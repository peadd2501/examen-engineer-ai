import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ProviderTimeoutError, ProviderUnavailableError, calcularIndicadores } from '@credit/contracts';
import { DEFAULT_AGENT_LIMITS } from './agent-limits.js';
import { ejecutarAgentLoop } from './agent-orchestrator.js';
import { FINALIZER_FUNCTION_NAME } from './finalizer.js';
import { buildToolRegistry } from './index.js';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';
import { candidato, solicitudPorEtiqueta } from './testing/fixtures.js';
import {
  guion,
  guionInfinito,
  guionQueFalla,
  respuestaConRazonamiento,
  respuestaFinalizer,
  respuestaFinalizerSinLlamada,
  respuestaFinalizerTruncada,
  respuestaSinTools,
  respuestaToolCall,
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

/** Camino feliz: el agente no pide herramientas y el finalizer emite. */
const caminoFeliz = (args = candidato({ policyIds: ['POL-2.1'] })) =>
  guion([respuestaSinTools(), respuestaFinalizer(args)]);

// ===================== FASE DE AGENTE: allowlist =====================

test('el loop ejecuta una herramienta permitida y luego finaliza', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'razon de endeudamiento pasivos entre activos', top_k: 3 } }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato({ policyIds: ['POL-2.1'] })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]?.status, 'OK');
  assert.ok(r.politicasRecuperadas.length > 0, 'las politicas recuperadas quedan registradas para G1');
  assert.equal(r.candidato?.decision, 'APROBADO');
});

test('G5 tool abuse: un nombre de funcion arbitrario no se ejecuta', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'borrar_politicas', args: {} }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls[0]?.status, 'ERROR');
  assert.match(String(r.toolCalls[0]?.errorMessage), /Herramienta no permitida/);
});

test('G5 tool abuse: registrar_dictamen no es alcanzable por el modelo', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'registrar_dictamen', args: {} }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls[0]?.status, 'ERROR');
  assert.match(String(r.toolCalls[0]?.errorMessage), /Herramienta no permitida/);
  assert.ok(registry['registrar_dictamen'], 'la herramienta existe como capacidad del sistema');
  assert.equal(registry['registrar_dictamen']?.exposedToModel, false);
});

test('el finalizer tampoco es una herramienta del registro', () => {
  assert.equal(registry[FINALIZER_FUNCTION_NAME], undefined,
    'emitir_dictamen_estructurado no pertenece al ToolRegistry');
  const nombres = Object.keys(registry).sort();
  assert.deepEqual(nombres, [
    'buscar_politica', 'calcular_indicadores', 'metricas_cartera',
    'obtener_solicitud', 'registrar_dictamen',
  ], 'las cinco capacidades del enunciado siguen intactas');
});

test('argumentos invalidos de herramienta se devuelven como error, no revientan el run', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'obtener_solicitud', args: { id_solicitud: 'no-es-un-uuid' } }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato()),
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
    respuestaSinTools(),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.toolCalls.length, 3);
  assert.deepEqual(r.toolCalls.map((c) => c.sequence), [1, 2, 3]);
  for (const c of r.toolCalls) assert.equal(c.status, 'OK');
});

// ===================== LIMITES =====================

test('MAX_ITERATIONS_EXCEEDED con un modelo que nunca deja de pedir herramientas', async () => {
  const { chat } = guionInfinito(respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'monto maximo', top_k: 1 } }]));
  const r = await ejecutarAgentLoop(deps(chat, { ...DEFAULT_AGENT_LIMITS, maxIterations: 3, maxToolCalls: 50 }), entrada);
  assert.equal(r.candidato, null);
  assert.equal(r.failure?.code, 'MAX_ITERATIONS_EXCEEDED');
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

// ===================== ERRORES DEL PROVEEDOR =====================

