import { Decimal, d, toMoney, type Solicitud } from '@credit/contracts';
import { fail, ok, type GuardrailFinding, type GuardrailOutcome } from './types.js';

/**
 * G3 — Topes de politica.
 *
 * `max_allowed_amount` se calcula en el backend a partir de los topes vigentes
 * y se persiste EN LA MISMA FILA del dictamen, porque un CHECK de PostgreSQL no
 * puede consultar otras tablas. Los CHECK sobre esa columna son la segunda capa.
 */

/** Topes derivados del corpus (POL-6.1, POL-5.2, POL-4.1, POL-4.3, POL-2.4). */
export const TOPE_GENERAL = '500000.00';
export const TOPE_CONSTRUCCION = '300000.00';
export const TOPE_SIN_GARANTIA = '50000.00';
export const TOPE_FIDUCIARIA = '150000.00';
/** POL-2.4: el monto no debe exceder el 50% de las ventas anuales. */
export const FRACCION_MAXIMA_VENTAS = '0.50';

export interface TopeCalculado {
  maxAllowedAmount: string;
  aplicados: Array<{ politica: string; tope: string }>;
}

/**
 * Calcula el tope autoritativo. Es una funcion pura del estado de la solicitud;
 * ni el modelo ni `destino_fondos` participan.
 */
export function calcularTopeAutoritativo(solicitud: Solicitud): TopeCalculado {
  const candidatos: Array<{ politica: string; tope: Decimal }> = [
    { politica: 'POL-6.1', tope: d(TOPE_GENERAL) },
    { politica: 'POL-6.2', tope: d(solicitud.monto_solicitado) },
  ];

  if (solicitud.sector === 'construccion') {
    candidatos.push({ politica: 'POL-5.2', tope: d(TOPE_CONSTRUCCION) });
  }
  if (solicitud.garantia_ofrecida === 'ninguna') {
    candidatos.push({ politica: 'POL-4.3', tope: d(TOPE_SIN_GARANTIA) });
  }
  if (solicitud.garantia_ofrecida === 'fiduciaria') {
    candidatos.push({ politica: 'POL-4.2', tope: d(TOPE_FIDUCIARIA) });
  }

  const ventas = d(solicitud.ventas_anuales);
  if (ventas.gt(0)) {
    candidatos.push({ politica: 'POL-2.4', tope: ventas.mul(FRACCION_MAXIMA_VENTAS) });
  }

  let minimo = candidatos[0]!.tope;
  for (const c of candidatos) if (c.tope.lt(minimo)) minimo = c.tope;

  return {
    maxAllowedAmount: toMoney(minimo),
    aplicados: candidatos.map((c) => ({ politica: c.politica, tope: toMoney(c.tope) })),
  };
}

export interface AmountCheckInput {
  montoRecomendado: string | null;
  montoSolicitado: string;
  maxAllowedAmount: string;
}

export function verificarTopes(input: AmountCheckInput): GuardrailOutcome {
  if (input.montoRecomendado === null) return ok();

  const findings: GuardrailFinding[] = [];
  const recomendado = d(input.montoRecomendado);

  if (recomendado.lte(0)) {
    findings.push({
      guardrail: 'G3',
      code: 'AMOUNT_NOT_POSITIVE',
      message: 'El monto recomendado debe ser mayor que cero',
      details: { monto_recomendado: input.montoRecomendado },
    });
  }
  if (recomendado.gt(d(input.montoSolicitado))) {
    findings.push({
      guardrail: 'G3',
      code: 'AMOUNT_EXCEEDS_REQUESTED',
      message: 'El monto recomendado excede el monto solicitado',
      details: { monto_recomendado: input.montoRecomendado, monto_solicitado: input.montoSolicitado },
    });
  }
  if (recomendado.gt(d(input.maxAllowedAmount))) {
    findings.push({
      guardrail: 'G3',
      code: 'AMOUNT_EXCEEDS_POLICY_CAP',
      message: 'El monto recomendado excede el tope de politica aplicable',
      details: { monto_recomendado: input.montoRecomendado, max_allowed_amount: input.maxAllowedAmount },
    });
  }

  // Exceder un tope no se "corrige" reduciendo el monto en silencio: se rechaza
  // la persistencia y el caso queda para el analista.
  return findings.length > 0 ? fail(findings, false) : ok();
}
