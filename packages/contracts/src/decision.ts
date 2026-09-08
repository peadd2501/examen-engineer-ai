import { z } from 'zod';
import { nullableMoneyString, moneyString } from './money.js';
import { DecisionSchema, NivelRiesgoSchema, OperationalStatusSchema } from './enums.js';
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
 * Version relajada que se pide al modelo: sin `indicadores` (los inyecta el backend)
 * y sin `id_solicitud` libre. Reduce la superficie de alucinacion numerica.
 */
export const DictamenLLMSchema = z.object({
  decision: DecisionSchema,
  monto_recomendado: nullableMoneyString,
  plazo_recomendado_meses: z.number().int().min(1).max(120).nullable(),
  politicas_citadas: z.array(CitaPoliticaSchema),
  motivos: z.array(z.string().min(1)).min(1).max(10),
  nivel_riesgo: NivelRiesgoSchema,
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
