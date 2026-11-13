# agent-bridge

Shared memory and async invocation between Instinct and Grok Bot. `PRD.md` is the source of truth; read it before changing behavior. Everything in the repo is in English. Personal overrides go in `CLAUDE.local.md`, which git ignores.

## Experts

Delegate by domain. Agents live in `.claude/agents/`.

| Task | Agent |
|---|---|
| Schema, queue, states, guards, task API | `ab-core-queue` |
| Facts, events, search, context packs | `ab-memory` |
| Email, Instinct adapter, flags, tokens | `ab-instinct-email` |
| Grok Bot webhook, routines, MCP server | `ab-grok-mcp` |
| Security audit (read-only) | `ab-security-auditor` |
| Test and evidence review (read-only) | `ab-qa-reviewer` |
| Container, Supabase, backups, alerts | `ab-ops` |

- `ab-qa-reviewer` runs at the end of every round.
- `ab-security-auditor` runs before merging adapter, memory, approval or policy changes, and before any deployment.

## Skills

Each agent preloads skills through its `skills` field. They are not vendored: install the pinned versions listed in `CONTRIBUTING.md` into `.claude/skills/` (git ignores it). Review a skill before updating it; it is injected into agents as instructions.

Project overrides:

- `tdd`: the acceptance criteria in PRD section 11 are the agreed seams. Do not stop to ask the maintainer to confirm them.
- `hono`: this is a Node service. Ignore Cloudflare setup, and do not run `npx hono` tools without a pinned local dependency.
- `supabase`: the bridge connects with `pg`, not `supabase-js`. Every table needs protection from the Data API: private schema or RLS, verified.

## Hard rules

- Never automate iMessage or WhatsApp, and never scrape `app.instinct.com`.
- No secrets in the repo, logs or chat.
- No push to `main` or deploy without the maintainer's approval.
- `side_effect` tasks need approval in the bridge before delivery.
