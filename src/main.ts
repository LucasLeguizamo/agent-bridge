import { serve } from '@hono/node-server';
import pg from 'pg';
import { z } from 'zod';
import { breakerGate, createGrokAdapter, GROK_ADAPTER, grokConfig, type GrokConfig } from './grok.ts';
import { createApp } from './http.ts';
import { mountMcp } from './mcp.ts';
import { startDispatcher, type Adapters } from './queue.ts';

// Messages name the variable only: parser errors would echo its value, which holds secrets.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? '';
if (!URL.canParse(url)) fail('DATABASE_URL must be a valid connection string');
// pg connects without TLS unless told otherwise, which would send the password in clear text.
if (!/^(require|verify-ca|verify-full)$/.test(new URL(url).searchParams.get('sslmode') ?? '')) {
  fail('DATABASE_URL must set sslmode=require or stricter');
}

let agentKeys: Record<string, string>;
try {
  agentKeys = z.record(z.string(), z.string().min(32)).parse(JSON.parse(process.env.BRIDGE_AGENT_KEYS ?? ''));
} catch {
  fail('BRIDGE_AGENT_KEYS must be a JSON object of agent id to a key of at least 32 characters');
}

const pool = new pg.Pool({
  connectionString: url,
  max: 5, // ponytail: fixed for one small process; raise with the Supabase pool size.
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
pool.on('error', (e) => console.error('idle pg client error', e.message));

let grok: GrokConfig | null = null;
try {
  grok = grokConfig(process.env);
} catch (e) {
  fail((e as Error).message);
}
if (!grok && (process.env.GROK_WEBHOOK_URL || process.env.GROK_WEBHOOK_KEY)) {
  console.warn('Grok adapter not loaded: GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY must both be set');
}

// The email adapter lands in M3. An agent with no adapter keeps its tasks queued, with no attempts burned.
const adapters: Adapters = grok ? { [GROK_ADAPTER]: createGrokAdapter(pool, grok) } : {};
const stop = startDispatcher(pool, breakerGate(pool, adapters));

const app = createApp(pool, agentKeys);
mountMcp(app, pool);
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    stop();
    server.close(() => void pool.end());
  });
}
