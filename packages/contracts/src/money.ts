import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Configuracion global de Decimal.
 * ROUND_HALF_EVEN evita sesgo acumulado al redondear montos.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -21, toExpPos: 34 });

export { Decimal };

export const MONEY_SCALE = 2;
export const RATIO_SCALE = 6;

export type DecimalInput = string | number | Decimal;

/** Constructor tolerante. Lanza si el valor no es numerico finito. */
export function d(value: DecimalInput): Decimal {
  const dec = value instanceof Decimal ? value : new Decimal(String(value).trim());
  if (!dec.isFinite()) throw new RangeError(`Valor decimal no finito: ${String(value)}`);
  return dec;
}

/** Division segura: null cuando el denominador es 0 o no valido (dato incompleto). */
export function safeDiv(numerator: DecimalInput, denominator: DecimalInput): Decimal | null {
  const den = d(denominator);
  if (den.isZero()) return null;
  const result = d(numerator).div(den);
  return result.isFinite() ? result : null;
}

/** Serializa a string con escala fija. Es el unico formato que cruza la frontera API/DB. */
export function toMoney(value: DecimalInput): string {
  return d(value).toFixed(MONEY_SCALE);
}

export function toRatio(value: DecimalInput): string {
  return d(value).toFixed(RATIO_SCALE);
}

export function toRatioOrNull(value: Decimal | null): string | null {
  return value === null ? null : toRatio(value);
}

/**
 * Comparacion usada por G2 (coherencia numerica).
 * Compara a la escala de ratio; no usa igualdad de punto flotante.
 */
export function ratiosEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return d(a).toFixed(RATIO_SCALE) === d(b).toFixed(RATIO_SCALE);
}

export function moneyEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return d(a).toFixed(MONEY_SCALE) === d(b).toFixed(MONEY_SCALE);
}

/** Zod: monto monetario transportado como string decimal (nunca number). */
export const moneyString = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return toMoney(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'monto decimal invalido' });
      return z.NEVER;
    }
  });

export const ratioString = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return toRatio(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ratio decimal invalido' });
      return z.NEVER;
    }
  });

export const nullableRatioString = z.union([ratioString, z.null()]);
export const nullableMoneyString = z.union([moneyString, z.null()]);
