import 'dotenv/config';
import { z } from 'zod';

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
    llm_configured: Boolean(config.OPENROUTER_API_KEY),
    seed: config.SEED,
  };
}
