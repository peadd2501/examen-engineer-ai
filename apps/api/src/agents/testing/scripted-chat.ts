import type { ChatFn } from '../agent-orchestrator.js';
import type { ChatResponse } from '../openrouter-client.js';

/**
 * Utilidades para guionar respuestas del proveedor en tests.
 * Solo se usan en tests: ningun camino de produccion las importa.
 */

export function respuestaFinal(objeto: unknown, tokens = { input: 100, output: 50 }): ChatResponse {
  return {
    message: { role: 'assistant', content: JSON.stringify(objeto) },
    finishReason: 'stop',
    usage: { inputTokens: tokens.input, outputTokens: tokens.output, reasoningTokens: 0, cost: '0.000000' },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

export function respuestaTexto(texto: string, finishReason = 'stop'): ChatResponse {
  return {
    message: { role: 'assistant', content: texto },
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** Generacion cortada por techo de tokens: contenido parcial y finish_reason 'length'. */
export function respuestaTruncada(parcial = '{"decision":"APROB', outputTokens = 5000, reasoningTokens = 4800): ChatResponse {
  return {
    message: { role: 'assistant', content: parcial },
    finishReason: 'length',
    usage: { inputTokens: 7759, outputTokens, reasoningTokens, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** El proveedor cierra normalmente pero no devuelve contenido. */
export function respuestaVacia(finishReason = 'stop'): ChatResponse {
  return {
    message: { role: 'assistant', content: '' },
    finishReason,
    usage: { inputTokens: 7751, outputTokens: 3000, reasoningTokens: 2950, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** Respuesta con bloques de razonamiento, para probar el round-trip. */
export function respuestaConRazonamiento(objeto: unknown, bloques: unknown[]): ChatResponse {
  return {
    message: { role: 'assistant', content: JSON.stringify(objeto), reasoning_details: bloques },
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 30, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

export function respuestaToolCall(llamadas: Array<{ name: string; args: unknown }>): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: llamadas.map((l, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: { name: l.name, arguments: JSON.stringify(l.args) },
      })),
    },
    finishReason: 'tool_calls',
    usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 0, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** Reproduce una secuencia fija de respuestas, una por iteracion. */
export function guion(respuestas: ChatResponse[]): { chat: ChatFn; llamadas: () => number } {
  let i = 0;
  const chat: ChatFn = async () => {
    const r = respuestas[i];
    i += 1;
    if (!r) throw new Error(`El guion se quedo sin respuestas en la iteracion ${i}`);
    return r;
  };
  return { chat, llamadas: () => i };
}

/** Repite siempre la misma respuesta. Util para probar limites del loop. */
export function guionInfinito(respuesta: ChatResponse): { chat: ChatFn; llamadas: () => number } {
  let i = 0;
  const chat: ChatFn = async () => {
    i += 1;
    return respuesta;
  };
  return { chat, llamadas: () => i };
}

/** Proveedor que siempre falla, para probar clasificacion de errores. */
export function guionQueFalla(error: Error): { chat: ChatFn } {
  return {
    chat: async () => {
      throw error;
    },
  };
}

/**
 * Respuesta del agente sin tool calls: cierra la fase de recoleccion de
 * evidencia y da paso al finalizer.
 */
export function respuestaSinTools(finishReason = 'stop'): ChatResponse {
  return {
    message: { role: 'assistant', content: '' },
    finishReason,
    usage: { inputTokens: 900, outputTokens: 10, reasoningTokens: 0, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** Llamada valida a la funcion forzada del finalizer. */
export function respuestaFinalizer(
  argumentos: unknown,
  opciones: { nombre?: string; finishReason?: string; llamadas?: number } = {},
): ChatResponse {
  const nombre = opciones.nombre ?? 'emitir_dictamen_estructurado';
  const cuantas = opciones.llamadas ?? 1;
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: Array.from({ length: cuantas }, (_, i) => ({
        id: `fin_${i}`,
        type: 'function' as const,
        function: {
          name: nombre,
          arguments: typeof argumentos === 'string' ? argumentos : JSON.stringify(argumentos),
        },
      })),
    },
    finishReason: opciones.finishReason ?? 'tool_calls',
    usage: { inputTokens: 4200, outputTokens: 180, reasoningTokens: 0, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** El finalizer no llama a ninguna funcion. */
export function respuestaFinalizerSinLlamada(finishReason = 'stop'): ChatResponse {
  return {
    message: { role: 'assistant', content: 'No puedo emitir el dictamen.' },
    finishReason,
    usage: { inputTokens: 4200, outputTokens: 20, reasoningTokens: 0, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}

/** El finalizer se trunca. */
export function respuestaFinalizerTruncada(outputTokens = 1200, reasoningTokens = 1150): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'fin_0', type: 'function', function: { name: 'emitir_dictamen_estructurado', arguments: '{"decision":"APROB' } }],
    },
    finishReason: 'length',
    usage: { inputTokens: 4353, outputTokens, reasoningTokens, cost: null },
    resolvedModel: 'scripted/deterministic',
    raw: {},
  };
}
