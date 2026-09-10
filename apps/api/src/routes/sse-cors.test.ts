import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { config } from '../config.js';

/**
 * Regresion de CORS sobre la respuesta SSE.
 *
 * `reply.hijack()` descarta los headers que @fastify/cors habia puesto con
 * reply.header(). El preflight OPTIONS seguia respondiendo 204, asi que desde el
 * servidor todo parecia bien mientras el navegador descartaba los eventos con
 * "CORS Missing Allow Origin". Un OPTIONS 204 no prueba CORS: hay que verificar
 * la respuesta REAL.
 */
const ORIGEN = 'http://localhost:5173';
let app: FastifyInstance;
let idSolicitud: string;

before(async () => {
  assert.ok(process.env['DATABASE_URL'], 'DATABASE_URL no definido');
  app = await buildServer();
  await app.ready();

  const listado = await app.inject({ method: 'GET', url: '/api/applications?limit=5' });
  const items = (listado.json() as { items: Array<{ id_solicitud: string }> }).items;
  assert.ok(items[0], 'la base no esta sembrada: corre pnpm seed');
  idSolicitud = items[0].id_solicitud;
});

after(async () => {
  await app?.close();
});

test('el preflight responde y permite el origen configurado', async () => {
  const r = await app.inject({
    method: 'OPTIONS',
    url: `/api/applications/${idSolicitud}/analyze/stream`,
    headers: { origin: ORIGEN, 'access-control-request-method': 'POST' },
  });
  assert.ok(r.statusCode === 204 || r.statusCode === 200, `preflight devolvio ${r.statusCode}`);
  assert.equal(r.headers['access-control-allow-origin'], ORIGEN);
});

test('la respuesta SSE real conserva los headers CORS pese al hijack', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/applications/${idSolicitud}/analyze/stream`,
    headers: { origin: ORIGEN, 'content-type': 'application/json' },
    payload: {},
  });

  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /text\/event-stream/);
  assert.equal(
    r.headers['access-control-allow-origin'],
    ORIGEN,
    'sin este header el navegador descarta el stream entero',
  );
  assert.equal(r.headers['vary'], 'Origin');
});

test('los headers de streaming siguen presentes', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/applications/${idSolicitud}/analyze/stream`,
    headers: { origin: ORIGEN, 'content-type': 'application/json' },
    payload: {},
  });
  assert.match(String(r.headers['content-type']), /charset=utf-8/);
  assert.equal(r.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(r.headers['connection'], 'keep-alive');
  assert.equal(r.headers['x-accel-buffering'], 'no');
});

test('el cuerpo son frames SSE validos', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/applications/${idSolicitud}/analyze/stream`,
    headers: { origin: ORIGEN, 'content-type': 'application/json' },
    payload: {},
  });

  const bloques = r.body.split('\n\n').filter((b) => b.trim() !== '');
  assert.ok(bloques.length > 0, 'no se emitio ningun evento');
  for (const bloque of bloques) {
    assert.match(bloque, /^event: [a-z.]+\ndata: \{/, `frame mal formado: ${bloque.slice(0, 60)}`);
    const datos = bloque.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim();
    const evento = JSON.parse(datos) as { type: string; run_id: string; sequence: number };
    assert.ok(typeof evento.type === 'string' && evento.type.length > 0);
    assert.ok(typeof evento.sequence === 'number');
  }
});

test('un origen no permitido no recibe el header', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/applications/${idSolicitud}/analyze/stream`,
    headers: { origin: 'http://sitio-no-autorizado.example', 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.notEqual(r.headers['access-control-allow-origin'], '*', 'nunca comodin');
});

test('CORS_ORIGIN admite varios origenes separados por coma', () => {
  const permitidos = config.CORS_ORIGIN.split(',').map((o) => o.trim());
  assert.ok(permitidos.length >= 1);
  assert.ok(permitidos.every((o) => o !== '*'), 'la configuracion no debe usar comodin');
});
