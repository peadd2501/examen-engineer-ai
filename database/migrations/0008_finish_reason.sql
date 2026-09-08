-- 0008: telemetria de generacion.
--
-- Sin finish_reason no se puede distinguir "el modelo respondio algo invalido"
-- de "la generacion se corto a la mitad". Son fallas distintas con arreglos
-- distintos: la primera se corrige con schema o prompt, la segunda con
-- presupuesto de tokens.
--
-- reasoning_tokens permite verificar que el esfuerzo de razonamiento
-- configurado ('low') realmente mantiene el consumo bajo, en vez de suponerlo.

ALTER TABLE agent_runs ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN last_finish_reason TEXT;

CREATE INDEX agent_runs_finish_reason_idx ON agent_runs (last_finish_reason);
