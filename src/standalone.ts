// Self-host entry: one long-running Node process (Docker, a VPS). Vercel's entry stays src/index.ts.
// Not named server.ts on purpose: src/server.ts is one of the paths Vercel tries as a Hono entry.
// With DISPATCH_INTERVAL_MS set, it runs the same pass as POST /cron/dispatch on a timer, which replaces pg_cron, pg_net
// and Vault, absent from plain Postgres. Without it, something must still call /cron/dispatch.
import { serve } from '@hono/node-server';
import { createBridge } from './bridge.ts';
import { logError } from './log.ts';

const MIN_INTERVAL_MS = 1_000;

/**
 * Runs `pass` every `intervalMs`, never two at once: a tick that finds the previous pass still running is skipped.
 * A failed pass is logged and the next tick tries again. `stop` waits for a pass in progress.
 */
export function startDispatcher(pass: () => Promise<unknown>, intervalMs: number, onError = (e: unknown) => logError('dispatch loop', e)) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return false;
    running = pass().then(() => {}, onError).finally(() => { running = undefined; });
    return true;
  };
  const timer = setInterval(tick, intervalMs);
  return {
    /** For tests: runs a tick now. False when one was already running. */
    tick,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}

/** DISPATCH_INTERVAL_MS as a number, or undefined when unset. The message names the variable only. */
export function dispatchInterval(raw: string | undefined) {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_MS) throw new Error(`DISPATCH_INTERVAL_MS must be an integer of at least ${MIN_INTERVAL_MS}`);
  return n;
}

if (import.meta.main) {
  // Work started by a request (an immediate dispatch, an alert) is tracked so shutdown can wait for it.
  const inFlight = new Set<Promise<unknown>>();
  const defer = (p: Promise<unknown>) => {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch(() => {});
  };
  let bridge: ReturnType<typeof createBridge>;
  let interval: number | undefined;
  try {
    interval = dispatchInterval(process.env.DISPATCH_INTERVAL_MS);
    bridge = createBridge(process.env, { defer });
  } catch (e) {
    // Fail fast: a restart loop with this line in the log is easier to read than a server that answers 500.
    console.error(`agent-bridge cannot start: ${(e as Error).message}`);
    process.exit(1);
  }
  const dispatcher = interval ? startDispatcher(bridge.pass, interval) : undefined;
  if (!dispatcher) console.warn('DISPATCH_INTERVAL_MS is not set: nothing runs the dispatcher unless POST /cron/dispatch is called');

  const port = Number(process.env.PORT ?? 3000);
  const server = serve({ fetch: bridge.app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, () => {
    console.log(JSON.stringify({ msg: 'listening', port, dispatch_interval_ms: interval ?? null }));
  });

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      if (stopping) return;
      stopping = true;
      console.log(JSON.stringify({ msg: 'shutting down', signal }));
      // A hung connection must not keep the container from stopping: Docker sends SIGKILL after 10 s anyway.
      const force = setTimeout(() => process.exit(1), 8_000);
      force.unref();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispatcher?.stop();
      await Promise.allSettled([...inFlight]);
      await bridge.pool.end();
      process.exit(0);
    });
  }
}
