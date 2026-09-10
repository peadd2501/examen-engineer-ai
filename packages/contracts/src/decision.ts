import { z } from 'zod';
import { nullableMoneyString, moneyString, toMoney } from './money.js';
import { DecisionSchema, NivelRiesgoSchema, OperationalStatusSchema } from './enums.js';
// NivelRiesgoSchema se sigue usando en DictamenSchema (el contrato final del
// examen lo exige); lo que cambia es quien lo produce.
import { IndicadoresSchema } from './indicators.js';
import { FragmentoPoliticaSchema } from './policy.js';

export const CitaPoliticaSchema = FragmentoPoliticaSchema;
export type CitaPolitica = z.infer<typeof CitaPoliticaSchema>;

/**
 * Structured output que debe producir el LLM.
 * Se valida con Zod ANTES de tocar guardarrailes o persistencia.
 */
export const DictamenSchema = z.object({
  id_solicitud: z.string().uuid(),
  decision: DecisionSchema,
  monto_recomendado: nullableMoneyString,
  plazo_recomendado_meses: z.number().int().min(1).max(120).nullable(),
  indicadores: IndicadoresSchema,
  politicas_citadas: z.array(CitaPoliticaSchema),
  motivos: z.array(z.string().min(1)).min(1).max(10),
  nivel_riesgo: NivelRiesgoSchema,
  requiere_autorizacion_humana: z.boolean(),
  confianza: z.number().min(0).max(1),
});
export type Dictamen = z.infer<typeof DictamenSchema>;

/**
 * Lo unico que el modelo produce. Diferencias con `Dictamen`: sin `indicadores`
 * —los inyecta el backend (G2)—, sin `id_solicitud` libre y **sin citas**.
 *
 * El modelo devuelve `policy_ids`, es decir REFERENCIAS a politicas existentes;
 * la terna citable la construye el backend leyendo el corpus. El motivo es
 * empirico: en la primera evaluacion real el modelo invento identificadores y
 * textos literales. Si no puede escribir el texto de una cita, no puede
 * alucinarla. G1 sigue activo como ultima defensa.
 */
/**
 * Limites de tamano de la salida del modelo.
 *
 * Un dictamen es pequeno, pero con Nemotron CASE-01 consumio los 5000 tokens sin
 * producirlo. Acotar el esquema le quita al modelo el espacio para divagar y hace
 * que una generacion descontrolada falle en la validacion en vez de agotar el
 * presupuesto en silencio. Los mismos numeros se replican en el JSON Schema.
 */
export const LIMITES_DICTAMEN_LLM = {
  MOTIVOS_MIN: 1,
  MOTIVOS_MAX: 5,
  MOTIVO_MAX_CHARS: 350,
  POLICY_IDS_MAX: 10,
  POLICY_ID_MAX_CHARS: 40,
  MONTO_MAX_CHARS: 24,
} as const;

/**
 * Monto tal como lo emite el modelo. Se acota la longitud ANTES de normalizar:
 * `moneyString` acepta cualquier cadena numerica, y una cadena de 4000 digitos
 * es una generacion descontrolada, no un monto.
 */
const montoDelModelo = z
  .union([z.string().max(LIMITES_DICTAMEN_LLM.MONTO_MAX_CHARS), z.number(), z.null()])
  .transform((v, ctx) => {
    if (v === null) return null;
    try {
      return toMoney(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'monto decimal invalido' });
      return z.NEVER;
    }
  });

export const DictamenLLMSchema = z.object({
  decision: DecisionSchema,
  monto_recomendado: montoDelModelo,
  plazo_recomendado_meses: z.number().int().min(1).max(120).nullable(),
  /** Identificadores de politicas del corpus. Nunca texto de politica. */
  policy_ids: z
    .array(z.string().min(1).max(LIMITES_DICTAMEN_LLM.POLICY_ID_MAX_CHARS))
    .max(LIMITES_DICTAMEN_LLM.POLICY_IDS_MAX)
    .default([]),
  motivos: z
    .array(z.string().min(1).max(LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS))
    .min(LIMITES_DICTAMEN_LLM.MOTIVOS_MIN)
    .max(LIMITES_DICTAMEN_LLM.MOTIVOS_MAX),
  // `nivel_riesgo` NO esta aqui a proposito: lo calcula el backend con
  // calcularNivelRiesgo(). Es el mismo tratamiento que los indicadores. En
  // CASE-09 el modelo devolvio ALTO sin respaldo del corpus y eso activo G4
  // sobre un dato inventado; un campo que decide si hace falta firma humana no
  // puede salir del modelo.
  confianza: z.number().min(0).max(1),
});
export type DictamenLLM = z.infer<typeof DictamenLLMSchema>;

/** Registro persistido. Añade lo que solo el backend puede afirmar. */
export const DictamenPersistidoSchema = DictamenSchema.extend({
  id: z.string().uuid(),
  operational_status: OperationalStatusSchema,
  requested_amount_snapshot: moneyString,
  max_allowed_amount: moneyString,
  idempotency_key: z.string().min(8).max(200),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
});
export type DictamenPersistido = z.infer<typeof DictamenPersistidoSchema>;

export const RegistrarDictamenInputSchema = z.object({
  id_solicitud: z.string().uuid(),
  dictamen: DictamenSchema,
  clave_idempotencia: z.string().min(8).max(200),
});
export type RegistrarDictamenInput = z.infer<typeof RegistrarDictamenInputSchema>;

export const ConfirmacionSchema = z.object({
  id_dictamen: z.string().uuid(),
  id_solicitud: z.string().uuid(),
  operational_status: OperationalStatusSchema,
  decision: DecisionSchema,
  requiere_autorizacion_humana: z.boolean(),
  /** true cuando la clave de idempotencia ya existia y se devolvio el registro original */
  reutilizado: z.boolean(),
  created_at: z.string(),
});
export type Confirmacion = z.infer<typeof ConfirmacionSchema>;

export const AutorizacionInputSchema = z.object({
  id_dictamen: z.string().uuid(),
  accion: z.enum(['CONFIRMAR', 'RECHAZAR']),
  analista: z.string().min(1).max(120).default('analista-demo'),
  comentario: z.string().max(1000).optional(),
});
export type AutorizacionInput = z.infer<typeof AutorizacionInputSchema>;
