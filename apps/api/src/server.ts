import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config, safeConfigSnapshot } from './config.js';
import { errorHandler } from './infrastructure/error-mapper.js';
import { pool } from './infrastructure/db.js';
import { healthRoutes } from './routes/health.js';
import { applicationRoutes } from './routes/applications.js';
import { policyRoutes } from './routes/policies.js';
import { agentRoutes, agentStreamRoutes } from './routes/agent.js';
import { decisionRoutes } from './routes/decisions.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // No imprimir secretos ni cabeceras de autorizacion.
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.apiKey',
        '*.api_key',
        // El razonamiento del modelo no se registra en logs.
        '*.reasoning_details',
        '*.reasoning',
      ],
    },
  });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()) });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Ruta no encontrada: ${request.method} ${request.url}` },
    });
  });

  await app.register(healthRoutes);
  await app.register(applicationRoutes);
  await app.register(policyRoutes);
  await app.register(agentRoutes);
  await app.register(agentStreamRoutes);
  await app.register(decisionRoutes);

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    app.log.info(safeConfigSnapshot(), 'API lista');
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} recibido, cerrando`);
      void app.close().then(() => process.exit(0));
    });
  }
}

start();
