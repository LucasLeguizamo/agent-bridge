// What a release must keep true, with no database: one version everywhere, and no bootstrap change that goes unannounced.
// The process is in CONTRIBUTING.md, "Releasing".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { BOOTSTRAP_VERSION, CHAT_BOOTSTRAP, CLI_BOOTSTRAP, ROUTINE_BOOTSTRAP } from '../src/instructions.ts';
import { mountMcp } from '../src/mcp.ts';
import { VERSION } from '../src/version.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };

describe('one version', () => {
  test('package.json holds a plain semantic version, and the bridge reads it', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(VERSION, pkg.version);
  });

  test('the CLI says the same version', () => {
    // The CLI is one file that agents download alone, so it cannot read package.json: its literal must be kept in step.
    const cli = /^const VERSION = '([0-9.]+)';$/m.exec(read('cli/bridge.mjs'))?.[1];
    assert.equal(cli, pkg.version, 'cli/bridge.mjs VERSION and package.json "version" must be bumped together');
  });

  test('the MCP server says the same version', async () => {
    const app = new Hono<{ Variables: { agent: string } }>();
    app.use(async (c, next) => { c.set('agent', 'grok'); await next(); });
    mountMcp(app, {} as Pool); // initialize runs no query
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://bridge.test/mcp'), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }));
    try {
      assert.deepEqual(client.getServerVersion(), { name: 'agent-bridge', version: pkg.version });
    } finally {
      await client.close();
    }
  });
});

describe('bootstraps', () => {
  // A bootstrap is pasted by hand into each agent, once. Unlike the served instructions, a deploy does not update it.
  // HISTORY has one entry per BOOTSTRAP_VERSION, with the hash of each text at that version. Version 0 is what was
  // pasted before the version existed. Add an entry when a bootstrap changes; never edit an older one.
  const HISTORY = [
    {
      version: 0,
      ROUTINE_BOOTSTRAP: '030bf02a8e704d74208707708aaf9452378ac75da51e0fb0c7dc75bfb03526ff',
      CLI_BOOTSTRAP: 'a4b84d7361bbb8c21f997ce655c6aa270d76d580f840c5ecbc78f8ebbdbdb7ec',
      CHAT_BOOTSTRAP: 'c404bdb6c70f37b0ce22f18bb41c89479e22398ae2e5acca39dff7a189f9a239',
    },
    {
      version: 1, // Each bootstrap sends its version to GET /instructions.
      ROUTINE_BOOTSTRAP: 'a1d8113ca2f81a6888282eddd234a81b5302968f3d9f496868458bf081c08691',
      CLI_BOOTSTRAP: '3180a8d31759e0a07e37455e1b5c2ad6f03b1b4d1105328b98a88effe7394c09',
      CHAT_BOOTSTRAP: '87fe3ec6a3c5380c08c4c01fbab60108f08bf4befaaa3160f28e0712e1870118',
    },
  ];
  type Texts = Record<'ROUTINE_BOOTSTRAP' | 'CLI_BOOTSTRAP' | 'CHAT_BOOTSTRAP', string>;
  const NAMES = ['ROUTINE_BOOTSTRAP', 'CLI_BOOTSTRAP', 'CHAT_BOOTSTRAP'] as const;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const texts: Texts = { ROUTINE_BOOTSTRAP, CLI_BOOTSTRAP, CHAT_BOOTSTRAP };

  /** The first thing wrong with the texts, the version and the history, as a message that says what to do. Null when fine. */
  const problem = (now: Texts, version: number, history: typeof HISTORY) => {
    const last = history.at(-1)!;
    const hashes = Object.fromEntries(NAMES.map((n) => [n, sha(now[n])]));
    const changed = NAMES.filter((n) => hashes[n] !== last[n]);
    if (changed.length) {
      return [
        `${changed.join(' and ')} in src/instructions.ts changed since version ${last.version}. Every install must paste the bootstrap again; a deploy does not do it.`,
        'If you did not mean that, undo the change: text that can change belongs in the served instructions.',
        'If you did mean it:',
        `  1. Set BOOTSTRAP_VERSION in src/instructions.ts to ${last.version + 1}. Agents that pasted an older version are told to ask the owner to paste again.`,
        `  2. Add a new entry to HISTORY in test/release.test.ts, without editing the older ones: { version: ${last.version + 1}, ${NAMES.map((n) => `${n}: '${hashes[n]}'`).join(', ')} }`,
        '  3. Add an entry to CHANGELOG.md under [Unreleased], in an "### Action required" section, that says which agents',
        '     must get the new text and where to copy it from (/activate/grok or /activate/instinct).',
        '  4. If the Grok Bot template is public, rebuild it (CONTRIBUTING.md, "Cutting a release").',
        'See CONTRIBUTING.md, "Releasing".',
      ].join('\n');
    }
    if (version !== last.version) {
      return `BOOTSTRAP_VERSION is ${version} but the texts are those of version ${last.version} and nothing changed. `
        + 'Bump it only together with a change to a bootstrap, with a new HISTORY entry: a bump alone makes every install look out of date for nothing.';
    }
    return null;
  };

  test('the texts are the ones the current BOOTSTRAP_VERSION names, so no bootstrap changes unannounced', () => {
    assert.equal(problem(texts, BOOTSTRAP_VERSION, HISTORY), null);
  });

  test('changing a bootstrap without a new version fails, and the message says what to do', () => {
    for (const name of NAMES) {
      const message = problem({ ...texts, [name]: `${texts[name]} ` }, BOOTSTRAP_VERSION, HISTORY);
      assert.ok(message, `${name} changed and nothing failed`);
      assert.match(message, new RegExp(`^${name} in src/instructions.ts changed since version ${BOOTSTRAP_VERSION}`));
      assert.match(message, new RegExp(`Set BOOTSTRAP_VERSION in src/instructions.ts to ${BOOTSTRAP_VERSION + 1}`));
      assert.match(message, /Add a new entry to HISTORY.*without editing the older ones/);
      assert.match(message, /Action required/);
      assert.match(message, /rebuild it/);
    }
    // A bump with nothing changed is a mistake too.
    assert.match(problem(texts, BOOTSTRAP_VERSION + 1, HISTORY)!, /nothing changed/);
  });

  test('HISTORY is complete: one entry per version from 0, each different from the one before', () => {
    assert.deepEqual(HISTORY.map((h) => h.version), HISTORY.map((_, i) => i));
    for (let i = 1; i < HISTORY.length; i++) {
      assert.ok(NAMES.some((n) => HISTORY[i]![n] !== HISTORY[i - 1]![n]), `version ${i} is the same text as version ${i - 1}`);
    }
    assert.equal(BOOTSTRAP_VERSION, HISTORY.at(-1)!.version, 'BOOTSTRAP_VERSION must be the last HISTORY version');
  });

  test('every bootstrap sends the version it was written at, so the bridge can tell an old paste', () => {
    assert.match(ROUTINE_BOOTSTRAP, new RegExp(`"\\{BRIDGE\\}/instructions\\?bootstrap=${BOOTSTRAP_VERSION}"`));
    assert.match(CHAT_BOOTSTRAP, new RegExp(`"\\{BRIDGE\\}/instructions\\?mode=owner&bootstrap=${BOOTSTRAP_VERSION}"`));
    assert.match(CLI_BOOTSTRAP, new RegExp(`^run: BRIDGE_BOOTSTRAP=${BOOTSTRAP_VERSION} node ~/\\.local/bin/bridge\\.mjs instructions$`, 'm'));
  });
});
