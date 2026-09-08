-- 0003_decisions: dictamenes, citas y guardarrailes con autoridad en la base de datos.

CREATE TYPE decision_t AS ENUM ('APROBADO','RECHAZADO','ESCALADO_A_COMITE');
CREATE TYPE risk_level_t AS ENUM ('BAJO','MEDIO','ALTO');
CREATE TYPE operational_status_t AS ENUM (
  'DRAFT','GENERATED','PENDING_AUTHORIZATION','CONFIRMED','REJECTED_BY_ANALYST'
);

CREATE TABLE decisions (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id               UUID           NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  decision                     decision_t     NOT NULL,
  recommended_amount           NUMERIC(18,2),
  recommended_term_months      INTEGER CHECK (recommended_term_months BETWEEN 1 AND 120),
  risk_level                   risk_level_t   NOT NULL,
  confidence                   NUMERIC(4,3)   NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  requires_human_authorization BOOLEAN        NOT NULL,
  operational_status           operational_status_t NOT NULL DEFAULT 'GENERATED',
  reasons                      TEXT[]         NOT NULL DEFAULT '{}',
  -- Snapshots: el guardarrail G3 se evalua contra el estado del momento,
  -- no contra tablas que pueden cambiar despues.
  requested_amount_snapshot    NUMERIC(18,2)  NOT NULL,
  max_allowed_amount           NUMERIC(18,2)  NOT NULL,
  indicators_snapshot          JSONB          NOT NULL,
  agent_run_id                 UUID,
  idempotency_key              TEXT           NOT NULL,
  created_at                   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  confirmed_at                 TIMESTAMPTZ,
  confirmed_by                 TEXT,

  -- G3: topes de politica aplicados por la base de datos, no por el modelo.
  CONSTRAINT g3_amount_le_requested
    CHECK (recommended_amount IS NULL OR recommended_amount <= requested_amount_snapshot),
  CONSTRAINT g3_amount_le_policy_cap
    CHECK (recommended_amount IS NULL OR recommended_amount <= max_allowed_amount),
  CONSTRAINT g3_amount_positive
    CHECK (recommended_amount IS NULL OR recommended_amount > 0),

  -- Un RECHAZADO no puede llevar monto recomendado.
  CONSTRAINT rejected_has_no_amount
    CHECK (decision <> 'RECHAZADO' OR recommended_amount IS NULL),

  -- G4: si requiere autorizacion humana no puede nacer firme.
  CONSTRAINT g4_requires_authorization_flow
    CHECK (
      requires_human_authorization = false
      OR operational_status IN ('PENDING_AUTHORIZATION','CONFIRMED','REJECTED_BY_ANALYST')
    ),

  -- Coherencia del cierre humano.
  CONSTRAINT confirmed_has_timestamp
    CHECK (operational_status <> 'CONFIRMED' OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

-- 17. Idempotencia: la misma clave nunca produce un segundo dictamen.
CREATE UNIQUE INDEX decisions_idempotency_key_uidx ON decisions (idempotency_key);
CREATE INDEX decisions_application_idx ON decisions (application_id);
CREATE INDEX decisions_status_idx      ON decisions (operational_status);
CREATE INDEX decisions_created_idx     ON decisions (created_at DESC);

-- Citas verificadas (G1). Se insertan en la misma transaccion que el dictamen.
CREATE TABLE decision_policy_citations (
  id            BIGSERIAL PRIMARY KEY,
  decision_id   UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  policy_id     TEXT NOT NULL REFERENCES policies(id) ON DELETE RESTRICT,
  section       TEXT NOT NULL,
  literal_text  TEXT NOT NULL,
  /* true = el texto literal fue verificado contra el corpus antes de persistir */
  verified      BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (decision_id, policy_id, section)
);

CREATE INDEX decision_citations_decision_idx ON decision_policy_citations (decision_id);

-- G1 a nivel de datos: una decision firme (APROBADO/RECHAZADO) exige al menos una cita.
-- Se valida con trigger CONSTRAINT diferido porque las citas se insertan despues del dictamen,
-- dentro de la misma transaccion.
CREATE OR REPLACE FUNCTION enforce_citation_requirement() RETURNS trigger AS $$
BEGIN
  IF NEW.decision IN ('APROBADO','RECHAZADO') THEN
    IF NOT EXISTS (SELECT 1 FROM decision_policy_citations c WHERE c.decision_id = NEW.id) THEN
      RAISE EXCEPTION 'G1: la decision % (%) requiere al menos una cita de politica verificada',
        NEW.id, NEW.decision
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER decisions_require_citation
  AFTER INSERT OR UPDATE ON decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_citation_requirement();

-- Bitacora de autorizacion humana.
CREATE TABLE decision_authorizations (
  id           BIGSERIAL PRIMARY KEY,
  decision_id  UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('CONFIRMAR','RECHAZAR')),
  analyst      TEXT NOT NULL,
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
