import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { Pool } from 'pg';
import { z } from 'zod';
import { mountActivation } from './activation.ts';
import { claimReply, pendingTasks, PendingInput } from './claim.ts';
import { logError } from './log.ts';
import { ContextPackInput, contextPack, DATA_LABEL, memoryEvents, MemoryEventsInput, memoryHistory, MemoryHistoryInput, memoryLog, MemoryLogInput,
  memorySearch, MemorySearchInput, memoryWrite, MemoryWriteInput } from './memory.ts';
import { jsonWithin, stripHiddenDeep } from './secrets.ts';
import { BridgeError, cancelTask, createTask, finishTask, getEvents, getTask } from './tasks.ts';

const sha = (s: string) => createHash('sha256').update(s).digest();
const MAX_TASK_INPUT_BYTES = 64 * 1024;
const MAX_TASK_OUTPUT_BYTES = 1024 * 1024; // Same as the body limit: this one exists to bound the depth.
const MIN_CRON_SECRET = 32;
const bearerOf = (c: Context) => c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];

// strict: hop, root_id, risk and from_agent are the bridge's to decide, so sending them is an error.
export const NewTaskBody = z.strictObject({
  to_agent: z.string().min(1).max(100),
  intent: z.string().min(1).max(100),
  input: z.record(z.string(), z.unknown()).refine((v) => jsonWithin(v, MAX_TASK_INPUT_BYTES), 'input too large or too deep'),
  idempotency_key: z.string().min(1).max(200),
  parent_id: z.uuid().toLowerCase().optional(),
});
export const TaskOutput = z.record(z.string(), z.unknown()).refine((v) => jsonWithin(v, MAX_TASK_OUTPUT_BYTES), 'output too large or too deep');
const OutputBody = z.strictObject({ output: TaskOutput });
const TaskId = z.uuid();

export type AppOptions = {
  /** Bearer token for /cron/dispatch. Unset or short means that route always answers 401. */
  cronSecret?: string | undefined;
  /** One dispatcher pass behind the breaker. */
  pass?: () => Promise<number>;
  /** Keeps the function alive for work that outlives the response. */
  defer?: (p: Promise<unknown>) => void;
};

/** Sends a new task now instead of on the next cron tick. A failure costs only that wait: cron picks the task up. */
export const dispatchSoon = ({ pass, defer }: AppOptions) => () => {
  if (pass) defer?.(pass().catch((e: unknown) => logError('immediate dispatch', e)));
};

/** `keys` maps agent id to its bearer key. No keys means every request gets a 401. */
export function createApp(pool: Pool, keys: Record<string, string>, options: AppOptions = {}) {
  const entries = Object.entries(keys).map(([agent, key]) => [agent, sha(key)] as const);
  const cronHash = (options.cronSecret?.length ?? 0) >= MIN_CRON_SECRET ? sha(options.cronSecret!) : null;
  const kick = dispatchSoon(options);
  const app = new Hono<{ Variables: { agent: string } }>();

  // First, so every request gets exactly one line. The route template only: a path can hold ids, and a query anything.
  // Per instance: this count resets with it. Only auth answers 401.
  let authFailures = 0;
  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    const failed = c.res.status === 401;
    if (failed) authFailures++;
    console.log(JSON.stringify({
      agent: c.get('agent') ?? null, method: c.req.method, route: routePath(c), status: c.res.status, ms: Date.now() - started,
      ...(failed ? { auth_failures: authFailures } : {}),
    }));
  });

  mountActivation(app);

  // Before auth on purpose: the host probes it without a key, so it says only up or down.
  app.get('/health', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  // Before auth: pg_cron is no agent, and an idle tick must not spend a query on an agent row.
  app.post('/cron/dispatch', async (c) => {
    const token = bearerOf(c);
    if (!cronHash || !options.pass || !token || !timingSafeEqual(sha(token), cronHash)) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent', 'cron');
    try {
      return c.json({ status: 'ok', claimed: await options.pass() });
    } catch (e) {
      logError('cron dispatch', e);
      return c.json({ error: 'dispatch_failed' }, 500);
    }
  });

  app.use(async (c, next) => {
    const token = bearerOf(c);
    const hash = token ? sha(token) : null;
    const agent = hash && entries.find(([, h]) => timingSafeEqual(h, hash))?.[0];
    if (!agent) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent', agent);
    const { rows: [row] } = await pool.query<{ enabled: boolean }>('SELECT enabled FROM agent WHERE id = $1', [agent]);
    if (!row?.enabled) return c.json({ error: 'agent_disabled' }, 403);
    await next();
  });

  app.use(bodyLimit({ maxSize: 1024 * 1024 }));

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

  app.get('/whoami', (c) => c.json({ agent: c.get('agent') }));

  app.post('/tasks', async (c) => {
    const { task, created } = await createTask(pool, c.get('agent'), await parse(NewTaskBody, c.req));
    if (task.state === 'rejected') return c.json({ task }, 422);
    if (created && task.state === 'submitted') kick();
    return c.json({ task }, created ? 201 : 200);
  });
  // Reads return what agents wrote, so they say it is data and drop what a human could not see.
  const data = (c: Context, body: Record<string, unknown>) => c.json({ data_label: DATA_LABEL, ...stripHiddenDeep(body) });

  // Before /tasks/:id, which would read "pending" as an id.
  app.get('/tasks/pending', async (c) =>
    data(c, await pendingTasks(pool, c.get('agent'), await parse(PendingInput, { json: async () => c.req.query() as unknown }))));
  // Same answer as the MCP tool, including for a malformed id: it is not run through idOf, which would answer 404.
  app.post('/tasks/:id/claim', async (c) => c.json(await claimReply(pool, c.req.param('id'), c.get('agent'))));
  app.get('/tasks/:id', async (c) =>
    data(c, { task: await getTask(pool, idOf(c.req.param('id')), c.get('agent')) }));
  app.get('/tasks/:id/events', async (c) =>
    data(c, { events: await getEvents(pool, idOf(c.req.param('id')), c.get('agent')) }));
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

  const fromQuery = (c: Context) => ({ json: async () => c.req.query() as unknown });
  app.post('/memory/facts', async (c) => {
    const { fact, created } = await memoryWrite(pool, c.get('agent'), await parse(MemoryWriteInput, c.req));
    return c.json({ fact }, created ? 201 : 200);
  });
  app.get('/memory/facts', async (c) =>
    data(c, { facts: await memoryHistory(pool, c.get('agent'), await parse(MemoryHistoryInput, fromQuery(c))) }));
  app.get('/memory/search', async (c) =>
    data(c, { facts: await memorySearch(pool, c.get('agent'), await parse(MemorySearchInput, fromQuery(c))) }));
  app.get('/memory/context', async (c) =>
    data(c, await contextPack(pool, await parse(ContextPackInput, fromQuery(c)))));
  app.post('/memory/events', async (c) =>
    c.json({ event: await memoryLog(pool, c.get('agent'), await parse(MemoryLogInput, c.req)) }, 201));
  app.get('/memory/events', async (c) =>
    data(c, { events: await memoryEvents(pool, c.get('agent'), await parse(MemoryEventsInput, fromQuery(c))) }));

  app.onError((e, c) => {
    if (e instanceof BridgeError) return c.json({ error: e.message }, e.status);
    if (e instanceof HTTPException) return c.json({ error: 'request_rejected' }, e.status);
    // Postgres rejects these in jsonb/text (for example \u0000): bad input, not a server fault.
    const code = (e as { code?: string }).code;
    if (code === '22P05' || code === '22021') return c.json({ error: 'invalid_body' }, 400);
    logError(routePath(c), e);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
