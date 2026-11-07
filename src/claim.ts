import type { Pool } from 'pg';
import { z } from 'zod';
import { logError } from './log.ts';
import { contextPack, DATA_LABEL } from './memory.ts';
import { stripHidden, stripHiddenDeep } from './secrets.ts';
import type { Task } from './tasks.ts';

// Shared by the MCP tool and the HTTP route, so both give one answer to anything that cannot be claimed.
export const NOT_CLAIMED = { claimed: false, instruction: 'Nothing to do. End this run now without taking any action.' };

export const PendingInput = z.strictObject({
  limit: z.coerce.number<number>().int().min(1).max(100).default(20),
  cursor: z.uuid().toLowerCase().optional(),
});

// What the list shows and the claim accepts, for $2 as the agent: a listed task can be claimed, and nothing else is listed.
// attempts > 0 means the bridge really offered it. The kill switch, the pair breaker and the approval hold here as they do
// in queue.claim: a run opened before they took effect must not get the task, and a parked side_effect never shows.
const CLAIMABLE = `to_agent = $2 AND claimed_at IS NULL AND attempts > 0
  AND state IN ('submitted', 'working') AND deadline_at > now()
  AND EXISTS (SELECT 1 FROM agent s WHERE s.id = task.from_agent AND s.enabled)
  AND NOT EXISTS (
    SELECT 1 FROM pair_pause p
    WHERE p.agent_a = LEAST(task.from_agent, task.to_agent)
      AND p.agent_b = GREATEST(task.from_agent, task.to_agent)
      AND p.paused_until > now())
  AND (risk <> 'side_effect' OR EXISTS (
    SELECT 1 FROM approval ap
    WHERE ap.task_id = task.id AND ap.decision = 'approved' AND ap.expires_at > now()))`;

/**
 * Atomic: the conditional UPDATE lets one caller through, and it stops further sends, because the queue only leases
 * `submitted`. A claim proves the agent is alive, so it also ends a breaker pause early.
 */
export async function claimTask(pool: Pool, id: string, agent: string) {
  const { rows: [t] } = await pool.query<Task>(
    `WITH up AS (
       UPDATE task SET state = 'working', claimed_at = now()
       WHERE id = $1 AND ${CLAIMABLE}
       RETURNING *
     ), ev AS (
       INSERT INTO event (task_id, actor, type, payload)
       SELECT id, $2, 'task_claimed', jsonb_build_object('attempt', attempts) FROM up
     ), resumed AS (
       UPDATE adapter_pause SET paused_until = now()
       WHERE paused_until > now() AND EXISTS (SELECT 1 FROM up)
         AND adapter = (SELECT adapter FROM agent WHERE id = $2)
       RETURNING adapter
     ), resumed_ev AS (
       INSERT INTO event (actor, type, payload)
       SELECT 'bridge', 'breaker_closed', jsonb_build_object('adapter', adapter, 'by', 'task_claimed') FROM resumed
     )
     SELECT * FROM up`,
    [id, agent],
  );
  return t ?? null;
}

// Memory is searched with what the task is about: its text fields, or its intent when it has none.
const packQuery = (t: Task) =>
  Object.values(t.input).filter((v) => typeof v === 'string').join(' ').slice(0, 500).trim() || t.intent;

/** The answer to a claim, whoever asks. `rawId` is untrusted: a malformed id gets the same answer as any other id that cannot be claimed. */
export async function claimReply(pool: Pool, rawId: string, agent: string) {
  const parsed = z.uuid().toLowerCase().safeParse(rawId);
  const t = parsed.success ? await claimTask(pool, parsed.data, agent) : null;
  if (!t) return NOT_CLAIMED;
  // The task is already ours, so a memory failure must not lose it: work on with no context rather than strand it.
  const context = await contextPack(pool, { query: packQuery(t) }).then((pack) => pack.text).catch((e: unknown) => {
    logError('context pack', e);
    return '';
  });
  return {
    claimed: true,
    task: { id: t.id, intent: stripHidden(t.intent), from_agent: t.from_agent, risk: t.risk, hop: t.hop, deadline_at: t.deadline_at },
    next: 'Do the task, then call task_complete before deadline_at.',
    data_label: DATA_LABEL,
    data: { from_agent: t.from_agent, input: stripHiddenDeep(t.input), context },
  };
}

/**
 * Oldest first. The input stays out: only a claim hands it over. The cursor is the last task id of the previous page,
 * and only this agent's tasks count as one, so it cannot tell anything about anyone else's.
 */
export async function pendingTasks(pool: Pool, agent: string, input: z.input<typeof PendingInput>) {
  const { limit, cursor } = PendingInput.parse(input);
  const { rows } = await pool.query<Pick<Task, 'id' | 'intent' | 'from_agent' | 'risk' | 'hop' | 'deadline_at' | 'created_at'>>(
    `SELECT id, intent, from_agent, risk, hop, deadline_at, created_at FROM task
     WHERE ${CLAIMABLE}
       AND ($1::uuid IS NULL OR (created_at, id) > (SELECT c.created_at, c.id FROM task c WHERE c.id = $1::uuid AND c.to_agent = $2))
     ORDER BY created_at, id
     LIMIT $3`,
    [cursor ?? null, agent, limit + 1],
  );
  const tasks = rows.slice(0, limit);
  return { tasks, next_cursor: rows.length > limit ? tasks.at(-1)!.id : null };
}
