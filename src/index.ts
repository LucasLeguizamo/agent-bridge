// Vercel's entry: it detects this path and needs a default export of a file that imports hono.
import { Hono } from 'hono';
import { mountActivation } from './activation.ts';
import { createBridge } from './bridge.ts';

// Built on the first request, so a build that imports this file without settings cannot fail, and a bad setting fails
// closed with a log line instead of a crash loop. Activation pages hold no settings and stay up even then.
let bridge: ReturnType<typeof createBridge> | undefined;
const pages = new Hono<{ Variables: { agent: string } }>();
mountActivation(pages);

const app = new Hono();
app.all('*', async (c) => {
  try {
    bridge ??= createBridge(process.env);
  } catch (e) {
    console.error((e as Error).message);
    const page = await pages.fetch(c.req.raw);
    return page.status === 404 ? c.json({ error: 'misconfigured' }, 500) : page;
  }
  return bridge.app.fetch(c.req.raw);
});

export default app;
