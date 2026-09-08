import type { Pool } from 'pg';
import type { AgentAnalysisInput, AgentAnalysisResult, AgentExecutionOptions, AgentProvider } from './agent-provider.js';
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from './agent-limits.js';
import { ejecutarAgentLoop } from './agent-orchestrator.js';
import { OpenRouterClient, type OpenRouterConfig } from './openrouter-client.js';
import type { ToolRegistry } from './tools/registry.js';

/**
 * Proveedor por defecto: acceso directo a OpenRouter con nuestro propio agent
 * loop. Se eligio sobre Mastra para conservar control explicito sobre el
 * contenido del contexto, la allowlist de herramientas, los limites, el
 * structured output y la observabilidad.
 *
 * Un futuro MastraAgentProvider implementaria esta misma interfaz con su
 * propio loop; los guardarrailes y la persistencia quedan fuera y no cambian.
 */
export class DirectOpenRouterAgentProvider implements AgentProvider {
  readonly name = 'direct-openrouter';
  readonly inferenceSeed: number | null;
  private readonly client: OpenRouterClient;

  constructor(
    config: OpenRouterConfig,
    private readonly pool: Pool,
    private readonly registry: ToolRegistry,
    private readonly limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  ) {
    this.client = new OpenRouterClient(config);
    this.inferenceSeed = config.seed ?? null;
  }

  get model(): string {
    return this.client.model;
  }

  analyze(input: AgentAnalysisInput, options: AgentExecutionOptions = {}): Promise<AgentAnalysisResult> {
    return ejecutarAgentLoop(
      {
        pool: this.pool,
        registry: this.registry,
        limits: this.limits,
        chat: (request, signal) => this.client.chat(request, signal),
      },
      input,
      options.signal,
      options.onEvent,
    );
  }
}
