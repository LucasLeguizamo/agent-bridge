import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

/** Disposable local cluster in a temp dir. It deliberately ignores DATABASE_URL: tests can only touch this one. */
export async function startThrowawayPostgres() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-pg-'));
  const data = join(dir, 'data');
  const port = await freePort();
  execFileSync('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`;
  execFileSync('pg_ctl', ['-D', data, '-w', '-l', join(dir, 'log'), '-o', opts, 'start'], { stdio: 'ignore' });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const schemaSql = () => readFileSync(new URL('../db/001_core.sql', import.meta.url), 'utf8');
