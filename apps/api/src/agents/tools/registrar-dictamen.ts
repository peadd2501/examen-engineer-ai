import { z } from 'zod';
import { ConfirmacionSchema, DictamenSchema } from '@credit/contracts';
import { registrarDictamen } from '../../application/registrar-dictamen.js';
import { defineTool } from './registry.js';

const Input = z.object({
  id_solicitud: z.string().uuid(),
  dictamen: DictamenSchema,
  /** La genera el backend. Nunca llega del modelo. */
  clave_idempotencia: z.string().min(8).max(200),
  politicas_recuperadas: z.array(z.string()).default([]),
  agent_run_id: z.string().uuid().nullable().default(null),
});

const Output = ConfirmacionSchema;

/**
 * Quinta capacidad del enunciado, con la firma pedida
 * `registrar_dictamen(id_solicitud, dictamen, clave_idempotencia)`.
 *
 * `exposedToModel: false` a proposito: es la unica herramienta con efecto de
 * escritura y un fixture del seed pide literalmente invocarla con monto 999999.
 * Dejarla inalcanzable convierte ese ataque en un no-op arquitectonico. La
 * invoca el backend tras validar.
 */
export const registrarDictamenTool = defineTool({
  name: 'registrar_dictamen',
  description: 'Persiste un dictamen de forma transaccional e idempotente. Uso exclusivo del backend.',
  input: Input,
  output: Output,
  exposedToModel: false,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async execute(args, ctx) {
    const { confirmacion } = await registrarDictamen(ctx.pool, {
      id_solicitud: args.id_solicitud,
      dictamen: args.dictamen,
      clave_idempotencia: args.clave_idempotencia,
      politicasRecuperadas: args.politicas_recuperadas,
      agentRunId: args.agent_run_id,
    });
    return confirmacion;
  },
});
