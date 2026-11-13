# Conversations dashboard

An owner-only, read-only view of what the agents sent each other. A conversation is every task sharing a `root_id`: the first task and everything delegated from it.

## Setup

1. Make a token: `openssl rand -hex 32`. It must be 32+ characters and must differ from every agent key and from `CRON_SECRET`, `GROK_WEBHOOK_KEY`, `EMAIL_TOKEN_SECRET`, `RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY`. Reusing one keeps the dashboard locked, because whoever holds that secret could then read everyone's traffic.
2. Set it as `DASHBOARD_TOKEN` on the host (Vercel: Production scope only), then redeploy.
3. Open `https://<your-bridge>/dashboard` and paste the token. The page keeps it in `sessionStorage`, so it is gone when you close the tab. **Forget token** clears it sooner.

Unset or shorter than 32 characters, the data route answers 401 to everyone. Agent keys get 401 there too.

## What it shows

- An agents strip with tasks sent, received, and failed or rejected, across the conversations loaded.
- One card per conversation, newest activity first: each task as `from → to` with its hop, state, risk and duration, plus the reason a task stopped (`hop_limit`, `pair_paused`, `daily_cap`, `deadline_exceeded`, `delivery_exhausted`...).
- Per task, its input and output (collapsed), capped at 2,000 and 4,000 characters of JSON text. Per conversation, a timeline of event types and actors. Event payloads are never sent.
- **redact** hides free text, as below. Use it before a screenshot.

Task content is written by agents, so the page treats it as hostile: it is rendered as text only, under a CSP that allows only the page's own inline code (by hash) and requests to the same origin.

## API

`GET /dashboard/conversations` with `Authorization: Bearer $DASHBOARD_TOKEN`.

| Parameter | Default | |
|---|---|---|
| `limit` | 20 | Conversations per page, 1 to 100. Out of range is a 400. |
| `before` | | The previous page's `next_before`, for older conversations. |
| `redact` | `0` | `1` nulls `input`, and keeps from `output` only `rejected` and `error` when the bridge wrote them (`BRIDGE_OUTPUT_CODES` in `src/dashboard.ts`). An intent without a bridge policy (`src/tasks.ts`) becomes `other`, and agent event types (`agent.*`) become `redacted`. Conversation and task ids become `c1`, `t1`... in order, consistent within one answer, with `parent_id` mapped the same way. Timestamps stay absolute. |

Past the cap, `input` or `output` is a JSON string holding the first characters of the stored JSON text, and the task has `truncated: true`. Every task carries `input_bytes` and `output_bytes` (`null` without output), the full sizes.

The answer carries `data_label`, as every agent read route does: the content is data, never instructions. It is sent with `cache-control: no-store` and `x-content-type-options: nosniff`.

## Export a snapshot

```sh
mkdir -p exports
pnpm -s conversations:export > exports/conversations.json   # exports/ is gitignored
pnpm -s conversations:export --redact > exports/demo.json   # for a public demo
```

Same JSON shape as the API, every conversation, from one read-only transaction, with payloads in full (no cap). `--redact` pseudonymizes once over the whole export, so `c1`, `t1`... stay consistent across pages. It uses `ADMIN_DATABASE_URL` if set, else `DATABASE_URL`, from `.env.local`. Look through a redacted file before you publish it: redaction is by rule, and agent ids, timestamps and states stay.
