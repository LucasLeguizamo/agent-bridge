// Regression tests for the pre-deploy audit findings. Each describe names its finding, and each test fails without its fix.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve, type ServerType } from '@hono/node-server';
import pg from 'pg';
import { breakerOpen, createGrokAdapter, grokConfig } from '../src/grok.ts';
import { createApp } from '../src/http.ts';
import { mountMcp } from '../src/mcp.ts';
import { contextPack, memoryLog, memoryWrite } from '../src/memory.ts';
import { MAX_ATTEMPTS, runOnce, sweep, type Adapters } from '../src/queue.ts';
import { createTask, type Task } from '../src/tasks.ts';
import { openTestSchema } from './pg.ts';

const KEYS = { grok: 'g'.repeat(32), instinct: 'i'.repeat(32), claude: 'c'.repeat(32) };
type Agent = keyof typeof KEYS;
const HIDDEN = /[\u200B\u202E\u2060\u{E0041}\u0007]/u;
const LEAK = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let bridge: ServerType;
let mcpUrl: string;
let receiver: Server;
let adapters: Adapters;
let hits: string[] = [];
let nextStatus: number[] = [];
let seq = 0;
const clients: Client[] = [];

async function mcp(agent: Agent) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${KEYS[agent]}` } },
  }));
  clients.push(client);
  return client;
}
async function tool(agent: Agent, name: string, args: Record<string, unknown>) {
  const r = await (await mcp(agent)).callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  let body: Record<string, any>;
  try { body = JSON.parse(r.content[0]!.text) as Record<string, any>; } catch { body = { raw: r.content[0]!.text }; }
  return { isError: r.isError === true, body };
}
async function call(agent: Agent | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...(agent ? { authorization: `Bearer ${KEYS[agent]}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const newTask = (over: Record<string, unknown> = {}) => {
  seq++;
  return { to_agent: 'grok', intent: 'research', input: { query: `q${seq}` }, idempotency_key: `k${seq}`, ...over };
};
const pass = () => runOnce(pool, adapters);
const reload = async (id: string) =>
  (await pool.query<Task & { claimed_at: Date | null }>('SELECT * FROM task WHERE id = $1', [id])).rows[0]!;
const dueNow = (id: string) => pool.query('UPDATE task SET next_attempt_at = now() WHERE id = $1', [id]);
/** A task delivered to Grok Bot, as the run finds it. */
const offered = async (over: Record<string, unknown> = {}) => {
  const { task } = await createTask(pool, 'instinct', newTask(over));
  await pass();
  return task;
};

