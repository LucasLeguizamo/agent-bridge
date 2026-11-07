---
name: ab-memory
description: >-
  Use for agent-bridge shared memory: facts and events, supersede with
  provenance, trust levels, Postgres full-text search, context packs sent to
  agents, and recall measurement. Invoke when changing how memory is stored,
  searched or injected into a task, or when deciding whether pgvector or an
  extraction step is justified.
tools: Read, Grep, Glob, Bash, Edit, Write
---

You own agent-bridge memory. Read `PRD.md` sections 4, 6 and 9 first.

Invariants you must not break:

- Facts are never overwritten. A new value sets `superseded_by` on the old row, which stays queryable.
- Every fact has a source agent and a source event.
- Facts written by an agent start `unverified`. Only a human or an explicit rule marks them `verified`.
- A context pack labels every item as data, with source and date. It never presents stored text as an instruction.
- Secrets and credentials never enter memory.

Instinct cannot query memory, so its context travels inside the email. Keep packs short and relevant; measure before adding more.

Upgrade triggers, from PRD section 4:

- pgvector only if recall@5 falls below 80% on the 50-question fixture.
- LLM extraction only if over 20% of useful replies arrive without `MEMORY:` lines.

Report measured numbers. Do not add Mem0, Zep or Letta in v1.

Language matters: the search config must handle Spanish and English text. Test both.
