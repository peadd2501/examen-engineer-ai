import type { Pool } from 'pg';
import { AgentSchemaValidationError, DictamenLLMSchema, ProviderUnavailableError, type DictamenLLM, type FragmentoPoliticaEnriquecido } from '@credit/contracts';
import { AgentLoopError, ExecutionBudget, type AgentLimits } from './agent-limits.js';
import type {
  AgentAnalysisInput,
  AgentAnalysisResult,
  AgentIterationDiagnostic,
  AgentToolCallRecord,
} from './agent-provider.js';
import { construirMensajes, construirResponseFormat } from './context-builder.js';
import { cargarCorpusContext } from './corpus-context.js';
import type { ChatMessage, ChatResponse } from './openrouter-client.js';
import { ToolNotAllowedError, toProviderTools, type ToolContext, type ToolRegistry } from './tools/registry.js';

export interface ChatFn {
  (request: Parameters<import('./openrouter-client.js').OpenRouterClient['chat']>[0], signal?: AbortSignal): Promise<ChatResponse>;
}

export interface OrchestratorDeps {
  pool: Pool;
  registry: ToolRegistry;
  limits: AgentLimits;
  chat: ChatFn;
}

/** Nombres amigables de las herramientas, para el timeline del analista. */
const ETIQUETA_TOOL: Record<string, string> = {
  obtener_solicitud: 'Consultando la solicitud',
  calcular_indicadores: 'Calculando indicadores financieros',
  buscar_politica: 'Buscando politicas aplicables',
  metricas_cartera: 'Consultando metricas de cartera',
};

/**
 * Agent loop explicito, controlado por la aplicacion.
 *
 * El proveedor solo produce mensajes. Que herramienta se ejecuta, con que
 * argumentos, cuantas veces y por cuanto tiempo lo decide este codigo.
 */
