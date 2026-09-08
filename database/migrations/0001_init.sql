-- 0001_init: tipos base, solicitudes e indicadores precalculados.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TYPE sector_t AS ENUM (
  'comercio','manufactura','servicios','agropecuario','transporte','construccion','otros'
);

CREATE TYPE collateral_t AS ENUM ('ninguna','fiduciaria','prendaria','hipotecaria');

CREATE TABLE applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name          TEXT           NOT NULL CHECK (length(company_name) BETWEEN 1 AND 200),
  sector                sector_t       NOT NULL,
  months_operation      INTEGER        NOT NULL CHECK (months_operation >= 0 AND months_operation <= 1200),
  requested_amount      NUMERIC(18,2)  NOT NULL CHECK (requested_amount > 0),
  term_months           INTEGER        NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  -- Contenido NO CONFIABLE (G5): se guarda tal cual, se trata como dato, nunca como instruccion.
  funds_destination     TEXT           NOT NULL,
  annual_sales          NUMERIC(18,2)  NOT NULL,
  net_income            NUMERIC(18,2)  NOT NULL,
  total_assets          NUMERIC(18,2)  NOT NULL,
  total_liabilities     NUMERIC(18,2)  NOT NULL,
  annual_existing_debt  NUMERIC(18,2)  NOT NULL,
  history_score         INTEGER        NOT NULL CHECK (history_score BETWEEN 0 AND 100),
  collateral            collateral_t   NOT NULL,
  application_date      DATE           NOT NULL,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX applications_sector_idx ON applications (sector);
CREATE INDEX applications_date_idx   ON applications (application_date);

-- Indicadores precalculados. NULL = no calculable con los datos dados (denominador 0),
-- que es semanticamente distinto de 0.
CREATE TABLE application_indicators (
  application_id         UUID PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  debt_ratio             NUMERIC(20,6),
  net_margin             NUMERIC(20,6),
  debt_service_coverage  NUMERIC(20,6),
  amount_sales_ratio     NUMERIC(20,6),
  estimated_annual_installment NUMERIC(20,6),
  months_operation       INTEGER      NOT NULL,
  anomalies              TEXT[]       NOT NULL DEFAULT '{}',
  calculated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  calculation_version    INTEGER      NOT NULL
);

CREATE INDEX application_indicators_version_idx ON application_indicators (calculation_version);
