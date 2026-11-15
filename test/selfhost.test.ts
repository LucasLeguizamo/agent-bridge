// Self-host mode: the Node entry and its dispatch loop, db/setup.ts, and the two doctors.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { doctor, failed } from '../db/doctor.ts';
import { agentAdapters, setup } from '../db/setup.ts';
import { dispatchInterval, startDispatcher } from '../src/standalone.ts';
import { openTestSchema, testDatabaseUrl } from './pg.ts';

const ROOT = new URL('..', import.meta.url);
const PKG_VERSION = (JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { version: string }).version;
const KEYS = { grok: 'g'.repeat(32), claude: 'c'.repeat(32) };
type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], env: Record<string, string>, { until }: { until?: RegExp } = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let seen: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { seen = resolve; });
  child.stdout.on('data', (c) => { stdout += c; if (until?.test(stdout)) seen!(); });
  child.stderr.on('data', (c) => { stderr += c; });
  const done = new Promise<Run>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, ready, done };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('adapter inference', () => {
  test('grok -> grok, instinct -> email, anything else -> http', () => {
    assert.deepEqual(agentAdapters(['grok', 'instinct', 'claude', 'ops']), { grok: 'grok', instinct: 'email', claude: 'http', ops: 'http' });
  });

  test('BRIDGE_AGENT_ADAPTERS wins over the inference, per id', () => {
    assert.deepEqual(agentAdapters(['grok', 'mailer'], '{"mailer":"email","grok":"http"}'), { grok: 'http', mailer: 'email' });
  });

  test('a bad BRIDGE_AGENT_ADAPTERS is refused, naming the variable only', () => {
    for (const raw of ['not json', '[]', 'null', '{"grok":"webhook"}', '{"stranger":"http"}']) {
      assert.throws(() => agentAdapters(['grok'], raw), /BRIDGE_AGENT_ADAPTERS/, raw);
    }
  });
});

describe('the dispatch loop', () => {
  test('a tick while a pass runs is skipped, and the next one after it runs', async () => {
    let calls = 0;
    let gate = deferred();
    const loop = startDispatcher(() => { calls++; return gate.promise; }, 1e9);
    try {
      assert.equal(loop.tick(), true);
      assert.equal(loop.tick(), false, 'overlapping tick');
      assert.equal(loop.tick(), false);
      assert.equal(calls, 1);
      gate.resolve();
      await new Promise((r) => setImmediate(r));
      gate = deferred();
      assert.equal(loop.tick(), true);
      assert.equal(calls, 2);
    } finally {
      gate.resolve(); // Also when an assertion failed, or stop() would wait on it forever.
      await loop.stop();
    }
  });

  test('on a real timer faster than the pass, passes never overlap', async () => {
    let active = 0;
    let most = 0;
    let calls = 0;
    const loop = startDispatcher(async () => {
      calls++;
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
    }, 5);
    await new Promise((r) => setTimeout(r, 300));
    await loop.stop();
    assert.equal(most, 1);
    assert.ok(calls >= 3 && calls <= 8, `calls ${calls}`);
    assert.equal(active, 0, 'stop waits for the pass in progress');
  });

  test('a failed pass is reported and the loop keeps going', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const loop = startDispatcher(async () => { calls++; throw new Error('db down'); }, 1e9, (e) => errors.push(e));
    loop.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(loop.tick(), true, 'not stuck after a failure');
    await loop.stop();
    assert.equal(calls, 2);
    assert.equal(errors.length, 2);
  });

  test('DISPATCH_INTERVAL_MS: unset means off, and a bad value is refused', () => {
    assert.equal(dispatchInterval(undefined), undefined);
    assert.equal(dispatchInterval(''), undefined);
    assert.equal(dispatchInterval('60000'), 60_000);
    for (const bad of ['0', '-5', '999', '1.5', 'often']) assert.throws(() => dispatchInterval(bad), /DISPATCH_INTERVAL_MS/, bad);
  });
});

