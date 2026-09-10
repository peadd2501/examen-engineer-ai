import type { Pool } from 'pg';
import { INDICATOR_CALC_VERSION, POLICY_CORPUS_VERSION, PROMPT_VERSION } from '@credit/contracts';
import type {
  AgentIterationDiagnostic,
  AgentToolCallRecord,
  AgentUsage,
} from '../../agents/agent-provider.js';

/**
 * Observabilidad: lo suficiente para reconstruir que hizo el agente y cuanto
 * costo, sin secretos ni razonamiento interno del modelo.
 *
 * De razonamiento se guarda solo el CONTEO de tokens (`reasoning_tokens`), que es
 * una metrica de costo. Los `reasoning_details` no se persisten nunca.
 */

export interface AgentRunStart {
  sessionId: string;
  applicationId: string;
  /** Lo que pedimos en .env. */
  configuredModel: string;
  provider: string;
  /** Semilla de inferencia enviada al proveedor, si aplica. */
  inferenceSeed?: number | null;
}

export async function iniciarAgentRun(pool: Pool, input: AgentRunStart): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs
       (session_id, application_id, prompt_version, policy_corpus_version, indicator_calc_version,
        configured_model, provider, inference_seed, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING') RETURNING id`,
    [
      input.sessionId,
      input.applicationId,
      PROMPT_VERSION,
      POLICY_CORPUS_VERSION,
      INDICATOR_CALC_VERSION,
      input.configuredModel,
      input.provider,
      input.inferenceSeed ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('No se pudo crear el agent_run');
  return id;
}

export interface AgentRunFinish {
  runId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  usage: AgentUsage;
  latencyMs: number;
  repairAttempted: boolean;
  /** Modelo que realmente respondio. Puede diferir del configurado. */
  resolvedModel?: string | null;
  /** finish_reason de la ultima respuesta del proveedor. */
  lastFinishReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function finalizarAgentRun(pool: Pool, input: AgentRunFinish): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
        SET status = $2, input_tokens = $3, output_tokens = $4, latency_ms = $5,
            estimated_cost = $6, repair_attempted = $7, error_code = $8, error_message = $9,
            resolved_model = $10, reasoning_tokens = $11, last_finish_reason = $12,
            finished_at = now()
      WHERE id = $1`,
    [
      input.runId,
      input.status,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.latencyMs,
      input.usage.estimatedCost,
      input.repairAttempted,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.resolvedModel ?? null,
      input.usage.reasoningTokens,
      input.lastFinishReason ?? null,
    ],
  );
}

/** Trunca resultados grandes: la auditoria no necesita el corpus completo. */
function acotar(valor: unknown): unknown {
  const texto = JSON.stringify(valor ?? null);
  if (texto.length <= 8000) return valor;
  return { _truncado: true, _bytes: texto.length, preview: texto.slice(0, 2000) };
}

export async function registrarToolCalls(
  pool: Pool,
  runId: string,
  calls: AgentToolCallRecord[],
): Promise<void> {
  for (const call of calls) {
    await pool.query(
      `INSERT INTO tool_calls (agent_run_id, sequence, tool_name, arguments_json, result_json, latency_ms, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (agent_run_id, sequence) DO NOTHING`,
      [
        runId,
        call.sequence,
        call.toolName,
        JSON.stringify(acotar(call.arguments)),
        JSON.stringify(acotar(call.result)),
        call.latencyMs,
        call.status,
        call.errorMessage ?? null,
      ],
    );
  }
}

/**
 * Persiste el diagnostico por iteracion.
 *
 * Todo lo que entra aqui son numeros, nombres de herramienta y banderas. El
 * contenido generado y el razonamiento no pasan por esta funcion.
 */
export async function registrarIteraciones(
  pool: Pool,
  runId: string,
  diagnosticos: AgentIterationDiagnostic[],
): Promise<void> {
  for (const d of diagnosticos) {
    await pool.query(
      `INSERT INTO agent_iterations
         (agent_run_id, iteration, phase, finish_reason, input_tokens, output_tokens, reasoning_tokens,
          content_length_chars, tool_call_count, tool_names, tool_argument_lengths,
          function_name, arguments_length, had_final_content, schema_valid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (agent_run_id, iteration) DO NOTHING`,
      [
        runId, d.iteration, d.phase, d.finishReason, d.inputTokens, d.outputTokens, d.reasoningTokens,
        d.contentLengthChars, d.toolCallCount, d.toolNames, d.toolArgumentLengths,
        d.functionName, d.argumentsLength, d.hadFinalContent, d.schemaValid,
      ],
    );
  }
}
