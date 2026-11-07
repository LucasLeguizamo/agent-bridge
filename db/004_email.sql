-- M3: email adapter for Instinct. Additive only; unqualified names, so run with search_path set to the target schema.

-- Keeps tasks for Instinct queued until EMAIL_* env vars load the adapter. Never touches `enabled`, the kill switch.
INSERT INTO agent (id, adapter) VALUES ('instinct', 'email')
ON CONFLICT (id) DO UPDATE SET adapter = EXCLUDED.adapter;

-- One row per received email, whatever its fate: quarantine is status = 'quarantined' plus the reason.
-- The primary key is what makes provider redelivery idempotent.
-- No body here on purpose: quarantined text stays at the provider, so this table cannot hold a leaked secret.
CREATE TABLE email_inbound (
  provider        text NOT NULL,
  provider_id     text NOT NULL,
  message_id      text,                 -- RFC 5322 Message-ID, for threading only
  in_reply_to     text,
  sender          text NOT NULL,        -- Untrusted until status = 'processed'
  recipients      jsonb NOT NULL,       -- Reply tokens masked
  subject         text,
  verdicts        jsonb,                -- SPF, DKIM and DMARC as the provider reported them
  body_sha256     text NOT NULL,
  body_chars      int  NOT NULL,
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'quarantined')),
  reason          text,                 -- Set when quarantined
  kind            text CHECK (kind IN ('reply', 'delegation')),
  task_id         uuid REFERENCES task(id),
  event_id        bigint REFERENCES event(id), -- Set once, so a redelivery cannot log the same mail twice.
  -- Mail back to the delegating agent when its task ends.
  result_attempts int NOT NULL DEFAULT 0,
  result_next_at  timestamptz NOT NULL DEFAULT now(),
  result_sent_at  timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (provider, provider_id)
);

-- A token is good for one reply, so a second message cannot rewrite the result or add facts.
-- A resent delegation maps to the same task and must not mail its result twice.
CREATE UNIQUE INDEX email_inbound_one_per_task ON email_inbound (task_id) WHERE kind IS NOT NULL;
CREATE INDEX email_inbound_quarantine ON email_inbound (received_at DESC) WHERE status = 'quarantined';
CREATE INDEX email_inbound_result_due ON email_inbound (result_next_at)
  WHERE kind = 'delegation' AND status = 'processed' AND result_sent_at IS NULL;

CREATE TABLE email_outbound (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES task(id),
  kind        text NOT NULL CHECK (kind IN ('task', 'result')),
  provider_id text NOT NULL,
  message_id  text,                     -- Null if the provider did not report one; the thread then starts over.
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, kind)
);

-- Same protection as bridge_access.sql, which only covers tables that existed when it ran.
-- Conditional because test schemas have no bridge_app.
REVOKE ALL ON email_inbound, email_outbound FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('bridge_app') IS NOT NULL THEN
    REVOKE ALL ON email_inbound, email_outbound FROM anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON email_inbound, email_outbound TO bridge_app;
    GRANT USAGE ON SEQUENCE email_outbound_id_seq TO bridge_app;
  END IF;
END $$;