describe('entry files', () => {
  test('the Node entry is not one of the paths Vercel tries, so src/index.ts stays its entry', () => {
    // From vercel.com/docs/frameworks/backend/hono: app, index, server, in the root and in src/.
    for (const name of ['server', 'app']) {
      for (const ext of ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts']) assert.equal(existsSync(new URL(`src/${name}.${ext}`, ROOT)), false, `src/${name}.${ext}`);
    }
    assert.ok(existsSync(new URL('src/standalone.ts', ROOT)));
    assert.doesNotMatch(readFileSync(new URL('src/standalone.ts', ROOT), 'utf8'), /from 'hono'/);
  });

  test('the image runs the Node entry as a non-root user, with a health check, and copies no secrets', () => {
    const dockerfile = readFileSync(new URL('Dockerfile', ROOT), 'utf8');
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^HEALTHCHECK .*\n.*\/health/m);
    assert.match(dockerfile, /CMD \["node", "src\/standalone\.ts"\]/);
    assert.match(dockerfile, /pnpm install --frozen-lockfile --prod/);
    assert.match(dockerfile, /^COPY package\.json \.\/$/m, 'src/version.ts reads the version from it');
    assert.match(readFileSync(new URL('.dockerignore', ROOT), 'utf8'), /^\.env\*$/m);
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { dependencies: Record<string, string> };
    assert.ok(pkg.dependencies['@hono/node-server'], 'a --prod install needs it');
  });
});

