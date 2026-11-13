-- Owner dashboard. Additive only; unqualified names, so run with search_path set to the target schema.

-- Per-task event lists and finish times on /dashboard/conversations, in id order.
CREATE INDEX IF NOT EXISTS event_task ON event (task_id, id);
-- Groups tasks into conversations and lists each one's tasks in order.
CREATE INDEX IF NOT EXISTS task_root ON task (root_id, created_at);
