import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApplicationNotFoundError,
  ListaSolicitudesQuerySchema,
  calcularIndicadores,
  type Indicadores,
  type Solicitud,
} from '@credit/contracts';
import { pool } from '../infrastructure/db.js';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';

export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/applications', async (request) => {
    const query = ListaSolicitudesQuerySchema.parse(request.query);
    const params: unknown[] = [query.limit, query.offset];
    let where = '';
    if (query.sector) {
      params.push(query.sector);
      where = `WHERE sector = $${params.length}`;
    }
    const { rows } = await pool.query<ApplicationRow>(
      `SELECT * FROM applications ${where} ORDER BY application_date DESC, id LIMIT $1 OFFSET $2`,
      params,
    );
    return { items: rows.map(rowToSolicitud), limit: query.limit, offset: query.offset };
  });

  app.get('/api/applications/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(id);
    return rowToSolicitud(row);
  });

  /**
   * Indicadores. Se leen los precalculados; si no existen (o la version de calculo
   * cambio) se recalculan en el momento de forma determinista.
   */
  app.get('/api/applications/:id/indicators', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(id);

    const solicitud: Solicitud = rowToSolicitud(row);
    const indicadores: Indicadores = calcularIndicadores(solicitud);
    return indicadores;
  });
}
