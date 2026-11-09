# agent-bridge

Shared memory and async task delegation between always-on AI agents that were never built to talk to each other.

Agents that run on someone else's platform (Grok Bot, Instinct, a local Claude) rarely have an API you can call. agent-bridge gives each one a mailbox: a small Postgres-backed service where any agent can hand a task to another, wait for the result, and read and write a shared memory with provenance. Each agent is reached through what it already has: a webhook routine, an email, or a CLI it polls.

- **Tasks:** `research`, `summarize` and `memory.write`, with retries, deadlines, idempotency keys and loop guards (hop limit, daily pair cap, auto-pause).
- **Risk is decided by the bridge, not the sender.** Read tasks are delivered at once; anything that could change the world is held until the owner approves it.
- **Shared memory:** facts with supersede history and trust levels, searched with Postgres full-text search.
- **Instructions served by the bridge:** each agent gets a short bootstrap once, and fetches its working instructions on every run. Deploy, and every agent is updated.

Design and rationale: [`PRD.md`](PRD.md).

## How it works

```text
 agent A ──POST /tasks──▶  bridge (Postgres queue)  ──wake──▶  agent B
                              │        ▲                       │
                              │        └── claim / complete ───┘
                              └── shared memory (facts, events)
```

1. Agent A creates a task. The bridge sets its risk from the intent and input shape.
2. The dispatcher wakes agent B through its adapter: a webhook (`grok`), an email (`email`), or nothing, because B polls (`http`).
3. B fetches its instructions (`GET /instructions`), claims the task, does it, and closes it with an output.
4. A reads the result with `GET /tasks/:id`.

## Quick start

Requires Node 24, pnpm and a dedicated Postgres database (Supabase is what it is tested on). Deploys to Vercel.

```sh
pnpm install
cp .env.example .env.local     # fill in DATABASE_URL, ADMIN_DATABASE_URL, BRIDGE_AGENT_KEYS
pnpm db:apply && pnpm db:migrate
pnpm test                      # needs TEST_DATABASE_URL, see CONTRIBUTING.md
```

Register each agent, with the id used in `BRIDGE_AGENT_KEYS` and its adapter:

```sql
INSERT INTO bridge.agent (id, adapter) VALUES ('grok', 'grok'), ('instinct', 'email'), ('claude', 'http');
```

Then deploy (see [`docs/runbook.md`](docs/runbook.md)) and open `/activate/grok` or `/activate/instinct` on your deployment for the setup steps, with your URL filled in.

## Configuration

Only two variables are required. Each adapter loads only when its own variables are set; until then its tasks wait without spending attempts.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | App role, transaction pooler |
| `BRIDGE_AGENT_KEYS` | yes | `{"agent-id": "key of 32+ chars"}` |
| `CRON_SECRET` | for the dispatcher | Bearer for `POST /cron/dispatch` |
| `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY` | routine adapter | From the Grok Bot routine panel |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_DOMAIN`, `EMAIL_TOKEN_SECRET`, `INSTINCT_EMAIL`, `OWNER_EMAIL` | email adapter | See [`docs/email.md`](docs/email.md) |
| `EMAIL_ALLOWED_SENDERS`, `DATABASE_CA_PEM` | no | Defaults: `INSTINCT_EMAIL`; TLS encrypted but not verified |

## Updating your agents

- **Instructions:** edit `src/instructions.ts`, then deploy. Agents fetch the new text on their next run. `GET /instructions` returns a `version` hash, so you can tell which text an agent used.
- **CLI:** ask an agent to run `bridge update --sha256 <hash>`. It installs the CLI your bridge serves only if the hash matches a release you trust.
- **Bootstraps:** paste one again only when a release says the bootstrap changed.

Details: [`docs/agents.md`](docs/agents.md).

## Docs

| | |
|---|---|
| [`docs/agents.md`](docs/agents.md) | Connecting agents, autonomy, how instructions update |
| [`docs/cli.md`](docs/cli.md) | The `bridge` CLI |
| [`docs/email.md`](docs/email.md) | Email adapter and quarantine |
| [`docs/runbook.md`](docs/runbook.md) | Deploy, rotate keys, kill switch, backups |

## Safety model, in short

- Everything an agent receives from another agent is labelled as data, never as an instruction.
- Agents work without asking, but read only. Each bootstrap carries firm limits that the served instructions cannot remove.
- Inside a task, anything needing a click, form, login or approval ends as `needs_approval`.
- Secrets in task outputs are rejected. Tokens never leave the bridge's own host.
- Loop guards: 4 hops per chain, 2 child tasks per task, 20 tasks per agent pair per day, auto-pause on abuse.
- Kill switch: `UPDATE bridge.agent SET enabled = false WHERE id = '...'`.

Instinct's terms limit it to personal use; this project does not automate iMessage or WhatsApp, and does not scrape any agent's web app.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Report vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes.

## License

[MIT](LICENSE)
