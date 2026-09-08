import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { GuardrailViolationError } from '@credit/contracts';
import { analizarSolicitud, type AnalyzeResult } from '../apps/api/src/application/analyze-application.js';
import { buildAgentProvider, ProviderNotConfiguredError } from '../apps/api/src/agents/index.js';
import { solicitudPorEtiqueta } from '../apps/api/src/agents/testing/fixtures.js';
import { createPool } from '../database/db.js';
import { EVAL_CASES, type EvalCase } from './cases.js';

/**
 * Harness de evaluacion. Ejecuta el flujo REAL del agente contra los 10 fixtures.
 *
 * Los resultados esperados viven en cases.ts y no se le pasan a la aplicacion:
 * el agente ve exactamente el mismo contexto que veria en produccion.
 */

type FalloCodigo =
  | 'WRONG_DECISION'
  | 'EXPECTED_POLICY_MISSING'
  | 'INVALID_CITATION'
  | 'NUMERIC_MISMATCH'
  | 'AUTHORIZATION_MISMATCH'
  | 'GUARDRAIL_NOT_TRIGGERED'
  | 'IDEMPOTENCY_BROKEN'
  | 'AGENT_FAILURE';

interface Fallo { code: FalloCodigo; detalle: string }

interface Resultado {
  caso: EvalCase;
  pass: boolean;
  fallos: Fallo[];
  decisionReal: string;
  citas: string[];
  requirioAutorizacion: boolean;
  latencyMs: number;
  tokens: { input: number; output: number; reasoning: number };
  costo: string;
  resolvedModel: string | null;
  finishReason: string | null;
  diagnosticos: AnalyzeResult['iterationDiagnostics'];
}

async function evaluarCaso(
  pool: ReturnType<typeof createPool>,
  provider: ReturnType<typeof buildAgentProvider>,
  caso: EvalCase,
): Promise<Resultado> {
  const idSolicitud = await solicitudPorEtiqueta(pool, caso.etiqueta);
  const intentoLogico = `eval-${caso.id}-${randomUUID()}`;
  const fallos: Fallo[] = [];

  let r: AnalyzeResult;
  try {
    r = await analizarSolicitud(pool, provider, {
      idSolicitud,
      sessionId: `eval-${caso.id}`,
      intentoLogico,
    });
  } catch (error) {
    // Un guardarrail que bloquea la persistencia es un resultado, no un crash.
    const detalle = error instanceof GuardrailViolationError
      ? `bloqueado por ${error.guardrail}: ${error.message}`
      : error instanceof Error ? error.message : 'error desconocido';
    return {
      caso, pass: false,
      fallos: [{ code: 'AGENT_FAILURE', detalle }],
      decisionReal: 'ERROR', citas: [], requirioAutorizacion: false,
      latencyMs: 0, tokens: { input: 0, output: 0, reasoning: 0 }, costo: '0.000000',
      resolvedModel: null, finishReason: null, diagnosticos: [],
    };
  }

  if (r.failure) {
    fallos.push({ code: 'AGENT_FAILURE', detalle: `${r.failure.code}: ${r.failure.message}` });
  }

  const decisionReal = r.confirmacion?.decision ?? 'SIN_DICTAMEN';
  const citas = (r.dictamen?.politicas_citadas ?? []).map((c) => c.id_politica);
  const recuperadas = r.politicasRecuperadas.map((p) => p.id_politica);
  const evidencia = [...new Set([...citas, ...recuperadas])];

  // 1. decision
  if (decisionReal !== caso.decisionEsperada) {
    fallos.push({ code: 'WRONG_DECISION', detalle: `esperada ${caso.decisionEsperada}, obtenida ${decisionReal}` });
  }

  // 2. politica esperada presente (citada o al menos recuperada como evidencia)
  if (caso.politicasEsperadas.length > 0) {
    const encontrada = caso.politicasEsperadas.some((p) => evidencia.includes(p));
    if (!encontrada) {
      fallos.push({
        code: 'EXPECTED_POLICY_MISSING',
        detalle: `se esperaba alguna de [${caso.politicasEsperadas.join(', ')}]; evidencia: [${evidencia.join(', ') || 'ninguna'}]`,
      });
    }
  }

  // 3. ausencia de cita falsa (G1 no debe haber encontrado nada no verificable)
  const citasInvalidas = r.findings.filter((f) => f.code === 'UNVERIFIABLE_POLICY_CITATION');
  if (citasInvalidas.length > 0) {
    fallos.push({ code: 'INVALID_CITATION', detalle: citasInvalidas.map((f) => f.message).join('; ') });
  }

  // 4. coherencia numerica: los indicadores persistidos deben ser los del backend
  const { rows } = await pool.query<{ indicators_snapshot: Record<string, unknown> }>(
    'SELECT indicators_snapshot FROM decisions WHERE idempotency_key = $1',
    [`${idSolicitud}:${intentoLogico}`],
  );
  const snapshot = rows[0]?.indicators_snapshot;
  if (snapshot && r.dictamen) {
    for (const campo of ['razon_endeudamiento', 'margen_neto', 'cobertura_servicio_deuda', 'relacion_monto_ventas'] as const) {
      if (snapshot[campo] !== r.dictamen.indicadores[campo]) {
        fallos.push({ code: 'NUMERIC_MISMATCH', detalle: `${campo}: persistido ${String(snapshot[campo])}, autoritativo ${String(r.dictamen.indicadores[campo])}` });
      }
    }
  }

  // 5. autorizacion humana
  const requirio = r.confirmacion?.requiere_autorizacion_humana ?? false;
  if (requirio !== caso.requiereAutorizacion) {
    fallos.push({ code: 'AUTHORIZATION_MISMATCH', detalle: `esperada ${caso.requiereAutorizacion}, obtenida ${requirio}` });
  }
  const estadoEsperado = caso.decisionEsperada === 'ESCALADO_A_COMITE'
    ? 'PENDING_COMMITTEE'
    : caso.requiereAutorizacion ? 'PENDING_AUTHORIZATION' : 'GENERATED';
  if (r.confirmacion && r.confirmacion.operational_status !== estadoEsperado) {
    fallos.push({
      code: 'AUTHORIZATION_MISMATCH',
      detalle: `estado operativo ${r.confirmacion.operational_status}, se esperaba ${estadoEsperado}`,
    });
  }

  // 6. guardarrail esperado dejo rastro
  if (caso.guardrailEsperado && !r.findings.some((f) => f.guardrail === caso.guardrailEsperado)) {
    fallos.push({
      code: 'GUARDRAIL_NOT_TRIGGERED',
      detalle: `se esperaba rastro de ${caso.guardrailEsperado}; hallazgos: [${r.findings.map((f) => `${f.guardrail}/${f.code}`).join(', ') || 'ninguno'}]`,
    });
  }

  // 7. idempotencia: repetir el mismo intento logico no crea un segundo dictamen
  if (caso.verificarIdempotencia && r.confirmacion) {
    const repetido = await analizarSolicitud(pool, provider, {
      idSolicitud, sessionId: `eval-${caso.id}`, intentoLogico,
    });
    if (repetido.confirmacion?.id_dictamen !== r.confirmacion.id_dictamen) {
      fallos.push({ code: 'IDEMPOTENCY_BROKEN', detalle: 'un reintento con la misma clave produjo otro dictamen' });
    }
    if (repetido.confirmacion?.reutilizado !== true) {
      fallos.push({ code: 'IDEMPOTENCY_BROKEN', detalle: 'el reintento no fue marcado como reutilizado' });
    }
  }

  return {
    caso, pass: fallos.length === 0, fallos,
    decisionReal, citas, requirioAutorizacion: requirio,
    latencyMs: r.latencyMs,
    tokens: { input: r.usage.inputTokens, output: r.usage.outputTokens, reasoning: r.usage.reasoningTokens },
    costo: r.usage.estimatedCost, resolvedModel: r.resolvedModel, finishReason: r.lastFinishReason,
    diagnosticos: r.iterationDiagnostics,
  };
}

