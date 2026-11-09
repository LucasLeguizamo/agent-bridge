// The serverless shape: entry, cron route, immediate dispatch, pool and TLS settings, idle cost, deploy files.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { rootCertificates } from 'node:tls';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createBridge } from '../src/bridge.ts';
import { connectionConfig } from '../src/db.ts';
import { createApp } from '../src/http.ts';
import { runPass, type Adapters } from '../src/queue.ts';
import { createTask, type Task } from '../src/tasks.ts';
import { openTestSchema } from './pg.ts';

const ROOT = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');
const KEYS = { grok: 'g'.repeat(32), instinct: 'i'.repeat(32), claude: 'c'.repeat(32) };
const CRON_SECRET = 'r'.repeat(40);
const WEBHOOK_KEY = 'w'.repeat(40);

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let receiver: Server;
let receiverUrl: string;
let hits: string[] = [];
let seq = 0;

const newTask = (over: Record<string, unknown> = {}) => {
  seq++;
  return { to_agent: 'grok', intent: 'research', input: { query: `q${seq}` }, idempotency_key: `k${seq}`, ...over };
};
const reload = async (id: string) => (await pool.query<Task>('SELECT * FROM task WHERE id = $1', [id])).rows[0]!;
const envFor = (over: Record<string, string> = {}) => ({
  DATABASE_URL: db!.url, BRIDGE_AGENT_KEYS: JSON.stringify(KEYS), CRON_SECRET,
  GROK_WEBHOOK_URL: receiverUrl, GROK_WEBHOOK_KEY: WEBHOOK_KEY, ...over,
});
const cron = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, token?: string, method = 'POST') =>
  app.request('/cron/dispatch', { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
  app.request('/tasks', {
    method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${KEYS.instinct}`, 'content-type': 'application/json' },
  });

before(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { hits.push(Buffer.concat(chunks).toString()); res.end('{}'); });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
});
after(async () => {
  await pool?.end();
  await db?.stop();
  receiver?.closeAllConnections();
  receiver?.close();
});
beforeEach(async () => {
  hits = [];
  await pool.query('TRUNCATE adapter_pause, pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'grok'), ('instinct', 'email'), ('claude', 'email')`);
});

describe('POST /cron/dispatch', () => {
  const passes: number[] = [];
  const pass = async () => { passes.push(1); return 0; };
  beforeEach(() => { passes.length = 0; });

  test('fails closed: with no secret configured no token gets in, and no pass runs', async (t) => {
    t.mock.method(console, 'log', () => {});
    for (const options of [{}, { cronSecret: '', pass }, { pass }, { cronSecret: 'tooshort', pass }]) {
      const app = createApp(pool, KEYS, options);
      for (const token of [undefined, '', 'tooshort', 'undefined', CRON_SECRET]) assert.equal((await cron(app, token)).status, 401);
    }
    assert.equal(passes.length, 0);
  });

  test('refuses a wrong token and runs nothing, and an agent key is not a cron key', async (t) => {
    t.mock.method(console, 'log', () => {});
    const app = createApp(pool, KEYS, { cronSecret: CRON_SECRET, pass });
    for (const token of [undefined, 'x'.repeat(40), `${CRON_SECRET}x`, KEYS.grok]) assert.equal((await cron(app, token)).status, 401);
    assert.equal(passes.length, 0);
  });

  test('a correct token runs one pass and needs no agent row', async (t) => {
    t.mock.method(console, 'log', () => {});
    await pool.query('DELETE FROM agent');
    const res = await cron(createApp(pool, KEYS, { cronSecret: CRON_SECRET, pass }), CRON_SECRET);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', claimed: 0 });
    assert.equal(passes.length, 1);
  });

  test('GET does not run a pass', async (t) => {
    t.mock.method(console, 'log', () => {});
    const app = createApp(pool, KEYS, { cronSecret: CRON_SECRET, pass });
    assert.notEqual((await cron(app, CRON_SECRET, 'GET')).status, 200);
    assert.equal(passes.length, 0);
  });

  test('a failed pass answers a bare 500, and its log has only code and message', async (t) => {
    t.mock.method(console, 'log', () => {});
    const err = t.mock.method(console, 'error', () => {});
    const boom = async () => { throw Object.assign(new Error('boom'), { code: '57014', detail: 'SECRETDETAIL' }); };
    const res = await cron(createApp(pool, KEYS, { cronSecret: CRON_SECRET, pass: boom }), CRON_SECRET);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'dispatch_failed' });
    assert.doesNotMatch(err.mock.calls.map((c) => JSON.stringify(c.arguments)).join(), /SECRETDETAIL/);
  });

  test('a failed cron token counts as failed auth in the log, without echoing it', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    await cron(createApp(pool, KEYS, { cronSecret: CRON_SECRET, pass }), 'TOKENMARKERxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    const [line] = log.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(JSON.parse(line!).auth_failures, 1);
    assert.doesNotMatch(line!, /TOKENMARKER/);
  });
});

