import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../src/http.ts';
import { ackDelivered, claim, MAX_ATTEMPTS, nackDelivery, runOnce, type Adapters, type ClaimedTask } from '../src/queue.ts';
import { DAILY_PAIR_CAP, MAX_HOPS, type Task } from '../src/tasks.ts';
import { openTestSchema } from './pg.ts';

const KEYS = { grok: 'g'.repeat(32), instinct: 'i'.repeat(32), claude: 'c'.repeat(32) };
type Agent = keyof typeof KEYS;

let db: Awaited<ReturnType<typeof openTestSchema>> | undefined;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let seq = 0;

// Fake adapter recording what a receiver would actually see.
let delivered: ClaimedTask[] = [];
let failNext = 0;
const adapters: Adapters = {
  fake: {
    async deliver(t) {
      delivered.push(t);
      if (failNext > 0) { failNext--; throw new Error('receiver down'); }
    },
  },
};

async function call(agent: Agent | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...(agent ? { authorization: `Bearer ${KEYS[agent]}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as { task: Task; error?: string; events?: { type: string }[] } };
}

const newTask = (over: Record<string, unknown> = {}) => {
  seq++;
  return { to_agent: 'instinct', intent: 'research', input: { query: `q${seq}` }, idempotency_key: `k${seq}`, ...over };
};
const create = (from: Agent, over: Record<string, unknown> = {}) => call(from, 'POST', '/tasks', newTask(over));
const eventTypes = async (id: string) =>
  (await pool.query('SELECT type FROM event WHERE task_id = $1 ORDER BY id', [id])).rows.map((r) => r.type as string);
const expireLease = (id: string) => pool.query('UPDATE task SET next_attempt_at = now() WHERE id = $1', [id]);

before(async () => {
  db = await openTestSchema();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  await pool.query('CREATE TABLE delivery_log (task_id uuid, idempotency_key text, pid int)');
  app = createApp(pool, KEYS);
});
after(async () => {
  await pool?.end();
  await db?.stop();
});
beforeEach(async () => {
  delivered = [];
  failNext = 0;
  await pool.query('TRUNCATE delivery_log, pair_pause, approval, fact, event, task, agent CASCADE');
  await pool.query(`INSERT INTO agent (id, adapter) VALUES ('grok', 'fake'), ('instinct', 'fake'), ('claude', 'fake')`);
});

describe('two processes', () => {
  test('never double-deliver, and both really compete for work', async () => {
    const N = 100;
    // The URL goes through env, not argv, so the password stays out of `ps`.
    const env = { ...process.env, WORKER_DATABASE_URL: db!.url };
    const workers = [0, 1].map(() => fork(new URL('./worker.ts', import.meta.url), { env }));
    const exited = workers.map((w) => new Promise<void>((resolve, reject) => {
      w.once('error', reject);
      w.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    }));
    await Promise.all(workers.map((w) => new Promise((r) => w.once('message', r))));

    // Direct insert: this test is about the queue, and the guards would cap it at 20.
    await pool.query(
      `INSERT INTO task (root_id, from_agent, to_agent, intent, input, risk, state, idempotency_key, deadline_at)
       SELECT gen_random_uuid(), 'grok', 'instinct', 'research', jsonb_build_object('n', n), 'read', 'submitted',
              'bulk-' || n, now() + interval '1 hour'
       FROM generate_series(1, $1::int) n`, [N]);
    for (const w of workers) w.send('go');
    await Promise.all(exited);

    const { rows: [r] } = await pool.query(
      `SELECT count(*)::int AS deliveries, count(DISTINCT task_id)::int AS tasks, count(DISTINCT pid)::int AS pids
       FROM delivery_log`);
    assert.equal(r.tasks, N, 'every task delivered');
    assert.equal(r.deliveries, N, 'no task delivered twice');
    assert.equal(r.pids, 2, 'both processes delivered work, otherwise the test proves nothing');

    const { rows: [s] } = await pool.query(
      `SELECT count(*) FILTER (WHERE state = 'working' AND attempts = 1)::int AS ok FROM task`);
    assert.equal(s.ok, N);
  });

  test('a claimed task is skipped while its row is locked by another transaction', async () => {
    const { body: { task } } = await create('grok');
    const other = await pool.connect();
    await other.query('BEGIN');
    await other.query('SELECT id FROM task WHERE id = $1 FOR UPDATE', [task.id]);
    // Raced against a timer: a claim that blocks on the lock must fail this test, not hang it.
    const outcome = await Promise.race([claim(pool, adapters), sleep(2000, 'blocked')]);
    await other.query('COMMIT');
    other.release();
    assert.deepEqual(outcome, [], 'skipped, did not block');
    await expireLease(task.id);
    assert.equal((await claim(pool, adapters)).length, 1);
    assert.deepEqual(await claim(pool, adapters), [], 'leased: not claimable again');
  });
});

describe('idempotent retries', () => {
  test('same create replayed returns the same task with one row and one event', async () => {
    const payload = newTask();
    const a = await call('grok', 'POST', '/tasks', payload);
    const b = await call('grok', 'POST', '/tasks', payload);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.task.id, a.body.task.id);
    assert.equal((await pool.query('SELECT 1 FROM task')).rowCount, 1);
    assert.deepEqual(await eventTypes(a.body.task.id), ['task_created']);
  });

  test('concurrent replays of one key create one task', async () => {
    const payload = newTask();
    const all = await Promise.all(Array.from({ length: 10 }, () => call('grok', 'POST', '/tasks', payload)));
    assert.equal(new Set(all.map((r) => r.body.task.id)).size, 1);
    assert.equal(all.filter((r) => r.status === 201).length, 1);
    assert.equal((await pool.query('SELECT 1 FROM task')).rowCount, 1);
  });

  test('same key with different content is a conflict; other agents have their own key space', async () => {
    const payload = newTask();
    await call('grok', 'POST', '/tasks', payload);
    const conflict = await call('grok', 'POST', '/tasks', { ...payload, input: { query: 'other' } });
    assert.equal(conflict.status, 409);
    const other = await call('claude', 'POST', '/tasks', { ...payload, input: { query: 'mine' } });
    assert.equal(other.status, 201);
  });

  test('failed delivery backs off, and the retry carries the same key and delivers once', async () => {
    const { body: { task } } = await create('grok');
    failNext = 1;
    assert.equal(await runOnce(pool, adapters), 1);
    const { rows: [mid] } = await pool.query<Task>('SELECT * FROM task WHERE id = $1', [task.id]);
    assert.equal(mid!.state, 'submitted');
    assert.ok(mid!.next_attempt_at.getTime() > Date.now() + 25_000, 'backed off');
    assert.equal(await runOnce(pool, adapters), 0, 'not due yet');

    await expireLease(task.id);
    assert.equal(await runOnce(pool, adapters), 1);
    assert.equal(await runOnce(pool, adapters), 0, 'delivered tasks are not retried');
    assert.deepEqual(delivered.map((t) => t.idempotency_key), [task.idempotency_key, task.idempotency_key]);
    assert.deepEqual(await eventTypes(task.id),
      ['task_created', 'delivery_attempt', 'delivery_failed', 'delivery_attempt', 'delivered']);
  });

  test('backoff doubles between attempts', async () => {
    const { body: { task } } = await create('grok');
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      failNext = 1;
      await runOnce(pool, adapters);
      const { rows: [r] } = await pool.query(
        'SELECT extract(epoch FROM next_attempt_at - now())::float AS s FROM task WHERE id = $1', [task.id]);
      gaps.push(Math.round(r.s));
      await expireLease(task.id);
    }
    assert.deepEqual(gaps, [30, 60, 120]);
  });

  test('crash after claim: the lease expires and the same key is redelivered', async () => {
    const { body: { task } } = await create('grok');
    await claim(pool, adapters); // Process dies here, with no ack and no nack.
    assert.equal(await runOnce(pool, adapters), 0, 'still leased');
    await expireLease(task.id);
    assert.equal(await runOnce(pool, adapters), 1);
    assert.equal(delivered[0]!.idempotency_key, task.idempotency_key);
    assert.equal(delivered[0]!.attempts, 2);
  });

  test('a stale ack from an older attempt changes nothing', async () => {
    const { body: { task } } = await create('grok');
    const [stale] = await claim(pool, adapters);
    await expireLease(task.id);
    await claim(pool, adapters);
    await ackDelivered(pool, stale!);
    const { rows: [r] } = await pool.query<Task>('SELECT state FROM task WHERE id = $1', [task.id]);
    assert.equal(r!.state, 'submitted');
  });

  test('complete is idempotent, and differing output after close conflicts', async () => {
    const { body: { task } } = await create('grok');
    await runOnce(pool, adapters);
    const path = `/tasks/${task.id}/complete`;
    assert.equal((await call('instinct', 'POST', path, { output: { a: 1 } })).status, 200);
    assert.equal((await call('instinct', 'POST', path, { output: { a: 1 } })).status, 200);
    assert.equal((await call('instinct', 'POST', path, { output: { a: 2 } })).status, 409);
    assert.equal((await eventTypes(task.id)).filter((t) => t === 'task_completed').length, 1);
  });

  test('a reply that beats the ack is accepted, and the late ack does not reopen it', async () => {
    const { body: { task } } = await create('grok');
    const [claimed] = await claim(pool, adapters);
    assert.equal((await call('instinct', 'POST', `/tasks/${task.id}/complete`, { output: { fast: true } })).status, 200);
    await ackDelivered(pool, claimed!);
    assert.equal((await call('grok', 'GET', `/tasks/${task.id}`)).body.task.state, 'completed');
  });

  test(`gives up after ${MAX_ATTEMPTS} attempts with failed and an alert`, async () => {
    const { body: { task } } = await create('grok');
    failNext = 99;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      assert.equal(await runOnce(pool, adapters), 1);
      await pool.query(`UPDATE task SET next_attempt_at = now() WHERE id = $1 AND state = 'submitted'`, [task.id]);
    }
    assert.equal(await runOnce(pool, adapters), 0);
    assert.equal(delivered.length, MAX_ATTEMPTS);
    assert.equal((await call('grok', 'GET', `/tasks/${task.id}`)).body.task.state, 'failed');
    assert.equal((await eventTypes(task.id)).at(-1), 'alert');
  });

  test('crash during the last attempt still ends failed instead of stuck', async () => {
    const { body: { task } } = await create('grok');
    await pool.query('UPDATE task SET attempts = $2 WHERE id = $1', [task.id, MAX_ATTEMPTS]);
    await runOnce(pool, adapters);
    assert.equal((await call('grok', 'GET', `/tasks/${task.id}`)).body.task.state, 'failed');
    assert.equal(delivered.length, 0);
  });
});

describe('loop guards', () => {
  test(`hop limit: a ping-pong chain stops after ${MAX_HOPS} deliveries, trips the breaker and alerts`, async () => {
    const sides: Agent[] = ['grok', 'instinct'];
    let parent: string | undefined;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const from = sides[hop % 2]!;
      const r = await create(from, { to_agent: sides[(hop + 1) % 2], ...(parent ? { parent_id: parent } : {}) });
      assert.equal(r.status, 201, `hop ${hop} allowed`);
      assert.equal(r.body.task.hop, hop);
      await runOnce(pool, adapters);
      parent = r.body.task.id;
    }
    assert.equal(delivered.length, MAX_HOPS);

    const over = await create('grok', { to_agent: 'instinct', parent_id: parent });
    assert.equal(over.status, 422);
    assert.equal(over.body.task.state, 'rejected');
    assert.deepEqual(over.body.task.output, { rejected: 'hop_limit' });
    await runOnce(pool, adapters);
    assert.equal(delivered.length, MAX_HOPS, 'nothing more delivered');
    assert.deepEqual(await eventTypes(over.body.task.id), ['task_rejected', 'alert']);

    // Whole conversation can be rebuilt with one query (PRD section 10).
    const { rows } = await pool.query(
      `SELECT e.type FROM event e JOIN task t ON t.id = e.task_id WHERE t.root_id = $1 ORDER BY e.id`,
      [delivered[0]!.root_id]);
    assert.equal(rows.filter((r) => r.type === 'delivered').length, MAX_HOPS);
    assert.equal(rows.filter((r) => r.type === 'task_rejected').length, 1);
  });

  test('hop cannot be forged or reset by the client', async () => {
    assert.equal((await create('grok', { hop: 0 })).status, 400);
    assert.equal((await create('grok', { root_id: crypto.randomUUID() })).status, 400);
    const r = await create('grok');
    await runOnce(pool, adapters);
    // Only the task's receiver may delegate from it.
    const stolen = await create('claude', { parent_id: r.body.task.id });
    assert.equal(stolen.status, 422);
    assert.equal(stolen.body.error, 'invalid_parent');
  });

  test(`daily cap: task ${DAILY_PAIR_CAP + 1} is rejected and never delivered, in either direction`, async () => {
    for (let i = 0; i < DAILY_PAIR_CAP; i++) {
      const [from, to]: Agent[] = i % 2 ? ['instinct', 'grok'] : ['grok', 'instinct'];
      assert.equal((await create(from!, { to_agent: to })).status, 201, `task ${i + 1}`);
    }
    while (await runOnce(pool, adapters));
    assert.equal(delivered.length, DAILY_PAIR_CAP);

    const over = await create('grok');
    assert.equal(over.status, 422);
    assert.deepEqual(over.body.task.output, { rejected: 'daily_cap' });
    while (await runOnce(pool, adapters));
    assert.equal(delivered.length, DAILY_PAIR_CAP, 'nothing more delivered');

    assert.equal((await create('grok', { to_agent: 'claude' })).status, 201, 'other pairs unaffected');
  });

  test('daily cap holds under concurrent creates', async () => {
    const all = await Promise.all(Array.from({ length: 40 }, () => create('grok')));
    assert.equal(all.filter((r) => r.status === 201).length, DAILY_PAIR_CAP);
    assert.equal(all.filter((r) => r.status === 422).length, 40 - DAILY_PAIR_CAP);
  });

  test('tasks older than 24 h do not count against the cap', async () => {
    for (let i = 0; i < DAILY_PAIR_CAP; i++) await create('grok');
    await pool.query(`UPDATE task SET created_at = now() - interval '25 hours'`);
    assert.equal((await create('grok')).status, 201);
  });

  test('breaker holds work already queued for the paused pair, and releases when it ends', async () => {
    const queued = await create('grok', { input: { query: 'queued' } });
    await pool.query(
      `INSERT INTO pair_pause VALUES ('grok', 'instinct', now() + interval '1 hour', 'test')`);
    assert.equal(await runOnce(pool, adapters), 0);
    const blocked = await create('instinct', { to_agent: 'grok' });
    assert.deepEqual(blocked.body.task.output, { rejected: 'pair_paused' });

    await pool.query(`UPDATE pair_pause SET paused_until = now() - interval '1 second'`);
    assert.equal(await runOnce(pool, adapters), 1);
    assert.equal(delivered[0]!.id, queued.body.task.id);
  });

  test('duplicate content within an hour is rejected under a new key, and allowed after', async () => {
    const input = { query: 'same' };
    assert.equal((await create('grok', { input })).status, 201);
    const dup = await create('grok', { input });
    assert.equal(dup.status, 422);
    assert.deepEqual(dup.body.task.output, { rejected: 'duplicate_content' });
    await pool.query(`UPDATE task SET created_at = now() - interval '61 minutes'`);
    assert.equal((await create('grok', { input })).status, 201);
  });

  test('unknown intent parks as side_effect and is never delivered; the sender cannot set risk', async () => {
    assert.equal((await create('grok', { risk: 'read' })).status, 400);
    for (const intent of ['send.payment', 'constructor']) {
      const r = await create('grok', { intent });
      assert.equal(r.body.task.risk, 'side_effect');
      assert.equal(r.body.task.state, 'input_required');
    }
    assert.equal(await runOnce(pool, adapters), 0);
    assert.equal(delivered.length, 0);
  });

  test('disabled agent receives nothing', async () => {
    await create('grok');
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'instinct'`);
    assert.equal(await runOnce(pool, adapters), 0);
  });
});

