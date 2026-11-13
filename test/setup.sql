-- Run once on a local Postgres before `pnpm test`. Supabase already has these roles, so this is a no-op there.
-- The migrations revoke from them to keep the schema out of the Data API; bridge_app is the app's role, whose grants tests check.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'bridge_app'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;
