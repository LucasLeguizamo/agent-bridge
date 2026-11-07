import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export const MAX_HOPS = 4; // hop is 0-based, so a chain gets hops 0..3: four deliveries.
export const DAILY_PAIR_CAP = 20;
const PAUSE = '1 hour';
const MAX_REJECTED_PER_HOUR = 100;
// A new task this soon after receiving work counts as part of that chain, even without parent_id.
const IMPLICIT_PARENT_WINDOW = '15 minutes';

export type Json = Record<string, unknown>;
export type Task = {
  id: string; root_id: string; parent_id: string | null;
  from_agent: string; to_agent: string; intent: string;
  input: Json; output: Json | null;
  risk: 'read' | 'write' | 'side_effect';
  state: 'submitted' | 'working' | 'input_required' | 'completed' | 'failed' | 'canceled' | 'rejected';
  hop: number; idempotency_key: string; attempts: number;
  next_attempt_at: Date; deadline_at: Date; created_at: Date;
};
export type NewTask = {
  to_agent: string; intent: string; input: Json;
  idempotency_key: string; parent_id?: string | undefined;
};

export class BridgeError extends Error {
  status: 400 | 404 | 409 | 422 | 429;
  constructor(status: 400 | 404 | 409 | 422 | 429, code: string) {
    super(code);
    this.status = status;
  }
}

// The sender never picks the risk (PRD section 9). An intent is only low risk with exactly the input shape
// listed here, so `research` cannot carry extra action fields. Anything else is side_effect.
// Limit: free text in `query` can still ask for anything; the receiving agent must treat it as data.
// ponytail: placeholder allowlist, the PRD names no intents. Extend as adapters land.
const TEXT = z.string().min(1).max(10_000);
const INTENT_POLICY = new Map<string, { risk: Task['risk']; input: z.ZodType }>([
  ['research', { risk: 'read', input: z.strictObject({ query: TEXT }) }],
  ['summarize', { risk: 'read', input: z.strictObject({ text: TEXT }) }],
  ['memory.write', { risk: 'write', input: z.strictObject({ key: TEXT, value: TEXT }) }],
]);
export const riskOf = (intent: string, input: Json): Task['risk'] => {
  const policy = INTENT_POLICY.get(intent);
  return policy?.input.safeParse(input).success ? policy.risk : 'side_effect';
};

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch((err: Error) => { broken = err; });
    throw e;
  } finally {
    c.release(broken);
  }
}

async function guardVerdict(c: PoolClient, from: string, t: NewTask, hop: number) {
  const { rows: [g] } = await c.query<{ paused: boolean; day: number; dup: boolean | null }>(
    `SELECT
       EXISTS (SELECT 1 FROM pair_pause
               WHERE agent_a = LEAST($1::text, $2::text) AND agent_b = GREATEST($1::text, $2::text)
                 AND paused_until > now()) AS paused,
       count(*) FILTER (WHERE state <> 'rejected' AND created_at > now() - interval '24 hours')::int AS day,
       bool_or(state <> 'rejected' AND created_at > now() - interval '1 hour'
               AND from_agent = $1 AND to_agent = $2 AND intent = $3 AND input = $4::jsonb) AS dup
     FROM task
     WHERE (from_agent = $1 AND to_agent = $2) OR (from_agent = $2 AND to_agent = $1)`,
    [from, t.to_agent, t.intent, JSON.stringify(t.input)],
  );
  if (g!.paused) return 'pair_paused';
  if (hop >= MAX_HOPS) return 'hop_limit';
  if (g!.day >= DAILY_PAIR_CAP) return 'daily_cap';
  if (g!.dup) return 'duplicate_content';
  return null;
}

