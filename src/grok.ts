import type { Pool } from 'pg';
import type { Adapter, Adapters } from './queue.ts';

export const GROK_ADAPTER = 'grok';
const MISSES_TO_TRIP = 3;
const TRIP_WINDOW = '15 minutes';
// A run only counts as missed once it has had this long to call task_claim.
// ASSUMPTION (G2): a healthy routine claims within 5 minutes. A slower one trips early, and its late claim closes the pause.
const CLAIM_GRACE_SECONDS = 300;
// ponytail: the PRD sets no pause length. Same hour as pair_pause. Waste stays bounded: a 2xx task is never re-sent.
const PAUSE = '1 hour';

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
  return { url, key };
}

/**
 * Wakes the routine. The body has no signature, so it carries only task_id and the run reads the task over MCP.
 * Documented contract: 200 means a run started, not that it finished or that the Bot's computer is available.
 */
export function createGrokAdapter(pool: Pool, { url, key }: GrokConfig): Adapter {
  return {
    async deliver(task, signal) {
      // ponytail: M5 replaces this with an approval check. Until then no side_effect can reach Grok Bot.
      if (task.risk === 'side_effect') throw new Error('side_effect_not_approved');
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: task.id }),
        redirect: 'error', // Never replay the bearer key to wherever a redirect points.
        signal,
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      await pool.query(
        `INSERT INTO event (task_id, actor, type, payload) VALUES ($1, 'bridge', 'grok_run_started', $2::jsonb)`,
        [task.id, JSON.stringify({ attempt: task.attempts })],
      );
    },
  };
}

/**
 * True while sends to Grok Bot must stop. Trips when the latest 3 settled runs since the last pause all went
 * unclaimed and started within 15 minutes of each other. A claimed run counts at once, so it breaks the streak
 * even before the older runs have settled. A task that was canceled or already closed does not count as missed.
 */
export async function breakerOpen(pool: Pool, graceSeconds = CLAIM_GRACE_SECONDS) {
  const { rows: [r] } = await pool.query<{ paused: boolean; trip: boolean; tasks: string[] }>(
    `WITH pause AS (
       SELECT paused_until FROM adapter_pause WHERE adapter = $1
     ), recent AS (
       SELECT e.task_id, e.created_at, (t.claimed_at IS NULL AND t.state IN ('submitted', 'working')) AS missed
       FROM event e JOIN task t ON t.id = e.task_id
       WHERE e.type = 'grok_run_started'
         AND e.created_at > COALESCE((SELECT paused_until FROM pause), '-infinity')
         AND (e.created_at <= now() - make_interval(secs => $2) OR t.claimed_at IS NOT NULL)
       ORDER BY e.id DESC
       LIMIT $3
     )
     SELECT COALESCE((SELECT paused_until > now() FROM pause), false) AS paused,
            COALESCE(count(*) = $3 AND bool_and(missed) AND max(created_at) - min(created_at) <= $4::interval, false) AS trip,
            COALESCE(jsonb_agg(task_id), '[]') AS tasks
     FROM recent`,
    [GROK_ADAPTER, graceSeconds, MISSES_TO_TRIP, TRIP_WINDOW],
  );
  if (r!.paused) return true;
  if (!r!.trip) return false;
  // The WHERE on the upsert means concurrent passes raise a single alert.
  await pool.query(
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
