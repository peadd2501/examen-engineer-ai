-- 0009: diagnostico por iteracion y semilla de inferencia.
--
-- Con CASE-01 terminando en finish_reason='length' hace falta poder responder
-- "que consumio la salida" sin adivinar: cuantas iteraciones hubo, cuantos tool
-- calls, que tan grandes fueron sus argumentos, cuanto contenido final hubo y
-- si paso el esquema.
--
-- Solo metadata. Ni razonamiento, ni chain-of-thought, ni el contenido generado:
-- se guarda la LONGITUD del contenido, nunca el contenido.

ALTER TABLE agent_runs ADD COLUMN inference_seed INTEGER;

CREATE TABLE agent_iterations (
  id                    BIGSERIAL PRIMARY KEY,
  agent_run_id          UUID    NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  iteration             INTEGER NOT NULL,
  finish_reason         TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  /* longitud del contenido final, no el contenido */
  content_length_chars  INTEGER NOT NULL DEFAULT 0,
  tool_call_count       INTEGER NOT NULL DEFAULT 0,
  tool_names            TEXT[]  NOT NULL DEFAULT '{}',
  tool_argument_lengths INTEGER[] NOT NULL DEFAULT '{}',
  had_final_content     BOOLEAN NOT NULL DEFAULT false,
  schema_valid          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, iteration)
);

CREATE INDEX agent_iterations_run_idx    ON agent_iterations (agent_run_id, iteration);
CREATE INDEX agent_iterations_finish_idx ON agent_iterations (finish_reason);
