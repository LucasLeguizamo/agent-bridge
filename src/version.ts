import { readFileSync } from 'node:fs';

// The one version of the bridge: package.json. cli/bridge.mjs keeps its own literal because agents download that file
// alone; test/release.test.ts fails if the two differ. Read like activation.ts reads the CLI, so Vercel's file tracing
// ships package.json; the Docker image copies it. A missing file must not take the bridge down: it says "unknown".
export const VERSION: string = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
