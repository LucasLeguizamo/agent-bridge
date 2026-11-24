// The agents a caller is in contact with. Only its own traffic is counted: nothing here may say what two others did.
import type { Pool, PoolClient } from 'pg';
import { aboutOf, PLAIN_ID } from './instructions.ts';

export const MAX_AGENTS = 100;

type Row = {
  id: string; about: unknown; paused: boolean;
  sent: number; received: number; open: number; last_contact_at: Date | null;
};

/**
 * Null when the caller is not an enabled agent. `sent` and `received` follow what GET /tasks/:id lets the caller see: a
 * task counts for its receiver only once offered, so a held side_effect stays hidden. One a guard rejected is no contact.
 * ponytail: scans task once, like guardVerdict. Index from_agent and to_agent if the table outgrows that.
 */
export async function agentDirectory(db: Pick<Pool | PoolClient, 'query'>, caller: string) {
  const { rows } = await db.query<Row>(
    `SELECT a.id, a.config->'about' AS about,
       coalesce(k.sent, 0) AS sent, coalesce(k.received, 0) AS received, coalesce(k.open, 0) AS open, k.last_contact_at,
       EXISTS (SELECT 1 FROM pair_pause p
               WHERE p.agent_a = LEAST(a.id, $1::text) AND p.agent_b = GREATEST(a.id, $1::text)
                 AND p.paused_until > now()) AS paused
     FROM agent a
     LEFT JOIN (
       SELECT CASE WHEN from_agent = $1 THEN to_agent ELSE from_agent END AS other,
         count(*) FILTER (WHERE from_agent = $1)::int AS sent,
         count(*) FILTER (WHERE to_agent = $1)::int AS received,
         count(*) FILTER (WHERE state IN ('submitted', 'working', 'input_required'))::int AS open,
         max(created_at) AS last_contact_at
       FROM task
       WHERE (from_agent = $1 OR (to_agent = $1 AND attempts > 0)) AND state <> 'rejected'
       GROUP BY 1
     ) k ON k.other = a.id
     WHERE a.enabled
     ORDER BY (a.id = $1) DESC, a.id
     LIMIT $2`,
    [caller, MAX_AGENTS + 1],
  );
  const [self, ...others] = rows; // The caller sorts first.
  if (self?.id !== caller) return null;
  return {
    self: caller,
    agents: others.filter((a) => PLAIN_ID.test(a.id)).map(({ id, about, sent, received, open, last_contact_at, paused }) => (
      { id, about: aboutOf(about) || null, contact: { sent, received, open, last_contact_at }, paused })),
  };
}
