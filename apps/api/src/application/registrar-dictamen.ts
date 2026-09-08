import type { Pool, PoolClient } from 'pg';
import {
  ApplicationNotFoundError,
  ConfirmacionSchema,
  DictamenSchema,
  GuardrailViolationError,
  type Confirmacion,
  type Dictamen,
} from '@credit/contracts';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';
import {
  calcularTopeAutoritativo,
  resolverAutorizacion,
  verificarAutorizacion,
  verificarCitas,
  verificarCoherenciaNumerica,
  verificarTopes,
  type GuardrailFinding,
} from '../domain/guardrails/index.js';
import { calcularIndicadores } from '@credit/contracts';

export interface RegistrarDictamenInput {
  id_solicitud: string;
  dictamen: Dictamen;
  clave_idempotencia: string;
  /** Ids recuperados en el run, para que G1 distinga cita con evidencia de cita de memoria. */
  politicasRecuperadas?: string[];
  agentRunId?: string | null;
}

export interface RegistrarDictamenResult {
  confirmacion: Confirmacion;
  findings: GuardrailFinding[];
}

interface DecisionRow {
  id: string;
  application_id: string;
  decision: Dictamen['decision'];
  operational_status: Confirmacion['operational_status'];
  requires_human_authorization: boolean;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Persistencia del dictamen. Es el unico camino de escritura.
 *
 * Orden: datos autoritativos -> guardarrailes -> transaccion. Nada se escribe
 * antes de que los guardarrailes pasen, y todo se escribe junto o nada.
 */
export async function registrarDictamen(
  pool: Pool,
  input: RegistrarDictamenInput,
): Promise<RegistrarDictamenResult> {
  // Idempotencia, primer chequeo: si la clave ya existe se devuelve el registro
  // original sin tocar nada. La UNIQUE de la DB es la ultima defensa, no la unica.
  const existente = await buscarPorClave(pool, input.clave_idempotencia);
  if (existente) {
    return { confirmacion: aConfirmacion(existente, true), findings: [] };
  }

  const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [input.id_solicitud]);
  const row = rows[0];
  if (!row) throw new ApplicationNotFoundError(input.id_solicitud);
  const solicitud = rowToSolicitud(row);

  // --- Datos autoritativos: los pone el backend, no el modelo ---------------
  const indicadores = calcularIndicadores(solicitud);
  const tope = calcularTopeAutoritativo(solicitud);
  const findings: GuardrailFinding[] = [];

  let decision = input.dictamen.decision;
  let montoRecomendado = input.dictamen.monto_recomendado;
  let plazoRecomendado = input.dictamen.plazo_recomendado_meses;

  // --- G2: coherencia numerica ---------------------------------------------
  const g2 = verificarCoherenciaNumerica(indicadores, input.dictamen.indicadores);
  findings.push(...g2.findings);
  if (!g2.passed) {
    throw new GuardrailViolationError('G2', 'Los indicadores del dictamen no coinciden con el calculo autoritativo', {
      findings: g2.findings,
    });
  }

  // --- G1: citas verificables ----------------------------------------------
  const g1 = await verificarCitas(pool, {
    citas: input.dictamen.politicas_citadas,
    decisionFirme: decision === 'APROBADO' || decision === 'RECHAZADO',
    politicasRecuperadas: input.politicasRecuperadas ?? [],
  });
  findings.push(...g1.findings);
  // Solo lo verificado llega a la base. Una cita inventada se descarta aqui;
  // persistirla rompeira la integridad referencial y contaminaria la auditoria.
  const citasVerificadas = g1.citasVerificadas;
  if (!g1.passed && g1.forceEscalation) {
    // Una cita no verificable no aborta: degrada a escalamiento, que es la
    // respuesta segura. El caso queda para el analista con el motivo registrado.
    decision = 'ESCALADO_A_COMITE';
    montoRecomendado = null;
    plazoRecomendado = null;
  }

  // Un RECHAZADO nunca lleva monto (constraint de DB), y un escalamiento tampoco.
  if (decision === 'RECHAZADO' || decision === 'ESCALADO_A_COMITE') {
    montoRecomendado = null;
    plazoRecomendado = null;
  }

  // --- G3: topes -----------------------------------------------------------
  const g3 = verificarTopes({
    montoRecomendado,
    montoSolicitado: solicitud.monto_solicitado,
    maxAllowedAmount: tope.maxAllowedAmount,
  });
  findings.push(...g3.findings);
  if (!g3.passed) {
    throw new GuardrailViolationError('G3', 'El monto recomendado viola un tope autoritativo', {
      findings: g3.findings,
      max_allowed_amount: tope.maxAllowedAmount,
      topes_aplicados: tope.aplicados,
    });
  }

