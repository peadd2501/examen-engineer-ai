import { z } from 'zod';

/**
 * Veredicto del smoke test, aislado del transporte para poder probarlo sin red.
 *
 * Motivo: la version anterior imprimia "Structured output operativo" con solo
 * ver un HTTP 200. Con Liquid eso dio un falso PASS: el proveedor respondio 200
 * con finish_reason='length' y content=null. Un 200 significa que la peticion
 * fue aceptada, no que el modelo produjera algo utilizable.
 *
 * Para dar PASS tienen que cumplirse las tres cosas:
 *   1. hay contenido final,
 *   2. el finish_reason es compatible con una finalizacion exitosa,
 *   3. el contenido valida contra el esquema pedido.
 */

/** Esquema que el smoke le pide al modelo. Pequeno a proposito. */
export const SmokeSchema = z.object({
  ok: z.boolean(),
  modelo_respondio: z.string().min(1).max(50),
}).strict();

export type SmokeVerdictCode =
  | 'OK'
  /** finish_reason = 'length': la generacion se corto. */
  | 'TRUNCATED'
  /** Cerro sin contenido. */
  | 'NO_CONTENT'
  /** finish_reason que no corresponde a una finalizacion exitosa. */
  | 'UNEXPECTED_FINISH_REASON'
  /** Habia contenido pero no es JSON. */
  | 'INVALID_JSON'
  /** JSON valido que no cumple el esquema pedido. */
  | 'SCHEMA_MISMATCH';

export interface SmokeVerdict {
  ok: boolean;
  code: SmokeVerdictCode;
  motivo: string;
  /** Aviso que no invalida el resultado (por ejemplo, finish_reason ausente). */
  aviso?: string;
}

/**
 * finish_reason que indican que el modelo termino porque quiso, no porque lo
 * cortaron. Los nombres varian entre proveedores.
 */
const FINISH_EXITOSO = new Set(['stop', 'end_turn', 'eos', 'completed', 'finished']);

export interface SmokeInput {
  content: string | null | undefined;
  finishReason: string | null | undefined;
}

export function evaluarRespuestaSmoke(input: SmokeInput): SmokeVerdict {
  const finish = input.finishReason ?? null;

  // 1. Truncacion primero: aunque llegara contenido parcial, esta cortado.
  if (finish === 'length') {
    return {
      ok: false,
      code: 'TRUNCATED',
      motivo:
        "El proveedor corto la generacion (finish_reason='length'). " +
        'Sube max_tokens o baja OPENROUTER_REASONING_EFFORT.',
    };
  }

  // 2. Contenido final.
  const contenido = (input.content ?? '').trim();
  if (contenido === '') {
    return {
      ok: false,
      code: 'NO_CONTENT',
      motivo: `El proveedor cerro con finish_reason='${finish ?? 'ausente'}' sin devolver contenido.`,
    };
  }

  // 3. finish_reason compatible con finalizacion exitosa.
  if (finish !== null && !FINISH_EXITOSO.has(finish)) {
    return {
      ok: false,
      code: 'UNEXPECTED_FINISH_REASON',
      motivo: `finish_reason='${finish}' no corresponde a una finalizacion exitosa.`,
    };
  }

  // 4. El contenido tiene que ser JSON.
  let json: unknown;
  try {
    json = JSON.parse(contenido);
  } catch {
    return {
      ok: false,
      code: 'INVALID_JSON',
      motivo: `El contenido no es JSON valido (${contenido.length} caracteres).`,
    };
  }

  // 5. Y tiene que cumplir el esquema pedido.
  const parsed = SmokeSchema.safeParse(json);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      motivo: `El JSON no cumple el esquema pedido: ${detalle}`,
    };
  }

  return {
    ok: true,
    code: 'OK',
    motivo: 'Contenido final presente, finalizacion limpia y esquema respetado.',
    // Sin finish_reason no se puede confirmar como termino; el resto si valido.
    ...(finish === null ? { aviso: 'El proveedor no informo finish_reason.' } : {}),
  };
}
