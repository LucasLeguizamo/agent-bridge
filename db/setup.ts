// Brings a database to what the bridge needs, and can be re-run at any time: each step checks before it changes.
// Role, schema (db/apply.ts's SQL), migrations (db/migrate.ts), role timeouts and agent rows. Run with ADMIN_DATABASE_URL.
// Prints one line per step and never a value: names of variables, agents and adapters only.
// On a live Supabase project this applies migrations, which needs a backup and the owner's approval first (runbook).
import pg from 'pg';
import { agentKeys } from '../src/bridge.ts';
import { connectionConfig } from '../src/db.ts';
import { coreSql, rolePassword } from './apply.ts';
import { migrate } from './migrate.ts';

type Env = Record<string, string | undefined>;
export type Step = { step: string; status: 'done' | 'already done' | 'skipped'; why: string };

export const ADAPTERS = ['grok', 'email', 'http'] as const;
const ROLE = 'bridge_app';
const SCHEMA = 'bridge';
// The runbook's values. A per-connection setting would not pass through a transaction-mode pooler; a role-level one does.
export const ROLE_SETTINGS = { search_path: SCHEMA, statement_timeout: '10s', idle_in_transaction_session_timeout: '15s' };

/** Adapter per agent id: BRIDGE_AGENT_ADAPTERS wins, else grok -> grok, instinct -> email, anything else -> http. */
export function agentAdapters(ids: string[], raw?: string) {
  let given: Record<string, unknown> = {};
  if (raw) {
    try {
      given = JSON.parse(raw);
    } catch {
      throw new Error('BRIDGE_AGENT_ADAPTERS must be a JSON object of agent id to grok, email or http');
    }
    if (given === null || typeof given !== 'object' || Array.isArray(given)) {
      throw new Error('BRIDGE_AGENT_ADAPTERS must be a JSON object of agent id to grok, email or http');
    }
  }
  for (const [id, adapter] of Object.entries(given)) {
    if (!ADAPTERS.includes(adapter as never)) throw new Error(`BRIDGE_AGENT_ADAPTERS: ${id} must map to grok, email or http`);
    if (!ids.includes(id)) throw new Error(`BRIDGE_AGENT_ADAPTERS: ${id} has no key in BRIDGE_AGENT_KEYS`);
  }
  const inferred = (id: string) => (id === 'grok' ? 'grok' : id === 'instinct' ? 'email' : 'http');
  return Object.fromEntries(ids.map((id) => [id, (given[id] as string | undefined) ?? inferred(id)]));
}

export async function setup(client: pg.ClientBase, env: Env): Promise<Step[]> {
  // Read before anything changes, so a bad variable leaves the database as it was.
  const adapters = agentAdapters(Object.keys(agentKeys(env.BRIDGE_AGENT_KEYS)), env.BRIDGE_AGENT_ADAPTERS);
  const steps: Step[] = [];
  const add = (step: string, status: Step['status'], why: string) => steps.push({ step, status, why });

  const { rows: [role] } = await client.query<{ login: boolean }>('SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (role) {
    add(`role ${ROLE}`, 'already done', role.login ? 'exists; its password is left as it is' : 'exists but cannot log in: run ALTER ROLE bridge_app LOGIN');
  } else {
    const password = rolePassword(env.BRIDGE_DB_PASSWORD);
    await client.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}'`);
    add(`role ${ROLE}`, 'done', 'created with BRIDGE_DB_PASSWORD');
  }

  const { rows: [schema] } = await client.query('SELECT to_regnamespace($1) AS oid', [SCHEMA]);
  if (schema.oid) {
    add(`schema ${SCHEMA}`, 'already done', 'exists; db/apply.ts is not run again');
  } else {
    await client.query('BEGIN');
    try {
      await client.query(coreSql());
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    add(`schema ${SCHEMA}`, 'done', 'created with 001_core.sql and its grants');
  }

  const { baselined, applied } = await migrate(client, SCHEMA);
  if (applied.length) add('migrations', 'done', `applied ${applied.join(', ')}${baselined ? '; 001 recorded as applied' : ''}`);
  else add('migrations', 'already done', baselined ? '001 recorded as applied; nothing else pending' : 'nothing pending');

  // Only settings made for every database (setdatabase = 0), which is what ALTER ROLE ... SET writes.
  const { rows: [current] } = await client.query<{ config: string[] | null }>(
    `SELECT s.setconfig AS config FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
     WHERE r.rolname = $1 AND s.setdatabase = 0`, [ROLE]);
  const have = new Map((current?.config ?? []).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  // Absent settings are set. One set to another value was chosen by someone: reported, not overwritten.
  const missing = Object.entries(ROLE_SETTINGS).filter(([k]) => !have.has(k));
  const other = Object.entries(ROLE_SETTINGS).filter(([k, v]) => have.has(k) && have.get(k) !== v);
  for (const [name, value] of missing) await client.query(`ALTER ROLE ${ROLE} SET ${name} = '${value}'`);
  const notes = other.map(([k, v]) => `${k} is ${have.get(k)}, not ${v}: left unchanged`);
  if (missing.length) add('role settings', 'done', [`set ${missing.map(([k]) => k).join(', ')}`, ...notes].join('; '));
  else add('role settings', 'already done', notes.length ? notes.join('; ') : Object.keys(ROLE_SETTINGS).join(', '));

  // ON CONFLICT DO NOTHING: a row someone set by hand is the owner's decision, so it is reported, not changed.
  for (const [id, adapter] of Object.entries(adapters)) {
    const { rowCount } = await client.query(
      `INSERT INTO ${SCHEMA}.agent (id, adapter) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, adapter]);
    if (rowCount) {
      add(`agent ${id}`, 'done', `registered with adapter ${adapter}`);
      continue;
    }
    const { rows: [row] } = await client.query<{ adapter: string; enabled: boolean }>(
      `SELECT adapter, enabled FROM ${SCHEMA}.agent WHERE id = $1`, [id]);
    const notes = [row!.adapter === adapter ? `adapter ${adapter}` : `adapter ${row!.adapter}, not ${adapter}: left unchanged, fix it by hand if wrong`];
    if (!row!.enabled) notes.push('disabled by the kill switch');
    add(`agent ${id}`, 'already done', notes.join('; '));
  }
  return steps;
}

if (import.meta.main) {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    console.error('setup: ADMIN_DATABASE_URL is required (an admin connection, never the transaction pooler)');
    process.exit(1);
  }
  const client = new pg.Client(connectionConfig(url, 'ADMIN_DATABASE_URL', process.env.DATABASE_CA_PEM));
  try {
    await client.connect();
    for (const s of await setup(client, process.env)) console.log(`${s.step}: ${s.status} (${s.why})`);
  } catch (e) {
    // pg messages can name hosts and users, never the password; still, keep to its code and our own text.
    const err = e as { code?: string; message?: string };
    console.error(`setup failed: ${err.code ? `postgres error ${err.code}: ` : ''}${err.message ?? 'unknown error'}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
