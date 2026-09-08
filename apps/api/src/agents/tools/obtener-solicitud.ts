import { z } from 'zod';
import { ApplicationNotFoundError, SolicitudSchema } from '@credit/contracts';
import { rowToSolicitud, type ApplicationRow } from '../../infrastructure/application-repository.js';
import { defineTool } from './registry.js';

const Input = z.object({ id_solicitud: z.string().uuid() });

export const obtenerSolicitudTool = defineTool({
  name: 'obtener_solicitud',
  description: 'Devuelve los datos completos de una solicitud de credito por su identificador.',
  input: Input,
  output: SolicitudSchema,
  exposedToModel: true,
  parameters: {
    type: 'object',
    properties: { id_solicitud: { type: 'string', description: 'UUID de la solicitud' } },
    required: ['id_solicitud'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { rows } = await ctx.pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [
      args.id_solicitud,
    ]);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(args.id_solicitud);
    return rowToSolicitud(row);
  },
});
