import type { Pool } from 'pg';
import { raiseAlert } from './alert.ts';
import { logTransition } from './log.ts';
import { CLAIM_ADAPTERS, CLAIM_GRACE_SECONDS, type Json, type Task } from './tasks.ts';

export const MAX_ATTEMPTS = 5;
// The lease must outlast the delivery timeout, so a live delivery is never re-claimed.
const LEASE_SECONDS = 60;
const DELIVERY_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_SECONDS = 30;

export type ClaimedTask = Task & { adapter: string; agent_config: Json };
export type Adapter = { deliver(task: ClaimedTask, signal: AbortSignal): Promise<void> };
export type Adapters = Record<string, Adapter>;

/**
 * Atomically leases due tasks: one statement, so the lock lasts only as long as a short transaction.
 * Delivery happens after commit. A crash leaves the task `submitted`, and it is retried when the lease ends.
 * Tasks for agents with no loaded adapter stay queued instead of burning attempts.
 */
export async function claim(pool: Pool, adapters: Adapters, limit = 10) {
  const { rows } = await pool.query<ClaimedTask>(
    `WITH due AS (
       SELECT t.id FROM task t
       JOIN agent a ON a.id = t.to_agent
       JOIN agent s ON s.id = t.from_agent
       WHERE t.state = 'submitted' AND t.next_attempt_at <= now()
         AND t.attempts < $1 AND a.enabled AND s.enabled AND a.adapter = ANY($2)
         AND NOT EXISTS (
           SELECT 1 FROM pair_pause p
           WHERE p.agent_a = LEAST(t.from_agent, t.to_agent)
             AND p.agent_b = GREATEST(t.from_agent, t.to_agent)
             AND p.paused_until > now())
         AND (t.risk <> 'side_effect' OR EXISTS (
           SELECT 1 FROM approval ap
           WHERE ap.task_id = t.id AND ap.decision = 'approved' AND ap.expires_at > now()))
       ORDER BY t.next_attempt_at
       LIMIT $3
       FOR UPDATE OF t SKIP LOCKED
     ), claimed AS (
       UPDATE task t SET attempts = t.attempts + 1, next_attempt_at = now() + make_interval(secs => $4)
       FROM due WHERE t.id = due.id
       RETURNING t.*
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, 'bridge', 'delivery_attempt', jsonb_build_object('attempt', attempts) FROM claimed
     )
     SELECT claimed.*, a.adapter, a.config AS agent_config
     FROM claimed JOIN agent a ON a.id = claimed.to_agent`,
    [MAX_ATTEMPTS, Object.keys(adapters), limit, LEASE_SECONDS],
  );
  return rows;
}

// `attempts = $2` fences stale acks: a slower attempt cannot overwrite a newer one.
// On a claim adapter a 2xx only means a run may have started, so the task stays `submitted`, due again after the grace
// period: the queue re-sends it inside MAX_ATTEMPTS until task_claim moves it to `working`. The wait doubles each time.
// The event is written in a CTE and the task returned, so the stdout line comes from the committed row.
// `woken`: a claim adapter started a run, and the task stays `submitted` until that run claims it.
export async function ackDelivered(pool: Pool, t: Pick<Task, 'id' | 'attempts'> & { adapter?: string }) {
  const woken = Boolean(t.adapter && CLAIM_ADAPTERS.includes(t.adapter));
  const { rows: [up] } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET state = CASE WHEN $3::boolean THEN state ELSE 'working' END,
         next_attempt_at = CASE WHEN $3::boolean THEN now() + make_interval(secs => $4) ELSE next_attempt_at END
       WHERE id = $1 AND attempts = $2 AND state = 'submitted'
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, 'bridge', 'delivered', jsonb_build_object('attempt', $2::int) FROM up
     )
     SELECT * FROM up`,
    [t.id, t.attempts, woken, CLAIM_GRACE_SECONDS * 2 ** (t.attempts - 1)],
  );
  if (up) logTransition(woken ? 'task.woken' : 'task.delivered', up);
}

export async function nackDelivery(pool: Pool, t: Pick<Task, 'id' | 'attempts'>, error: string) {
  const payload = JSON.stringify({ attempt: t.attempts, error: error.slice(0, 500) });
  if (t.attempts >= MAX_ATTEMPTS) {
    const { rows: [up] } = await pool.query<Task>(
      `WITH up AS (
         UPDATE task SET state = 'failed', output = '{"error":"delivery_exhausted"}'
         WHERE id = $1 AND attempts = $2 AND state = 'submitted'
         RETURNING *
       ), ev AS (
         INSERT INTO event (task_id, actor, type, payload)
         SELECT id, 'bridge', 'alert', $3::jsonb || '{"alert":"delivery_exhausted"}' FROM up
       )
       SELECT * FROM up`,
      [t.id, t.attempts, payload],
    );
    if (up) failedAlert(up, 'delivery_exhausted');
    return;
  }
  const { rows: [up] } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND attempts = $2 AND state = 'submitted'
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, 'bridge', 'delivery_failed', $4::jsonb FROM up
     )
     SELECT * FROM up`,
    [t.id, t.attempts, BACKOFF_BASE_SECONDS * 2 ** (t.attempts - 1), payload],
  );
  if (up) logTransition('task.retry', up);
}

