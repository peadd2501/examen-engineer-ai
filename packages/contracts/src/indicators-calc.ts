import { Decimal, d, safeDiv, toRatio, toRatioOrNull } from './money.js';
import { INDICATOR_CALC_VERSION } from './versions.js';
import type { Solicitud } from './application.js';
import type { Indicadores } from './indicators.js';

/**
 * Calculo determinista de indicadores. Funcion pura, sin I/O.
 * Vive en @credit/contracts (y no en apps/api) porque la comparten
 * la API, el seed y el evaluation harness; es la unica fuente de verdad
 * numerica del sistema (ver docs/engineering-notes.md).
 */

/**
 * Cuota anual estimada del nuevo credito.
 * MVP: amortizacion lineal de capital, sin interes.
 *   cuota_anual = monto_solicitado * 12 / plazo_meses
 * Es determinista y auditable; incorporar tasa seria cambiar solo esta funcion
 * y subir INDICATOR_CALC_VERSION.
 */
export function cuotaAnualEstimada(montoSolicitado: string, plazoMeses: number): Decimal | null {
  if (plazoMeses <= 0) return null;
  return d(montoSolicitado).mul(12).div(plazoMeses);
}

export interface AnomaliaFinanciera {
  codigo: string;
  detalle: string;
}

/** Deteccion determinista de datos incompletos o inconsistentes. */
export function detectarAnomalias(s: Solicitud): AnomaliaFinanciera[] {
  const out: AnomaliaFinanciera[] = [];
  const ventas = d(s.ventas_anuales);
  const utilidad = d(s.utilidad_neta);
  const activos = d(s.activos_totales);
  const pasivos = d(s.pasivos_totales);
  const deuda = d(s.deuda_vigente_anual);

  if (ventas.lte(0)) out.push({ codigo: 'VENTAS_NO_POSITIVAS', detalle: 'ventas_anuales <= 0' });
  if (activos.lte(0)) out.push({ codigo: 'ACTIVOS_NO_POSITIVOS', detalle: 'activos_totales <= 0' });
  if (utilidad.gt(ventas)) out.push({ codigo: 'UTILIDAD_MAYOR_VENTAS', detalle: 'utilidad_neta > ventas_anuales' });
  if (pasivos.gt(activos)) out.push({ codigo: 'PASIVOS_MAYORES_ACTIVOS', detalle: 'pasivos_totales > activos_totales' });
  if (pasivos.lt(0)) out.push({ codigo: 'PASIVOS_NEGATIVOS', detalle: 'pasivos_totales < 0' });
  if (deuda.lt(0)) out.push({ codigo: 'DEUDA_NEGATIVA', detalle: 'deuda_vigente_anual < 0' });
  if (s.meses_operacion <= 0) out.push({ codigo: 'SIN_ANTIGUEDAD', detalle: 'meses_operacion <= 0' });
  return out;
}

export function calcularIndicadores(s: Solicitud): Indicadores {
  const cuota = cuotaAnualEstimada(s.monto_solicitado, s.plazo_meses);
  const servicioTotal = cuota === null ? null : cuota.plus(d(s.deuda_vigente_anual));

  const cobertura =
    servicioTotal === null || servicioTotal.isZero()
      ? null
      : safeDiv(s.utilidad_neta, servicioTotal);

  return {
    id_solicitud: s.id_solicitud,
    razon_endeudamiento: toRatioOrNull(safeDiv(s.pasivos_totales, s.activos_totales)),
    margen_neto: toRatioOrNull(safeDiv(s.utilidad_neta, s.ventas_anuales)),
    cobertura_servicio_deuda: toRatioOrNull(cobertura),
    relacion_monto_ventas: toRatioOrNull(safeDiv(s.monto_solicitado, s.ventas_anuales)),
    antiguedad_meses: s.meses_operacion,
    cuota_anual_estimada: cuota === null ? null : toRatio(cuota),
    calculation_version: INDICATOR_CALC_VERSION,
    anomalias: detectarAnomalias(s).map((a) => a.codigo),
  };
}
