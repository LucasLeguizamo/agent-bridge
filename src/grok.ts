import type { Pool } from 'pg';
import { raiseAlert } from './alert.ts';
import { logBridgeEvent, logError } from './log.ts';
import type { Adapter, Adapters } from './queue.ts';
import { CLAIM_GRACE_SECONDS } from './tasks.ts';

export const GROK_ADAPTER = 'grok';
const MISSES_TO_TRIP = 3;
const TRIP_WINDOW = '15 minutes';
// The newest attempt looked at. Above the trip window plus the grace period, and it keeps the scan short.
const LOOKBACK = '1 hour';
// ponytail: the PRD sets no pause length. Same hour as pair_pause. Waste stays bounded: re-sends stop at MAX_ATTEMPTS.
const PAUSE = '1 hour';
// The format of a routine key is not documented (G2). This only catches what would break the header: a bad paste.
const WEBHOOK_KEY = /^[\x21-\x7e]{16,}$/;

export type GrokConfig = { url: string; key: string };

type Env = Record<string, string | undefined>;

/** Null unless both variables are set. Secrets come from the environment, never from agent.config. */
export function grokConfig(env: Env): GrokConfig | null {
  const { GROK_WEBHOOK_URL: url, GROK_WEBHOOK_KEY: key } = env;
  if (!url || !key) return null;
  // The message names the variable only: the URL is a secret too.
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const loopback = parsed?.hostname === '127.0.0.1' || parsed?.hostname === 'localhost';
  if (parsed?.protocol !== 'https:' && !(parsed?.protocol === 'http:' && loopback)) {
    throw new Error('GROK_WEBHOOK_URL must be a valid https URL');
  }
  if (!WEBHOOK_KEY.test(key)) throw new Error('GROK_WEBHOOK_KEY must be at least 16 visible characters with no spaces');
  return { url, key };
}

/**
 * Wakes the routine. The body has no signature, so it carries only task_id and the run reads the task over MCP.
 * Documented contract: 200 means a run started, not that it finished or that the Bot's computer is available.
 */
export function createGrokAdapter(pool: Pool, config: GrokConfig): Adapter {
  return {
    async deliver(task, signal) {
      await postWebhook(config, task.id, signal);
      await pool.query(
        `INSERT INTO event (task_id, actor, type, payload) VALUES ($1, 'bridge', 'grok_run_started', $2::jsonb)`,
        [task.id, JSON.stringify({ attempt: task.attempts })],
      );
    },
  };
}

/** One POST to the routine webhook. Only task_id travels: the body is not signed. */
async function postWebhook({ url, key }: GrokConfig, taskId: string, signal: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: taskId }),
    redirect: 'error', // Never replay the bearer key to wherever a redirect points.
    signal,
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

const WAKE_QUIET = '90 seconds';
// A task is open for 24 hours at most, and a breaker pause holds wake-ups for 1 hour more, even renewed once. Counted from
// creation, since that is what the index has.
const WAKE_WINDOW = '50 hours';
const WAKES_PER_PASS = 5;
// Each send is a paid run, so a pass stops starting new ones when its budget is spent, well inside the function's
// maxDuration (vercel.json). Worst case: this budget plus one claim, one send and one event, each at its own timeout.
const WAKE_BUDGET_MS = 30_000;
const WAKE_TIMEOUT_MS = 10_000;
// The events that end a task, written by the bridge's own code: complete and fail (any agent can only reach them through
// finishTask), and the alerts of sweep, nackDelivery and the email adapter. An event an agent can write on its task (a memory log, a
// refused close) is not one of them, so the receiver cannot hold a wake-up back.
const END_EVENT = `(e.type IN ('task_completed', 'task_failed')
  OR (e.type = 'alert' AND e.actor = 'bridge' AND e.payload->>'alert' IN ('deadline_exceeded', 'delivery_exhausted', 'secret_blocked')))`;

export type WakeOptions = { quiet?: string; budgetMs?: number; timeoutMs?: number };

/**
 * Tells a routine agent that a task it asked for ended, by starting a run with that task_id. The run cannot claim the
 * task, so it reads the answer and tells its owner (step 3 of the served instructions). Skipped when the asker already
 * read the answer, while the breaker has sends paused, and until the task ended 90 seconds ago, so an asker that is
 * still waiting on GET /tasks/:id/answer gets there first. Run it on each dispatcher pass. Returns how many it tried.
 * One at a time: take one row, send, record, take the next. A pass cut short then loses at most the send in flight, and
 * that one has an `asker_waking` event with no outcome after it. Rows not yet taken stay due for the next pass.
 * ponytail: at most once. The row is marked before the send, so a crash or a failed webhook is not retried: every
 * retry is a paid run, and the owner can still ask the agent to check the task. Add attempts and a backoff, as
 * sendDelegationResults has, if wake-ups are seen to get lost.
 */
