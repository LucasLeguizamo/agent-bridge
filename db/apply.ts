// Creates the bridge schema and the bridge_app role in one transaction. Fails without changes if they exist.
// ponytail: one-shot, no migration tracking; add it when M2 brings the second migration.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { ADMIN_DATABASE_URL: url, BRIDGE_DB_PASSWORD: password } = process.env;
if (!url) throw new Error('ADMIN_DATABASE_URL is required');
if (!password || !/^[0-9a-f]{32,}$/.test(password)) throw new Error('BRIDGE_DB_PASSWORD must be 32+ hex characters');

const file = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
    BEGIN;
    CREATE SCHEMA bridge;
    SET LOCAL search_path = bridge;
    CREATE ROLE bridge_app LOGIN PASSWORD '${password}';
    ${file('./001_core.sql')}
    ${file('./bridge_access.sql')}
    COMMIT;`);
  console.log('bridge schema and bridge_app role created');
} finally {
  await client.end();
}
