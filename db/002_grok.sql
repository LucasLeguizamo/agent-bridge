-- M4: Grok Bot adapter and bridge MCP. Additive only; unqualified names, so run with search_path set to the target schema.

-- Set once by task_claim. The conditional UPDATE on this column is what makes a claim atomic.
ALTER TABLE task ADD COLUMN claimed_at timestamptz;

-- Delivery pause per adapter, one row per adapter. Unlike pair_pause it holds sends and leaves task creation open.
-- A row whose paused_until has passed means closed, and runs before that moment no longer count toward a new trip.
CREATE TABLE adapter_pause (
  adapter      text PRIMARY KEY,
  paused_until timestamptz NOT NULL,
  reason       text NOT NULL
);

-- The breaker reads the latest webhook runs on every dispatcher pass.
CREATE INDEX event_grok_run ON event (id DESC) WHERE type = 'grok_run_started';

-- Same protection as bridge_access.sql, which only covers tables that existed when it ran.
-- Conditional because test schemas have no bridge_app.
REVOKE ALL ON adapter_pause FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_app') THEN
    REVOKE ALL ON adapter_pause FROM anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON adapter_pause TO bridge_app;
  END IF;
END $$;
