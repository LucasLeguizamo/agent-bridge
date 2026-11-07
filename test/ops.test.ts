import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../db/migrate.ts';
import { createApp } from '../src/http.ts';

const DB_DIR = fileURLToPath(new URL('../db/', import.meta.url));

function testUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL is required');
  if (!/\.supabase\.(co|com)$/.test(new URL(raw).hostname)) throw new Error('TEST_DATABASE_URL must point to Supabase');
  return raw;
}

describe('GET /health', () => {
  const keys = { grok: 'g'.repeat(32) };

  test('answers 200 without a key when the database responds, and the rest stays behind auth', async () => {
    const pool = new pg.Pool({ connectionString: testUrl(), max: 1 });
    try {
      const app = createApp(pool, keys);
      const res = await app.request('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
      assert.equal((await app.request('/tasks/x')).status, 401);
    } finally {
      await pool.end();
    }
  });

  test('answers 503 without details when the query fails', async () => {
    const secret = 'postgres://user:hunter2@db.internal:6543/postgres';
    const pool = { query: async () => { throw new Error(`connect failed: ${secret}`); } } as unknown as pg.Pool;
    const res = await createApp(pool, keys).request('/health');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'unavailable' });
  });
});

describe('migrate', () => {
  let schema: string;
  let client: pg.Client;
  let dir: string;

  const fixture = (name: string, sql: string) => writeFileSync(join(dir, name), sql);
  const tracked = async () =>
    (await client.query(`SELECT name FROM ${schema}.schema_migration ORDER BY name`)).rows.map((r) => r.name as string);
  const exists = async (table: string) =>
    (await client.query('SELECT to_regclass($1) AS t', [table])).rows[0].t !== null;

  // Only 001, loaded without tracking: the exact state of the live schema. The client keeps no search_path
  // of its own, so only migrate() can put files in the right schema.
  beforeEach(async () => {
    schema = `test_${randomBytes(8).toString('hex')}`;
    client = new pg.Client({ connectionString: testUrl() });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`BEGIN; SET LOCAL search_path = ${schema}; ${readFileSync(join(DB_DIR, '001_core.sql'), 'utf8')}; COMMIT;`);
    dir = mkdtempSync(join(tmpdir(), 'migrate-'));
    copyFileSync(join(DB_DIR, '001_core.sql'), join(dir, '001_core.sql'));
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  test('on a pre-tracking schema, records 001 without running it and applies only what is pending', async () => {
    fixture('002_x.sql', 'CREATE TABLE only_once (id int);');
    // Running 001 again would fail: its tables exist.
    assert.deepEqual(await migrate(client, schema, dir), { baselined: true, applied: ['002_x.sql'] });
    assert.deepEqual(await tracked(), ['001_core.sql', '002_x.sql']);
    assert.ok(await exists(`${schema}.only_once`));
    assert.equal(await exists('public.only_once'), false);
  });

  test('a second run changes nothing', async () => {
    fixture('002_x.sql', 'CREATE TABLE only_once (id int);');
    await migrate(client, schema, dir);
    assert.deepEqual(await migrate(client, schema, dir), { baselined: false, applied: [] });
  });

  test('a failing file rolls back whole, stays pending and stops later files', async () => {
    fixture('002_ok.sql', 'CREATE TABLE ok (id int);');
    fixture('003_bad.sql', 'CREATE TABLE half (id int);\nSELECT 1/0;');
    fixture('004_later.sql', 'CREATE TABLE later (id int);');
    await assert.rejects(migrate(client, schema, dir), /division by zero/);
    assert.deepEqual(await tracked(), ['001_core.sql', '002_ok.sql']);
    assert.ok(await exists(`${schema}.ok`));
    assert.equal(await exists(`${schema}.half`), false);
    assert.equal(await exists(`${schema}.later`), false);

    fixture('003_bad.sql', 'CREATE TABLE half (id int);');
    assert.deepEqual((await migrate(client, schema, dir)).applied, ['003_bad.sql', '004_later.sql']);
  });

  test('two runners at once apply each file once', async () => {
    fixture('002_x.sql', 'CREATE TABLE only_once (id int);');
    const other = new pg.Client({ connectionString: testUrl() });
    await other.connect();
    try {
      const results = await Promise.all([migrate(client, schema, dir), migrate(other, schema, dir)]);
      assert.deepEqual(results.flatMap((r) => r.applied), ['002_x.sql']);
      assert.equal(results.filter((r) => r.baselined).length, 1);
    } finally {
      await other.end();
    }
  });

  test('refuses a file that ends its own transaction, and allows a plpgsql BEGIN', async () => {
    fixture('002_fn.sql', 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND $$;');
    fixture('003_tx.sql', 'CREATE TABLE t (id int);\nCOMMIT;');
    await assert.rejects(migrate(client, schema, dir), /controls its own transaction/);
    assert.deepEqual(await tracked(), ['001_core.sql', '002_fn.sql']);
    assert.equal(await exists(`${schema}.t`), false);
  });

  test('refuses a schema holding only part of 001, and a missing schema', async () => {
    await client.query(`DROP TABLE ${schema}.pair_pause`);
    await assert.rejects(migrate(client, schema, dir), /has 5 of 6 tables/);
    assert.equal(await exists(`${schema}.schema_migration`), false);
    await assert.rejects(migrate(client, `${schema}_missing`, dir), /does not exist/);
  });

  test('the real db/ files apply on the pre-tracking schema', async () => {
    const files = readdirSync(DB_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f));
    // Files must stay schema-relative: a hardcoded name would make this test write to the live schema.
    for (const f of files) {
      assert.doesNotMatch(readFileSync(join(DB_DIR, f), 'utf8'), /\bbridge\.\w|SCHEMA\s+bridge\b/i, f);
    }
    await migrate(client, schema, DB_DIR);
    assert.deepEqual(await tracked(), files.sort());
  });
});
