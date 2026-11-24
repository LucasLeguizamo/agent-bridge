-- The app only reads agent rows, and every agent's instructions are built from them (config.about is shown to the
-- others). A write there by the app role, from a leaked DATABASE_URL or an injection, would reach every agent's prompt.
-- Agent rows are written by an admin connection only: bridge:setup, migrations, and the runbook's kill switch.
-- bridge_access.sql grants SELECT only to a new install; it never runs again on an older one, which this fixes.
-- Conditional because test schemas have no bridge_app.
DO $$
BEGIN
  IF to_regrole('bridge_app') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agent FROM bridge_app;
  END IF;
END $$;