test('timeout del proveedor se clasifica como PROVIDER_TIMEOUT', async () => {
  const { chat } = guionQueFalla(new ProviderTimeoutError('sin respuesta en 45000 ms'));
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
  const { chat } = guionInfinito(respuestaSinTools());
  const r = await ejecutarAgentLoop(deps(chat), entrada, controller.signal);
  assert.equal(r.failure?.code, 'CANCELLED');
  assert.equal(r.candidato, null);
});

test('se acumulan tokens de todas las fases', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'plazo maximo autorizable', top_k: 1 } }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.usage.inputTokens, 20 + 900 + 4200);
  assert.equal(r.usage.outputTokens, 10 + 10 + 180);
});

// ===================== CONTEXTO =====================

test('el corpus completo viaja en el contexto y sus ids quedan disponibles', async () => {
  const { chat } = caminoFeliz();
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.politicasDisponibles.length, 30);
  assert.ok(r.politicasDisponibles.includes('POL-2.3'));
});

test('el destino de fondos crudo no aparece en ningun mensaje de ninguna fase', async () => {
  const mensajesPorLlamada: string[][] = [];
  let paso = 0;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    mensajesPorLlamada.push(request.messages.map((m) => m.content ?? ''));
    paso += 1;
    return paso === 1 ? respuestaSinTools() : respuestaFinalizer(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);

  for (const mensajes of mensajesPorLlamada) {
    const todo = mensajes.join('\n');
    assert.ok(!todo.includes(entrada.solicitud.destino_fondos), 'el texto crudo llego al modelo');
  }
  assert.ok(mensajesPorLlamada[1]!.join('\n').includes('representacion normalizada'));
});

test('un nivel_riesgo inventado por el modelo no sale del parseo', async () => {
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizer(candidato({ riesgoInventado: 'ALTO', policyIds: ['POL-2.1'] })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.ok(r.candidato);
  assert.equal((r.candidato as unknown as Record<string, unknown>)['nivel_riesgo'], undefined);
});

// ===================== FINALIZER: payload =====================

test('el tool_choice de la fase final apunta obligatoriamente al finalizer', async () => {
  const peticiones: Array<Record<string, unknown>> = [];
  let paso = 0;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    peticiones.push(request as unknown as Record<string, unknown>);
    paso += 1;
    return paso === 1 ? respuestaSinTools() : respuestaFinalizer(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);

  const final = peticiones[1]!;
  assert.deepEqual(final['toolChoice'], { type: 'function', function: { name: FINALIZER_FUNCTION_NAME } });
  assert.equal(final['maxTokens'], DEFAULT_AGENT_LIMITS.maxFinalizerOutputTokens);
  assert.equal(final['temperature'], 0);
  assert.equal(final['responseFormat'], undefined, 'no se vuelve a response_format');
});

test('las herramientas de dominio no viajan en la llamada final', async () => {
  const peticiones: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
  let paso = 0;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    peticiones.push(request as never);
    paso += 1;
    return paso === 1 ? respuestaSinTools() : respuestaFinalizer(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);

  const nombresAgente = (peticiones[0]?.tools ?? []).map((t) => t.function.name).sort();
  assert.deepEqual(nombresAgente, ['buscar_politica', 'calcular_indicadores', 'metricas_cartera', 'obtener_solicitud']);

  const nombresFinal: string[] = (peticiones[1]?.tools ?? []).map((t) => t.function.name);
  // Las comprobaciones de ausencia van antes del deepEqual: `assert.deepEqual` es una
  // assertion function y estrecharia `nombresFinal` al tipo literal del esperado.
  assert.ok(!nombresFinal.includes('registrar_dictamen'), 'registrar_dictamen no viaja en la fase final');
  assert.ok(!nombresFinal.includes('buscar_politica'), 'buscar_politica no viaja en la fase final');
  assert.deepEqual(nombresFinal, [FINALIZER_FUNCTION_NAME], 'la fase final ofrece solo el finalizer');
});

test('los parameters del finalizer son el esquema del dictamen', async () => {
  let definicion: { function: { name: string; strict: boolean; parameters: { required: string[]; properties: Record<string, unknown> } } } | undefined;
  let paso = 0;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    paso += 1;
    if (paso === 2) definicion = (request.tools as never[])[0];
    return paso === 1 ? respuestaSinTools() : respuestaFinalizer(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);

  assert.ok(definicion);
  assert.equal(definicion.function.strict, true);
  const req = definicion.function.parameters.required.sort();
  assert.deepEqual(req, ['confianza', 'decision', 'monto_recomendado', 'motivos', 'plazo_recomendado_meses', 'policy_ids']);
  for (const prohibido of ['indicadores', 'nivel_riesgo', 'requiere_autorizacion_humana', 'operational_status', 'politicas_citadas']) {
    assert.equal(definicion.function.parameters.properties[prohibido], undefined,
      `${prohibido} es autoritativo del backend y no puede pedirse al modelo`);
  }
});

// ===================== FINALIZER: validacion =====================

test('exactamente una llamada valida se acepta', async () => {
  const { chat, llamadas } = caminoFeliz();
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.candidato?.decision, 'APROBADO');
  assert.equal(r.failure, undefined);
  assert.equal(llamadas(), 2);
  assert.equal(r.repairAttempted, false);
});

