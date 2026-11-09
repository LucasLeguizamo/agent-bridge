import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, statSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serve, type ServerType } from '@hono/node-server';
import pg from 'pg';
import { createApp } from '../src/http.ts';
import { mountMcp } from '../src/mcp.ts';
import { runOnce, type Adapters } from '../src/queue.ts';
import { CLI_INSTRUCTIONS, ROUTINE_INSTRUCTIONS } from '../src/instructions.ts';
import { createTask, type Task } from '../src/tasks.ts';
import { openTestSchema } from './pg.ts';

// The real CLI, over real HTTP, against the real routes on a temporary Supabase schema.
const CLI = new URL('../cli/bridge.mjs', import.meta.url).pathname;
const KEYS = { instinct: 'i'.repeat(32), grok: 'g'.repeat(32), claude: 'c'.repeat(32) };
type Agent = keyof typeof KEYS;
const NOT_CLAIMED = { claimed: false, instruction: 'Nothing to do. End this run now without taking any action.' };
const NO_SUCH_TASK = '00000000-0000-4000-8000-000000000000';

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let server: ServerType;
let url: string;
let mcp: Client;
let seq = 0;
const adapters: Adapters = { email: { deliver: async () => {} } };

type Run = { code: number | null; stdout: string; stderr: string; json: any };
const NO_CONFIG = join(tmpdir(), 'agent-bridge-no-config');
function cli(agent: Agent | 'nobody', ...args: string[]) {
  return run(CLI, { BRIDGE_URL: url, BRIDGE_TOKEN: agent === 'nobody' ? 'n'.repeat(32) : KEYS[agent] }, args);
}
function run(file: string, env: Record<string, string>, args: string[]) {
  const child = spawn(process.execPath, [file, ...args], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: NO_CONFIG, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise<Run>((resolve) => {
    child.on('close', (code) => {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
      resolve({ code, stdout, stderr, json: parsed });
    });
  });
}
const ok = async (agent: Agent, ...args: string[]) => {
  const r = await cli(agent, ...args);
  assert.equal(r.code, 0, r.stderr);
  return r.json;
};
const mcpClaim = async (id: string) => {
  const r = await mcp.callTool({ name: 'task_claim', arguments: { task_id: id } }) as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
};
const newTask = async (from = 'grok', to = 'instinct', over: Record<string, unknown> = {}) => {
  seq++;
  const { task } = await createTask(pool, from, { to_agent: to, intent: 'research', input: { query: `q${seq}` }, idempotency_key: `k${seq}`, ...over });
  return task;
};
/** A task the bridge has really offered, through the real queue. Delivery moves it to `working`. */
const offered = async (from = 'grok', to = 'instinct', over: Record<string, unknown> = {}) => {
  const t = await newTask(from, to, over);
  await runOnce(pool, adapters);
  return t;
};
const ids = (r: { tasks: { id: string }[] }) => r.tasks.map((t) => t.id);
const reload = async (id: string) => (await pool.query<Task>('SELECT * FROM task WHERE id = $1', [id])).rows[0]!;
const eventsOf = async (id: string, type: string) =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM event WHERE task_id = $1 AND type = $2', [id, type])).rows[0]!.n;

before(async () => {
  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
  const app = createApp(pool, KEYS);
  mountMcp(app, pool);
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${KEYS.instinct}` } },
  }));
});
after(async () => {
  await mcp?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
  await pool?.end();
  await db?.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE adapter_pause, pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'email'), ('instinct', 'email'), ('claude', 'email')`);
});

