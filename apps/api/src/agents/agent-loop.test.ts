import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ProviderTimeoutError, ProviderUnavailableError, calcularIndicadores } from '@credit/contracts';
import { DEFAULT_AGENT_LIMITS } from './agent-limits.js';
import { ejecutarAgentLoop } from './agent-orchestrator.js';
import { buildToolRegistry } from './index.js';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';
import { candidato, solicitudPorEtiqueta } from './testing/fixtures.js';
import {
  guion,
  guionInfinito,
  guionQueFalla,
  respuestaConRazonamiento,
  respuestaFinal,
  respuestaTexto,
  respuestaToolCall,
  respuestaTruncada,
  respuestaVacia,
} from './testing/scripted-chat.js';
import type { AgentAnalysisInput } from './agent-provider.js';

pg.types.setTypeParser(1700, (v: string) => v);
let pool: pg.Pool;
let entrada: AgentAnalysisInput;
const registry = buildToolRegistry();

before(async () => {
  const connectionString = process.env['DATABASE_URL'];
  assert.ok(connectionString, 'DATABASE_URL no definido');
  pool = new pg.Pool({ connectionString, max: 4 });
  const id = await solicitudPorEtiqueta(pool, 'EVAL-CASE-01');
  const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [id]);
  const solicitud = rowToSolicitud(rows[0]!);
  entrada = { solicitud, indicadores: calcularIndicadores(solicitud) };
});

after(async () => { await pool?.end(); });

const deps = (chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'], limits = DEFAULT_AGENT_LIMITS) =>
  ({ pool, registry, limits, chat });

// --- allowlist de herramientas ----------------------------------------------

test('el loop ejecuta una herramienta permitida y devuelve el dictamen', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'razon de endeudamiento pasivos entre activos', top_k: 3 } }]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]?.status, 'OK');
  assert.equal(r.toolCalls[0]?.toolName, 'buscar_politica');
  assert.ok(r.politicasRecuperadas.length > 0, 'las politicas recuperadas quedan registradas para G1');
  assert.equal(r.candidato?.decision, 'APROBADO');
});

test('G5 tool abuse: un nombre de funcion arbitrario no se ejecuta', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'borrar_politicas', args: {} }]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls[0]?.status, 'ERROR');
  assert.match(String(r.toolCalls[0]?.errorMessage), /Herramienta no permitida/);
});

test('G5 tool abuse: registrar_dictamen no es alcanzable por el modelo', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'registrar_dictamen', args: { id_solicitud: entrada.solicitud.id_solicitud, dictamen: {}, clave_idempotencia: 'x'.repeat(10) } }]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls[0]?.status, 'ERROR');
  assert.match(String(r.toolCalls[0]?.errorMessage), /Herramienta no permitida/);
  assert.ok(registry['registrar_dictamen'], 'la herramienta existe como capacidad del sistema');
  assert.equal(registry['registrar_dictamen']?.exposedToModel, false);
});

test('argumentos invalidos de herramienta se devuelven como error, no revientan el run', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'obtener_solicitud', args: { id_solicitud: 'no-es-un-uuid' } }]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls[0]?.status, 'ERROR');
  assert.ok(r.candidato, 'el loop continua tras un error de herramienta');
});

test('multiples tool calls en una sola respuesta se ejecutan todas', async () => {
  const { chat } = guion([
    respuestaToolCall([
      { name: 'obtener_solicitud', args: { id_solicitud: entrada.solicitud.id_solicitud } },
      { name: 'calcular_indicadores', args: { id_solicitud: entrada.solicitud.id_solicitud } },
      { name: 'buscar_politica', args: { consulta: 'score de historial crediticio minimo', top_k: 2 } },
    ]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls.length, 3);
  assert.deepEqual(r.toolCalls.map((c) => c.sequence), [1, 2, 3]);
  for (const c of r.toolCalls) assert.equal(c.status, 'OK');
});

// --- limites del loop --------------------------------------------------------

test('MAX_ITERATIONS_EXCEEDED con un modelo que nunca concluye', async () => {
  const { chat } = guionInfinito(respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'monto maximo', top_k: 1 } }]));
  const r = await ejecutarAgentLoop(deps(chat, { ...DEFAULT_AGENT_LIMITS, maxIterations: 3, maxToolCalls: 50 }), entrada);
  assert.equal(r.candidato, null);
  assert.equal(r.failure?.code, 'MAX_ITERATIONS_EXCEEDED');
  assert.equal(r.iterations, 3);
});

