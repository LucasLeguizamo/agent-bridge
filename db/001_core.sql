-- PRD section 6, plus pair_pause (circuit breaker) and two integrity triggers.
-- Safe behind a transaction-mode pooler: no session state, no LISTEN.

CREATE TABLE agent (
  id        text PRIMARY KEY,           -- 'instinct', 'grok'
  adapter   text NOT NULL,              -- 'email', 'http', ...
  config    jsonb NOT NULL DEFAULT '{}',-- no secrets here
  enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE task (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id          uuid NOT NULL,       -- conversation; budgets count against this
  parent_id        uuid REFERENCES task(id),
  from_agent       text NOT NULL REFERENCES agent(id),
  to_agent         text NOT NULL REFERENCES agent(id),
  intent           text NOT NULL,
  input            jsonb NOT NULL,
  output           jsonb,
  risk             text NOT NULL CHECK (risk IN ('read','write','side_effect')),
  state            text NOT NULL CHECK (state IN
    ('submitted','working','input_required','completed','failed','canceled','rejected')),
  hop              int  NOT NULL DEFAULT 0,
  idempotency_key  text NOT NULL UNIQUE,
  attempts         int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  deadline_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_due ON task (next_attempt_at) WHERE state = 'submitted';

CREATE TABLE event (                  -- append-only
  id         bigserial PRIMARY KEY,
  task_id    uuid REFERENCES task(id),
  actor      text NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fact (
  id              bigserial PRIMARY KEY,
  namespace       text NOT NULL,
  key             text NOT NULL,
  value           text NOT NULL,
  source_agent    text NOT NULL REFERENCES agent(id),
  source_event_id bigint REFERENCES event(id),
  trust           text NOT NULL DEFAULT 'unverified'
                  CHECK (trust IN ('unverified','verified')),
  superseded_by   bigint REFERENCES fact(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  tsv             tsvector GENERATED ALWAYS AS
                  (to_tsvector('simple', key || ' ' || value)) STORED
);
CREATE INDEX fact_tsv ON fact USING gin (tsv);
CREATE UNIQUE INDEX fact_current ON fact (namespace, key) WHERE superseded_by IS NULL;

CREATE TABLE approval (
  task_id    uuid PRIMARY KEY REFERENCES task(id),
  decision   text CHECK (decision IN ('approved','denied')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);

-- Circuit breaker. The pair is unordered: agent_a = LEAST, agent_b = GREATEST.
CREATE TABLE pair_pause (
  agent_a      text NOT NULL REFERENCES agent(id),
  agent_b      text NOT NULL REFERENCES agent(id),
  paused_until timestamptz NOT NULL,
  reason       text NOT NULL,
  PRIMARY KEY (agent_a, agent_b)
);

-- State machine lives in the database so no writer can bypass it.
-- submitted -> completed/failed covers a reply that beats the delivery ack.
CREATE FUNCTION task_check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (CASE OLD.state
    WHEN 'submitted'      THEN NEW.state IN ('working','input_required','completed','failed','canceled','rejected')
    WHEN 'working'        THEN NEW.state IN ('input_required','completed','failed','canceled')
    WHEN 'input_required' THEN NEW.state IN ('submitted','working','failed','canceled','rejected')
    ELSE false
  END) THEN
    RAISE EXCEPTION 'invalid task transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_transition BEFORE UPDATE OF state ON task
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION task_check_transition();

CREATE FUNCTION event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER event_immutable BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION event_append_only();
