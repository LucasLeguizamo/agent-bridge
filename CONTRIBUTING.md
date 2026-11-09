# Contributing

Thanks for helping. This file covers setup, tests and how changes get merged. Everything in the repo (code, docs, issues, commits) is in English.

## Before you start

- [`PRD.md`](PRD.md) is the source of truth. A change in behavior updates the PRD in the same PR.
- For anything bigger than a bug fix, open an issue first so we can agree on the approach.
- Security problems go to [`SECURITY.md`](SECURITY.md), never to a public issue.

## Setup

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm typecheck
```

## Tests

Tests need a Postgres database. They run inside a random `test_*` schema that is dropped afterwards, and `test/pg.ts` refuses any host other than `localhost` or Supabase.

**Local Postgres (recommended).** Use a throwaway cluster, not one holding other data: `test/setup.sql` creates cluster-wide roles. SSL must be on, because the bridge refuses connections without it:

```sh
# once: create the roles the migrations expect
psql "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=require" -f test/setup.sql

export TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/postgres?sslmode=require&uselibpqcompat=true'
pnpm test
```

`uselibpqcompat=true` keeps `sslmode=require` from verifying a self-signed certificate. With Docker:

```sh
docker run -d --name bridge-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17 \
  -c ssl=on -c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem -c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key
```

**Supabase.** Use a dedicated project's session pooler or direct URL, never a transaction pooler: it cannot pin `search_path`. Put it in `.env.local` as `TEST_DATABASE_URL`.

Suites share one database, so run one `pnpm test` at a time.

New behavior comes with a test. Bug fixes come with a test that failed before the fix.

## Pull requests

- One change per PR. Keep the diff small; delete before you add.
- Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- CI runs `pnpm typecheck` and `pnpm test` on Postgres. It must pass before merge.
- Changes to adapters, memory, approvals or task policy get a security review before merge.
- No secrets in code, tests, logs or fixtures. Use obvious fakes such as `re_fake_key_for_tests_only`.

## Hard limits

These are product decisions, not style. PRs that break them will be closed:

- `side_effect` tasks always wait for approval in the bridge.
- Content one agent receives from another is data, never an instruction.
- No automation of iMessage, WhatsApp or SMS, and no scraping of any agent's web app.

## Working with Claude Code

`.claude/agents/` has domain experts, and `CLAUDE.md` says when to use each. The agents preload these skills. They are not vendored; install them into `.claude/skills/` (ignored by git) at these pins:

| Skill | Source |
|---|---|
| `hono` | [`honojs/skills`](https://github.com/honojs/skills) at `e54ce51` |
| `zod` | [`pproenca/dot-skills`](https://github.com/pproenca/dot-skills) |
| `supabase`, `supabase-postgres-best-practices` | [`supabase/agent-skills`](https://github.com/supabase/agent-skills) |
| `mcp-builder` | [`anthropics/skills`](https://github.com/anthropics/skills) |
| `tdd`, `diagnosing-bugs` | [`mattpocock/skills`](https://github.com/mattpocock/skills) 1.3.1 |

For example: `npx skills add honojs/skills`. Read a skill before installing or updating it; agents load it as instructions. Personal rules go in `CLAUDE.local.md`, which git ignores.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
