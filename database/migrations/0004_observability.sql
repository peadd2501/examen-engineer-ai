-- 0004_observability: trazabilidad de ejecuciones del agente y de cada tool call.

CREATE TYPE run_status_t AS ENUM ('RUNNING','COMPLETED','FAILED','CANCELLED');

CREATE TABLE agent_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         TEXT         NOT NULL,
  application_id     UUID         REFERENCES applications(id) ON DELETE SET NULL,
  prompt_version     TEXT         NOT NULL,
  policy_corpus_version TEXT      NOT NULL,
  indicator_calc_version INTEGER  NOT NULL,
  model              TEXT         NOT NULL,
  input_tokens       INTEGER      NOT NULL DEFAULT 0,
  output_tokens      INTEGER      NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  estimated_cost     NUMERIC(12,6) NOT NULL DEFAULT 0,
  status             run_status_t NOT NULL DEFAULT 'RUNNING',
  error_code         TEXT,
  error_message      TEXT,
  repair_attempted   BOOLEAN      NOT NULL DEFAULT false,
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX agent_runs_session_idx     ON agent_runs (session_id);
CREATE INDEX agent_runs_application_idx ON agent_runs (application_id);
CREATE INDEX agent_runs_status_idx      ON agent_runs (status);

CREATE TABLE tool_calls (
  id             BIGSERIAL PRIMARY KEY,
  agent_run_id   UUID        NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence       INTEGER     NOT NULL,
  tool_name      TEXT        NOT NULL,
  arguments_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result_json    JSONB,
  latency_ms     INTEGER,
  status         TEXT        NOT NULL CHECK (status IN ('OK','ERROR')),
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, sequence)
);

CREATE INDEX tool_calls_run_idx  ON tool_calls (agent_run_id);
CREATE INDEX tool_calls_name_idx ON tool_calls (tool_name);

-- FK diferida de decisions hacia agent_runs (se crea aqui porque agent_runs nace despues).
ALTER TABLE decisions
  ADD CONSTRAINT decisions_agent_run_fk
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
