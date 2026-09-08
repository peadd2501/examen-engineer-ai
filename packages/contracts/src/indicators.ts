import { z } from 'zod';
import { nullableRatioString } from './money.js';

/**
 * Indicadores financieros. Se calculan SIEMPRE en codigo con decimal.js,
 * nunca por el LLM. `null` significa "no calculable con los datos dados"
 * (por ejemplo denominador cero), no cero.
 */
export const IndicadoresSchema = z.object({
  id_solicitud: z.string().uuid(),
  /** pasivos_totales / activos_totales */
  razon_endeudamiento: nullableRatioString,
  /** utilidad_neta / ventas_anuales */
  margen_neto: nullableRatioString,
  /** utilidad_neta / (cuota_anual_estimada + deuda_vigente_anual) */
  cobertura_servicio_deuda: nullableRatioString,
  /** monto_solicitado / ventas_anuales */
  relacion_monto_ventas: nullableRatioString,
  /** meses_operacion (se replica aqui para que el agente reciba un bloque unico) */
  antiguedad_meses: z.number().int().min(0),
  /** cuota anual estimada del nuevo credito, derivada (amortizacion lineal simple) */
  cuota_anual_estimada: nullableRatioString,
  calculation_version: z.number().int(),
  /** Banderas de inconsistencia detectadas de forma determinista */
  anomalias: z.array(z.string()).default([]),
});
export type Indicadores = z.infer<typeof IndicadoresSchema>;
