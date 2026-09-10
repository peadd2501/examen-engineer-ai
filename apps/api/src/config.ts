import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as cargarEnv } from 'dotenv';
import { z } from 'zod';

/**
 * `pnpm dev` arranca la API con cwd en apps/api, asi que `dotenv/config` a
 * secas no encuentra el .env del monorepo. Se cargan los dos: primero el del
 * directorio actual (si existe) y despues el de la raiz. dotenv no sobreescribe
 * variables ya definidas, asi que lo mas especifico gana.
 */
const raizMonorepo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
cargarEnv();
cargarEnv({ path: resolve(raizMonorepo, '.env') });

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  API_PORT: z.coerce.number().int().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  SEED: z.string().default('20260907'),
  // FASE 3. Opcionales aqui a proposito: la API arranca sin proveedor LLM.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
  AGENT_PROVIDER: z.enum(['direct', 'mastra']).default('direct'),
  /**
   * Esfuerzo de razonamiento que se pide al proveedor.
   *
   * 'none' PIDE explicitamente que no razone; 'off' omite el campo, para modelos
   * que no lo soportan. Son cosas distintas: instruccion contra silencio. No se
   * decide por modelo en codigo: es configuracion.
   */
  OPENROUTER_REASONING_EFFORT: z.enum(['off', 'none', 'low', 'medium', 'high']).default('none'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuracion invalida:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;

/** Nunca loguear secretos: helper para exponer configuracion de forma segura. */
export function safeConfigSnapshot() {
  return {
    api_port: config.API_PORT,
    log_level: config.LOG_LEVEL,
    agent_provider: config.AGENT_PROVIDER,
    model: config.OPENROUTER_MODEL,
    reasoning_effort: config.OPENROUTER_REASONING_EFFORT,
    llm_configured: Boolean(config.OPENROUTER_API_KEY),
    seed: config.SEED,
  };
}
