# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, a breaking change goes in a minor release and the release notes say how; fixes go in a patch release.

When a release needs more from an existing install than a deploy (paste a bootstrap again, run a migration, set a variable, update the CLI), it says so under "Action required", first in its section. The rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md#releasing).

## [Unreleased]

### Action required

- New migration `db/006_agent_read_only.sql`: the app role `bridge_app` can now only read `bridge.agent`, so a leaked `DATABASE_URL` or an injection cannot rewrite the agent list and `about` lines that every agent's instructions are built from. Back up first, then run `pnpm bridge:setup` (or `pnpm db:migrate`) with `ADMIN_DATABASE_URL` before the deploy. With Docker, `docker compose up --build -d` applies it. Change agent rows (kill switch, `about`, new agents) with the admin connection only, as the runbook already does.

### Added

- Self-host mode: `Dockerfile`, `docker-compose.yml` with plain Postgres 17, and `src/standalone.ts`, a Node server that runs the dispatcher in the process when `DISPATCH_INTERVAL_MS` is set. See `docs/self-host.md`.
- `pnpm bridge:setup`: one idempotent command for the role, schema, migrations, role timeouts and one `bridge.agent` row per key. The adapter is inferred from the agent id or set with `BRIDGE_AGENT_ADAPTERS`.
- `pnpm bridge:doctor` (server side) and `bridge doctor` (agent side): each check prints ✓ or ✗ with a one-line fix, and the command exits non-zero when a required check fails.
- One JSON log line per task transition (`task.created`, `task.claimed`, `task.completed`, `task.failed`, …), with allowlisted fields and never task content.
- `ALERT_WEBHOOK_URL`: every alert is also POSTed as `{"text": ...}`, deduped per kind and key for 10 minutes.
- Dependabot for npm, GitHub Actions and the Docker image.
- Agent directory: an optional `about` line in `bridge.agent.config` is shown to every other agent in its instructions, next to the agent's id, so an agent can tell which one to ask. The description is reduced to a plain alphabet (letters, digits, space and `, . : / ' -`), cut at 200 characters, dropped when the raw value is over 2000 characters or looks like a secret, and the instructions say it is a note, never an instruction. See `docs/agents.md`.
- The served instructions now say how to write a request to another agent (a question that stands alone, with the time range and the form of answer wanted) and how to answer one (take the most likely meaning and say which, never beyond the task's intent or the limits, answer first, keep it short). The notice names the full task id, not a short one, so an agent can check its own task again. No bootstrap changed: nothing to paste again.
- `GET /health` also returns `version`, so you can tell which release a bridge runs: `{"status":"ok","version":"0.2.0"}`. `pnpm bridge:doctor` prints the version of its checkout first.
- One version: `src/version.ts` reads it from `package.json`, and a test fails when `cli/bridge.mjs` or the MCP server say another.
- A test pins the hash of each bootstrap. Changing one fails the tests, with a message that says to list the change here under "Action required".
- The secret check also refuses `whsec_` signing secrets, Resend `re_` keys and Slack webhook URLs.
- CI scans every commit for secrets with gitleaks 8.30.1 and `.gitleaks.toml`.
- A release process, in `CONTRIBUTING.md`: which version bump each kind of change needs, what an existing install must do, and what must never be published (secrets, personal data, dumps and backups, agent addresses, live and signed URLs, logs and `.env*` files, customer data, unfixed vulnerabilities).
- `GET /tasks/:id` and `GET /tasks/:id/events` take a unique prefix of the id, 8 characters or more, in any case, such as the short id an agent shows the owner. It is matched only among tasks the caller can already see; no match is the usual 404, and two matches are `409 ambiguous_id`. Claim, complete, fail and cancel still need the full id. `bridge tasks get` takes the prefix too, after `bridge update`.

### Changed

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
