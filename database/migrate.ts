import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';

/**
 * Runner de migraciones minimo y determinista.
 * Cada archivo .sql corre una sola vez, en orden lexicografico, dentro de una transaccion.
 * Se prefiere esto a una libreria externa: menos dependencias y el SQL queda a la vista.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const pool = createPool();
  const client = await pool.connect();

  try {
    if (reset) {
      console.log('!! --reset: se elimina y recrea el schema public');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file} (ya aplicada)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  + ${file}`);
        count += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  x ${file} fallo, transaccion revertida`);
        throw error;
      }
    }

    console.log(count === 0 ? 'Base de datos ya estaba al dia.' : `${count} migracion(es) aplicada(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
