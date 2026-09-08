import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ApplicationNotFoundError,
  GuardrailViolationError,
  calcularIndicadores,
  calcularNivelRiesgo,
  type Confirmacion,
  type Dictamen,
  type FragmentoPoliticaEnriquecido,
} from '@credit/contracts';
import type { AgentAnalysisResult, AgentProvider } from '../agents/agent-provider.js';
import { hidratarCitas } from '../agents/corpus-context.js';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';
import {
  finalizarAgentRun,
  iniciarAgentRun,
  registrarIteraciones,
  registrarToolCalls,
} from '../infrastructure/repositories/agent-run-repository.js';
import { registrarEntradaNoConfiable, type GuardrailFinding } from '../domain/guardrails/index.js';
import { generarClaveIdempotencia, registrarDictamen } from './registrar-dictamen.js';

export interface AnalyzeInput {
  idSolicitud: string;
  sessionId?: string;
  /** Progreso para SSE. Recibe eventos ya seguros para mostrar al analista. */
  onEvent?: (evento: { type: string; label?: string; data?: Record<string, unknown> }) => void;
  /** Identificador del intento logico. Fijarlo hace el analisis idempotente. */
  intentoLogico?: string;
  consultaAnalista?: string;
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  runId: string;
  confirmacion: Confirmacion | null;
  dictamen: Dictamen | null;
  politicasRecuperadas: FragmentoPoliticaEnriquecido[];
  findings: GuardrailFinding[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    estimatedCost: string;
    costReportedByProvider: boolean;
  };
  latencyMs: number;
  toolSequence: string[];
  /** Modelo que realmente respondio, segun el proveedor. */
  resolvedModel: string | null;
  /** finish_reason de la ultima respuesta del proveedor. */
  lastFinishReason: string | null;
  /** Metadata segura por llamada al proveedor. Sin razonamiento ni contenido. */
  iterationDiagnostics: AgentAnalysisResult['iterationDiagnostics'];
  failure?: { code: string; message: string };
}

/**
 * Caso de uso completo: contexto -> agente -> guardarrailes -> persistencia.
 *
 * Los guardarrailes y la persistencia viven aqui, FUERA del proveedor, para que
 * cambiar de OpenRouter a Mastra no toque nada de lo que tiene autoridad.
 */
