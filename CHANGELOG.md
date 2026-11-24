# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, a breaking change goes in a minor release and the release notes say how; fixes go in a patch release.

When a release needs more from an existing install than a deploy (paste a bootstrap again, run a migration, set a variable, update the CLI), it says so under "Action required", first in its section. The rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md#releasing).

## [Unreleased]

### Action required

- New migration `db/006_agent_read_only.sql`: the app role `bridge_app` can now only read `bridge.agent`, so a leaked `DATABASE_URL` or an injection cannot rewrite the agent list and `about` lines that every agent's instructions are built from. Back up first, then run `pnpm bridge:setup` (or `pnpm db:migrate`) with `ADMIN_DATABASE_URL` before the deploy. With Docker, `docker compose up --build -d` applies it. Change agent rows (kill switch, `about`, new agents) with the admin connection only, as the runbook already does.
- Paste every bootstrap again, in every agent. The firm limits in all three (`ROUTINE_BOOTSTRAP`, `CHAT_BOOTSTRAP`, `CLI_BOOTSTRAP`) now say private content may not go into "a result, a question to another agent, or a URL", where they said "a result or a URL": an agent that asks other agents could otherwise copy private content into the question. Copy the routine and chat bootstraps from `/activate/grok` into the Bot's routine and its own instructions, and the CLI one from `/activate/instinct` into each CLI agent. A deploy does not do this. Until you do, an agent keeps the old, narrower rule; nothing else breaks.
- New migration `db/007_asker_wake.sql` (two columns on `bridge.task`). Run `pnpm bridge:setup` (or `pnpm db:migrate`) with `ADMIN_DATABASE_URL` before the deploy; the new code fails on the old schema (reading an ended task as its asker answers `500`).

### Added