export async function ejecutarAgentLoop(
  deps: OrchestratorDeps,
  input: AgentAnalysisInput,
  signal?: AbortSignal,
  onEvent?: import('./agent-provider.js').AgentEventEmitter,
): Promise<AgentAnalysisResult> {
  const emitir = onEvent ?? ((): void => undefined);
  const { pool, registry, limits, chat } = deps;
  const budget = new ExecutionBudget(limits.totalExecutionTimeoutMs);
  const iniciado = Date.now();

  const toolCalls: AgentToolCallRecord[] = [];
  const iterationDiagnostics: AgentIterationDiagnostic[] = [];
  const politicasRecuperadas: FragmentoPoliticaEnriquecido[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0, costReported: false };
  /** finish_reason de la ultima respuesta del proveedor. Distingue por que fallo un run. */
  let lastFinishReason: string | null = null;

  const ctx = {
    pool,
    registrarPoliticas: (fragmentos: unknown[]): void => {
      politicasRecuperadas.push(...(fragmentos as FragmentoPoliticaEnriquecido[]));
    },
  };

  // El corpus completo entra al contexto como bloque autoritativo, y sus ids
  // alimentan el enum del structured output.
  const corpus = await cargarCorpusContext(pool);
  const responseFormat = construirResponseFormat(corpus.idsValidos);

  const mensajes = construirMensajes(input.solicitud, input.indicadores, corpus, input.consultaAnalista);
  const providerTools = toProviderTools(registry);

  let iterations = 0;
  let repairAttempted = false;
  let repairSucceeded = false;
  let resolvedModel: string | null = null;

  const acumularUso = (r: ChatResponse): void => {
    if (r.resolvedModel) resolvedModel = r.resolvedModel;
    lastFinishReason = r.finishReason;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.reasoningTokens += r.usage.reasoningTokens;
    if (r.usage.cost !== null) {
      usage.cost += Number(r.usage.cost);
      usage.costReported = true;
    }
  };

  const resultado = (
    candidato: DictamenLLM | null,
    failure?: AgentAnalysisResult['failure'],
  ): AgentAnalysisResult => ({
    candidato,
    politicasRecuperadas,
    politicasDisponibles: corpus.idsValidos,
    resolvedModel,
    toolCalls,
    iterationDiagnostics,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      estimatedCost: usage.cost.toFixed(6),
      costReportedByProvider: usage.costReported,
    },
    lastFinishReason,
    iterations,
    latencyMs: Date.now() - iniciado,
    repairAttempted,
    repairSucceeded,
    ...(failure ? { failure } : {}),
  });

  try {
    while (iterations < limits.maxIterations) {
      if (signal?.aborted) throw new AgentLoopError('CANCELLED', 'Ejecucion cancelada por el cliente', false);
      budget.assertNotExhausted();
      iterations += 1;

      const response = await chat(
        {
          messages: mensajes,
          tools: providerTools,
          toolChoice: 'auto',
          responseFormat,
          maxTokens: limits.maxOutputTokens,
          temperature: 0,
        },
        signal,
      );
      acumularUso(response);
      mensajes.push(response.message);

      const pedidas = response.message.tool_calls ?? [];
      const diagnostico = registrarIteracion(iterationDiagnostics, iterations, response, pedidas);

      // El proveedor puede devolver varias tool calls en una sola respuesta.
      if (pedidas.length > 0) {
        if (toolCalls.length + pedidas.length > limits.maxToolCalls) {
          throw new AgentLoopError(
            'MAX_TOOL_CALLS_EXCEEDED',
            `Se supero el limite de ${limits.maxToolCalls} llamadas a herramienta`,
            true,
          );
        }

        for (const pedida of pedidas) {
          emitir({
            type: 'tool.started',
            label: ETIQUETA_TOOL[pedida.function.name] ?? `Ejecutando ${pedida.function.name}`,
            data: { tool: pedida.function.name, sequence: toolCalls.length + 1 },
          });

          const politicasAntes = politicasRecuperadas.length;
          const registro = await ejecutarHerramienta(registry, ctx, pedida, toolCalls.length + 1);
          toolCalls.push(registro);
          mensajes.push({
            role: 'tool',
            tool_call_id: pedida.id,
            name: pedida.function.name,
            content: JSON.stringify(
              registro.status === 'OK' ? registro.result : { error: registro.errorMessage },
            ),
          });

          emitir({
            type: 'tool.completed',
            label: `${ETIQUETA_TOOL[pedida.function.name] ?? pedida.function.name}: ${registro.status === 'OK' ? 'listo' : 'error'}`,
            data: {
              tool: registro.toolName,
              sequence: registro.sequence,
              status: registro.status,
              latency_ms: registro.latencyMs,
            },
          });

          // Las politicas recuperadas se anuncian por id: es la fuente que
          // respaldara la decision, y el analista tiene que poder verla.
          for (const politica of politicasRecuperadas.slice(politicasAntes)) {
            emitir({
              type: 'policy.found',
              label: `Politica ${politica.id_politica} consultada`,
              data: {
                id_politica: politica.id_politica,
                seccion: politica.seccion,
                categoria: politica.categoria,
                incluido_por_relacion: politica.incluido_por_relacion,
              },
            });
          }
        }
        continue;
      }

      // Sin tool calls: se espera el structured output final.
      const parseado = parsearCandidato(response.message.content);
      diagnostico.schemaValid = parseado.ok;
      if (parseado.ok) {
        emitir({
          type: 'dictamen.partial',
          label: 'Recomendacion generada, validando',
          data: { decision: parseado.value.decision, nivel_riesgo: parseado.value.nivel_riesgo },
        });
        return resultado(parseado.value);
      }

      // La generacion se corto por techo de tokens. Reparar no sirve: la
      // segunda respuesta se cortaria igual. Se clasifica aparte porque el
      // arreglo es presupuesto de salida, no schema ni prompt.
      if (response.finishReason === 'length') {
        throw new AgentLoopError(
          'OUTPUT_TOKEN_LIMIT_EXCEEDED',
          `La generacion se corto por limite de tokens (max_tokens=${limits.maxOutputTokens}, ` +
            `salida=${response.usage.outputTokens}, razonamiento=${response.usage.reasoningTokens}) ` +
            'sin producir un dictamen valido',
          true,
          {
            finish_reason: response.finishReason,
            max_output_tokens: limits.maxOutputTokens,
            output_tokens: response.usage.outputTokens,
            reasoning_tokens: response.usage.reasoningTokens,
          },
        );
      }

      // Una unica reparacion estructurada. Nunca un retry ciego.
      if (repairAttempted) {
        throw fallaDeSalida(parseado.error, response, limits.maxOutputTokens);
      }
      repairAttempted = true;
      mensajes.push({
        role: 'user',
        content: [
          'Tu respuesta anterior no cumple el esquema requerido.',
          `Errores detectados: ${parseado.error}`,
          'Devuelve unicamente el objeto JSON valido. No agregues texto fuera del JSON.',
        ].join('\n'),
      });

      budget.assertNotExhausted();
      const reparada = await chat(
        {
          messages: mensajes,
          responseFormat,
          maxTokens: limits.maxOutputTokens,
          temperature: 0,
        },
        signal,
      );
      acumularUso(reparada);
      iterations += 1;
      const diagReparacion = registrarIteracion(
        iterationDiagnostics,
        iterations,
        reparada,
        reparada.message.tool_calls ?? [],
      );

      const reparado = parsearCandidato(reparada.message.content);
      diagReparacion.schemaValid = reparado.ok;
      if (reparado.ok) {
        repairSucceeded = true;
        return resultado(reparado.value);
      }
      throw fallaDeSalida(reparado.error, reparada, limits.maxOutputTokens);
    }

    throw new AgentLoopError(
      'MAX_ITERATIONS_EXCEEDED',
      `Se superaron las ${limits.maxIterations} iteraciones sin dictamen`,
      true,
    );
  } catch (error) {
    const failure = clasificarFallo(error);
    if (!failure) throw error;
    return resultado(null, failure);
  }
}