test('un nombre de funcion distinto se rechaza', async () => {
  const args = candidato();
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizer(args, { nombre: 'otra_funcion' }),
    respuestaFinalizer(args, { nombre: 'otra_funcion' }),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.failure?.code, 'FINALIZER_FAILED');
  assert.match(String(r.failure?.message), /FINALIZER_WRONG_FUNCTION/);
});

test('dos llamadas simultaneas se rechazan', async () => {
  const args = candidato();
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizer(args, { llamadas: 2 }),
    respuestaFinalizer(args, { llamadas: 2 }),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /FINALIZER_MULTIPLE_CALLS/);
});

test('argumentos que no son JSON se rechazan', async () => {
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizer('esto no es json'),
    respuestaFinalizer('tampoco esto'),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /FINALIZER_INVALID_JSON/);
});

test('argumentos que no cumplen el esquema se rechazan', async () => {
  const invalido = { decision: 'QUIZAS', motivos: [], confianza: 5 };
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizer(invalido),
    respuestaFinalizer(invalido),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /FINALIZER_SCHEMA_INVALID/);
});

test('si el proveedor no llama a la funcion se rechaza', async () => {
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizerSinLlamada(),
    respuestaFinalizerSinLlamada(),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /FINALIZER_NO_FUNCTION_CALL/);
});

// ===================== FINALIZER: reparacion =====================

