# Email and Instinct (M3)

Guide for the owner. **G1 has not been done and no real email has been sent**: everything was tested with fake signed webhooks and a simulated Resend API. Items marked **[G1]** are assumptions that still need confirmation.

## How it works

| Function | Mechanism |
|---|---|
| Where it goes | The address: `bridge+<token>@` is a reply, `bridge+grok@` is a delegation |
| Who authorized it | Sender on the allow list, SPF, DKIM and DMARC verdicts all `pass`, and the HMAC token on replies |
| Which task it belongs to | The `[task:xxxxxxxx]` flag in the subject. It only correlates: it never authorizes anything |

**Bridge to Instinct.** The email goes to `INSTINCT_EMAIL`, with the owner (`OWNER_EMAIL`) in Cc. `Reply-To` carries the signed token. The request and the memory are labeled as data, each on its own line. If the task contains a secret, it does not leave: the task ends `failed` with an alert. If the secret is in the memory, the email goes out without that context. A `side_effect` task is not sent without approval. Instinct does read tasks without asking, and the owner is notified after. Only `side_effect` tasks wait, and the bridge holds them.

**Instinct's reply.** It closes the task with `finishTask`. Each `MEMORY: key = value` line goes through `memoryWrite`, as an `unverified` fact with its source. The text is always kept in an `email_reply` event. Without `MEMORY:` lines, no fact is created. Each task accepts only one reply.

**Instinct's delegation.** An email to `bridge+grok@` creates a task with `createTask`, with its hop limit, daily cap and duplicate checks. The bridge sets `to_agent`, the `research` intent and therefore the risk: the email content does not choose them. Text over 10,000 characters does not meet the policy and becomes `side_effect`, waiting for approval. When the task finishes, the result returns on the same thread, without a token, so replying to it creates nothing. A task rejected by the limits sends no email, so it does not feed a loop.

## Provider: Resend

| | Resend | Mailgun | Postmark | SendGrid | Amazon SES |
|---|---|---|---|---|---|
| Inbound by webhook | Yes, metadata only; the body is fetched from the API | Yes, with the body | Yes, with the body | Yes, multipart | Not direct: SNS, S3 or Lambda |
| Signed webhook | Yes (Svix, HMAC over the whole body) | Yes. In form mode it signs only `timestamp` and `token`; in JSON, the body | **No**: Basic Auth and IP | Yes (ECDSA, with a separate policy) | SNS signed with a certificate |
| Verdicts | Yes: `authentication.spf`, `dkim`, `dmarc`, documented | Announced in May 2026, no documented field names | SpamAssassin headers only, no DMARC | `SPF` and `dkim`, no DMARC field | Yes: the most complete |
| Threads | `message_id`, `In-Reply-To` and `References` documented | By headers | By headers | By headers | MIME must be parsed |
| Free tier | 100 per day, 3,000 per month, inbound included | 100 per day, 1 inbound route, 1 day of logs | Not reviewed: discarded | Not reviewed | Not reviewed |

**Why Resend:** it is the only one with a signed webhook and documented DKIM and DMARC verdicts in simple JSON, with no AWS and no MIME parsing. It works in serverless because the webhook is short. **Plan B:** SES, if Resend fails the real test. Mailgun is an alternative only if it documents the fields.

Resend limits: every received email counts against the quota, and because the domain receives at any address, spam also spends it. Use a low-profile subdomain. The API allows 10 requests per second. The SDK is not used: one signature check and three calls do not justify a dependency.

A provider change is limited to `EmailProvider` in `src/email.ts`: `parseWebhook`, `fetchInbound` and `send`.

## Variables

Without all six (the five above and `OWNER_EMAIL`), the adapter does not load and Instinct tasks stay queued without spending attempts.

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | API key. Send mail and read received mail |
| `RESEND_WEBHOOK_SECRET` | Webhook signing secret, `whsec_...` |
| `EMAIL_DOMAIN` | Bridge subdomain, for example `bridge.yourdomain.com` |
| `EMAIL_TOKEN_SECRET` | Random, 32 characters or more: `openssl rand -hex 32` |
| `INSTINCT_EMAIL` | Address the bridge writes to for Instinct |

Optional:

| Variable | What it is |
|---|---|
| `EMAIL_ALLOWED_SENDERS` | Addresses Instinct writes from, comma-separated. Exact match. Defaults to `INSTINCT_EMAIL`. The owner's address is rejected at startup |
| `OWNER_EMAIL` | Required. The owner, in Cc of each email. Agents work without asking, so this is the supervision |

Rotating `EMAIL_TOKEN_SECRET` invalidates the tokens of open tasks: their replies go to quarantine until the tasks expire, after 24 h.

## Schema

`db/004_email.sql` is additive and **is not applied live**. Apply it with `pnpm db:migrate`, after a backup.

- It registers `instinct` with the `email` adapter, without touching `enabled`, which is the kill switch.
- `email_inbound`: one row per received email, with its status and reason. The `(provider, provider_id)` key makes redelivery idempotent. It stores no bodies: the body of a quarantined email stays only in Resend (30 days on the free plan).
- `email_outbound`: what was sent, for threading and audit.

## Quarantine

A webhook without a valid signature gets `401` and leaves nothing. A signed webhook whose email fails the checks gets `200`, so the provider does not retry, and the email goes to quarantine without being parsed.

```sql
SELECT received_at, reason, sender, subject, verdicts, provider_id
FROM bridge.email_inbound WHERE status = 'quarantined' ORDER BY received_at DESC LIMIT 50;
```

