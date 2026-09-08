import 'dotenv/config';
import { calcularIndicadores } from '@credit/contracts';
import { config, safeConfigSnapshot } from '../apps/api/src/config.js';
import { DEFAULT_AGENT_LIMITS } from '../apps/api/src/agents/agent-limits.js';
import { cargarCorpusContext } from '../apps/api/src/agents/corpus-context.js';
import {
  FINALIZER_FUNCTION_NAME,
  construirMensajesFinalizer,
  interpretarRespuestaFinalizer,
  peticionFinalizer,
} from '../apps/api/src/agents/finalizer.js';
import { semillaDeInferencia } from '../apps/api/src/agents/index.js';
import { OpenRouterClient } from '../apps/api/src/agents/openrouter-client.js';
import { solicitudPorEtiqueta } from '../apps/api/src/agents/testing/fixtures.js';
import { rowToSolicitud, type ApplicationRow } from '../apps/api/src/infrastructure/application-repository.js';
import { createPool } from '../database/db.js';

/**
 * Smoke de la FASE FINALIZER (FASE 3.4).
 *
 * `pnpm agent:smoke` prueba structured output generico con un payload de
 * juguete. Esto es otra cosa: reproduce en UNA sola llamada el payload real de
 * finalizacion de un caso de evaluacion —corpus completo, solicitud
 * estructurada, indicadores autoritativos, resumen seguro del destino— y
 * comprueba que el proveedor sabe cerrar por function call forzada.
 *
 * El caso por defecto es EVAL-CASE-09, que es el que fallaba mecanicamente por
 * truncacion en la ruta `response_format`. Se puede pasar otra etiqueta:
 *
 *   pnpm agent:smoke:finalizer EVAL-CASE-01
 *
 * PASS exige que `interpretarRespuestaFinalizer` —el MISMO parser que usa el
 * orquestador en produccion, no una copia relajada— devuelva ok:
 *   finish_reason compatible + exactamente una llamada + nombre correcto +
 *   argumentos presentes + JSON valido + DictamenLLMSchema cumplido.
 *
 * Un HTTP 200 no es PASS. Una llamada a funcion vacia tampoco.
 *
 * La funcion NUNCA se ejecuta y no se escribe nada en la base de datos: este
 * script solo LEE el corpus y la solicitud.
 *
 * Codigos de salida: 0 = PASS, 1 = el modelo no sabe finalizar asi,
 * 2 = problema de configuracion o de datos.
 */

const ETIQUETA_POR_DEFECTO = 'EVAL-CASE-09';

