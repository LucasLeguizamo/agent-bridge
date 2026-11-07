import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Every run gets its own schema in Supabase and drops it afterwards, so tests cannot reach real tables,
 * even though they TRUNCATE. It needs a session-mode or direct URL: a transaction pooler cannot pin search_path.
 * ponytail: a crashed run leaves its test_* schema behind; drop those by hand.
 */
export async function openTestSchema() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL is required (Supabase session pooler or direct connection)');
  const url = new URL(raw);
  if (!/\.supabase\.(co|com)$/.test(url.hostname)) throw new Error('TEST_DATABASE_URL must point to Supabase');
  if (!url.searchParams.get('sslmode')) throw new Error('TEST_DATABASE_URL must set sslmode');

  const schema = `test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString: raw });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);

  url.searchParams.set('options', `-c search_path=${schema}`);
  const scoped = url.toString();
  const drop = async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };

  // Checked before any test runs: without it, TRUNCATE would hit whatever schema the connection defaults to.
  const probe = new pg.Client({ connectionString: scoped });
  try {
    await probe.connect();
    const { rows: [r] } = await probe.query<{ s: string }>('SELECT current_schema() AS s');
    if (r!.s !== schema) throw new Error('search_path not applied; use a session pooler or direct URL');
    const dbDir = new URL('../db/', import.meta.url);
    for (const file of readdirSync(dbDir).filter((f) => /^0.*\.sql$/.test(f)).sort()) {
      await probe.query(readFileSync(new URL(file, dbDir), 'utf8'));
    }
  } catch (e) {
    await drop();
    throw e;
  } finally {
    await probe.end();
  }
  return { url: scoped, stop: drop };
}
