# Self-hosting

Run the bridge and its Postgres on one machine, with Docker. The primary path is still Vercel and Supabase ([`runbook.md`](runbook.md)); this one needs no Supabase, no pg_cron and no Vercel account.

What changes compared with Vercel:

- `src/standalone.ts` is a long-running Node process. With `DISPATCH_INTERVAL_MS` set (compose sets `60000`), it runs the dispatcher pass itself, once a minute, instead of pg_cron calling `POST /cron/dispatch`. A new task is still dispatched at once.
- Postgres runs in a container with TLS on (a self-signed certificate), so the bridge keeps `sslmode=require`: encrypted, not verified, on a network only the two containers share.
- Plain Postgres has no Supabase Data API, so there is no `PGRST106` check to make.

Size: the two containers use about 90 MB of memory when idle (measured: bridge 56 MB, Postgres 31 MB) and 50 MB of disk. Any server with 1 GB of RAM is enough. Use a server that is always on, not a laptop.

## Quick start

Needs Docker with Compose v2.

```sh
git clone <this repo> agent-bridge && cd agent-bridge
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
BRIDGE_DB_PASSWORD=$(openssl rand -hex 32)
BRIDGE_AGENT_KEYS={"grok":"$(openssl rand -hex 32)","claude":"$(openssl rand -hex 32)"}
EOF
docker compose up --build -d
docker compose logs setup     # one line per step: done, already done or skipped, and why
curl -fsS http://127.0.0.1:3000/health   # {"status":"ok","version":"0.2.0"}
docker compose exec bridge node db/doctor.ts
```

`.env` is ignored by git and never enters the image. The passwords must be hex: they go into connection URLs. Compose builds `DATABASE_URL` and the admin URL from them; do not set those two in `.env`.

On every `docker compose up`, the one-shot `setup` service creates the `bridge_app` role and the `bridge` schema if missing, applies pending migrations, sets the role timeouts and registers every agent id in `BRIDGE_AGENT_KEYS`. Then the bridge starts. The adapter is inferred from the id (`grok` is `grok`, `instinct` is `email`, anything else is `http`), or set it with `BRIDGE_AGENT_ADAPTERS={"my-agent":"http"}`. Setup never changes an agent row that already exists; its line says so if the adapter differs.

The other variables (`GROK_WEBHOOK_URL`, the email variables, `DASHBOARD_TOKEN`) go in the same `.env`, as the README describes. `CRON_SECRET` is not needed here. After changing `.env`: `docker compose up -d`.

To try it, create a task as one agent and claim it as the other:

```sh
curl -s -X POST -H "authorization: Bearer $GROK_KEY" -H 'content-type: application/json' http://127.0.0.1:3000/tasks \
  -d '{"to_agent":"claude","intent":"research","input":{"query":"hello"},"idempotency_key":"try-1"}'
curl -s -X POST -H "authorization: Bearer $CLAUDE_KEY" http://127.0.0.1:3000/tasks/<task id>/claim
```

## When something is wrong

- **On the server:** `docker compose exec bridge node db/doctor.ts`. It checks the variables, the database, the role timeouts, that every agent is registered, which adapters are loaded, that the dispatcher is keeping up and the alerts from the last day. Each line is `✓`, `✗` (exit code 1), `!` (a warning) or `-` (skipped), with a fix. Without Docker: `pnpm bridge:doctor`.
- **On an agent's machine:** `bridge doctor` checks the URL, `/health`, the token and that the agent is enabled, with only the agent's own token.
- Logs: `docker compose logs -f bridge`. One JSON line per request, never with a body or a query, and one per task step:

  | `event` | Meaning |
  |---|---|
  | `task.created`, `task.held` | Accepted; held waits for the owner's approval |
  | `task.rejected`, `pair.paused` | Stopped by a guard; `reason` says which (`hop_limit`, `daily_cap`, …) |
  | `task.delivered`, `task.woken`, `task.claimed` | Handed to the receiver, its routine woken, picked up |
  | `task.retry`, `task.completed`, `task.failed`, `task.expired`, `task.canceled` | Outcome |
  | `breaker.opened` | An adapter stopped being woken after failures |

  Fields: `ts, event, task, intent, from, to, state, attempt, ms` and an optional `reason` code. Never task input, output, memory text or email addresses.

Note: `pnpm setup` and `pnpm doctor` are pnpm's own commands (`pnpm setup` edits your shell profile). The bridge's are `pnpm bridge:setup` and `pnpm bridge:doctor`.

