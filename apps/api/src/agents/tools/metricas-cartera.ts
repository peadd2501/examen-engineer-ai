import { z } from 'zod';
import { MetricFiltersSchema, MetricasCarteraSchema, SECTORES, toMoney } from '@credit/contracts';
import { defineTool } from './registry.js';

interface CountRow { k: string; n: string }

export const metricasCarteraTool = defineTool({
  name: 'metricas_cartera',
  description:
    'Devuelve metricas agregadas de la cartera: solicitudes procesadas por decision y por estado ' +
    'operativo, monto promedio recomendado, tasa de escalamiento y tasa de autorizaciones pendientes.',
  input: MetricFiltersSchema,
  output: MetricasCarteraSchema,
  exposedToModel: true,
  parameters: {
    type: 'object',
    properties: {
      desde: { type: 'string', description: 'Fecha inicial YYYY-MM-DD' },
      hasta: { type: 'string', description: 'Fecha final YYYY-MM-DD' },
      sector: { type: 'string', enum: [...SECTORES] },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const cond: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      cond.push(sql.replace('$n', `$${params.length}`));
    };
    if (args.desde) add('a.application_date >= $n', args.desde);
    if (args.hasta) add('a.application_date <= $n', args.hasta);
    if (args.sector) add('a.sector = $n', args.sector);
    const where = cond.length > 0 ? `WHERE ${cond.join(' AND ')}` : '';

    const totalSolicitudes = Number(
      (await ctx.pool.query<{ n: string }>(`SELECT count(*)::text n FROM applications a ${where}`, params)).rows[0]?.n ?? '0',
    );

    const joinWhere = where.replace('WHERE', 'WHERE').trim();
    const base = `FROM decisions d JOIN applications a ON a.id = d.application_id ${joinWhere}`;

    const totalDictamenes = Number(
      (await ctx.pool.query<{ n: string }>(`SELECT count(*)::text n ${base}`, params)).rows[0]?.n ?? '0',
    );

    const porDecision: Record<string, number> = {};
    for (const r of (await ctx.pool.query<CountRow>(`SELECT d.decision::text k, count(*)::text n ${base} GROUP BY 1`, params)).rows) {
      porDecision[r.k] = Number(r.n);
    }

    const porEstado: Record<string, number> = {};
    for (const r of (await ctx.pool.query<CountRow>(`SELECT d.operational_status::text k, count(*)::text n ${base} GROUP BY 1`, params)).rows) {
      porEstado[r.k] = Number(r.n);
    }

    const promedio = (
      await ctx.pool.query<{ avg: string | null }>(
        `SELECT avg(d.recommended_amount)::text avg ${base} ${joinWhere ? 'AND' : 'WHERE'} d.recommended_amount IS NOT NULL`,
        params,
      )
    ).rows[0]?.avg ?? null;

    const escalados = porDecision['ESCALADO_A_COMITE'] ?? 0;
    const pendientes = porEstado['PENDING_AUTHORIZATION'] ?? 0;

    return MetricasCarteraSchema.parse({
      total_solicitudes: totalSolicitudes,
      total_dictamenes: totalDictamenes,
      por_decision: porDecision,
      por_estado_operativo: porEstado,
      monto_promedio_recomendado: promedio === null ? null : toMoney(promedio),
      tasa_escalamiento: totalDictamenes === 0 ? 0 : escalados / totalDictamenes,
      tasa_autorizacion_pendiente: totalDictamenes === 0 ? 0 : pendientes / totalDictamenes,
    });
  },
});
