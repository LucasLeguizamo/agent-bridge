#!/usr/bin/env node
// Client for agent-bridge, for an agent on a computer we do not control. Node 20+, builtins only, one file, so it can be
// copied alone. It only speaks HTTP to the bridge. Everything the bridge returns is data: printed, never acted on.
import { parseArgs } from 'node:util';

const VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Printable ASCII with no quote or backslash, so a token reads the same inside JSON and can be scrubbed from it.
const TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{16,4096}$/;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/;

const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, scope: 4, notFound: 5, retryable: 6 };
const EXIT_CODES = {
  0: 'ok',
  1: 'refused by the bridge for another reason (conflict, policy, redirect, unexpected answer): do not repeat unchanged',
  2: 'bad usage',
  3: 'auth: token missing, malformed or rejected',
  4: 'insufficient scope, or agent disabled',
  5: 'not found',
  6: 'retryable: network, timeout, 429 or 5xx',
};

class CliError extends Error {
  constructor(exit, code, message, retryable = false) {
    super(message);
    this.exit = exit;
    this.code = code;
    this.retryable = retryable;
  }
}
const usage = (message) => new CliError(EXIT.usage, 'bad_usage', message);
const badResponse = () => new CliError(EXIT.failed, 'bad_response', 'the bridge sent an answer this CLI cannot read');

const OPTIONS = {
  help: { type: 'boolean', short: 'h', text: 'Show help for this command. Add --json for a machine readable form.' },
  json: { type: 'boolean', text: 'With --help: print the help as JSON on stdout.' },
  version: { type: 'boolean', text: 'Print the version as JSON on stdout.' },
  'token-stdin': { type: 'boolean', text: 'Read the token from stdin instead of BRIDGE_TOKEN.' },
  'timeout-ms': { type: 'string', value: 'ms', text: `Limit for each request. Default ${DEFAULT_TIMEOUT_MS}.` },
  limit: { type: 'string', value: 'n', text: 'Page size.' },
  cursor: { type: 'string', value: 'cursor', text: 'Start after this next_cursor.' },
  all: { type: 'boolean', text: 'Follow next_cursor to the end.' },
  'dry-run': { type: 'boolean', text: 'Print the request and send nothing. Needs no token.' },
  'idempotency-key': { type: 'string', value: 'key', text: 'Reuse the same key when repeating the same request.' },
  'output-json': { type: 'string', value: 'json', required: true, text: 'The result, as a JSON object.' },
  failed: { type: 'boolean', text: 'Close the task as failed. --output-json says why.' },
  to: { type: 'string', value: 'agent', required: true, text: 'Agent that receives the task.' },
  intent: { type: 'string', value: 'intent', required: true, text: 'What is asked, such as research.' },
  'input-json': { type: 'string', value: 'json', required: true, text: 'The input, as a JSON object.' },
  parent: { type: 'string', value: 'task-id', text: 'The task this one comes from.' },
};
const COMMON = ['token-stdin', 'timeout-ms'];
const READ_LIST = ['limit', 'cursor', 'all'];
const WRITE = ['dry-run', 'idempotency-key'];

