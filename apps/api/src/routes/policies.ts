import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CategoriaPoliticaSchema } from '@credit/contracts';
import { pool } from '../infrastructure/db.js';
import { buscarPoliticaDetallado } from '../infrastructure/policy-search.js';

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  top_k: z.coerce.number().int().min(1).max(20).default(5),
  categoria: CategoriaPoliticaSchema.optional(),
});

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  /** Endpoint de inspeccion manual del retrieval. La tool del agente llega en FASE 3. */
  app.get('/api/policies/search', async (request) => {
    const { q, top_k, categoria } = SearchQuerySchema.parse(request.query);
    const resultados = await buscarPoliticaDetallado(pool, q, top_k, categoria ? { categoria } : {});
    return {
      consulta: q,
      top_k,
      categoria: categoria ?? null,
      total: resultados.length,
      sin_politica_aplicable: resultados.length === 0,
      resultados,
    };
  });

  app.get('/api/policies', async () => {
    const { rows } = await pool.query(
      'SELECT id, section, category, severity, version, active FROM policies ORDER BY id',
    );
    return { total: rows.length, items: rows };
  });
}
