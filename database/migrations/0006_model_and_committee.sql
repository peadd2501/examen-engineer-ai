-- 0006: trazabilidad del modelo REAL y separacion entre escalamiento y autorizacion.

-- (a) OpenRouter puede enrutar a un modelo distinto del solicitado. Sin esta
--     distincion no se puede afirmar que modelo produjo cada dictamen.
ALTER TABLE agent_runs RENAME COLUMN model TO configured_model;
ALTER TABLE agent_runs ADD COLUMN resolved_model TEXT;
CREATE INDEX agent_runs_resolved_model_idx ON agent_runs (resolved_model);

-- (b) Escalar a comite y requerir autorizacion humana son actos humanos distintos:
--     el primero dice "el sistema no pudo recomendar"; el segundo dice
--     "hay una recomendacion firme que necesita firma". Mezclarlos producia
--     escalamientos marcados como requires_human_authorization = true.
ALTER TYPE operational_status_t ADD VALUE IF NOT EXISTS 'PENDING_COMMITTEE';