describe('GET /whoami', () => {
  test('names the agent of the key, and needs a valid key', async () => {
    assert.deepEqual(await ok('instinct', 'whoami'), { agent: 'instinct' });
    assert.deepEqual(await ok('grok', 'whoami'), { agent: 'grok' });
    assert.equal((await cli('nobody', 'whoami')).code, 3);
  });
  test('a disabled agent is stopped by the kill switch', async () => {
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'instinct'`);
    const r = await cli('instinct', 'whoami');
    assert.equal(r.code, 4);
    assert.equal(r.json.error.code, 'agent_disabled');
  });
});

describe('GET /instructions', () => {
  test('gives each agent the text for its adapter, filled with this bridge and the other enabled agents', async () => {
    await pool.query(`UPDATE agent SET adapter = 'grok' WHERE id = 'grok'`);
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'claude'`);
    const routine = await ok('grok', 'instructions');
    assert.equal(routine.agent, 'grok');
    assert.match(routine.version, /^[0-9a-f]{12}$/);
    assert.equal(routine.text, ROUTINE_INSTRUCTIONS.replaceAll('{BRIDGE}', url).replaceAll('{AGENTS}', 'instinct'));
    const pull = await ok('instinct', 'instructions');
    assert.equal(pull.text, CLI_INSTRUCTIONS.replaceAll('{BRIDGE}', url).replaceAll('{AGENTS}', 'grok'));
    assert.notEqual(pull.version, routine.version);
  });
  test('needs a key, and a disabled agent gets none', async () => {
    assert.equal((await cli('nobody', 'instructions')).code, 3);
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'instinct'`);
    assert.equal((await cli('instinct', 'instructions')).code, 4);
  });
});

describe('CLI config files and self-update', () => {
  test('reads the URL and a mode 600 token from the config directory, and refuses a token others can read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-config-'));
    mkdirSync(join(home, 'bridge'));
    writeFileSync(join(home, 'bridge', 'url'), `${url}\n`);
    writeFileSync(join(home, 'bridge', 'token'), `${KEYS.instinct}\n`, { mode: 0o600 });
    const env = { XDG_CONFIG_HOME: home };
    const good = await run(CLI, env, ['whoami']);
    assert.equal(good.code, 0, good.stderr);
    assert.deepEqual(good.json, { agent: 'instinct' });
    chmodSync(join(home, 'bridge', 'token'), 0o644);
    const open = await run(CLI, env, ['whoami']);
    assert.equal(open.code, 3);
    assert.equal(open.json.error.code, 'config_file_open');
    chmodSync(join(home, 'bridge', 'token'), 0o600);
    chmodSync(join(home, 'bridge', 'url'), 0o666);
    assert.equal((await run(CLI, env, ['whoami'])).json.error.code, 'config_file_open', 'a url others can write could send the token anywhere');
  });
  test('update swaps in the CLI this bridge serves, with no token, and prints its hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-update-'));
    const copy = join(dir, 'bridge.mjs');
    copyFileSync(CLI, copy);
    writeFileSync(copy, readFileSync(copy, 'utf8').replace(/^const VERSION = '[0-9.]+';$/m, "const VERSION = '0.0.1';"));
    const before = readFileSync(copy, 'utf8');
    const bare = await run(copy, { BRIDGE_URL: url }, ['update']);
    assert.equal(bare.code, 2, 'a compromised bridge must not be able to swap the client: the hash is required');
    assert.equal(readFileSync(copy, 'utf8'), before);
    const r = await run(copy, { BRIDGE_URL: url }, ['update', '--sha256', createHash('sha256').update(readFileSync(CLI)).digest('hex')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.updated, true);
    assert.equal(r.json.from, '0.0.1');
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(CLI, 'utf8'));
    assert.equal(r.json.sha256, createHash('sha256').update(readFileSync(CLI)).digest('hex'), 'the hash to compare is the real one');
    assert.equal(statSync(copy).mode, statSync(CLI).mode, 'keeps the file mode, so it stays executable');
  });
  test('update --sha256 installs nothing when the hash differs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-update-'));
    const copy = join(dir, 'bridge.mjs');
    writeFileSync(copy, readFileSync(CLI, 'utf8').replace(/^const VERSION = '[0-9.]+';$/m, "const VERSION = '0.0.1';"));
    const before = readFileSync(copy, 'utf8');
    const r = await run(copy, { BRIDGE_URL: url }, ['update', '--sha256', '0'.repeat(64)]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'hash_mismatch');
    assert.equal(readFileSync(copy, 'utf8'), before);
    const good = createHash('sha256').update(readFileSync(CLI)).digest('hex');
    assert.equal((await run(copy, { BRIDGE_URL: url }, ['update', '--sha256', good])).json.updated, true);
  });
  test('update installs nothing from a non-CLI body, an HTTP error or a redirect, even when the hash matches', async () => {
    const bodies: Record<string, [number, Record<string, string>, string]> = {
      '/html/cli/bridge.mjs': [200, {}, '<html>hello</html>'],
      '/error/cli/bridge.mjs': [500, {}, readFileSync(CLI, 'utf8')],
      '/redirect/cli/bridge.mjs': [302, { location: `${url}/cli/bridge.mjs` }, readFileSync(CLI, 'utf8')],
    };
    const fake = serve({ port: 0, fetch: (req) => {
      const [status, headers, body] = bodies[new URL(req.url).pathname] ?? [404, {}, ''];
      return new Response(body, { status, headers });
    } });
    await once(fake, 'listening');
    const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    try {
      for (const [path, [, , body]] of Object.entries(bodies)) {
        const dir = mkdtempSync(join(tmpdir(), 'bridge-update-'));
        const copy = join(dir, 'bridge.mjs');
        copyFileSync(CLI, copy);
        const before = readFileSync(copy, 'utf8');
        const hash = createHash('sha256').update(body).digest('hex');
        const r = await run(copy, { BRIDGE_URL: base + path.replace('/cli/bridge.mjs', '') }, ['update', '--sha256', hash]);
        assert.notEqual(r.code, 0, path);
        assert.equal(readFileSync(copy, 'utf8'), before, path);
      }
    } finally {
      fake.close();
    }
  });
});

describe('GET /tasks/pending', () => {
  test('lists what was offered to this agent and is not claimed, with no input', async () => {
    const t = await offered();
    const r = await ok('instinct', 'tasks', 'pending');
    assert.deepEqual(ids(r), [t.id]);
    assert.equal(typeof r.data_label, 'string');
    assert.equal(r.next_cursor, null);
    assert.equal(r.tasks[0].from_agent, 'grok');
    assert.equal(r.tasks[0].intent, 'research');
    assert.ok(!('input' in r.tasks[0]));
    assert.ok(!('idempotency_key' in r.tasks[0]));
  });

  test('not a task never offered, one for another agent, or one already claimed', async () => {
    const queued = await newTask(); // No delivery pass: attempts = 0.
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), []);
    await runOnce(pool, adapters);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [queued.id]);
    assert.deepEqual(ids(await ok('grok', 'tasks', 'pending')), []); // The sender, not the receiver.
    assert.deepEqual(ids(await ok('claude', 'tasks', 'pending')), []);
    await ok('instinct', 'tasks', 'claim', queued.id);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), []);
  });

  test('never a parked side_effect, even with a delivery on record', async () => {
    const parked = await newTask('grok', 'instinct', { intent: 'pay.invoice', input: { amount: 10 } });
    assert.equal(parked.state, 'input_required');
    assert.equal(parked.risk, 'side_effect');
    await runOnce(pool, adapters);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), []);

    // Past the state check too: the approval is what lets it through.
    await pool.query(`UPDATE task SET attempts = 1 WHERE id = $1`, [parked.id]);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'parked with attempts');
    await pool.query(`UPDATE task SET state = 'submitted' WHERE id = $1`, [parked.id]);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'submitted with no approval');
    await pool.query(`INSERT INTO approval (task_id, decision, expires_at) VALUES ($1, 'approved', now() - interval '1 minute')`, [parked.id]);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'expired approval');
    await pool.query(`UPDATE approval SET expires_at = now() + interval '1 hour' WHERE task_id = $1`, [parked.id]);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [parked.id], 'approved');
  });

  test('not while the pair is paused, the sender is disabled, or past the deadline: the list matches the claim', async () => {
    const t = await offered();
    await pool.query(`INSERT INTO pair_pause (agent_a, agent_b, paused_until, reason) VALUES ('grok', 'instinct', now() + interval '1 hour', 'test')`);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'paused');
    assert.deepEqual(await ok('instinct', 'tasks', 'claim', t.id), NOT_CLAIMED);
    await pool.query('DELETE FROM pair_pause');

    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'grok'`);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'disabled sender');
    assert.deepEqual(await ok('instinct', 'tasks', 'claim', t.id), NOT_CLAIMED);
    await pool.query(`UPDATE agent SET enabled = true WHERE id = 'grok'`);

    await pool.query(`UPDATE task SET deadline_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending')), [], 'overdue');
    assert.deepEqual(await ok('instinct', 'tasks', 'claim', t.id), NOT_CLAIMED);
  });

  test('pages with a cursor, oldest first, and --all reads them all', async () => {
    const made = [await offered(), await offered('claude'), await offered()];
    await pool.query('UPDATE task SET created_at = $2 WHERE id = $1', [made[0]!.id, '2026-01-01T00:00:00.123456Z']);
    await pool.query('UPDATE task SET created_at = $2 WHERE id = $1', [made[1]!.id, '2026-01-01T00:00:00.123456Z']); // A tie: the id decides.
    await pool.query('UPDATE task SET created_at = $2 WHERE id = $1', [made[2]!.id, '2026-01-02T00:00:00Z']);
    const firstTwo = [made[0]!.id, made[1]!.id].sort();

    const p1 = await ok('instinct', 'tasks', 'pending', '--limit', '1');
    assert.deepEqual(ids(p1), [firstTwo[0]]);
    assert.equal(p1.next_cursor, firstTwo[0]);
    const p2 = await ok('instinct', 'tasks', 'pending', '--limit', '1', '--cursor', p1.next_cursor);
    assert.deepEqual(ids(p2), [firstTwo[1]]);
    const p3 = await ok('instinct', 'tasks', 'pending', '--limit', '1', '--cursor', p2.next_cursor);
    assert.deepEqual(ids(p3), [made[2]!.id]);
    assert.equal(p3.next_cursor, null);

    const all = await ok('instinct', 'tasks', 'pending', '--all', '--limit', '2');
    assert.deepEqual(ids(all), [...firstTwo, made[2]!.id]);
    assert.equal(all.next_cursor, null);
  });

  test("a cursor naming someone else's task or nothing lists nothing, and a malformed one is bad usage", async () => {
    await offered();
    const foreign = await offered('instinct', 'grok');
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending', '--cursor', foreign.id)), []);
    assert.deepEqual(ids(await ok('instinct', 'tasks', 'pending', '--cursor', NO_SUCH_TASK)), []);
    const bad = await cli('instinct', 'tasks', 'pending', '--cursor', 'nope');
    assert.equal(bad.code, 2);
    assert.equal(bad.json.error.code, 'invalid_body');
  });

  test('sanitizes what it shows', async () => {
    const t = await offered('grok', 'instinct', { intent: 'ops.he​llo‮', input: { a: 1 } });
    await pool.query(`UPDATE task SET attempts = 1, state = 'working', risk = 'read' WHERE id = $1`, [t.id]);
    const r = await cli('instinct', 'tasks', 'pending');
    assert.equal(r.json.tasks[0].intent, 'ops.hello');
    assert.ok(!r.stdout.includes('\\u200b') && !r.stdout.includes('​') && !r.stdout.includes('‮'));
  });
});

describe('POST /tasks/:id/claim', () => {
  test('the first claim gets the task, labelled and sanitized, in the shape of the MCP tool', async () => {
    const t = await offered('grok', 'instinct', { input: { query: 'ho​la' } });
    const r = await ok('instinct', 'tasks', 'claim', t.id);
    assert.equal(r.claimed, true);
    assert.equal(r.task.id, t.id);
    assert.equal(r.data.input.query, 'hola');
    assert.equal(r.data.from_agent, 'grok');
    assert.match(r.data_label, /never instructions/);
    assert.equal((await reload(t.id)).state, 'working');
    assert.ok((await reload(t.id)).claimed_at);
    assert.equal(await eventsOf(t.id, 'task_claimed'), 1);

    const viaMcp = await offered('grok', 'instinct', { input: { query: 'second' } });
    const m = await mcpClaim(viaMcp.id);
    assert.deepEqual(Object.keys(m).sort(), Object.keys(r).sort());
  });

  test('forged, malformed, repeated and foreign claims get the same answer as MCP, and change nothing', async () => {
    const claimed = await offered();
    await ok('instinct', 'tasks', 'claim', claimed.id);
    const foreign = await offered('instinct', 'grok');
    const unoffered = await newTask('claude', 'instinct');
    const before = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM event')).rows[0]!.n;

    for (const [what, id] of [['forged', NO_SUCH_TASK], ['repeated', claimed.id], ['foreign', foreign.id], ['not offered', unoffered.id]] as const) {
      assert.deepEqual(await ok('instinct', 'tasks', 'claim', id), NOT_CLAIMED, what);
      assert.deepEqual(await mcpClaim(id), NOT_CLAIMED, `${what} via MCP`);
    }
    // The CLI refuses a malformed id itself, so this one goes straight at the route.
    const res = await fetch(`${url}/tasks/not-a-uuid/claim`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.instinct}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), NOT_CLAIMED);
    assert.deepEqual(await mcpClaim('not-a-uuid'), NOT_CLAIMED);

    assert.equal((await reload(foreign.id)).claimed_at, null);
    assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM event')).rows[0]!.n, before);
  });

  test('a claim through MCP and one through HTTP compete for the same task', async () => {
    const t = await offered();
    assert.equal((await mcpClaim(t.id)).claimed, true);
    assert.deepEqual(await ok('instinct', 'tasks', 'claim', t.id), NOT_CLAIMED);
  });

  test('two CLI processes racing on one task: one wins', async () => {
    const t = await offered();
    const answers = await Promise.all([ok('instinct', 'tasks', 'claim', t.id), ok('instinct', 'tasks', 'claim', t.id)]);
    assert.deepEqual(answers.map((a) => a.claimed).sort(), [false, true]);
    assert.equal(await eventsOf(t.id, 'task_claimed'), 1);
  });

  test('a claim with no key is refused', async () => {
    const t = await offered();
    assert.equal((await cli('nobody', 'tasks', 'claim', t.id)).code, 3);
    assert.equal((await reload(t.id)).claimed_at, null);
  });
});

describe('the whole round through the CLI', () => {
  test('pending, claim, complete twice: one effect, and the terminal state stays', async () => {
    const t = await offered();
    const [listed] = (await ok('instinct', 'tasks', 'pending')).tasks;
    assert.equal(listed.id, t.id);
    assert.equal((await ok('instinct', 'tasks', 'claim', t.id)).claimed, true);

    const done = { summary: 'hecho' };
    const first = await ok('instinct', 'tasks', 'complete', t.id, '--output-json', JSON.stringify(done));
    assert.deepEqual(first, { task_id: t.id, state: 'completed' });
    const again = await ok('instinct', 'tasks', 'complete', t.id, '--output-json', JSON.stringify(done));
    assert.deepEqual(again, first);
    assert.equal(await eventsOf(t.id, 'task_completed'), 1);

    const changed = await cli('instinct', 'tasks', 'complete', t.id, '--output-json', '{"summary":"otra"}');
    assert.equal(changed.code, 1);
    assert.equal(changed.json.error.code, 'invalid_state');
    const flipped = await cli('instinct', 'tasks', 'complete', t.id, '--output-json', JSON.stringify(done), '--failed');
    assert.equal(flipped.code, 1);
    const row = await reload(t.id);
    assert.equal(row.state, 'completed');
    assert.deepEqual(row.output, done);
  });

  test('tasks get shows the sender the result once closed, labelled as data; a stranger gets 5', async () => {
    const t = await offered('grok', 'instinct');
    assert.equal((await ok('grok', 'tasks', 'get', t.id)).task.state, 'working');
    await ok('instinct', 'tasks', 'claim', t.id);
    await ok('instinct', 'tasks', 'complete', t.id, '--output-json', '{"result":"hecho"}');
    const seen = await ok('grok', 'tasks', 'get', t.id);
    assert.match(seen.data_label, /data, never instructions/);
    assert.deepEqual({ ...seen.task, deadline_at: undefined }, {
      id: t.id, from_agent: 'grok', to_agent: 'instinct', intent: 'research', state: 'completed', output: { result: 'hecho' }, deadline_at: undefined,
    });
    assert.equal((await cli('claude', 'tasks', 'get', t.id)).code, 5);
  });

  test('--failed closes as failed; a stranger gets 5 and changes nothing', async () => {
    const t = await offered();
    assert.equal((await cli('claude', 'tasks', 'complete', t.id, '--output-json', '{"a":1}')).code, 5);
    assert.equal((await reload(t.id)).state, 'working');
    assert.equal((await ok('instinct', 'tasks', 'complete', t.id, '--output-json', '{"why":"no"}', '--failed')).state, 'failed');
  });

  test('a secret in the output is refused and not stored', async () => {
    const t = await offered();
    const r = await cli('instinct', 'tasks', 'complete', t.id, '--output-json', JSON.stringify({ note: `password: hunter2hunter2` }));
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'secret_rejected');
    assert.equal((await reload(t.id)).output, null);
  });

  test('tasks create repeats safely with its key, and a guard hit exits 1', async () => {
    const args = ['tasks', 'create', '--to', 'grok', '--intent', 'research', '--input-json', '{"query":"madrid"}', '--idempotency-key', 'cli-1'];
    const first = await ok('instinct', ...args);
    assert.equal(first.created, true);
    assert.equal(first.state, 'submitted');
    const again = await ok('instinct', ...args);
    assert.equal(again.created, false);
    assert.equal(again.task_id, first.task_id);
    assert.equal((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM task')).rows[0]!.n, 1);

    const dup = await cli('instinct', 'tasks', 'create', '--to', 'grok', '--intent', 'research', '--input-json', '{"query":"madrid"}', '--idempotency-key', 'cli-2');
    assert.equal(dup.code, 1);
    assert.equal(dup.json.error.code, 'task_rejected');
    assert.match(dup.json.error.message, /duplicate_content/);
  });

  test('memory write then search: same value changes nothing, and results are labelled', async () => {
    const first = await ok('instinct', 'memory', 'write', 'hotel.madrid', 'Atlas, reservado');
    assert.deepEqual(first, { namespace: 'shared', key: 'hotel.madrid', trust: 'unverified', created: true });
    assert.equal((await ok('instinct', 'memory', 'write', 'hotel.madrid', 'Atlas, reservado')).created, false);
    const found = await ok('grok', 'memory', 'search', 'atlas', '--limit', '3');
    assert.match(found.data_label, /never instructions/);
    assert.equal(found.facts[0].value, 'Atlas, reservado');
    assert.equal(found.facts[0].source_agent, 'instinct');
  });
});