test('MAX_TOOL_CALLS_EXCEEDED corta antes de gastar mas llamadas', async () => {
  const { chat } = guionInfinito(respuestaToolCall([
    { name: 'buscar_politica', args: { consulta: 'monto maximo', top_k: 1 } },
    { name: 'buscar_politica', args: { consulta: 'plazo maximo', top_k: 1 } },
  ]));
  const r = await ejecutarAgentLoop(deps(chat, { ...DEFAULT_AGENT_LIMITS, maxIterations: 20, maxToolCalls: 3 }), entrada);
  assert.equal(r.failure?.code, 'MAX_TOOL_CALLS_EXCEEDED');
  assert.ok(r.toolCalls.length <= 3);
});

test('TOTAL_TIMEOUT cuando se agota el presupuesto de ejecucion', async () => {
  const lento = async (): ReturnType<Parameters<typeof ejecutarAgentLoop>[0]['chat']> => {
    await new Promise((r) => setTimeout(r, 60));
    return respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'garantia real', top_k: 1 } }]);
  };
  const r = await ejecutarAgentLoop(
    deps(lento, { ...DEFAULT_AGENT_LIMITS, totalExecutionTimeoutMs: 100, maxIterations: 20, maxToolCalls: 50 }),
    entrada,
  );
  assert.equal(r.failure?.code, 'TOTAL_TIMEOUT');
});

// --- salida invalida y reparacion unica --------------------------------------

test('una salida invalida dispara exactamente una reparacion, y funciona', async () => {
  const { chat, llamadas } = guion([
    respuestaTexto('claro, aqui va mi analisis en prosa'),
    respuestaFinal(candidato({ decision: 'ESCALADO_A_COMITE', monto: null, plazo: null })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.repairAttempted, true);
  assert.equal(r.repairSucceeded, true);
  assert.equal(r.candidato?.decision, 'ESCALADO_A_COMITE');
  assert.equal(llamadas(), 2, 'exactamente una llamada extra, no un retry ciego');
});

test('si la reparacion tampoco valida se escala, sin reintentos adicionales', async () => {
  const { chat, llamadas } = guion([respuestaTexto('prosa'), respuestaTexto('mas prosa')]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.candidato, null);
  assert.equal(r.failure?.code, 'AGENT_SCHEMA_VALIDATION_FAILED');
  assert.equal(r.repairAttempted, true);
  assert.equal(r.repairSucceeded, false);
  assert.equal(llamadas(), 2);
});

test('acepta JSON envuelto en bloque de codigo', async () => {
  const { chat } = guion([respuestaTexto('```json\n' + JSON.stringify(candidato()) + '\n```')]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.candidato?.decision, 'APROBADO');
  assert.equal(r.repairAttempted, false);
});

// --- errores del proveedor ---------------------------------------------------

test('timeout del proveedor se clasifica como PROVIDER_TIMEOUT', async () => {
  const { chat } = guionQueFalla(new ProviderTimeoutError('sin respuesta en 30000 ms'));
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'PROVIDER_TIMEOUT');
});

test('caida del proveedor se clasifica como PROVIDER_UNAVAILABLE', async () => {
  const { chat } = guionQueFalla(new ProviderUnavailableError('el proveedor respondio 503'));
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'PROVIDER_UNAVAILABLE');
});

test('la cancelacion se propaga y corta el loop', async () => {
  const controller = new AbortController();
  controller.abort();
  const { chat } = guionInfinito(respuestaFinal(candidato()));
  const r = await ejecutarAgentLoop(deps(chat), entrada, controller.signal);
  assert.equal(r.failure?.code, 'CANCELLED');
  assert.equal(r.candidato, null);
});

// --- contabilidad de uso -----------------------------------------------------

test('se acumulan tokens de todas las iteraciones', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'plazo maximo autorizable', top_k: 1 } }]),
    respuestaFinal(candidato(), { input: 300, output: 120 }),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.usage.inputTokens, 320);
  assert.equal(r.usage.outputTokens, 130);
});

// --- referencias de politica en vez de texto literal (FASE 3.1) --------------

