# agent-bridge runbook

It runs on Vercel Hobby, with functions in a region near your database, and Postgres in a dedicated Supabase project. Use a dedicated Supabase project, never one shared with another product.
Deploying, migrating production, rotating keys or changing DNS is done by the owner, or needs the owner's explicit approval.

**Pending before M5:** the restore procedure below is written but untested. The PRD requires a real test.

**Alerts:** today they are only rows in `event`. Nobody receives a notice, and if the bridge goes down none is written. Check them by hand.

**Activating agents:** `/activate/grok` and `/activate/instinct`, on your deployment URL, give the steps with that deployment's URL. They are public and have no keys and do not touch the database. Full guides: `docs/agents.md` and `docs/email.md`.

## Environment variables

Names only. Values never go in the repo or in chat.

| Where | Variables |
|---|---|
| Vercel, **Production** only | `DATABASE_URL`, `BRIDGE_AGENT_KEYS`, `CRON_SECRET` |
| Vercel, **Production** only, optional | `DATABASE_CA_PEM`, `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_DOMAIN`, `EMAIL_TOKEN_SECRET`, `INSTINCT_EMAIL`, `OWNER_EMAIL`, `EMAIL_ALLOWED_SENDERS` |
| Supabase Vault | `bridge_url`, `bridge_cron_secret` |
| `.env.local` only, never in Vercel | `ADMIN_DATABASE_URL`, `BRIDGE_DB_PASSWORD`, `TEST_DATABASE_URL` |

`LUCAS_EMAIL` is still read as a fallback for `OWNER_EMAIL`, with a warning, until 0.3.0.

