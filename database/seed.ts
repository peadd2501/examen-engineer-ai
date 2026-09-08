import 'dotenv/config';
import type { PoolClient } from 'pg';
import { calcularIndicadores, POLICY_CORPUS_VERSION } from '@credit/contracts';
import { loadCorpus } from '@credit/policies';
import { createPool } from './db.js';
import { generarDataset, type SolicitudGenerada } from './generator.js';

/**
 * Seed determinista e idempotente: TRUNCATE + carga completa dentro de una
 * unica transaccion. Correrlo dos veces produce exactamente la misma base.
 */

async function cargarPoliticas(client: PoolClient): Promise<number> {
  const corpus = loadCorpus();

  for (const p of corpus.politicas) {
    await client.query(
      `INSERT INTO policies (id, section, category, text, severity, version, active, effective_from, effective_to, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, p.seccion, p.categoria, p.texto, p.severidad, p.version, p.activa, p.vigente_desde, p.vigente_hasta, p.metadata],
    );
  }
  for (const r of corpus.relaciones) {
    await client.query(
      'INSERT INTO policy_relations (source_policy_id, target_policy_id, relation_type) VALUES ($1,$2,$3)',
      [r.source_policy_id, r.target_policy_id, r.relation_type],
    );
  }
  return corpus.politicas.length;
}

async function cargarSolicitudes(client: PoolClient, dataset: SolicitudGenerada[]): Promise<void> {
  for (const { solicitud: s } of dataset) {
    await client.query(
      `INSERT INTO applications
         (id, company_name, sector, months_operation, requested_amount, term_months, funds_destination,
          annual_sales, net_income, total_assets, total_liabilities, annual_existing_debt,
          history_score, collateral, application_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [s.id_solicitud, s.nombre_empresa, s.sector, s.meses_operacion, s.monto_solicitado, s.plazo_meses,
       s.destino_fondos, s.ventas_anuales, s.utilidad_neta, s.activos_totales, s.pasivos_totales,
       s.deuda_vigente_anual, s.score_historial, s.garantia_ofrecida, s.fecha_solicitud],
    );

    // Precalculo determinista. Es la misma funcion pura que usara la tool
    // calcular_indicadores en FASE 3: una sola fuente de verdad numerica.
    const i = calcularIndicadores(s);
    await client.query(
      `INSERT INTO application_indicators
         (application_id, debt_ratio, net_margin, debt_service_coverage, amount_sales_ratio,
          estimated_annual_installment, months_operation, anomalies, calculation_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id_solicitud, i.razon_endeudamiento, i.margen_neto, i.cobertura_servicio_deuda,
       i.relacion_monto_ventas, i.cuota_anual_estimada, i.antiguedad_meses, i.anomalias, i.calculation_version],
    );
  }
}

async function main(): Promise<void> {
  const seed = process.env.SEED ?? '20260907';
  const dataset = generarDataset(seed);
  const pool = createPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE decision_policy_citations, decision_authorizations, decisions, tool_calls, agent_runs, application_indicators, applications, policy_relations, policies RESTART IDENTITY CASCADE');

    const totalPoliticas = await cargarPoliticas(client);
    await cargarSolicitudes(client, dataset);
    await client.query('COMMIT');

    const cuenta = async (sql: string): Promise<string> =>
      (await pool.query<{ n: string }>(sql)).rows[0]?.n ?? '0';

    console.log(`SEED=${seed}  POLICY_CORPUS_VERSION=${POLICY_CORPUS_VERSION}`);
    console.log(`  politicas insertadas ........ ${totalPoliticas}`);
    console.log(`  relaciones .................. ${await cuenta('SELECT count(*)::text n FROM policy_relations')}`);
    console.log(`  solicitudes insertadas ...... ${await cuenta('SELECT count(*)::text n FROM applications')}`);
    console.log(`  indicadores precalculados ... ${await cuenta('SELECT count(*)::text n FROM application_indicators')}`);
    console.log(`  con anomalias detectadas .... ${await cuenta("SELECT count(*)::text n FROM application_indicators WHERE cardinality(anomalies) > 0")}`);
    console.log(`  adversariales (inyeccion) ... ${dataset.filter((x) => x.tag === 'injection').length}`);
    console.log(`  inconsistentes .............. ${dataset.filter((x) => x.tag === 'inconsistent').length}`);
    console.log(`  fixtures de evaluacion ...... ${dataset.filter((x) => x.tag === 'eval').length}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
