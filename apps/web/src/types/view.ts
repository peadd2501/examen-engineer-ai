import type {
  AgentEvent,
  Confirmacion,
  Dictamen,
  Indicadores,
  MetricasCartera,
  Solicitud,
} from '@credit/contracts';

/**
 * Tipos de la UI. Los contratos del backend se reutilizan tal cual desde
 * @credit/contracts; aqui solo vive lo que es estado de interfaz.
 */

export interface CitaPolitica {
  id_politica: string;
  seccion: string;
  texto_literal: string;
}

/** Fila del listado. Es lo que devuelve GET /api/applications. */
export type SolicitudResumen = Solicitud;

export interface AnalisisUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCost: string;
  costReportedByProvider: boolean;
}

/**
 * Resultado del analisis.
 *
 * Los campos de ejecucion son nullables a proposito: al restaurar un dictamen
 * persistido esa metadata pertenece al `agent_run`. Si no esta disponible se
 * muestra N/D, nunca un cero inventado.
 */
export interface AnalisisResultado {
  /** null cuando el dictamen se restauro y no tiene run asociado. */
  runId: string | null;
  confirmacion: Confirmacion | null;
  dictamen: (Dictamen & { politicas_citadas: CitaPolitica[] }) | null;
  politicasRecuperadas: Array<{ id_politica: string; seccion: string; categoria: string; incluido_por_relacion: boolean }>;
  findings: Array<{ guardrail: string; code: string; message: string; details?: unknown }>;
  usage: AnalisisUsage | null;
  latencyMs: number | null;
  /** null = no se conoce la secuencia; [] = se conoce y estuvo vacia. */
  toolSequence: string[] | null;
  resolvedModel: string | null;
  lastFinishReason: string | null;
  iterationDiagnostics: Array<{
    iteration: number;
    finishReason: string | null;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    contentLengthChars: number;
    toolCallCount: number;
    toolNames: string[];
    toolArgumentLengths: number[];
    hadFinalContent: boolean;
    schemaValid: boolean;
  }>;
  failure?: { code: string; message: string };
}

export type EstadoAnalisis = 'idle' | 'corriendo' | 'completado' | 'error' | 'cancelado';

export interface ErrorAnalisis {
  code: string;
  mensaje: string;
  detalle?: string;
}

export type { AgentEvent, Dictamen, Indicadores, MetricasCartera, Solicitud };
