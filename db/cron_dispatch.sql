-- The once-a-minute trigger for POST /cron/dispatch. A documented manual step (docs/runbook.md), not a migration: it needs
-- pg_cron, pg_net and Vault, which test schemas lack, and it runs on the postgres role in the SQL editor.
-- Safe to re-run: the extensions are IF NOT EXISTS, and cron.schedule with a name replaces that job.
-- The URL and the secret live in Vault: create them first, as the runbook says. Neither belongs in this file.
-- Limit (Supabase KB): pg_net holds the decrypted header in net.http_request_queue until it sends, readable by any
-- role that can use pg_net. That secret can only trigger a pass, so a leak costs little. Rotate it if in doubt.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'bridge-dispatch',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bridge_url') || '/cron/dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bridge_cron_secret')
    ),
    timeout_milliseconds := 60000 -- The default of 2 s is shorter than a pass with deliveries.
  ) AS request_id;
  $$
);
