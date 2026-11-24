-- The agent that asked for a task (from_agent) learns that it ended in one of two ways: it reads the answer
-- (asker_seen_at), or the bridge wakes it once (asker_woken_at). Only routine agents are woken; see src/grok.ts.
ALTER TABLE task ADD COLUMN asker_seen_at timestamptz, ADD COLUMN asker_woken_at timestamptz;

-- Tasks that ended before this migration wake nobody.
UPDATE task SET asker_seen_at = now() WHERE state IN ('completed', 'failed', 'canceled', 'rejected');

CREATE INDEX task_asker_wake_due ON task (created_at)
  WHERE state IN ('completed', 'failed') AND asker_seen_at IS NULL AND asker_woken_at IS NULL;
