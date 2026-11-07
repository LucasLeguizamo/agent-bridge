// Applies pending db/NNN_*.sql files to the bridge schema, each in one transaction, and records them.
// Run with ADMIN_DATABASE_URL. db/apply.ts still creates the schema and role on a new project; run this after it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DB_DIR = fileURLToPath(new URL('.', import.meta.url));
const LOCK_ID = 7240301; // Arbitrary, only has to be stable: serializes concurrent runners.

// 001 reached the live schema through db/apply.ts, before this table existed.
const BASELINE = '001_core.sql';
const BASELINE_TABLES = ['agent', 'task', 'event', 'fact', 'approval', 'pair_pause'];

// A statement like these would end the transaction early and break all-or-nothing.
const TX_CONTROL = /^\s*(BEGIN\s*;|START\s+TRANSACTION|COMMIT\b|ROLLBACK\b)/im;

export async function migrate(client: pg.ClientBase, schema = 'bridge', dir = DB_DIR) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid schema name');

  // SET LOCAL and the xact lock end with the transaction, so this also works through a pooler.
  const tx = async <T>(fn: () => Promise<T>) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await client.query(`SET LOCAL search_path = ${schema}`);
      await client.query(`SET LOCAL lock_timeout = '10s'`); // Fail rather than queue the dispatcher behind us.
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  };

  const { rows: [found] } = await client.query('SELECT to_regnamespace($1) AS oid', [schema]);
  if (!found.oid) throw new Error(`schema ${schema} does not exist; run db/apply.ts first`);

  const baselined = await tx(async () => {
    const { rows: [t] } = await client.query(`SELECT to_regclass('schema_migration') AS oid`);
    if (t.oid) return false;
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2)',
      [schema, BASELINE_TABLES],
    );
    const n = rows[0]!.n;
    if (n !== 0 && n !== BASELINE_TABLES.length) {
      throw new Error(`schema ${schema} has ${n} of ${BASELINE_TABLES.length} tables from ${BASELINE}; fix it by hand`);
    }
    await client.query(`CREATE TABLE schema_migration (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    if (n === 0) return false;
    await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [BASELINE]);
    return true;
  });

  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join(dir, name), 'utf8');
    if (TX_CONTROL.test(sql)) throw new Error(`${name} controls its own transaction; remove that statement`);
    await tx(async () => {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migration WHERE name = $1', [name]);
      if (rowCount) return;
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [name]);
      applied.push(name);
    });
  }
  return { baselined, applied };
}

if (import.meta.main) {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { baselined, applied } = await migrate(client);
    if (baselined) console.log(`recorded ${BASELINE} as already applied`);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
  } finally {
    await client.end();
  }
}
