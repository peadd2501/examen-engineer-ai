import type { Solicitud } from './application.js';
import type { Indicadores } from './indicators.js';
import type { NivelRiesgo } from './enums.js';
import { calcularNivelRiesgo } from './risk.js';
import { evaluarCobertura, type EvaluacionCobertura } from './coverage.js';
import { d } from './money.js';
import { HUMAN_AUTHORIZATION_THRESHOLD_GTQ } from './versions.js';

/**
 * ATRIBUCION — que politicas aplico el backend por su cuenta.
 *
 * Visto en CASE-07: el backend determina que un monto de Q400,000 exige
 * autorizacion humana —eso es POL-8.1— pero las citas salian exclusivamente de
 * los `policy_ids` del modelo, que no tenia por que mencionarla. Resultado: la
 * regla se aplica y su evidencia no aparece.
 *
 * Principio: si una condicion la aplica el backend de forma determinista, su
 * evidencia no puede depender de que el modelo se acuerde de citarla. La solucion
 * es generica, no una regla por caso: cada evaluacion determinista ya nombra su
 * politica (`FactorRiesgo.politica`, `MotivoSinCobertura.politica`) y aqui se
 * recolectan todas.
 *
 * No son citas todavia, son referencias: el llamador las hidrata desde la base y
 * pasan por G1 como las demas.
 */

export interface EntradaAtribucion {
  solicitud: Solicitud;
  indicadores: Indicadores;
  /** Monto recomendado FINAL, despues de topes y degradaciones. */
  montoRecomendado: string | null;
  /** Nivel de riesgo autoritativo del backend. */
  nivelRiesgo: NivelRiesgo;
  /** Cobertura ya evaluada. Se recalcula si no se pasa. */
  cobertura?: EvaluacionCobertura;
}

/** POL-8.1: autorizacion humana por monto. */
export const POLITICA_AUTORIZACION_POR_MONTO = 'POL-8.1';
/** POL-8.2: autorizacion humana por nivel de riesgo ALTO. */
export const POLITICA_AUTORIZACION_POR_RIESGO = 'POL-8.2';

/**
 * Identificadores de politica que el backend aplico determinísticamente.
 *
 * Devuelve referencias unicas y ordenadas. Vacio es un resultado legitimo: una
 * solicitud sin factores de riesgo, cubierta y por debajo del umbral de
 * autorizacion no activa ninguna regla automatica.
 */
export function politicasAplicadasPorBackend(entrada: EntradaAtribucion): string[] {
  const ids = new Set<string>();

  // 1. Factores que elevaron el nivel de riesgo (POL-3.2, POL-10.2, POL-10.3).
  const riesgo = calcularNivelRiesgo(entrada.solicitud, entrada.indicadores);
  for (const factor of riesgo.factores) ids.add(factor.politica);

  // 2. Ausencia de cobertura (POL-1.2, POL-6.1).
  const cobertura = entrada.cobertura ?? evaluarCobertura(entrada.solicitud);
  for (const motivo of cobertura.motivos) ids.add(motivo.politica);

  // 3. Autorizacion humana (POL-8.1 por monto, POL-8.2 por riesgo).
  //    Las mismas dos condiciones que evalua `requiereAutorizacionHumana`.
  if (entrada.nivelRiesgo === 'ALTO') ids.add(POLITICA_AUTORIZACION_POR_RIESGO);
  if (
    entrada.montoRecomendado !== null &&
    d(entrada.montoRecomendado).gt(d(HUMAN_AUTHORIZATION_THRESHOLD_GTQ))
  ) {
    ids.add(POLITICA_AUTORIZACION_POR_MONTO);
  }

  return [...ids].sort();
}
