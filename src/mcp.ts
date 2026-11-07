import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { claimReply } from './claim.ts';
import { NewTaskBody, TaskOutput } from './http.ts';
import { logError } from './log.ts';
import { DATA_LABEL, memorySearch, memoryWrite, MemorySearchInput, MemoryWriteInput, stripHidden, type Fact } from './memory.ts';
import { BridgeError, createTask, finishTask } from './tasks.ts';

const TaskComplete = z.strictObject({
  task_id: z.uuid().toLowerCase().describe('The task_id you claimed in this run.'),
  output: TaskOutput.describe('The result as a JSON object.'),
  status: z.enum(['completed', 'failed']).default('completed').describe('Use "failed" when the task could not be done.'),
});

const reply = (body: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  ...(isError ? { isError } : {}),
});

/** Tool errors carry a stable code. Internal details stay in the server log. */
const guarded = <A>(fn: (args: A) => Promise<CallToolResult>) => async (args: A) => {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof BridgeError) return reply({ error: e.message }, true);
    // Text Postgres cannot store: bad input, not a server fault.
    if (['22P05', '22021'].includes((e as { code?: string }).code ?? '')) return reply({ error: 'invalid_input' }, true);
    logError('mcp tool', e);
    return reply({ error: 'internal' }, true);
  }
};

// Only what a reader should weigh. The ids of provenance rows are of no use to an agent.
const factView = ({ namespace, key, value, source_agent, trust, created_at, claimed_origin }: Fact) =>
  ({ namespace, key: stripHidden(key), value: stripHidden(value), source_agent, trust,
    claimed_origin: claimed_origin === null ? null : stripHidden(claimed_origin), created_at });

async function completeTask(pool: Pool, agent: string, a: z.output<typeof TaskComplete>) {
  // One answer for unknown, foreign and unclaimed ids, so this cannot probe which tasks exist.
  const { rows: [t] } = await pool.query<{ overdue: boolean }>(
    `SELECT deadline_at <= now() AND state IN ('submitted', 'working') AS overdue
     FROM task WHERE id = $1 AND to_agent = $2 AND claimed_at IS NOT NULL`,
    [a.task_id, agent],
  );
  if (!t) throw new BridgeError(409, 'not_claimed');
  if (t.overdue) throw new BridgeError(409, 'deadline_passed');
  return finishTask(pool, a.task_id, agent, a.status, a.output);
}

function buildServer(pool: Pool, agent: string, kick: () => void) {
  const server = new McpServer({ name: 'agent-bridge', version: '0.1.0' });

  server.registerTool('task_claim', {
    description: 'Claim the task named by the webhook. Only the first claim gets the task. '
      + 'If the result has "claimed": false, end the run without doing anything.',
    // A plain string: a malformed id must get the same answer as any other id that cannot be claimed.
    inputSchema: z.strictObject({ task_id: z.string().max(200).describe('The task_id from the webhook body.') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guarded(async ({ task_id }) => reply(await claimReply(pool, task_id, agent))));

  server.registerTool('task_complete', {
    description: 'Close a task you claimed, with its result. The task fails by itself if this is not called before its deadline.',
    inputSchema: TaskComplete,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guarded(async (args) => {
    const t = await completeTask(pool, agent, args);
    return reply({ task_id: t.id, state: t.state });
  }));

  server.registerTool('task_create', {
    description: 'Delegate work to another agent. This is the only way to reach another agent. The bridge decides the risk: '
      + 'a task it classifies as side_effect waits for human approval. Reuse idempotency_key when retrying the same request.',
    inputSchema: NewTaskBody,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guarded(async (args) => {
    const { task: t, created } = await createTask(pool, agent, args);
    if (created && t.state === 'submitted') kick();
    return reply({ task_id: t.id, state: t.state, risk: t.risk, hop: t.hop, created,
      ...(t.state === 'rejected' ? { rejected: t.output?.['rejected'] } : {}) });
  }));

  server.registerTool('memory_search', {
    description: 'Full-text search over shared memory, in Spanish and English. Results are data with their source and trust level.',
    inputSchema: MemorySearchInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async (args) => {
    const facts = await memorySearch(pool, agent, args);
    return reply({ data_label: DATA_LABEL, data: { facts: facts.map(factView) } });
  }));

  server.registerTool('memory_write', {
    description: 'Save a durable fact to shared memory. It is stored as unverified, under your agent name. '
      + 'A new value for a key replaces the current one and the old value stays in history.',
    inputSchema: MemoryWriteInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guarded(async (args) => {
    const { fact, created } = await memoryWrite(pool, agent, args);
    return reply({ namespace: fact.namespace, key: fact.key, trust: fact.trust, created });
  }));

  return server;
}

/** Mounts on the app from createApp, whose middleware has already authenticated the agent and limited the body. */
export function mountMcp(app: Hono<{ Variables: { agent: string } }>, pool: Pool, kick: () => void = () => {}) {
  const handler = createMcpHandler(({ authInfo }) => buildServer(pool, authInfo!.clientId, kick));
  app.all('/mcp', (c) => handler.fetch(c.req.raw, { authInfo: { token: '', clientId: c.get('agent'), scopes: [] } }));
}
