// A real OS process running the real dispatcher pass. Every delivery is logged in Postgres.
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { runOnce, type Adapters } from '../src/queue.ts';

const pool = new pg.Pool({ connectionString: process.env.WORKER_DATABASE_URL!, max: 3 });
const adapters: Adapters = {
  fake: {
    async deliver(task) {
      await pool.query('INSERT INTO delivery_log (task_id, idempotency_key, pid) VALUES ($1, $2, $3)',
        [task.id, task.idempotency_key, process.pid]);
      await sleep(3); // Holds the batch open so the two processes overlap.
    },
  },
};

process.once('message', async () => {
  while ((await runOnce(pool, adapters)) > 0);
  await pool.end();
  process.send!('done', () => process.exit(0));
});
process.send!('ready');