test('un fallo del finalizer dispara exactamente una reparacion', async () => {
  const { chat, llamadas } = guion([
    respuestaSinTools(),
    respuestaFinalizerSinLlamada(),
    respuestaFinalizer(candidato({ policyIds: ['POL-2.1'] })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(llamadas(), 3);
  assert.equal(r.repairAttempted, true);
  assert.equal(r.repairSucceeded, true);
  assert.equal(r.candidato?.decision, 'APROBADO');
  assert.equal(r.failure, undefined);
});

test('la reparacion vuelve a usar la funcion forzada, nunca response_format', async () => {
  const peticiones: Array<Record<string, unknown>> = [];
  let paso = 0;
  const chat: Parameters<typeof ejecutarAgentLoop>[0]['chat'] = async (request) => {
    peticiones.push(request as unknown as Record<string, unknown>);
    paso += 1;
    if (paso === 1) return respuestaSinTools();
    if (paso === 2) return respuestaFinalizerTruncada();
    return respuestaFinalizer(candidato());
  };
  await ejecutarAgentLoop(deps(chat), entrada);

  const reparacion = peticiones[2]!;
  assert.deepEqual(reparacion['toolChoice'], { type: 'function', function: { name: FINALIZER_FUNCTION_NAME } });
  assert.equal(reparacion['responseFormat'], undefined);
  assert.equal(reparacion['maxTokens'], DEFAULT_AGENT_LIMITS.maxFinalizerOutputTokens);
});

test('truncacion del finalizer hace maximo una reparacion', async () => {
  const { chat, llamadas } = guion([
    respuestaSinTools(),
    respuestaFinalizerTruncada(),
    respuestaFinalizerTruncada(),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(llamadas(), 3, 'no hay tercer intento');
  assert.equal(r.failure?.code, 'OUTPUT_TOKEN_LIMIT_EXCEEDED');
  assert.equal(r.repairAttempted, true);
  assert.equal(r.repairSucceeded, false);
});

test('el error final nombra las dos causas', async () => {
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizerSinLlamada(),
    respuestaFinalizer('no json'),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.match(String(r.failure?.message), /Primer intento: FINALIZER_NO_FUNCTION_CALL/);
  assert.match(String(r.failure?.message), /Reparacion: FINALIZER_INVALID_JSON/);
});

// ===================== OBSERVABILIDAD =====================

test('cada llamada deja metadata segura con su fase', async () => {
  const { chat } = guion([
    respuestaToolCall([{ name: 'buscar_politica', args: { consulta: 'score minimo', top_k: 1 } }]),
    respuestaSinTools(),
    respuestaFinalizer(candidato({ policyIds: ['POL-3.1'] })),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);

  assert.deepEqual(r.iterationDiagnostics.map((d) => d.phase), ['AGENT', 'AGENT', 'FINALIZER']);
  const final = r.iterationDiagnostics[2]!;
  assert.equal(final.functionName, FINALIZER_FUNCTION_NAME);
  assert.ok(final.argumentsLength > 0, 'se registra la longitud de los argumentos');
  assert.equal(final.schemaValid, true);
});

test('la reparacion se registra con su propia fase', async () => {
  const { chat } = guion([
    respuestaSinTools(),
    respuestaFinalizerTruncada(1200, 1150),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.deepEqual(r.iterationDiagnostics.map((d) => d.phase), ['AGENT', 'FINALIZER', 'FINALIZER_REPAIR']);
  const truncada = r.iterationDiagnostics[1]!;
  assert.equal(truncada.finishReason, 'length');
  assert.equal(truncada.reasoningTokens, 1150);
  assert.equal(truncada.schemaValid, false);
});

test('el diagnostico guarda longitudes, nunca los argumentos completos', async () => {
  const args = candidato({ motivos: ['Un motivo con contenido reconocible XYZZY.'], policyIds: ['POL-2.1'] });
  const { chat } = guion([respuestaSinTools(), respuestaFinalizer(args)]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);

  const serializado = JSON.stringify(r.iterationDiagnostics);
  assert.ok(!serializado.includes('XYZZY'), 'los argumentos completos se filtraron al diagnostico');
  assert.ok(!serializado.includes('POL-2.1'));
  assert.ok(r.iterationDiagnostics[1]!.argumentsLength > 20, 'pero si su longitud');
});

test('el razonamiento no llega al diagnostico', async () => {
  const secreto = 'razonamiento interno que no debe salir';
  const { chat } = guion([
    respuestaConRazonamiento({}, [{ type: 'reasoning.text', text: secreto }]),
    respuestaFinalizer(candidato()),
  ]);
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  const serializado = JSON.stringify(r.iterationDiagnostics);
  assert.ok(!serializado.includes(secreto));
  assert.ok(!serializado.includes('reasoning_details'));
});

test('finish_reason se registra en un run exitoso', async () => {
  const { chat } = caminoFeliz();
  const r = await ejecutarAgentLoop(deps(chat), entrada);
  assert.equal(r.lastFinishReason, 'tool_calls');
  assert.equal(r.failure, undefined);
});