/** The log line and the notice for a task the bridge itself failed. Keyed by pair, so a loop alerts once per window. */
export function failedAlert(t: Task, alert: string) {
  logTransition(alert === 'deadline_exceeded' ? 'task.expired' : 'task.failed', t, alert);
  raiseAlert({ alert, key: `${t.from_agent}|${t.to_agent}`, task: t.id,
    text: `${alert} on task ${t.id} (${t.from_agent} -> ${t.to_agent}, attempt ${t.attempts})` });
}

/** Fails overdue tasks, and tasks whose last allowed attempt crashed before it could report. */
export async function sweep(pool: Pool) {
  const { rows } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET state = 'failed', output = jsonb_build_object(
         'error', CASE WHEN deadline_at <= now() THEN 'deadline_exceeded' ELSE 'delivery_exhausted' END)
       WHERE state IN ('submitted', 'working', 'input_required')
         AND (deadline_at <= now()
              OR (state = 'submitted' AND attempts >= $1 AND next_attempt_at <= now()))
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, 'bridge', 'alert', jsonb_build_object('alert', output->>'error') FROM up
     )
     SELECT * FROM up`,
    [MAX_ATTEMPTS],
  );
  for (const t of rows) failedAlert(t, String(t.output?.error));
}

/** One dispatcher pass, whatever triggered it. Returns how many tasks it claimed. */
export async function runOnce(pool: Pool, adapters: Adapters, timeoutMs = DELIVERY_TIMEOUT_MS) {
  await sweep(pool);
  const tasks = await claim(pool, adapters);
  await Promise.all(tasks.map(async (t) => {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      // Raced, so an adapter that ignores the signal cannot stall the dispatcher or outlive its lease.
      await Promise.race([
        adapters[t.adapter]!.deliver(t, signal),
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      ]);
    } catch (e) {
      await nackDelivery(pool, t, e instanceof Error ? e.message : String(e));
      return;
    }
    await ackDelivered(pool, t);
  }));
  return tasks.length;
}

/** True when a pass has anything to do: something to send, or a deadline to enforce. Covers all that sweep can fail. */
export async function hasDueWork(pool: Pool) {
  const { rows: [r] } = await pool.query<{ due: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM task WHERE state = 'submitted' AND next_attempt_at <= now())
         OR EXISTS (SELECT 1 FROM task WHERE state IN ('submitted', 'working', 'input_required') AND deadline_at <= now()) AS due`,
  );
  return r!.due;
}

/**
 * What a cron tick or a new task triggers. Runs every minute with nothing to do, so an idle pass is this one read.
 * maxDuration in vercel.json is 300 s. With every query at its 15 s timeout, the dispatch part (due check, sweep, claim,
 * deliveries at 30 s, acks) takes at most 90 s, and the wake-ups after it at most 70 s (grok.ts: a 30 s budget, then one
 * claim, one send and one event). Sending result mails (email.ts) is a third phase with its own limits and is not counted
 * here. A pass killed anyway loses nothing: its tasks are retried when the lease ends, and a wake-up in flight leaves an
 * `asker_waking` event with no outcome. A function is resolved only when there is work, and then on every pass, so
 * a breaker can hold an adapter's tasks without burning attempts.
 */
export async function runPass(pool: Pool, adapters: Adapters | (() => Promise<Adapters>), timeoutMs?: number) {
  if (!(await hasDueWork(pool))) return 0;
  return runOnce(pool, typeof adapters === 'function' ? await adapters() : adapters, timeoutMs);
}
