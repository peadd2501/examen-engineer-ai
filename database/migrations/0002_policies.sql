-- 0002_policies: corpus de politicas, relaciones regla<->excepcion y full text search.

CREATE TYPE policy_category_t AS ENUM (
  'elegibilidad','capacidad_pago','score','garantia','sector',
  'monto','plazo','autorizacion','excepcion','documentacion'
);

CREATE TYPE policy_severity_t AS ENUM ('informativa','media','critica');

CREATE TYPE policy_relation_t AS ENUM (
  'OVERRIDES_PARTIALLY','OVERRIDES_FULLY','COMPLEMENTS','DEPENDS_ON'
);

CREATE TABLE policies (
  id             TEXT PRIMARY KEY,                 -- p.ej. 'POL-2.3'
  section        TEXT               NOT NULL,
  category       policy_category_t  NOT NULL,
  text           TEXT               NOT NULL,
  severity       policy_severity_t  NOT NULL DEFAULT 'media',
  version        TEXT               NOT NULL,
  active         BOOLEAN            NOT NULL DEFAULT true,
  effective_from DATE               NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  metadata_json  JSONB              NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ        NOT NULL DEFAULT now(),
  -- Nota: la columna generada solo puede usar expresiones IMMUTABLE.
  -- El cast enum->text (category::text) es STABLE, no IMMUTABLE, asi que la
  -- categoria NO entra al tsvector: se filtra por la columna `category` con su
  -- propio indice, que ademas es exacto en lugar de aproximado.
  search_vector  tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('spanish', coalesce(section, '')), 'A') ||
      setweight(to_tsvector('spanish', coalesce(text, '')), 'B')
  ) STORED,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX policies_search_idx   ON policies USING GIN (search_vector);
CREATE INDEX policies_category_idx ON policies (category);
CREATE INDEX policies_active_idx   ON policies (active);

-- Relacion explicita entre reglas y excepciones.
-- Evita que el LLM tenga que inferir por si solo que POL-7.3 modifica a POL-2.3.
CREATE TABLE policy_relations (
  source_policy_id TEXT              NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  target_policy_id TEXT              NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  relation_type    policy_relation_t NOT NULL,
  PRIMARY KEY (source_policy_id, target_policy_id, relation_type),
  CHECK (source_policy_id <> target_policy_id)
);

CREATE INDEX policy_relations_target_idx ON policy_relations (target_policy_id);