export async function analizarSolicitud(
  pool: Pool,
  provider: AgentProvider,
  input: AnalyzeInput,
): Promise<AnalyzeResult> {
  const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [input.idSolicitud]);
  const row = rows[0];
  if (!row) throw new ApplicationNotFoundError(input.idSolicitud);

  const solicitud = rowToSolicitud(row);
  const indicadores = calcularIndicadores(solicitud);
  const sessionId = input.sessionId ?? randomUUID();

  const emitir = input.onEvent ?? ((): void => undefined);

  const runId = await iniciarAgentRun(pool, {
    sessionId,
    applicationId: solicitud.id_solicitud,
    configuredModel: provider.model,
    provider: provider.name,
    inferenceSeed: provider.inferenceSeed ?? null,
  });

  emitir({ type: 'run.started', label: 'Analisis iniciado', data: { run_id: runId, session_id: sessionId } });
  emitir({
    type: 'application.loaded',
    label: `Solicitud cargada: ${solicitud.nombre_empresa}`,
    data: { id_solicitud: solicitud.id_solicitud, sector: solicitud.sector },
  });
  emitir({
    type: 'indicators.loaded',
    label: 'Indicadores financieros calculados por el backend',
    data: { indicadores: indicadores as unknown as Record<string, unknown> },
  });

  const findings: GuardrailFinding[] = [];

  // G5: se registra el intento de inyeccion antes de construir el contexto.
  // No bloquea; deja rastro en la auditoria del run.
  const g5 = registrarEntradaNoConfiable(solicitud.destino_fondos);
  findings.push(...g5.findings);
  if (g5.findings.length > 0) {
    emitir({
      type: 'guardrail.checked',
      label: 'Texto del solicitante marcado como no confiable',
      data: { guardrail: 'G5', code: g5.findings[0]?.code, details: g5.findings[0]?.details },
    });
  }

  const resultado = await provider.analyze(
    { solicitud, indicadores, ...(input.consultaAnalista ? { consultaAnalista: input.consultaAnalista } : {}) },
    {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    },
  );

  await registrarToolCalls(pool, runId, resultado.toolCalls);
  await registrarIteraciones(pool, runId, resultado.iterationDiagnostics);

  const idsRecuperados = [...new Set(resultado.politicasRecuperadas.map((p) => p.id_politica))];
  // Lo que el modelo tenia a la vista: corpus inyectado mas lo recuperado por tool.
  const idsDisponibles = [...new Set([...resultado.politicasDisponibles, ...idsRecuperados])];
  const toolSequence = resultado.toolCalls.map((c) => `${c.sequence}:${c.toolName}:${c.status}`);

  // --- El loop fallo de forma controlada -----------------------------------
  if (!resultado.candidato) {
    const failure = resultado.failure ?? { code: 'UNKNOWN', message: 'El agente no produjo dictamen' };
    await finalizarAgentRun(pool, {
      runId,
      status: failure.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      usage: resultado.usage,
      latencyMs: resultado.latencyMs,
      repairAttempted: resultado.repairAttempted,
      resolvedModel: resultado.resolvedModel,
      lastFinishReason: resultado.lastFinishReason,
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    await persistirFindings(pool, runId, findings);

    emitir({
      type: failure.code === 'CANCELLED' ? 'run.cancelled' : 'run.failed',
      label: mensajeAmigable(failure.code),
      data: { code: failure.code, detail: failure.message },
    });

    return {
      runId,
      confirmacion: null,
      dictamen: null,
      politicasRecuperadas: resultado.politicasRecuperadas,
      findings,
      usage: resultado.usage,
      latencyMs: resultado.latencyMs,
      toolSequence,
      resolvedModel: resultado.resolvedModel,
      lastFinishReason: resultado.lastFinishReason,
      iterationDiagnostics: resultado.iterationDiagnostics,
      failure,
    };
  }

  // --- Hidratacion de citas ------------------------------------------------
  // El modelo solo devolvio identificadores. El texto literal y la seccion se
  // leen del corpus: el modelo no tiene forma de escribirlos, y por lo tanto
  // tampoco de alucinarlos. Un id inexistente no puede pasar el enum del schema,
  // pero si el proveedor ignorara el schema se registra aqui como hallazgo G1.
  const { citas, desconocidos } = await hidratarCitas(pool, resultado.candidato.policy_ids);
  for (const id of desconocidos) {
    findings.push({
      guardrail: 'G1',
      code: 'UNKNOWN_POLICY_REFERENCE',
      message: `El modelo referencio una politica inexistente: ${id}`,
      details: { id_politica: id, motivo: 'POLICY_NOT_FOUND' },
    });
  }

  const { policy_ids: _referencias, ...candidatoSinReferencias } = resultado.candidato;

  // --- Nivel de riesgo autoritativo ----------------------------------------
  // Lo calcula el backend sobre indicadores y datos estructurados, con umbrales
  // del corpus. El modelo ya no lo produce: en CASE-09 devolvio ALTO sin
  // respaldo y eso activo G4 sobre un dato inventado.
  const riesgo = calcularNivelRiesgo(solicitud, indicadores);
  for (const factor of riesgo.factores) {
    findings.push({
      guardrail: 'G4',
      code: 'RISK_FACTOR',
      message: `${factor.codigo}: ${factor.detalle}`,
      details: { politica: factor.politica, codigo: factor.codigo, nivel: riesgo.nivel },
    });
  }

  // --- Dictamen candidato + datos autoritativos ----------------------------
  const dictamen: Dictamen = {
    ...candidatoSinReferencias,
    id_solicitud: solicitud.id_solicitud,
    politicas_citadas: citas,
    // Los indicadores del dictamen SIEMPRE son los del backend (G2).
    indicadores,
    // Y el nivel de riesgo tambien. G4 consume solo este valor.
    nivel_riesgo: riesgo.nivel,
    // La necesidad de autorizacion la recalcula registrarDictamen (G4).
    requiere_autorizacion_humana: false,
  };

  const clave = generarClaveIdempotencia(solicitud.id_solicitud, input.intentoLogico ?? runId);

  try {
    const { confirmacion, findings: persistFindings } = await registrarDictamen(pool, {
      id_solicitud: solicitud.id_solicitud,
      dictamen,
      clave_idempotencia: clave,
      politicasRecuperadas: idsDisponibles,
      agentRunId: runId,
    });
    findings.push(...persistFindings);

    emitir({
      type: 'guardrail.checked',
      label: 'Validaciones de seguridad completadas',
      data: {
        decision: confirmacion.decision,
        estado: confirmacion.operational_status,
        hallazgos: findings.map((f) => `${f.guardrail}/${f.code}`),
      },
    });
    emitir({
      type: 'dictamen.completed',
      label: etiquetaDeCierre(confirmacion.decision, confirmacion.operational_status),
      data: { id_dictamen: confirmacion.id_dictamen, decision: confirmacion.decision, estado: confirmacion.operational_status },
    });

    await finalizarAgentRun(pool, {
      runId,
      status: 'COMPLETED',
      usage: resultado.usage,
      latencyMs: resultado.latencyMs,
      repairAttempted: resultado.repairAttempted,
      resolvedModel: resultado.resolvedModel,
      lastFinishReason: resultado.lastFinishReason,
    });
    await persistirFindings(pool, runId, findings);
    emitir({ type: 'run.completed', label: 'Analisis completado', data: { run_id: runId } });

    return {
      runId,
      confirmacion,
      dictamen: { ...dictamen, decision: confirmacion.decision, requiere_autorizacion_humana: confirmacion.requiere_autorizacion_humana },
      politicasRecuperadas: resultado.politicasRecuperadas,
      findings,
      usage: resultado.usage,
      latencyMs: resultado.latencyMs,
      toolSequence,
      resolvedModel: resultado.resolvedModel,
      lastFinishReason: resultado.lastFinishReason,
      iterationDiagnostics: resultado.iterationDiagnostics,
    };
  } catch (error) {
    if (error instanceof GuardrailViolationError) {
      const detalles = error.details as { findings?: GuardrailFinding[] } | undefined;
      findings.push(...(detalles?.findings ?? []));
    }
    await finalizarAgentRun(pool, {
      runId,
      status: 'FAILED',
      usage: resultado.usage,
      latencyMs: resultado.latencyMs,
      repairAttempted: resultado.repairAttempted,
      resolvedModel: resultado.resolvedModel,
      lastFinishReason: resultado.lastFinishReason,
      errorCode: error instanceof GuardrailViolationError ? error.code : 'PERSISTENCE_FAILED',
      errorMessage: error instanceof Error ? error.message : 'error desconocido',
    });
    await persistirFindings(pool, runId, findings);
    emitir({
      type: 'run.failed',
      label: error instanceof GuardrailViolationError
        ? `Bloqueado por el guardarrail ${error.guardrail}`
        : 'El analisis no pudo completarse',
      data: {
        code: error instanceof GuardrailViolationError ? error.code : 'PERSISTENCE_FAILED',
        detail: error instanceof Error ? error.message : 'error desconocido',
      },
    });
    throw error;
  }
}

/** Traduce el codigo de fallo a algo que un analista entienda. */
function mensajeAmigable(code: string): string {
  const mensajes: Record<string, string> = {
    PROVIDER_RATE_LIMITED: 'El proveedor de IA alcanzo temporalmente su limite de solicitudes',
    PROVIDER_TIMEOUT: 'El proveedor tardo demasiado en responder',
    PROVIDER_UNAVAILABLE: 'El proveedor de IA no esta disponible',
    OUTPUT_TOKEN_LIMIT_EXCEEDED: 'La generacion no pudo completarse dentro del limite configurado',
    EMPTY_PROVIDER_RESPONSE: 'El proveedor respondio sin contenido',
    STRUCTURED_OUTPUT_UNSUPPORTED: 'El modelo seleccionado no soporta el formato estructurado requerido',
    REASONING_EFFORT_UNSUPPORTED: 'El modelo no acepta la configuracion de razonamiento',
    AGENT_SCHEMA_VALIDATION_FAILED: 'La respuesta del modelo no cumplio el formato requerido',
    MAX_ITERATIONS_EXCEEDED: 'El analisis excedio el numero maximo de pasos',
    MAX_TOOL_CALLS_EXCEEDED: 'El analisis excedio el numero maximo de consultas',
    TOTAL_TIMEOUT: 'El analisis excedio el tiempo maximo',
    CANCELLED: 'Analisis cancelado',
  };
  return mensajes[code] ?? 'El analisis no pudo completarse';
}

function etiquetaDeCierre(decision: string, estado: string): string {
  if (estado === 'PENDING_AUTHORIZATION') return 'Dictamen generado: requiere autorizacion del analista';
  if (estado === 'PENDING_COMMITTEE') return 'Escalado a comite';
  if (decision === 'APROBADO') return 'Dictamen generado: APROBADO';
  if (decision === 'RECHAZADO') return 'Dictamen generado: RECHAZADO';
  return 'Dictamen generado';
}

async function persistirFindings(pool: Pool, runId: string, findings: GuardrailFinding[]): Promise<void> {
  for (const f of findings) {
    await pool.query(
      `INSERT INTO guardrail_findings (agent_run_id, guardrail, code, message, details_json)
       VALUES ($1,$2,$3,$4,$5)`,
      [runId, f.guardrail, f.code, f.message, JSON.stringify(f.details ?? {})],
    );
  }
}
