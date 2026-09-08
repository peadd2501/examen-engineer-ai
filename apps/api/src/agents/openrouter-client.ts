import {
  AgentSchemaValidationError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@credit/contracts';
import { AgentLoopError } from './agent-limits.js';

/** Mensajes en el formato de chat completions de OpenRouter/OpenAI. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  /**
   * Bloques de razonamiento del modelo.
   *
   * Se conservan UNICAMENTE para reenviarlos en el historial: algunos modelos
   * con razonamiento exigen recibir de vuelta sus propios bloques en los turnos
   * siguientes de una conversacion con tool calls, o pierden el hilo.
   *
   * Nunca se persisten, nunca se registran en logs y nunca salen por la API ni
   * por SSE. Viven en memoria durante el run y se descartan con el.
   */
  reasoning_details?: unknown[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  /**
   * 'auto' | 'none' o la forma forzada de OpenAI/OpenRouter:
   * `{ type: 'function', function: { name } }`.
   */
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  responseFormat?: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Subconjunto de outputTokens gastado en razonamiento, si el proveedor lo separa. */
    reasoningTokens: number;
    cost: string | null;
  };
  /**
   * Modelo que REALMENTE respondio, segun el cuerpo de la respuesta.
   * OpenRouter puede enrutar a otro modelo del que se pidio (`openrouter/free`
   * es literalmente un enrutador), asi que solicitado y resuelto se registran
   * por separado.
   */
  resolvedModel: string | null;
  raw: unknown;
}

export type ReasoningEffort = 'off' | 'none' | 'low' | 'medium' | 'high';

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 'off' omite el campo `reasoning`; 'none' lo envia con effort 'none'. */
  reasoningEffort?: ReasoningEffort;
  /** Semilla de inferencia, cuando el modelo la soporta. Mejora la reproducibilidad. */
  seed?: number;
}

interface OpenRouterChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ChatMessage['tool_calls'];
    reasoning_details?: unknown[];
  };
  finish_reason?: string | null;
  native_finish_reason?: string | null;
}
interface OpenRouterBody {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; code?: number | string };
}

/**
 * No todo modelo acepta `response_format: json_schema`. Si el proveedor lo
 * rechaza hay que decirlo, no degradar en silencio a texto libre: perder el
 * structured output sin avisar convierte una falla de configuracion en
 * alucinaciones que aparecen tres capas mas abajo.
 */
const RE_STRUCTURED_OUTPUT_NO_SOPORTADO =
  /response_format|json[_ ]schema|structured output/i;

/** El proveedor rechaza el parametro `reasoning` o el nivel de esfuerzo pedido. */
const RE_REASONING_NO_SOPORTADO = /reasoning|effort/i;

/** Rechazo generico de un parametro no soportado. */
const RE_PARAMETRO_NO_SOPORTADO = /unsupported parameter|not supported|unrecognized|invalid.*parameter/i;

/**
 * Cliente HTTP minimo. Sin SDK: el contrato de chat completions es estable y
 * una dependencia mas seria superficie sin beneficio.
 *
 * Clasifica los fallos del proveedor de forma explicita (429, 5xx, timeout,
 * JSON malformado) porque el orquestador decide distinto para cada uno.
 */
export class OpenRouterClient {
  constructor(private readonly config: OpenRouterConfig) {}

