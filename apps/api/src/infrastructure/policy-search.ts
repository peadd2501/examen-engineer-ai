import type { Pool } from 'pg';
import {
  BuscarPoliticaInputSchema,
  type CategoriaPolitica,
  type FragmentoPolitica,
  type FragmentoPoliticaEnriquecido,
  type Severidad,
  type TipoRelacion,
} from '@credit/contracts';

/**
 * Recuperacion de politicas. Determinista y auditable, sin embeddings:
 *   consulta -> lexemas (to_tsvector en la propia base)
 *   -> filtro opcional por categoria -> FTS con semantica OR
 *   -> compuerta de cobertura de terminos  <-- decide SI aplica
 *   -> ranking ts_rank_cd                  <-- decide CUANTO importa
 *   -> top_k -> expansion de relaciones regla <-> excepcion
 */

/** Piso de relevancia. Descarta coincidencias marginales. */
export const MIN_RELEVANCE = 0.01;

/**
 * Fraccion minima de lexemas de la consulta que la politica debe contener.
 *
 * Es la compuerta que hace posible responder "no hay politica aplicable": con
 * semantica OR, "carta de credito para importacion en euros" hace match con la
 * politica de cobertura de deuda solo por compartir dos de siete terminos. Un
 * umbral sobre ts_rank_cd no separa ese caso (0.64); la cobertura si (0.29
 * contra 1.00).
 */
export const MIN_COVERAGE = 0.5;

interface PolicyHitRow {
  id: string;
  section: string;
  text: string;
  category: CategoriaPolitica;
  severity: Severidad;
  score: string;
  coverage: string;
}

interface RelatedRow {
  id: string;
  section: string;
  text: string;
  category: CategoriaPolitica;
  severity: Severidad;
  related_to: string;
  relation_type: TipoRelacion;
}

/**
 * La normalizacion ocurre en PostgreSQL: `to_tsvector('spanish', ...)` hace
 * stemming y elimina stopwords, y los lexemas se unen con OR. No se usa
 * `plainto_tsquery` porque une con AND: una consulta de seis palabras no
 * encontraria nada. `tsvector_to_array` permite contar lexemas sin re-stemming.
 */
const SQL_HITS = `
WITH lexemas AS (
  SELECT array_agg(lexeme) AS terms
  FROM unnest(to_tsvector('spanish', $1)) AS t(lexeme, positions, weights)
  WHERE lexeme ~ '^[a-z0-9áéíóúñü]+$'
),
consulta AS (
  SELECT terms, to_tsquery('spanish', array_to_string(terms, ' | ')) AS tsq
  FROM lexemas WHERE terms IS NOT NULL
),
candidatos AS (
  SELECT p.id, p.section, p.text, p.category, p.severity,
         ts_rank_cd(p.search_vector, c.tsq, 32) AS score,
         (SELECT count(*) FROM unnest(c.terms) AS l
           WHERE l = ANY(tsvector_to_array(p.search_vector)))::numeric
           / array_length(c.terms, 1) AS coverage
  FROM policies p, consulta c
  WHERE p.active
    AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
    AND p.search_vector @@ c.tsq
    AND ($2::policy_category_t IS NULL OR p.category = $2::policy_category_t)
)
SELECT id, section, text, category, severity, score::text, coverage::text
FROM candidatos
WHERE score >= $3 AND coverage >= $4
ORDER BY score DESC, coverage DESC, id
LIMIT $5
`;

/**
 * Expansion de relaciones, en AMBAS direcciones: si se recupero una regla entran
 * las excepciones que la modifican, y si se recupero una excepcion entra la regla
 * que modifica. El modelo nunca tiene que inferir esta relacion por su cuenta.
 */
const SQL_RELATED = `
SELECT p.id, p.section, p.text, p.category, p.severity,
       r.anchor AS related_to, r.relation_type
FROM (
  SELECT source_policy_id AS id, target_policy_id AS anchor, relation_type
  FROM policy_relations WHERE target_policy_id = ANY($1::text[])
  UNION
  SELECT target_policy_id AS id, source_policy_id AS anchor, relation_type
  FROM policy_relations WHERE source_policy_id = ANY($1::text[])
) r
JOIN policies p ON p.id = r.id
WHERE p.active AND NOT (p.id = ANY($1::text[]))
ORDER BY p.id
`;

export interface BuscarPoliticaOptions {
  categoria?: CategoriaPolitica;
  /** Permiten endurecer o relajar las compuertas en tests y calibracion. */
  minRelevance?: number;
  minCoverage?: number;
}

/**
 * Version enriquecida: incluye score, cobertura, categoria y de donde vino cada
 * fragmento. Es la que usa la API y la que se registrara en tool_calls.
 */
export async function buscarPoliticaDetallado(
  pool: Pool,
  consulta: string,
  topK = 5,
  options: BuscarPoliticaOptions = {},
): Promise<FragmentoPoliticaEnriquecido[]> {
  const input = BuscarPoliticaInputSchema.parse({
    consulta,
    top_k: topK,
    ...(options.categoria ? { categoria: options.categoria } : {}),
  });

  const { rows: hits } = await pool.query<PolicyHitRow>(SQL_HITS, [
    input.consulta,
    input.categoria ?? null,
    options.minRelevance ?? MIN_RELEVANCE,
    options.minCoverage ?? MIN_COVERAGE,
    input.top_k,
  ]);

  const resultado: FragmentoPoliticaEnriquecido[] = hits.map((r) => ({
    id_politica: r.id,
    seccion: r.section,
    texto_literal: r.text,
    categoria: r.category,
    severidad: r.severity,
    score: Number(r.score),
    cobertura: Number(r.coverage),
    incluido_por_relacion: false,
    relacionado_con: [],
  }));

  // Sin acierto directo no hay nada que expandir: la respuesta correcta es
  // "no hay politica aplicable", y el orquestador debera escalar a comite.
  if (resultado.length === 0) return resultado;

  // La expansion NO consume cupo de top_k: una excepcion critica no puede
  // quedar fuera porque el llamador pidio top_k=3.
  const anclas = resultado.map((r) => r.id_politica);
  const { rows: related } = await pool.query<RelatedRow>(SQL_RELATED, [anclas]);

  const porId = new Map<string, FragmentoPoliticaEnriquecido>();
  for (const r of related) {
    const existente = porId.get(r.id);
    if (existente) {
      if (!existente.relacionado_con.includes(r.related_to)) existente.relacionado_con.push(r.related_to);
      continue;
    }
    porId.set(r.id, {
      id_politica: r.id,
      seccion: r.section,
      texto_literal: r.text,
      categoria: r.category,
      severidad: r.severity,
      score: 0,
      cobertura: 0,
      incluido_por_relacion: true,
      relacionado_con: [r.related_to],
    });
  }

  return [...resultado, ...porId.values()];
}

/**
 * Firma publica exigida por el enunciado.
 * Devuelve solo lo citable: id, seccion y texto literal.
 */
export async function buscarPolitica(
  pool: Pool,
  consulta: string,
  topK = 5,
  options: BuscarPoliticaOptions = {},
): Promise<FragmentoPolitica[]> {
  const detallado = await buscarPoliticaDetallado(pool, consulta, topK, options);
  return detallado.map(({ id_politica, seccion, texto_literal }) => ({ id_politica, seccion, texto_literal }));
}
