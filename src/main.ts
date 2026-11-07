import { serve } from '@hono/node-server';
import pg from 'pg';
import { z } from 'zod';
import { createApp } from './http.ts';
import { startDispatcher } from './queue.ts';

const env = z.object({
  DATABASE_URL: z.string().min(1),
  BRIDGE_AGENT_KEYS: z.string().transform((s) => z.record(z.string(), z.string().min(32)).parse(JSON.parse(s))),
  PORT: z.coerce.number().default(3000),
}).parse(process.env);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
pool.on('error', (e) => console.error('idle pg client error', e));

// Adapters land in M3 and M4. Until then tasks stay queued, with no attempts burned.
const stop = startDispatcher(pool, {});
const server = serve({ fetch: createApp(pool, env.BRIDGE_AGENT_KEYS).fetch, port: env.PORT });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    stop();
    server.close(() => void pool.end());
  });
}
