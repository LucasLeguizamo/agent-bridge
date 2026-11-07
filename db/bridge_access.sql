-- Runs after 001_core.sql, inside the same transaction as CREATE ROLE bridge_app.
-- Keeps the schema out of the Supabase Data API and gives the app only what it uses.
-- A role-level search_path is what lets unqualified SQL work through a transaction-mode pooler.

REVOKE ALL ON SCHEMA bridge FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA bridge FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA bridge FROM PUBLIC, anon, authenticated, service_role;

ALTER ROLE bridge_app SET search_path = bridge;
GRANT USAGE ON SCHEMA bridge TO bridge_app;
GRANT SELECT, INSERT, UPDATE ON agent, task, fact, approval, pair_pause TO bridge_app;
GRANT DELETE ON pair_pause TO bridge_app;
GRANT SELECT, INSERT ON event TO bridge_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA bridge TO bridge_app;
