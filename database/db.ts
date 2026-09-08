import 'dotenv/config';
import pg from 'pg';

/**
 * pg devuelve NUMERIC como string por defecto y asi lo queremos:
 * cualquier conversion a `number` perderia precision decimal.
 * Se desactiva explicitamente cualquier parser numerico personalizado.
 */
pg.types.setTypeParser(1700, (v: string) => v); // numeric
pg.types.setTypeParser(20, (v: string) => v);   // int8

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL. Copia .env.example a .env');
  return url;
}

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(), max: 10 });
}