Production only, on purpose: a preview without variables answers 500 instead of talking to the real database. Without both Grok variables, or without the six required email variables (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_DOMAIN`, `EMAIL_TOKEN_SECRET`, `INSTINCT_EMAIL`, `OWNER_EMAIL`), that adapter does not load and its tasks stay queued without spending attempts. `EMAIL_ALLOWED_SENDERS` is optional and defaults to `INSTINCT_EMAIL`. Changing a variable does not affect what is already deployed: redeploy.

## Database TLS

`sslmode=require` encrypts but does not check who answers. Supabase provides its CA only from the dashboard, with a signed-in session, so the repo does not include it.

To enable verification: Database > Settings > SSL Configuration > Download Certificate. Paste the content into `DATABASE_CA_PEM` (it is not secret), in Vercel and in `.env.local`, and change `DATABASE_URL` and `ADMIN_DATABASE_URL` to `sslmode=verify-full`. With that variable set, the bridge and the scripts reject any other mode. **Untested:** there was no access to the real CA, and the only thing tested was that a wrong certificate is rejected against the real server.

## First deployment

Each step depends on the previous one. In particular, the Grok webhook goes last because the routine needs the `/mcp` URL, which does not exist until you deploy.

1. **Backup** (below), if there is already data.

2. **Check that `bridge` is not in Exposed schemas.** In Settings > Data API, "Exposed schemas" must not include it. Confirm from outside, with the publishable key:

   ```sh
   curl -s -H 'Accept-Profile: bridge' -H "apikey: $SUPABASE_PUBLISHABLE_KEY" "https://<ref>.supabase.co/rest/v1/agent"
   ```

   It must answer with the `PGRST106` error. If it returns rows or `[]`, stop: remove `bridge` from that list before going on.

3. **Migrate:** `pnpm db:migrate`, with `ADMIN_DATABASE_URL` in `.env.local`. Each file runs in a transaction and is recorded in `bridge.schema_migration`. On a new project, run `pnpm db:apply` first.

   **Role timeouts**, once, with the admin URL. A per-connection `statement_timeout` does not pass through the pooler in transaction mode, and without this the client's `query_timeout` does not stop the query on the server:

   ```sql
   ALTER ROLE bridge_app SET statement_timeout = '10s';
   ALTER ROLE bridge_app SET idle_in_transaction_session_timeout = '15s';
   ```

4. **Register the agents.** `bridge.agent` starts empty, and without a row each agent gets 403. The ids must match `BRIDGE_AGENT_KEYS`. With `psql` and the admin URL (see Backup to build `LIBPQ_URL`):

   ```sh
   psql -d "$LIBPQ_URL" -c "INSERT INTO bridge.agent (id, adapter) VALUES ('grok', 'grok'), ('claude', 'http') ON CONFLICT (id) DO NOTHING"
   psql -d "$LIBPQ_URL" -c "SELECT id, adapter, enabled FROM bridge.agent ORDER BY id"
   ```

   Check the result: `ON CONFLICT DO NOTHING` leaves a row with the wrong adapter unchanged. It must say `grok | grok | t`.

   **Instinct:** do not send it tasks until M3 is done and the email variables are loaded. `db/004_email.sql` already registers the row with the `email` adapter, and a task for an agent without an adapter waits and ends `failed` after 24 h.

5. **Create the Vercel project** from the repo, with the Hono preset. The entry file is `src/index.ts`, and `vercel.json` sets the region. Load `DATABASE_URL`, `BRIDGE_AGENT_KEYS` and `CRON_SECRET` (`openssl rand -hex 32`) for Production only.

6. **Deployment protection:** Settings > Deployment Protection > Vercel Authentication, with **Standard Protection** or "Only Preview Deployments" if shown. It must cover previews and leave the production domain open: `pg_net` and Grok Bot cannot sign in to Vercel. Never "All Deployments".

7. **Deploy** and verify. `<url>` is the production domain:

   ```sh
   curl -fsS https://<url>/health                                  # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' https://<url>/tasks/x  # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<url>/cron/dispatch  # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://<url>/activate/grok  # 200
   ```

8. **Smoke test as `bridge_app`.** `/health` and a 401 do not touch permissions; this does. It does one write, one replace and one search with the real code, through port 6543, in a transaction that always rolls back. With `DATABASE_URL` in `.env.local`:

   ```sh
   pnpm db:smoke   # {"wrote":true,"superseded":true,"found":true,"rolled_back":true}
   ```

9. **Cron in Supabase.** In the SQL Editor, with the real values, and close that tab afterwards:

   ```sql
   SELECT vault.create_secret('https://<url>', 'bridge_url');
   SELECT vault.create_secret('<the same value as CRON_SECRET>', 'bridge_cron_secret');
   ```

   `vault.create_secret` fails if the name already exists: to change a value, use `vault.update_secret` with its id, from `SELECT id, name FROM vault.secrets`.

   Then run `db/cron_dispatch.sql` as is. It can be repeated with no effect: a `cron.schedule` with the same name replaces the previous one. Verify after two minutes:

   ```sql
   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'bridge-dispatch';
   SELECT status_code, left(content::text, 80), created FROM net._http_response ORDER BY created DESC LIMIT 3;
   ```

   You should see `200` with `{"status":"ok","claimed":0}`. A `401` means the secret does not match `CRON_SECRET`.

   Limit: `pg_net` keeps the header in clear text in `net.http_request_queue` until it is sent, and any role with access to `pg_net` can read it. That token only triggers a pass, and it can be rotated.

10. **Uptime check:** an external service that calls `GET /health` every 5 minutes or more. It answers 200 or 503 and nothing else. Vercel restarts nothing because of this: it only serves to alert you. Each call is one invocation and one read.

11. **Activate Grok Bot** following `/activate/grok`: with the URL now created, configure the MCP and the routine. Then load `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_KEY` and redeploy. **G2 is done here**, with a test Bot.

## Later deployments

1. Backup, if the release has migrations.
2. Migrate **before** deploying: migrations are additive, and the new code may need them.
3. `git push` to the production branch, or `vercel deploy --prod`.
4. Repeat the checks from step 7 and `pnpm db:smoke`.

Rules for new migrations: `db/NNN_name.sql`, no hand-written schema names, no `BEGIN` or `COMMIT`, and their own `GRANT`s to `bridge_app`.

## Rollback

In Vercel, Deployments, pick an earlier one and "Instant Rollback". On Hobby you can only go back to the previous one.

This does not revert variables or migrations. Migrations only go forward: to undo one, write another or restore a backup.

## Hobby limits

| Resource | Included per month | Estimated cron usage |
|---|---|---|
| Invocations | 1,000,000 | 43,200 |
| Active CPU | 4 hours | About 0.2 h if the instance stays warm (15 ms per pass). About 2.2 h if every pass were a cold start (190 ms). Measured on a Mac, not on Vercel |
| Provisioned memory | 360 GB-h | About 48 GB-h: 2 GB for about 2 s per pass, counting 1 s to close connections. Estimated, not measured on Vercel |
| Duration per invocation | 300 s | A pass with deliveries, about 30 s in the usual worst case |
| Regions | 1 | A region near your database |
| Logs | 1 hour | No history: read `event` to audit |
| Vercel cron | Once a day | That is why the cron lives in Supabase |

- **If a limit is exceeded, Vercel may pause the project for up to 30 days.** Check Usage during the first week. If CPU or memory reaches half, lower the cron to every 2 or 5 minutes in `db/cron_dispatch.sql`: new tasks still go out right away, and only retries are delayed.
- Hobby is for personal, non-commercial use. That fits this bridge, and it is another reason not to put another product's data in it.
- With the email adapter loaded, each pass adds the queries for its pending results, even with no work.
- The one-line-per-request logs never carry the query or the body. `auth_failures` counts the 401s per instance and resets with it: use it to see an attack in progress, not as a total.

## Restart or stop

There is no process to restart. To stop everything:

1. `SELECT cron.unschedule('bridge-dispatch');` stops the per-minute passes. To resume, run `db/cron_dispatch.sql` again.
2. Settings > General > "Pause Project" in Vercel turns off the whole service, also for the agents.

## Kill switch

Run with `psql` and the admin URL. It takes effect without deploying.

Turn off one agent. Its API answers 403, the dispatcher stops delivering to it and stops delivering its tasks, and a `task_claim` for one of its tasks is no longer granted. A delivery in progress finishes, and deadlines keep expiring.

```sql
UPDATE bridge.agent SET enabled = false WHERE id = 'grok';
```

Turn it back on:

```sql
UPDATE bridge.agent SET enabled = true WHERE id = 'grok';
```

Turn off all agents:

```sql
UPDATE bridge.agent SET enabled = false;
```

Pause a pair of agents for an hour, also for `task_claim`. `agent_a` is the lower of the two ids in alphabetical order:

```sql
INSERT INTO bridge.pair_pause (agent_a, agent_b, paused_until, reason)
VALUES (LEAST('grok', 'instinct'), GREATEST('grok', 'instinct'), now() + interval '1 hour', 'manual')
ON CONFLICT (agent_a, agent_b) DO UPDATE SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason;
```

Remove the pause:

```sql
DELETE FROM bridge.pair_pause WHERE agent_a = LEAST('grok', 'instinct') AND agent_b = GREATEST('grok', 'instinct');
```

## Reading alerts

Read only, no session `SET`.

Alerts from the last day. The `alert` field is `deadline_exceeded`, `delivery_exhausted`, `pair_paused` or `grok_breaker_open`:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload->>'alert' AS alert, payload
FROM bridge.event WHERE type = 'alert' AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Stuck queue. It does not produce an alert row, so you must query it. It includes tasks for an agent with no adapter loaded, or turned off. If it is full, also check that the cron is running:

```sql
BEGIN READ ONLY;
SELECT id, to_agent, attempts, next_attempt_at FROM bridge.task
WHERE state = 'submitted' AND next_attempt_at < now() - interval '5 minutes' ORDER BY next_attempt_at;
ROLLBACK;
```

Active circuit breakers:

```sql
BEGIN READ ONLY;
SELECT agent_a, agent_b, paused_until, reason FROM bridge.pair_pause WHERE paused_until > now();
SELECT adapter, paused_until, reason FROM bridge.adapter_pause WHERE paused_until > now();
ROLLBACK;
```

Delivery failures:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload FROM bridge.event
WHERE type = 'delivery_failed' AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Secret filter rejections and writes over verified facts, without content:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, actor, type, payload FROM bridge.event
WHERE type IN ('secret_rejected', 'memory_rejected') AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Rebuild a conversation:

```sql
BEGIN READ ONLY;
SELECT e.* FROM bridge.event e JOIN bridge.task t ON t.id = e.task_id
WHERE t.root_id = '00000000-0000-0000-0000-000000000000' ORDER BY e.id;
ROLLBACK;
```

## Rotating keys

Every rotation needs the owner's approval. In Vercel, a variable change takes effect on redeploy.

- **An agent's key:** generate with `openssl rand -hex 32`, update the whole `BRIDGE_AGENT_KEYS` JSON and deploy, then update the key in the client. There is no overlap: the agent gets 401 until it has the new key. The `grok` key also goes in Grok Bot's secure card.
- **`GROK_WEBHOOK_KEY`:** regenerate the key in the Grok Bot routine, update the variable and deploy. If the URL changes, also `GROK_WEBHOOK_URL`. There is no overlap: between the two steps the webhook rejects deliveries, and the queue retries them with backoff. **To avoid spending attempts or tripping the circuit breaker**, pause the adapter before starting and resume it when done:

  ```sql
  INSERT INTO bridge.adapter_pause (adapter, paused_until, reason) VALUES ('grok', now() + interval '15 minutes', 'rotation')
  ON CONFLICT (adapter) DO UPDATE SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason;
  -- When done. UPDATE, not DELETE: without the row, earlier attempts count again.
  UPDATE bridge.adapter_pause SET paused_until = now() WHERE adapter = 'grok';
  ```

- **`CRON_SECRET`:** change the variable and deploy, and update `bridge_cron_secret` with `vault.update_secret`. Between the two steps, the cron gets 401 and tasks wait: nothing is lost.
- **`bridge_app` role:** in `psql` with the admin URL, `\password bridge_app`. Then update `DATABASE_URL` in Vercel and in `.env.local`, and deploy.
- **`postgres` role:** change it in the Supabase dashboard and update `.env.local`. Vercel does not use it.

## Backup

`psql` and `pg_dump` reject the `uselibpqcompat` parameter, and `pg_dump` must be version 17 or higher because the server is 17. Version 16 aborts: on a Mac, install with `brew install postgresql@17` and use the full path, without starting the service. The dump holds all the agents' memory, so it is encrypted and kept outside the repo:

```sh
export LIBPQ_URL="$(node --env-file=.env.local -p "const u = new URL(process.env.ADMIN_DATABASE_URL); u.searchParams.delete('uselibpqcompat'); u.href")"
mkdir -p -m 700 ~/agent-bridge-backups
/opt/homebrew/opt/postgresql@17/bin/pg_dump -d "$LIBPQ_URL" --schema=bridge --format=custom --no-owner --file="$HOME/agent-bridge-backups/bridge-$(date +%F).dump"
```

`*.dump` is in `.gitignore` just in case. Before a migration, check that the file exists and is not empty.

Supabase makes an automatic daily backup only on Pro plans or higher, with 7 days on Pro. On Free there is none, and this `pg_dump` would have to run daily to meet the PRD. Check Database > Backups.

## Restoring

**From the dashboard (Database > Backups):** it replaces the whole project and leaves it unavailable while it runs. Afterwards, reset the `bridge_app` password, because Supabase does not keep it in backups, and update `DATABASE_URL`.

**From a dump, into a new, dedicated project.** Never over the live schema. With `LIBPQ_URL` pointing at the new project:

```sh
psql -d "$LIBPQ_URL" -c "CREATE ROLE bridge_app LOGIN" -c "ALTER ROLE bridge_app SET search_path = bridge" -c "ALTER ROLE bridge_app SET statement_timeout = '10s'" -c "ALTER ROLE bridge_app SET idle_in_transaction_session_timeout = '15s'"
psql -d "$LIBPQ_URL" -c '\password bridge_app'
/opt/homebrew/opt/postgresql@17/bin/pg_restore -d "$LIBPQ_URL" --no-owner --single-transaction ~/agent-bridge-backups/bridge-YYYY-MM-DD.dump
```

The role is created first because the dump includes its permissions. To count the restore as tested:

1. Compare the row counts of `task`, `event` and `fact` with the source.
2. Deploy a preview against the new project and check `/health`, `pnpm db:smoke` and a test task.
3. Record here the date and how long it took.
