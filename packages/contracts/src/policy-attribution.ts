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
 * Problema que resuelve (visto en CASE-07): el backend determina
 * correctamente que un monto recomendado de Q400,000 exige autorizacion
 * humana —eso es POL-8.1— y marca PENDING_AUTHORIZATION. Pero las citas del
 * dictamen salen exclusivamente de los `policy_ids` que devolvio el modelo, y
 * el modelo no cito POL-8.1: desde FASE 3.4 la autorizacion humana ni siquiera
 * forma parte de su esquema de salida, asi que no tenia por que mencionarla.
 * Resultado: la regla se aplica y la evidencia de esa regla no aparece.
 *
 * Principio: SI UNA CONDICION LA APLICA EL BACKEND DE FORMA DETERMINISTA, SU
 * EVIDENCIA NO PUEDE DEPENDER DE QUE EL MODELO SE ACUERDE DE CITARLA.
 *
 * La solucion es generica, no una regla por caso: cada evaluacion determinista
 * del sistema ya nombra la politica que la sustenta —`FactorRiesgo.politica`,
 * `MotivoSinCobertura.politica`— y aqui se recolectan todas. Una regla nueva que
 * respete esa convencion queda citada automaticamente, sin tocar este archivo.
 *
 * Estos identificadores NO son citas todavia: son referencias. El llamador las
 * hidrata desde la base igual que las del modelo, y pasan por G1 como todas las
 * demas. Aqui no se escribe texto de politica en ningun momento.
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
