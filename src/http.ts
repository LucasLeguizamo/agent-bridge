import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { BridgeError, cancelTask, createTask, finishTask, getEvents, getTask } from './tasks.ts';

const sha = (s: string) => createHash('sha256').update(s).digest();

// strict: hop, root_id, risk and from_agent are the bridge's to decide, so sending them is an error.
const NewTaskBody = z.strictObject({
  to_agent: z.string().min(1).max(100),
  intent: z.string().min(1).max(100),
  input: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().min(1).max(200),
  parent_id: z.uuid().optional(),
});
const OutputBody = z.strictObject({ output: z.record(z.string(), z.unknown()) });
const TaskId = z.uuid();

/** `keys` maps agent id to its bearer key. No keys means every request gets a 401. */
export function createApp(pool: Pool, keys: Record<string, string>) {
  const entries = Object.entries(keys).map(([agent, key]) => [agent, sha(key)] as const);
  const app = new Hono<{ Variables: { agent: string } }>();

  app.use(bodyLimit({ maxSize: 1024 * 1024 }));

  app.use(async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const hash = token ? sha(token) : null;
    const agent = hash && entries.find(([, h]) => timingSafeEqual(h, hash))?.[0];
    if (!agent) return c.json({ error: 'unauthorized' }, 401);
    const { rows: [row] } = await pool.query<{ enabled: boolean }>('SELECT enabled FROM agent WHERE id = $1', [agent]);
    if (!row?.enabled) return c.json({ error: 'agent_disabled' }, 403);
    c.set('agent', agent);
    await next();
  });

  const parse = async <T>(schema: z.ZodType<T>, req: { json(): Promise<unknown> }) => {
    const r = schema.safeParse(await req.json().catch(() => undefined));
    if (!r.success) throw new BridgeError(400, 'invalid_body');
    return r.data;
  };
  const idOf = (raw: string) => {
    const r = TaskId.safeParse(raw);
    if (!r.success) throw new BridgeError(404, 'not_found');
    return r.data;
  };

  app.post('/tasks', async (c) => {
    const { task, created } = await createTask(pool, c.get('agent'), await parse(NewTaskBody, c.req));
    if (!created) return c.json({ task }, 200);
    return c.json({ task }, task.state === 'rejected' ? 422 : 201);
  });
  app.get('/tasks/:id', async (c) =>
    c.json({ task: await getTask(pool, idOf(c.req.param('id')), c.get('agent')) }));
  app.get('/tasks/:id/events', async (c) =>
    c.json({ events: await getEvents(pool, idOf(c.req.param('id')), c.get('agent')) }));
  app.post('/tasks/:id/complete', async (c) => {
    const { output } = await parse(OutputBody, c.req);
    return c.json({ task: await finishTask(pool, idOf(c.req.param('id')), c.get('agent'), 'completed', output) });
  });
  app.post('/tasks/:id/fail', async (c) => {
    const { output } = await parse(OutputBody, c.req);
    return c.json({ task: await finishTask(pool, idOf(c.req.param('id')), c.get('agent'), 'failed', output) });
  });
  app.post('/tasks/:id/cancel', async (c) =>
    c.json({ task: await cancelTask(pool, idOf(c.req.param('id')), c.get('agent')) }));

  app.onError((e, c) => {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status);
    // Postgres rejects these in jsonb/text (for example \u0000): bad input, not a server fault.
    const code = (e as { code?: string }).code;
    if (code === '22P05' || code === '22021') return c.json({ error: 'invalid_body' }, 400);
    console.error(e);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
