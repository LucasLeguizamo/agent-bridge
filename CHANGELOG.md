# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor release may break things; the release notes say how.

## [Unreleased]

### Added

- Self-host mode: `Dockerfile`, `docker-compose.yml` with plain Postgres 17, and `src/standalone.ts`, a Node server that runs the dispatcher in the process when `DISPATCH_INTERVAL_MS` is set. See `docs/self-host.md`.
- `pnpm bridge:setup`: one idempotent command for the role, schema, migrations, role timeouts and one `bridge.agent` row per key. The adapter is inferred from the agent id or set with `BRIDGE_AGENT_ADAPTERS`.
- `pnpm bridge:doctor` (server side) and `bridge doctor` (agent side): each check prints ✓ or ✗ with a one-line fix, and the command exits non-zero when a required check fails.
- One JSON log line per task transition (`task.created`, `task.claimed`, `task.completed`, `task.failed`, …), with allowlisted fields and never task content.
- `ALERT_WEBHOOK_URL`: every alert is also POSTed as `{"text": ...}`, deduped per kind and key for 10 minutes.
- Dependabot for npm, GitHub Actions and the Docker image.

### Changed

- The `REVOKE` statements on Supabase API roles run only when those roles exist, so the schema applies on vanilla Postgres. The result on Supabase is unchanged.
- `@hono/node-server` is now a runtime dependency.

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