describe('states', () => {
  test('database refuses invalid transitions', async () => {
    const { body: { task } } = await create('grok');
    await pool.query(`UPDATE task SET state = 'completed' WHERE id = $1`, [task.id]);
    for (const next of ['working', 'submitted', 'failed', 'canceled']) {
      await assert.rejects(pool.query(`UPDATE task SET state = $2 WHERE id = $1`, [task.id, next]),
        /invalid task transition/);
    }
  });

  test('events are append-only', async () => {
    const { body: { task } } = await create('grok');
    await assert.rejects(pool.query(`UPDATE event SET type = 'x' WHERE task_id = $1`, [task.id]), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM event WHERE task_id = $1`, [task.id]), /append-only/);
  });

  test('deadline fails open tasks with an alert', async () => {
    const { body: { task } } = await create('grok');
    await pool.query(`UPDATE task SET deadline_at = now() - interval '1 second' WHERE id = $1`, [task.id]);
    assert.equal(await runOnce(pool, adapters), 0);
    const got = (await call('grok', 'GET', `/tasks/${task.id}`)).body.task;
    assert.equal(got.state, 'failed');
    assert.deepEqual(got.output, { error: 'deadline_exceeded' });
    assert.equal((await eventTypes(task.id)).at(-1), 'alert');
  });

  test('default deadline is 24 h', async () => {
    const { body: { task } } = await create('grok');
    const hours = (new Date(task.deadline_at).getTime() - new Date(task.created_at).getTime()) / 3_600_000;
    assert.ok(Math.abs(hours - 24) < 0.01);
  });

  test('cancel: only the sender, and not after close', async () => {
    const { body: { task } } = await create('grok');
    assert.equal((await call('instinct', 'POST', `/tasks/${task.id}/cancel`)).status, 404, 'undelivered: hidden from receiver');
    assert.equal((await call('grok', 'POST', `/tasks/${task.id}/cancel`)).status, 200);
    assert.equal((await call('grok', 'POST', `/tasks/${task.id}/cancel`)).status, 200, 'idempotent');
    assert.equal(await runOnce(pool, adapters), 0, 'canceled work is not delivered');
    assert.equal((await call('instinct', 'POST', `/tasks/${task.id}/complete`, { output: {} })).status, 404);
  });
});

describe('http boundary', () => {
  test('rejects missing and wrong keys', async () => {
    assert.equal((await call(null, 'GET', '/tasks/x')).status, 401);
    const res = await app.request('/tasks', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(res.status, 401);
  });

  test('from_agent comes from the key, not the body', async () => {
    assert.equal((await create('grok', { from_agent: 'instinct' })).status, 400);
    assert.equal((await create('grok')).body.task.from_agent, 'grok');
  });

  test('disabled sender is refused', async () => {
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'grok'`);
    assert.equal((await create('grok')).status, 403);
  });

  test('non-participants see 404 and cannot complete', async () => {
    const { body: { task } } = await create('grok');
    await runOnce(pool, adapters);
    assert.equal((await call('claude', 'GET', `/tasks/${task.id}`)).status, 404);
    assert.equal((await call('claude', 'GET', `/tasks/${task.id}/events`)).status, 404);
    assert.equal((await call('claude', 'POST', `/tasks/${task.id}/complete`, { output: {} })).status, 404);
    assert.equal((await call('grok', 'POST', `/tasks/${task.id}/complete`, { output: {} })).status, 409, 'sender cannot self-complete');
    assert.ok((await call('grok', 'GET', `/tasks/${task.id}/events`)).body.events!.length >= 3);
  });

  test('bad input gets 4xx, never 500', async () => {
    assert.equal((await create('grok', { to_agent: 'ghost' })).status, 422);
    assert.equal((await create('grok', { to_agent: 'grok' })).status, 422);
    assert.equal((await create('grok', { input: 'not-an-object' })).status, 400);
    assert.equal((await create('grok', { input: { query: '\u0000' } })).status, 400);
    assert.equal((await call('grok', 'GET', '/tasks/not-a-uuid')).status, 404);
    const res = await app.request('/tasks', {
      method: 'POST', headers: { authorization: `Bearer ${KEYS.grok}` }, body: '{broken',
    });
    assert.equal(res.status, 400);
  });
});

