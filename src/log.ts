import { isKnownIntent, type Task } from './tasks.ts';

// A pg error carries `detail`, `where` and `internalQuery`, which can quote stored values. Only code and message get out.
export function logError(where: string, e: unknown) {
  const { code, message } = e as { code?: unknown; message?: unknown };
  console.error(JSON.stringify({ where, code, message: String(message ?? e).slice(0, 500) }));
}

type Transition = Pick<Task, 'id' | 'intent' | 'from_agent' | 'to_agent' | 'state' | 'attempts'> & { created_at: Date | string };

/**
 * One stdout line per task state transition. Built field by field from an allowlist, so input, output and memory can
 * never ride along. An intent outside the policy is the sender's free text, so it shows as `other`. `reason` only takes
 * a bridge code (`daily_cap`, `deadline_exceeded`), never an error message. `ms` is since the task was created.
 */
export function logTransition(event: string, t: Transition, reason?: string | null) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    task: t.id,
    intent: isKnownIntent(t.intent) ? t.intent : 'other',
    from: t.from_agent,
    to: t.to_agent,
    state: t.state,
    attempt: t.attempts,
    ms: Math.max(0, Date.now() - new Date(t.created_at).getTime()),
    ...code(reason),
  }));
}

/** The same line for a change that is not one task's: a breaker on an adapter. Counts and codes only. */
export function logBridgeEvent(event: string, f: { adapter: string; tasks: number; reason: string }) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, adapter: f.adapter, tasks: f.tasks, ...code(f.reason) }));
}

const code = (reason: string | null | undefined) => (reason && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {});