const taskId = (raw) => {
  if (!UUID.test(raw)) throw usage('the task id must be a UUID');
  return raw.toLowerCase();
};
const jsonObject = (flag, raw) => {
  if (raw === undefined) throw usage(`--${flag} is required`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw usage(`--${flag} is not valid JSON`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw usage(`--${flag} must be a JSON object`);
  return parsed;
};
const required = (flag, raw) => {
  if (!raw) throw usage(`--${flag} is required`);
  return raw;
};
const text = (name, raw) => {
  if (!raw || !raw.trim()) throw usage(`<${name}> must not be empty`);
  return raw;
};
const taskOf = (r) => {
  if (r.body?.task === null || typeof r.body?.task !== 'object') throw badResponse();
  return r.body.task;
};

// Writes print only what the caller needs, as the MCP tools do: a full task row also holds what other agents wrote.
const COMMANDS = [
  {
    name: 'whoami', summary: 'Show which agent this token belongs to.', args: [], flags: [],
    example: 'bridge whoami',
    request: () => ({ method: 'GET', path: '/whoami' }),
  },
  {
    name: 'tasks pending', summary: 'List tasks offered to this agent and not claimed yet.', args: [], flags: READ_LIST,
    list: { key: 'tasks', maxLimit: 100, pages: true },
    example: 'bridge tasks pending --limit 20',
    request: () => ({ method: 'GET', path: '/tasks/pending' }),
  },
  {
    name: 'tasks get', summary: 'Show a task you sent or were offered: its state and, once closed, its output.',
    args: ['id'], flags: [],
    example: 'bridge tasks get 7b0f3c52-6a44-4d1e-9a51-0c7e5c0f1a22',
    request: ([id]) => ({ method: 'GET', path: `/tasks/${taskId(id)}` }),
    view: (r) => {
      const t = taskOf(r);
      return {
        data_label: r.body.data_label,
        task: { id: t.id, from_agent: t.from_agent, to_agent: t.to_agent, intent: t.intent, state: t.state, output: t.output, deadline_at: t.deadline_at },
      };
    },
  },
  {
    name: 'tasks claim', summary: 'Take a task. Only the first claim gets it; "claimed": false means stop, and exits 0. '
      + 'After exit 6 the claim may have happened, and repeating it answers "claimed": false.',
    args: ['id'], flags: WRITE, write: true,
    example: 'bridge tasks claim 7b0f3c52-6a44-4d1e-9a51-0c7e5c0f1a22',
    request: ([id]) => ({ method: 'POST', path: `/tasks/${taskId(id)}/claim` }),
  },
  {
    name: 'tasks complete', summary: 'Close a task with its result. Safe to repeat with the same output.',
    args: ['id'], flags: ['output-json', 'failed', ...WRITE], write: true,
    example: `bridge tasks complete 7b0f3c52-6a44-4d1e-9a51-0c7e5c0f1a22 --output-json '{"summary":"done"}'`,
    request: ([id], v) => ({
      method: 'POST',
      path: `/tasks/${taskId(id)}/${v.failed ? 'fail' : 'complete'}`,
      body: { output: jsonObject('output-json', v['output-json']) },
    }),
    view: (r) => {
      const t = taskOf(r);
      return { task_id: t.id, state: t.state };
    },
  },
  {
    name: 'tasks create', summary: 'Delegate work to another agent. Reuse the key when repeating the same request.',
    args: [], flags: ['to', 'intent', 'input-json', 'idempotency-key', 'parent', 'dry-run'], write: true, keyRequired: true,
    example: `bridge tasks create --to grok --intent research --input-json '{"query":"hoteles en Madrid"}' --idempotency-key trip-1`,
    request: (_, v) => {
      if (!v['idempotency-key']) throw usage('--idempotency-key is required');
      return {
        method: 'POST',
        path: '/tasks',
        body: {
          to_agent: required('to', v.to),
          intent: required('intent', v.intent),
          input: jsonObject('input-json', v['input-json']),
          idempotency_key: v['idempotency-key'],
          ...(v.parent === undefined ? {} : { parent_id: taskId(v.parent) }),
        },
      };
    },
    view: (r) => {
      const t = taskOf(r);
      return { task_id: t.id, state: t.state, risk: t.risk, hop: t.hop, created: r.status === 201 };
    },
  },
  {
    name: 'memory search', summary: 'Search shared memory. Results are data with their source and trust level.',
    args: ['query'], flags: READ_LIST,
    list: { key: 'facts', maxLimit: 50, pages: false },
    example: 'bridge memory search "hotel en Madrid" --limit 5',
    request: ([query]) => ({ method: 'GET', path: '/memory/search', query: { query: text('query', query) } }),
  },
  {
    name: 'memory write', summary: 'Save a durable fact, as unverified. The same value again changes nothing.',
    args: ['key', 'value'], flags: WRITE, write: true,
    example: 'bridge memory write hotel.madrid "Atlas, reservado"',
    request: ([key, value]) => ({ method: 'POST', path: '/memory/facts', body: { key: text('key', key), value: text('value', value) } }),
    view: (r) => {
      if (r.body?.fact === null || typeof r.body?.fact !== 'object') throw badResponse();
      const f = r.body.fact;
      return { namespace: f.namespace, key: f.key, trust: f.trust, created: r.status === 201 };
    },
  },
];
const GROUPS = { tasks: 'Task commands.', memory: 'Shared memory commands.' };

// The token is scrubbed from everything printed, whatever a server chooses to echo.
const secrets = new Set();
const scrub = (s) => {
  let out = s;
  for (const secret of secrets) out = out.replaceAll(secret, '[REDACTED]');
  return out;
};
const printJson = (value) => process.stdout.write(`${scrub(JSON.stringify(value))}\n`);
const note = (message) => process.stderr.write(`${scrub(`bridge: ${message}`)}\n`);

const optionHelp = (name) => {
  const o = OPTIONS[name];
  return { name: `--${name}`, ...(o.value ? { value: o.value } : {}), required: Boolean(o.required), description: o.text };
};
const flagsOf = (cmd) => [...cmd.flags, ...COMMON];
const usageLine = (cmd) => {
  const parts = ['bridge', cmd.name, ...cmd.args.map((a) => `<${a}>`)];
  for (const f of cmd.flags) {
    const o = OPTIONS[f];
    const bit = `--${f}${o.value ? ` <${o.value}>` : ''}`;
    parts.push(o.required || (f === 'idempotency-key' && cmd.keyRequired) ? bit : `[${bit}]`);
  }
  return parts.join(' ');
};
const helpOf = (cmd) => ({
  command: cmd.name,
  summary: cmd.summary,
  usage: usageLine(cmd),
  arguments: cmd.args,
  options: flagsOf(cmd).map(optionHelp).map((o) =>
    (o.name === '--idempotency-key' && cmd.keyRequired ? { ...o, required: true } : o)),
  writes: Boolean(cmd.write),
  ...(cmd.list ? { list_key: cmd.list.key, max_limit: cmd.list.maxLimit, server_cursor: cmd.list.pages } : {}),
  example: cmd.example,
});
const ENVIRONMENT = {
  BRIDGE_URL: 'Base URL of the bridge. https is required; plain http only on loopback.',
  BRIDGE_TOKEN: 'Bearer token. Or use --token-stdin. Never an argument.',
};
const globalHelp = (commands) => ({
  name: 'bridge',
  version: VERSION,
  environment: ENVIRONMENT,
  output: 'One JSON document on stdout. Messages on stderr.',
  error_shape: { error: { code: 'string', message: 'string', retryable: 'boolean' } },
  exit_codes: EXIT_CODES,
  commands: commands.map(helpOf),
});
const helpText = (cmd) => {
  const lines = [cmd.summary, '', `Usage: ${usageLine(cmd)}`, '', 'Options:'];
  for (const name of flagsOf(cmd)) {
    const o = OPTIONS[name];
    lines.push(`  --${name}${o.value ? ` <${o.value}>` : ''}  ${o.text}`);
  }
  lines.push('  --help [--json]  Show this help.', '', 'Example:', `  ${cmd.example}`);
  return lines.join('\n');
};
const overviewText = (commands, group) => [
  group ? GROUPS[group] : `bridge ${VERSION}: client for agent-bridge. Output is JSON on stdout; messages go to stderr.`,
  '',
  'Commands:',
  ...commands.map((c) => `  ${usageLine(c)}\n      ${c.summary}`),
  '',
  'Environment:',
  ...Object.entries(ENVIRONMENT).map(([k, v]) => `  ${k}  ${v}`),
  '',
  'Exit codes:',
  ...Object.entries(EXIT_CODES).map(([k, v]) => `  ${k}  ${v}`),
  '',
  'Example:',
  `  ${commands[0].example}`,
  '',
  'Each command also takes --help, and --help --json. Top level: --version.',
].join('\n');

function parse(argv) {
  const beforeDashes = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
  if (beforeDashes.some((a) => /^--(token|bearer|api-key|key)(=|$)/.test(a))) {
    throw usage('the token is never an argument: set BRIDGE_TOKEN or use --token-stdin');
  }
  const options = Object.fromEntries(Object.entries(OPTIONS).map(([k, o]) =>
    [k, { type: o.type, ...(o.short ? { short: o.short } : {}) }]));
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    // Node quotes what it could not read, and that could be a secret typed by mistake: keep only the option name.
    const name = /'(--?[A-Za-z][A-Za-z-]*)/.exec(e instanceof Error ? e.message : '')?.[1];
    throw usage(`${name ? `cannot read option ${name}` : 'cannot read the options'}. A value starting with "-" goes after "--" or as --option=value. See --help.`);
  }
}

function resolveCommand(positionals) {
  const [first, second] = positionals;
  if (first === undefined) return {};
  const inGroup = first in GROUPS ? COMMANDS.filter((c) => c.name.startsWith(`${first} `)) : null;
  if (inGroup && second === undefined) return { group: first, commands: inGroup };
  const name = inGroup ? `${first} ${second}` : first;
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw usage('unknown command. See bridge --help.');
  return { cmd, args: positionals.slice(inGroup ? 2 : 1) };
}

function checkUse(cmd, args, values) {
  if (args.length !== cmd.args.length) throw usage(`expected: ${usageLine(cmd)}`);
  const allowed = new Set([...flagsOf(cmd), 'help', 'json', 'version']);
  for (const flag of Object.keys(values)) {
    if (!allowed.has(flag)) throw usage(`${cmd.name} does not take --${flag}`);
  }
  const key = values['idempotency-key'];
  if (key !== undefined && !/^[\x21-\x7e]{1,200}$/.test(key)) throw usage('--idempotency-key must be 1 to 200 visible characters');
  if (cmd.list) {
    if (values.limit !== undefined) {
      const n = Number(values.limit);
      if (!Number.isInteger(n) || n < 1 || n > cmd.list.maxLimit) throw usage(`--limit must be an integer from 1 to ${cmd.list.maxLimit}`);
    }
    if (values.cursor !== undefined && !cmd.list.pages) throw usage(`the bridge does not page ${cmd.name}: use --limit, up to ${cmd.list.maxLimit}`);
  }
}

function timeoutOf(values) {
  if (values['timeout-ms'] === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Number(values['timeout-ms']);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_MS) throw usage(`--timeout-ms must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  return n;
}

// Messages never repeat the value: it may hold a credential.
function bridgeUrl(env) {
  const raw = env.BRIDGE_URL;
  if (!raw) throw usage('BRIDGE_URL is not set');
  let url;
  try { url = new URL(raw); } catch { throw usage('BRIDGE_URL is not a valid URL'); }
  if (url.username || url.password || url.search || url.hash) throw usage('BRIDGE_URL must hold no credentials, query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw usage('BRIDGE_URL must use https (plain http only on loopback)');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw usage('refusing to send a token with NODE_TLS_REJECT_UNAUTHORIZED=0');
  return url;
}

async function readStdin() {
  if (process.stdin.isTTY) throw new CliError(EXIT.auth, 'token_missing', '--token-stdin needs piped input: this CLI never prompts');
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CliError(EXIT.auth, 'token_missing', 'nothing arrived on stdin for --token-stdin')), STDIN_TIMEOUT_MS);
  });
  const read = (async () => {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 8192) break;
    }
    return raw;
  })();
  try {
    return await Promise.race([read, timedOut]);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(EXIT.auth, 'token_missing', 'could not read stdin for --token-stdin');
  } finally {
    clearTimeout(timer);
    process.stdin.destroy();
  }
}

async function loadToken(values, env) {
  const raw = values['token-stdin'] ? await readStdin() : env.BRIDGE_TOKEN;
  const token = raw?.replace(/\r?\n$/, '');
  if (!token) throw new CliError(EXIT.auth, 'token_missing', 'no token: set BRIDGE_TOKEN or use --token-stdin');
  if (!TOKEN.test(token)) throw new CliError(EXIT.auth, 'token_malformed', 'the token must be at least 16 visible characters, with no quotes, backslashes or spaces');
  secrets.add(token);
  return token;
}

function urlFor(base, path, query = {}) {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url;
}

async function readLimited(res) {
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new CliError(EXIT.failed, 'response_too_large', 'the answer from the bridge is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// `message` is always ours: text from the server is data, and an error is what an agent is most likely to act on.
function errorFor(status, body) {
  const fromServer = typeof body?.error === 'string' && SAFE_CODE.test(body.error) ? body.error : null;
  const fail = (exit, fallback, message, retryable = false) => new CliError(exit, fromServer ?? fallback, message, retryable);
  if (status === 401) return fail(EXIT.auth, 'unauthorized', 'the bridge rejected the token');
  if (status === 403) return fail(EXIT.scope, 'forbidden', 'this token may not do that, or its agent is disabled');
  if (status === 404) return fail(EXIT.notFound, 'not_found', 'the bridge found nothing there');
  if (status === 408 || status === 429 || status >= 500) return fail(EXIT.retryable, `http_${status}`, `temporary failure at the bridge (HTTP ${status}): retry later`, true);
  if (status === 400) return fail(EXIT.usage, 'invalid_request', 'the bridge rejected the request as invalid');
  if (body?.task?.state === 'rejected') {
    const reason = body.task.output?.rejected;
    const why = typeof reason === 'string' && SAFE_CODE.test(reason) ? `: ${reason}` : '';
    return new CliError(EXIT.failed, 'task_rejected', `a guard of the bridge rejected the task${why}`);
  }
  return fail(EXIT.failed, `http_${status}`, `the bridge refused the request (HTTP ${status})`);
}

async function send(ctx, req, query = req.query) {
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(urlFor(ctx.base, req.path, query), {
      method: req.method,
      redirect: 'manual', // A followed redirect could carry the token to another host.
      signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${ctx.token}`,
        'user-agent': `agent-bridge-cli/${VERSION}`,
        ...req.headers,
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new CliError(EXIT.failed, 'redirect_refused', 'the bridge answered with a redirect, and this CLI does not follow them: check BRIDGE_URL');
    }
    raw = await readLimited(res);
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (signal.aborted) throw new CliError(EXIT.retryable, 'timeout', `no answer within ${ctx.timeoutMs} ms`, true);
    const cause = e instanceof Error && typeof e.cause?.code === 'string' && SAFE_CODE.test(e.cause.code.toLowerCase()) ? `: ${e.cause.code}` : '';
    throw new CliError(EXIT.retryable, 'network_error', `could not reach the bridge${cause}`, true);
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = undefined; }
  if (!res.ok) throw errorFor(res.status, body);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badResponse();
  return { status: res.status, body };
}