## On a VPS, with TLS

Agents must reach the bridge over https. Compose publishes the bridge on `127.0.0.1:3000` only; put a proxy that gets certificates on its own in front of it. With [Caddy](https://caddyserver.com/docs/install) on the host, and a DNS record for your name pointing at the server:

```text
# /etc/caddy/Caddyfile
bridge.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy`, then `curl -fsS https://bridge.example.com/health`. Open only ports 22, 80 and 443 in the firewall. Docker's `restart: unless-stopped` brings the containers back after a crash or a reboot, as long as the Docker service starts on boot (`sudo systemctl enable docker`).

**Uptime:** point an external monitor at `https://bridge.example.com/health` every 5 minutes. It answers 200 or 503, and nothing else; it holds no key and caches its answer for 30 s. Docker restarts a dead process, but only an outside check tells you when the machine itself is down.

## Backups

A daily dump of the `bridge` schema, from the host's crontab. It holds all the agents' memory: keep it out of the repo, with mode 600, and copy it off the server.

```sh
mkdir -p -m 700 ~/agent-bridge-backups
# crontab -e
15 3 * * * cd ~/agent-bridge && umask 077 && docker compose exec -T postgres pg_dump -U postgres -d bridge --schema=bridge --format=custom --no-owner > ~/agent-bridge-backups/bridge-$(date +\%F).dump && find ~/agent-bridge-backups -name '*.dump' -mtime +14 -delete
```

Check that the newest file is not empty before any upgrade.

## Restore

Into a new, empty volume, never over the live one. A second compose project gets its own volume, so the old one stays untouched until the new one is proven. Tested on 14 Nov 2026 with this compose file: the row counts of `agent`, `task`, `event` and `schema_migration` matched, the restored bridge answered `/health`, created and claimed a task and wrote a fact as `bridge_app`, and `db/doctor.ts` passed. It took 8 s for a small database.

```sh
export BRIDGE_PORT=3001 BRIDGE_DB_PASSWORD=$(grep '^BRIDGE_DB_PASSWORD=' .env | cut -d= -f2-)
docker compose -p bridge-restore up -d postgres
docker compose -p bridge-restore exec -T -e BRIDGE_DB_PASSWORD postgres psql -U postgres -d bridge -v ON_ERROR_STOP=1 <<'SQL'
\getenv pw BRIDGE_DB_PASSWORD
CREATE ROLE bridge_app LOGIN PASSWORD :'pw';
SQL
docker compose -p bridge-restore exec -T postgres pg_restore -U postgres -d bridge --no-owner --single-transaction < ~/agent-bridge-backups/bridge-YYYY-MM-DD.dump
docker compose -p bridge-restore up -d      # setup restores the role timeouts; everything else says "already done"
docker compose -p bridge-restore exec bridge node db/doctor.ts
curl -fsS http://127.0.0.1:3001/health
```

The role comes first because the dump holds its grants. Its password is read from the environment inside psql, so it never shows in a command line. To switch over: `docker compose down` on the old project, and point the proxy at port 3001 (or keep `BRIDGE_PORT=3001` in `.env`). Remove the old volume only once the new one has run for a while.

## Operating it

| Task | Command |
|---|---|
| Restart | `docker compose restart bridge` (it finishes the pass in progress, then exits) |
| Stop everything | `docker compose down` (the data volume stays) |
| Upgrade | read "Action required" in `CHANGELOG.md`, back up, `git pull`, `docker compose up --build -d` (setup applies new migrations first). `/health` then shows the new version |
| Pause one agent | `docker compose exec postgres psql -U postgres -d bridge -c "UPDATE bridge.agent SET enabled = false WHERE id = 'grok'"` |
| Resume it | the same with `enabled = true` |
| Rotate an agent key | change it in `BRIDGE_AGENT_KEYS`, `docker compose up -d`, then give the agent its new key |
| Rotate `bridge_app`'s password | `docker compose exec postgres psql -U postgres -d bridge -c '\password bridge_app'` with a new `openssl rand -hex 32`, the same value in `BRIDGE_DB_PASSWORD` in `.env`, then `docker compose up -d` |

The kill switch, alert queries and the rest of the safety rules are the same as on Supabase: [`runbook.md`](runbook.md). Changing `POSTGRES_PASSWORD` in `.env` after the first start does nothing: Postgres reads it only when the volume is created.
