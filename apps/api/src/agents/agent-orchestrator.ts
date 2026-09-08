import type { Pool } from 'pg';
import { AgentSchemaValidationError, DictamenLLMSchema, ProviderUnavailableError, type DictamenLLM, type FragmentoPoliticaEnriquecido } from '@credit/contracts';
import { AgentLoopError, ExecutionBudget, type AgentLimits } from './agent-limits.js';
import type {
  AgentAnalysisInput,
  AgentAnalysisResult,
  AgentIterationDiagnostic,
  AgentToolCallRecord,
  FaseIteracion,
} from './agent-provider.js';
import { construirMensajes } from './context-builder.js';
import {
  FINALIZER_FUNCTION_NAME,
  construirMensajesFinalizer,
  interpretarRespuestaFinalizer,
  peticionFinalizer,
} from './finalizer.js';
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
    // ===================== FASE 1: AGENTE =====================
    // Recolecta evidencia con las herramientas de dominio. Ya NO produce el
    // dictamen: eso es trabajo del finalizer.
    while (iterations < limits.maxIterations) {
      if (signal?.aborted) throw new AgentLoopError('CANCELLED', 'Ejecucion cancelada por el cliente', false);
      budget.assertNotExhausted();
      iterations += 1;

      const response = await chat(
        {
          messages: mensajes,
          tools: providerTools,
          toolChoice: 'auto',
          maxTokens: limits.maxOutputTokens,
          temperature: 0,
        },
        signal,
      );
      acumularUso(response);
      mensajes.push(response.message);

      const pedidas = response.message.tool_calls ?? [];
      registrarIteracion(iterationDiagnostics, iterations, 'AGENT', response, pedidas);

      if (pedidas.length === 0) {
        // El agente dejo de pedir herramientas: la evidencia esta completa.
        break;
      }

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

      if (iterations >= limits.maxIterations) {
        throw new AgentLoopError(
          'MAX_ITERATIONS_EXCEEDED',
          `Se superaron las ${limits.maxIterations} iteraciones sin completar la evidencia`,
          true,
        );
      }
    }

    // ===================== FASE 2: FINALIZER =====================
    // Function call forzada. El proveedor tiene que producir los argumentos de
    // una firma concreta, no prosa que ademas resulte ser JSON.
    const evidencia = [...new Set(politicasRecuperadas.map((p) => p.id_politica))];
    const mensajesFinalizer = construirMensajesFinalizer(
      input.solicitud,
      input.indicadores,
      corpus,
      evidencia,
    );

    const ejecutarFinalizer = async (
      fase: 'FINALIZER' | 'FINALIZER_REPAIR',
      mensajesFase: typeof mensajesFinalizer,
    ): Promise<ReturnType<typeof interpretarRespuestaFinalizer>> => {
      budget.assertNotExhausted();
      const response = await chat(
        peticionFinalizer(mensajesFase, corpus.idsValidos, limits.maxFinalizerOutputTokens),
        signal,
      );
      acumularUso(response);
      iterations += 1;

      const interpretado = interpretarRespuestaFinalizer(response);
      const diag = registrarIteracion(
        iterationDiagnostics,
        iterations,
        fase,
        response,
        response.message.tool_calls ?? [],
      );
      diag.schemaValid = interpretado.ok;
      diag.functionName = response.message.tool_calls?.[0]?.function.name ?? null;
      diag.argumentsLength = interpretado.argumentsLength;
      return interpretado;
    };

    const primerIntento = await ejecutarFinalizer('FINALIZER', mensajesFinalizer);
    if (primerIntento.ok) {
      emitir({
        type: 'dictamen.partial',
        label: 'Recomendacion generada, validando',
        data: { decision: primerIntento.candidato.decision },
      });
      return resultado(primerIntento.candidato);
    }

    // UNA reparacion, con la MISMA funcion forzada. Nunca se vuelve a
    // response_format libre: eso seria un fallback silencioso a un camino que
    // ya demostro no funcionar con este modelo.
    repairAttempted = true;
    const mensajesReparacion = [
      ...mensajesFinalizer,
      {
        role: 'user' as const,
        content:
          `El intento anterior no produjo una llamada valida a ${FINALIZER_FUNCTION_NAME} ` +
          `(${primerIntento.code}). Llama a la funcion con argumentos completos y validos. ` +
          'Motivos muy breves, maximo 5.',
      },
    ];

    const reparacion = await ejecutarFinalizer('FINALIZER_REPAIR', mensajesReparacion);
    if (reparacion.ok) {
      repairSucceeded = true;
      emitir({
        type: 'dictamen.partial',
        label: 'Recomendacion generada tras reparacion, validando',
        data: { decision: reparacion.candidato.decision },
      });
      return resultado(reparacion.candidato);
    }

    // Sin tercer intento.
    throw new AgentLoopError(
      reparacion.code === 'FINALIZER_TRUNCATED' ? 'OUTPUT_TOKEN_LIMIT_EXCEEDED' : 'FINALIZER_FAILED',
      `La finalizacion estructurada fallo dos veces. Primer intento: ${primerIntento.code} ` +
        `(${primerIntento.detalle}). Reparacion: ${reparacion.code} (${reparacion.detalle}).`,
      true,
      {
        primer_intento: primerIntento.code,
        reparacion: reparacion.code,
        max_finalizer_output_tokens: limits.maxFinalizerOutputTokens,
      },
    );
  } catch (error) {
    const failure = clasificarFallo(error);
    if (!failure) throw error;
    return resultado(null, failure);
  }
}

function registrarIteracion(
  destino: AgentIterationDiagnostic[],
  iteration: number,
  phase: FaseIteracion,
  response: ChatResponse,
  pedidas: NonNullable<ChatMessage['tool_calls']>,
): AgentIterationDiagnostic {
  const contenido = response.message.content ?? '';
  const diagnostico: AgentIterationDiagnostic = {
    iteration,
    phase,
    finishReason: response.finishReason,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    reasoningTokens: response.usage.reasoningTokens,
    contentLengthChars: contenido.length,
    toolCallCount: pedidas.length,
    toolNames: pedidas.map((p) => p.function.name),
    toolArgumentLengths: pedidas.map((p) => (p.function.arguments ?? '').length),
    functionName: null,
    argumentsLength: 0,
    hadFinalContent: contenido.trim().length > 0,
    schemaValid: false,
  };
  destino.push(diagnostico);
  return diagnostico;
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
