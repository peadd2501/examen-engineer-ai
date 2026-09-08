import type { Pool } from 'pg';
import type { CitaPolitica } from '@credit/contracts';

/** Lee del corpus sembrado el texto literal exacto de una politica. */
export async function citaReal(pool: Pool, idPolitica: string): Promise<CitaPolitica> {
  const { rows } = await pool.query<{ id: string; section: string; text: string }>(
    'SELECT id, section, text FROM policies WHERE id = $1',
    [idPolitica],
  );
  const row = rows[0];
  if (!row) throw new Error(`Politica inexistente en el corpus de prueba: ${idPolitica}`);
  return { id_politica: row.id, seccion: row.section, texto_literal: row.text };
}

/** Busca una solicitud del seed por el prefijo de su nombre (EVAL-CASE-01, ADV-INJ-01...). */
export async function solicitudPorEtiqueta(pool: Pool, etiqueta: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM applications WHERE company_name LIKE $1 ORDER BY company_name LIMIT 1',
    [`%${etiqueta}%`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`No hay solicitud sembrada con etiqueta ${etiqueta}. Corre pnpm seed.`);
  return id;
}

export interface CandidatoOpts {
  decision?: 'APROBADO' | 'RECHAZADO' | 'ESCALADO_A_COMITE';
  monto?: string | null;
  plazo?: number | null;
  /** Referencias a politicas. El modelo ya no escribe texto de cita. */
  policyIds?: string[];
  /** Nivel que el modelo INTENTA imponer. El backend lo ignora (FASE 3.3). */
  riesgoInventado?: 'BAJO' | 'MEDIO' | 'ALTO';
  confianza?: number;
  motivos?: string[];
}

/** Candidato valido segun DictamenLLMSchema, para guionar al proveedor. */
export function candidato(opts: CandidatoOpts = {}): Record<string, unknown> {
  return {
    decision: opts.decision ?? 'APROBADO',
    monto_recomendado: opts.monto === undefined ? '80000.00' : opts.monto,
    plazo_recomendado_meses: opts.plazo === undefined ? 24 : opts.plazo,
    policy_ids: opts.policyIds ?? [],
    motivos: opts.motivos ?? ['Indicadores dentro de los umbrales de politica.'],
    // Se emite solo si el test quiere probar que el backend lo descarta.
    ...(opts.riesgoInventado ? { nivel_riesgo: opts.riesgoInventado } : {}),
    confianza: opts.confianza ?? 0.85,
  };
}
