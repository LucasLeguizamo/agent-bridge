// Creates the bridge schema and the bridge_app role in one transaction. Fails without changes if they exist.
// One-shot, for a new project only. Everything after 001 goes through db/migrate.ts. db/setup.ts does both, re-runnably.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connectionConfig } from '../src/db.ts';

const file = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** The schema, 001 and the app role's grants. Needs bridge_app to exist already, and an open transaction. */
export const coreSql = () => `
    CREATE SCHEMA bridge;
    SET LOCAL search_path = bridge;
    ${file('./001_core.sql')}
    ${file('./bridge_access.sql')}`;

/** Checked so it can go into SQL as a literal: hex only. The message names the variable, never the value. */
export function rolePassword(password: string | undefined) {
  if (!password || !/^[0-9a-f]{32,}$/.test(password)) throw new Error('BRIDGE_DB_PASSWORD must be 32+ hex characters');
  return password;
}

if (import.meta.main) {
  const { ADMIN_DATABASE_URL: url } = process.env;
  if (!url) throw new Error('ADMIN_DATABASE_URL is required');
  const password = rolePassword(process.env.BRIDGE_DB_PASSWORD);
  const client = new pg.Client(connectionConfig(url, 'ADMIN_DATABASE_URL', process.env.DATABASE_CA_PEM));
  await client.connect();
  try {
    await client.query(`BEGIN; CREATE ROLE bridge_app LOGIN PASSWORD '${password}'; ${coreSql()} COMMIT;`);
    console.log('bridge schema and bridge_app role created');
  } finally {
    await client.end();
  }
}
