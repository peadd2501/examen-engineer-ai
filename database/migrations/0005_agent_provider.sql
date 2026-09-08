-- 0005_agent_provider: el proveedor forma parte de la trazabilidad del run.
-- Sin esta columna no se puede distinguir un run de OpenRouter de uno guionado.

ALTER TABLE agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX agent_runs_provider_idx ON agent_runs (provider);

-- Hallazgos de guardarrailes del run, para auditoria.
-- Se guardan aunque el dictamen se haya persistido: un G5 marcado o una cita
-- no recuperada no bloquean, pero deben quedar registrados.
CREATE TABLE guardrail_findings (
  id           BIGSERIAL PRIMARY KEY,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  decision_id  UUID REFERENCES decisions(id) ON DELETE CASCADE,
  guardrail    TEXT NOT NULL CHECK (guardrail IN ('G1','G2','G3','G4','G5')),
  code         TEXT NOT NULL,
  message      TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guardrail_findings_run_idx      ON guardrail_findings (agent_run_id);
CREATE INDEX guardrail_findings_guardrail_idx ON guardrail_findings (guardrail);
