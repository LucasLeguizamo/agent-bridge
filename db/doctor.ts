// Tells the operator what is wrong, with the bridge's own environment: run it where the bridge runs.
// Read only: every query is in BEGIN READ ONLY ... ROLLBACK, as the app role. ADMIN_DATABASE_URL, if set, is used only
// to read which migrations are applied (bridge_app cannot read schema_migration). Prints names and counts, never values.
// Exit code 1 if any required check fails.
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { alertWebhook } from '../src/alert.ts';
import { agentKeys } from '../src/bridge.ts';
import { connectionConfig } from '../src/db.ts';
import { EMAIL_ADAPTER, emailConfig } from '../src/email.ts';
import { GROK_ADAPTER, grokConfig } from '../src/grok.ts';
import { MAX_ATTEMPTS } from '../src/queue.ts';
import { dispatchInterval } from '../src/standalone.ts';

type Env = Record<string, string | undefined>;
export type Check = { name: string; status: 'ok' | 'fail' | 'warn' | 'skip'; detail: string; fix?: string };
const MARK = { ok: '✓', fail: '✗', warn: '!', skip: '-' } as const;
// One missed tick of a 60 s dispatcher is normal; three is not.
const OVERDUE = '3 minutes';
const MIN_CRON_SECRET = 32;
const SETUP = 'pnpm bridge:setup (with Docker: docker compose run --rm setup)';
const MIGRATIONS = readdirSync(new URL('.', import.meta.url)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

// Codes and our own words only: a pg message can name the host, and a URL is a secret.
const reason = (e: unknown) => {
  const { code, message } = e as { code?: string; message?: string };
  if (code === '28P01') return 'password rejected';
  if (code === '3D000') return 'database does not exist';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === '42501') return 'permission denied';
  if (code) return `error ${code}`;
  return /timeout/i.test(message ?? '') ? 'timed out' : 'could not connect';
};

