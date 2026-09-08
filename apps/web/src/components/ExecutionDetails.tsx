import type { AnalisisResultado } from '../types/view.js';
import type { RunDetalle, VersionInfo } from '../services/api.js';
import { idCorto } from '../features/analysis/format.js';

/**
 * Observabilidad, expandible.
 *
 * Únicamente metadata segura. Nunca razonamiento, `reasoning_details`,
 * chain-of-thought, system prompt ni claves. De razonamiento se muestra el
 * contador de tokens, que es una métrica de costo.
 *
 * Dos fuentes, en este orden:
 *   1. el resultado en memoria, cuando el análisis acaba de correr;
 *   2. `GET /api/runs/:id`, cuando se restauró un dictamen persistido.
 *
 * Si ninguna tiene el dato, se muestra **N/D**. Nunca un cero inventado: un 0
 * de relleno es indistinguible de un 0 medido, y esta tabla existe justamente
 * para poder confiar en lo que dice.
 */
const ND = 'N/D';

function texto(valor: unknown): string {
  if (valor === null || valor === undefined || valor === '') return ND;
  return String(valor);
}

function numero(valor: unknown): string {
  if (valor === null || valor === undefined) return ND;
  const n = Number(valor);
  return Number.isFinite(n) ? String(n) : ND;
}

interface Props {
  resultado: AnalisisResultado;
  version: VersionInfo | null;
  /** Metadata del run leída de la API. null mientras carga o si no existe. */
  runDetalle: RunDetalle | null;
}

export function ExecutionDetails({ resultado, version, runDetalle }: Props) {
  const run = runDetalle?.run ?? null;
  const u = resultado.usage;

  // Se prefiere lo medido en vivo; si no, lo persistido; si no, N/D.
  const inputTokens = u ? u.inputTokens : run?.['input_tokens'];
  const outputTokens = u ? u.outputTokens : run?.['output_tokens'];
  const reasoningTokens = u ? u.reasoningTokens : run?.['reasoning_tokens'];
  const latencia = resultado.latencyMs ?? run?.['latency_ms'];
  const costo = u ? u.estimatedCost : run?.['estimated_cost'];
  const costoReportado = u?.costReportedByProvider ?? null;
  const finish = resultado.lastFinishReason ?? run?.['last_finish_reason'];
  const resuelto = resultado.resolvedModel ?? run?.['resolved_model'];
  const configurado = (run?.['configured_model'] as string | undefined) ?? version?.config.model;
  const runId = resultado.runId ?? (run?.['id'] as string | undefined) ?? null;

  const toolCalls = resultado.toolSequence
    ? String(resultado.toolSequence.length)
    : runDetalle
      ? String(runDetalle.tool_calls.length)
      : ND;

  const filas: Array<[string, string]> = [
    ['Run', runId ? idCorto(runId) : ND],
    ['Sesión', texto(run?.['session_id'])],
    ['Modelo configurado', texto(configurado)],
    ['Modelo resuelto', texto(resuelto)],
    ['prompt_version', texto((run?.['prompt_version'] as string | undefined) ?? version?.prompt_version)],
    ['policy_corpus_version', texto((run?.['policy_corpus_version'] as string | undefined) ?? version?.policy_corpus_version)],
    ['indicator_calc_version', texto((run?.['indicator_calc_version'] as number | undefined) ?? version?.indicator_calc_version)],
    ['Semilla de inferencia', texto(run?.['inference_seed'])],
    ['Tokens de entrada', numero(inputTokens)],
    ['Tokens de salida', numero(outputTokens)],
    ['Tokens de razonamiento', numero(reasoningTokens)],
    ['Latencia', latencia === null || latencia === undefined ? ND : `${String(latencia)} ms`],
    [
      'Costo estimado',
      costo === null || costo === undefined
        ? ND
        : costoReportado === false
          ? `${String(costo)} (no informado por el proveedor)`
          : String(costo),
    ],
    ['Tool calls', toolCalls],
    ['finish_reason', texto(finish)],
    ['Estado del run', texto(run?.['status'])],
  ];

  const iteraciones = resultado.iterationDiagnostics.length > 0
    ? resultado.iterationDiagnostics
    : (runDetalle?.iteraciones ?? []).map((i) => ({
        iteration: Number(i['iteration']),
        finishReason: (i['finish_reason'] as string | null) ?? null,
        inputTokens: Number(i['input_tokens']),
        outputTokens: Number(i['output_tokens']),
        reasoningTokens: Number(i['reasoning_tokens']),
        contentLengthChars: Number(i['content_length_chars']),
        toolCallCount: Number(i['tool_call_count']),
        toolNames: (i['tool_names'] as string[] | undefined) ?? [],
        toolArgumentLengths: (i['tool_argument_lengths'] as number[] | undefined) ?? [],
        hadFinalContent: Boolean(i['had_final_content']),
        schemaValid: Boolean(i['schema_valid']),
      }));

  const secuencia = resultado.toolSequence
    ?? (runDetalle?.tool_calls ?? []).map((t) => `${t.sequence}:${t.tool_name}:${t.status}`);

  const hallazgos = resultado.findings.length > 0
    ? resultado.findings.map((f) => ({ guardrail: f.guardrail, code: f.code, message: f.message }))
    : (runDetalle?.hallazgos ?? []);

  const sinDatosDeRun = !u && !runDetalle;

  return (
    <details className="ejecucion">
      <summary>Detalles de ejecución</summary>

      {sinDatosDeRun && (
        <p className="muted small">
          Este dictamen se restauró desde la base de datos y no tiene un run asociado disponible.
          Los datos de ejecución se muestran como N/D.
        </p>
      )}

      <table className="tabla tabla--kv">
        <tbody>
          {filas.map(([k, v]) => (
            <tr key={k}><th>{k}</th><td className={v === ND ? 'mono nd' : 'mono'}>{v}</td></tr>
          ))}
        </tbody>
      </table>

      {secuencia.length > 0 && (
        <>
          <h4>Secuencia de herramientas</h4>
          <ol className="mono small">{secuencia.map((t) => <li key={t}>{t}</li>)}</ol>
        </>
      )}

      {iteraciones.length > 0 && (
        <>
          <h4>Iteraciones</h4>
          <table className="tabla tabla--dense mono small">
            <thead>
              <tr><th>it</th><th>finish</th><th>in/out/razon</th><th>chars</th><th>tools</th><th>schema</th></tr>
            </thead>
            <tbody>
              {iteraciones.map((d) => (
                <tr key={d.iteration}>
                  <td>{d.iteration}</td>
                  <td>{d.finishReason ?? ND}</td>
                  <td>{d.inputTokens}/{d.outputTokens}/{d.reasoningTokens}</td>
                  <td>{d.contentLengthChars}</td>
                  <td>{d.toolNames.join(', ') || '—'}</td>
                  <td>{d.schemaValid ? 'ok' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Solo metadata: longitudes y conteos. No se registra el contenido generado ni el
            razonamiento del modelo.
          </p>
        </>
      )}

      {hallazgos.length > 0 && (
        <>
          <h4>Hallazgos de guardarraíles</h4>
          <ul className="small">
            {hallazgos.map((f, i) => (
              <li key={i}><code>{f.guardrail}/{f.code}</code> — {f.message}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
