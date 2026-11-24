import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/http.ts';
import { createTask } from '../src/tasks.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openTestSchema, testDatabaseUrl } from './pg.ts';

const KEYS = { grok: 'g'.repeat(32), instinct: 'i'.repeat(32), claude: 'c'.repeat(32) };
type Agent = keyof typeof KEYS;

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

const get = (path: string, agent: Agent = 'grok') =>
  app.request(path, { headers: { authorization: `Bearer ${KEYS[agent]}` } });
const ask = async () => (await createTask(pool, 'grok', {
  to_agent: 'instinct', intent: 'research', input: { query: 'q1' }, idempotency_key: 'k1',
})).task;
const ask2 = async () => (await createTask(pool, 'grok', {
  to_agent: 'instinct', intent: 'research', input: { query: 'q2' }, idempotency_key: 'k2',
})).task;
const complete = (id: string) =>
  pool.query(`UPDATE task SET state = 'completed', output = '{"result":"42"}' WHERE id = $1`, [id]);

before(async () => {
  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 4 });
  app = createApp(pool, KEYS);
});
after(async () => {
  await pool?.end();
  await db?.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE adapter_pause, pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter, config) VALUES
    ('grok', 'grok', '{}'), ('instinct', 'fake', '{}'), ('claude', 'fake', '{}')`);
});

describe('GET /tasks/:id/answer', () => {
  test('the asker reads the state of its own open task, without the input', async () => {
    const t = await ask();
    const res = await get(`/tasks/${t.id}/answer`);
    assert.equal(res.status, 200);
    const body = await res.json() as { data_label: string; task: Record<string, unknown> };
    assert.equal(body.task.state, 'submitted');
    assert.equal(body.task.to_agent, 'instinct');
    assert.ok(typeof body.data_label === 'string' && body.data_label.length > 0);
    assert.ok(!('input' in body.task));
    assert.ok(!('from_agent' in body.task));
  });

  test('the receiver and a third agent get 404 for the same id', async () => {
    const t = await ask();
    for (const agent of ['instinct', 'claude'] as const) {
      const res = await get(`/tasks/${t.id}/answer`, agent);
      assert.equal(res.status, 404, agent);
      assert.deepEqual(await res.json(), { error: 'not_found' });
    }
  });

  test('an 8-character prefix works, a 7-character one does not', async () => {
    const t = await ask();
    const ok = await get(`/tasks/${t.id.slice(0, 8)}/answer`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { task: { id: string } }).task.id, t.id);
    assert.equal((await get(`/tasks/${t.id.slice(0, 7)}/answer`)).status, 404);
  });

  test('a bad wait or an unknown parameter is invalid_body', async () => {
    const t = await ask();
    for (const q of ['wait=26', 'wait=-1', 'wait=abc', 'other=1']) {
      const res = await get(`/tasks/${t.id}/answer?${q}`);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: 'invalid_body' }, q);
    }
  });

  test('wait returns as soon as the task completes', async () => {
    const t = await ask();
    setTimeout(() => void complete(t.id), 500);
    const started = Date.now();
    const res = await get(`/tasks/${t.id}/answer?wait=6`);
    assert.ok(Date.now() - started < 5000);
    const { task } = await res.json() as { task: { state: string; output: { result: string } } };
    assert.equal(task.state, 'completed');
    assert.equal(task.output.result, '42');
  });

  test('wait on a task that stays open answers when the time is up', async () => {
    const t = await ask();
    const started = Date.now();
    const res = await get(`/tasks/${t.id}/answer?wait=3`);
    const took = Date.now() - started;
    assert.ok(took >= 1000 && took <= 4000, `took ${took} ms`);
    assert.equal(((await res.json()) as { task: { state: string } }).task.state, 'submitted');
  });

  test('a finished task answers at once even with the longest wait', async () => {
    const t = await ask();
    await complete(t.id);
    const started = Date.now();
    const res = await get(`/tasks/${t.id}/answer?wait=25`);
    assert.ok(Date.now() - started < 1000);
    assert.equal(((await res.json()) as { task: { state: string } }).task.state, 'completed');
  });
});

describe('reading an answer records that the asker saw it', () => {
  const seen = async (id: string) =>
    (await pool.query<{ asker_seen_at: Date | null }>('SELECT asker_seen_at FROM task WHERE id = $1', [id])).rows[0]!.asker_seen_at;

  test('an open task stays unseen', async () => {
    const t = await ask();
    await get(`/tasks/${t.id}/answer`);
    assert.equal(await seen(t.id), null);
  });

  test('a completed task is marked on the first read and not changed by the second', async () => {
    const t = await ask();
    await complete(t.id);
    await get(`/tasks/${t.id}/answer`);
    const first = await seen(t.id);
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 20));
    await get(`/tasks/${t.id}/answer`);
    assert.deepEqual(await seen(t.id), first);
  });

  // A held read can be left behind by a client that went away, and a serverless host does not always say so. So a task
  // that ends during the hold is not marked; the served texts make one last read without ?wait, and that one counts.
  test('a task that ends while a read is held is not marked, and a plain read afterwards marks it', async () => {
    const t = await ask();
    const held = get(`/tasks/${t.id}/answer?wait=4`);
    await new Promise((r) => setTimeout(r, 300));
    await complete(t.id);
    const body = await (await held).json() as { task: { state: string } };
    assert.equal(body.task.state, 'completed');
    assert.equal(await seen(t.id), null);
    await get(`/tasks/${t.id}/answer`);
    assert.ok(await seen(t.id));
  });

  test('a held read of a task that had already ended marks it', async () => {
    const t = await ask();
    await complete(t.id);
    await get(`/tasks/${t.id}/answer?wait=25`);
    assert.ok(await seen(t.id));
  });

  test('GET /tasks/:id by the asker on an ended task marks it, and on an open one does not', async () => {
    const t = await ask();
    assert.equal((await get(`/tasks/${t.id}`)).status, 200);
    assert.equal(await seen(t.id), null);
    await complete(t.id);
    assert.equal((await get(`/tasks/${t.id}`)).status, 200);
    assert.ok(await seen(t.id));
  });

  test('the receiver reading the task does not mark it', async () => {
    const t = await ask();
    await pool.query('UPDATE task SET attempts = 1 WHERE id = $1', [t.id]);
    await complete(t.id);
    assert.equal((await get(`/tasks/${t.id}`, 'instinct')).status, 200);
    assert.equal(await seen(t.id), null);
  });
});

describe('the receiver never sees the wake bookkeeping', () => {
  const post = (path: string, agent: Agent, body?: unknown) => app.request(path, {
    method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${KEYS[agent]}`, 'content-type': 'application/json' },
  });
  const clean = async (res: Response) => {
    const text = await res.text();
    assert.ok(res.status < 500, text);
    assert.doesNotMatch(text, /asker_/);
  };

  test('no route that returns a task row carries asker_seen_at or asker_woken_at', async () => {
    const t = await ask();
    await pool.query('UPDATE task SET attempts = 1 WHERE id = $1', [t.id]);
    await clean(await get(`/tasks/${t.id}`, 'instinct'));
    await clean(await get(`/tasks/${t.id}`, 'grok'));
    await clean(await get(`/tasks/${t.id}/answer`, 'grok'));
    await clean(await get('/tasks/pending', 'instinct'));
    await clean(await post(`/tasks/${t.id}/claim`, 'instinct'));
    await clean(await post(`/tasks/${t.id}/complete`, 'instinct', { output: { result: '42' } }));
    const again = await createTask(pool, 'grok', { to_agent: 'instinct', intent: 'research', input: { query: 'q2' }, idempotency_key: 'k2' });
    await clean(await post(`/tasks/${again.task.id}/cancel`, 'grok'));
    const created = await post('/tasks', 'grok', { to_agent: 'instinct', intent: 'research', input: { query: 'q3' }, idempotency_key: 'k3' });
    assert.equal(created.status, 201);
    await clean(created);
    const third = await createTask(pool, 'grok', { to_agent: 'instinct', intent: 'research', input: { query: 'q4' }, idempotency_key: 'k4' });
    await pool.query('UPDATE task SET attempts = 1 WHERE id = $1', [third.task.id]);
    await clean(await post(`/tasks/${third.task.id}/fail`, 'instinct', { output: { reason: 'x' } }));
    // The columns are really set, so a clean answer is not an empty column.
    await pool.query(`UPDATE task SET asker_seen_at = now(), asker_woken_at = now()`);
    await clean(await get(`/tasks/${t.id}`, 'instinct'));
    await clean(await get(`/tasks/${t.id}`, 'grok'));
  });
});

