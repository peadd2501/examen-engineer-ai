-- 0010: la fase de finalizacion estructurada.
--
-- Un run ahora tiene dos fases distintas: el agente recolecta evidencia con las
-- herramientas de dominio, y el finalizer emite el dictamen mediante una
-- function call forzada. Sin la columna `phase` no se puede distinguir una
-- truncacion del agente de una del finalizer, que se arreglan en lugares
-- distintos.

ALTER TABLE agent_iterations ADD COLUMN phase TEXT NOT NULL DEFAULT 'AGENT'
  CHECK (phase IN ('AGENT', 'FINALIZER', 'FINALIZER_REPAIR'));
ALTER TABLE agent_iterations ADD COLUMN function_name TEXT;
-- Longitud de los argumentos, nunca su contenido: los argumentos validos siguen
-- por el pipeline normal y no se duplican en la tabla de diagnostico.
ALTER TABLE agent_iterations ADD COLUMN arguments_length INTEGER NOT NULL DEFAULT 0;

CREATE INDEX agent_iterations_phase_idx ON agent_iterations (phase);
