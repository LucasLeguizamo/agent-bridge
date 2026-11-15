import { logError } from './log.ts';

/** What a receiver gets. `text` names kind, ids, agents and counts only, never a payload. */
export type AlertMessage = { text: string; alert: string; task?: string; ts: string };
export type AlertSink = (a: AlertMessage) => Promise<void>;
/** `key` scopes the dedupe: the agent pair or adapter, so a loop over many tasks still alerts once. */
export type Alert = { alert: string; key: string; text: string; task?: string | null | undefined };

const TIMEOUT_MS = 3000;
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20; // Across all kinds: a burst of distinct alerts cannot flood the receiver either.

/**
 * Null when unset. Only https, or http on localhost, so alerts never cross the network in clear text.
 * The message names the variable only: a Slack or Discord webhook URL is itself a secret.
 */
export function alertWebhook(url: string | undefined): AlertSink | null {
  if (!url) return null;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const loopback = parsed?.hostname === '127.0.0.1' || parsed?.hostname === 'localhost';
  // Credentials in the URL make fetch throw a TypeError that quotes them, which would land in the log on every alert.
  if ((parsed?.protocol !== 'https:' && !(parsed?.protocol === 'http:' && loopback)) || parsed.username || parsed.password) {
    throw new Error('ALERT_WEBHOOK_URL must be a valid https URL without credentials');
  }
  return async (a) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`alert webhook responded ${res.status}`);
  };
}

let sinks: AlertSink[] = [];
let defer: (p: Promise<unknown>) => void = () => {};
// ponytail: in memory, so the dedupe is per instance: on serverless each warm instance sends its own first alert.
// The `event` row stays the record of every alert; this only limits notices. Move it to a table if that spams.
const lastSent = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;

/** Called once at boot. `defer` keeps a serverless instance alive until the POST settles (waitUntil). */
export function configureAlerts(opts: { sinks: AlertSink[]; defer?: (p: Promise<unknown>) => void }) {
  sinks = opts.sinks;
  defer = opts.defer ?? ((p) => void p);
  lastSent.clear();
  sentInWindow = 0;
}

/**
 * Notifies after the alert's `event` row has committed. Fire-and-forget: it never throws, never waits,
 * and a failing receiver only reaches logError.
 */
export function raiseAlert(a: Alert, now = Date.now()) {
  if (!sinks.length) return;
  const id = `${a.alert}|${a.key}`;
  if (now - (lastSent.get(id) ?? -Infinity) < WINDOW_MS) return;
  if (now - windowStart >= WINDOW_MS) { windowStart = now; sentInWindow = 0; }
  if (sentInWindow >= MAX_PER_WINDOW) return;
  sentInWindow++;
  lastSent.set(id, now);
  for (const [k, at] of lastSent) if (now - at >= WINDOW_MS) lastSent.delete(k);

  const msg: AlertMessage = { text: `agent-bridge alert: ${a.text}`, alert: a.alert, ...(a.task ? { task: a.task } : {}), ts: new Date(now).toISOString() };
  defer(Promise.all(sinks.map((send) => send(msg).catch((e: unknown) => logError('alert webhook', e)))));
}