test('el modelo devuelve policy_ids, no texto de politica', async () => {
  const { chat } = guion([respuestaFinal(candidato({ policyIds: ['POL-2.1', 'POL-3.1'] }))]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.deepEqual(r.candidato?.policy_ids, ['POL-2.1', 'POL-3.1']);
  assert.ok(!('politicas_citadas' in (r.candidato ?? {})), 'el schema del modelo ya no admite citas');
});

test('el corpus completo viaja en el contexto y sus ids quedan disponibles', async () => {
  const { chat } = guion([respuestaFinal(candidato())]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.politicasDisponibles.length, 30);
  assert.ok(r.politicasDisponibles.includes('POL-2.3'));
});

test('el response_format enviado al proveedor limita policy_ids al corpus', async () => {
  let capturado: Record<string, unknown> | undefined;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    capturado = request.responseFormat;
    return respuestaFinal(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);
  const schema = capturado as { json_schema: { strict: boolean; schema: { properties: { policy_ids: { items: { enum: string[] } } } } } };
  assert.equal(schema.json_schema.strict, true);
  assert.equal(schema.json_schema.schema.properties.policy_ids.items.enum.length, 30);
});

test('el corpus se inyecta como mensaje de contexto separado', async () => {
  let mensajes: Array<{ role: string; content: string | null }> = [];
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    mensajes = request.messages;
    return respuestaFinal(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);
  const corpus = mensajes.find((m) => m.content?.includes('CORPUS DE POLITICAS VIGENTES'));
  assert.ok(corpus, 'no se inyecto el corpus');
  assert.equal(corpus.role, 'user', 'el corpus no debe ir en el mensaje system');
  // El texto del solicitante sigue en su propio mensaje y fuera del system.
  const system = mensajes.find((m) => m.role === 'system');
  assert.ok(!system?.content?.includes(entrada.solicitud.destino_fondos));
});

test('el modelo ya no puede alucinar un texto de cita: no hay campo donde escribirlo', async () => {
  const { chat } = guion([
    respuestaFinal({
      decision: 'APROBADO', monto_recomendado: '50000.00', plazo_recomendado_meses: 24,
      policy_ids: ['POL-2.1'],
      politicas_citadas: [{ id_politica: 'POL-INVENTADA', seccion: 'X', texto_literal: 'inventado' }],
      motivos: ['ok'], nivel_riesgo: 'BAJO', confianza: 0.9,
    }),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  // Zod descarta el campo extra: no llega a ninguna capa posterior.
  assert.deepEqual(r.candidato?.policy_ids, ['POL-2.1']);
  assert.equal((r.candidato as unknown as Record<string, unknown>)['politicas_citadas'], undefined);
});

// --- clasificacion de la salida final (FASE 3.2) -----------------------------
// Motivacion: la corrida con Dots3 dio "7759 in / 3000 out -> respuesta final
// vacia". Un AGENT_SCHEMA_VALIDATION_FAILED generico no distingue eso de un
// JSON mal formado, y el arreglo de cada caso vive en un lugar distinto.

test('finish_reason length sin dictamen valido es OUTPUT_TOKEN_LIMIT_EXCEEDED', async () => {
  const { chat, llamadas } = guion([respuestaTruncada()]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.candidato, null);
  assert.equal(r.failure?.code, 'OUTPUT_TOKEN_LIMIT_EXCEEDED');
  assert.equal(r.lastFinishReason, 'length');
  assert.equal(llamadas(), 1, 'no se intenta reparar una truncacion: se cortaria igual');
  assert.equal(r.repairAttempted, false);
});

test('el fallo por truncacion reporta el presupuesto y el gasto real', async () => {
  const { chat } = guion([respuestaTruncada('{"decision":"APROB', 5000, 4800)]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /max_tokens=5000/);
  assert.match(String(r.failure?.message), /razonamiento=4800/);
});

test('respuesta vacia con finish_reason stop se repara una vez y si sigue vacia es EMPTY_PROVIDER_RESPONSE', async () => {
  const { chat, llamadas } = guion([respuestaVacia(), respuestaVacia()]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'EMPTY_PROVIDER_RESPONSE');
  assert.equal(r.repairAttempted, true);
  assert.equal(r.repairSucceeded, false);
  assert.equal(llamadas(), 2);
});

test('una respuesta vacia recuperable si se repara', async () => {
  const { chat } = guion([respuestaVacia(), respuestaFinal(candidato())]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure, undefined);
  assert.equal(r.repairSucceeded, true);
  assert.equal(r.candidato?.decision, 'APROBADO');
});

test('JSON con contenido pero invalido sigue siendo AGENT_SCHEMA_VALIDATION_FAILED', async () => {
  const { chat } = guion([
    respuestaTexto('{"decision":"QUIZAS"}'),
    respuestaTexto('{"decision":"TAMPOCO"}'),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'AGENT_SCHEMA_VALIDATION_FAILED');
  assert.equal(r.lastFinishReason, 'stop');
});

test('truncacion detectada tambien en el intento de reparacion', async () => {
  const { chat } = guion([respuestaTexto('prosa'), respuestaTruncada()]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'OUTPUT_TOKEN_LIMIT_EXCEEDED');
  assert.equal(r.repairAttempted, true);
});

test('finish_reason se registra tambien en un run exitoso', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'plazo maximo autorizable', top_k: 1 } }]),
    respuestaFinal(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.lastFinishReason, 'stop');
  assert.equal(r.failure, undefined);
});

// --- razonamiento -----------------------------------------------------------