  // --- G4: autorizacion humana ---------------------------------------------
  // Un escalamiento va a PENDING_COMMITTEE y NO requiere autorizacion: no hay
  // recomendacion firme que autorizar. Ver authorization.guardrail.ts.
  const { requiereAutorizacion, estadoOperativo } = resolverAutorizacion(
    decision,
    montoRecomendado,
    input.dictamen.nivel_riesgo,
  );
  const g4 = verificarAutorizacion({
    montoRecomendado,
    nivelRiesgo: input.dictamen.nivel_riesgo,
    decision,
    requiereAutorizacionPropuesta: input.dictamen.requiere_autorizacion_humana,
    estadoOperativo,
  });
  findings.push(...g4.findings);
  if (!g4.passed) {
    throw new GuardrailViolationError('G4', 'Violacion del flujo de autorizacion humana', { findings: g4.findings });
  }

  // Se revalida el objeto completo antes de escribir.
  const dictamenFinal = DictamenSchema.parse({
    ...input.dictamen,
    id_solicitud: solicitud.id_solicitud,
    politicas_citadas: citasVerificadas,
    decision,
    monto_recomendado: montoRecomendado,
    plazo_recomendado_meses: plazoRecomendado,
    indicadores,
    requiere_autorizacion_humana: requiereAutorizacion,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const persistido = await insertar(client, {
      solicitud,
      dictamen: dictamenFinal,
      estadoOperativo,
      maxAllowedAmount: tope.maxAllowedAmount,
      claveIdempotencia: input.clave_idempotencia,
      agentRunId: input.agentRunId ?? null,
    });
    await client.query('COMMIT');
    return { confirmacion: aConfirmacion(persistido, false), findings };
  } catch (error) {
    await client.query('ROLLBACK');

    // Carrera: otra transaccion gano con la misma clave. Se devuelve la suya.
    if (esViolacionUnique(error)) {
      const ganador = await buscarPorClave(pool, input.clave_idempotencia);
      if (ganador) return { confirmacion: aConfirmacion(ganador, true), findings };
    }
    throw error;
  } finally {
    client.release();
  }
}

interface InsertInput {
  solicitud: ReturnType<typeof rowToSolicitud>;
  dictamen: Dictamen;
  estadoOperativo: Confirmacion['operational_status'];
  maxAllowedAmount: string;
  claveIdempotencia: string;
  agentRunId: string | null;
}

async function insertar(client: PoolClient, i: InsertInput): Promise<DecisionRow> {
  const { rows } = await client.query<DecisionRow>(
    `INSERT INTO decisions
       (application_id, decision, recommended_amount, recommended_term_months, risk_level, confidence,
        requires_human_authorization, operational_status, reasons, requested_amount_snapshot,
        max_allowed_amount, indicators_snapshot, agent_run_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id, application_id, decision, operational_status, requires_human_authorization, created_at`,
    [
      i.dictamen.id_solicitud,
      i.dictamen.decision,
      i.dictamen.monto_recomendado,
      i.dictamen.plazo_recomendado_meses,
      i.dictamen.nivel_riesgo,
      i.dictamen.confianza,
      i.dictamen.requiere_autorizacion_humana,
      i.estadoOperativo,
      i.dictamen.motivos,
      i.solicitud.monto_solicitado,
      i.maxAllowedAmount,
      JSON.stringify(i.dictamen.indicadores),
      i.agentRunId,
      i.claveIdempotencia,
    ],
  );
  const decision = rows[0];
  if (!decision) throw new Error('El INSERT del dictamen no devolvio fila');

  for (const cita of i.dictamen.politicas_citadas) {
    await client.query(
      `INSERT INTO decision_policy_citations (decision_id, policy_id, section, literal_text, verified)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (decision_id, policy_id, section) DO NOTHING`,
      [decision.id, cita.id_politica, cita.seccion, cita.texto_literal],
    );
  }

  return decision;
}

async function buscarPorClave(pool: Pool, clave: string): Promise<DecisionRow | null> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT id, application_id, decision, operational_status, requires_human_authorization, created_at
     FROM decisions WHERE idempotency_key = $1`,
    [clave],
  );
  return rows[0] ?? null;
}

function aConfirmacion(row: DecisionRow, reutilizado: boolean): Confirmacion {
  return ConfirmacionSchema.parse({
    id_dictamen: row.id,
    id_solicitud: row.application_id,
    operational_status: row.operational_status,
    decision: row.decision,
    requiere_autorizacion_humana: row.requires_human_authorization,
    reutilizado,
    created_at: iso(row.created_at),
  });
}

function esViolacionUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** Clave de idempotencia. La genera el backend; el modelo nunca la ve. */
export function generarClaveIdempotencia(idSolicitud: string, intentoLogico: string): string {
  return `${idSolicitud}:${intentoLogico}`;
}
