import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AutorizacionInputSchema, MetricFiltersSchema } from '@credit/contracts';
import { autorizarDictamen } from '../application/authorize-decision.js';
import { metricasCarteraTool } from '../agents/tools/metricas-cartera.js';
import { pool } from '../infrastructure/db.js';

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/decisions/:id/authorize', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = AutorizacionInputSchema.parse({ ...(request.body as object), id_dictamen: id });
    return autorizarDictamen(pool, body);
  });

  app.get('/api/decisions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query(
      `SELECT d.*, coalesce(json_agg(json_build_object(
                'id_politica', c.policy_id, 'seccion', c.section, 'texto_literal', c.literal_text)
              ) FILTER (WHERE c.id IS NOT NULL), '[]') AS citas
         FROM decisions d
         LEFT JOIN decision_policy_citations c ON c.decision_id = d.id
        WHERE d.id = $1
        GROUP BY d.id`,
      [id],
    );
    if (!rows[0]) return reply.status(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Dictamen no encontrado' } });
    return rows[0];
  });

  /** Ultimo dictamen de una solicitud. Permite reconstruir la vista al recargar. */
  app.get('/api/applications/:id/decision', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query(
      `SELECT d.*, coalesce(json_agg(json_build_object(
                'id_politica', c.policy_id, 'seccion', c.section, 'texto_literal', c.literal_text)
              ) FILTER (WHERE c.id IS NOT NULL), '[]') AS citas
         FROM decisions d
         LEFT JOIN decision_policy_citations c ON c.decision_id = d.id
        WHERE d.application_id = $1
        GROUP BY d.id
        ORDER BY d.created_at DESC
        LIMIT 1`,
      [id],
    );
    if (!rows[0]) return reply.status(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Sin dictamen para esta solicitud' } });
    return rows[0];
  });

  /**
   * Observabilidad de un run. Solo metadata segura: ni razonamiento, ni
   * contenido generado, ni prompt.
   */
  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query(
      `SELECT id, session_id, application_id, prompt_version, policy_corpus_version,
              indicator_calc_version, configured_model, resolved_model, provider,
              inference_seed, status, input_tokens, output_tokens, reasoning_tokens,
              latency_ms, estimated_cost, repair_attempted, last_finish_reason,
              error_code, error_message, started_at, finished_at
         FROM agent_runs WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return reply.status(404).send({ error: { code: 'RUN_NOT_FOUND', message: 'Run no encontrado' } });

    const { rows: iteraciones } = await pool.query(
      `SELECT iteration, finish_reason, input_tokens, output_tokens, reasoning_tokens,
              content_length_chars, tool_call_count, tool_names, tool_argument_lengths,
              had_final_content, schema_valid
         FROM agent_iterations WHERE agent_run_id = $1 ORDER BY iteration`,
      [id],
    );
    const { rows: tools } = await pool.query(
      `SELECT sequence, tool_name, status, latency_ms, error_message
         FROM tool_calls WHERE agent_run_id = $1 ORDER BY sequence`,
      [id],
    );
    const { rows: hallazgos } = await pool.query(
      `SELECT guardrail, code, message FROM guardrail_findings WHERE agent_run_id = $1 ORDER BY id`,
      [id],
    );

    return { run: rows[0], iteraciones, tool_calls: tools, hallazgos };
  });

  app.get('/api/metrics', async (request) => {
    const filtros = MetricFiltersSchema.parse(request.query);
    const { result } = await metricasCarteraTool.run(filtros, { pool, registrarPoliticas: () => undefined });
    return result;
  });
}
