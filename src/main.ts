import { serve } from '@hono/node-server';
import pg from 'pg';
import { z } from 'zod';
import { createApp } from './http.ts';
import { startDispatcher } from './queue.ts';

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

// Adapters land in M3 and M4. Until then tasks stay queued, with no attempts burned.
const stop = startDispatcher(pool, {});
const server = serve({ fetch: createApp(pool, agentKeys).fetch, port: Number(process.env.PORT ?? 3000) });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    stop();
    server.close(() => void pool.end());
  });
}
