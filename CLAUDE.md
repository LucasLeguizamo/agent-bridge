# agent-bridge

Shared memory and async invocation between Instinct and Grok Bot. `PRD.md` is the source of truth; read it before changing behavior. Code and technical text are in English. Reports to Lucas are in Spanish.

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

Project skills live in `.claude/skills/` as pinned copies. Each agent preloads its own through the `skills` field. To update one, review the new content first; it is injected into agents as instructions.

| Skill | Source | Used by |
|---|---|---|
| `hono` | `honojs/skills` at `e54ce51`, MIT | core-queue, instinct-email, grok-mcp |
| `zod` | `pproenca/dot-skills`, copied from free-admin | core-queue, memory, instinct-email, grok-mcp |
| `supabase` | `supabase/agent-skills`, copied from free-admin | ops, security-auditor |
| `supabase-postgres-best-practices` | `supabase/agent-skills`, MIT, copied from free-admin | core-queue, memory, ops |
| `mcp-builder` | Anthropic, Apache 2.0 | grok-mcp |
| `tdd` | `mattpocock/skills` 1.3.1, MIT | core-queue, memory, instinct-email, grok-mcp, qa-reviewer |
| `diagnosing-bugs` | `mattpocock/skills` 1.3.1, MIT | core-queue, ops |

Project overrides:

- `tdd`: the acceptance criteria in PRD section 11 are the agreed seams. Do not stop to ask Lucas to confirm them.
- `hono`: this is a Node service. Ignore Cloudflare setup, and do not run `npx hono` tools without a pinned local dependency.
- `supabase`: the bridge connects with `pg`, not `supabase-js`. Every table needs protection from the Data API: private schema or RLS, verified.

## Hard rules

- Never use a FreeTicket database or project.
- Never automate iMessage or WhatsApp, and never scrape `app.instinct.com`.
- No secrets in the repo, logs or chat.
- No push or deploy without Lucas's approval.
- `side_effect` tasks need approval in the bridge before delivery.

## Memory

Team memory is engram, project `agent-bridge` (`.engram/config.json`). Save decisions and non-obvious findings there.