describe('the wired bridge', () => {
  type Deferred = Promise<unknown>[];
  const bridgeOf = (env = envFor()) => {
    const deferred: Deferred = [];
    const bridge = createBridge(env, { defer: (p) => { deferred.push(p); } });
    return { ...bridge, deferred };
  };
  const within = async <T>(b: { pool: pg.Pool }, fn: () => Promise<T>) => {
    try { return await fn(); } finally { await b.pool.end(); }
  };

  test('a cron pass wakes the routine with the real adapter and the real gate, and MCP is mounted', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    await within(b, async () => {
      const { task } = await createTask(pool, 'instinct', newTask());
      const res = await cron(b.app, CRON_SECRET);
      assert.deepEqual(await res.json(), { status: 'ok', claimed: 1 });
      assert.deepEqual(hits.map((h) => JSON.parse(h)), [{ task_id: task.id }]);
      assert.equal((await b.app.request('/mcp', { method: 'POST', body: '{}' })).status, 401);
    });
  });

  test('a pull agent (adapter http) gets its task offered, so it shows in pending and can be claimed', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    await within(b, async () => {
      await pool.query(`UPDATE agent SET adapter = 'http' WHERE id = 'claude'`);
      const { task } = await createTask(pool, 'instinct', newTask({ to_agent: 'claude' }));
      assert.deepEqual(await (await cron(b.app, CRON_SECRET)).json(), { status: 'ok', claimed: 1 });
      const t1 = await reload(task.id);
      assert.equal(t1.state, 'working');
      assert.equal(t1.attempts, 1);
      assert.equal(t1.claimed_at, null);
      const pending = await b.app.request('/tasks/pending', { headers: { authorization: `Bearer ${KEYS.claude}` } });
      assert.equal(((await pending.json()) as { tasks: { id: string }[] }).tasks[0]?.id, task.id);
    });
  });

  test('while the breaker is open a cron pass sends nothing and burns no attempt', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    await within(b, async () => {
      const { task } = await createTask(pool, 'instinct', newTask());
      await pool.query(`INSERT INTO adapter_pause VALUES ('grok', now() + interval '1 hour', 'test')`);
      assert.deepEqual(await (await cron(b.app, CRON_SECRET)).json(), { status: 'ok', claimed: 0 });
      assert.equal(hits.length, 0);
      assert.equal((await reload(task.id)).attempts, 0);
    });
  });

  test('POST /tasks dispatches right away through waitUntil, before any cron tick', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    await within(b, async () => {
      const payload = newTask();
      const res = await post(b.app, payload);
      assert.equal(res.status, 201);
      assert.equal(b.deferred.length, 1);
      await Promise.all(b.deferred);
      const { task } = await res.json() as { task: Task };
      assert.deepEqual(hits.map((h) => JSON.parse(h)), [{ task_id: task.id }]);

      assert.equal((await post(b.app, payload)).status, 200);
      assert.equal(b.deferred.length, 1, 'a replay creates nothing, so it dispatches nothing');
    });
  });

  test('a rejected or parked task does not dispatch', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    await within(b, async () => {
      assert.equal((await (await post(b.app, newTask({ intent: 'pay.invoice', input: { a: 1 } })))).status, 201);
      const dup = newTask({ input: { query: 'same' } });
      await post(b.app, dup);
      await Promise.all(b.deferred);
      const before = b.deferred.length;
      assert.equal((await post(b.app, newTask({ input: { query: 'same' } }))).status, 422);
      assert.equal(b.deferred.length, before);
      assert.equal(before, 1, 'only the deliverable task dispatched');
    });
  });

  test('a failed immediate dispatch does not fail the request: cron picks the task up', async (t) => {
    t.mock.method(console, 'log', () => {});
    const err = t.mock.method(console, 'error', () => {});
    const deferred: Promise<unknown>[] = [];
    const app = createApp(pool, KEYS, { pass: async () => { throw new Error('db down'); }, defer: (p) => { deferred.push(p); } });
    const res = await post(app, newTask());
    assert.equal(res.status, 201);
    await Promise.all(deferred);
    assert.equal(err.mock.callCount(), 1);
  });

  test('task_create over MCP dispatches right away too', async (t) => {
    t.mock.method(console, 'log', () => {});
    const b = bridgeOf();
    const server = serve({ fetch: b.app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${KEYS.instinct}` } },
    }));
    try {
      await client.callTool({ name: 'task_create', arguments: newTask() });
      assert.equal(b.deferred.length, 1);
      await Promise.all(b.deferred);
      assert.equal(hits.length, 1);
    } finally {
      await client.close();
      await new Promise((r) => server.close(r));
      await b.pool.end();
    }
  });

  test('with one Grok variable missing the adapter does not load: tasks wait and it warns, without the URL', async (t) => {
    t.mock.method(console, 'log', () => {});
    const warn = t.mock.method(console, 'warn', () => {});
    const env = envFor();
    delete (env as Partial<typeof env>).GROK_WEBHOOK_KEY;
    const b = bridgeOf(env);
    await within(b, async () => {
      const { task } = await createTask(pool, 'instinct', newTask());
      await cron(b.app, CRON_SECRET);
      assert.equal(hits.length, 0);
      assert.equal((await reload(task.id)).attempts, 0);
      const text = warn.mock.calls.map((c) => String(c.arguments[0])).join();
      assert.match(text, /Grok adapter not loaded/);
      assert.ok(!text.includes(receiverUrl));
    });
  });

  test('the pool is small and short-lived, as serverless needs', () => {
    const b = bridgeOf();
    const o = b.pool.options as pg.PoolConfig;
    assert.equal(o.max, 3);
    assert.ok(o.connectionTimeoutMillis! <= 5000);
    assert.ok(o.idleTimeoutMillis! <= 2000, 'each tick keeps a 2 GB instance billed for this long');
    assert.ok(o.query_timeout! > 0 && o.query_timeout! <= 15_000);
    assert.equal('statement_timeout' in o, false, 'a startup parameter does not survive the transaction pooler');
    return b.pool.end();
  });

  test('bad settings fail without printing secrets', () => {
    const url = 'postgresql://u:SECRETPW@h.supabase.com:6543/postgres';
    const bad: [Record<string, string>, RegExp][] = [
      [{ DATABASE_URL: url, BRIDGE_AGENT_KEYS: '{}' }, /sslmode/],
      [{ DATABASE_URL: 'SECRETPW-not-a-url', BRIDGE_AGENT_KEYS: '{}' }, /DATABASE_URL/],
      [{ DATABASE_URL: `${url}?sslmode=require`, BRIDGE_AGENT_KEYS: '{"grok":"SECRETKEY' }, /BRIDGE_AGENT_KEYS/],
      [{ DATABASE_URL: `${url}?sslmode=require`, BRIDGE_AGENT_KEYS: '{"grok":"SECRETKEY"}' }, /BRIDGE_AGENT_KEYS/],
      [{ DATABASE_URL: `${url}?sslmode=require`, BRIDGE_AGENT_KEYS: '{}', GROK_WEBHOOK_URL: 'http://SECRETHOST.test/h', GROK_WEBHOOK_KEY: WEBHOOK_KEY }, /GROK_WEBHOOK_URL/],
    ];
    for (const [env, name] of bad) {
      assert.throws(() => createBridge(env), (e: Error) => name.test(e.message) && !/SECRET/.test(e.message), JSON.stringify(Object.keys(env)));
    }
  });
});

describe('src/index.ts, the entry Vercel detects', () => {
  // Async: the child calls the webhook receiver in this process, which a blocking spawn would starve.
  const runEntry = async (env: Record<string, string>, script: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { default: app } = await import('./src/index.ts');
      ${script}
    `], { cwd: ROOT, env: { PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const [status] = await once(child, 'close') as [number];
    return { status, stdout, stderr };
  };

  test('sits where Vercel looks, imports hono itself, and default-exports an app', () => {
    const source = read('src/index.ts');
    assert.match(source, /from 'hono'/);
    assert.match(source, /export default app/);
    for (const earlier of ['app', 'index', 'server'].flatMap((n) => ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'].map((x) => `${n}.${x}`)).concat(['src/app.ts'])) {
      assert.equal(existsSync(new URL(earlier, ROOT)), false, `${earlier} would win Vercel's entry detection`);
    }
  });

  test('without settings it imports fine, so a build cannot fail on it, and fails closed at request time', async () => {
    const r = await runEntry({ DATABASE_URL: 'postgresql://u:SECRETPW@h.supabase.com:6543/postgres' }, `
      if (typeof app.fetch !== 'function') process.exit(2);
      const res = await app.request('/tasks');
      console.log(res.status, await res.text());
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^500 \{"error":"misconfigured"\}/);
    assert.ok(!(r.stdout + r.stderr).includes('SECRETPW'));
    assert.match(r.stderr, /sslmode/, 'the log names what to fix');
  });

  test('activation pages stay public even when the bridge is misconfigured, and other paths do not', async () => {
    const r = await runEntry({}, `
      for (const path of ['/', '/activate/grok', '/activate/instinct', '/activate/other']) {
        console.log(path, (await app.request(path)).status);
      }
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['/ 200', '/activate/grok 200', '/activate/instinct 200', '/activate/other 500']);
  });

  test('activation pages open no database connection through the entry', async () => {
    // Port 1 refuses at once, so any query would fail: these answers cannot have needed one.
    const r = await runEntry({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x?sslmode=require', BRIDGE_AGENT_KEYS: JSON.stringify(KEYS) }, `
      for (const path of ['/', '/activate/grok', '/activate/instinct', '/health']) {
        console.log(path, (await app.request(path)).status);
      }
      process.exit(0);
    `);
    assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('/')), ['/ 200', '/activate/grok 200', '/activate/instinct 200', '/health 503'], r.stderr);
  });

  test('with settings: /health answers, MCP works with a valid key, the rest stays behind auth, and the breaker wraps dispatch', async () => {
    const { task } = await createTask(pool, 'instinct', newTask());
    await pool.query(`INSERT INTO adapter_pause VALUES ('grok', now() + interval '1 hour', 'test')`);
    const r = await runEntry(envFor(), `
      const report = {};
      report.health = (await app.request('/health')).status;
      report.closed = (await app.request('/tasks/x')).status;
      report.page = (await app.request('/activate/grok')).status;
      const mcp = await app.request('/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ${KEYS.grok}', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      report.mcp = mcp.status;
      report.tools = (await mcp.text()).includes('task_claim');
      const cron = () => app.request('/cron/dispatch', { method: 'POST', headers: { authorization: 'Bearer ${CRON_SECRET}' } });
      report.paused = await (await cron()).json();
      process.stdout.write('PAUSE_CHECK ' + JSON.stringify(report) + '\\n');
      process.exit(0);
    `);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('PAUSE_CHECK'))!.slice('PAUSE_CHECK '.length));
    assert.deepEqual(report, { health: 200, closed: 401, page: 200, mcp: 200, tools: true, paused: { status: 'ok', claimed: 0 } });
    assert.equal(hits.length, 0, 'the pause held');
    assert.equal((await reload(task.id)).attempts, 0);

    // Same entry, breaker closed: the send really goes out, so the zero above came from the gate.
    await pool.query(`UPDATE adapter_pause SET paused_until = now()`);
    const open = await runEntry(envFor(), `
      const res = await app.request('/cron/dispatch', { method: 'POST', headers: { authorization: 'Bearer ${CRON_SECRET}' } });
      process.stdout.write('RESUMED ' + JSON.stringify(await res.json()) + '\\n');
      process.exit(0);
    `);
    assert.match(open.stdout, /RESUMED \{"status":"ok","claimed":1\}/, open.stderr);
    assert.deepEqual(hits.map((h) => JSON.parse(h)), [{ task_id: task.id }]);
  });
});

describe('idle cost', () => {
  const counted = () => {
    let queries = 0;
    let connects = 0;
    const wrapped = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'query') return (...a: unknown[]) => { queries++; return (target.query as (...x: unknown[]) => unknown)(...a); };
        if (prop === 'connect') return (...a: unknown[]) => { connects++; return (target.connect as (...x: unknown[]) => unknown)(...a); };
        return Reflect.get(target, prop);
      },
    });
    return { wrapped, count: () => ({ queries, connects }) };
  };
  const gateThatMustNotRun = async (): Promise<Adapters> => { throw new Error('the gate ran on an idle pass'); };

  test('a pass with no work runs exactly one read and never the breaker', async (t) => {
    const { wrapped, count } = counted();
    assert.equal(await runPass(wrapped, gateThatMustNotRun), 0);
    assert.deepEqual(count(), { queries: 1, connects: 0 });
    t.diagnostic(`idle pass, empty queue: ${JSON.stringify(count())}`);
  });

  test('open work that is not due yet still costs one read', async (t) => {
    const { task } = await createTask(pool, 'instinct', newTask());
    await pool.query(`UPDATE task SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [task.id]);
    const parked = await createTask(pool, 'instinct', newTask({ intent: 'pay.invoice', input: { a: 1 } }));
    assert.equal(parked.task.state, 'input_required');
    const { wrapped, count } = counted();
    assert.equal(await runPass(wrapped, gateThatMustNotRun), 0);
    assert.deepEqual(count(), { queries: 1, connects: 0 });
    t.diagnostic(`idle pass, work not due: ${JSON.stringify(count())}`);
  });

  test('through the cron route an idle pass also costs one read', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { wrapped, count } = counted();
    const app = createApp(wrapped, KEYS, { cronSecret: CRON_SECRET, pass: () => runPass(wrapped, gateThatMustNotRun) });
    assert.equal((await cron(app, CRON_SECRET)).status, 200);
    assert.deepEqual(count(), { queries: 1, connects: 0 });
  });

  const delivered: string[] = [];
  const fake: Adapters = { email: { async deliver(task) { delivered.push(task.id); } } };

  test('due work is noticed: a queued task, a passed deadline, and a re-send coming due', async () => {
    const due = await createTask(pool, 'grok', newTask({ to_agent: 'instinct' }));
    assert.equal(await runPass(pool, fake), 1);
    assert.deepEqual(delivered, [due.task.id]);

    const overdue = await createTask(pool, 'instinct', newTask({ intent: 'pay.invoice', input: { a: 2 } }));
    await pool.query(`UPDATE task SET deadline_at = now() - interval '1 second' WHERE id = $1`, [overdue.task.id]);
    await runPass(pool, fake);
    assert.equal((await reload(overdue.task.id)).state, 'failed');

    const exhausted = await createTask(pool, 'instinct', newTask());
    await pool.query(`UPDATE task SET attempts = 5, next_attempt_at = now() WHERE id = $1`, [exhausted.task.id]);
    await runPass(pool, fake);
    assert.equal((await reload(exhausted.task.id)).state, 'failed');
  });
});

describe('M6: TLS settings', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n';
  const url = (q: string) => `postgresql://u:SECRETPW@h.supabase.com:6543/postgres${q}`;
  const noLeak = (e: Error) => !e.message.includes('SECRETPW');

  test('without a CA: require is accepted, weaker modes are not', () => {
    for (const q of ['', '?sslmode=disable', '?sslmode=prefer', '?sslmode=allow', '?sslmode=']) {
      assert.throws(() => connectionConfig(url(q), 'DATABASE_URL'), (e: Error) => /DATABASE_URL.*sslmode/.test(e.message) && noLeak(e), q);
    }
    const c = connectionConfig(url('?sslmode=require&uselibpqcompat=true'), 'DATABASE_URL');
    assert.deepEqual(c.ssl, { rejectUnauthorized: false });
    // These two would override `ssl`, because pg lets the connection string win.
    assert.doesNotMatch(c.connectionString, /sslmode|uselibpqcompat/);
  });

  test('once a CA is available, only verify-full and verify-ca are accepted', () => {
    for (const q of ['?sslmode=require', '', '?sslmode=disable']) {
      assert.throws(() => connectionConfig(url(q), 'DATABASE_URL', CA), (e: Error) => /verify-full/.test(e.message) && noLeak(e), q);
    }
    const full = connectionConfig(url('?sslmode=verify-full'), 'DATABASE_URL', CA);
    assert.equal(full.ssl.rejectUnauthorized, true);
    assert.equal(full.ssl.ca, CA);
    assert.equal(full.ssl.checkServerIdentity, undefined, 'verify-full keeps the hostname check');
    assert.doesNotMatch(full.connectionString, /sslmode/);

    const ca = connectionConfig(url('?sslmode=verify-ca'), 'DATABASE_URL', CA);
    assert.equal(ca.ssl.rejectUnauthorized, true);
    assert.equal(ca.ssl.checkServerIdentity?.('h', {} as never), undefined);
  });

  test('verify modes without a CA, or with a value that is not a certificate, are refused rather than silently unverified', () => {
    assert.throws(() => connectionConfig(url('?sslmode=verify-full'), 'DATABASE_URL'), /DATABASE_CA_PEM/);
    assert.throws(() => connectionConfig(url('?sslmode=verify-full'), 'DATABASE_URL', 'nonsense'), /DATABASE_CA_PEM/);
  });

  test('verify-full really verifies: the real server is refused under a CA that did not sign it', async () => {
    const raw = process.env.TEST_DATABASE_URL!;
    const u = new URL(raw);
    u.searchParams.set('sslmode', 'verify-full');
    const client = new pg.Client(connectionConfig(u.href, 'TEST_DATABASE_URL', rootCertificates[0]));
    await assert.rejects(client.connect(), (e: NodeJS.ErrnoException) =>
      /certificate|self.signed|issuer/i.test(`${e.code} ${e.message}`));
    await client.end().catch(() => {});
  });

  test('the app builds its pool through this check', () => {
    assert.throws(() => createBridge({ DATABASE_URL: url('?sslmode=require'), BRIDGE_AGENT_KEYS: '{}', DATABASE_CA_PEM: CA }), /verify-full/);
  });

  for (const script of ['db/migrate.ts', 'db/apply.ts']) {
    test(`${script} refuses a connection without TLS, without printing it`, () => {
      const r = spawnSync(process.execPath, [script], {
        cwd: ROOT, encoding: 'utf8',
        env: { PATH: process.env.PATH!, ADMIN_DATABASE_URL: url(''), BRIDGE_DB_PASSWORD: 'a'.repeat(32) },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /ADMIN_DATABASE_URL.*sslmode/);
      assert.ok(!r.stderr.includes('SECRETPW'));
    });
  }
});

describe('deploy files', () => {
  test('the container files are gone, and no long-running process remains', () => {
    for (const f of ['Dockerfile', '.dockerignore', 'fly.toml', 'src/main.ts']) assert.equal(existsSync(new URL(f, ROOT)), false, f);
    assert.doesNotMatch(read('src/queue.ts'), /setInterval|setTimeout\(loop|startDispatcher/);
    assert.doesNotMatch(read('package.json'), /src\/main\.ts/);
  });

  test('vercel.json keeps functions next to Supabase in us-west-2, in a single region as Hobby requires', () => {
    const v = JSON.parse(read('vercel.json')) as { regions: string[] };
    assert.deepEqual(v.regions, ['pdx1']);
  });

  test('Node is pinned to 24, since the Vercel default moved past it', () => {
    assert.equal((JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node, '24.x');
  });

  test('the pg_cron step stays out of migrations, holds no secret, and is written to be re-run', () => {
    assert.equal(readdirSync(new URL('db/', ROOT)).filter((f) => /^0.*\.sql$/.test(f)).includes('cron_dispatch.sql'), false);
    const sql = read('db/cron_dispatch.sql');
    assert.match(sql, /vault\.decrypted_secrets/);
    assert.match(sql, /cron\.schedule\(\s*'bridge-dispatch'/, 'a named job: scheduling again replaces it');
    assert.match(sql, /\/cron\/dispatch/);
    assert.match(sql, /timeout_milliseconds/, 'the pg_net default of 2 s is shorter than a pass');
    assert.doesNotMatch(sql, /Bearer [A-Za-z0-9]{8,}/);
  });

  test('the runbook covers the Vercel steps the owner has to run', () => {
    const runbook = read('docs/runbook.md');
    for (const must of ['CRON_SECRET', 'Exposed schemas', 'PGRST106', 'db/cron_dispatch.sql', '/health', 'Kill switch', 'Hobby', 'statement_timeout']) {
      assert.ok(runbook.includes(must), must);
    }
    assert.doesNotMatch(runbook, /\bfly (deploy|secrets|machine|status)/);
  });

  test('.env.example names every variable the code reads', () => {
    const example = read('.env.example');
    for (const name of ['DATABASE_URL', 'DATABASE_CA_PEM', 'BRIDGE_AGENT_KEYS', 'CRON_SECRET', 'GROK_WEBHOOK_URL', 'GROK_WEBHOOK_KEY', 'ADMIN_DATABASE_URL']) {
      assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), name);
    }
  });
});