describe('bridge:doctor without a database', () => {
  test('a missing variable is a failed check with a fix, and the exit code says so', async () => {
    const r = await run(['db/doctor.ts'], {}).done;
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout.split('\n')[0], `agent-bridge ${PKG_VERSION}`, 'the first line names the version');
    assert.match(r.stdout, /^✗ DATABASE_URL: not set\n {4}fix: /m);
    assert.match(r.stdout, /^✗ BRIDGE_AGENT_KEYS: not set/m);
    assert.match(r.stdout, /^! dispatcher trigger: neither DISPATCH_INTERVAL_MS nor CRON_SECRET is set/m);
    assert.match(r.stdout, /^- database: needs a valid DATABASE_URL/m);
  });

  test('a malformed value is named, never printed', async () => {
    const checks = await doctor({
      DATABASE_URL: 'postgresql://u:SECRETPW@h.supabase.com:6543/postgres', BRIDGE_AGENT_KEYS: '{"grok":"SECRETKEY"}', CRON_SECRET: 'x'.repeat(40),
    });
    const text = JSON.stringify(checks);
    assert.ok(!text.includes('SECRETPW') && !text.includes('SECRETKEY'));
    assert.equal(checks.find((c) => c.name === 'DATABASE_URL')!.status, 'fail');
    assert.equal(checks.find((c) => c.name === 'BRIDGE_AGENT_KEYS')!.status, 'fail');
    assert.equal(checks.find((c) => c.name === 'dispatcher trigger')!.status, 'ok');
    assert.ok(failed(checks));
  });

  test('on Supabase: PGRST106 passes, anything else fails, and the key goes only in the apikey header', async () => {
    const env = { BRIDGE_AGENT_KEYS: JSON.stringify(KEYS), DISPATCH_INTERVAL_MS: '60000', SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' };
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const answer = (status: number, body: unknown) => (async (url: URL | RequestInfo, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const hidden = await doctor(env, { fetch: answer(406, { code: 'PGRST106', message: 'Invalid schema: bridge' }) });
    assert.equal(hidden.find((c) => c.name === 'Data API exposure')!.status, 'ok');
    assert.equal(seen[0]!.url, 'https://ref.supabase.co/rest/v1/agent');
    assert.equal(seen[0]!.headers['accept-profile'], 'bridge');
    const exposed = await doctor(env, { fetch: answer(200, []) });
    assert.equal(exposed.find((c) => c.name === 'Data API exposure')!.status, 'fail');
    assert.ok(!JSON.stringify(exposed).includes('sb_publishable_fake'));
  });
});

describe('with a database', () => {
  let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
  let pool: pg.Pool;
  // The role timeouts that bridge:setup sets on bridge_app, given here per connection: tests connect as an admin.
  let appUrl: string;

  before(async () => {
    db = await openTestSchema();
    pool = new pg.Pool({ connectionString: db.url, max: 2 });
    const u = new URL(db.url);
    u.searchParams.set('options', `${u.searchParams.get('options')} -c statement_timeout=10s -c idle_in_transaction_session_timeout=15s`);
    appUrl = u.href;
    await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'grok'), ('claude', 'http')`);
  });
  after(async () => {
    await pool?.end();
    await db?.stop();
  });

  test('bridge:doctor passes on a healthy bridge, then names an overdue queue and fails', async () => {
    const env = { DATABASE_URL: appUrl, BRIDGE_AGENT_KEYS: JSON.stringify(KEYS), DISPATCH_INTERVAL_MS: '60000' };
    const healthy = await doctor(env);
    // Supabase's session pooler forwards only search_path from `options`, so there the timeouts read as unset.
    const pooled = /\.supabase\.(co|com)$/.test(new URL(appUrl).hostname);
    assert.deepEqual(healthy.filter((c) => c.status === 'fail' && !(pooled && c.name === 'role settings')), []);
    assert.match(healthy.find((c) => c.name === 'agents registered')!.detail, /2 of 2/);
    assert.match(healthy.find((c) => c.name === 'agent grok')!.detail, /adapter grok is not loaded/);
    assert.equal(healthy.find((c) => c.name === 'migrations')!.status, 'skip');

    // Due ten minutes ago, for a loaded adapter: a running dispatcher would have sent it.
    await pool.query(
      `INSERT INTO task (root_id, from_agent, to_agent, intent, input, risk, state, idempotency_key, next_attempt_at, deadline_at)
       VALUES (gen_random_uuid(), 'grok', 'claude', 'research', '{}', 'read', 'submitted', $1, now() - interval '10 minutes', now() + interval '1 day')`,
      [`doctor-${randomBytes(4).toString('hex')}`]);
    const stuck = await doctor(env);
    const alive = stuck.find((c) => c.name === 'dispatcher alive')!;
    assert.equal(alive.status, 'fail');
    assert.match(alive.detail, /^1 send\(s\) and 0 deadline\(s\) overdue/);
    assert.ok(failed(stuck));
    await pool.query(`DELETE FROM event; DELETE FROM task`);
  });

  test('bridge:doctor fails an unregistered agent and missing role timeouts', async () => {
    const extra = await doctor({ DATABASE_URL: appUrl, BRIDGE_AGENT_KEYS: JSON.stringify({ ...KEYS, ops: 'o'.repeat(32) }), DISPATCH_INTERVAL_MS: '60000' });
    assert.match(extra.find((c) => c.name === 'agents registered')!.detail, /no row for ops/);
    const bare = await doctor({ DATABASE_URL: db!.url, BRIDGE_AGENT_KEYS: JSON.stringify(KEYS), DISPATCH_INTERVAL_MS: '60000' });
    assert.equal(bare.find((c) => c.name === 'role settings')!.status, 'fail');
    assert.equal(bare.find((c) => c.name === 'agents registered')!.status, 'ok', 'the other checks still run');
  });

  test('the Node entry serves /health, dispatches on its own timer, and stops cleanly on SIGTERM', async () => {
    const probe: Server = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const { rows: [task] } = await pool.query<{ id: string }>(
      `INSERT INTO task (root_id, from_agent, to_agent, intent, input, risk, state, idempotency_key, deadline_at)
       VALUES (gen_random_uuid(), 'grok', 'claude', 'research', '{}', 'read', 'submitted', $1, now() + interval '1 day') RETURNING id`,
      [`loop-${randomBytes(4).toString('hex')}`]);
    const server = run(['src/standalone.ts'], {
      DATABASE_URL: appUrl, BRIDGE_AGENT_KEYS: JSON.stringify(KEYS), DISPATCH_INTERVAL_MS: '1000', PORT: String(port), HOST: '127.0.0.1',
    }, { until: /"msg":"listening"/ });
    try {
      await Promise.race([server.ready, server.done.then((r) => { throw new Error(`exited early: ${r.stderr}`); })]);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok', version: PKG_VERSION });

      // No POST /cron/dispatch anywhere: only the timer can have sent it. http is pull-only, so delivered means working.
      let state = 'submitted';
      for (let i = 0; i < 40 && state === 'submitted'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        state = (await pool.query<{ state: string }>('SELECT state FROM task WHERE id = $1', [task!.id])).rows[0]!.state;
      }
      assert.equal(state, 'working');
    } finally {
      server.child.kill('SIGTERM');
    }
    const r = await server.done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"msg":"shutting down","signal":"SIGTERM"/);
    assert.ok(!(r.stdout + r.stderr).includes(KEYS.grok));
  });

  test('the Node entry refuses to start on a bad setting, naming it without its value', async () => {
    const r = await run(['src/standalone.ts'], { DATABASE_URL: 'postgresql://u:SECRETPW@127.0.0.1:1/x', BRIDGE_AGENT_KEYS: '{}' }).done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot start: DATABASE_URL must set sslmode/);
    assert.ok(!r.stderr.includes('SECRETPW'));
  });
});

// It creates the cluster-wide role bridge_app and sets its timeouts, so it runs only on a local, throwaway Postgres,
// in a database of its own. Never on Supabase, where bridge_app is the live app role.
describe('bridge:setup', () => {
  const raw = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : undefined;
  const local = raw && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname);
  const name = `bridge_setup_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let client: pg.Client;
  let roleExisted = false;

  before(async () => {
    if (!local) return;
    admin = new pg.Client({ connectionString: raw });
    await admin.connect();
    roleExisted = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'bridge_app'`)).rowCount === 1;
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(raw);
    u.pathname = `/${name}`;
    client = new pg.Client({ connectionString: u.href });
    await client.connect();
  });
  after(async () => {
    if (!local) return;
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    if (!roleExisted) await admin.query('DROP ROLE IF EXISTS bridge_app');
    else await admin.query('ALTER ROLE bridge_app RESET ALL');
    await admin.end();
  });

  test('runs on plain Postgres, and a second run changes nothing', { skip: local ? false : 'needs TEST_DATABASE_URL on localhost' }, async () => {
    const env = { BRIDGE_AGENT_KEYS: JSON.stringify({ ...KEYS, instinct: 'i'.repeat(32) }), BRIDGE_DB_PASSWORD: randomBytes(16).toString('hex') };
    const first = await setup(client, env);
    const byStep = (steps: typeof first) => Object.fromEntries(steps.map((s) => [s.step, s.status]));
    assert.deepEqual(byStep(first), {
      'role bridge_app': roleExisted ? 'already done' : 'done', 'schema bridge': 'done', migrations: 'done',
      'role settings': 'done', 'agent claude': 'done', 'agent grok': 'done',
      'agent instinct': 'already done', // 004_email.sql registers it.
    });
    const second = await setup(client, env);
    for (const s of second) assert.equal(s.status, 'already done', `${s.step}: ${s.why}`);

    const { rows: agents } = await client.query('SELECT id, adapter FROM bridge.agent ORDER BY id');
    assert.deepEqual(agents, [{ id: 'claude', adapter: 'http' }, { id: 'grok', adapter: 'grok' }, { id: 'instinct', adapter: 'email' }]);
    const { rows: [settings] } = await client.query<{ config: string[] }>(
      `SELECT setconfig AS config FROM pg_db_role_setting WHERE setrole = 'bridge_app'::regrole AND setdatabase = 0`);
    assert.deepEqual(settings!.config.sort(), ['idle_in_transaction_session_timeout=15s', 'search_path=bridge', 'statement_timeout=10s']);
    // The schema is closed to everyone but bridge_app, which gets only what the app uses.
    const { rows: [grants] } = await client.query(`SELECT
      has_schema_privilege('public', 'bridge', 'USAGE') AS public_usage,
      has_table_privilege('bridge_app', 'bridge.task', 'SELECT') AS app_reads_task,
      has_table_privilege('bridge_app', 'bridge.event', 'UPDATE') AS app_updates_event,
      has_column_privilege('bridge_app', 'bridge.fact', 'trust', 'UPDATE') AS app_sets_trust,
      has_table_privilege('bridge_app', 'bridge.agent', 'SELECT') AS app_reads_agent,
      has_table_privilege('bridge_app', 'bridge.agent', 'INSERT') OR has_table_privilege('bridge_app', 'bridge.agent', 'UPDATE') AS app_writes_agent`);
    assert.deepEqual(grants, {
      public_usage: false, app_reads_task: true, app_updates_event: false, app_sets_trust: false, app_reads_agent: true, app_writes_agent: false,
    });

    // A row someone changed by hand is reported, not overwritten.
    await client.query(`UPDATE bridge.agent SET adapter = 'http', enabled = false WHERE id = 'grok'`);
    const third = await setup(client, env);
    const grok = third.find((s) => s.step === 'agent grok')!;
    assert.equal(grok.status, 'already done');
    assert.match(grok.why, /adapter http, not grok: left unchanged.*disabled by the kill switch/);
    const output = JSON.stringify([first, second, third]);
    assert.ok(!output.includes(env.BRIDGE_DB_PASSWORD) && !output.includes(KEYS.grok));
  });

  test('a bad BRIDGE_AGENT_KEYS changes nothing', { skip: local ? false : 'needs TEST_DATABASE_URL on localhost' }, async () => {
    await assert.rejects(setup(client, { BRIDGE_AGENT_KEYS: '{"grok":"short"}' }), /BRIDGE_AGENT_KEYS/);
  });
});
