import { z } from 'zod';
import { DecisionSchema, SectorSchema } from './enums.js';
import { moneyString } from './money.js';

export const MetricFiltersSchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sector: SectorSchema.optional(),
});
export type MetricFilters = z.infer<typeof MetricFiltersSchema>;

export const MetricasCarteraSchema = z.object({
  total_solicitudes: z.number().int(),
  total_dictamenes: z.number().int(),
  por_decision: z.record(DecisionSchema, z.number().int()),
  por_estado_operativo: z.record(z.string(), z.number().int()),
  monto_promedio_recomendado: moneyString.nullable(),
  tasa_escalamiento: z.number().min(0).max(1),
  tasa_autorizacion_pendiente: z.number().min(0).max(1),
});
export type MetricasCartera = z.infer<typeof MetricasCarteraSchema>;