async function runList(ctx, cmd, req, values) {
  const { key, maxLimit, pages } = cmd.list;
  const limit = values.limit ?? (values.all && !pages ? maxLimit : undefined);
  const query = { ...req.query, limit, cursor: values.cursor };
  const first = await send(ctx, req, query);
  if (!values.all) return first.body;
  if (!pages) note(`the bridge does not page ${cmd.name}: this is the top of its results`);

  const items = [];
  const seen = new Set();
  let page = first.body;
  for (let n = 1; ; n++) {
    if (!Array.isArray(page[key])) throw badResponse();
    items.push(...page[key]);
    const next = page.next_cursor;
    if (typeof next !== 'string' || !next) break;
    if (seen.has(next) || n >= MAX_PAGES) throw badResponse(); // A server must not be able to keep this running.
    seen.add(next);
    page = (await send(ctx, req, { ...query, cursor: next })).body;
  }
  return { ...first.body, [key]: items, ...(pages ? { next_cursor: null } : {}) };
}

async function run(argv, env) {
  // A malformed token is never sent, so no server can echo it, and scrubbing "e" would wreck the JSON.
  const envToken = env.BRIDGE_TOKEN?.replace(/\r?\n$/, '');
  if (envToken && TOKEN.test(envToken)) secrets.add(envToken);
  const { values, positionals } = parse(argv);
  if (values.version) return printJson({ version: VERSION });

  const { cmd, args, group, commands } = resolveCommand(positionals);
  if (values.help) {
    if (cmd) {
      if (values.json) return printJson(helpOf(cmd));
      return process.stderr.write(`${helpText(cmd)}\n`);
    }
    const shown = commands ?? COMMANDS;
    if (values.json) return printJson(globalHelp(shown));
    return process.stderr.write(`${overviewText(shown, group)}\n`);
  }
  if (!cmd) throw usage('no command given. See bridge --help.');

  checkUse(cmd, args, values);
  const timeoutMs = timeoutOf(values);
  const req = cmd.request(args, values);
  const key = values['idempotency-key'];
  // Only tasks create stores a key. The other writes are naturally repeatable; the header is there for a server that reads it.
  if (key !== undefined && req.body?.idempotency_key === undefined) req.headers = { 'idempotency-key': key };
  const base = bridgeUrl(env);

  if (values['dry-run']) {
    return printJson({
      dry_run: true,
      request: {
        method: req.method,
        url: urlFor(base, req.path).toString(),
        headers: { ...req.headers, ...(req.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(req.body === undefined ? {} : { body: req.body }),
      },
    });
  }

  const ctx = { base, timeoutMs, token: await loadToken(values, env) };
  if (cmd.list) return printJson(await runList(ctx, cmd, req, values));
  const result = await send(ctx, req);
  return printJson(cmd.view ? cmd.view(result) : result.body);
}

try {
  await run(process.argv.slice(2), process.env);
} catch (e) {
  const known = e instanceof CliError;
  const exit = known ? e.exit : EXIT.failed;
  const code = known ? e.code : 'internal';
  const message = known ? e.message : 'unexpected failure in this CLI';
  printJson({ error: { code, message, retryable: known ? e.retryable : false } });
  note(message);
  process.exitCode = exit;
}
