import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { analizarSolicitud } from '../apps/api/src/application/analyze-application.js';
import { ScriptedAgentProvider, buildToolRegistry } from '../apps/api/src/agents/index.js';
import { solicitudPorEtiqueta } from '../apps/api/src/agents/testing/fixtures.js';
import type { ChatFn } from '../apps/api/src/agents/agent-orchestrator.js';
import { createPool } from '../database/db.js';

/**
 * Verificacion del pipeline SIN proveedor LLM.
 *
 * ESTO NO ES LA EVALUACION. No mide la calidad del modelo y no puede sustituir
 * a `pnpm eval`: el proveedor esta guionado. Lo que verifica es la fontaneria
 * — agent loop, allowlist de herramientas, recuperacion de politicas,
 * guardarrailes, persistencia transaccional, idempotencia y observabilidad —
 * de punta a punta y contra la base real, sin gastar creditos de API.
 *
 * El guion NO conoce los resultados esperados de los casos de evaluacion: hace
 * lo mismo para cualquier solicitud (buscar politicas, citar la primera que
 * recupero, aprobar). Por eso sirve como prueba de fontaneria y no como prueba
 * de acierto.
 */
function guionGenerico(): ChatFn {
  let paso = 0;
  const recuperadas: string[] = [];

  return async (request) => {
    paso += 1;

    if (paso === 1) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'obtener_solicitud', arguments: JSON.stringify({ id_solicitud: idActual }) } },
            { id: 'c2', type: 'function', function: { name: 'calcular_indicadores', arguments: JSON.stringify({ id_solicitud: idActual }) } },
          ],
        },
        finishReason: 'tool_calls',
        usage: { inputTokens: 850, outputTokens: 60, reasoningTokens: 0, cost: null },
        resolvedModel: 'scripted/deterministic',
        raw: {},
      };
    }

    if (paso === 2) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c3', type: 'function', function: { name: 'buscar_politica', arguments: JSON.stringify({ consulta: 'razon de endeudamiento pasivos entre activos totales', top_k: 2 }) } },
            { id: 'c4', type: 'function', function: { name: 'buscar_politica', arguments: JSON.stringify({ consulta: 'score de historial crediticio minimo', top_k: 2 }) } },
          ],
        },
        finishReason: 'tool_calls',
        usage: { inputTokens: 1200, outputTokens: 80, reasoningTokens: 0, cost: null },
        resolvedModel: 'scripted/deterministic',
        raw: {},
      };
    }

    // Referencia lo que devolvio la herramienta. El guion tampoco escribe texto
    // de politica: devuelve identificadores, igual que el modelo real.
    for (const m of request.messages) {
      if (m.role !== 'tool' || m.name !== 'buscar_politica' || !m.content) continue;
      const payload = JSON.parse(m.content) as { fragmentos?: Array<{ id_politica: string }> };
      for (const f of payload.fragmentos ?? []) {
        if (!recuperadas.includes(f.id_politica)) recuperadas.push(f.id_politica);
      }
    }

    return {
      message: {
        role: 'assistant',
        content: JSON.stringify({
          decision: 'APROBADO',
          monto_recomendado: '50000.00',
          plazo_recomendado_meses: 24,
          policy_ids: recuperadas.slice(0, 2),
          motivos: ['Indicadores dentro de los umbrales de las politicas recuperadas.'],
          nivel_riesgo: 'BAJO',
          confianza: 0.82,
        }),
      },
      finishReason: 'stop',
      usage: { inputTokens: 1600, outputTokens: 220, reasoningTokens: 0, cost: null },
      resolvedModel: 'scripted/deterministic',
      raw: {},
    };
  };
}

let idActual = '';

async function main(): Promise<void> {
  const pool = createPool();
  const etiqueta = process.argv[2] ?? 'EVAL-CASE-01';

  try {
    idActual = await solicitudPorEtiqueta(pool, etiqueta);
    const provider = new ScriptedAgentProvider(guionGenerico(), pool, buildToolRegistry());

    console.log(`\nVerificacion de pipeline (proveedor GUIONADO, no es evaluacion)`);
    console.log(`  solicitud: ${etiqueta}  ${idActual}\n`);

    const r = await analizarSolicitud(pool, provider, {
      idSolicitud: idActual,
      sessionId: `pipeline-check-${randomUUID().slice(0, 8)}`,
      intentoLogico: `pipeline-${randomUUID()}`,
    });

    console.log(`  run_id ............... ${r.runId}`);
    console.log(`  secuencia de tools ... ${r.toolSequence.join('  ->  ')}`);
    console.log(`  politicas recuperadas  ${[...new Set(r.politicasRecuperadas.map((p) => p.id_politica))].join(', ')}`);
    console.log(`  decision ............. ${r.confirmacion?.decision}`);
    console.log(`  estado operativo ..... ${r.confirmacion?.operational_status}`);
    console.log(`  autorizacion humana .. ${r.confirmacion?.requiere_autorizacion_humana}`);
    console.log(`  citas persistidas .... ${(r.dictamen?.politicas_citadas ?? []).map((c) => c.id_politica).join(', ') || 'ninguna'}`);
    console.log(`  latencia ............. ${r.latencyMs} ms`);
    console.log(`  tokens ............... ${r.usage.inputTokens} in / ${r.usage.outputTokens} out (razonamiento: ${r.usage.reasoningTokens})`);
    console.log(`  finish_reason ........ ${r.lastFinishReason ?? 'no informado'}`);
    console.log(`  costo ................ ${r.usage.estimatedCost} (reportado por proveedor: ${r.usage.costReportedByProvider})`);
    console.log(`  hallazgos guardrail .. ${r.findings.map((f) => `${f.guardrail}/${f.code}`).join(', ') || 'ninguno'}`);
    console.log('  iteraciones (metadata):');
    for (const d of r.iterationDiagnostics) {
      console.log(
        `    it=${d.iteration} finish=${d.finishReason} tokens=${d.inputTokens}/${d.outputTokens}/${d.reasoningTokens} ` +
        `chars=${d.contentLengthChars} tools=[${d.toolNames.join(',') || '-'}] args=[${d.toolArgumentLengths.join(',') || '-'}] ` +
        `final=${d.hadFinalContent} schema=${d.schemaValid}`,
      );
    }
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
