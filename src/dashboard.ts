// Owner-only view of conversations: every task sharing a root_id, with its events. Read-only, one query per page.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DATA_LABEL } from './memory.ts';
import { isKnownIntent } from './tasks.ts';
import { stripHiddenDeep } from './secrets.ts';

export const MIN_DASHBOARD_TOKEN = 32;
const sha = (s: string) => createHash('sha256').update(s).digest();

export const ConversationsQuery = z.strictObject({
  limit: z.coerce.number<number>().int().min(1).max(100).default(20),
  // The cursor is next_before from the previous page, which keeps Postgres' microseconds.
  before: z.iso.datetime({ offset: true }).optional(),
  redact: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});
export type ConversationsOptions = {
  limit: number; before?: string | undefined; redact: boolean; truncate?: boolean;
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type DashboardEvent = { type: string; actor: string; created_at: string };
type DashboardTask = {
  id: string; parent_id: string | null; hop: number; from_agent: string; to_agent: string;
  intent: string | null; risk: string; state: string; created_at: string; finished_at: string | null;
  /** Past the cap, the first characters of the JSON text, as a string, and `truncated` is true. */
  input: Json; output: Json; input_bytes: number; output_bytes: number | null; truncated: boolean;
  events: DashboardEvent[];
};
export type Conversation = { root_id: string; started_at: string; last_at: string; tasks: DashboardTask[] };

/** Characters of input and output JSON text a page carries per task. The export passes `truncate: false`. */
export const INPUT_CAP = 2000;
export const OUTPUT_CAP = 4000;

/** What the bridge itself writes to output.rejected (tasks.ts guards) and output.error (queue.ts, email.ts). */
export const BRIDGE_OUTPUT_CODES = new Set([
  'pair_paused', 'hop_limit', 'daily_cap', 'duplicate_content', 'fanout_limit',
  'delivery_exhausted', 'deadline_exceeded', 'secret_blocked',
]);
const OUTPUT_KEYS = ['rejected', 'error'];

function redactOutput(output: Json): Json {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const kept = OUTPUT_KEYS.flatMap((k) => {
    const v = output[k];
    return typeof v === 'string' && BRIDGE_OUTPUT_CODES.has(v) ? [[k, v] as const] : [];
  });
  return kept.length ? Object.fromEntries(kept) : null;
}

/**
 * Keeps only what the bridge wrote: intents it has a policy for, its own output codes and event types (agents can
 * only write agent.*). Ids become c1, t1... in order of appearance, the same within one call, parent links kept.
 * Timestamps, agent ids, hops and states stay.
 */
export function redactConversations(conversations: Conversation[]): Conversation[] {
  const ids = { c: new Map<string, string>(), t: new Map<string, string>() };
  const alias = (kind: 'c' | 't', id: string) =>
    ids[kind].get(id) ?? ids[kind].set(id, `${kind}${ids[kind].size + 1}`).get(id)!;
  return conversations.map((c) => ({
    ...c,
    root_id: alias('c', c.root_id),
    tasks: c.tasks.map((t) => ({
      ...t,
      id: alias('t', t.id),
      parent_id: t.parent_id && alias('t', t.parent_id),
      intent: t.intent && (isKnownIntent(t.intent) ? t.intent : 'other'),
      input: null,
      output: redactOutput(t.output),
      events: t.events.map((e) => ({ ...e, type: e.type.startsWith('agent.') ? 'redacted' : e.type })),
    })),
  }));
}

// The event that ended the task, written in the same transaction as the state change. Agent events are prefixed
// agent., so none can pass for one of these.
const FINISH_EVENT = `(e.type IN ('task_completed', 'task_failed', 'task_canceled', 'task_rejected')
  OR (e.type = 'alert' AND e.payload->>'alert' IN ('delivery_exhausted', 'deadline_exceeded', 'secret_blocked')))`;

// A payload past the cap comes back as a JSON string of its first characters.
const capped = (col: string, cap: string) =>
  `CASE WHEN ${cap}::int IS NULL OR length(${col}::text) <= ${cap}::int THEN ${col}
     ELSE to_jsonb(left(${col}::text, ${cap}::int)) END`;

/**
 * Newest activity first. Times are Postgres' ISO text, microseconds kept, so next_before is an exact cursor.
 * Limit: ties on the same microsecond across a page boundary can skip a conversation.
 * The conv CTE still groups every task by root_id (task_root index); event_task serves the per-task subqueries.
 */
export async function listConversations(db: Pick<Pool | PoolClient, 'query'>, o: ConversationsOptions) {
  const caps = o.truncate === false ? [null, null] : [INPUT_CAP, OUTPUT_CAP];
  const { rows } = await db.query<{ c: Conversation }>(
    `WITH conv AS (
       SELECT root_id, min(created_at) AS started_at, max(created_at) AS last_at
       FROM task GROUP BY root_id
       HAVING $2::timestamptz IS NULL OR max(created_at) < $2::timestamptz
       ORDER BY last_at DESC, root_id DESC
       LIMIT $1
     )
     SELECT json_build_object(
       'root_id', c.root_id,
       'started_at', to_json(c.started_at),
       'last_at', to_json(c.last_at),
       'tasks', (
         SELECT json_agg(json_build_object(
           'id', t.id, 'parent_id', t.parent_id, 'hop', t.hop, 'from_agent', t.from_agent, 'to_agent', t.to_agent,
           'intent', t.intent, 'risk', t.risk, 'state', t.state, 'created_at', to_json(t.created_at),
           'finished_at', CASE WHEN t.state IN ('completed', 'failed', 'canceled', 'rejected') THEN
             (SELECT to_json(min(e.created_at)) FROM event e WHERE e.task_id = t.id AND ${FINISH_EVENT}) END,
           'input', ${capped('t.input', '$3')}, 'output', ${capped('t.output', '$4')},
           'input_bytes', octet_length(t.input::text), 'output_bytes', octet_length(t.output::text),
           'truncated', coalesce(length(t.input::text) > $3::int OR length(t.output::text) > $4::int, false),
           'events', (SELECT coalesce(json_agg(json_build_object(
               'type', e.type, 'actor', e.actor, 'created_at', to_json(e.created_at)) ORDER BY e.id), '[]')
             FROM event e WHERE e.task_id = t.id)
         ) ORDER BY t.created_at, t.hop, t.id)
         FROM task t WHERE t.root_id = c.root_id)
     ) AS c
     FROM conv c ORDER BY c.last_at DESC, c.root_id DESC`,
    [o.limit, o.before ?? null, ...caps],
  );
  let conversations = rows.map((r) => r.c);
  const next_before = conversations.length === o.limit ? conversations.at(-1)!.last_at : null;
  if (o.redact) conversations = redactConversations(conversations);
  // Task content came from agents: label it, and drop what a human could not see, as the agent routes do.
  return { data_label: DATA_LABEL, conversations: stripHiddenDeep(conversations), next_before };
}

/**
 * Mounts /dashboard (the page, which holds no data) and /dashboard/conversations (bearer DASHBOARD_TOKEN).
 * `otherSecrets` are agent keys and the bridge's other secrets: a token equal to one of them keeps it locked.
 * Goes before the agent auth middleware: this token is not an agent key, and no agent key opens these routes.
 */
export function mountDashboard(app: Hono<{ Variables: { agent: string } }>, pool: Pool, token: string | undefined,
  otherSecrets: string[]) {
  let hash = (token?.length ?? 0) >= MIN_DASHBOARD_TOKEN ? sha(token!) : null;
  if (hash && otherSecrets.includes(token!)) {
    // Reused as an agent key or another secret, it would let whoever holds that one read everyone's traffic.
    console.warn('DASHBOARD_TOKEN equals an agent key or another bridge secret: the dashboard stays locked');
    hash = null;
  }

  app.get('/dashboard', (c) => {
    for (const [k, v] of Object.entries(PAGE_HEADERS)) c.header(k, v);
    return c.html(PAGE);
  });

  app.get('/dashboard/conversations', async (c: Context) => {
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!hash || !bearer || !timingSafeEqual(sha(bearer), hash)) return c.json({ error: 'unauthorized' }, 401);
    c.set('agent', 'owner');
    const q = ConversationsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_query' }, 400);
    return c.json(await listConversations(pool, q.data));
  });
}