async function main(): Promise<void> {
  const etiqueta = process.argv[2] ?? ETIQUETA_POR_DEFECTO;

  console.log('\nConfiguracion:', safeConfigSnapshot());
  console.log(`Caso: ${etiqueta}\n`);

  if (!config.OPENROUTER_API_KEY) {
    console.error('Falta OPENROUTER_API_KEY en .env');
    process.exit(2);
  }
  if (!config.OPENROUTER_API_KEY.startsWith('sk-or-')) {
    console.warn(
      'AVISO: la API key no empieza con "sk-or-". Las claves de OpenRouter tienen el formato sk-or-v1-<64 hex>.\n',
    );
  }

  const pool = createPool();
  let payload;
  try {
    const idSolicitud = await solicitudPorEtiqueta(pool, etiqueta);
    const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [idSolicitud]);
    const row = rows[0];
    if (!row) throw new Error(`La solicitud ${idSolicitud} desaparecio entre consultas`);

    const solicitud = rowToSolicitud(row);
    const indicadores = calcularIndicadores(solicitud);
    const corpus = await cargarCorpusContext(pool);

    payload = {
      corpus,
      mensajes: construirMensajesFinalizer(solicitud, indicadores, corpus, []),
    };
  } catch (error) {
    console.error('\nFALLO DE DATOS — no se pudo construir el payload de finalizacion:');
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('\nRevisa que la base este levantada y sembrada: pnpm db:migrate && pnpm seed\n');
    await pool.end();
    process.exit(2);
  }

  const { corpus, mensajes } = payload;
  const peticion = peticionFinalizer(mensajes, corpus.idsValidos, DEFAULT_AGENT_LIMITS.maxFinalizerOutputTokens);
  const caracteresPrompt = mensajes.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);

  console.log('Payload de finalizacion:');
  console.log(`  politicas en corpus: ${corpus.totalPoliticas} (${corpus.totalRelaciones} relaciones)`);
  console.log(`  ids validos en enum: ${corpus.idsValidos.length}`);
  console.log(`  mensajes:            ${mensajes.length} (${caracteresPrompt} caracteres)`);
  console.log(`  funcion forzada:     ${FINALIZER_FUNCTION_NAME}`);
  console.log(`  herramientas:        ${peticion.tools?.length ?? 0} (solo el finalizer)`);
  console.log(`  max_tokens:          ${peticion.maxTokens}`);
  console.log(`  response_format:     ${peticion.responseFormat === undefined ? 'no se envia' : 'PRESENTE (bug)'}`);

  const semilla = semillaDeInferencia();
  const client = new OpenRouterClient({
    apiKey: config.OPENROUTER_API_KEY,
    baseUrl: config.OPENROUTER_BASE_URL,
    model: config.OPENROUTER_MODEL,
    timeoutMs: DEFAULT_AGENT_LIMITS.providerTimeoutMs,
    reasoningEffort: config.OPENROUTER_REASONING_EFFORT,
    ...(semilla !== null ? { seed: semilla } : {}),
  });

  const inicio = Date.now();
  let respuesta;
  try {
    respuesta = await client.chat(peticion);
  } catch (error) {
    console.error('\nFALLO — el proveedor no respondio a la llamada forzada:');
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      '\nSi el codigo es STRUCTURED_OUTPUT_UNSUPPORTED o PROVIDER_PARAMETER_REJECTED, este modelo\n' +
      'no admite tool_choice forzado y no sirve para la ruta de finalizacion.\n',
    );
    await pool.end();
    process.exit(1);
  }
  await pool.end();

  const latencia = Date.now() - inicio;
  const llamadas = respuesta.message.tool_calls ?? [];

  // Telemetria: se imprime siempre, pase o falle. Nunca razonamiento ni prompt.
  console.log('\nRespuesta del proveedor:');
  console.log(`  modelo configurado: ${config.OPENROUTER_MODEL}`);
  console.log(`  modelo resuelto:    ${respuesta.resolvedModel ?? 'no informado'}`);
  console.log(`  latencia:           ${latencia} ms`);
  console.log(`  finish_reason:      ${respuesta.finishReason ?? 'no informado'}`);
  console.log(`  tokens:             ${respuesta.usage.inputTokens} in / ${respuesta.usage.outputTokens} out`);
  console.log(`  reasoning:          effort=${config.OPENROUTER_REASONING_EFFORT}  tokens=${respuesta.usage.reasoningTokens}`);
  console.log(`  semilla:            ${semilla ?? 'no enviada'}`);
  console.log(`  costo:              ${respuesta.usage.cost ?? 'no informado por el proveedor'}`);
  console.log(`  tool_calls:         ${llamadas.length}`);
  console.log(`  nombres:            ${llamadas.length === 0 ? '(ninguno)' : llamadas.map((l) => l.function.name).join(', ')}`);
  console.log(`  longitud args:      ${llamadas.map((l) => l.function.arguments.length).join(', ') || '0'}`);
  console.log(`  content paralelo:   ${respuesta.message.content === null ? 'null' : `${respuesta.message.content.length} caracteres`}`);

  const veredicto = interpretarRespuestaFinalizer(respuesta);

  if (!veredicto.ok) {
    console.error(`\nFALLO [${veredicto.code}] — la finalizacion forzada no produjo un dictamen valido.`);
    console.error(`  ${veredicto.detalle}`);
    console.error(
      '\nEste modelo no cierra por function call forzada tal como esta configurado.\n' +
      'La evaluacion completa fallara por FINALIZER_FAILED en los casos que lleguen a esta fase.\n',
    );
    process.exit(1);
  }

  const d = veredicto.candidato;
  console.log(`\nPASS — ${FINALIZER_FUNCTION_NAME} devolvio argumentos que validan contra DictamenLLMSchema.`);
  console.log(`  argumentos:         ${veredicto.argumentsLength} caracteres`);
  console.log(`  decision:           ${d.decision}`);
  console.log(`  monto_recomendado:  ${d.monto_recomendado ?? 'null'}`);
  console.log(`  plazo_meses:        ${d.plazo_recomendado_meses ?? 'null'}`);
  console.log(`  policy_ids:         ${d.policy_ids.length === 0 ? '(ninguno)' : d.policy_ids.join(', ')}`);
  console.log(`  motivos:            ${d.motivos.length}`);
  console.log(`  confianza:          ${d.confianza}`);
  console.log(
    '\nNota: nivel de riesgo, indicadores, autorizacion humana y texto de las citas NO vienen\n' +
    'de aqui; los agrega el backend. La funcion no se ejecuto: sus argumentos son el resultado.\n',
  );
  console.log('Ruta de finalizacion operativa. Ya podes correr pnpm eval.\n');
}

main();
