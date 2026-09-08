import type { AnalisisResultado } from '../types/view.js';
import type { VersionInfo } from '../services/api.js';
import { idCorto } from '../features/analysis/format.js';

/**
 * Observabilidad, expandible.
 *
 * Únicamente metadata segura. Nunca razonamiento, `reasoning_details`,
 * chain-of-thought, system prompt ni claves. De razonamiento se muestra el
 * contador de tokens, que es una métrica de costo.
 */
export function ExecutionDetails({ resultado, version }: { resultado: AnalisisResultado; version: VersionInfo | null }) {
  const u = resultado.usage;
  const filas: Array<[string, string]> = [
    ['Run', idCorto(resultado.runId)],
    ['Modelo configurado', version?.config.model ?? '—'],
    ['Modelo resuelto', resultado.resolvedModel ?? 'no informado'],
    ['prompt_version', version?.prompt_version ?? '—'],
    ['policy_corpus_version', version?.policy_corpus_version ?? '—'],
    ['indicator_calc_version', String(version?.indicator_calc_version ?? '—')],
    ['Tokens de entrada', String(u.inputTokens)],
    ['Tokens de salida', String(u.outputTokens)],
    ['Tokens de razonamiento', String(u.reasoningTokens)],
    ['Latencia', `${resultado.latencyMs} ms`],
    ['Costo estimado', u.costReportedByProvider ? u.estimatedCost : `${u.estimatedCost} (no informado por el proveedor)`],
    ['Tool calls', String(resultado.toolSequence.length)],
    ['finish_reason', resultado.lastFinishReason ?? 'no informado'],
  ];

  return (
    <details className="ejecucion">
      <summary>Detalles de ejecución</summary>

      <table className="tabla tabla--kv">
        <tbody>
          {filas.map(([k, v]) => <tr key={k}><th>{k}</th><td className="mono">{v}</td></tr>)}
        </tbody>
      </table>

      {resultado.toolSequence.length > 0 && (
        <>
          <h4>Secuencia de herramientas</h4>
          <ol className="mono small">
            {resultado.toolSequence.map((t) => <li key={t}>{t}</li>)}
          </ol>
        </>
      )}

      {resultado.iterationDiagnostics.length > 0 && (
        <>
          <h4>Iteraciones</h4>
          <table className="tabla tabla--dense mono small">
            <thead>
              <tr><th>it</th><th>finish</th><th>in/out/razon</th><th>chars</th><th>tools</th><th>schema</th></tr>
            </thead>
            <tbody>
              {resultado.iterationDiagnostics.map((d) => (
                <tr key={d.iteration}>
                  <td>{d.iteration}</td>
                  <td>{d.finishReason ?? '—'}</td>
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

      {resultado.findings.length > 0 && (
        <>
          <h4>Hallazgos de guardarraíles</h4>
          <ul className="small">
            {resultado.findings.map((f, i) => (
              <li key={i}><code>{f.guardrail}/{f.code}</code> — {f.message}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