describe('the size of an answer', () => {
  const finish = (id: string, output: unknown) =>
    pool.query(`UPDATE task SET state = 'completed', output = $2::jsonb WHERE id = $1`, [id, JSON.stringify(output)]);
  const answer = async (id: string) => ((await (await get(`/tasks/${id}/answer`)).json()) as { task: { output: Record<string, unknown> } }).task.output;

  test('a small answer is returned as it is', async () => {
    const t = await ask();
    await finish(t.id, { result: 'short', n: 1 });
    assert.deepEqual(await answer(t.id), { result: 'short', n: 1 });
  });

  test('a 1 MB answer is cut to about 8000 characters, marked, and keeps its result field', async () => {
    const t = await ask();
    await finish(t.id, { result: 'abc '.repeat(250_000), extra: 'x'.repeat(500_000) });
    const out = await answer(t.id);
    assert.ok(JSON.stringify(out).length <= 8200, String(JSON.stringify(out).length));
    assert.equal(out.truncated, true);
    assert.ok(String(out.result).startsWith('abc abc abc'));
    assert.match(String(out.result), /\[truncated\]$/);
  });

  test('reason, error and detail survive the cut, with the same names', async () => {
    const t = await ask();
    await finish(t.id, { reason: 'r'.repeat(100_000), error: 'e'.repeat(100_000), detail: 'd'.repeat(100_000), junk: 'j'.repeat(100_000) });
    const out = await answer(t.id);
    assert.ok(JSON.stringify(out).length <= 8200);
    for (const k of ['reason', 'error', 'detail']) assert.match(String(out[k]), new RegExp(`^${k[0]}+.*\\[truncated\\]$`), k);
    assert.equal('junk' in out, false);
  });

  test('a result that is not text still comes back as one, cut', async () => {
    const t = await ask();
    await finish(t.id, { result: Array.from({ length: 5000 }, (_, i) => ({ i, t: 'word '.repeat(10) })) });
    const out = await answer(t.id);
    assert.ok(JSON.stringify(out).length <= 8200);
    assert.equal(typeof out.result, 'string');
    assert.equal(out.truncated, true);
  });

  test('an output that is not an object is wrapped, not dropped', async () => {
    const t = await ask();
    await finish(t.id, ['x'.repeat(100_000)]);
    const out = await answer(t.id);
    assert.ok(JSON.stringify(out).length <= 8200);
    assert.equal(out.truncated, true);
    assert.match(String(out.result), /^\["x+/);
  });
});

describe('migration 007', () => {
  test('tasks that ended before it wake nobody, and open ones can still be woken later', async () => {
    const raw = testDatabaseUrl();
    const schema = `test_${randomBytes(8).toString('hex')}`;
    const admin = new pg.Client({ connectionString: raw });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(raw);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const old = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
      const dir = new URL('../db/', import.meta.url);
      const files = readdirSync(dir).filter((f) => /^0.*\.sql$/.test(f)).sort();
      assert.ok(files.includes('007_asker_wake.sql'));
      for (const f of files.filter((f) => f < '007')) await old.query(readFileSync(new URL(f, dir), 'utf8'));
      await old.query(`INSERT INTO agent (id, adapter, config) VALUES ('grok', 'grok', '{}'), ('instinct', 'fake', '{}')
        ON CONFLICT (id) DO UPDATE SET adapter = EXCLUDED.adapter, enabled = true`);
      const ids: Record<string, string> = {};
      let n = 0;
      for (const state of ['completed', 'failed', 'canceled', 'rejected', 'submitted', 'working']) {
        n++;
        const { task } = await createTask(old, 'grok', { to_agent: 'instinct', intent: 'research', input: { query: `q${n}` }, idempotency_key: `k${n}` });
        await old.query('UPDATE task SET state = $2 WHERE id = $1', [task.id, state]);
        ids[state] = task.id;
      }
      await old.query(readFileSync(new URL('007_asker_wake.sql', dir), 'utf8'));
      const { rows } = await old.query<{ id: string; asker_seen_at: Date | null; asker_woken_at: Date | null }>(
        'SELECT id, asker_seen_at, asker_woken_at FROM task');
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      for (const state of ['completed', 'failed', 'canceled', 'rejected']) assert.ok(by[ids[state]!]!.asker_seen_at, `${state} is stamped`);
      for (const state of ['submitted', 'working']) assert.equal(by[ids[state]!]!.asker_seen_at, null, `${state} is not`);
      assert.ok(rows.every((r) => r.asker_woken_at === null));
      // The index that keeps the per-pass query cheap exists.
      const { rows: idx } = await old.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'task_asker_wake_due'`, [schema]);
      assert.equal(idx.length, 1);
    } finally {
      await old.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});

describe('the size of an answer, by shape', () => {
  const finish = (id: string, output: unknown) =>
    pool.query(`UPDATE task SET state = 'completed', output = $2::jsonb WHERE id = $1`, [id, JSON.stringify(output)]);
  const answer = async (id: string) => ((await (await get(`/tasks/${id}/answer`)).json()) as { task: { output: Record<string, unknown> } }).task.output;

  test('a lone 9000-character result keeps nearly the whole budget', async () => {
    const t = await ask();
    await finish(t.id, { result: 'w'.repeat(9000) });
    const out = await answer(t.id);
    assert.ok(String(out.result).length > 7500, String(String(out.result).length));
    assert.ok(JSON.stringify(out).length <= 8200);
    assert.equal(out.truncated, true);
  });

  test('an email reply keeps its text and its untrusted mark, and drops the rest', async () => {
    const t = await ask();
    await finish(t.id, { untrusted: true, text: 'hello '.repeat(2000), source: { channel: 'email', from: 'a@b.c', provider_id: 'p' }, memory: { written: [], rejected: 0 } });
    const out = await answer(t.id);
    assert.equal(out.untrusted, true);
    assert.match(String(out.text), /^hello hello.*\[truncated\]$/);
    assert.ok(String(out.text).length > 7500);
    assert.equal(out.truncated, true);
    assert.equal('source' in out, false);
  });

  test('a summary is kept too, as the CLI help example writes it', async () => {
    const t = await ask();
    await finish(t.id, { summary: 's'.repeat(20_000) });
    const out = await answer(t.id);
    assert.match(String(out.summary), /^s+\.\.\.\[truncated\]$/);
  });

  test('an output with none of the known fields is kept whole under result, cut', async () => {
    const t = await ask();
    await finish(t.id, { weird: 'x'.repeat(30_000), other: [1, 2, 3] });
    const out = await answer(t.id);
    assert.equal(out.truncated, true);
    assert.match(String(out.result), /^\{"other":\[1,2,3\],"weird":"xxx.*\[truncated\]$/);
    assert.ok(JSON.stringify(out).length <= 8200);
  });
});

describe('a held read that did not confirm receipt says so', () => {
  const NEXT = 'Read once more without wait to confirm receipt';
  const body = async (res: Response) => await res.json() as { next?: string; task: { state: string } };

  test('it asks for one more read when the task ended during the hold, and not otherwise', async () => {
    const t = await ask();
    const held = get(`/tasks/${t.id}/answer?wait=4`);
    await new Promise((r) => setTimeout(r, 300));
    await complete(t.id);
    const b = await body(await held);
    assert.equal(b.task.state, 'completed');
    assert.equal(b.next, NEXT);
    assert.equal('next' in b.task, false);
    const plain = await body(await get(`/tasks/${t.id}/answer`));
    assert.equal('next' in plain, false);
    const open = await ask2();
    assert.equal('next' in await body(await get(`/tasks/${open.id}/answer`)), false);
    await complete(open.id);
    assert.equal('next' in await body(await get(`/tasks/${open.id}/answer?wait=25`)), false, 'already ended on arrival');
  });
});

describe('the receiver does not see wake events', () => {
  const events = async (path: string, agent: Agent) =>
    ((await (await get(path, agent)).json()) as { events: { type: string }[] }).events.map((e) => e.type);
  const seed = async () => {
    const t = await ask();
    await pool.query('UPDATE task SET attempts = 1 WHERE id = $1', [t.id]);
    await complete(t.id);
    await pool.query(`INSERT INTO event (task_id, actor, type, payload) VALUES
      ($1, 'bridge', 'asker_waking', '{}'), ($1, 'bridge', 'asker_woken', '{}'), ($1, 'bridge', 'asker_wake_failed', '{}'),
      ($1, 'bridge', 'asker2', '{}')`, [t.id]);
    return t;
  };

  test('GET /tasks/:id/events hides them from the receiver and shows them to the asker', async () => {
    const t = await seed();
    const receiver = await events(`/tasks/${t.id}/events`, 'instinct');
    assert.deepEqual(receiver.filter((x) => x.startsWith('asker')), ['asker2']);
    const asker = await events(`/tasks/${t.id}/events`, 'grok');
    assert.deepEqual(asker.filter((x) => x.startsWith('asker_')), ['asker_waking', 'asker_woken', 'asker_wake_failed']);
  });

  test('GET /memory/events hides them from the receiver and shows them to the asker', async () => {
    const t = await seed();
    const receiver = await events(`/memory/events?task_id=${t.id}`, 'instinct');
    assert.equal(receiver.some((x) => x.startsWith('asker_')), false);
    assert.ok(receiver.includes('asker2'));
    const asker = await events(`/memory/events?task_id=${t.id}`, 'grok');
    assert.equal(asker.filter((x) => x.startsWith('asker_')).length, 3);
  });

  test('the dashboard still shows them', async () => {
    await seed();
    const token = 'd'.repeat(40);
    const dash = createApp(pool, KEYS, { dashboardToken: token });
    const res = await dash.request('/dashboard/conversations', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const type of ['asker_waking', 'asker_woken', 'asker_wake_failed']) assert.ok(text.includes(type), type);
  });
});
