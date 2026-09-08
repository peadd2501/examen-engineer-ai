import { DomainError } from '@credit/contracts';

/**
 * Limites explicitos del agent loop. Sin esto, una respuesta del modelo que
 * insiste en llamar herramientas produce un bucle infinito con costo real.
 */
export interface AgentLimits {
  maxIterations: number;
  maxToolCalls: number;
  providerTimeoutMs: number;
  totalExecutionTimeoutMs: number;
  maxOutputTokens: number;
  /**
   * Techo de salida de la reparacion por truncacion. Deliberadamente mas bajo
   * que el normal: un dictamen ocupa ~250 caracteres, y un techo estrecho es
   * parte del mensaje. Si aqui tambien se trunca, el problema no es el
   * presupuesto.
   */
  maxRepairOutputTokens: number;
  /**
   * Techo de la fase de finalizacion. El dictamen es pequeno; con function call
   * forzada el proveedor no tiene que producir prosa antes del objeto.
   */
  maxFinalizerOutputTokens: number;
}

/**
 * Valores ajustados con evidencia de la primera evaluacion real: el smoke test
 * contra un modelo gratuito tardo ~15 s por llamada y CASE-07 agoto los 60 s de
 * presupuesto total. Los limites de iteraciones y tool calls NO se tocaron: el
 * problema era latencia del proveedor, no un loop descontrolado.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxIterations: 8,
  maxToolCalls: 12,
  providerTimeoutMs: 45_000,
  totalExecutionTimeoutMs: 120_000,
  // 5000 tras la corrida con Dots3: dos casos terminaron con respuesta final
  // vacia por truncacion. El techo alto es una red de seguridad, no un objetivo:
  // con reasoning en 'low' el consumo real debe quedar muy por debajo, y por eso
  // se registran reasoning_tokens y finish_reason para poder comprobarlo.
  maxOutputTokens: 5_000,
  maxRepairOutputTokens: 1_400,
  maxFinalizerOutputTokens: 1_200,
};

export type AgentFailureCode =
  | 'MAX_ITERATIONS_EXCEEDED'
  | 'MAX_TOOL_CALLS_EXCEEDED'
  | 'PROVIDER_TIMEOUT'
  | 'TOTAL_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'AGENT_SCHEMA_VALIDATION_FAILED'
  | 'STRUCTURED_OUTPUT_UNSUPPORTED'
  /** El finalizer forzado no produjo un dictamen valido tras su unica reparacion. */
  | 'FINALIZER_FAILED'
  /** El proveedor rechazo reasoning.effort. Nunca se degrada en silencio. */
  | 'REASONING_EFFORT_UNSUPPORTED'
  /** Otro parametro de la peticion fue rechazado por el proveedor. */
  | 'PROVIDER_PARAMETER_REJECTED'
  /** finish_reason = 'length' y no hubo dictamen valido: se corto la generacion. */
  | 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
  /** El proveedor cerro normalmente pero no devolvio contenido. */
  | 'EMPTY_PROVIDER_RESPONSE'
  | 'CANCELLED';

/**
 * Fallo controlado del loop. `escalate` indica si el orquestador debe emitir un
 * dictamen ESCALADO_A_COMITE en lugar de propagar un error al cliente.
 */
export class AgentLoopError extends DomainError {
  constructor(
    readonly failure: AgentFailureCode,
    message: string,
    readonly escalate: boolean,
    details?: unknown,
  ) {
    super(message, failure, details);
  }
}

/** Reloj de pared del run completo, compartido por todas las iteraciones. */
export class ExecutionBudget {
  private readonly startedAt = Date.now();
  constructor(private readonly totalMs: number) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.totalMs - this.elapsedMs());
  }

  assertNotExhausted(): void {
    if (this.remainingMs() <= 0) {
      throw new AgentLoopError(
        'TOTAL_TIMEOUT',
        `Presupuesto total de ejecucion agotado (${this.totalMs} ms)`,
        true,
      );
    }
  }
}
