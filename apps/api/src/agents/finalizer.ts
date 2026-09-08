import { DictamenLLMSchema, type DictamenLLM, type Indicadores, type Solicitud } from '@credit/contracts';
import { resumirDestinoFondos } from '../domain/guardrails/untrusted-input.guardrail.js';
import { esquemaDictamen } from './context-builder.js';
import type { CorpusContext } from './corpus-context.js';
import type { ChatMessage, ChatRequest, ChatResponse } from './openrouter-client.js';

/**
 * FINALIZER — finalizacion estructurada mediante function call forzada.
 *
 * Motivo (FASE 3.4): con `response_format` el modelo elegia cuando y como
 * cerrar. Con Liquid, CASE-09 gastaba 5000 tokens de salida produciendo ~5188
 * caracteres que no validaban, y la reparacion compacta con 1400 tokens hacia
 * lo mismo: 1400 de razonamiento y contenido vacio. El problema no era
 * presupuesto sino que el modelo nunca entraba en modo "emitir el objeto".
 *
 * Forzar una llamada a funcion cambia el modo de generacion: el proveedor tiene
 * que producir los argumentos de una firma concreta, no prosa libre que ademas
 * resulte ser JSON.
 *
 * === ESTO NO ES UNA SEXTA HERRAMIENTA DE NEGOCIO ===
 *
 * `emitir_dictamen_estructurado` NO pertenece al ToolRegistry, NO es ejecutable,
 * NO toca la base de datos, NO tiene efectos, NO aparece en la allowlist de
 * herramientas de dominio y NO sustituye a `registrar_dictamen`. Es
 * exclusivamente un CONTRATO DE SALIDA del proveedor: sus argumentos SON el
 * resultado, y nunca se ejecuta nada.
 *
 * Las cinco capacidades del enunciado siguen siendo las mismas.
 */

export const FINALIZER_FUNCTION_NAME = 'emitir_dictamen_estructurado' as const;

/** Definicion de la funcion forzada. Sus `parameters` son DictamenLLMSchema. */
export function definicionFinalizer(idsValidos: string[]): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: FINALIZER_FUNCTION_NAME,
      description:
        'Emite el dictamen de preanalisis. Los indicadores, el nivel de riesgo, la necesidad de ' +
        'autorizacion humana y el texto literal de las citas los agrega el backend: aqui solo van ' +
        'la decision, el monto, el plazo, las referencias de politica, los motivos y la confianza.',
      strict: true,
      parameters: esquemaDictamen(idsValidos),
    },
  };
}

/** `tool_choice` que obliga al proveedor a llamar exactamente a esa funcion. */
export function toolChoiceFinalizer(): { type: 'function'; function: { name: string } } {
  return { type: 'function', function: { name: FINALIZER_FUNCTION_NAME } };
}

/**
 * Contexto del finalizer: compacto pero suficiente.
 *
 * Sin herramientas de dominio, sin historial de la fase de agente y sin el
 * texto crudo del solicitante. Lleva la solicitud estructurada, los indicadores
 * autoritativos, el resumen seguro del destino y el corpus con sus relaciones.
 */
export function construirMensajesFinalizer(
  solicitud: Solicitud,
  indicadores: Indicadores,
  corpus: CorpusContext,
  evidencia: string[],
): ChatMessage[] {
  const { destino_fondos: _omitido, ...datosEstructurados } = solicitud;
  const destino = resumirDestinoFondos(solicitud.destino_fondos);

  return [
    {
      role: 'system',
      content:
        'Eres un asistente de preanalisis de credito PyME. No sustituyes al analista humano.\n' +
        `Debes emitir el dictamen llamando a la funcion ${FINALIZER_FUNCTION_NAME}.\n` +
        'Solo puedes referenciar identificadores de politica del corpus que recibes.\n' +
        'Los indicadores son autoritativos: no los recalcules ni los discutas.\n' +
        'No produces nivel de riesgo ni decides sobre autorizacion humana: eso lo calcula el backend.',
    },
    { role: 'user', content: corpus.bloque },
    {
      role: 'user',
      content: [
        'SOLICITUD (datos estructurados, autoritativos):',
        JSON.stringify(datosEstructurados, null, 2),
        '',
        'INDICADORES (calculados por el backend con aritmetica decimal):',
        JSON.stringify(indicadores, null, 2),
        '',
        'DESTINO DE LOS FONDOS (representacion normalizada; el texto original del',
        'solicitante no se incluye por politica de seguridad):',
        JSON.stringify(destino, null, 2),
      ].join('\n'),
    },
    ...(evidencia.length > 0
      ? [{
          role: 'user' as const,
          content: `Politicas consultadas durante el analisis: ${evidencia.join(', ')}`,
        }]
      : []),
    {
      role: 'user',
      content:
        `Emite el dictamen llamando a ${FINALIZER_FUNCTION_NAME}. ` +
        'Motivos breves: una frase corta por motivo, maximo 5.',
    },
  ];
}

