import type { Pool } from 'pg';
import { config } from '../config.js';
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from './agent-limits.js';
import type { AgentProvider } from './agent-provider.js';
import { DirectOpenRouterAgentProvider } from './direct-openrouter-provider.js';
import { buscarPoliticaTool } from './tools/buscar-politica.js';
import { calcularIndicadoresTool } from './tools/calcular-indicadores.js';
import { metricasCarteraTool } from './tools/metricas-cartera.js';
import { obtenerSolicitudTool } from './tools/obtener-solicitud.js';
import { registrarDictamenTool } from './tools/registrar-dictamen.js';
import { buildRegistry, type ToolRegistry } from './tools/registry.js';

export * from './agent-provider.js';
export * from './agent-limits.js';
export { DirectOpenRouterAgentProvider } from './direct-openrouter-provider.js';
export { ScriptedAgentProvider } from './scripted-provider.js';
export { ejecutarAgentLoop } from './agent-orchestrator.js';
export * from './tools/registry.js';

/**
 * Las cinco capacidades del enunciado.
 *
 * `registrar_dictamen` esta presente como herramienta —con su esquema, su
 * validacion y su registro en tool_calls— pero con `exposedToModel: false`:
 * no viaja al proveedor y el loop rechaza ejecutarla si el modelo la nombra.
 * La invoca el backend despues de los guardarrailes. Ver engineering-notes.
 */
export function buildToolRegistry(): ToolRegistry {
  return buildRegistry([
    obtenerSolicitudTool,
    calcularIndicadoresTool,
    buscarPoliticaTool,
    metricasCarteraTool,
    registrarDictamenTool,
  ]);
}

/** SEED del proyecto como entero, o null si no es convertible. */
export function semillaDeInferencia(): number | null {
  const n = Number.parseInt(config.SEED, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
}

/**
 * Fabrica del proveedor. Falla de forma ruidosa si no hay API key: un sistema
 * que "funciona" sin proveedor configurado esconde el problema real.
 */
export function buildAgentProvider(pool: Pool, limits: AgentLimits = DEFAULT_AGENT_LIMITS): AgentProvider {
  if (config.AGENT_PROVIDER !== 'direct') {
    throw new ProviderNotConfiguredError(
      `AGENT_PROVIDER=${config.AGENT_PROVIDER} no esta implementado. Solo 'direct' esta disponible.`,
    );
  }
  if (!config.OPENROUTER_API_KEY) {
    throw new ProviderNotConfiguredError(
      'Falta OPENROUTER_API_KEY. Configurala en .env (formato: sk-or-v1-...).',
    );
  }
  return new DirectOpenRouterAgentProvider(
    {
      apiKey: config.OPENROUTER_API_KEY,
      baseUrl: config.OPENROUTER_BASE_URL,
      model: config.OPENROUTER_MODEL,
      timeoutMs: limits.providerTimeoutMs,
      reasoningEffort: config.OPENROUTER_REASONING_EFFORT,
      // La semilla sale del SEED del proyecto, el mismo que hace reproducible
      // el dataset. No es un literal, y si SEED no es entero simplemente no se
      // envia: no se inventa un valor.
      ...(semillaDeInferencia() !== null ? { seed: semillaDeInferencia() as number } : {}),
    },
    pool,
    buildToolRegistry(),
    limits,
  );
}
