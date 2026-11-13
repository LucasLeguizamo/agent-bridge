import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/http.ts';
import { DATA_LABEL } from '../src/memory.ts';
import { openTestSchema } from './pg.ts';

const KEYS = { grok: 'g'.repeat(32), instinct: 'i'.repeat(32) };
const TOKEN = 'd'.repeat(40);

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

type Body = {
  data_label: string; next_before: string | null; error?: string;
  conversations: { root_id: string; started_at: string; last_at: string; tasks: {
    id: string; parent_id: string | null; hop: number; from_agent: string; to_agent: string; intent: string | null;
    risk: string; state: string; created_at: string; finished_at: string | null; input: unknown; output: unknown;
    input_bytes: number; output_bytes: number | null; truncated: boolean;
    events: { type: string; actor: string; created_at: string; payload?: unknown }[];
  }[] }[];
};

const get = async (path: string, bearer?: string, target = app) => {
  const res = await target.request(path, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
  return { status: res.status, body: (await res.json()) as Body };
};

let seq = 0;
// One base time for every row, so durations are exact: now() moves between statements.
const BASE = new Date();
/** Direct insert, so each case controls times, states and outputs exactly. `at` is minutes before now. */
async function task(o: { id?: string; root?: string; parent?: string; from?: string; to?: string; hop?: number; state?: string;
  intent?: string; input?: unknown; output?: unknown; at: number; events?: [string, string, number, unknown?][] }) {
  const id = o.id ?? randomUUID();
  seq++;
  await pool.query(
    `INSERT INTO task (id, root_id, parent_id, from_agent, to_agent, intent, input, output, risk, state, hop,
       idempotency_key, deadline_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'read', $9, $10, $11, now() + interval '1 day',
       $13::timestamptz - make_interval(mins => $12))`,
    [id, o.root ?? id, o.parent ?? null, o.from ?? 'grok', o.to ?? 'instinct', o.intent ?? 'research',
      JSON.stringify(o.input ?? { query: `q${seq}` }), o.output === undefined ? null : JSON.stringify(o.output),
      o.state ?? 'submitted', o.hop ?? 0, `k${seq}`, o.at, BASE],
  );
  for (const [type, actor, at, payload] of o.events ?? [['task_created', o.from ?? 'grok', o.at]]) {
    await pool.query(
      `INSERT INTO event (task_id, actor, type, payload, created_at) VALUES ($1, $2, $3, $4, $6::timestamptz - make_interval(mins => $5))`,
      [id, actor, type, JSON.stringify(payload ?? { secret_detail: 'payload text' }), at, BASE]);
  }
  return id;
}

before(async () => {
  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  app = createApp(pool, KEYS, { dashboardToken: TOKEN });
});
after(async () => {
  await pool?.end();
  await db?.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'http'), ('instinct', 'http')`);
});

describe('dashboard auth', () => {
  test('answers 401 without a token and with a wrong one', async () => {
    assert.equal((await get('/dashboard/conversations')).status, 401);
    assert.equal((await get('/dashboard/conversations', 'x'.repeat(40))).status, 401);
    assert.equal((await get('/dashboard/conversations', TOKEN.slice(0, -1))).status, 401);
    assert.equal((await get('/dashboard/conversations', TOKEN)).status, 200);
  });

  test('an agent key does not open it, so agents cannot read each other\'s traffic', async () => {
    for (const key of Object.values(KEYS)) {
      const { status } = await get('/dashboard/conversations', key);
      assert.ok(status === 401 || status === 403, `agent key got ${status}`);
    }
  });

  test('an unset or short token keeps it locked, and so does one reused as an agent key', async () => {
    assert.equal((await get('/dashboard/conversations', TOKEN, createApp(pool, KEYS))).status, 401);
    const short = 'd'.repeat(31);
    assert.equal((await get('/dashboard/conversations', short, createApp(pool, KEYS, { dashboardToken: short }))).status, 401);
    const reused = createApp(pool, KEYS, { dashboardToken: KEYS.grok });
    assert.equal((await get('/dashboard/conversations', KEYS.grok, reused)).status, 401);
  });

  test('a token equal to the cron secret or another bridge secret keeps it locked', async () => {
    const shared = 's'.repeat(40);
    for (const options of [{ cronSecret: shared }, { secrets: [undefined, shared] }]) {
      const locked = createApp(pool, KEYS, { dashboardToken: shared, ...options });
      assert.equal((await get('/dashboard/conversations', shared, locked)).status, 401);
    }
    const open = createApp(pool, KEYS, { dashboardToken: TOKEN, cronSecret: shared, secrets: ['e'.repeat(40)] });
    assert.equal((await get('/dashboard/conversations', TOKEN, open)).status, 200);
  });

  test('answers with nosniff on the data route', async () => {
    for (const bearer of [TOKEN, undefined]) {
      const res = await app.request('/dashboard/conversations', bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });

  test('the dashboard token is not an agent key either', async () => {
    assert.equal((await get('/tasks/pending', TOKEN)).status, 401);
  });
});

describe('GET /dashboard/conversations', () => {
  test('groups tasks by root_id, newest activity first, with tasks in chain order and payloads left out', async () => {
    const a = await task({ at: 30, state: 'completed', output: { answer: 'done' },
      events: [['task_created', 'grok', 30], ['task_claimed', 'instinct', 29], ['task_completed', 'instinct', 25]] });
    const a1 = await task({ root: a, parent: a, from: 'instinct', to: 'grok', hop: 1, at: 28, state: 'rejected',
      output: { rejected: 'hop_limit' }, events: [['task_rejected', 'instinct', 28], ['alert', 'bridge', 28]] });
    const b = await task({ at: 10 });

    const { status, body } = await get('/dashboard/conversations', TOKEN);
    assert.equal(status, 200);
    assert.equal(body.data_label, DATA_LABEL);
    assert.equal(body.next_before, null);
    assert.deepEqual(body.conversations.map((c) => c.root_id), [b, a]);

    const conv = body.conversations[1]!;
    assert.deepEqual(conv.tasks.map((t) => [t.id, t.parent_id, t.hop, t.from_agent, t.to_agent, t.state]),
      [[a, null, 0, 'grok', 'instinct', 'completed'], [a1, a, 1, 'instinct', 'grok', 'rejected']]);
    const [first, second] = conv.tasks;
    assert.deepEqual(first!.input, { query: 'q1' });
    assert.deepEqual(first!.output, { answer: 'done' });
    assert.deepEqual(first!.events.map((e) => [e.type, e.actor]),
      [['task_created', 'grok'], ['task_claimed', 'instinct'], ['task_completed', 'instinct']]);
    assert.ok(first!.events.every((e) => !('payload' in e)));
    assert.ok(!JSON.stringify(body).includes('payload text'));
    // Finished when its completing event was written: 5 minutes after it was created.
    assert.equal(Date.parse(first!.finished_at!) - Date.parse(first!.created_at), 5 * 60_000);
    assert.equal(second!.finished_at, second!.created_at);
    assert.equal(body.conversations[0]!.tasks[0]!.finished_at, null);
    assert.equal(Date.parse(conv.started_at), Date.parse(first!.created_at));
    assert.equal(Date.parse(conv.last_at), Date.parse(second!.created_at));
  });

  test('orders a chain by time, then hop, whatever the ids sort to', async () => {
    const [r, c1, c2] = ['ffffffff', 'eeeeeeee', 'dddddddd'].map((p) => `${p}-0000-4000-8000-000000000000`);
    await task({ id: r!, at: 5 });
    await task({ id: c1!, root: r, parent: r, hop: 1, at: 5 });
    await task({ id: c2!, root: r, parent: c1, hop: 2, at: 5 });
    const [conv] = (await get('/dashboard/conversations', TOKEN)).body.conversations;
    assert.deepEqual(conv!.tasks.map((t) => t.id), [r, c1, c2]);
  });

  test('a task failed by the deadline sweep finishes at its alert event', async () => {
    await task({ at: 10, state: 'failed', output: { error: 'deadline_exceeded' },
      events: [['task_created', 'grok', 10], ['alert', 'bridge', 4, { alert: 'deadline_exceeded' }]] });
    const t = (await get('/dashboard/conversations', TOKEN)).body.conversations[0]!.tasks[0]!;
    assert.equal(Date.parse(t.finished_at!) - Date.parse(t.created_at), 6 * 60_000);
  });

  test('drops hidden and zero-width characters from task content', async () => {
    await task({ at: 1, input: { query: 'pay\u200b now\u202e' } });
    const t = (await get('/dashboard/conversations', TOKEN)).body.conversations[0]!.tasks[0]!;
    assert.deepEqual(t.input, { query: 'pay now' });
  });

  test('a task canceled through the API shows its real events and finish time', async () => {
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEYS.grok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to_agent: 'instinct', intent: 'research', input: { query: 'x' }, idempotency_key: 'api1' }),
    });
    const { task: t } = (await res.json()) as { task: { id: string } };
    await app.request(`/tasks/${t.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.grok}` } });

    const [conv] = (await get('/dashboard/conversations', TOKEN)).body.conversations;
    assert.equal(conv!.tasks[0]!.state, 'canceled');
    assert.deepEqual(conv!.tasks[0]!.events.map((e) => e.type), ['task_created', 'task_canceled']);
    assert.ok(conv!.tasks[0]!.finished_at);
  });

  test('redact=1 drops free text and keeps machine codes', async () => {
    await task({ at: 3, state: 'rejected', intent: 'Ask Lucas about his flight', input: { text: 'private plans in Madrid' },
      output: { rejected: 'pair_paused', note: 'free text here' } });
    await task({ at: 2, state: 'failed', input: { text: 'more private text' }, output: { error: 'deadline_exceeded' } });
    await task({ at: 1, state: 'failed', output: { error: 'Receiver said: call me at home' },
      events: [['task_created', 'grok', 1], ['agent.Note-To-Self.hidden', 'grok', 1]] });

    const plain = (await get('/dashboard/conversations', TOKEN)).body;
    assert.ok(JSON.stringify(plain).includes('private plans in Madrid'));

    const { status, body } = await get('/dashboard/conversations?redact=1', TOKEN);
    assert.equal(status, 200);
    const tasks = body.conversations.map((c) => c.tasks[0]!);
    assert.deepEqual(tasks.map((t) => t.input), [null, null, null]);
    assert.deepEqual(tasks.map((t) => t.output), [null, { error: 'deadline_exceeded' }, { rejected: 'pair_paused' }]);
    assert.deepEqual(tasks.map((t) => t.intent), ['research', 'research', 'other']);
    assert.deepEqual(tasks[0]!.events.map((e) => e.type), ['task_created', 'redacted']);
    const text = JSON.stringify(body);
    for (const leaked of ['private', 'free text', 'Receiver', 'Lucas', 'Note-To-Self']) assert.ok(!text.includes(leaked), leaked);
  });

  test('redact=1 keeps only intents with a policy and output codes the bridge writes, snake_case or not', async () => {
    await task({ at: 3, state: 'failed', intent: 'ask_owner_about_madrid_flight', output: { error: 'call_me_at_home_after_9' } });
    await task({ at: 2, state: 'rejected', intent: 'memory.write', output: { rejected: 'not_a_bridge_code', error: 'hop_limit' } });
    await task({ at: 1, state: 'rejected', intent: 'summarize', output: { rejected: 'fanout_limit' } });

    const { body } = await get('/dashboard/conversations?redact=1', TOKEN);
    const tasks = body.conversations.map((c) => c.tasks[0]!);
    assert.deepEqual(tasks.map((t) => t.intent), ['summarize', 'memory.write', 'other']);
    assert.deepEqual(tasks.map((t) => t.output), [{ rejected: 'fanout_limit' }, { error: 'hop_limit' }, null]);
    const text = JSON.stringify(body);
    for (const leaked of ['madrid', 'call_me', 'not_a_bridge_code']) assert.ok(!text.includes(leaked), leaked);
  });

  test('redact=1 pseudonymizes ids, stable within the answer, and keeps parent links', async () => {
    const a = await task({ at: 30 });
    const a1 = await task({ root: a, parent: a, hop: 1, at: 29 });
    await task({ root: a, parent: a1, hop: 2, at: 28 });
    const b = await task({ at: 10 });

    const { body } = await get('/dashboard/conversations?redact=1', TOKEN);
    assert.deepEqual(body.conversations.map((c) => c.root_id), ['c1', 'c2']);
    assert.deepEqual(body.conversations.map((c) => c.tasks.map((t) => [t.id, t.parent_id])),
      [[['t1', null]], [['t2', null], ['t3', 't2'], ['t4', 't3']]]);
    const text = JSON.stringify(body);
    for (const id of [a, a1, b]) assert.ok(!text.includes(id), id);
  });

  test('caps input and output per task, with byte sizes and a truncated flag', async () => {
    const big = 'é'.repeat(3000);
    await task({ at: 2, input: { query: big }, output: { answer: big + big } });
    await task({ at: 1, input: { query: 'small' } });

    const [small, large] = (await get('/dashboard/conversations', TOKEN)).body.conversations.map((c) => c.tasks[0]!);
    assert.equal(small!.truncated, false);
    assert.deepEqual(small!.input, { query: 'small' });
    assert.equal(small!.output_bytes, null);
    assert.equal(large!.truncated, true);
    assert.equal(typeof large!.input, 'string');
    assert.equal((large!.input as string).length, 2000);
    assert.ok((large!.input as string).startsWith('{"query": "éé'));
    assert.equal((large!.output as string).length, 4000);
    // Bytes of the stored JSON text: é is two bytes.
    assert.equal(large!.input_bytes, '{"query": ""}'.length + 6000);
    assert.equal(large!.output_bytes, '{"answer": ""}'.length + 12000);
    // Redaction still drops both, however long.
    const [, red] = (await get('/dashboard/conversations?redact=1', TOKEN)).body.conversations.map((c) => c.tasks[0]!);
    assert.equal(red!.input, null);
    assert.equal(red!.output, null);
  });

  test('bounds limit: default 20, at most 100, and pages with next_before', async () => {
    for (let i = 0; i < 21; i++) await task({ at: 100 - i });
    const page = (await get('/dashboard/conversations', TOKEN)).body;
    assert.equal(page.conversations.length, 20);
    assert.ok(page.next_before);
    const rest = (await get(`/dashboard/conversations?before=${encodeURIComponent(page.next_before!)}`, TOKEN)).body;
    assert.equal(rest.conversations.length, 1);
    assert.equal(rest.next_before, null);
    assert.ok(!page.conversations.some((c) => c.root_id === rest.conversations[0]!.root_id));

    // Microsecond cursor: two conversations 1 µs apart, one per page, neither skipped nor repeated.
    await pool.query('TRUNCATE event, task CASCADE');
    const older = await task({ at: 0 });
    const newer = await task({ at: 0 });
    await pool.query(`UPDATE task SET created_at = CASE id WHEN $1 THEN '2026-01-01T00:00:00.000001Z'::timestamptz
      ELSE '2026-01-01T00:00:00.000002Z'::timestamptz END`, [older]);
    const p1 = (await get('/dashboard/conversations?limit=1', TOKEN)).body;
    assert.deepEqual(p1.conversations.map((c) => c.root_id), [newer]);
    assert.match(p1.next_before!, /\.000002/);
    const p2 = (await get(`/dashboard/conversations?limit=1&before=${encodeURIComponent(p1.next_before!)}`, TOKEN)).body;
    assert.deepEqual(p2.conversations.map((c) => c.root_id), [older]);
    const p3 = (await get(`/dashboard/conversations?limit=1&before=${encodeURIComponent(p2.next_before!)}`, TOKEN)).body;
    assert.deepEqual(p3.conversations, []);
    for (let i = 0; i < 21; i++) await task({ at: 100 - i });

    assert.equal((await get('/dashboard/conversations?limit=100', TOKEN)).body.conversations.length, 23);
    assert.equal((await get('/dashboard/conversations?limit=5', TOKEN)).body.conversations.length, 5);
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'before=yesterday', 'redact=yes', 'other=1']) {
      const { status, body } = await get(`/dashboard/conversations?${bad}`, TOKEN);
      assert.equal(status, 400, bad);
      assert.equal(body.error, 'invalid_query');
    }
  });
});

describe('GET /dashboard', () => {
  test('serves one self-contained page under a strict CSP that matches its inline code', async () => {
    const res = await app.request('/dashboard');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);

    const html = await res.text();
    const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const style = html.match(/<style>([\s\S]*)<\/style>/)![1]!;
    assert.ok(csp.includes(`script-src ${hash(script)}`));
    assert.ok(csp.includes(`style-src ${hash(style)}`));
    assert.doesNotMatch(html, /<script[^>]+src=|<link\b|https?:\/\//);
    // Task content is attacker-controlled: nothing may parse it as HTML.
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    assert.match(script, /textContent/);
  });
});