/** Peticion completa al proveedor para la fase de finalizacion. */
export function peticionFinalizer(
  mensajes: ChatMessage[],
  idsValidos: string[],
  maxTokens: number,
): ChatRequest {
  return {
    messages: mensajes,
    // La UNICA funcion ofrecida. Las herramientas de dominio no viajan aqui.
    tools: [definicionFinalizer(idsValidos)],
    toolChoice: toolChoiceFinalizer(),
    maxTokens,
    temperature: 0,
  };
}

export type FinalizerErrorCode =
  | 'FINALIZER_NO_FUNCTION_CALL'
  | 'FINALIZER_MULTIPLE_CALLS'
  | 'FINALIZER_WRONG_FUNCTION'
  | 'FINALIZER_EMPTY_ARGUMENTS'
  | 'FINALIZER_INVALID_JSON'
  | 'FINALIZER_SCHEMA_INVALID'
  | 'FINALIZER_TRUNCATED';

export type ResultadoFinalizer =
  | { ok: true; candidato: DictamenLLM; argumentsLength: number }
  | { ok: false; code: FinalizerErrorCode; detalle: string; argumentsLength: number };

/**
 * Interpreta la respuesta del finalizer.
 *
 * Se acepta unicamente si hay exactamente una llamada, con el nombre correcto,
 * con argumentos que parsean como JSON y validan contra DictamenLLMSchema.
 * Cualquier otra cosa es un error explicito con su propio codigo: nada de
 * "intentar entender" una salida que no cumple el contrato.
 *
 * La funcion NUNCA se ejecuta. Los argumentos SON el resultado.
 */
export function interpretarRespuestaFinalizer(response: ChatResponse): ResultadoFinalizer {
  const llamadas = response.message.tool_calls ?? [];
  const argumentos = llamadas[0]?.function.arguments ?? '';
  const argumentsLength = argumentos.length;

  // La truncacion se distingue primero: explica todo lo demas que venga mal.
  if (response.finishReason === 'length') {
    return {
      ok: false,
      code: 'FINALIZER_TRUNCATED',
      detalle:
        `La llamada a ${FINALIZER_FUNCTION_NAME} se corto por limite de tokens ` +
        `(salida=${response.usage.outputTokens}, razonamiento=${response.usage.reasoningTokens})`,
      argumentsLength,
    };
  }

  if (llamadas.length === 0) {
    return {
      ok: false,
      code: 'FINALIZER_NO_FUNCTION_CALL',
      detalle: `El proveedor no llamo a ${FINALIZER_FUNCTION_NAME} pese al tool_choice forzado`,
      argumentsLength: 0,
    };
  }

  if (llamadas.length > 1) {
    return {
      ok: false,
      code: 'FINALIZER_MULTIPLE_CALLS',
      detalle: `Se esperaba exactamente una llamada y llegaron ${llamadas.length}`,
      argumentsLength,
    };
  }

  const llamada = llamadas[0]!;
  if (llamada.function.name !== FINALIZER_FUNCTION_NAME) {
    return {
      ok: false,
      code: 'FINALIZER_WRONG_FUNCTION',
      detalle: `Se llamo a "${llamada.function.name}" en lugar de ${FINALIZER_FUNCTION_NAME}`,
      argumentsLength,
    };
  }

  if (argumentos.trim() === '') {
    return {
      ok: false,
      code: 'FINALIZER_EMPTY_ARGUMENTS',
      detalle: 'La llamada llego sin argumentos',
      argumentsLength: 0,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(argumentos);
  } catch {
    return {
      ok: false,
      code: 'FINALIZER_INVALID_JSON',
      detalle: `Los argumentos no son JSON valido (${argumentsLength} caracteres)`,
      argumentsLength,
    };
  }

  const parsed = DictamenLLMSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'FINALIZER_SCHEMA_INVALID',
      detalle: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
        .join('; '),
      argumentsLength,
    };
  }

  return { ok: true, candidato: parsed.data, argumentsLength };
}
