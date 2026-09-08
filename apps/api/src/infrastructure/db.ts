import pg from 'pg';
import { config } from '../config.js';

// NUMERIC y BIGINT llegan como string: la precision decimal se conserva.
pg.types.setTypeParser(1700, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => v);

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

/** Ejecuta una funcion dentro de una transaccion, con rollback automatico ante error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function pingDatabase(): Promise<boolean> {
  const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