  get model(): string {
    return this.config.model;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('provider-timeout')), this.config.timeoutMs);
    const onAbort = (): void => controller.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      // Temperatura 0: el determinismo del sistema no puede depender del muestreo.
      temperature: request.temperature,
      // Pide a OpenRouter que informe costo real en la respuesta.
      usage: { include: true },
    };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools;
      body['tool_choice'] = request.toolChoice ?? 'auto';
    }
    if (request.responseFormat) body['response_format'] = request.responseFormat;

    // Razonamiento. Un modelo que razona sin techo consume el presupuesto de
    // salida antes de emitir el JSON final: asi murieron CASE-01 y CASE-09 con
    // Dots3, y asi murio CASE-01 con Nemotron (1736 tokens de razonamiento y
    // 5000 de salida sin dictamen). Para este flujo el dictamen es pequeno y
    // deterministico, y no necesita razonamiento extendido.
    const esfuerzo = this.config.reasoningEffort ?? 'off';
    if (esfuerzo !== 'off') body['reasoning'] = { effort: esfuerzo };

    // Semilla de inferencia: misma entrada, misma salida, en los modelos que la
    // soportan. Viene del SEED del proyecto, no de un literal.
    if (this.config.seed !== undefined) body['seed'] = this.config.seed;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'AI Credit Originator',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new AgentLoopError('CANCELLED', 'Ejecucion cancelada por el cliente', false);
      throw new ProviderTimeoutError(
        `Sin respuesta del proveedor en ${this.config.timeoutMs} ms: ${error instanceof Error ? error.message : 'error de red'}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const texto = await response.text();

    if (response.status === 429) {
      throw new AgentLoopError('PROVIDER_RATE_LIMITED', 'El proveedor limito la tasa de peticiones (429)', true, {
        status: 429,
      });
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError(`El proveedor respondio ${response.status}`);
    }
    if (!response.ok) {
      // 400/401/404: error de configuracion nuestro. No se reintenta.
      let detalle = texto.slice(0, 300);
      try {
        const parsed = JSON.parse(texto) as OpenRouterBody;
        detalle = parsed.error?.message ?? detalle;
      } catch { /* se conserva el texto crudo recortado */ }

      if (response.status === 400) {
        // Se clasifica por parametro. Nunca hay fallback silencioso: si el
        // proveedor rechaza algo que pedimos, el run falla con el motivo exacto.
        if (esfuerzo !== 'off' && RE_REASONING_NO_SOPORTADO.test(detalle)) {
          throw new AgentLoopError(
            'REASONING_EFFORT_UNSUPPORTED',
            `El modelo ${this.config.model} rechazo reasoning.effort='${esfuerzo}': ${detalle}. ` +
              'Configura OPENROUTER_REASONING_EFFORT=off para omitir el parametro.',
            false,
            { status: 400, model: this.config.model, effort: esfuerzo },
          );
        }
        if (request.responseFormat !== undefined && RE_STRUCTURED_OUTPUT_NO_SOPORTADO.test(detalle)) {
          throw new AgentLoopError(
            'STRUCTURED_OUTPUT_UNSUPPORTED',
            `El modelo ${this.config.model} no acepta response_format json_schema: ${detalle}`,
            false,
            { status: 400, model: this.config.model },
          );
        }
        if (RE_PARAMETRO_NO_SOPORTADO.test(detalle)) {
          throw new AgentLoopError(
            'PROVIDER_PARAMETER_REJECTED',
            `El modelo ${this.config.model} rechazo un parametro de la peticion: ${detalle}`,
            false,
            { status: 400, model: this.config.model },
          );
        }
      }

      throw new ProviderUnavailableError(`El proveedor rechazo la peticion (${response.status}): ${detalle}`);
    }

    let parsed: OpenRouterBody;
    try {
      parsed = JSON.parse(texto) as OpenRouterBody;
    } catch {
      throw new AgentSchemaValidationError('El proveedor devolvio una respuesta que no es JSON', {
        code: 'INVALID_PROVIDER_RESPONSE',
        preview: texto.slice(0, 200),
      });
    }

    const choice = parsed.choices?.[0];
    if (!choice?.message) {
      throw new AgentSchemaValidationError('La respuesta del proveedor no contiene un mensaje', {
        code: 'INVALID_PROVIDER_RESPONSE',
      });
    }

    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        // Se arrastra tal cual para el siguiente turno. No sale de este proceso.
        ...(choice.message.reasoning_details ? { reasoning_details: choice.message.reasoning_details } : {}),
      },
      finishReason: choice.finish_reason ?? choice.native_finish_reason ?? null,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        cost: typeof parsed.usage?.cost === 'number' ? parsed.usage.cost.toFixed(6) : null,
      },
      resolvedModel: parsed.model ?? null,
      raw: parsed,
    };
  }
}
