import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { calcularIndicadores, type Dictamen } from '@credit/contracts';
import { rowToSolicitud, type ApplicationRow } from '../infrastructure/application-repository.js';
import { citaReal, solicitudPorEtiqueta } from '../agents/testing/fixtures.js';
import { generarClaveIdempotencia, registrarDictamen } from './registrar-dictamen.js';

pg.types.setTypeParser(1700, (v: string) => v);
let pool: pg.Pool;

before(async () => {
  const connectionString = process.env['DATABASE_URL'];
  assert.ok(connectionString, 'DATABASE_URL no definido');
  pool = new pg.Pool({ connectionString, max: 10 });
});
after(async () => { await pool?.end(); });

async function dictamenValido(etiqueta: string): Promise<{ id: string; dictamen: Dictamen }> {
  const id = await solicitudPorEtiqueta(pool, etiqueta);
  const { rows } = await pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [id]);
  const solicitud = rowToSolicitud(rows[0]!);
  return {
    id,
    dictamen: {
      id_solicitud: id,
      decision: 'APROBADO',
      monto_recomendado: '40000.00',
      plazo_recomendado_meses: 24,
      indicadores: calcularIndicadores(solicitud),
      politicas_citadas: [await citaReal(pool, 'POL-2.1')],
      motivos: ['Indicadores dentro de umbral.'],
      nivel_riesgo: 'BAJO',
      requiere_autorizacion_humana: false,
      confianza: 0.9,
    },
  };
}

test('la clave la genera el backend y es estable para el mismo intento logico', () => {
  const a = generarClaveIdempotencia('11111111-1111-4111-8111-111111111111', 'intento-1');
  const b = generarClaveIdempotencia('11111111-1111-4111-8111-111111111111', 'intento-1');
  assert.equal(a, b);
  assert.notEqual(a, generarClaveIdempotencia('11111111-1111-4111-8111-111111111111', 'intento-2'));
});

test('misma clave secuencial: mismo dictamen, sin duplicado', async () => {
  const { id, dictamen } = await dictamenValido('EVAL-CASE-01');
  const key = `idem-seq-${process.pid}-${Date.now()}`;

  const primero = await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: key, politicasRecuperadas: ['POL-2.1'] });
  const segundo = await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: key, politicasRecuperadas: ['POL-2.1'] });

  assert.equal(primero.confirmacion.reutilizado, false);
  assert.equal(segundo.confirmacion.reutilizado, true);
  assert.equal(primero.confirmacion.id_dictamen, segundo.confirmacion.id_dictamen);
  assert.equal(primero.confirmacion.created_at, segundo.confirmacion.created_at);

  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM decisions WHERE idempotency_key = $1', [key]);
  assert.equal(rows[0]?.n, '1');
});

test('misma clave concurrente: una sola fila, todos devuelven el mismo id', async () => {
  const { id, dictamen } = await dictamenValido('EVAL-CASE-01');
  const key = `idem-conc-${process.pid}-${Date.now()}`;

  const resultados = await Promise.all(
    Array.from({ length: 8 }, () =>
      registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: key, politicasRecuperadas: ['POL-2.1'] }),
    ),
  );

  const ids = new Set(resultados.map((r) => r.confirmacion.id_dictamen));
  assert.equal(ids.size, 1, `se crearon ${ids.size} dictamenes distintos en carrera`);

  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text n FROM decisions WHERE idempotency_key = $1', [key]);
  assert.equal(rows[0]?.n, '1', 'la UNIQUE de la base es la ultima defensa y funciono');

  // Exactamente uno creo; el resto reutilizo.
  assert.equal(resultados.filter((r) => !r.confirmacion.reutilizado).length, 1);
});

test('claves distintas para la misma solicitud si crean dictamenes distintos', async () => {
  const { id, dictamen } = await dictamenValido('EVAL-CASE-01');
  const base = `idem-multi-${process.pid}-${Date.now()}`;
  const a = await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: `${base}-a`, politicasRecuperadas: ['POL-2.1'] });
  const b = await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: `${base}-b`, politicasRecuperadas: ['POL-2.1'] });
  assert.notEqual(a.confirmacion.id_dictamen, b.confirmacion.id_dictamen);
});

test('un reintento con la misma clave no vuelve a insertar citas', async () => {
  const { id, dictamen } = await dictamenValido('EVAL-CASE-01');
  const key = `idem-citas-${process.pid}-${Date.now()}`;
  const primero = await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: key, politicasRecuperadas: ['POL-2.1'] });
  await registrarDictamen(pool, { id_solicitud: id, dictamen, clave_idempotencia: key, politicasRecuperadas: ['POL-2.1'] });

  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text n FROM decision_policy_citations WHERE decision_id = $1', [primero.confirmacion.id_dictamen]);
  assert.equal(rows[0]?.n, '1');
});