/** Runs guards, then stores the task. A guard hit stores a `rejected` task, so the decision is auditable. */
export function createTask(pool: Pool, from: string, t: NewTask) {
  // Keys are namespaced per sender so one agent cannot collide with or probe another's.
  const key = `${from}:${t.idempotency_key}`;
  return tx(pool, async (c) => {
    // Serializes per pair so concurrent creates cannot overshoot the cap. Released at commit: pooler safe.
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(LEAST($1::text, $2::text) || '|' || GREATEST($1::text, $2::text), 0))`,
      [from, t.to_agent],
    );

    const replay = async () => {
      const { rows: [old] } = await c.query<Task>('SELECT * FROM task WHERE idempotency_key = $1', [key]);
      if (!old) return null;
      const same = old.to_agent === t.to_agent && old.intent === t.intent
        && (t.parent_id === undefined || old.parent_id === t.parent_id) && isDeepStrictEqual(old.input, t.input);
      if (!same) throw new BridgeError(409, 'idempotency_conflict');
      return { task: old, created: false };
    };
    const first = await replay();
    if (first) return first;

    if (from === t.to_agent) throw new BridgeError(422, 'self_delegation');
    const { rows: agents } = await c.query('SELECT id FROM agent WHERE id = ANY($1)', [[from, t.to_agent]]);
    if (agents.length !== 2) throw new BridgeError(422, 'unknown_agent');

    // hop and root come only from stored tasks; the client cannot reset them by omitting parent_id.
    let parent: Task | undefined;
    if (t.parent_id) {
      ({ rows: [parent] } = await c.query<Task>('SELECT * FROM task WHERE id = $1', [t.parent_id]));
      // attempts > 0: a task that was rejected or never delivered, such as an unapproved side_effect, spawns nothing.
      if (!parent || parent.to_agent !== from || parent.attempts === 0) throw new BridgeError(422, 'invalid_parent');
    } else {
      ({ rows: [parent] } = await c.query<Task>(
        `SELECT * FROM task
         WHERE to_agent = $1 AND attempts > 0 AND state <> 'rejected'
           AND (state IN ('submitted', 'working', 'input_required') OR created_at > now() - $2::interval)
         ORDER BY hop DESC, created_at DESC LIMIT 1`,
        [from, IMPLICIT_PARENT_WINDOW],
      ));
    }
    const root = parent?.root_id;
    const hop = parent ? parent.hop + 1 : 0;

    const reason = await guardVerdict(c, from, t, hop);
    if (reason) {
      // Rejections are stored for audit, so a misbehaving sender must not be able to grow the table without limit.
      const { rows: [r] } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM task
         WHERE from_agent = $1 AND state = 'rejected' AND created_at > now() - interval '1 hour'`, [from]);
      if (r!.n >= MAX_REJECTED_PER_HOUR) throw new BridgeError(429, 'too_many_rejections');
    }
    const risk = riskOf(t.intent, t.input);
    // ponytail: side_effect parks here until M5 adds approvals; the deadline sweep fails it meanwhile.
    const state = reason ? 'rejected' : risk === 'side_effect' ? 'input_required' : 'submitted';
    const id = randomUUID();
    const { rows: [task] } = await c.query<Task>(
      `INSERT INTO task (id, root_id, parent_id, from_agent, to_agent, intent, input, output,
                         risk, state, hop, idempotency_key, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, now() + interval '24 hours')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, root ?? id, parent?.id ?? null, from, t.to_agent, t.intent, JSON.stringify(t.input),
        reason ? JSON.stringify({ rejected: reason }) : null, risk, state, hop, key],
    );
    if (!task) return (await replay())!; // Lost a race with the same key on another pair.

    await logEvent(c, task.id, from, reason ? 'task_rejected' : 'task_created', {
      risk, hop, state, reason, implicit_parent: Boolean(parent && !t.parent_id),
    });
    if (state === 'input_required') await logEvent(c, task.id, 'bridge', 'approval_required', { intent: t.intent });

    if (reason === 'hop_limit' || reason === 'daily_cap') {
      await c.query(
        `INSERT INTO pair_pause (agent_a, agent_b, paused_until, reason)
         VALUES (LEAST($1::text, $2::text), GREATEST($1::text, $2::text), now() + $3::interval, $4)
         ON CONFLICT (agent_a, agent_b) DO UPDATE
           SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason`,
        [from, t.to_agent, PAUSE, reason],
      );
      await logEvent(c, task.id, 'bridge', 'alert', { alert: 'pair_paused', reason, from, to: t.to_agent });
    }
    return { task, created: true };
  });
}

function logEvent(c: PoolClient, taskId: string, actor: string, type: string, payload: Json) {
  return c.query('INSERT INTO event (task_id, actor, type, payload) VALUES ($1, $2, $3, $4::jsonb)',
    [taskId, actor, type, JSON.stringify(payload)]);
}

export async function getTask(pool: Pool, id: string, agent: string) {
  const { rows: [t] } = await pool.query<Task>(
    // The receiver sees a task only once it has been offered, so an unapproved side_effect stays hidden.
    'SELECT * FROM task WHERE id = $1 AND (from_agent = $2 OR (to_agent = $2 AND attempts > 0))', [id, agent]);
  if (!t) throw new BridgeError(404, 'not_found');
  return t;
}

export async function getEvents(pool: Pool, id: string, agent: string) {
  await getTask(pool, id, agent);
  // Raw adapter errors can hold internal details: they stay in the audit log, out of the API.
  const { rows } = await pool.query(
    `SELECT id, task_id, actor, type, payload - 'error' AS payload, created_at
     FROM event WHERE task_id = $1 ORDER BY id`, [id]);
  return rows;
}

/**
 * Receiver closes a task. A delivered-but-unacked task counts as delivered (attempts > 0):
 * the reply may beat the ack, or the dispatcher may have crashed in between.
 */
export async function finishTask(pool: Pool, id: string, agent: string, state: 'completed' | 'failed', output: Json) {
  const { rows: [t] } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET state = $3, output = $4::jsonb
       WHERE id = $1 AND to_agent = $2
         AND (state = 'working' OR (state = 'submitted' AND attempts > 0))
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, $2, 'task_' || $3, '{}'::jsonb FROM up
     )
     SELECT * FROM up`,
    [id, agent, state, JSON.stringify(output)],
  );
  if (t) return t;
  const cur = await getTask(pool, id, agent);
  if (cur.to_agent === agent && cur.state === state && isDeepStrictEqual(cur.output, output)) return cur;
  throw new BridgeError(409, 'invalid_state');
}

export async function cancelTask(pool: Pool, id: string, agent: string) {
  const { rows: [t] } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET state = 'canceled'
       WHERE id = $1 AND from_agent = $2 AND state IN ('submitted', 'working', 'input_required')
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, $2, 'task_canceled', '{}'::jsonb FROM up
     )
     SELECT * FROM up`,
    [id, agent],
  );
  if (t) return t;
  const cur = await getTask(pool, id, agent);
  if (cur.from_agent === agent && cur.state === 'canceled') return cur;
  throw new BridgeError(409, 'invalid_state');
}
