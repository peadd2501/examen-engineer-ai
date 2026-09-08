import { d, HUMAN_AUTHORIZATION_THRESHOLD_GTQ, type NivelRiesgo } from '@credit/contracts';

/**
 * G4 evaluado en codigo, no en el prompt:
 * un dictamen requiere autorizacion humana si el monto supera Q250,000
 * o si el nivel de riesgo es ALTO.
 */
export function requiereAutorizacionHumana(
  montoRecomendado: string | null,
  nivelRiesgo: NivelRiesgo,
): boolean {
  if (nivelRiesgo === 'ALTO') return true;
  if (montoRecomendado === null) return false;
  return d(montoRecomendado).gt(d(HUMAN_AUTHORIZATION_THRESHOLD_GTQ));
}