test('los tokens de razonamiento se acumulan por separado', async () => {
  const { chat } = guion([
    respuestaConRazonamiento(candidato(), [{ type: 'reasoning.text', text: 'interno' }]),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.usage.reasoningTokens, 30);
  assert.equal(r.usage.outputTokens, 50);
});

test('reasoning_details se reenvia al proveedor pero no sale del resultado', async () => {
  const bloques = [{ type: 'reasoning.text', text: 'razonamiento interno del modelo' }];
  const historial: Array<Array<{ role: string; reasoning_details?: unknown[] }>> = [];
  let paso = 0;

  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    historial.push(request.messages.map((m) => ({ ...m })));
    paso += 1;
    if (paso === 1) {
      const r = respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'score minimo', top_k: 1 } }]);
      return { ...r, message: { ...r.message, reasoning_details: bloques } };
    }
    return respuestaConRazonamiento(candidato(), bloques);
  };

  const r = await ejecutarAgentLoop(deps(chat), entrada);

  // El protocolo exige devolver los bloques en el turno siguiente.
  const segundoTurno = historial[1];
  assert.ok(segundoTurno, 'deberia haber un segundo turno');
  const assistant = segundoTurno.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant?.reasoning_details, bloques, 'no se reenvio el razonamiento');

  // Pero no aparece en nada de lo que sale del loop.
  const serializado = JSON.stringify({
    candidato: r.candidato, usage: r.usage, toolCalls: r.toolCalls, failure: r.failure,
  });
  assert.ok(!serializado.includes('razonamiento interno del modelo'), 'el razonamiento se filtro al resultado');
  assert.ok(!serializado.includes('reasoning_details'));
});

// --- diagnostico por iteracion (FASE 3.2b) ----------------------------------

test('cada llamada al proveedor deja metadata segura', async () => {
  const { chat } = guion([
    respuestaToolCall([
      { name: 'obtener_solicitud', args: { id_solicitud: entrada.solicitud.id_solicitud } },
      { name: 'buscar_politica', args: { consulta: 'score de historial crediticio minimo', top_k: 2 } },
    ]),
    respuestaFinal(candidato({ policyIds: ['POL-3.1'] })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);

  assert.equal(r.iterationDiagnostics.length, 2);

  const primera = r.iterationDiagnostics[0]!;
  assert.equal(primera.iteration, 1);
  assert.equal(primera.finishReason, 'tool_calls');
  assert.equal(primera.toolCallCount, 2);
  assert.deepEqual(primera.toolNames, ['obtener_solicitud', 'buscar_politica']);
  assert.equal(primera.toolArgumentLengths.length, 2);
  assert.ok(primera.toolArgumentLengths.every((n) => n > 0), 'se registra el tamano de los argumentos');
  assert.equal(primera.hadFinalContent, false);
  assert.equal(primera.schemaValid, false);

  const segunda = r.iterationDiagnostics[1]!;
  assert.equal(segunda.finishReason, 'stop');
  assert.equal(segunda.toolCallCount, 0);
  assert.ok(segunda.contentLengthChars > 0);
  assert.equal(segunda.hadFinalContent, true);
  assert.equal(segunda.schemaValid, true);
});

test('el diagnostico registra longitudes, nunca contenido ni razonamiento', async () => {
  const secreto = 'razonamiento interno que no debe salir';
  const { chat } = guion([
    respuestaConRazonamiento(candidato(), [{ type: 'reasoning.text', text: secreto }]),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);

  const serializado = JSON.stringify(r.iterationDiagnostics);
  assert.ok(!serializado.includes(secreto), 'se filtro el razonamiento al diagnostico');
  assert.ok(!serializado.includes('reasoning_details'));
  assert.ok(!serializado.includes('APROBADO'), 'se filtro el contenido generado al diagnostico');

  const d = r.iterationDiagnostics[0]!;
  assert.equal(d.reasoningTokens, 30, 'el conteo si se registra');
  assert.ok(d.contentLengthChars > 0, 'la longitud si se registra');
});

test('una truncacion queda visible en el diagnostico', async () => {
  const { chat } = guion([respuestaTruncada('{"decision":"APROB', 5000, 1736)]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);

  const d = r.iterationDiagnostics[0]!;
  assert.equal(d.finishReason, 'length');
  assert.equal(d.outputTokens, 5000);
  assert.equal(d.reasoningTokens, 1736);
  assert.equal(d.toolCallCount, 0);
  assert.equal(d.hadFinalContent, true, 'hubo contenido, pero cortado');
  assert.equal(d.schemaValid, false);
  assert.equal(r.failure?.code, 'OUTPUT_TOKEN_LIMIT_EXCEEDED');
});

test('el diagnostico cubre tambien la iteracion de reparacion', async () => {
  const { chat } = guion([respuestaTexto('prosa'), respuestaFinal(candidato())]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.iterationDiagnostics.length, 2);
  assert.equal(r.iterationDiagnostics[0]?.schemaValid, false);
  assert.equal(r.iterationDiagnostics[1]?.schemaValid, true);
});
