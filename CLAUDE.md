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

## Hard rules

- Never use a FreeTicket database or project.
- Never automate iMessage or WhatsApp, and never scrape `app.instinct.com`.
- No secrets in the repo, logs or chat.
- No push or deploy without Lucas's approval.
- `side_effect` tasks need approval in the bridge before delivery.

## Memory

Team memory is engram, project `agent-bridge` (`.engram/config.json`). Save decisions and non-obvious findings there.
