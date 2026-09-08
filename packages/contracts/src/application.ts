import { z } from 'zod';
import { moneyString } from './money.js';
import { GarantiaSchema, SectorSchema } from './enums.js';

/**
 * Solicitud de credito. Los montos viajan como string decimal;
 * `number` queda prohibido para dinero (ver docs/engineering-notes.md).
 */
export const SolicitudSchema = z.object({
  id_solicitud: z.string().uuid(),
  nombre_empresa: z.string().min(1).max(200),
  sector: SectorSchema,
  meses_operacion: z.number().int().min(0).max(1200),
  monto_solicitado: moneyString,
  plazo_meses: z.number().int().min(1).max(120),
  /** ENTRADA NO CONFIABLE (G5). Nunca se interpola en instrucciones del sistema. */
  destino_fondos: z.string().max(2000),
  ventas_anuales: moneyString,
  utilidad_neta: moneyString,
  activos_totales: moneyString,
  pasivos_totales: moneyString,
  deuda_vigente_anual: moneyString,
  score_historial: z.number().int().min(0).max(100),
  garantia_ofrecida: GarantiaSchema,
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado YYYY-MM-DD'),
});
export type Solicitud = z.infer<typeof SolicitudSchema>;

/** Payload de creacion: el id lo genera el backend. */
export const NuevaSolicitudSchema = SolicitudSchema.omit({ id_solicitud: true });
export type NuevaSolicitud = z.infer<typeof NuevaSolicitudSchema>;

export const ListaSolicitudesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sector: SectorSchema.optional(),
});
export type ListaSolicitudesQuery = z.infer<typeof ListaSolicitudesQuerySchema>;
