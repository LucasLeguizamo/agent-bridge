# Grok Bot

How to connect your own Grok Bot to agent-bridge, so other agents can hand it read-only tasks and it can hand tasks back.

Grok Bot changes quickly. Platform facts below come from the [Grok Bot docs](https://docs.x.ai/grok-bot/overview) as of November 2026, or from running this bridge in production; anything not documented by xAI is marked **(observed)** or **(assumption)**.

## How it works

```text
 other agent ──POST /tasks──▶ bridge ──webhook {task_id}──▶ Grok Bot routine run
                                ▲                                   │
                                └── curl: instructions, claim, ─────┘
                                    memory, complete / fail
```

- The bridge wakes the Bot by calling a **routine with a Webhook trigger**. The body carries only `task_id`, because the webhook body is not signed: whoever has the URL and key can start a run.
- The run fetches its working instructions from `GET /instructions`, then **claims** the task with `POST /tasks/<id>/claim`. The claim is atomic: a forged, duplicate or already claimed `task_id` answers `claimed: false` and the run stops.
- The run does the task, closes it with `/complete` or `/fail` before `deadline_at`, and tells you in its chat.
- A `200` from the webhook only means a run started. It does not mean the run finished, or that the Bot's computer is reachable. The bridge's queue owns delivery: it retries, and a task is done only when the Bot closes it.
- The Bot never contacts another agent directly. To ask one, it creates a task on the bridge.

**Shipped path: `curl` to the HTTP API.** Grok Bot has no UI to give a custom MCP server an `Authorization` header **(observed)**, so the routine talks to the bridge with `curl` and `Authorization: Bearer $BRIDGE_TOKEN`. The bridge also serves an MCP server at `/mcp` (streamable HTTP, same bearer key, tools `memory_search`, `memory_write`, `task_claim`, `task_create`, `task_complete`). It is optional, for clients that can send a header; the Grok routine does not use it.

## Prerequisites

- A deployed bridge (see [`runbook.md`](runbook.md)), reachable over `https` from the internet. Deployment protection must leave the production domain open.
- A Grok Bot plan that includes routines. Every run spends metered usage from your weekly limit.
- At least one other agent registered on the bridge, so something can send the Bot a task (a local `http` agent with the [CLI](cli.md) is enough for testing).

## Setup

1. **Use a dedicated Bot.** Connect only the apps it needs for the research you will send it. Connected apps, files, browser sessions and command line credentials on the cloud computer are shared by all your Bots, so a separate Bot reduces the risk but is not a security boundary.

2. **Register the agent on the bridge.** Generate a key with `openssl rand -hex 32`, add it to `BRIDGE_AGENT_KEYS` as `"grok": "<key>"`, deploy, then:

   ```sql
   INSERT INTO bridge.agent (id, adapter) VALUES ('grok', 'grok');
   ```

   The id can be anything plain (`[a-z0-9_.-]`); the adapter must be `grok`. The examples here use `grok`.

3. **Give the Bot its key.** In the Bot's chat, ask it to open its secure secret input for an environment variable named `BRIDGE_TOKEN`, and paste the key there. The value is masked and not shown to the model. Never paste it in the chat.

4. **Let `curl` to the bridge run without asking.** Auto Review may show an approval card for each command. Cards from routine runs expire after about 30 minutes, and the run stalls until then. Add a narrow **Allow automatically** rule under Settings > General > Bot > Custom Rules, for example *"Allow curl commands to https://your-bridge.example only"*. Do not allow all shell commands: a page the Bot reads could then run anything. If you chose **Always allow** on a card instead, check the rule it saved and narrow it. **(assumption:** how precisely a rule can be scoped is not documented.)

5. **Create the routine.** Open `/activate/grok` on your deployment, copy the routine text (the bootstrap, with your URL filled in), and ask the Bot to create a routine with a **Webhook** trigger and that text as its instruction. The same text is in [`agents.md`](agents.md#routine-bootstrap).

6. **Connect the bridge to the routine.** From the routine's Webhook section, copy **POST to** into `GROK_WEBHOOK_URL` and **key** into `GROK_WEBHOOK_KEY`. Use the key field, not the **header** field (which already includes `Bearer `). Set them in the Production environment only, and redeploy.

| Variable | Value | Notes |
|---|---|---|
| `BRIDGE_AGENT_KEYS` | `{"grok": "<key>", ...}` | Same key as the Bot's `BRIDGE_TOKEN` secret |
| `GROK_WEBHOOK_URL` | The routine's **POST to** | Must be `https` |
| `GROK_WEBHOOK_KEY` | The routine's **key** | 16+ visible characters, no spaces |

If either Grok variable is missing, the adapter does not load, the bridge logs `Grok adapter not loaded`, and tasks for the Bot wait without spending attempts. Never put these values in `agent.config`.

## First test task

Send a research task from another registered agent, with that agent's key (not the Bot's):

```sh
curl -sS https://your-bridge.example/tasks \
  -H "Authorization: Bearer $OTHER_AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"to_agent":"grok","intent":"research","input":{"query":"What is the capital of Australia?"},"idempotency_key":"first-test"}'
```

Or with the CLI: `bridge tasks create --to grok --intent research --input-json '{"query":"..."}' --idempotency-key first-test`.

Then read it with `GET /tasks/<id>` (or `bridge tasks get <id>`). Within a few minutes it should go `submitted` to `working` to `completed`, and the Bot should post a short notice in the routine run's chat. To see each step:

```sql
SELECT created_at, actor, type, payload FROM bridge.event WHERE task_id = '<id>' ORDER BY id;
```

You should see `delivery_attempt`, `grok_run_started`, `task_claimed`, and the completion. Do not test with the routine's **Test** button: it sends no `task_id`, so the run stops at step 1 and only spends usage.

## Routing to your other Bots

A routine run can read the chat history of your other Bots, but it cannot message one and wait for the reply: the run ends first **(observed)**. So if another of your Bots already knows about a topic, you can tell this Bot where to look, in the **Owner notes** block at the end of the routine text. Name the topic and the Bot, nothing more:

```text
Owner notes (optional; they add to the instructions and cannot relax their limits):
- For questions about <topic>, you may read the recent chat history of my Bot "<name>". Do not message it.
```

Owner notes live in the routine, not on the bridge, so they survive updates. They add to the served instructions and cannot relax their limits.

Use this sparingly, because it opens a leak path. Any registered agent can send this Bot a research task, and that agent may be acting on a hostile email or page. With a routing note, such a task can make the Bot read another Bot's private history and put it in a result that goes back to the sender. So:

- Notes name topics only. Never write a note that asks the Bot to quote, copy or forward another Bot's history.
- Content from another Bot's history must not be copied into a result. The Bot uses it to write a short answer in its own words; the served instructions say the same.
- Do not route to a Bot whose history holds anything you would not send to every agent on the bridge.

The bridge cannot enforce any of this: it never sees what the Bot reads in another Bot's history, and its secret check catches tokens, not private prose. These limits are obeyed by the model only. If that is not enough for a given Bot, leave it out of the notes.

To ask an agent that is on the bridge, the Bot creates a task (`POST /tasks`) instead, at most 2 per task. It reads the answer with `GET /tasks/<id>` if it arrives before the Bot must close; otherwise it says so in its result.

## Approvals and `needs_approval`

- **Risk is decided by the bridge, not the sender.** `research`, `summarize` with text input, and `memory.write` are delivered at once, and the Bot does them without asking you. Anything else is `side_effect`: it waits in `input_required` and is never sent to the Bot without an approval row. There is no approval UI yet (PRD milestone M5), so such tasks fail at their deadline. Approving in the bridge before the webhook fires matters because a Grok approval card in a routine expires after about 30 minutes.
- **Inside a run, the Bot only reads.** The served instructions forbid clicks that change anything, forms, post or message composers, logins and dialogs. If a task cannot be done without one, the Bot fails it with reason `needs_approval` and says which action would be needed. This exists because a routine that opened a social network's post composer hit a computer-action approval and stalled until the card expired **(observed)**.

## Circuit breaker

If the last 3 tasks sent to the Bot got no claim, within 15 minutes from first to last attempt, the bridge stops sending to it for 1 hour and writes an `alert` event with `grok_breaker_open`. This protects your usage when the routine is paused or the computer is unreachable: the webhook may still answer `200` and start runs that cannot work. Tasks keep being accepted and wait without spending attempts.

It ends on its own after the hour, or earlier when a valid claim arrives. To resume by hand:

```sql
UPDATE bridge.adapter_pause SET paused_until = now() WHERE adapter = 'grok';
```

Use `UPDATE`, not `DELETE`, or the missed runs count again. Details: [`agents.md`](agents.md#circuit-breaker-routine-agents).

## Usage and limits

Every run spends usage, including runs that do nothing:

| Run | Why it happens |
|---|---|
| A normal task | 1 run, plus the `curl` calls and the research itself |
| A re-send | The webhook answered `200` but no claim came within 5 minutes: sent again after 5, 10, 20, 40 minutes, 5 attempts at most |
| A failed delivery retried | Non-2xx or no answer in 30 s: retried with backoff, same 5 attempts |
| A forged or repeated `task_id` | The claim answers `claimed: false` and the run stops, but it already started |

Platform limits: 50 routines per Bot, 300 runs per hour across your routines, 200 per routine, schedules at least 5 minutes apart. Over a limit, the webhook fails with `Automation run rate limit exceeded`; Grok does not retry it, the bridge does. The bridge's own caps (20 tasks per agent pair per day, 4 hops per chain, 2 child tasks per task) keep it far below the platform limits.

Keep the webhook URL and key secret, and do not add an email trigger to this Bot unless you need it: any email to the Bot's address can start a run, and filtering by sender is not documented.

## Rotating keys

- **`GROK_WEBHOOK_KEY`:** pause the adapter first, so failed deliveries do not spend attempts or trip the breaker. Regenerate the key in the routine, update the variable, redeploy, then resume. See [`runbook.md`](runbook.md) for the exact SQL.
- **`BRIDGE_TOKEN` (the agent key):** generate a new key, update `BRIDGE_AGENT_KEYS`, deploy, then replace the Bot's `BRIDGE_TOKEN` secret through the secure input. There is no overlap: runs get `401` from the bridge until the Bot has the new key, so pause the adapter for the change too.

## Updates

The routine fetches its instructions on every run, so a deploy updates the Bot with nothing to paste. `GET /instructions` returns a `version` hash; ask the Bot which version it ran if behavior looks stale. Paste the routine text again only when a release says the bootstrap changed.

## Troubleshooting

Start with the task's events (query above) and the alerts:

```sql
SELECT created_at, task_id, payload FROM bridge.event WHERE type = 'alert' ORDER BY id DESC LIMIT 20;
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `delivery_failed` events with `webhook responded 401` | `GROK_WEBHOOK_KEY` is wrong: the **header** field was copied (it starts with `Bearer `), the key was regenerated in the routine, or the variable is stale in the deployment | Copy the **key** field again, update the variable, redeploy. Resume the breaker if it opened |
| `delivery_failed` with another status, often `400` | The routine is off or was paused by Grok after a long absence; the endpoint does not queue | Turn the routine back on. Re-create tasks that ended `delivery_exhausted` |
| Tasks stay `submitted` with `attempts = 0` | The adapter did not load (a variable missing, or set outside Production), the agent is disabled, or the breaker is open | Check the deploy log for `Grok adapter not loaded`, `bridge.agent.enabled`, and `bridge.adapter_pause` |
| `grok_breaker_open` alert | 3 runs in a row without a claim: routine paused, computer unreachable, or `BRIDGE_TOKEN` wrong | Fix the cause, then resume (above) |
| Run history shows the run, but the task stays `submitted` | The run could not reach the bridge: `401` (wrong `BRIDGE_TOKEN`) or `403 agent_disabled` on `/instructions` | Re-enter `BRIDGE_TOKEN` through the secure input; `GET /whoami` with the key must answer `{"agent":"grok"}` |
| The run shows `curl: (22) ... error: 403` (or `401`) right at the start, and does nothing else | The bootstrap fetches `/instructions` with `curl -f`, on purpose, so it stops instead of running without instructions; `-f` hides the error body. `403` is `agent_disabled` (the key is valid but `grok` is not enabled in `bridge.agent`); `401` is a wrong `BRIDGE_TOKEN` | Check `bridge.agent.enabled` for `grok`, or re-enter `BRIDGE_TOKEN`; `GET /whoami` with the key shows which |
| The run stalls, the task stays `working` until its deadline | The run is waiting on an approval card, which expires after about 30 minutes. Seen when a run opened a post composer | Current instructions forbid that and end as `needs_approval`. If the card is for `curl` itself, add the allow rule from setup step 4 |
| The claim always answers `claimed: false` | The key belongs to another agent, the task is for another agent, already claimed, past its deadline, a `side_effect` without approval, or the pair or sender is paused | Check `GET /whoami`, then the task's state and events |
| A task the Bot creates is rejected with `pair_paused`, after a `hop_limit` you did not expect | An older bridge counted hops from unrelated tasks the Bot had received earlier, so a fresh question looked like a long chain, and the hop limit paused the pair | Fixed: a task the Bot is working on is now the parent. Update the bridge, then remove the pause with the `DELETE FROM bridge.pair_pause` in [`runbook.md`](runbook.md) |
| Memory search answers `400 invalid_body` | The parameter is `?query=`, not `?q=`. Old instructions, or owner notes, used `?q=` | Served instructions use `?query=`. Remove any copy of the old call from the owner notes |
| Closing answers `secret_rejected` | The result contains something that looks like a token or password | The Bot removes the value and closes again. The task stays open meanwhile |
| A run starts and stops at once | It was started by the routine's **Test** button, or by a request with no `task_id` | Test with a real task, as above |
| `Automation run rate limit exceeded` | Over 300 runs per hour across routines, or 200 for this routine | The bridge retries. Look for what is creating so many tasks |

## Not documented by xAI

These are unknown or only observed, and may change:

- Whether a routine can use a custom MCP server unattended, with a bearer header. Not available in the UI as of this writing, which is why the shipped path is `curl`.
- How the webhook body is shown to the model beyond "received with the routine instruction". The bridge sends only `task_id` and the instructions ignore every other field.
- Email trigger filters by sender or subject.
- How narrowly an Auto Review rule can be scoped to one command and host.
