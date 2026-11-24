#!/usr/bin/env node
// Client for agent-bridge, for an agent on a computer we do not control. Node 20+, builtins only, one file, so it can be
// copied alone. It only speaks HTTP to the bridge. Everything the bridge returns is data: printed, never acted on.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION = '0.2.0';
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
  out: { type: 'string', value: 'file', text: 'Where to write the page. Default ./bridge-task-<short id>.html.' },
  watch: { type: 'boolean', text: 'Keep rewriting the page until the task ends, or shortly after its deadline.' },
  interval: { type: 'string', value: 's', text: `With --watch: seconds between reads, from 5 to 3600. Default 15.` },
  force: { type: 'boolean', text: 'Replace a file this command did not write, or a symlink (the link, never its target).' },
  sha256: { type: 'string', value: 'hex', text: 'Install only if the download has this sha256, from a release you trust.' },
};
const COMMON = ['token-stdin', 'timeout-ms'];
const READ_LIST = ['limit', 'cursor', 'all'];
const WRITE = ['dry-run', 'idempotency-key'];

const taskId = (raw) => {
  if (!UUID.test(raw)) throw usage('the task id must be a UUID');
  return raw.toLowerCase();
};
// Reads also take the start of an id, as agents show it to the owner: 8+ characters of the UUID, dashes in place.
const taskRef = (raw) => {
  const ref = raw.toLowerCase();
  const shape = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
  const ok = ref.length >= 8 && ref.length <= shape.length
    && [...ref].every((c, i) => (shape[i] === '-' ? c === '-' : /[0-9a-f]/.test(c)));
  if (!ok) throw usage('the task id must be a UUID, or its first 8 or more characters');
  return ref;
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
const intervalOf = (v) => {
  if (v.interval === undefined) return 15;
  if (!v.watch) throw usage('--interval needs --watch');
  const n = Number(v.interval);
  if (!Number.isInteger(n) || n < 5 || n > 3600) throw usage('--interval must be an integer from 5 to 3600');
  return n;
};
const taskOf = (r) => {
  if (r.body?.task === null || typeof r.body?.task !== 'object') throw badResponse();
  return r.body.task;
};

// Writes print only what the caller needs, as the MCP tools do: a full task row also holds what other agents wrote.
const COMMANDS = [
  {
    name: 'instructions', summary: 'Print this agent\'s current working instructions from the bridge. Follow its "text".',
    args: [], flags: [],
    example: 'bridge instructions',
    request: () => ({ method: 'GET', path: '/instructions' }),
  },
  {
    name: 'doctor', summary: 'Check this agent\'s setup: bridge URL, /health, token, agent enabled, instructions. '
      + 'Exits 0 only if every check passes. Prints each check with a fix on stderr.',
    args: [], flags: [], doctor: true,
    example: 'bridge doctor',
    request: () => ({ method: 'GET', path: '/health' }),
  },
  {
    name: 'update', summary: 'Replace this CLI with the version the bridge serves, only if its sha256 matches. Needs no token.',
    args: [], flags: ['sha256'], local: true,
    example: 'bridge update',
    request: () => ({ method: 'GET', path: '/cli/bridge.mjs' }),
  },
  {
    name: 'whoami', summary: 'Show which agent this token belongs to.', args: [], flags: [],
    example: 'bridge whoami',
    request: () => ({ method: 'GET', path: '/whoami' }),
  },
  {
    name: 'agents', summary: 'List the other agents on this bridge: what each is for, and your own contact with it '
      + '(tasks sent, received and still open, the last one, and whether the pair is paused).',
    args: [], flags: [],
    example: 'bridge agents',
    request: () => ({ method: 'GET', path: '/agents' }),
  },
  {
    name: 'tasks pending', summary: 'List tasks offered to this agent and not claimed yet.', args: [], flags: READ_LIST,
    list: { key: 'tasks', maxLimit: 100, pages: true },
    example: 'bridge tasks pending --limit 20',
    request: () => ({ method: 'GET', path: '/tasks/pending' }),
  },
  {
    name: 'tasks get', summary: 'Show a task you sent or were offered: its state and, once closed, its output. '
      + 'The id may be its first 8 or more characters; if two of your tasks start that way, exit 1 with ambiguous_id.',
    args: ['id'], flags: [],
    example: 'bridge tasks get 7b0f3c52',
    request: ([id]) => ({ method: 'GET', path: `/tasks/${taskRef(id)}` }),
    view: (r) => {
      const t = taskOf(r);
      return {
        data_label: r.body.data_label,
        task: { id: t.id, from_agent: t.from_agent, to_agent: t.to_agent, intent: t.intent, state: t.state, output: t.output, deadline_at: t.deadline_at },
      };
    },
  },
  {
    name: 'tasks view', summary: 'Write one HTML page that shows how a task you sent or were offered is going, and print '
      + 'where it is. It holds task content: share it with care.',
    args: ['id'], flags: ['out', 'watch', 'interval', 'force'], page: true,
    example: 'bridge tasks view 7b0f3c52 --watch',
    request: ([id], v) => {
      if (v.out === '') throw usage('--out must not be empty');
      intervalOf(v);
      return { method: 'GET', path: `/tasks/${taskRef(id)}` };
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
  BRIDGE_URL: 'Base URL of the bridge. https is required; plain http only on loopback. Default: the file <config>/url.',
  BRIDGE_TOKEN: 'Bearer token. Or use --token-stdin. Never an argument. Default: the file <config>/token, mode 600.',
  XDG_CONFIG_HOME: 'Where <config> lives: $XDG_CONFIG_HOME/bridge, or ~/.config/bridge.',
};
const configDir = (env) => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'bridge');
// Both files are refused when others can write them (the url decides where the token goes) or, for the token, read it.
function readConfig(env, name, forbidden) {
  const path = join(configDir(env), name);
  let mode;
  try { mode = statSync(path).mode; } catch { return undefined; }
  if (process.platform !== 'win32' && (mode & forbidden)) {
    throw new CliError(EXIT.auth, 'config_file_open', `the ${name} file in the config directory is open to other users: run chmod 600 on it`);
  }
  return readFileSync(path, 'utf8');
}
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
  const raw = env.BRIDGE_URL || readConfig(env, 'url', 0o022)?.trim();
  if (!raw) throw usage('BRIDGE_URL is not set, and there is no url file in the config directory');
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

const tokenFile = (env) => readConfig(env, 'token', 0o077); // As ssh does with a private key.

// Downloads the CLI the bridge serves and swaps it in atomically. It runs only what the same bridge already serves
// at install time, and only when its sha256 matches the one the owner gave.
async function selfUpdate(base, timeoutMs, expected) {
  // Required: without it a compromised bridge could swap in its own client, which holds the token.
  if (!/^[0-9a-f]{64}$/i.test(expected ?? '')) throw usage('--sha256 <64 hex characters> is required, from a release you trust');
  const res = await fetch(urlFor(base, '/cli/bridge.mjs'), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    .catch(() => { throw new CliError(EXIT.retryable, 'network_error', 'could not reach the bridge', true); });
  if (!res.ok) throw errorFor(res.status, undefined);
  const source = await readLimited(res);
  const version = /^const VERSION = '([0-9.]+)';$/m.exec(source)?.[1];
  if (!source.startsWith('#!/usr/bin/env node\n') || !version) throw badResponse();
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== expected.toLowerCase()) {
    throw new CliError(EXIT.failed, 'hash_mismatch', 'the downloaded CLI does not have the expected sha256: nothing was changed');
  }
  const path = fileURLToPath(import.meta.url);
  const temp = `${path}.${process.pid}.new`;
  try {
    writeFileSync(temp, source, { mode: statSync(path).mode, flag: 'wx' }); // wx: never through an existing file or link.
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* nothing was written */ }
    throw new CliError(EXIT.failed, 'update_failed', 'could not replace this CLI file: nothing was changed');
  }
  return { updated: version !== VERSION, from: VERSION, to: version, path, sha256 };
}

async function loadToken(values, env) {
  const raw = values['token-stdin'] ? await readStdin() : env.BRIDGE_TOKEN || tokenFile(env);
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

// ---- tasks view: one HTML file with no script, no link and nothing to load. Every value in it was written by an agent
// or by the server, so it goes through esc() or one of the helpers built on it.

const SECOND_MS = 1000; // The watch's unit: tests run a copy of this file with a shorter one.
const WATCH_GRACE_MS = 120 * SECOND_MS; // The bridge fails an overdue task on its next pass, a minute away at most.
const LAST_READ_MS = 5 * SECOND_MS;
const MAX_WATCH_MS = 48 * 3_600_000; // Whatever deadline a server claims.
const MAX_FIELD = 200;
const MAX_BLOCK = 20_000;
const MAX_PAYLOAD = 1000;
const MAX_EVENTS = 200;
const PAGE_MARKER = '<!doctype html>\n<!-- agent-bridge: written by "bridge tasks view" -->\n';
const STATES = { // sign, name, meaning
  submitted: ['\u25cb', 'Submitted', 'queued or sent, not taken yet'],
  working: ['\u25d0', 'Working', 'the agent has it'],
  input_required: ['\u2016', 'Waiting', 'held until the owner approves it'],
  completed: ['\u2713', 'Completed', 'closed with a result'],
  failed: ['\u2717', 'Failed', 'closed without a result'],
  canceled: ['\u2013', 'Canceled', 'withdrawn before it ended'],
  rejected: ['\u2717', 'Rejected', 'refused, never done'],
};
const CLOSED = new Set(['completed', 'failed', 'canceled', 'rejected']);

// What a reader could not see goes first, so that nothing hides a token from the scrubbing; tab and line feed stay.
const visible = (s) => scrub(s.replace(/[^\P{C}\t\n]|\p{Default_Ignorable_Code_Point}/gu, ''));
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);
const cut = (s, max) => s.slice(0, max).replace(/[\ud800-\udbff]$/, ''); // Never half a surrogate pair.
/** One short value. bdi keeps right-to-left text from reordering what is around it. */
const field = (v) => {
  const s = visible(typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  return `<bdi>${esc(cut(s, MAX_FIELD))}${s.length > MAX_FIELD ? '\u2026' : ''}</bdi>`;
};
const block = (name, v, max) => {
  const s = visible(JSON.stringify(v, null, 2));
  const note = s.length > max ? `cut: the first ${max} of ${s.length} characters` : `${s.length} characters`;
  return `<details>\n<summary>${name} (${note})</summary>\n<pre dir="auto">${esc(cut(s, max))}</pre>\n</details>`;
};
const timeOf = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : NaN);
const moment = (v) => {
  const ms = timeOf(v);
  if (Number.isNaN(ms)) return field(v);
  const iso = new Date(ms).toISOString();
  return `<time datetime="${iso}">${iso.slice(0, 19).replace('T', ' ')} UTC</time>`;
};
const duration = (ms) => {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under 1 min';
  if (min < 60) return `${min} min`;
  return min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} d`;
};

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#18181b;--muted:#52525b;--card:#fff;--line:#d4d4d8;--ok:#166534;--bad:#b91c1c;--warn:#92400e;--run:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0e;--fg:#e4e4e7;--muted:#a1a1aa;--card:#16161a;--line:#3f3f46;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--run:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header,main,footer{max-width:720px;margin:0 auto;padding:12px 16px}
h1{font-size:1.4rem;margin:.4em 0 0}
h2{font-size:1.05rem;margin:0 0 .5em}
p{margin:.3em 0}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px}
.state{font-weight:700;font-size:1.15rem}
.completed{color:var(--ok)}.failed,.rejected,.late{color:var(--bad)}.input_required{color:var(--warn)}.working,.submitted{color:var(--run)}
.muted,footer,dt,summary{color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0}
dd{margin:0}
dd,li,p,h1{overflow-wrap:anywhere}
ol{margin:0;padding-left:1.4em}
li{margin:0 0 .5em}
summary{cursor:pointer;padding:4px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:.85rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0}
`;
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(PAGE_STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'`;

/** `refresh` is the seconds between reloads, or 0 for a page that will not change again. */
function taskHtml({ task, events }, refresh) {
  const id = task.id.slice(0, 8);
  const [sign, name, meaning] = Object.hasOwn(STATES, task.state) ? STATES[task.state] : ['?', field(task.state), 'a state this CLI does not know'];
  const left = timeOf(task.deadline_at) - Date.now();
  const rows = [
    ['Intent', field(task.intent)],
    ['Risk', field(task.risk)],
    ['Hop', field(task.hop)],
    ['Attempts', field(task.attempts)],
    ['Created', moment(task.created_at)],
    ['Claimed', task.claimed_at == null ? 'Not claimed yet' : moment(task.claimed_at)],
    ['Deadline', moment(task.deadline_at)],
    ...(CLOSED.has(task.state) ? [] : [left < 0
      ? ['Overdue by', `<strong class="late">${duration(-left)}</strong>`] : ['Time left', duration(left)]]),
    ['Task id', esc(task.id)],
  ];
  const shown = events.slice(-MAX_EVENTS);
  const hidden = events.length - shown.length;
  const line = (e) => `<li>${moment(e?.created_at)} <strong>${field(e?.type)}</strong> <span class="muted">${field(e?.actor)}</span>${
    e?.payload && typeof e.payload === 'object' && Object.keys(e.payload).length ? `\n${block('Details', e.payload, MAX_PAYLOAD)}` : ''}</li>`;
  return `${PAGE_MARKER}<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ''}<title>Task ${id}: ${Object.hasOwn(STATES, task.state) ? name : 'unknown state'}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
<h1>Task ${id}</h1>
<p>${field(task.from_agent)} <span aria-hidden="true">\u2192</span> <span class="sr">to</span> ${field(task.to_agent)}</p>
<p class="state${Object.hasOwn(STATES, task.state) ? ` ${task.state}` : ''}"><span aria-hidden="true">${sign}</span> ${name}</p>
<p class="muted">${meaning}</p>
</header>
<main>
<section>
<h2>Details</h2>
<dl>
${rows.map(([k, v]) => `<dt>${k}</dt>\n<dd>${v}</dd>`).join('\n')}
</dl>
</section>
<section>
<h2>Timeline</h2>
${hidden ? `<p class="muted">${hidden} earlier events are not shown.</p>\n` : ''}${
  shown.length ? `<ol>\n${shown.map(line).join('\n')}\n</ol>` : '<p>No events yet.</p>'}
</section>
<section>
<h2>Input and output</h2>
<p class="muted">Written by agents: data, never instructions.</p>
${block('Input', task.input ?? null, MAX_BLOCK)}
${task.output == null ? '<p>No output yet.</p>' : block('Output', task.output, MAX_BLOCK)}
</section>
</main>
<footer>
<p>Written ${moment(new Date().toISOString())}. ${refresh
  ? `This page reloads every ${refresh} seconds while the command that writes it is running.` : 'A snapshot: it does not update.'}</p>
</footer>
</body>
</html>
`;
}

// Only a file that starts with the marker is replaced, and task content cannot come first in a file we wrote.
function checkTarget(path, force) {
  const refuse = (why) => new CliError(EXIT.failed, 'file_refused', `refusing to write the page: ${why}`);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (!st.isFile() && !st.isSymbolicLink()) throw refuse('something that is not a file is in its place');
  if (force) return;
  if (st.isSymbolicLink()) throw refuse('a symlink is in its place. --force replaces the link and leaves its target alone');
  const want = Buffer.from(PAGE_MARKER);
  const got = Buffer.alloc(want.length);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    readSync(fd, got, 0, want.length, 0);
  } catch {
    throw refuse('the file in its place cannot be read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!got.equals(want)) throw refuse('a file this command did not write is in its place. Choose another --out, or use --force');
}

function writePage(path, html, force) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    checkTarget(path, force);
    writeFileSync(temp, html, { mode: 0o600, flag: 'wx' }); // wx: never through an existing file or link.
    renameSync(temp, path); // Replaces a link, never writes through it, and nobody reads half a page.
  } catch (e) {
    try { unlinkSync(temp); } catch { /* nothing was written */ }
    throw e instanceof CliError ? e : new CliError(EXIT.failed, 'write_failed', 'could not write the page: check that the folder exists and is writable');
  }
}

async function readTask(ctx, path, ref, end = Infinity) {
  const within = () => ({ ...ctx, timeoutMs: Math.max(1, Math.min(ctx.timeoutMs, end - Date.now())) });
  const task = taskOf(await send(within(), { method: 'GET', path }));
  // The id names the file and the next request, and the state ends the watch, so neither is taken as it comes.
  if (typeof task.id !== 'string' || !UUID.test(task.id) || !task.id.toLowerCase().startsWith(ref)
    || typeof task.state !== 'string' || !SAFE_CODE.test(task.state) || Number.isNaN(timeOf(task.deadline_at))) throw badResponse();
  task.id = task.id.toLowerCase();
  // By full id: bridges up to 0.2.0 take no prefix.
  const { body } = await send(within(), { method: 'GET', path: `/tasks/${task.id}/events` });
  if (!Array.isArray(body.events)) throw badResponse();
  return { task, events: body.events };
}

async function taskPage(ctx, ref, values) {
  const every = intervalOf(values);
  let snap = await readTask(ctx, `/tasks/${ref}`, ref);
  const { id } = snap.task;
  const file = resolve(values.out ?? `bridge-task-${id.slice(0, 8)}.html`);
  // Fixed by the first read, so a server cannot keep this running by moving the deadline. The last read starts at `stop`
  // and no request may outlast `end`, so one that never answers cannot either.
  const end = Math.min(timeOf(snap.task.deadline_at) + WATCH_GRACE_MS, Date.now() + MAX_WATCH_MS);
  const stop = end - LAST_READ_MS;
  let force = Boolean(values.force);
  for (;;) {
    const closed = CLOSED.has(snap.task.state);
    const last = !values.watch || closed || Date.now() >= stop;
    writePage(file, taskHtml(snap, last ? 0 : every), force);
    force = false; // From here on the file is ours.
    if (last) {
      if (values.watch && !closed) note('stopped watching: the task is past its deadline, or 48 hours went by, and it is still open');
      return { file, state: snap.task.state };
    }
    for (let fresh; !fresh;) {
      await new Promise((done) => { setTimeout(done, Math.min(every * SECOND_MS, Math.max(stop - Date.now(), 0))); });
      try {
        fresh = snap = await readTask(ctx, `/tasks/${id}`, id, end);
      } catch (e) {
        if (e instanceof CliError && e.retryable && Date.now() < stop) {
          note(`${e.message}. Trying again in ${every} s`);
          continue;
        }
        try { writePage(file, taskHtml(snap, 0), false); } catch { /* the first error is the one to report */ }
        throw e;
      }
    }
  }
}

// Each check is ours to word: what the server sends is only read for a status, an agent id or a version.
async function doctor(values, env, timeoutMs) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(ok || !fix ? {} : { fix }) });
  const code = (v) => (typeof v === 'string' && SAFE_CODE.test(v) ? v : 'unknown');
  let base;
  try {
    base = bridgeUrl(env);
    add('url', true, 'BRIDGE_URL is set and uses https or loopback');
  } catch (e) {
    add('url', false, e.message, 'set BRIDGE_URL to the https address of your bridge');
  }
  if (base) {
    try {
      const res = await fetch(urlFor(base, '/health'), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => {});
      if (res.ok) add('health', true, 'the bridge answers and reaches its database');
      else if (res.status === 503) add('health', false, 'the bridge answers, but cannot reach its database', 'tell the owner: run pnpm bridge:doctor on the server');
      else add('health', false, `GET /health answered HTTP ${res.status}`, 'check BRIDGE_URL points at the bridge, not another site');
    } catch {
      add('health', false, 'could not reach the bridge', 'check BRIDGE_URL and the network; the bridge may be down');
    }
  }
  let token;
  try {
    token = await loadToken(values, env);
    add('token', true, 'present and well formed');
  } catch (e) {
    add('token', false, e.message, 'set BRIDGE_TOKEN to this agent\'s key, or pass it with --token-stdin');
  }
  if (base && token) {
    const ctx = { base, timeoutMs, token };
    try {
      const r = await send(ctx, { method: 'GET', path: '/whoami' });
      add('agent', true, `the token belongs to ${code(r.body.agent)}, which is enabled`);
      try {
        const i = await send(ctx, { method: 'GET', path: '/instructions' });
        add('instructions', true, `served, version ${code(i.body.version)}`);
      } catch (e) {
        add('instructions', false, e.message, 'tell the owner; bridge instructions should print them');
      }
    } catch (e) {
      const fix = e.exit === EXIT.auth ? 'the key does not match BRIDGE_AGENT_KEYS on the bridge: ask the owner for this agent\'s key'
        : e.exit === EXIT.scope ? 'the agent is disabled or not registered: ask the owner to run pnpm bridge:setup or turn it back on'
          : 'retry later; if it persists, tell the owner';
      add('agent', false, e.message, fix);
    }
  }
  for (const c of checks) process.stderr.write(`${scrub(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`)}\n`);
  const ok = checks.every((c) => c.ok);
  printJson({ ok, checks });
  if (!ok) process.exitCode = EXIT.failed;
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
  if (cmd.doctor) return doctor(values, env, timeoutMs);
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

  if (cmd.local) return printJson(await selfUpdate(base, timeoutMs, values.sha256));
  const ctx = { base, timeoutMs, token: await loadToken(values, env) };
  if (cmd.page) return printJson(await taskPage(ctx, taskRef(args[0]), values));
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
