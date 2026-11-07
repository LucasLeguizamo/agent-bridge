import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import pg from 'pg';
import { z } from 'zod';
import { connectionConfig } from './db.ts';
import { createEmailAdapter, createResendProvider, EMAIL_ADAPTER, EMAIL_ENV, emailConfig, emailRoutes, sendDelegationResults } from './email.ts';
import { breakerGate, createGrokAdapter, GROK_ADAPTER, grokConfig } from './grok.ts';
import { createApp, dispatchSoon } from './http.ts';
import { logError } from './log.ts';
import { mountMcp } from './mcp.ts';
import { runPass, type Adapters } from './queue.ts';

type Env = Record<string, string | undefined>;

function agentKeys(raw: string | undefined) {
  try {
    return z.record(z.string(), z.string().min(32)).parse(JSON.parse(raw ?? ''));
  } catch {
    // Names the variable only: parser errors would echo its value.
    throw new Error('BRIDGE_AGENT_KEYS must be a JSON object of agent id to a key of at least 32 characters');
  }
}

/**
 * Builds the whole service from the environment. Opens no connection until a request needs one.
 * Timeouts: `query_timeout` is the client's backstop, because it does not stop the query on the server. What stops it
 * is the role-level statement_timeout in the runbook, which is set lower: a pg `statement_timeout` option is a startup
 * parameter, and those do not reach the backend through the transaction pooler. A pg_advisory_xact_lock wait counts too.
 */
export function createBridge(env: Env, { defer = waitUntil as (p: Promise<unknown>) => void } = {}) {
  const config = connectionConfig(env.DATABASE_URL ?? '', 'DATABASE_URL', env.DATABASE_CA_PEM);
  const keys = agentKeys(env.BRIDGE_AGENT_KEYS);
  const grok = grokConfig(env);
  if (!grok && (env.GROK_WEBHOOK_URL || env.GROK_WEBHOOK_KEY)) {
    console.warn('Grok adapter not loaded: GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY must both be set');
  }
  const email = emailConfig(env);
  if (!email && EMAIL_ENV.some((name) => env[name])) {
    console.warn(`Email adapter not loaded: ${EMAIL_ENV.join(', ')} must all be set`);
  }
  if (!env.DATABASE_CA_PEM) console.warn('DATABASE_URL uses sslmode=require: encrypted, but the server is not verified');

  const pool = new pg.Pool({
    ...config,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000, // attachDatabasePool bills an instance until this ends, on every cron tick: see the runbook.
    query_timeout: 15_000,
    allowExitOnIdle: true,
  });
  pool.on('error', (e) => console.error('idle pg client error', e.message));
  attachDatabasePool(pool); // Keeps the instance alive until idle clients close, so none freezes holding a socket.

  // An agent with no adapter keeps its tasks queued, with no attempts burned.
  // ponytail: `http` is pull-only. Offering a task just makes it listable in /tasks/pending; the agent polls and claims.
  // Push to a URL in agent.config when an agent cannot poll.
  const adapters: Adapters = { http: { deliver: async () => {} } };
  if (grok) adapters[GROK_ADAPTER] = createGrokAdapter(pool, grok);
  const mail = email && { config: email, provider: createResendProvider(email) };
  if (mail) adapters[EMAIL_ADAPTER] = createEmailAdapter(pool, mail.config, mail.provider);
  const gate = breakerGate(pool, adapters);
  const pass = async () => {
    const claimed = await runPass(pool, gate);
    // Its own failure must not fail the pass: those tasks are already delivered, and results retry on the next one.
    if (mail) await sendDelegationResults(pool, mail.config, mail.provider).catch((e: unknown) => logError('email results', e));
    return claimed;
  };
  const options = { cronSecret: env.CRON_SECRET, pass, defer };

  const app = createApp(pool, keys, options);
  const dispatch = dispatchSoon(options);
  mountMcp(app, pool, dispatch);
  if (!mail) return { app, pool };
  // In front of the bearer middleware: the webhook authenticates with the provider's signature.
  const root = new Hono();
  root.route('/', emailRoutes(pool, mail.config, mail.provider, () => dispatch()));
  root.route('/', app);
  return { app: root, pool };
}
