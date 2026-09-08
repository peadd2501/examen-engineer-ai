import type {
  DictamenLLM,
  FragmentoPoliticaEnriquecido,
  Indicadores,
  Solicitud,
} from '@credit/contracts';
import type { AgentFailureCode } from './agent-limits.js';

/**
 * Entrada del agente. Los indicadores llegan ya calculados por el backend:
 * son dato autoritativo, no algo que el modelo deba producir ni recalcular.
 */
export interface AgentAnalysisInput {
  solicitud: Solicitud;
  indicadores: Indicadores;
  /** Consulta libre del analista. Opcional. */
  consultaAnalista?: string;
}

export interface AgentToolCallRecord {
  sequence: number;
  toolName: string;
  arguments: unknown;
  result: unknown;
  latencyMs: number;
  status: 'OK' | 'ERROR';
  errorMessage?: string;
}

/**
 * Metadata segura de una llamada al proveedor.
 *
 * Deliberadamente NO contiene el contenido generado, ni razonamiento, ni
 * chain-of-thought: solo tamanos, conteos y banderas. Es lo suficiente para
 * diagnosticar una generacion descontrolada sin guardar nada sensible.
 */
export interface AgentIterationDiagnostic {
  iteration: number;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Longitud del contenido final en caracteres. Nunca el contenido. */
  contentLengthChars: number;
  toolCallCount: number;
  toolNames: string[];
  /** Longitud en caracteres de los argumentos JSON de cada tool call. */
  toolArgumentLengths: number[];
  hadFinalContent: boolean;
  /** true si el contenido final valido contra DictamenLLMSchema. */
  schemaValid: boolean;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Parte de outputTokens gastada en razonamiento, cuando el proveedor la separa. */
  reasoningTokens: number;
  /** Costo reportado por el proveedor. 0 cuando el proveedor no lo informa. */
  estimatedCost: string;
  /** true solo si el numero vino del proveedor y no de una estimacion nuestra. */
  costReportedByProvider: boolean;
}

export interface AgentAnalysisResult {
  /** Candidato del modelo. null cuando el loop fallo de forma controlada. */
  candidato: DictamenLLM | null;
  /** Politicas recuperadas por herramienta durante el run. */
  politicasRecuperadas: FragmentoPoliticaEnriquecido[];
  /**
   * Ids que el modelo tenia efectivamente a la vista (corpus inyectado mas lo
   * recuperado). Es contra esto que G1 juzga si una cita vino de evidencia.
   */
  politicasDisponibles: string[];
  /** Modelo que realmente respondio, si el proveedor lo informa. */
  resolvedModel: string | null;
  /**
   * finish_reason de la ultima respuesta: 'stop', 'length', 'tool_calls'...
   * Es lo que permite separar una salida invalida de una generacion truncada.
   */
  lastFinishReason: string | null;
  toolCalls: AgentToolCallRecord[];
  /** Una entrada por llamada al proveedor. Solo metadata. */
  iterationDiagnostics: AgentIterationDiagnostic[];
  usage: AgentUsage;
  iterations: number;
  latencyMs: number;
  /** Se intento una unica reparacion estructurada. */
  repairAttempted: boolean;
  repairSucceeded: boolean;
  /** Presente cuando el loop termino por un fallo controlado. */
  failure?: { code: AgentFailureCode; message: string };
}

/**
 * Emisor de eventos de progreso. Recibe eventos ya seguros para mostrar en UI:
 * progreso, acciones y fuentes. Nunca razonamiento ni contenido interno.
 */
export type AgentEventEmitter = (evento: {
  type: string;
  label?: string;
  data?: Record<string, unknown>;
}) => void;

export interface AgentExecutionOptions {
  signal?: AbortSignal;
  onEvent?: AgentEventEmitter;
}

/**
 * Seam de proveedor. `DirectOpenRouterAgentProvider` contiene nuestro loop
 * explicito; un futuro `MastraAgentProvider` traeria el suyo. Lo que queda
 * FUERA de esta interfaz, y por lo tanto identico para cualquier proveedor,
 * es todo lo que tiene autoridad: guardarrailes, datos autoritativos,
 * idempotencia y persistencia.
 */
export interface AgentProvider {
  readonly name: string;
  readonly model: string;
  /** Semilla de inferencia enviada al proveedor, si el flujo la usa. */
  readonly inferenceSeed?: number | null;
  analyze(input: AgentAnalysisInput, options?: AgentExecutionOptions): Promise<AgentAnalysisResult>;
}
