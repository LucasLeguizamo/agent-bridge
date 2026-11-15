// What a release must keep true, with no database: one version everywhere, and no bootstrap change that goes unannounced.
// The process is in CONTRIBUTING.md, "Releasing".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { CLI_BOOTSTRAP, ROUTINE_BOOTSTRAP } from '../src/instructions.ts';
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
  const PINNED = {
    ROUTINE_BOOTSTRAP: '6e5f4887dfd30c8cfb17e40bcca7313633fe10238dea8266febba89118cbc256',
    CLI_BOOTSTRAP: '644a19f89d05c783069dff5bdbf2da5051a0ac1ab7b38b51be1472723c8f9f29',
  };
  const texts = { ROUTINE_BOOTSTRAP, CLI_BOOTSTRAP };

  for (const name of Object.keys(PINNED) as (keyof typeof PINNED)[]) {
    test(`${name} is the text every install already pasted`, () => {
      const now = createHash('sha256').update(texts[name]).digest('hex');
      assert.equal(now, PINNED[name], [
        `${name} in src/instructions.ts changed. Every install must paste this bootstrap again; a deploy does not do it.`,
        'If you did not mean that, undo the change: text that can change belongs in the served instructions.',
        'If you did mean it:',
        '  1. Add an entry to CHANGELOG.md under [Unreleased], in an "### Action required" section, that says which agents',
        '     must get the new text and where to copy it from (/activate/grok or /activate/instinct).',
        `  2. Then set PINNED.${name} in test/release.test.ts to ${now}`,
        'See CONTRIBUTING.md, "Releasing".',
      ].join('\n'));
    });
  }
});
