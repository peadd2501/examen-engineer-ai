import type { FastifyInstance } from 'fastify';
import { INDICATOR_CALC_VERSION, POLICY_CORPUS_VERSION, PROMPT_VERSION } from '@credit/contracts';
import { pingDatabase } from '../infrastructure/db.js';
import { safeConfigSnapshot } from '../config.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  app.get('/health/db', async (_request, reply) => {
    try {
      await pingDatabase();
      return { status: 'ok', database: 'up' };
    } catch (error) {
      return reply.status(503).send({
        status: 'degraded',
        database: 'down',
        message: error instanceof Error ? error.message : 'error desconocido',
      });
    }
  });

  app.get('/version', async () => ({
    prompt_version: PROMPT_VERSION,
    policy_corpus_version: POLICY_CORPUS_VERSION,
    indicator_calc_version: INDICATOR_CALC_VERSION,
    config: safeConfigSnapshot(),
  }));
}