export async function wakeAskers(pool: Pool, config: GrokConfig, options: WakeOptions = {}) {
  const { quiet = WAKE_QUIET, budgetMs = WAKE_BUDGET_MS, timeoutMs = WAKE_TIMEOUT_MS } = options;
  const started = Date.now();
  let tried = 0;
  while (tried < WAKES_PER_PASS && Date.now() - started < budgetMs) {
    // SKIP LOCKED is what keeps two passes from taking the same row: the lock is held until this statement commits.
    const { rows: [row] } = await pool.query<{ id: string }>(
      `WITH due AS (
         SELECT t.id FROM task t JOIN agent a ON a.id = t.from_agent
         WHERE t.state IN ('completed', 'failed') AND t.asker_seen_at IS NULL AND t.asker_woken_at IS NULL
           AND t.created_at > now() - $2::interval
           AND a.adapter = $1 AND a.enabled
           AND NOT EXISTS (SELECT 1 FROM adapter_pause p WHERE p.adapter = $1 AND p.paused_until > now())
           AND NOT EXISTS (SELECT 1 FROM event e WHERE e.task_id = t.id AND e.created_at > now() - $3::interval AND ${END_EVENT})
         ORDER BY t.created_at LIMIT 1
         FOR UPDATE OF t SKIP LOCKED
       ), up AS (
         UPDATE task t SET asker_woken_at = now() FROM due WHERE t.id = due.id RETURNING t.id
       ), ev AS (
         INSERT INTO event (task_id, actor, type, payload) SELECT id, 'bridge', 'asker_waking', '{}'::jsonb FROM up
       )
       SELECT id FROM up`,
      [GROK_ADAPTER, WAKE_WINDOW, quiet],
    );
    if (!row) break;
    tried++;
    const record = (type: string, payload: object) => pool.query(
      `INSERT INTO event (task_id, actor, type, payload) VALUES ($1, 'bridge', '${type}', $2::jsonb)`,
      [row.id, JSON.stringify(payload)],
    ).catch((e: unknown) => logError('asker wake event', e)); // The rest of the batch still goes.
    try {
      await postWebhook(config, row.id, AbortSignal.timeout(timeoutMs));
    } catch (e) {
      await record('asker_wake_failed', { error: (e instanceof Error ? e.message : 'unknown').slice(0, 200) });
      continue;
    }
    await record('asker_woken', {});
  }
  return tried;
}

/**
 * True while sends to Grok Bot must stop. Trips when the latest 3 tasks attempted since the last pause all went unclaimed
 * and were attempted within 15 minutes of each other. Every attempt counts, not only a 2xx: a webhook that errors or
 * times out may still have opened a run. A task counts once, at its newest attempt, so one task retried by the queue
 * cannot pause everything: its own sends stop at MAX_ATTEMPTS. A claimed task counts at once, so it breaks the streak
 * even before the older ones have settled. A task that was canceled or already closed does not count as missed.
 */
export async function breakerOpen(pool: Pool, graceSeconds = CLAIM_GRACE_SECONDS) {
  const { rows: [r] } = await pool.query<{ paused: boolean; trip: boolean; tasks: string[] }>(
    `WITH pause AS (
       SELECT paused_until FROM adapter_pause WHERE adapter = $1
     ), per_task AS (
       SELECT DISTINCT ON (e.task_id) e.id, e.task_id, e.created_at,
              (t.claimed_at IS NULL AND t.state IN ('submitted', 'working')) AS missed
       FROM event e JOIN task t ON t.id = e.task_id JOIN agent a ON a.id = t.to_agent AND a.adapter = $1
       WHERE e.type IN ('delivery_attempt', 'grok_run_started')
         AND e.created_at > GREATEST(COALESCE((SELECT paused_until FROM pause), '-infinity'), now() - $5::interval)
         AND (e.created_at <= now() - make_interval(secs => $2) OR t.claimed_at IS NOT NULL)
       ORDER BY e.task_id, e.id DESC
     ), recent AS (
       SELECT * FROM per_task ORDER BY id DESC LIMIT $3
     )
     SELECT COALESCE((SELECT paused_until > now() FROM pause), false) AS paused,
            COALESCE(count(*) = $3 AND bool_and(missed) AND max(created_at) - min(created_at) <= $4::interval, false) AS trip,
            COALESCE(jsonb_agg(task_id), '[]') AS tasks
     FROM recent`,
    [GROK_ADAPTER, graceSeconds, MISSES_TO_TRIP, TRIP_WINDOW, LOOKBACK],
  );
  if (r!.paused) return true;
  if (!r!.trip) return false;
  // The WHERE on the upsert means concurrent passes raise a single alert.
  const { rowCount } = await pool.query(
    `WITH up AS (
       INSERT INTO adapter_pause (adapter, paused_until, reason)
       VALUES ($1, now() + $2::interval, 'runs_without_claim')
       ON CONFLICT (adapter) DO UPDATE SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason
         WHERE adapter_pause.paused_until <= now()
       RETURNING paused_until
     )
     INSERT INTO event (actor, type, payload)
     SELECT 'bridge', 'alert', jsonb_build_object('alert', 'grok_breaker_open', 'tasks', $3::jsonb, 'paused_until', paused_until)
     FROM up`,
    [GROK_ADAPTER, PAUSE, JSON.stringify(r!.tasks)],
  );
  if (rowCount) {
    logBridgeEvent('breaker.opened', { adapter: GROK_ADAPTER, tasks: r!.tasks.length, reason: 'runs_without_claim' });
    raiseAlert({ alert: 'grok_breaker_open', key: GROK_ADAPTER,
      text: `grok_breaker_open: ${r!.tasks.length} runs without a claim, sends to grok paused for 1 hour` });
  }
  return true;
}

/**
 * Resolves the adapters for one dispatcher pass. Leaving grok out holds its tasks with no attempts burned,
 * the way the queue treats any agent with no loaded adapter. If the check throws, the pass sends nothing.
 */
export function breakerGate(pool: Pool, adapters: Adapters, graceSeconds?: number) {
  return async (): Promise<Adapters> => {
    if (!adapters[GROK_ADAPTER] || !(await breakerOpen(pool, graceSeconds))) return adapters;
    return Object.fromEntries(Object.entries(adapters).filter(([name]) => name !== GROK_ADAPTER));
  };
}
