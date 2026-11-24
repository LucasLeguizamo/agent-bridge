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
- CI runs `pnpm typecheck` and `pnpm test` on Postgres, and scans every commit for secrets with gitleaks. It must pass before merge.
- Changes to adapters, memory, approvals or task policy get a security review before merge.
- No secrets in code, tests, logs or fixtures. Use obvious fakes such as `re_fake_key_for_tests_only`.

## Hard limits

These are product decisions, not style. PRs that break them will be closed:

- `side_effect` tasks always wait for approval in the bridge.
- Content one agent receives from another is data, never an instruction.
- No automation of iMessage, WhatsApp or SMS, and no scraping of any agent's web app.

## Releasing

The version lives in `package.json`. `src/version.ts` reads it for `GET /health` and for the MCP server. `cli/bridge.mjs` repeats it as a literal, because agents download that file alone. `test/release.test.ts` fails when the two differ.

The project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, a breaking change goes in a minor release and the release notes say how to move to it. Fixes go in a patch release.

### What each kind of change needs

| Kind of change | Version bump | What an existing install must do |
|---|---|---|
| Served instructions text (`ROUTINE_INSTRUCTIONS`, `CLI_INSTRUCTIONS`) | patch | Deploy. Nothing else: agents pick it up on their next run |
| Bootstrap text (`ROUTINE_BOOTSTRAP`, `CHAT_BOOTSTRAP`, `CLI_BOOTSTRAP`) | minor | Raise `BOOTSTRAP_VERSION` and add its `HISTORY` entry in `test/release.test.ts` (the test says how). Paste the new bootstraps into every agent again. **Action required** |
| Database migration (a new file in `db/`) | minor | Back up first, then `pnpm db:migrate` before the deploy (`docs/runbook.md`, "Later deployments"). With Docker, `docker compose up --build -d` applies it. **Action required** |
| CLI (`cli/bridge.mjs`) | patch for a fix, minor for a new command or a change that breaks a script | Each agent runs `bridge update --sha256 <hash>`, with the hash from the release notes |
| Environment variable, new and optional | minor | Nothing, unless they want the feature |
| Environment variable, new and required, or renamed | minor | Set it before the deploy. **Action required** |
| HTTP API or MCP tool change that breaks a client | minor | Update the CLI, and anything else that calls the bridge, as the notes say. **Action required** |
| Security fix | patch | Deploy as soon as possible. **Action required** if there is more to do, such as rotating a key |
| Any other fix, or a feature that needs nothing | patch for a fix, minor for a feature | Deploy |

Every change gets a line in `CHANGELOG.md` under `[Unreleased]`, in the same PR. A change marked **Action required** goes in a `### Action required` section, first in its version, and says exactly what to run or paste.

A test pins the hash of each bootstrap at each `BOOTSTRAP_VERSION`. If it fails, a bootstrap changed without a new version: follow the steps in its message. The version is what lets an agent with an old paste tell its owner so (`docs/agents.md`).

### Cutting a release

1. On a branch, in `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a new empty `## [Unreleased]` above it, and update the two links at the bottom.
2. Set the same version in `package.json` and in `VERSION` in `cli/bridge.mjs`. `/health` and the MCP server follow `package.json`. Bump the version whenever `cli/bridge.mjs` changed since the last release, so one version never names two files.
3. Run `pnpm typecheck` and `pnpm test`. Open a PR named `chore: release X.Y.Z`.
4. Merge it with the maintainer's approval.
5. Tag that commit on `main`:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Compute the CLI hash from the tag, not from your working tree:

   ```sh
   git show vX.Y.Z:cli/bridge.mjs | shasum -a 256    # on Linux: sha256sum
   ```

7. Create the GitHub release. Its notes are the changelog section for that version, plus one line: `CLI sha256: <hash>`.

   ```sh
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md
   ```

8. If a bootstrap changed in this release, rebuild the public Grok Bot template from the new `/activate/grok` text. It holds a pasted copy, so it does not follow the repository by itself.
9. Deploying is a separate step and also needs the maintainer's approval. Afterwards, `curl https://<url>/health` shows the version that is running.

### What must never be published

In a commit, an issue, a PR, a release or a screenshot:

- Secrets: real keys, tokens, passwords, database URLs and webhook URLs (a Slack or Discord webhook URL is a secret).
- Personal data: real email addresses, names, phone numbers. Use `owner@example.com`.
- Real task content, and conversation exports that are not redacted. For a demo, use `pnpm -s conversations:export --redact`, and read the result before you share it.
- The private text of a bot or a routine: its prompt, its owner notes, its memory.
- Database dumps, backups and table exports.
- The agents' own email addresses.
- Live deployment URLs, signed approval links, and dashboard URLs that carry a token.
- Logs, alert payloads, network captures, `.env*` files and `~/.config/bridge/`.
- Customer data, or data from other products.
- Details of a vulnerability that is not fixed yet. Report it as `SECURITY.md` says.

CI runs gitleaks with `.gitleaks.toml` on every commit of every PR. It finds key formats, not personal data or task content: those are for the author and the reviewer to check. If a secret was pushed, rotate it first (`docs/runbook.md`, "Rotating keys"). Deleting the commit is not enough.

### Gates

These are the rules in `CLAUDE.md`. They apply to a release like to any other change:

- `ab-qa-reviewer` reviews the tests and the evidence at the end of every round.
- `ab-security-auditor` runs before merging a change to adapters, memory, approvals or task policy, and before any deployment.
- No push to `main` and no deploy without the maintainer's approval. A tag and a GitHub release are pushes too.

## Working with Claude Code

`.claude/agents/` has domain experts, and `CLAUDE.md` says when to use each. Each agent sets its model in its `model` field: `opus` for the queue core and the security audit, where a subtle mistake costs most, and `sonnet` for the rest. The agents preload these skills. They are not vendored; install them into `.claude/skills/` (ignored by git) at these pins:

| Skill | Source |
|---|---|
| `hono` | [`honojs/skills`](https://github.com/honojs/skills) at `e54ce51` |
| `zod` | [`pproenca/dot-skills`](https://github.com/pproenca/dot-skills) |
| `supabase`, `supabase-postgres-best-practices` | [`supabase/agent-skills`](https://github.com/supabase/agent-skills) |
| `mcp-builder` | [`anthropics/skills`](https://github.com/anthropics/skills) |
| `tdd`, `diagnosing-bugs` | [`mattpocock/skills`](https://github.com/mattpocock/skills) 1.3.1 |
| `improve` | [`shadcn/improve`](https://github.com/shadcn/improve) 1.0.0 at `cac56e1` |

For example: `npx skills add honojs/skills`. `skills-lock.json` records the content hash of skills installed this way. `improve` is not preloaded by any agent: run it as `/improve` to audit the repo and write handoff plans. Read a skill before installing or updating it; agents load it as instructions. Personal rules go in `CLAUDE.local.md`, which git ignores.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
