import type { Pool } from 'pg';
import type { CategoriaPolitica, Severidad, TipoRelacion } from '@credit/contracts';

/**
 * Corpus completo como bloque autoritativo de contexto.
 *
 * Con 30 politicas cabe entero en el prompt (~9 KB) y eso elimina de raiz un
 * modo de fallo que la evaluacion real expuso: `buscar_politica` funciona bien
 * en aislamiento, pero el modelo formulaba consultas que recuperaban evidencia
 * equivocada, y sobre esa evidencia decidia mal. Una decision no puede depender
 * de que el modelo acierte la consulta perfecta para enterarse de una regla
 * basica.
 *
 * `buscar_politica` sigue existiendo y sigue expuesta como herramienta: sirve
 * para profundizar. Lo que cambia es que ya no es la unica via de acceso.
 *
 * A ~500 politicas esto deja de caber y habria que volver a recuperacion:
 * hibrida (BM25 + embeddings), filtros por metadata, reranking y una metrica de
 * recall y precision de citas. Ver README.
 */

interface PolicyRow {
  id: string;
  section: string;
  category: CategoriaPolitica;
  text: string;
  severity: Severidad;
}

interface RelationRow {
  source_policy_id: string;
  target_policy_id: string;
  relation_type: TipoRelacion;
}

export interface CorpusContext {
  /** Bloque de texto listo para inyectar como mensaje de contexto. */
  bloque: string;
  /** Ids validos. Alimentan el enum del JSON Schema de salida. */
  idsValidos: string[];
  totalPoliticas: number;
  totalRelaciones: number;
}

/** Frases legibles para cada tipo de relacion, en las dos direcciones. */
const RELACION_SALIENTE: Record<TipoRelacion, string> = {
  OVERRIDES_PARTIALLY: 'modifica parcialmente a',
  OVERRIDES_FULLY: 'reemplaza a',
  COMPLEMENTS: 'complementa a',
  DEPENDS_ON: 'depende de',
};

const RELACION_ENTRANTE: Record<TipoRelacion, string> = {
  OVERRIDES_PARTIALLY: 'modificada parcialmente por',
  OVERRIDES_FULLY: 'reemplazada por',
  COMPLEMENTS: 'complementada por',
  DEPENDS_ON: 'de la que depende',
};

/**
 * Carga el corpus vigente y lo renderiza.
 *
 * Las relaciones regla <-> excepcion se escriben explicitamente en ambas
 * direcciones. El modelo no tiene que descubrir por semantica textual que
 * POL-9.1 modifica a POL-2.3: se lo decimos.
 */
export async function cargarCorpusContext(pool: Pool): Promise<CorpusContext> {
  const { rows: politicas } = await pool.query<PolicyRow>(
    `SELECT id, section, category, text, severity
       FROM policies
      WHERE active AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY id`,
  );
  const { rows: relaciones } = await pool.query<RelationRow>(
    'SELECT source_policy_id, target_policy_id, relation_type FROM policy_relations',
  );

  const salientes = new Map<string, string[]>();
  const entrantes = new Map<string, string[]>();
  for (const r of relaciones) {
    const s = salientes.get(r.source_policy_id) ?? [];
    s.push(`${RELACION_SALIENTE[r.relation_type]} ${r.target_policy_id}`);
    salientes.set(r.source_policy_id, s);

    const e = entrantes.get(r.target_policy_id) ?? [];
    e.push(`${RELACION_ENTRANTE[r.relation_type]} ${r.source_policy_id}`);
    entrantes.set(r.target_policy_id, e);
  }

  const entradas = politicas.map((p) => {
    const lineas = [`[${p.id}] ${p.section}  (categoria: ${p.category}, severidad: ${p.severity})`, p.text];
    const rel = [...(salientes.get(p.id) ?? []), ...(entrantes.get(p.id) ?? [])];
    if (rel.length > 0) lineas.push(`RELACIONES: ${rel.join('; ')}`);
    return lineas.join('\n');
  });

  const bloque = [
    'CORPUS DE POLITICAS VIGENTES (autoritativo y completo).',
    `Son ${politicas.length} politicas. Este es el corpus entero: no existe ninguna otra politica.`,
    'Solo podes referenciar identificadores de esta lista. No inventes identificadores.',
    'El bloque RELACIONES indica que politicas se modifican entre si; respetalo en tu analisis.',
    '',
    entradas.join('\n\n'),
  ].join('\n');

  return {
    bloque,
    idsValidos: politicas.map((p) => p.id),
    totalPoliticas: politicas.length,
    totalRelaciones: relaciones.length,
  };
}

interface CitaRow { id: string; section: string; text: string }

/**
 * Hidratacion de citas: convierte las referencias del modelo en citas completas
 * leyendo el corpus. El texto literal proviene SIEMPRE de la base de datos.
 *
 * Devuelve tambien los ids desconocidos, que el llamador registra como hallazgo
 * de G1 en lugar de silenciarlos.
 */
export async function hidratarCitas(
  pool: Pool,
  policyIds: string[],
): Promise<{ citas: Array<{ id_politica: string; seccion: string; texto_literal: string }>; desconocidos: string[] }> {
  const unicos = [...new Set(policyIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (unicos.length === 0) return { citas: [], desconocidos: [] };

  const { rows } = await pool.query<CitaRow>(
    'SELECT id, section, text FROM policies WHERE id = ANY($1::text[]) AND active',
    [unicos],
  );
  const porId = new Map(rows.map((r) => [r.id, r]));

  const citas = unicos
    .map((id) => porId.get(id))
    .filter((r): r is CitaRow => r !== undefined)
    .map((r) => ({ id_politica: r.id, seccion: r.section, texto_literal: r.text }));

  const desconocidos = unicos.filter((id) => !porId.has(id));
  return { citas, desconocidos };
}