async function readOnly<T>(raw: string, name: string, ca: string | undefined, fn: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ ...connectionConfig(raw, name, ca), connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

export async function doctor(env: Env, { fetch: get = fetch } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string, fix?: string) =>
    checks.push({ name, status, detail, ...(fix ? { fix } : {}) });

  // Environment. Each parser throws a message that names the variable only.
  let dbUrl: string | undefined;
  if (!env.DATABASE_URL) add('DATABASE_URL', 'fail', 'not set', 'set it to the bridge_app connection string, with sslmode=require');
  else {
    try {
      connectionConfig(env.DATABASE_URL, 'DATABASE_URL', env.DATABASE_CA_PEM);
      dbUrl = env.DATABASE_URL;
      add('DATABASE_URL', 'ok', 'set and well formed');
    } catch (e) {
      add('DATABASE_URL', 'fail', (e as Error).message, 'fix the connection string; see docs/runbook.md, Database TLS');
    }
  }
  let ids: string[] = [];
  if (!env.BRIDGE_AGENT_KEYS) add('BRIDGE_AGENT_KEYS', 'fail', 'not set', 'set it to {"agent-id": "key of 32+ chars"}; generate keys with openssl rand -hex 32');
  else {
    try {
      ids = Object.keys(agentKeys(env.BRIDGE_AGENT_KEYS)).sort();
      add('BRIDGE_AGENT_KEYS', ids.length ? 'ok' : 'fail', `${ids.length} agent(s): ${ids.join(', ') || 'none'}`,
        ids.length ? undefined : 'add at least one agent id and key');
    } catch (e) {
      add('BRIDGE_AGENT_KEYS', 'fail', (e as Error).message, 'set it to {"agent-id": "key of 32+ chars"}');
    }
  }

  let interval: number | undefined;
  try {
    interval = dispatchInterval(env.DISPATCH_INTERVAL_MS);
  } catch (e) {
    add('dispatcher trigger', 'fail', (e as Error).message, 'use 60000');
  }
  const cron = (env.CRON_SECRET?.length ?? 0) >= MIN_CRON_SECRET;
  if (interval || cron) {
    add('dispatcher trigger', 'ok', [interval && `in-process every ${interval} ms`, cron && 'POST /cron/dispatch accepts CRON_SECRET'].filter(Boolean).join('; '));
  } else if (!checks.some((c) => c.name === 'dispatcher trigger')) {
    // A warning: on Vercel, CRON_SECRET lives there and may be absent here. "dispatcher alive" is what fails.
    add('dispatcher trigger', 'warn', env.CRON_SECRET ? 'CRON_SECRET is shorter than 32 characters' : 'neither DISPATCH_INTERVAL_MS nor CRON_SECRET is set here',
      'self-host: DISPATCH_INTERVAL_MS=60000; Vercel: CRON_SECRET from openssl rand -hex 32, plus db/cron_dispatch.sql');
  }

  // Same rules as createBridge: a malformed adapter setting stops the bridge from starting at all.
  const loaded = ['http'];
  for (const [adapter, load, vars] of [
    [GROK_ADAPTER, grokConfig, 'GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY'],
    [EMAIL_ADAPTER, emailConfig, 'RESEND_API_KEY, RESEND_WEBHOOK_SECRET, EMAIL_DOMAIN, EMAIL_TOKEN_SECRET, INSTINCT_EMAIL, OWNER_EMAIL'],
  ] as const) {
    try {
      if (load(env)) loaded.push(adapter);
    } catch (e) {
      add(`adapter ${adapter}`, 'fail', (e as Error).message, `fix ${vars}; the bridge does not start with this`);
    }
  }
  add('adapters loaded', 'ok', loaded.join(', '));
  try {
    add('alert webhook', alertWebhook(env.ALERT_WEBHOOK_URL) ? 'ok' : 'skip', env.ALERT_WEBHOOK_URL ? 'ALERT_WEBHOOK_URL is valid' : 'ALERT_WEBHOOK_URL is not set: alerts are only rows in event');
  } catch (e) {
    add('alert webhook', 'fail', (e as Error).message, 'fix ALERT_WEBHOOK_URL or unset it; the bridge does not start with this');
  }

  if (!dbUrl) {
    add('database', 'skip', 'needs a valid DATABASE_URL');
  } else {
    try {
      await readOnly(dbUrl, 'DATABASE_URL', env.DATABASE_CA_PEM, async (c) => {
        // `found`: the search_path reaches the bridge's tables, which is what unqualified SQL through a pooler needs.
        const { rows: [who] } = await c.query<{ user: string; path: string; timeout: string; idle: string; found: boolean }>(
          `SELECT current_user AS user, current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout,
                  current_setting('idle_in_transaction_session_timeout') AS idle, to_regclass('agent') IS NOT NULL AS found`);
        add('database', 'ok', `reachable as ${who!.user}`);
        const settings = who!.found && who!.timeout !== '0' && who!.idle !== '0';
        add('role settings', settings ? 'ok' : 'fail',
          `search_path ${who!.path}, statement_timeout ${who!.timeout}, idle_in_transaction_session_timeout ${who!.idle}`,
          settings ? undefined : `run ${SETUP}, which sets them on bridge_app, then restart the bridge`);
        if (!who!.found) return; // Every query below would fail on a missing table.

        const { rows: agents } = await c.query<{ id: string; adapter: string; enabled: boolean }>('SELECT id, adapter, enabled FROM agent ORDER BY id');
        const byId = new Map(agents.map((a) => [a.id, a]));
        const missing = ids.filter((id) => !byId.has(id));
        add('agents registered', missing.length ? 'fail' : 'ok',
          missing.length ? `no row for ${missing.join(', ')}: their requests get 403` : `${ids.length} of ${ids.length}`,
          missing.length ? `run ${SETUP}` : undefined);
        for (const a of agents.filter((r) => ids.includes(r.id))) {
          if (!a.enabled) add(`agent ${a.id}`, 'warn', 'disabled by the kill switch', `UPDATE bridge.agent SET enabled = true WHERE id = '${a.id}'`);
          else if (!loaded.includes(a.adapter)) {
            add(`agent ${a.id}`, 'warn', `adapter ${a.adapter} is not loaded: its tasks wait without spending attempts`,
              a.adapter === GROK_ADAPTER ? 'set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY' : a.adapter === EMAIL_ADAPTER ? 'set the email variables, see docs/email.md' : 'set adapter to grok, email or http');
          }
        }

        // The bridge records no heartbeat. A pass that runs leaves nothing due for long, so overdue work means none runs.
        const { rows: [due] } = await c.query<{ sends: number; deadlines: number; last: Date | null }>(
          `SELECT
             (SELECT count(*)::int FROM task t JOIN agent a ON a.id = t.to_agent JOIN agent s ON s.id = t.from_agent
              WHERE t.state = 'submitted' AND t.next_attempt_at < now() - $1::interval AND t.attempts < $2
                AND a.enabled AND s.enabled AND a.adapter = ANY($3)
                AND NOT EXISTS (SELECT 1 FROM pair_pause p WHERE p.agent_a = LEAST(t.from_agent, t.to_agent)
                                AND p.agent_b = GREATEST(t.from_agent, t.to_agent) AND p.paused_until > now())
                AND NOT EXISTS (SELECT 1 FROM adapter_pause ap WHERE ap.adapter = a.adapter AND ap.paused_until > now())
                AND (t.risk <> 'side_effect' OR EXISTS (SELECT 1 FROM approval ap WHERE ap.task_id = t.id
                                                        AND ap.decision = 'approved' AND ap.expires_at > now()))) AS sends,
             (SELECT count(*)::int FROM task WHERE state IN ('submitted', 'working', 'input_required')
                AND deadline_at < now() - $1::interval) AS deadlines,
             (SELECT max(created_at) FROM event WHERE type = 'delivery_attempt') AS last`,
          [OVERDUE, MAX_ATTEMPTS, loaded]);
        const last = due!.last ? `; last delivery attempt ${Math.round((Date.now() - due!.last.getTime()) / 60_000)} min ago` : '';
        if (due!.sends || due!.deadlines) {
          add('dispatcher alive', 'fail', `${due!.sends} send(s) and ${due!.deadlines} deadline(s) overdue by more than ${OVERDUE}${last}`,
            'self-host: check the bridge container is up with DISPATCH_INTERVAL_MS; Vercel: check the bridge-dispatch cron and CRON_SECRET');
        } else {
          add('dispatcher alive', 'ok', `nothing overdue by more than ${OVERDUE}${last}`);
        }

        const { rows: alerts } = await c.query<{ alert: string; n: number }>(
          `SELECT payload->>'alert' AS alert, count(*)::int AS n FROM event
           WHERE type = 'alert' AND created_at > now() - interval '1 day' GROUP BY 1 ORDER BY 1`);
        add('alerts, last day', alerts.length ? 'warn' : 'ok', alerts.length ? alerts.map((a) => `${a.alert} ${a.n}`).join(', ') : 'none',
          alerts.length ? 'read them with the queries in docs/runbook.md, Reading alerts' : undefined);
      });
    } catch (e) {
      add('database', 'fail', reason(e), `check DATABASE_URL, that the database is up, and that ${SETUP} ran`);
    }
  }

  if (!env.ADMIN_DATABASE_URL) {
    add('migrations', 'skip', 'set ADMIN_DATABASE_URL to check them: bridge_app cannot read schema_migration');
  } else {
    try {
      const applied = await readOnly(env.ADMIN_DATABASE_URL, 'ADMIN_DATABASE_URL', env.DATABASE_CA_PEM, async (c) => {
        const { rows: [t] } = await c.query(`SELECT to_regclass('bridge.schema_migration') AS oid`);
        if (!t.oid) return null;
        return (await c.query<{ name: string }>('SELECT name FROM bridge.schema_migration')).rows.map((r) => r.name);
      });
      const pending = MIGRATIONS.filter((m) => !applied?.includes(m));
      add('migrations', pending.length ? 'fail' : 'ok', pending.length ? `pending: ${pending.join(', ')}` : `${MIGRATIONS.length} applied`,
        pending.length ? `back up first, then run ${SETUP}` : undefined);
    } catch (e) {
      add('migrations', 'fail', `admin connection: ${reason(e)}`, 'check ADMIN_DATABASE_URL');
    }
  }

  // Supabase only: the schema must be outside the Data API. PostgREST answers PGRST106 for a schema it does not serve.
  const supabaseDb = dbUrl && /\.supabase\.(co|com)$/.test(new URL(dbUrl).hostname);
  if (env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY) {
    try {
      const res = await get(new URL('/rest/v1/agent', env.SUPABASE_URL), {
        headers: { 'accept-profile': 'bridge', apikey: env.SUPABASE_PUBLISHABLE_KEY }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => undefined) as { code?: string } | undefined;
      const hidden = body?.code === 'PGRST106';
      add('Data API exposure', hidden ? 'ok' : 'fail', hidden ? 'bridge is not an exposed schema (PGRST106)' : `bridge answered HTTP ${res.status} without PGRST106`,
        hidden ? undefined : 'remove bridge from Settings > Data API > Exposed schemas now');
    } catch {
      add('Data API exposure', 'fail', 'could not ask the Data API', 'check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
    }
  } else if (supabaseDb) {
    add('Data API exposure', 'skip', 'set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to check that bridge is not exposed');
  }
  return checks;
}

export const failed = (checks: Check[]) => checks.some((c) => c.status === 'fail');
export const format = (c: Check) => `${MARK[c.status]} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`;

if (import.meta.main) {
  const checks = await doctor(process.env);
  for (const c of checks) console.log(format(c));
  process.exitCode = failed(checks) ? 1 : 0;
}