before(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push(Buffer.concat(chunks).toString());
      res.statusCode = nextStatus.shift() ?? 200;
      if (res.statusCode === 302) res.setHeader('location', '/redirected');
      res.end('{}');
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');

  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 6 });
  adapters = {
    grok: createGrokAdapter(pool, { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/h`, key: 'w'.repeat(40) }),
    email: { async deliver() {} },
  };
  app = createApp(pool, KEYS);
  mountMcp(app, pool);
  bridge = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(bridge, 'listening');
  mcpUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/mcp`;
});
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await new Promise((r) => (bridge ? bridge.close(r) : r(null)));
  await pool?.end();
  await db?.stop();
  receiver?.closeAllConnections();
  receiver?.close();
});
beforeEach(async () => {
  hits = [];
  nextStatus = [];
  await pool.query('TRUNCATE adapter_pause, pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'grok'), ('instinct', 'email'), ('claude', 'email')`);
});

describe('H2: hidden characters and origin in what agents read', () => {
  test('task_claim strips hidden characters at any depth, keeps line breaks, and labels the sender inside data', async () => {
    const { task } = await createTask(pool, 'instinct', newTask({
      intent: 'ops.nested',
      input: { 'k\u202Eey': { deep: ['a\u200Bb', { c: 'line1\nline2\u2060\u{E0041}\u0007', n: 7, ok: true, none: null }] } },
    }));
    await pool.query(`UPDATE task SET risk = 'read', state = 'submitted' WHERE id = $1`, [task.id]);
    await pass();

    const { body } = await tool('grok', 'task_claim', { task_id: task.id });
    assert.equal(body.claimed, true);
    assert.doesNotMatch(JSON.stringify(body), HIDDEN);
    assert.deepEqual(body.data.input, { key: { deep: ['ab', { c: 'line1\nline2', n: 7, ok: true, none: null }] } });
    assert.equal(body.data.from_agent, 'instinct');
  });

  test('memory_search strips hidden characters from key, value and origin', async () => {
    await memoryWrite(pool, 'instinct', { key: 'ho\u200Btel', value: 'Atlas \u202Eplaya\u200B', origin: 'we\u2060b' });
    const { body } = await tool('grok', 'memory_search', { query: 'atlas' });
    const [fact] = body.data.facts;
    assert.equal(fact.key, 'hotel');
    assert.equal(fact.value, 'Atlas playa');
    assert.equal(fact.claimed_origin, 'web');
  });
});

describe('H3 and L2: secret filter', () => {
  const refusals = async (type: string) =>
    (await pool.query(`SELECT task_id, actor, payload FROM event WHERE type = $1 ORDER BY id`, [type])).rows;

  test('createTask refuses a secret anywhere in the input, stores no task, and audits without content', async () => {
    for (const input of [
      { query: `usa ${LEAK}` },
      { query: `primera linea\n${LEAK}` }, // In JSON this is \nghp_, which would hide it from a word boundary.
      { a: { b: [{ c: `x ${LEAK}` }] } },
      { [LEAK]: 'as a key' },
      { password: 'hunter2' },
    ]) {
      const r = await call('instinct', 'POST', '/tasks', newTask({ input }));
      assert.equal(r.status, 422, JSON.stringify(input));
      assert.equal(r.body.error, 'secret_rejected');
    }
    assert.equal((await pool.query('SELECT 1 FROM task')).rows.length, 0);
    const audit = await refusals('secret_rejected');
    assert.equal(audit.length, 5);
    for (const a of audit) assert.deepEqual(a, { task_id: null, actor: 'instinct', payload: { reason: 'secret' } });
  });

  test('createTask refuses a secret in the intent too', async () => {
    assert.equal((await call('instinct', 'POST', '/tasks', newTask({ intent: `do ${LEAK}` }))).status, 422);
  });

  test('task_complete and REST close refuse a secret in the output and leave the task open', async () => {
    const t = await offered();
    await tool('grok', 'task_claim', { task_id: t.id });

    const viaMcp = await tool('grok', 'task_complete', { task_id: t.id, output: { answer: `key ${LEAK}` } });
    assert.equal(viaMcp.isError, true);
    assert.equal(viaMcp.body.error, 'secret_rejected');
    const viaRest = await call('grok', 'POST', `/tasks/${t.id}/complete`, { output: { deep: [`x\n${LEAK}`] } });
    assert.equal(viaRest.status, 422);

    const cur = await reload(t.id);
    assert.equal(cur.state, 'working');
    assert.equal(cur.output, null);
    const audit = await refusals('secret_rejected');
    assert.equal(audit.length, 2);
    for (const a of audit) assert.deepEqual(a, { task_id: t.id, actor: 'grok', payload: { reason: 'secret' } });
  });

  test('a refused output from an agent outside the task does not attach to that task', async () => {
    const t = await offered();
    const r = await call('claude', 'POST', `/tasks/${t.id}/complete`, { output: { a: LEAK } });
    assert.equal(r.status, 422);
    assert.deepEqual(await refusals('secret_rejected'), [{ task_id: null, actor: 'claude', payload: { reason: 'secret' } }]);
  });

  test('stored refusal audits are capped per agent, while the refusal itself still happens', async () => {
    await pool.query(`INSERT INTO event (actor, type, payload)
      SELECT 'instinct', 'secret_rejected', '{"reason":"secret"}' FROM generate_series(1, 100)`);
    assert.equal((await call('instinct', 'POST', '/tasks', newTask({ input: { query: LEAK } }))).status, 422);
    assert.equal((await refusals('secret_rejected')).length, 100);
  });

  test('containsSecret lives in src/secrets.ts and sees through hidden characters', async () => {
    const { containsSecret } = await import('../src/secrets.ts');
    for (const text of [
      'ghp_abcdefghij\u200Bklmnopqrstuvwxyz0123456789',
      'pass\u200Bword: hunter2',
      'pass\u2060word\u202E = hunter2',
      '-----BEGIN RSA PRI\u200BVATE KEY-----',
      `linea uno\n${LEAK}`,
    ]) assert.equal(containsSecret(text), true, text);
    for (const ok of ['la clave es practicar', 'hola\nmundo', '']) assert.equal(containsSecret(ok), false, ok);
  });

  test('a memory key is tested before it is lowercased, on every path', async () => {
    const shape = 'AKIAIOSFODNN7EXAMPLE'; // Only matches in upper case.
    await assert.rejects(memoryWrite(pool, 'grok', { key: shape, value: 'v' }), { status: 422, message: 'secret_rejected' });
    const http = await call('grok', 'POST', '/memory/facts', { key: shape, value: 'v' });
    assert.equal(http.status, 422);
    const viaMcp = await tool('grok', 'memory_write', { key: shape, value: 'v' });
    assert.equal(viaMcp.body.error, 'secret_rejected');
    assert.equal((await pool.query('SELECT 1 FROM fact')).rows.length, 0);
  });

  test('keys still store lowercased, so Vuelo and vuelo stay one fact', async () => {
    await memoryWrite(pool, 'grok', { key: 'Vuelo', value: 'uno' });
    const { fact } = await memoryWrite(pool, 'grok', { key: 'vuelo', value: 'uno' });
    assert.equal(fact.key, 'vuelo');
    assert.equal((await pool.query('SELECT 1 FROM fact')).rows.length, 1);
  });

  test('a secret name split by a hidden character is refused', async () => {
    await assert.rejects(memoryWrite(pool, 'grok', { key: 'db.pass\u200Bword', value: 'x' }), { message: 'secret_rejected' });
  });

  test('a memory log with a secret after a line break is refused', async () => {
    await assert.rejects(memoryLog(pool, 'grok', { type: 'note', payload: { t: `uno\n${LEAK}` } }), { message: 'secret_rejected' });
  });
});

describe('M1: explicit parent_id cannot reset hops', () => {
  test('naming an old low-hop parent keeps the higher hop and root of recent work', async () => {
    const a = await call('grok', 'POST', '/tasks', newTask({ to_agent: 'instinct' }));
    await runOnce(pool, adapters);
    const b = await call('instinct', 'POST', '/tasks', newTask({ to_agent: 'grok' }));
    await runOnce(pool, adapters);
    const c = await call('grok', 'POST', '/tasks', newTask({ to_agent: 'instinct' }));
    await runOnce(pool, adapters);
    assert.deepEqual([a, b, c].map((r) => r.body.task.hop), [0, 1, 2]);

    const payload = newTask({ to_agent: 'grok', parent_id: a.body.task.id });
    const reset = await call('instinct', 'POST', '/tasks', payload);
    assert.equal(reset.status, 201);
    assert.equal(reset.body.task.hop, 3, 'continues from hop 2, not from the hop 0 parent it named');
    assert.equal(reset.body.task.root_id, a.body.task.root_id);
    assert.equal(reset.body.task.parent_id, a.body.task.id);
    assert.equal((await call('instinct', 'POST', '/tasks', payload)).status, 200, 'a retry is still the same request');
  });

  test('a higher explicit parent still wins over a lower implicit one', async () => {
    const a = await call('grok', 'POST', '/tasks', newTask({ to_agent: 'instinct' }));
    await runOnce(pool, adapters);
    await pool.query('UPDATE task SET hop = 2 WHERE id = $1', [a.body.task.id]);
    const fresh = await call('claude', 'POST', '/tasks', newTask({ to_agent: 'instinct' }));
    await runOnce(pool, adapters);
    await pool.query('UPDATE task SET hop = 0 WHERE id = $1', [fresh.body.task.id]);
    await pool.query(`UPDATE task SET created_at = now() - interval '20 minutes', state = 'completed' WHERE id = $1`, [a.body.task.id]);
    const r = await call('instinct', 'POST', '/tasks', newTask({ to_agent: 'grok', parent_id: a.body.task.id }));
    assert.equal(r.body.task.hop, 3);
  });
});

describe('M2: verified facts', () => {
  const verify = (key: string) => pool.query(`UPDATE fact SET trust = 'verified' WHERE key = $1`, [key]);

  test('an agent cannot replace a verified fact, and the attempt is logged', async () => {
    const { fact } = await memoryWrite(pool, 'instinct', { key: 'iban', value: 'ES00' });
    await verify('iban');

    await assert.rejects(memoryWrite(pool, 'grok', { key: 'iban', value: 'ES99 attacker' }), { status: 409, message: 'verified_fact' });
    const { rows } = await pool.query('SELECT id, value, superseded_by FROM fact');
    assert.deepEqual(rows, [{ id: fact.id, value: 'ES00', superseded_by: null }]);

    const { rows: audit } = await pool.query(`SELECT actor, payload FROM event WHERE type = 'memory_rejected'`);
    assert.deepEqual(audit, [{ actor: 'grok', payload: { reason: 'verified_fact', namespace: 'shared', key: 'iban' } }]);
    assert.ok(!JSON.stringify(audit).includes('attacker'), 'the rejected value is not stored');
  });

  test('writing the same value over a verified fact is still a no-op', async () => {
    await memoryWrite(pool, 'instinct', { key: 'iban', value: 'ES00' });
    await verify('iban');
    assert.equal((await memoryWrite(pool, 'grok', { key: 'iban', value: 'ES00' })).created, false);
  });

  test('the origin an agent supplies is rendered as claimed_origin', async () => {
    await memoryWrite(pool, 'grok', { key: 'hotel', value: 'Atlas \u202Eplaya\u200B', origin: 'web' });
    const pack = await contextPack(pool, { query: 'hotel' });
    assert.match(pack.text, /claimed_origin: "web"/);
    assert.doesNotMatch(pack.text, /[( ]origin:/);
    const { body } = await tool('grok', 'memory_search', { query: 'hotel' });
    assert.equal(body.data.facts[0].claimed_origin, 'web');
    assert.equal('origin' in body.data.facts[0], false);
  });
});

describe('M3: task_claim honors the kill switch and the pair breaker', () => {
  test('a disabled sender blocks the claim, and re-enabling allows it', async () => {
    const t = await offered();
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'instinct'`);
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, false);
    assert.equal((await reload(t.id)).claimed_at, null);
    await pool.query(`UPDATE agent SET enabled = true WHERE id = 'instinct'`);
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, true);
  });

  test('an active pair pause blocks the claim, and an expired one does not', async () => {
    const t = await offered();
    await pool.query(`INSERT INTO pair_pause VALUES ('grok', 'instinct', now() + interval '1 hour', 'test')`);
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, false);
    await pool.query(`UPDATE pair_pause SET paused_until = now() - interval '1 second'`);
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, true);
  });
});

describe('M4: size and rate caps', () => {
  const addLog = (agent: string, n: number, age = '1 minute', type = 'memory_write') => pool.query(
    `INSERT INTO event (actor, type, payload, created_at)
     SELECT $1, $2, '{}', now() - $3::interval FROM generate_series(1, $4::int)`, [agent, type, age, n]);

  test('task input over 64 KB is refused at both doors, and just under it is accepted', async () => {
    const big = { input: { query: 'x'.repeat(65 * 1024) } };
    assert.equal((await call('instinct', 'POST', '/tasks', newTask(big))).status, 400);
    assert.equal((await tool('instinct', 'task_create', newTask(big))).isError, true);
    assert.equal((await pool.query('SELECT 1 FROM task')).rows.length, 0);
    assert.equal((await call('instinct', 'POST', '/tasks', newTask({ input: { query: 'x'.repeat(60 * 1024) } }))).status, 201);
  });

  test('the size is measured in bytes, not characters', async () => {
    const r = await call('instinct', 'POST', '/tasks', newTask({ input: { query: 'ñ'.repeat(40 * 1024) } }));
    assert.equal(r.status, 400);
  });

  test('absurdly deep input is a clean 400', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 5000; i++) deep = [deep];
    const r = await call('instinct', 'POST', '/tasks', newTask({ input: { deep } }));
    assert.equal(r.status, 400);
  });

  test('memory writes stop at the hourly cap for that agent only', async () => {
    await addLog('grok', 200);
    await assert.rejects(memoryWrite(pool, 'grok', { key: 'a', value: 'b' }), { status: 429, message: 'memory_rate_limited' });
    assert.equal((await pool.query('SELECT 1 FROM fact')).rows.length, 0);
    assert.equal((await memoryWrite(pool, 'instinct', { key: 'a', value: 'b' })).created, true);
  });

  test('memory logs count toward the same cap, and old rows stop counting', async () => {
    await addLog('grok', 200, '1 minute', 'agent.note');
    await assert.rejects(memoryLog(pool, 'grok', { type: 'note', payload: {} }), { status: 429 });
    await assert.rejects(memoryWrite(pool, 'grok', { key: 'a', value: 'b' }), { status: 429 });

    await pool.query('ALTER TABLE event DISABLE TRIGGER event_immutable');
    await pool.query(`UPDATE event SET created_at = now() - interval '61 minutes' WHERE actor = 'grok'`);
    await pool.query('ALTER TABLE event ENABLE TRIGGER event_immutable');
    assert.equal((await memoryLog(pool, 'grok', { type: 'note', payload: {} })).actor, 'grok');
  });

  test('an unchanged rewrite is not counted, so retries at the cap still answer', async () => {
    await memoryWrite(pool, 'grok', { key: 'a', value: 'b' });
    await addLog('grok', 200);
    assert.equal((await memoryWrite(pool, 'grok', { key: 'a', value: 'b' })).created, false);
  });

  test('the cap holds under concurrent writes', async () => {
    await addLog('grok', 198);
    const out = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      memoryWrite(pool, 'grok', { key: `k${i}`, value: 'v' })));
    assert.equal(out.filter((r) => r.status === 'fulfilled').length, 2);
  });
});

describe('M5: request log', () => {
  const lines = (fn: { mock: { calls: { arguments: unknown[] }[] } }) => fn.mock.calls.map((c) => JSON.parse(String(c.arguments[0])) as Record<string, any>);

  test('one line per request with agent, route and status, and never the query, body or key', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const { body: { task } } = await call('instinct', 'POST', '/tasks', newTask({ input: { query: 'BODYMARKER' } }));
    log.mock.resetCalls();

    const res = await app.request(`/tasks/${task.id}?token=QUERYMARKER`, { headers: { authorization: `Bearer ${KEYS.instinct}` } });
    assert.equal(res.status, 200);
    await app.request('/memory/search?query=QUERYMARKER', { headers: { authorization: `Bearer ${KEYS.instinct}` } });
    await call('instinct', 'POST', '/tasks', newTask({ input: { query: 'BODYMARKER2' } }));

    const got = lines(log);
    assert.equal(got.length, 3);
    assert.deepEqual(got.map(({ agent, route, status, method }) => ({ agent, route, status, method })), [
      { agent: 'instinct', route: '/tasks/:id', status: 200, method: 'GET' },
      { agent: 'instinct', route: '/memory/search', status: 200, method: 'GET' },
      { agent: 'instinct', route: '/tasks', status: 201, method: 'POST' },
    ]);
    const all = log.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.doesNotMatch(all, /MARKER/);
    assert.ok(!all.includes(task.id), 'the route is the template, not the path');
    assert.ok(!all.includes(KEYS.instinct));
  });

  test('failed auth is counted, is never attributed to an agent, and does not log the attempted key', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const local = createApp(pool, KEYS);
    await local.request('/tasks/x', { headers: { authorization: 'Bearer KEYATTEMPT1' } });
    await local.request('/tasks/x');
    await local.request('/memory/search?query=QUERYMARKER', { headers: { authorization: `Bearer ${KEYS.grok}` } });

    const got = lines(log);
    assert.equal(got.length, 3);
    assert.deepEqual(got.map((l) => [l.agent, l.status, l.auth_failures]), [[null, 401, 1], [null, 401, 2], ['grok', 200, undefined]]);
    assert.doesNotMatch(log.mock.calls.map((c) => String(c.arguments[0])).join('\n'), /KEYATTEMPT|MARKER/);
  });

  test('a disabled agent and an unmatched route each get one line', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const local = createApp(pool, KEYS);
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'claude'`);
    await local.request('/tasks/x', { headers: { authorization: `Bearer ${KEYS.claude}` } });
    await local.request('/secret/path/UNKNOWNPATHMARKER', { headers: { authorization: `Bearer ${KEYS.grok}` } });
    const got = lines(log);
    assert.equal(got.length, 2);
    assert.equal(got[0]!.agent, 'claude');
    assert.equal(got[0]!.status, 403);
    assert.equal(got[1]!.status, 404);
    assert.doesNotMatch(log.mock.calls.map((c) => String(c.arguments[0])).join('\n'), /UNKNOWNPATHMARKER/);
  });
});

describe('Log only code and message from pg errors', () => {
  const pgError = () => Object.assign(new Error('duplicate key'), {
    code: '23505', detail: 'Key (value)=(SECRETDETAIL) already exists.', where: 'SECRETWHERE', internalQuery: 'SECRETQUERY',
  });
  const failing = () => ({
    query: async (sql: string) => {
      if (/SELECT enabled/.test(sql)) return { rows: [{ enabled: true }] };
      throw pgError();
    },
  }) as unknown as pg.Pool;
  const printed = (fn: { mock: { calls: { arguments: unknown[] }[] } }) =>
    fn.mock.calls.map((c) => c.arguments.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(' ')).join('\n');

  test('an HTTP handler failure logs code and message only', async (t) => {
    t.mock.method(console, 'log', () => {});
    const err = t.mock.method(console, 'error', () => {});
    const res = await createApp(failing(), KEYS).request('/memory/search?query=a', { headers: { authorization: `Bearer ${KEYS.grok}` } });
    assert.equal(res.status, 500);
    const out = printed(err);
    assert.match(out, /23505/);
    assert.match(out, /duplicate key/);
    assert.doesNotMatch(out, /SECRET/);
  });

  test('an MCP tool failure logs code and message only', async (t) => {
    const err = t.mock.method(console, 'error', () => {});
    const local = createApp(failing(), KEYS);
    mountMcp(local, failing());
    const server = serve({ fetch: local.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${KEYS.grok}` } },
    }));
    try {
      await client.callTool({ name: 'memory_search', arguments: { query: 'x' } });
      const out = printed(err);
      assert.match(out, /23505/);
      assert.doesNotMatch(out, /SECRET/);
    } finally {
      await client.close();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('L1: REST close', () => {
  test('honors the deadline', async () => {
    const t = await offered({ to_agent: 'claude' });
    await pool.query(`UPDATE task SET deadline_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    const r = await call('claude', 'POST', `/tasks/${t.id}/complete`, { output: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'deadline_passed');
    assert.equal((await reload(t.id)).state, 'working');
  });

  test('requires a claim from an adapter that uses claims', async () => {
    const t = await offered();
    for (const verb of ['complete', 'fail']) {
      const r = await call('grok', 'POST', `/tasks/${t.id}/${verb}`, { output: {} });
      assert.equal(r.status, 409, verb);
      assert.equal(r.body.error, 'not_claimed');
    }
    await tool('grok', 'task_claim', { task_id: t.id });
    assert.equal((await call('grok', 'POST', `/tasks/${t.id}/complete`, { output: { a: 1 } })).status, 200);
  });

  test('does not require a claim from an adapter with no claim step, such as email', async () => {
    const t = await offered({ to_agent: 'claude' });
    assert.equal((await reload(t.id)).claimed_at, null);
    assert.equal((await call('claude', 'POST', `/tasks/${t.id}/complete`, { output: { a: 1 } })).status, 200);
  });

  test('an idempotent repeat after close still answers 200, past the deadline too', async () => {
    const t = await offered({ to_agent: 'claude' });
    const path = `/tasks/${t.id}/complete`;
    assert.equal((await call('claude', 'POST', path, { output: { a: 1 } })).status, 200);
    await pool.query(`UPDATE task SET deadline_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    assert.equal((await call('claude', 'POST', path, { output: { a: 1 } })).status, 200);
  });
});

describe('L3: webhook key format', () => {
  const URL_OK = 'https://x.test/h';

  test('refuses a short key or one with whitespace or control characters, without echoing it', () => {
    for (const key of ['SECRETshort', 'SECRET key with spaces xxxxxxxxxxxxxxxxxx', 'SECRETxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n', 'SECRETxxxxxxxxxxxxxxxxxxxxxxxx\u200B']) {
      assert.throws(() => grokConfig({ GROK_WEBHOOK_URL: URL_OK, GROK_WEBHOOK_KEY: key }),
        (e: Error) => /GROK_WEBHOOK_KEY/.test(e.message) && !e.message.includes('SECRET'), JSON.stringify(key));
    }
  });

  test('accepts a long token of visible characters', () => {
    assert.ok(grokConfig({ GROK_WEBHOOK_URL: URL_OK, GROK_WEBHOOK_KEY: 'abc-DEF_123.456~789+xyz/000=' }));
  });
});

describe('the webhook bearer key', () => {
  test('is never replayed to where a redirect points: a redirect is a failed delivery', async () => {
    nextStatus = [302];
    const t = await offered();
    assert.equal(hits.length, 1, 'the redirect target got nothing');
    const { rows } = await pool.query(`SELECT 1 FROM event WHERE task_id = $1 AND type = 'delivery_failed'`, [t.id]);
    assert.equal(rows.length, 1);
    assert.equal((await pool.query(`SELECT 1 FROM event WHERE task_id = $1 AND type = 'delivered'`, [t.id])).rows.length, 0);
  });
});

describe('L5: breaker counts delivery attempts', () => {
  const failedSends = async (n: number) => {
    nextStatus = Array.from({ length: n }, () => 500);
    const tasks = [];
    for (let i = 0; i < n; i++) tasks.push((await createTask(pool, 'instinct', newTask())).task);
    await pass();
    assert.equal(hits.length, n);
    return tasks;
  };

  test('three tasks whose webhook failed with no claim trip it, since a failed answer does not prove no run started', async () => {
    await failedSends(3);
    assert.equal(await breakerOpen(pool, 0), true);
  });

  test('one task retried three times does not trip it: a single transient failure must not pause an hour', async () => {
    const [t] = await failedSends(1);
    for (let i = 0; i < 2; i++) {
      nextStatus = [500];
      await dueNow(t!.id);
      await pass();
    }
    assert.equal(hits.length, 3);
    assert.equal(await breakerOpen(pool, 0), false);
  });

  test('a successful send counts once, though it writes both an attempt and a run event', async () => {
    await offered();
    await offered();
    assert.equal(await breakerOpen(pool, 0), false);
  });

  test('attempts to agents on other adapters do not count', async () => {
    for (let i = 0; i < 3; i++) await offered({ to_agent: 'claude' });
    assert.equal(await breakerOpen(pool, 0), false);
  });
});

describe('L6 and L4: routine and rotation docs', () => {
  const read = (p: string) => readFileSync(new URL(`../docs/${p}`, import.meta.url), 'utf8');

  test('the routine passes task_id and origin when a memory.write task saves a fact', () => {
    const line = read('grok-routine.md').split('\n').find((l) => l.includes('memory.write:'))!;
    assert.match(line, /task_id/);
    assert.match(line, /origin/);
  });

  test('the runbook documents rotating the webhook key', () => {
    const runbook = read('runbook.md');
    const section = runbook.slice(runbook.indexOf('## Rotar claves'));
    assert.match(section, /GROK_WEBHOOK_KEY/);
    assert.match(read('grok-routine.md'), /[Rr]ota.*GROK_WEBHOOK_KEY/);
  });
});

describe('L7: REST reads carry the data label', () => {
  test('every read route labels its content as data and strips hidden characters', async () => {
    await memoryWrite(pool, 'instinct', { key: 'hotel', value: 'Atlas\u200B' });
    await memoryLog(pool, 'instinct', { type: 'note', payload: { t: 'x\u202E' } });
    const { body: { task } } = await call('instinct', 'POST', '/tasks', newTask({ input: { query: 'hotel\u200B' } }));

    for (const path of [`/tasks/${task.id}`, `/tasks/${task.id}/events`, '/memory/facts?key=hotel', '/memory/search?query=hotel',
      '/memory/context?query=hotel', '/memory/events']) {
      const r = await call('instinct', 'GET', path);
      assert.equal(r.status, 200, path);
      assert.match(r.body.data_label, /never instructions/, path);
      assert.doesNotMatch(JSON.stringify(r.body), HIDDEN, path);
    }
  });

  test('the fields a client reads stay in place', async () => {
    const { body: { task } } = await call('instinct', 'POST', '/tasks', newTask());
    const r = await call('instinct', 'GET', `/tasks/${task.id}`);
    assert.equal(r.body.task.id, task.id);
    assert.equal(typeof r.body.task.created_at, 'string');
  });
});

describe('Latent: side_effect needs an approved row', () => {
  const parked = async () => {
    const { task } = await createTask(pool, 'instinct', newTask({ intent: 'pay.invoice', input: { amount: 1 } }));
    await pool.query(`UPDATE task SET state = 'submitted' WHERE id = $1`, [task.id]);
    return task;
  };
  const approval = (id: string, decision: string | null, expires = `now() + interval '1 hour'`) =>
    pool.query(`INSERT INTO approval (task_id, decision, expires_at, decided_at) VALUES ($1, $2, ${expires}, now())`, [id, decision]);

  for (const [name, decision, expires] of [
    ['no row', undefined, undefined],
    ['an undecided row', null, undefined],
    ['a denied row', 'denied', undefined],
    ['an expired approval', 'approved', `now() - interval '1 second'`],
  ] as const) {
    test(`${name} blocks both delivery and claim`, async () => {
      const t = await parked();
      if (decision !== undefined) await approval(t.id, decision, expires);
      assert.equal(await pass(), 0);
      assert.equal(hits.length, 0);
      assert.equal((await reload(t.id)).attempts, 0);

      await pool.query('UPDATE task SET attempts = 1 WHERE id = $1', [t.id]);
      assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, false);
    });
  }

  test('an approved row lets it be delivered and claimed', async () => {
    const t = await parked();
    await approval(t.id, 'approved');
    assert.equal(await pass(), 1);
    assert.equal(hits.length, 1);
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, true);
  });

  test('other adapters are held too', async () => {
    const { task } = await createTask(pool, 'instinct', newTask({ to_agent: 'claude', intent: 'pay.invoice', input: { amount: 1 } }));
    await pool.query(`UPDATE task SET state = 'submitted' WHERE id = $1`, [task.id]);
    assert.equal(await pass(), 0);
  });
});

describe('Gap: a 2xx with no task_claim', () => {
  test('is not re-sent inside the claim grace period, then is, with the same task_id', async () => {
    const t = await offered();
    assert.equal(hits.length, 1);
    assert.equal(await pass(), 0, 'still inside the grace period');
    const { rows: [r] } = await pool.query(`SELECT extract(epoch FROM next_attempt_at - now())::int AS s FROM task WHERE id = $1`, [t.id]);
    assert.ok(r.s > 290 && r.s <= 300, String(r.s));

    await dueNow(t.id);
    assert.equal(await pass(), 1);
    assert.equal(hits.length, 2);
    assert.deepEqual(JSON.parse(hits[1]!), { task_id: t.id });
    assert.equal((await reload(t.id)).attempts, 2);
  });

  test('the wait doubles between re-sends', async () => {
    const t = await offered();
    await dueNow(t.id);
    await pass();
    const { rows: [r] } = await pool.query(`SELECT extract(epoch FROM next_attempt_at - now())::int AS s FROM task WHERE id = $1`, [t.id]);
    assert.ok(r.s > 590 && r.s <= 600, String(r.s));
  });

  test(`stops at ${MAX_ATTEMPTS} sends in total, then ends failed with an alert`, async () => {
    const t = await offered();
    for (let i = 1; i < MAX_ATTEMPTS + 3; i++) {
      await pool.query(`UPDATE task SET next_attempt_at = now() WHERE id = $1 AND state = 'submitted'`, [t.id]);
      await pass();
    }
    assert.equal(hits.length, MAX_ATTEMPTS);
    const cur = await reload(t.id);
    assert.equal(cur.state, 'failed');
    assert.deepEqual(cur.output, { error: 'delivery_exhausted' });
    const { rows } = await pool.query(`SELECT 1 FROM event WHERE task_id = $1 AND type = 'alert'`, [t.id]);
    assert.equal(rows.length, 1);
  });

  test('a failed send and a re-send share the same budget', async () => {
    nextStatus = [500, 500, 500];
    const t = await offered();
    for (let i = 0; i < 8; i++) {
      await pool.query(`UPDATE task SET next_attempt_at = now() WHERE id = $1 AND state = 'submitted'`, [t.id]);
      await pass();
    }
    assert.equal(hits.length, MAX_ATTEMPTS);
  });

  test('a claimed task is never re-sent, and its run still closes it', async () => {
    const t = await offered();
    assert.equal((await tool('grok', 'task_claim', { task_id: t.id })).body.claimed, true);
    await dueNow(t.id);
    assert.equal(await pass(), 0);
    assert.equal(hits.length, 1);
    assert.equal((await tool('grok', 'task_complete', { task_id: t.id, output: {} })).body.state, 'completed');
  });

  test('a re-sent task can be claimed by the first run, once', async () => {
    const t = await offered();
    await dueNow(t.id);
    await pass();
    const [a, b] = await Promise.all([tool('grok', 'task_claim', { task_id: t.id }), tool('grok', 'task_claim', { task_id: t.id })]);
    assert.deepEqual([a.body.claimed, b.body.claimed].sort(), [false, true]);
  });

  test('an adapter with no claim step is not re-sent: it goes to working on its first 2xx', async () => {
    const t = await offered({ to_agent: 'claude' });
    assert.equal((await reload(t.id)).state, 'working');
    await dueNow(t.id);
    assert.equal(await pass(), 0);
  });

  test('sweep leaves an unclaimed task with attempts left alone', async () => {
    const t = await offered();
    await dueNow(t.id);
    await sweep(pool);
    assert.equal((await reload(t.id)).state, 'submitted');
  });
});