describe('audit fixes', () => {
  test('low-risk intent with extra fields is side_effect, and never delivered', async () => {
    const r = await create('grok', { input: { query: 'x', action: 'send payment' } });
    assert.equal(r.body.task.risk, 'side_effect');
    assert.equal(r.body.task.state, 'input_required');
    assert.equal(await runOnce(pool, adapters), 0);
  });

  test('receiver cannot read a task, or its events, until it is delivered', async () => {
    const { body: { task } } = await create('grok', { intent: 'send.payment', input: { to: 'x' } });
    assert.equal((await call('instinct', 'GET', `/tasks/${task.id}`)).status, 404);
    assert.equal((await call('instinct', 'GET', `/tasks/${task.id}/events`)).status, 404);
    assert.equal((await call('grok', 'GET', `/tasks/${task.id}`)).status, 200);
  });

  test('omitting parent_id does not reset hops: ping-pong still stops', async () => {
    const sides: Agent[] = ['grok', 'instinct'];
    const hops: number[] = [];
    for (let i = 0; i < MAX_HOPS; i++) {
      const r = await create(sides[i % 2]!, { to_agent: sides[(i + 1) % 2] });
      assert.equal(r.status, 201);
      hops.push(r.body.task.hop);
      await runOnce(pool, adapters);
    }
    assert.deepEqual(hops, [0, 1, 2, 3]);
    const over = await create('grok');
    assert.deepEqual(over.body.task.output, { rejected: 'hop_limit' });
    assert.equal(delivered.length, MAX_HOPS);
    assert.equal(new Set(delivered.map((t) => t.root_id)).size, 1, 'one conversation');
  });

  test('routing through a third agent does not reset hops', async () => {
    const a = await create('grok', { to_agent: 'instinct' });
    await runOnce(pool, adapters);
    const b = await create('instinct', { to_agent: 'claude' });
    assert.equal(b.body.task.hop, 1);
    assert.equal(b.body.task.root_id, a.body.task.root_id);
  });

  test('a task received long ago and already closed starts a new chain', async () => {
    const { body: { task } } = await create('grok');
    await runOnce(pool, adapters);
    await call('instinct', 'POST', `/tasks/${task.id}/complete`, { output: {} });
    await pool.query(`UPDATE task SET created_at = now() - interval '16 minutes'`);
    assert.equal((await create('instinct', { to_agent: 'grok' })).body.task.hop, 0);
  });

  test('a replay without parent_id still matches a task given an implicit parent', async () => {
    await create('grok');
    await runOnce(pool, adapters);
    const payload = newTask({ to_agent: 'grok' });
    const a = await call('instinct', 'POST', '/tasks', payload);
    assert.ok(a.body.task.parent_id);
    assert.equal((await call('instinct', 'POST', '/tasks', payload)).status, 200);
  });

  test('parent must have been delivered; uppercase parent id is the same id', async () => {
    const undelivered = await create('grok');
    assert.equal((await create('instinct', { to_agent: 'grok', parent_id: undelivered.body.task.id })).status, 422);
    await runOnce(pool, adapters);
    const r = await create('instinct', { to_agent: 'grok', parent_id: undelivered.body.task.id.toUpperCase() });
    assert.equal(r.body.task.parent_id, undelivered.body.task.id);
  });

  test('disabling the sender holds its queued work', async () => {
    await create('grok');
    await pool.query(`UPDATE agent SET enabled = false WHERE id = 'grok'`);
    assert.equal(await runOnce(pool, adapters), 0);
  });

  test('adapter errors stay out of the API and in the audit log', async () => {
    const { body: { task } } = await create('grok');
    failNext = 1;
    await runOnce(pool, adapters);
    const { body } = await call('grok', 'GET', `/tasks/${task.id}/events`);
    assert.ok(body.events!.some((e) => e.type === 'delivery_failed'));
    assert.ok(!JSON.stringify(body.events).includes('receiver down'));
    const { rows } = await pool.query(`SELECT payload FROM event WHERE type = 'delivery_failed'`);
    assert.equal(rows[0].payload.error, 'receiver down');
  });

  test('stored rejections are capped per sender', async () => {
    const input = { query: 'same' };
    await create('grok', { input });
    await pool.query(
      `INSERT INTO task (root_id, from_agent, to_agent, intent, input, risk, state, idempotency_key, deadline_at)
       SELECT gen_random_uuid(), 'grok', 'instinct', 'research', '{}', 'read', 'rejected', 'r-' || n, now()
       FROM generate_series(1, 100) n`);
    const before = (await pool.query('SELECT 1 FROM task')).rowCount;
    assert.equal((await create('grok', { input })).status, 429);
    assert.equal((await pool.query('SELECT 1 FROM task')).rowCount, before);
  });

  test('rejected tasks do not count against the daily cap', async () => {
    const input = { query: 'same' };
    await create('grok', { input });
    for (let i = 0; i < DAILY_PAIR_CAP; i++) assert.equal((await create('grok', { input })).status, 422);
    assert.equal((await create('grok')).status, 201);
  });

  test('replaying a rejected task still answers 422', async () => {
    const input = { query: 'same' };
    await create('grok', { input });
    const payload = newTask({ input });
    assert.equal((await call('grok', 'POST', '/tasks', payload)).status, 422);
    assert.equal((await call('grok', 'POST', '/tasks', payload)).status, 422);
  });

  test('same key toward another agent is a conflict', async () => {
    const payload = newTask();
    await call('grok', 'POST', '/tasks', payload);
    assert.equal((await call('grok', 'POST', '/tasks', { ...payload, to_agent: 'claude' })).status, 409);
  });

  test('an adapter ignoring the signal cannot stall the dispatcher', async () => {
    const { body: { task } } = await create('grok');
    const stuck: Adapters = { fake: { deliver: () => new Promise(() => {}) } };
    await runOnce(pool, stuck, 50);
    const { rows: [t] } = await pool.query<Task>('SELECT * FROM task WHERE id = $1', [task.id]);
    assert.equal(t!.state, 'submitted');
    assert.deepEqual((await eventTypes(task.id)).at(-1), 'delivery_failed');
  });

  test('stale nacks change nothing', async () => {
    const { body: { task } } = await create('grok');
    const [stale] = await claim(pool, adapters);
    await expireLease(task.id);
    await claim(pool, adapters);
    const lease = async () => (await pool.query<Task>('SELECT * FROM task WHERE id = $1', [task.id])).rows[0]!;
    const before = await lease();
    await nackDelivery(pool, stale!, 'old');
    assert.deepEqual((await lease()).next_attempt_at, before.next_attempt_at);
    await nackDelivery(pool, { id: task.id, attempts: MAX_ATTEMPTS }, 'old');
    assert.equal((await lease()).state, 'submitted', 'a final nack from another attempt does not fail it');
  });

  test('receiver can fail a delivered task, but not one still undelivered', async () => {
    const { body: { task } } = await create('grok');
    assert.equal((await call('instinct', 'POST', `/tasks/${task.id}/fail`, { output: {} })).status, 404);
    await runOnce(pool, adapters);
    const r = await call('instinct', 'POST', `/tasks/${task.id}/fail`, { output: { why: 'no' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.task.state, 'failed');
  });

  test('oversized body gets 413 only after auth', async () => {
    const body = JSON.stringify({ input: 'x'.repeat(1024 * 1024 + 1) });
    const anon = await app.request('/tasks', { method: 'POST', body, headers: { 'content-length': String(body.length) } });
    assert.equal(anon.status, 401);
    const authed = await app.request('/tasks', {
      method: 'POST', body, headers: { authorization: `Bearer ${KEYS.grok}`, 'content-length': String(body.length) },
    });
    assert.equal(authed.status, 413);
  });

  test('main.ts fails on bad env without printing secrets', () => {
    const boot = (env: Record<string, string>) => spawnSync(process.execPath, ['src/main.ts'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH!, ...env },
    });
    const url = 'postgresql://u:SECRETPW@h.supabase.com:6543/postgres';
    const noTls = boot({ DATABASE_URL: url, BRIDGE_AGENT_KEYS: '{}' });
    assert.notEqual(noTls.status, 0);
    assert.match(noTls.stderr, /sslmode/);
    assert.ok(!noTls.stderr.includes('SECRETPW'));
    const badKeys = boot({ DATABASE_URL: `${url}?sslmode=require`, BRIDGE_AGENT_KEYS: '{"grok":"SECRETKEY' });
    assert.notEqual(badKeys.status, 0);
    assert.ok(!badKeys.stderr.includes('SECRETKEY'));
    assert.ok(!badKeys.stderr.includes('SECRETPW'));
    const badUrl = boot({ DATABASE_URL: 'SECRETPW-not-a-url', BRIDGE_AGENT_KEYS: '{}' });
    assert.notEqual(badUrl.status, 0);
    assert.ok(!badUrl.stderr.includes('SECRETPW'));
  });
});