/**
 * Registra la metadata segura de una llamada al proveedor.
 *
 * Se toma la LONGITUD del contenido y de los argumentos, nunca su texto. Asi el
 * diagnostico responde "que consumio la salida" —muchas iteraciones, tool calls
 * con argumentos gigantes, contenido final enorme— sin guardar nada del
 * razonamiento del modelo.
 */
function registrarIteracion(
  destino: AgentIterationDiagnostic[],
  iteration: number,
  response: ChatResponse,
  pedidas: NonNullable<ChatMessage['tool_calls']>,
): AgentIterationDiagnostic {
  const contenido = response.message.content ?? '';
  const diagnostico: AgentIterationDiagnostic = {
    iteration,
    finishReason: response.finishReason,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    reasoningTokens: response.usage.reasoningTokens,
    contentLengthChars: contenido.length,
    toolCallCount: pedidas.length,
    toolNames: pedidas.map((p) => p.function.name),
    toolArgumentLengths: pedidas.map((p) => (p.function.arguments ?? '').length),
    hadFinalContent: contenido.trim().length > 0,
    schemaValid: false,
  };
  destino.push(diagnostico);
  return diagnostico;
}

/**
 * Traduce una salida final no valida al codigo que corresponde.
 *
 * Un `AGENT_SCHEMA_VALIDATION_FAILED` generico esconde tres problemas distintos:
 * truncacion, respuesta vacia y JSON que no cumple el esquema. Cada uno se
 * arregla en un lugar diferente, asi que cada uno lleva su propio codigo.
 */