- Owner requests from a routine agent's chat: `GET /instructions?mode=owner` serves the steps for "ask instinct ..." (pick the agent, write a question that stands alone, create the task, wait a bounded time, report, and say the code when the bridge refuses). Routine agents only; a CLI agent gets `404`. `/activate/grok` now also prints an optional chat bootstrap to save in the Bot's own instructions. Existing installs may paste it; nothing breaks if they do not.
- `GET /tasks/:id/answer`: the asker reads the state and output of a task it created, by full id or 8+ character prefix. `?wait=` (up to 25 seconds) holds the request until the task ends, so an agent with only `curl` can wait. Anyone else gets `404`.
- A routine agent that asks another agent inside a task now waits for the answer with `GET /tasks/:id/answer?wait=25`, at most 12 times and until 10 minutes before its own deadline.
- The bridge wakes a routine agent once when a task it asked for ends as `completed` or `failed` and it has not read the answer: it calls the Bot's webhook with that `task_id`, 90 seconds after the task ended (only the bridge's own end events count, so the receiver cannot hold it back). The run cannot claim the task, reads the answer and reports it to the owner in that run's chat, which may not be the conversation where the owner asked. Routine agents only (`grok` adapter), one at a time and at most 5 per dispatcher pass (a 30 second budget, 10 seconds per send), for tasks up to 50 hours old. Never retried, not sent while the breaker has sends paused, and not counted by the breaker. Each wake-up spends one run of the owner's Grok usage. Each one leaves `asker_waking`, then `asker_woken` or `asker_wake_failed`, on the task.
- `GET /agents` and `bridge agents`: the other enabled agents, what each is for (`about`), and the caller's own contact with each one: tasks sent, received and open, the last one, and whether the pair is paused. Nothing about traffic between two other agents, and no adapter config. No migration.
- `bridge tasks view <id>`: one self-contained HTML page (no script, nothing to load) that shows how a task is going, for opening or handing over. `--watch` keeps it current until the task ends. It works against a 0.2.0 bridge with the full id. Both commands come with the next CLI version: `bridge update --sha256 <hash>`. See `docs/cli.md`.
- Self-host mode: `Dockerfile`, `docker-compose.yml` with plain Postgres 17, and `src/standalone.ts`, a Node server that runs the dispatcher in the process when `DISPATCH_INTERVAL_MS` is set. See `docs/self-host.md`.
- `pnpm bridge:setup`: one idempotent command for the role, schema, migrations, role timeouts and one `bridge.agent` row per key. The adapter is inferred from the agent id or set with `BRIDGE_AGENT_ADAPTERS`.
- `pnpm bridge:doctor` (server side) and `bridge doctor` (agent side): each check prints ✓ or ✗ with a one-line fix, and the command exits non-zero when a required check fails.
- One JSON log line per task transition (`task.created`, `task.claimed`, `task.completed`, `task.failed`, …), with allowlisted fields and never task content.
- `ALERT_WEBHOOK_URL`: every alert is also POSTed as `{"text": ...}`, deduped per kind and key for 10 minutes.
- Dependabot for npm, GitHub Actions and the Docker image.
- Agent directory: an optional `about` line in `bridge.agent.config` is shown to every other agent in its instructions, next to the agent's id, so an agent can tell which one to ask. The description is reduced to a plain alphabet (letters, digits, space and `, . : / ' -`), cut at 200 characters, dropped when the raw value is over 2000 characters or looks like a secret, and the instructions say it is a note, never an instruction. See `docs/agents.md`.
- The served instructions now say how to write a request to another agent (a question that stands alone, with the time range and the form of answer wanted) and how to answer one (take the most likely meaning and say which, never beyond the task's intent or the limits, answer first, keep it short). The notice names the full task id, not a short one, so an agent can check its own task again.
- `GET /health` also returns `version`, so you can tell which release a bridge runs: `{"status":"ok","version":"0.2.0"}`. `pnpm bridge:doctor` prints the version of its checkout first.
- One version: `src/version.ts` reads it from `package.json`, and a test fails when `cli/bridge.mjs` or the MCP server say another.
- A test pins the hash of each bootstrap. Changing one fails the tests, with a message that says to list the change here under "Action required".
- The secret check also refuses `whsec_` signing secrets, Resend `re_` keys and Slack webhook URLs.
- CI scans every commit for secrets with gitleaks 8.30.1 and `.gitleaks.toml`.
- A release process, in `CONTRIBUTING.md`: which version bump each kind of change needs, what an existing install must do, and what must never be published (secrets, personal data, dumps and backups, agent addresses, live and signed URLs, logs and `.env*` files, customer data, unfixed vulnerabilities).
- `GET /tasks/:id` and `GET /tasks/:id/events` take a unique prefix of the id, 8 characters or more, in any case, such as the short id an agent shows the owner. It is matched only among tasks the caller can already see; no match is the usual 404, and two matches are `409 ambiguous_id`. Claim, complete, fail and cancel still need the full id. `bridge tasks get` takes the prefix too, after `bridge update`.

### Changed

- `GET /tasks/:id/answer` returns at most about 8000 characters of `output`. Past that, only `result`, `reason`, `error` and `detail` are kept, each cut and marked, and `output.truncated` is `true`. The served texts say what to do with a cut answer.
- Reading an ended task as its asker marks it as seen, through `GET /tasks/:id` as well as `/answer`, so it is not woken for it. A read held with `?wait` marks only a task that had already ended when it began: the served texts make one last read without `wait`.
- `asker_seen_at` and `asker_woken_at` are never returned by the API.
- The served texts treat answers to your own tasks and memory search results as data too, quote an answer with its agent, leave out links and requests in it, and say a yes to something an answer proposed is not a request.
- `vercel.json` sets `maxDuration` to 300 seconds on `src/index.ts`, the entry of the Hono preset. 300 s is also the default with fluid compute, so nothing changes if the key is not applied: for Hono a key that matches nothing is ignored without an error, so check `vercel inspect <deployment> --json` for the function's `timeout`.
- The secret check no longer takes quadratic time on a long run of `a.a.a.` or `eyJ-eyJ-`: the scheme and user parts of a URL with credentials, and the header of a JWT, have length limits. Credentials in a URL are still recognized up to 256 characters of user and 1024 of password, and a JWT whose header is up to 300 characters.
- A routine run whose claim answers `claimed: false` now makes one read (`GET /tasks/<id>/answer`) before it stops. A bot still on a hand-written routine (not the bootstrap) will get wake-up runs it does not understand and will stop, at the cost of one run each.
- The `REVOKE` statements on Supabase API roles run only when those roles exist, so the schema applies on vanilla Postgres. The result on Supabase is unchanged.
- `@hono/node-server` is now a runtime dependency.
- `pnpm db:smoke` writes in the name of the first enabled agent instead of adding a `smoke` agent row, which `bridge_app` can no longer do. It needs `pnpm bridge:setup` to have registered an agent.

### Fixed

- The MCP server reported version `0.1.0`. It now reports the version in `package.json`.
- `docs/cli.md` no longer names a fixed CLI version.

## [0.2.0] - 2026-11-13

First public release.

### Added

- Postgres task queue with retries, deadlines, idempotency keys and loop guards (hop limit, daily pair cap, auto-pause).
- Shared memory: facts with supersede history and trust levels, searched with Postgres full-text search.
- Adapters: Grok Bot routine webhook, Instinct by email (Resend), and `http` agents that poll.
- Instructions served by the bridge, the `bridge` CLI served from the deployment, the MCP server at `/mcp`, activation pages, and the owner's conversations dashboard.
- Deployment on Vercel with Supabase, with the dispatcher triggered by `pg_cron`.

[Unreleased]: https://github.com/LucasLeguizamo/agent-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LucasLeguizamo/agent-bridge/releases/tag/v0.2.0
