import 'dotenv/config';
import { config, safeConfigSnapshot } from '../apps/api/src/config.js';
import { OpenRouterClient } from '../apps/api/src/agents/openrouter-client.js';
import { semillaDeInferencia } from '../apps/api/src/agents/index.js';
import { SmokeSchema, evaluarRespuestaSmoke } from './smoke-verdict.js';

/**
 * Smoke test aislado del proveedor. Valida en una sola llamada que la API key,
 * el modelo y la salida estructurada funcionan, ANTES de gastar una evaluacion
 * completa. No toca la base de datos.
 *
 * PASS exige tres cosas, no un HTTP 200:
 *   contenido final + finish_reason de finalizacion exitosa + esquema cumplido.
 *
 * Codigos de salida: 0 = PASS, 1 = el modelo no produjo salida utilizable,
 * 2 = problema de configuracion.
 */
async function main(): Promise<void> {
  console.log('\nConfiguracion:', safeConfigSnapshot(), '\n');

  if (!config.OPENROUTER_API_KEY) {
    console.error('Falta OPENROUTER_API_KEY en .env');
    process.exit(2);
  }
  if (!config.OPENROUTER_API_KEY.startsWith('sk-or-')) {
    console.warn(
      'AVISO: la API key no empieza con "sk-or-". Las claves de OpenRouter tienen el formato sk-or-v1-<64 hex>.\n' +
      '       Si pegaste solo la parte hexadecimal, falta el prefijo.\n',
    );
  }

  const semilla = semillaDeInferencia();
  const client = new OpenRouterClient({
    apiKey: config.OPENROUTER_API_KEY,
    baseUrl: config.OPENROUTER_BASE_URL,
    model: config.OPENROUTER_MODEL,
    timeoutMs: 30_000,
    reasoningEffort: config.OPENROUTER_REASONING_EFFORT,
    ...(semilla !== null ? { seed: semilla } : {}),
  });

  const inicio = Date.now();
  let respuesta;
  try {
    respuesta = await client.chat({
      messages: [
        { role: 'system', content: 'Responde unicamente con JSON valido.' },
        { role: 'user', content: 'Devuelve {"ok": true, "modelo_respondio": "si"}' },
      ],
      maxTokens: 200,
      temperature: 0,
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'smoke',
          strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            required: ['ok', 'modelo_respondio'],
            properties: {
              ok: { type: 'boolean' },
              modelo_respondio: { type: 'string', maxLength: 50 },
            },
          },
        },
      },
    });
  } catch (error) {
    // Fallo de transporte o rechazo del proveedor: no llego a haber respuesta.
    console.error('\nFALLO — el proveedor no respondio:');
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('\nRevisa: formato de la API key (sk-or-v1-...), slug del modelo y salida de red.\n');
    process.exit(1);
  }

  const latencia = Date.now() - inicio;
  const contenido = respuesta.message.content ?? null;

  // Telemetria: se imprime siempre, pase o falle.
  console.log('Respuesta del proveedor:');
  console.log(`  modelo configurado: ${config.OPENROUTER_MODEL}`);
  console.log(`  modelo resuelto:    ${respuesta.resolvedModel ?? 'no informado'}`);
  console.log(`  latencia:           ${latencia} ms`);
  console.log(`  finish_reason:      ${respuesta.finishReason ?? 'no informado'}`);
  console.log(`  tokens:             ${respuesta.usage.inputTokens} in / ${respuesta.usage.outputTokens} out`);
  console.log(`  reasoning:          effort=${config.OPENROUTER_REASONING_EFFORT}  tokens=${respuesta.usage.reasoningTokens}`);
  console.log(`  semilla:            ${semilla ?? 'no enviada'}`);
  console.log(`  costo:              ${respuesta.usage.cost ?? 'no informado por el proveedor'}`);
  console.log(`  contenido:          ${contenido === null ? 'null' : `${contenido.length} caracteres`}`);

  // Veredicto. Un HTTP 200 no basta.
  const veredicto = evaluarRespuestaSmoke({ content: contenido, finishReason: respuesta.finishReason });

  if (!veredicto.ok) {
    console.error(`\nFALLO [${veredicto.code}] — el modelo no produjo salida utilizable.`);
    console.error(`  ${veredicto.motivo}`);
    if (contenido !== null && contenido.trim() !== '') {
      console.error(`  contenido recibido: ${JSON.stringify(contenido.slice(0, 200))}`);
    }
    console.error('\nEste modelo no sirve para la evaluacion tal como esta configurado.\n');
    process.exit(1);
  }

  const validado = SmokeSchema.parse(JSON.parse(contenido as string));
  console.log(`\nPASS — ${veredicto.motivo}`);
  if (veredicto.aviso) console.log(`  aviso: ${veredicto.aviso}`);
  console.log(`  objeto validado: ${JSON.stringify(validado)}`);
  console.log('\nStructured output operativo. Ya podes correr pnpm eval.\n');
}

main();
