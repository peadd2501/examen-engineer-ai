import type { Pool } from 'pg';
import type { AgentAnalysisInput, AgentAnalysisResult, AgentExecutionOptions, AgentProvider } from './agent-provider.js';
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from './agent-limits.js';
import { ejecutarAgentLoop, type ChatFn } from './agent-orchestrator.js';
import type { ToolRegistry } from './tools/registry.js';

/**
 * Proveedor con respuestas guionadas. Ejecuta EL MISMO agent loop, la misma
 * allowlist de herramientas y el mismo parseo de structured output; lo unico
 * que se sustituye es la llamada HTTP al modelo.
 *
 * Existe para probar de forma determinista lo que no debe depender del modelo:
 * guardarrailes, idempotencia, persistencia, limites del loop y clasificacion
 * de errores del proveedor.
 *
 * NO es un fallback de produccion. `buildAgentProvider` nunca lo devuelve; solo
 * lo instancian los tests y el harness cuando se le pide explicitamente.
 */
export class ScriptedAgentProvider implements AgentProvider {
  readonly name = 'scripted';
  readonly model = 'scripted/deterministic';
  readonly inferenceSeed = null;

  constructor(
    private readonly chat: ChatFn,
    private readonly pool: Pool,
    private readonly registry: ToolRegistry,
    private readonly limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  ) {}

  analyze(input: AgentAnalysisInput, options: AgentExecutionOptions = {}): Promise<AgentAnalysisResult> {
    return ejecutarAgentLoop(
      { pool: this.pool, registry: this.registry, limits: this.limits, chat: this.chat },
      input,
      options.signal,
      options.onEvent,
    );
  }
}