| Reason | Meaning |
|---|---|
| `sender_not_allowed` | Sender not on the list, or ambiguous `From` |
| `auth_failed` | SPF, DKIM or DMARC is not `pass`, or there is no verdict |
| `no_token` | No `bridge+...`: for example, the reply went to `From` instead of `Reply-To` |
| `invalid_token` | Tampered token, or a delegation target that is not allowed |
| `ambiguous_route` | More than one distinct `bridge+...` |
| `no_text_body` | No plain-text part |
| `too_large`, `invalid_text` | More than 64,000 characters, or contains NUL characters |
| `secret` | The secret filter found something. It may be a false positive, such as a long hash |
| `task_not_open` | The task expired, closed, or already got its reply |
| `task_refused:<code>` | `createTask` rejected the delegation |

Nothing leaves quarantine on its own. To review a body, look it up in Resend with `provider_id`.

## What G1 must confirm

The tests are the ones in PRD section 11. The adapter also depends on these points:

1. **[G1]** Does Instinct reply to automated email from a sender that is not the owner? If not, M3 is useless and plan B in section 7 applies.
2. **[G1]** Does it reply to `Reply-To`, keeping the exact `+token`? If it replies to `From`, everything lands in `no_token`.
3. **[G1]** Which address does it write from? Is it the same one it is sent to? This sets `EMAIL_ALLOWED_SENDERS`.
4. **[G1]** Do its emails arrive with SPF, DKIM and DMARC all `pass`? The check is strict. If DMARC arrives `gray` because its domain uses `p=none`, everything lands in `auth_failed`. Relaxing it is a security decision, not a tuning step: the owner must approve it.
5. **[G1]** Does it send a `text/plain` part? If it sends only HTML, everything lands in `no_text_body`.
6. **[G1]** Does it put `MEMORY:` at the start of the line, 5 out of 5 times, without bullets or bold? The parser does not guess: those lines create no facts. Check `memory_lines` in `email_reply` for the 20% rule in section 7.
7. **[G1]** Does it send only one reply per task? The first reply closes the task. An "I'll let you know when done" would close the task with that text, and the real reply would go to quarantine.
8. **[G1]** Can it write to `bridge+grok@` on its own? Does it keep the `+` in the address? Does it keep the thread when it is answered?
9. **[G1]** Does it obey what arrives as data (test 5, BANANA)? If so, the risk is real and `side_effect` is not relaxed.
10. The terms do not address automated sending. The owner sends the draft for `comms@instinct.com` from section 7.

## What needs a real mailbox

None of this was tested. Do it with a test mailbox as the allowed sender, never the owner's own, before using Instinct:

1. Resend delivers `bridge+<52 characters>@` and `bridge+grok@` to the webhook. Its documentation says "any address on the domain" and does not mention `+`.
2. The real payload matches its reference, and `authentication` carries all three verdicts. `headers.from` must match `from`, also with encoded names, or the email lands in `sender_not_allowed`.
3. A spoofed email from a foreign domain arrives with the correct verdict and goes to quarantine.
4. `GET /emails/{id}` already has `message_id` right after sending. If not, only the next task's thread is lost, not the reply.
5. `In-Reply-To` and `References` group the thread in a real client, and the owner receives the Cc copy.
6. The real signature of a webhook, and a forced retry by answering `503`.

This is the M3 criterion "real round trip with a test mailbox", and it is still pending.

## Manual steps

1. G1, especially the points above.
2. A Resend account and a dedicated subdomain, with its sending DNS records and the receiving MX.
3. An `email.received` webhook to `https://<host>/webhooks/email`, with no deployment protection on that URL.
4. The variables above on the host, and `pnpm db:migrate`.
5. The test with a real mailbox.
6. The opt-out in `app.instinct.com/settings`, and teaching Instinct the text at `/activate/instinct`.

## Known limits

- **Vercel Hobby:** its cron runs only once a day, so sending depends on a per-minute `POST /cron/dispatch` from `db/cron_dispatch.sql` (pg_cron in Supabase, see the runbook). Without that manual step, a task for Instinct or a result may not go out. Each pass also sends pending results. Receiving does not depend on the cron.
- **The bridge does not control Instinct.** It controls what it asks, not what Instinct does with its accounts. Hostile text in `research` is still text: the recipient must treat it as data.
- **Approvals:** a `side_effect` task does not leave without a current approval in `approval`. The queue holds it and the adapter checks again. Without approval, it expires after 24 h.
- **A reply only closes as `completed`.** There is no way to mark it `failed` by email.
- **Overwritable facts:** a valid reply with an existing key replaces the current value, as `unverified`, and the previous value stays in the history. A `verified` fact cannot be replaced: that line counts as rejected.
- **Spam:** each email to the domain costs one API call, one row and one event. There is no automatic retention.

## Never

Automate iMessage, WhatsApp or SMS from your account. Scrape or reverse-engineer `app.instinct.com`. Pass credentials or customer data through this channel.

## Sources

Reviewed on 2026-11-07. Resend: [receiving](https://resend.com/docs/dashboard/receiving/introduction), [received email](https://resend.com/docs/api-reference/emails/retrieve-received-email), [`email.received` event](https://resend.com/docs/webhooks/emails/received), [threads](https://resend.com/docs/dashboard/receiving/reply-to-emails), [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [retries](https://resend.com/docs/dashboard/webhooks/retries-and-replays), [pricing](https://resend.com/pricing), [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits). [Svix: manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual). [Mailgun: inbound](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http), [signing](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks), [verdicts](https://www.mailgun.com/?p=13451), [pricing](https://www.mailgun.com/pricing/). [Postmark: webhooks](https://postmarkapp.com/developer/webhooks/webhooks-overview). [SendGrid: Inbound Parse](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook), [signing](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks). [SES: notifications](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html). [Vercel: cron](https://vercel.com/docs/cron-jobs/usage-and-pricing).