function fallaDeSalida(
  errorSchema: string,
  response: ChatResponse,
  maxOutputTokens: number,
): AgentLoopError {
  const contenido = response.message.content ?? '';

  if (response.finishReason === 'length') {
    return new AgentLoopError(
      'OUTPUT_TOKEN_LIMIT_EXCEEDED',
      `La generacion se corto por limite de tokens (max_tokens=${maxOutputTokens}, ` +
        `salida=${response.usage.outputTokens}, razonamiento=${response.usage.reasoningTokens})`,
      true,
      {
        finish_reason: response.finishReason,
        max_output_tokens: maxOutputTokens,
        output_tokens: response.usage.outputTokens,
        reasoning_tokens: response.usage.reasoningTokens,
      },
    );
  }

  if (contenido.trim() === '') {
    return new AgentLoopError(
      'EMPTY_PROVIDER_RESPONSE',
      `El proveedor cerro con finish_reason='${response.finishReason ?? 'desconocido'}' sin devolver contenido`,
      true,
      {
        finish_reason: response.finishReason,
        output_tokens: response.usage.outputTokens,
        reasoning_tokens: response.usage.reasoningTokens,
      },
    );
  }

  return new AgentLoopError(
    'AGENT_SCHEMA_VALIDATION_FAILED',
    `La salida del modelo sigue siendo invalida tras la reparacion: ${errorSchema}`,
    true,
    { errores: errorSchema, finish_reason: response.finishReason },
  );
}

function clasificarFallo(error: unknown): AgentAnalysisResult['failure'] | null {
  if (error instanceof AgentLoopError) return { code: error.failure, message: error.message };
  if (error instanceof ProviderUnavailableError) return { code: 'PROVIDER_UNAVAILABLE', message: error.message };
  if (error instanceof AgentSchemaValidationError) {
    return { code: 'INVALID_PROVIDER_RESPONSE', message: error.message };
  }
  if (error instanceof Error && error.name === 'ProviderTimeoutError') {
    return { code: 'PROVIDER_TIMEOUT', message: error.message };
  }
  return null;
}

type Parseo = { ok: true; value: DictamenLLM } | { ok: false; error: string };

function parsearCandidato(content: string | null): Parseo {
  if (!content || content.trim() === '') return { ok: false, error: 'respuesta vacia' };

  let json: unknown;
  try {
    json = JSON.parse(extraerJson(content));
  } catch {
    return { ok: false, error: 'la respuesta no es JSON valido' };
  }

  const parsed = DictamenLLMSchema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
  };
}

/** Tolera que el modelo envuelva el JSON en un bloque de codigo. */
function extraerJson(texto: string): string {
  const enBloque = /```(?:json)?\s*([\s\S]*?)```/.exec(texto);
  if (enBloque?.[1]) return enBloque[1].trim();
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio >= 0 && fin > inicio) return texto.slice(inicio, fin + 1);
  return texto.trim();
}

async function ejecutarHerramienta(
  registry: ToolRegistry,
  ctx: ToolContext,
  pedida: { id: string; function: { name: string; arguments: string } },
  sequence: number,
): Promise<AgentToolCallRecord> {
  const inicio = Date.now();
  const nombre = pedida.function.name;

  const base = { sequence, toolName: nombre, latencyMs: 0 };

  try {
    // Allowlist: solo se ejecuta lo que esta registrado Y expuesto al modelo.
    const tool = registry[nombre];
    if (!tool || !tool.exposedToModel) throw new ToolNotAllowedError(nombre);

    let argumentosCrudos: unknown;
    try {
      argumentosCrudos = pedida.function.arguments ? JSON.parse(pedida.function.arguments) : {};
    } catch {
      throw new AgentSchemaValidationError(`Argumentos no parseables para ${nombre}`, { tool: nombre });
    }

    const { args, result } = await tool.run(argumentosCrudos, ctx);

    return { ...base, arguments: args, result, latencyMs: Date.now() - inicio, status: 'OK' };
  } catch (error) {
    // Un fallo de herramienta no aborta el run: se devuelve al modelo como
    // resultado de error para que pueda corregir o escalar.
    return {
      ...base,
      arguments: safeArgs(pedida.function.arguments),
      result: null,
      latencyMs: Date.now() - inicio,
      status: 'ERROR',
      errorMessage: error instanceof Error ? error.message : 'error desconocido',
    };
  }
}

function safeArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw.slice(0, 500) };
  }
}
