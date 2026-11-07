-- Pre-deploy audit and Vercel. Additive only; unqualified names, so run with search_path set to the target schema.

-- The first read of every pass, once a minute, finds a passed deadline here (due sends use task_due).
CREATE INDEX task_open_deadline ON task (deadline_at) WHERE state IN ('submitted', 'working', 'input_required');

-- The per-agent hourly caps count recent rows by actor.
CREATE INDEX event_actor_recent ON event (actor, created_at);

-- The breaker now reads delivery attempts too.
CREATE INDEX event_send_attempt ON event (created_at) WHERE type IN ('delivery_attempt', 'grok_run_started');
