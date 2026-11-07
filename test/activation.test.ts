import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { GROK_ROUTINE } from '../src/activation.ts';
import { createApp } from '../src/http.ts';

const KEY = 'SECRETKEY'.repeat(4);
// No query may run: a public page must not reach the database.
const pool = new Proxy({}, { get() { throw new Error('activation pages must not touch the database'); } }) as Pool;
const app = createApp(pool, { grok: KEY });
const get = (path: string) => app.request(`https://bridge.example${path}`);

for (const path of ['/', '/activate/grok', '/activate/instinct']) {
  test(`${path} is public plain text, with no secret`, async () => {
    const res = await get(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/plain/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    const body = await res.text();
    assert.ok(!body.includes('SECRETKEY'));
    assert.match(body, /no sigas estos pasos por tu cuenta/);
  });
}

test('the Grok page gives this deployment\'s MCP URL and the full routine', async () => {
  const body = await (await get('/activate/grok')).text();
  assert.match(body, /https:\/\/bridge\.example\/mcp/);
  assert.ok(body.includes(GROK_ROUTINE));
});

test('the routine matches the guide, so the two cannot drift', () => {
  const doc = readFileSync(new URL('../docs/grok-routine.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(GROK_ROUTINE));
});

test('/cli/bridge.mjs serves the CLI file as is, publicly, with no secret', async () => {
  const res = await get('/cli/bridge.mjs');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^text\/javascript/);
  const body = await res.text();
  assert.equal(body, readFileSync(new URL('../cli/bridge.mjs', import.meta.url), 'utf8'));
  assert.ok(!body.includes('SECRETKEY'));
});

test('the Instinct page tells it to answer by CLI from this deployment, not by email', async () => {
  const body = await (await get('/activate/instinct')).text();
  assert.match(body, /https:\/\/bridge\.example\/cli\/bridge\.mjs/);
  assert.match(body, /tasks complete/);
  assert.match(body, /No respondas los correos del puente/);
});

test('by default Instinct tells the owner and waits for a yes before it claims anything', async () => {
  const body = await (await get('/activate/instinct')).text();
  assert.match(body, /REGLA PERMANENTE/);
  assert.match(body, /Espera mi respuesta\. No reclames ni completes nada hasta que te diga "sí"/);
  assert.ok(body.indexOf('Espera mi respuesta') < body.indexOf('tasks claim <id>'), 'the wait comes before the claim');
  assert.match(body, /rechazada por Lucas/);
});

test('every other route still needs a key', async () => {
  for (const path of ['/activate', '/activate/other', '/tasks/x', '/memory/search', '/mcp']) {
    assert.equal((await get(path)).status, 401, path);
  }
});