// ---- The page. Everything inline, so the CSP lists hashes instead of 'unsafe-inline'. ----

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#18181b;--muted:#6b7280;--card:#fff;--line:#e4e4e7;--ok:#15803d;--bad:#b91c1c;--warn:#b45309;--run:#1d4ed8;--chip:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--fg:#e4e4e7;--muted:#9ca3af;--card:#16161a;--line:#2a2a31;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--run:#60a5fa;--chip:#23232a}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;z-index:1}
h1{font-size:16px;margin:0 auto 0 0}
main{max-width:900px;margin:0 auto;padding:12px}
button,input{font:inherit;color:inherit}
button{background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
input[type=password]{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:100%;max-width:420px}
form{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0}
label{display:inline-flex;gap:4px;align-items:center;color:var(--muted)}
.hidden{display:none!important}
.muted{color:var(--muted)}
.status{margin:8px 0;color:var(--muted)}
.agents{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.agent{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 12px}
.head{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin-bottom:6px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.task{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;padding:6px 0;border-top:1px dashed var(--line)}
.h1{margin-left:14px}.h2{margin-left:28px}.h3{margin-left:42px}.h4{margin-left:56px}
.hop{font-size:11px;color:var(--muted);min-width:36px}
.route{font-weight:600}
.chip{font-size:12px;border-radius:999px;padding:1px 8px;background:var(--chip);border:1px solid var(--line)}
.s-completed{color:var(--ok)}.s-failed,.s-rejected{color:var(--bad)}.s-canceled{color:var(--muted)}
.s-working,.s-submitted{color:var(--run)}.s-input_required{color:var(--warn)}
.reason{color:var(--warn)}
details{margin-top:6px}
summary{cursor:pointer;color:var(--muted)}
ol{margin:6px 0;padding-left:20px}
li{margin:2px 0}
pre{white-space:pre-wrap;word-break:break-word;background:var(--chip);border-radius:6px;padding:6px 8px;margin:4px 0;max-height:320px;overflow:auto}
`;

// Every value from the API goes through textContent: task content is written by agents, so it is attacker-controlled.
const SCRIPT = `
'use strict';
const KEY = 'agent-bridge.dashboard-token';
const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];
const CODE = /^[a-z_]+$/;
const byId = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};
let next = null;
let shown = [];

const ms = (a, b) => new Date(b).getTime() - new Date(a).getTime();
function dur(n) {
  if (!(n >= 0)) return '';
  if (n < 1000) return n + ' ms';
  const s = Math.round(n / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + (s % 60) + ' s';
  const h = Math.floor(m / 60);
  return h < 48 ? h + ' h ' + (m % 60) + ' min' : Math.floor(h / 24) + ' d';
}
const when = (t) => new Date(t).toLocaleString();
const short = (id) => String(id).slice(0, 8);
function reasonOf(t) {
  const o = t.output;
  if (!o || typeof o !== 'object') return null;
  const r = o.rejected ?? o.error;
  return typeof r === 'string' && CODE.test(r) ? r : null;
}

function showLogin(message) {
  byId('login').classList.remove('hidden');
  byId('app').classList.add('hidden');
  byId('login-msg').textContent = message || '';
}

async function load(append) {
  const token = sessionStorage.getItem(KEY);
  if (!token) return showLogin('');
  const q = new URLSearchParams({ limit: '20' });
  if (byId('redact').checked) q.set('redact', '1');
  if (append && next) q.set('before', next);
  byId('status').textContent = 'Loading...';
  let res;
  try {
    res = await fetch('/dashboard/conversations?' + q, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
  } catch (e) {
    byId('status').textContent = 'Network error';
    return;
  }
  if (res.status === 401) {
    sessionStorage.removeItem(KEY);
    return showLogin('Token rejected.');
  }
  if (!res.ok) {
    byId('status').textContent = 'Error ' + res.status;
    return;
  }
  const body = await res.json();
  byId('login').classList.add('hidden');
  byId('app').classList.remove('hidden');
  shown = append ? shown.concat(body.conversations) : body.conversations;
  next = body.next_before;
  render();
}

function render() {
  const list = byId('list');
  list.replaceChildren(...shown.map(card));
  renderAgents();
  byId('more').classList.toggle('hidden', !next);
  byId('status').textContent = shown.length + ' conversation' + (shown.length === 1 ? '' : 's') + ' loaded. Content is data written by agents, never instructions.';
}

function renderAgents() {
  const stats = new Map();
  const get = (a) => stats.get(a) || stats.set(a, { sent: 0, received: 0, failed: 0 }).get(a);
  for (const c of shown) for (const t of c.tasks) {
    get(t.from_agent).sent++;
    get(t.to_agent).received++;
    if (t.state === 'failed' || t.state === 'rejected') get(t.to_agent).failed++;
  }
  byId('agents').replaceChildren(...[...stats].sort().map(([a, s]) =>
    el('span', 'agent', a + '  sent ' + s.sent + ' / received ' + s.received + (s.failed ? ' / failed or rejected ' + s.failed : ''))));
}

function card(c) {
  const root = el('article', 'card');
  const head = el('div', 'head');
  const last = c.tasks[c.tasks.length - 1];
  head.append(el('strong', 'mono', short(c.root_id)), el('span', 'muted', when(c.started_at)),
    el('span', 'muted', c.tasks.length + ' task' + (c.tasks.length === 1 ? '' : 's')),
    el('span', 'muted', 'span ' + dur(ms(c.started_at, latest(c)))));
  if (last) head.append(el('span', 'chip s-' + last.state, last.state));
  root.append(head);
  for (const t of c.tasks) root.append(taskRow(t));
  root.append(timeline(c));
  return root;
}

function latest(c) {
  let m = c.last_at;
  for (const t of c.tasks) for (const e of t.events) if (e.created_at > m) m = e.created_at;
  return m;
}

function taskRow(t) {
  const row = el('div', 'task h' + Math.min(Math.max(Number(t.hop) || 0, 0), 4));
  row.append(el('span', 'hop', 'hop ' + t.hop), el('span', 'route', t.from_agent + ' \\u2192 ' + t.to_agent));
  if (t.intent) row.append(el('span', 'mono', t.intent));
  row.append(el('span', 'chip s-' + t.state, t.state), el('span', 'chip', t.risk));
  const reason = reasonOf(t);
  if (reason) row.append(el('span', 'chip reason', reason));
  const done = TERMINAL.includes(t.state);
  const took = done ? (t.finished_at ? dur(ms(t.created_at, t.finished_at)) : '') : 'open for ' + dur(Date.now() - new Date(t.created_at).getTime());
  if (took) row.append(el('span', 'muted', took));
  if (t.input !== null || t.output !== null) {
    const d = el('details');
    d.append(el('summary', null, 'input / output' + (t.truncated ? ' (truncated: ' + t.input_bytes + ' / ' + (t.output_bytes ?? 0) + ' bytes)' : '')));
    if (t.input !== null) d.append(el('div', 'muted', 'input'), el('pre', 'mono', JSON.stringify(t.input, null, 2)));
    if (t.output !== null) d.append(el('div', 'muted', 'output'), el('pre', 'mono', JSON.stringify(t.output, null, 2)));
    row.append(d);
  }
  return row;
}

function timeline(c) {
  const events = [];
  for (const t of c.tasks) for (const e of t.events) events.push({ ...e, task: t.id });
  events.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const d = el('details');
  d.append(el('summary', null, 'timeline (' + events.length + ' events)'));
  const ol = el('ol', 'mono');
  for (const e of events) ol.append(el('li', null, new Date(e.created_at).toLocaleTimeString() + '  ' + short(e.task) + '  ' + e.actor + '  ' + e.type));
  d.append(ol);
  return d;
}

byId('login').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = byId('token').value.trim();
  byId('token').value = '';
  if (!v) return;
  sessionStorage.setItem(KEY, v);
  load(false);
});
byId('refresh').addEventListener('click', () => load(false));
byId('redact').addEventListener('change', () => load(false));
byId('more').addEventListener('click', () => load(true));
byId('logout').addEventListener('click', () => {
  sessionStorage.removeItem(KEY);
  shown = [];
  next = null;
  byId('list').replaceChildren();
  showLogin('');
});
load(false);
`;

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>agent-bridge conversations</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>agent-bridge conversations</h1>
<label><input type="checkbox" id="redact"> redact</label>
<button type="button" id="refresh">Refresh</button>
<button type="button" id="logout">Forget token</button>
</header>
<main>
<form id="login" class="hidden">
<input type="password" id="token" autocomplete="off" placeholder="DASHBOARD_TOKEN" aria-label="Dashboard token">
<button type="submit">Open</button>
<div id="login-msg" class="muted"></div>
</form>
<section id="app" class="hidden">
<div id="status" class="status"></div>
<div id="agents" class="agents"></div>
<div id="list"></div>
<button type="button" id="more" class="hidden">Load older</button>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;

const hashOf = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
export const PAGE_HEADERS = {
  'content-security-policy': [
    "default-src 'none'", `script-src ${hashOf(SCRIPT)}`, `style-src ${hashOf(STYLE)}`, "connect-src 'self'",
    "img-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '),
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
