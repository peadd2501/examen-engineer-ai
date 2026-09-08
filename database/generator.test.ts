import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicUuid, generarDataset } from './generator.js';

const SEED = '20260907';

test('el dataset es reproducible con el mismo seed', () => {
  const a = generarDataset(SEED);
  const b = generarDataset(SEED);
  assert.deepEqual(a, b);
});

test('un seed distinto produce un dataset distinto', () => {
  const a = generarDataset(SEED);
  const b = generarDataset('20260908');
  assert.notEqual(a[0]?.solicitud.id_solicitud, b[0]?.solicitud.id_solicitud);
});

test('los UUID son estables y bien formados', () => {
  const uuid = deterministicUuid(SEED, 0);
  assert.equal(uuid, deterministicUuid(SEED, 0));
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('cumple los minimos obligatorios del dataset', () => {
  const dataset = generarDataset(SEED);
  assert.ok(dataset.length >= 200, `se esperaban 200+, hay ${dataset.length}`);
  assert.ok(dataset.filter((x) => x.tag === 'injection').length >= 3);
  assert.ok(dataset.filter((x) => x.tag === 'inconsistent').length >= 5);
  assert.equal(dataset.filter((x) => x.tag === 'eval').length, 10);
});

test('no hay ids repetidos', () => {
  const ids = generarDataset(SEED).map((x) => x.solicitud.id_solicitud);
  assert.equal(new Set(ids).size, ids.length);
});
