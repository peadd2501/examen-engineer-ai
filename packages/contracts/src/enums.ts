import { z } from 'zod';

export const SECTORES = [
  'comercio',
  'manufactura',
  'servicios',
  'agropecuario',
  'transporte',
  'construccion',
  'otros',
] as const;
export const SectorSchema = z.enum(SECTORES);
export type Sector = z.infer<typeof SectorSchema>;

export const GARANTIAS = ['ninguna', 'fiduciaria', 'prendaria', 'hipotecaria'] as const;
export const GarantiaSchema = z.enum(GARANTIAS);
export type Garantia = z.infer<typeof GarantiaSchema>;

export const DECISIONES = ['APROBADO', 'RECHAZADO', 'ESCALADO_A_COMITE'] as const;
export const DecisionSchema = z.enum(DECISIONES);
export type Decision = z.infer<typeof DecisionSchema>;

export const NIVELES_RIESGO = ['BAJO', 'MEDIO', 'ALTO'] as const;
export const NivelRiesgoSchema = z.enum(NIVELES_RIESGO);
export type NivelRiesgo = z.infer<typeof NivelRiesgoSchema>;

/**
 * Estado operativo, separado de `decision` (G4).
 * `decision` = recomendacion tecnica; `operational_status` = ciclo de vida humano.
 */
export const ESTADOS_OPERATIVOS = [
  'DRAFT',
  'GENERATED',
  'PENDING_AUTHORIZATION',
  'CONFIRMED',
  'REJECTED_BY_ANALYST',
] as const;
export const OperationalStatusSchema = z.enum(ESTADOS_OPERATIVOS);
export type OperationalStatus = z.infer<typeof OperationalStatusSchema>;

export const CATEGORIAS_POLITICA = [
  'elegibilidad',
  'capacidad_pago',
  'score',
  'garantia',
  'sector',
  'monto',
  'plazo',
  'autorizacion',
  'excepcion',
  'documentacion',
] as const;
export const CategoriaPoliticaSchema = z.enum(CATEGORIAS_POLITICA);
export type CategoriaPolitica = z.infer<typeof CategoriaPoliticaSchema>;

export const SEVERIDADES = ['informativa', 'media', 'critica'] as const;
export const SeveridadSchema = z.enum(SEVERIDADES);
export type Severidad = z.infer<typeof SeveridadSchema>;

export const TIPOS_RELACION = [
  'OVERRIDES_PARTIALLY',
  'OVERRIDES_FULLY',
  'COMPLEMENTS',
  'DEPENDS_ON',
] as const;
export const TipoRelacionSchema = z.enum(TIPOS_RELACION);
export type TipoRelacion = z.infer<typeof TipoRelacionSchema>;

export const ESTADOS_RUN = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const RunStatusSchema = z.enum(ESTADOS_RUN);
export type RunStatus = z.infer<typeof RunStatusSchema>;