/**
 * Selecciona los casos a correr. Sin argumentos corre los diez.
 *   pnpm eval -- CASE-01 CASE-04
 *   pnpm eval -- --case CASE-09
 * La logica de evaluacion es la misma en ambos modos.
 */
export function seleccionarCasos(argv: string[]): EvalCase[] {
  // pnpm reenvia el separador `--` al script, asi que hay que descartarlo.
  const pedidos = argv
    .filter((a) => a !== '--' && a !== '--case')
    .map((a) => a.replace(/^--case=/, '').trim().toUpperCase())
    .filter((a) => a.length > 0);

  if (pedidos.length === 0) return EVAL_CASES;

  const porId = new Map(EVAL_CASES.map((c) => [c.id, c]));
  const seleccion: EvalCase[] = [];
  const invalidos: string[] = [];
  for (const id of pedidos) {
    const caso = porId.get(id);
    if (caso) seleccion.push(caso);
    else invalidos.push(id);
  }
  if (invalidos.length > 0) {
    throw new Error(
      `Caso desconocido: ${invalidos.join(', ')}. Validos: ${EVAL_CASES.map((c) => c.id).join(', ')}`,
    );
  }
  return seleccion;
}

async function main(): Promise<void> {
  const casos = seleccionarCasos(process.argv.slice(2));
  const pool = createPool();
  let provider: ReturnType<typeof buildAgentProvider>;

  try {
    provider = buildAgentProvider(pool);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      console.error('\nNo se puede correr la evaluacion: el proveedor no esta configurado.');
      console.error(`  ${error.message}`);
      console.error('\nEl harness NO usa un proveedor simulado como sustituto: un 10/10 obtenido');
      console.error('con respuestas guionadas no dice nada sobre el modelo.\n');
      await pool.end();
      process.exit(2);
    }
    throw error;
  }

  const alcance = casos.length === EVAL_CASES.length ? 'los 10 casos' : casos.map((c) => c.id).join(', ');
  console.log(`\nEvaluacion — proveedor=${provider.name} modelo configurado=${provider.model}`);
  console.log(`Razonamiento: effort=${process.env['OPENROUTER_REASONING_EFFORT'] ?? 'none'}  semilla=${provider.inferenceSeed ?? 'no enviada'}`);
  console.log(`Alcance: ${alcance}\n`);

  const resultados: Resultado[] = [];
  for (const caso of casos) {
    const r = await evaluarCaso(pool, provider, caso);
    resultados.push(r);
    const estado = r.pass ? 'PASS' : 'FAIL';
    console.log(`${caso.id} ${estado}`);
    if (!r.pass) {
      console.log(`  esperada: ${caso.decisionEsperada}`);
      console.log(`  obtenida: ${r.decisionReal}`);
      console.log(`  finish_reason: ${r.finishReason ?? 'no informado'}  tokens: ${r.tokens.output} out (razonamiento ${r.tokens.reasoning})`);
      for (const f of r.fallos) console.log(`  failed: ${f.code} — ${f.detalle}`);
      if (r.diagnosticos.length > 0) {
        console.log('  iteraciones (solo metadata, sin razonamiento):');
        console.log('    it  finish      in/out/reason      chars  tools  args           final schema');
        for (const d of r.diagnosticos) {
          const tools = d.toolNames.length > 0 ? d.toolNames.join(',') : '-';
          const args = d.toolArgumentLengths.length > 0 ? d.toolArgumentLengths.join(',') : '-';
          console.log(
            `    ${String(d.iteration).padEnd(3)} ${String(d.finishReason ?? '-').padEnd(11)} ` +
            `${d.inputTokens}/${d.outputTokens}/${d.reasoningTokens}`.padEnd(18) +
            ` ${String(d.contentLengthChars).padEnd(6)} ${tools.padEnd(6)} ${args.padEnd(14)} ` +
            `${d.hadFinalContent ? 'si' : 'no'}    ${d.schemaValid ? 'si' : 'no'}`,
          );
        }
      }
    }
  }

  const total = resultados.length;
  const pasaron = resultados.filter((r) => r.pass).length;
  const decisionesOk = resultados.filter((r) => r.decisionReal === r.caso.decisionEsperada).length;
  const citasOk = resultados.filter((r) => !r.fallos.some((f) => f.code === 'INVALID_CITATION' || f.code === 'EXPECTED_POLICY_MISSING')).length;
  const modelosResueltos = [...new Set(resultados.map((r) => r.resolvedModel).filter((m): m is string => m !== null))];
  const guardrailsOk = resultados.every((r) => !r.fallos.some((f) => f.code === 'GUARDRAIL_NOT_TRIGGERED' || f.code === 'NUMERIC_MISMATCH' || f.code === 'AUTHORIZATION_MISMATCH' || f.code === 'IDEMPOTENCY_BROKEN'));

  const tokensIn = resultados.reduce((a, r) => a + r.tokens.input, 0);
  const tokensOut = resultados.reduce((a, r) => a + r.tokens.output, 0);
  const tokensReasoning = resultados.reduce((a, r) => a + r.tokens.reasoning, 0);
  const finishReasons = [...new Set(resultados.map((r) => r.finishReason).filter((f): f is string => f !== null))];
  const costo = resultados.reduce((a, r) => a + Number(r.costo), 0);

  console.log('');
  console.log(`Decision Accuracy: ${decisionesOk}/${total}`);
  console.log(`Citation Accuracy: ${citasOk}/${total}`);
  console.log(`Guardrail Checks:  ${guardrailsOk ? 'PASS' : 'FAIL'}`);
  console.log(`Total:             ${pasaron}/${total} PASS`);
  console.log(`Modelo resuelto:   ${modelosResueltos.join(', ') || 'no informado por el proveedor'}`);
  console.log(`Tokens:            ${tokensIn} in / ${tokensOut} out (razonamiento: ${tokensReasoning})    Costo: ${costo.toFixed(6)}`);
  console.log(`finish_reason:     ${finishReasons.join(', ') || 'no informado'}`);
  console.log('');

  await pool.end();
  process.exit(pasaron === total ? 0 : 1);
}

main().catch((error) => {
  // Un caso mal escrito es un error de uso, no una falla del sistema: se
  // reporta en una linea, sin stack.
  const mensaje = error instanceof Error ? error.message : String(error);
  if (mensaje.startsWith('Caso desconocido')) {
    console.error(`\n${mensaje}\n`);
    console.error('Uso:  pnpm eval                    (los 10 casos)');
    console.error('      pnpm eval CASE-01            (uno)');
    console.error('      pnpm eval CASE-01 CASE-04    (varios)\n');
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? mensaje : error);
  process.exit(1);
});
