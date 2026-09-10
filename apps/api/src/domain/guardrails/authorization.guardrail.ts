import {
  HUMAN_AUTHORIZATION_THRESHOLD_GTQ,
  d,
  type Decision,
  type NivelRiesgo,
  type OperationalStatus,
} from '@credit/contracts';
import { fail, ok, type GuardrailFinding, type GuardrailOutcome } from './types.js';

/**
 * G4 — Autorizacion humana.
 *
 * La regla es del backend, no del modelo: si el monto recomendado supera
 * Q250,000.00 o el riesgo es ALTO, el dictamen no puede nacer firme. Lo que el
 * modelo puso en `requiere_autorizacion_humana` se ignora y se recalcula aqui.
 */
export function requiereAutorizacionHumana(montoRecomendado: string | null, nivelRiesgo: NivelRiesgo): boolean {
  if (nivelRiesgo === 'ALTO') return true;
  if (montoRecomendado === null) return false;
  return d(montoRecomendado).gt(d(HUMAN_AUTHORIZATION_THRESHOLD_GTQ));
}

/**
 * Comite y autorizacion humana son flujos distintos:
 *   ESCALADO_A_COMITE -> PENDING_COMMITTEE. No hay recomendacion que autorizar;
 *   resuelve el comite, desde cero.
 *   requiere_autorizacion_humana -> PENDING_AUTHORIZATION. Hay recomendacion
 *   firme y necesita firma humana antes de surtir efecto.
 *
 * Mezclarlos producia escalamientos marcados como pendientes de autorizacion. No
 * debilita G4: la unica ruta hacia CONFIRMED sigue siendo PENDING_AUTHORIZATION.
 */
export interface ResolucionAutorizacion {
  requiereAutorizacion: boolean;
  estadoOperativo: OperationalStatus;
}

export function resolverAutorizacion(
  decision: Decision,
  montoRecomendado: string | null,
  nivelRiesgo: NivelRiesgo,
): ResolucionAutorizacion {
  if (decision === 'ESCALADO_A_COMITE') {
    return { requiereAutorizacion: false, estadoOperativo: 'PENDING_COMMITTEE' };
  }
  const requiereAutorizacion = requiereAutorizacionHumana(montoRecomendado, nivelRiesgo);
  return {
    requiereAutorizacion,
    estadoOperativo: requiereAutorizacion ? 'PENDING_AUTHORIZATION' : 'GENERATED',
  };
}

export interface AuthorizationCheckInput {
  montoRecomendado: string | null;
  nivelRiesgo: NivelRiesgo;
  decision: Decision;
  requiereAutorizacionPropuesta: boolean;
  estadoOperativo: OperationalStatus;
}

export function verificarAutorizacion(input: AuthorizationCheckInput): GuardrailOutcome {
  const findings: GuardrailFinding[] = [];
  const resuelto = resolverAutorizacion(input.decision, input.montoRecomendado, input.nivelRiesgo);

  if (resuelto.requiereAutorizacion && !input.requiereAutorizacionPropuesta) {
    findings.push({
      guardrail: 'G4',
      code: 'AUTHORIZATION_FLAG_OVERRIDDEN',
      message: 'El dictamen requiere autorizacion humana y el modelo no lo marco; se corrige en backend',
      details: { monto_recomendado: input.montoRecomendado, nivel_riesgo: input.nivelRiesgo },
    });
  }
  if (input.estadoOperativo === 'CONFIRMED') {
    return fail(
      [{ guardrail: 'G4', code: 'CONFIRMED_WITHOUT_HUMAN', message: 'Ningun dictamen puede nacer CONFIRMED' }],
      false,
    );
  }
  if (input.estadoOperativo !== resuelto.estadoOperativo) {
    return fail(
      [{
        guardrail: 'G4',
        code: 'INVALID_OPERATIONAL_STATUS',
        message: `Estado operativo invalido (${input.estadoOperativo}); corresponde ${resuelto.estadoOperativo}`,
        details: { decision: input.decision, esperado: resuelto.estadoOperativo, recibido: input.estadoOperativo },
      }],
      false,
    );
  }

  // Los findings restantes son correcciones aplicadas, no bloqueos.
  return findings.length > 0 ? { passed: true, findings, forceEscalation: false } : ok();
}
