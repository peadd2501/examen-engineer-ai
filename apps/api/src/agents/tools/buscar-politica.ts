import { z } from 'zod';
import { CATEGORIAS_POLITICA, CategoriaPoliticaSchema, FragmentoPoliticaSchema } from '@credit/contracts';
import { buscarPoliticaDetallado } from '../../infrastructure/policy-search.js';
import { defineTool } from './registry.js';

const Input = z.object({
  consulta: z.string().min(1).max(500),
  top_k: z.number().int().min(1).max(10).default(5),
  categoria: CategoriaPoliticaSchema.optional(),
});

const Output = z.object({
  total: z.number().int(),
  sin_politica_aplicable: z.boolean(),
  fragmentos: z.array(
    FragmentoPoliticaSchema.extend({
      categoria: CategoriaPoliticaSchema,
      incluido_por_relacion: z.boolean(),
      relacionado_con: z.array(z.string()),
    }),
  ),
});

export const buscarPoliticaTool = defineTool({
  name: 'buscar_politica',
  description:
    'Busca politicas vigentes en el corpus. Devuelve el texto literal de cada politica, que es lo unico ' +
    'que se puede citar. Si una regla recuperada tiene excepciones relacionadas, se incluyen ' +
    'automaticamente. Un resultado vacio significa que NO existe politica aplicable.',
  input: Input,
  output: Output,
  exposedToModel: true,
  parameters: {
    type: 'object',
    properties: {
      consulta: { type: 'string', description: 'Tema a buscar, en espanol' },
      top_k: { type: 'integer', minimum: 1, maximum: 10, description: 'Numero de aciertos directos' },
      categoria: { type: 'string', enum: [...CATEGORIAS_POLITICA] },
    },
    required: ['consulta'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const fragmentos = await buscarPoliticaDetallado(
      ctx.pool,
      args.consulta,
      args.top_k,
      args.categoria ? { categoria: args.categoria } : {},
    );

    // Todo lo recuperado queda registrado en el run: G1 verifica las citas
    // contra esto y contra el corpus, nunca contra lo que el modelo afirme.
    ctx.registrarPoliticas(fragmentos);

    return {
      total: fragmentos.length,
      sin_politica_aplicable: fragmentos.length === 0,
      fragmentos: fragmentos.map((f) => ({
        id_politica: f.id_politica,
        seccion: f.seccion,
        texto_literal: f.texto_literal,
        categoria: f.categoria,
        incluido_por_relacion: f.incluido_por_relacion,
        relacionado_con: f.relacionado_con,
      })),
    };
  },
});
