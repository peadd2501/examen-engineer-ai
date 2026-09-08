import { z } from 'zod';
import { CategoriaPoliticaSchema, SeveridadSchema, TipoRelacionSchema } from './enums.js';

/** Fragmento devuelto por buscar_politica. Es el unico material citable. */
export const FragmentoPoliticaSchema = z.object({
  id_politica: z.string().min(1),
  seccion: z.string().min(1),
  texto_literal: z.string().min(1),
});
export type FragmentoPolitica = z.infer<typeof FragmentoPoliticaSchema>;

export const FragmentoPoliticaEnriquecidoSchema = FragmentoPoliticaSchema.extend({
  categoria: CategoriaPoliticaSchema,
  severidad: SeveridadSchema,
  score: z.number(),
  /** fraccion de lexemas de la consulta presentes en la politica (0..1) */
  cobertura: z.number().min(0).max(1),
  /** true cuando el fragmento entro por relacion regla<->excepcion, no por match textual */
  incluido_por_relacion: z.boolean().default(false),
  relacionado_con: z.array(z.string()).default([]),
});
export type FragmentoPoliticaEnriquecido = z.infer<typeof FragmentoPoliticaEnriquecidoSchema>;

export const PoliticaSchema = z.object({
  id: z.string().min(1),
  seccion: z.string().min(1),
  categoria: CategoriaPoliticaSchema,
  texto: z.string().min(1),
  severidad: SeveridadSchema,
  version: z.string().min(1),
  activa: z.boolean().default(true),
  vigente_desde: z.string(),
  vigente_hasta: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
export type Politica = z.infer<typeof PoliticaSchema>;

export const RelacionPoliticaSchema = z.object({
  source_policy_id: z.string().min(1),
  target_policy_id: z.string().min(1),
  relation_type: TipoRelacionSchema,
});
export type RelacionPolitica = z.infer<typeof RelacionPoliticaSchema>;

export const BuscarPoliticaInputSchema = z.object({
  consulta: z.string().min(1).max(500),
  top_k: z.number().int().min(1).max(20).default(5),
  categoria: CategoriaPoliticaSchema.optional(),
});
export type BuscarPoliticaInput = z.infer<typeof BuscarPoliticaInputSchema>;
