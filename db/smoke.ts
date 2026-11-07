// Proves the app role can do its real work on the real schema, which /health and a 401 cannot: they touch no grants.
// Run with DATABASE_URL (bridge_app, port 6543). A write, a supersede and a search through the real code, in one
// transaction that always rolls back, so production keeps nothing. Sequence numbers do advance.
import pg from 'pg';
import { connectionConfig } from '../src/db.ts';
import { memorySearch, memoryWrite } from '../src/memory.ts';

const NOT_NESTED = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i;

export async function smokeCheck(client: pg.ClientBase) {
  const tag = `smoke${Date.now()}`;
  // The real code opens its own transactions. Here they all become part of the outer one.
  const query = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && NOT_NESTED.test(args[0])) return Promise.resolve({ rows: [], rowCount: 0 });
    return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  const shared = { query, release() {} };
  const pool = { query, connect: async () => shared } as unknown as pg.Pool;

  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO agent (id, adapter) VALUES ('smoke', 'smoke')`);
    const first = await memoryWrite(pool, 'smoke', { namespace: 'smoke', key: tag, value: `${tag} first` });
    const second = await memoryWrite(pool, 'smoke', { namespace: 'smoke', key: tag, value: `${tag} second` });
    const found = await memorySearch(pool, 'smoke', { query: tag, namespace: 'smoke' });
    await client.query('ROLLBACK');
    const { rows } = await client.query('SELECT 1 FROM fact WHERE key = $1', [tag]);
    return {
      wrote: first.created,
      superseded: second.created && second.fact.id !== first.fact.id,
      found: found.length === 1 && found[0]!.id === second.fact.id,
      rolled_back: rows.length === 0,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client(connectionConfig(url, 'DATABASE_URL', process.env.DATABASE_CA_PEM));
  await client.connect();
  try {
    const result = await smokeCheck(client);
    console.log(JSON.stringify(result));
    if (Object.values(result).includes(false)) process.exitCode = 1;
  } finally {
    await client.end();
  }
}
