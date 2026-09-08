import { z } from 'zod';
import { PoliticaSchema, RelacionPoliticaSchema, POLICY_CORPUS_VERSION } from '@credit/contracts';
import corpusJson from './corpus.json' with { type: 'json' };

export const CorpusSchema = z.object({
  version: z.string(),
  politicas: z.array(PoliticaSchema),
  relaciones: z.array(RelacionPoliticaSchema),
});
export type Corpus = z.infer<typeof CorpusSchema>;

/**
 * Carga y valida el corpus de politicas.
 * Verifica ademas integridad referencial de las relaciones regla <-> excepcion,
 * para que un error de corpus falle en el seed y no en tiempo de agente.
 */
export function loadCorpus(): Corpus {
  const corpus = CorpusSchema.parse(corpusJson);

  if (corpus.version !== POLICY_CORPUS_VERSION) {
    throw new Error(
      `Version de corpus (${corpus.version}) distinta de POLICY_CORPUS_VERSION (${POLICY_CORPUS_VERSION})`,
    );
  }

  const ids = new Set(corpus.politicas.map((p) => p.id));
  if (ids.size !== corpus.politicas.length) {
    throw new Error('Hay ids de politica duplicados en el corpus');
  }
  for (const r of corpus.relaciones) {
    if (!ids.has(r.source_policy_id)) throw new Error(`Relacion con origen inexistente: ${r.source_policy_id}`);
    if (!ids.has(r.target_policy_id)) throw new Error(`Relacion con destino inexistente: ${r.target_policy_id}`);
  }
  return corpus;
}
