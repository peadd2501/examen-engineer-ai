import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { cargarCorpusContext, hidratarCitas } from './corpus-context.js';
import { construirResponseFormat } from './context-builder.js';

pg.types.setTypeParser(1700, (v: string) => v);
let pool: pg.Pool;

before(async () => {
  const connectionString = process.env['DATABASE_URL'];
  assert.ok(connectionString, 'DATABASE_URL no definido');
  pool = new pg.Pool({ connectionString, max: 4 });
});
after(async () => { await pool?.end(); });

// --- bloque de corpus completo ----------------------------------------------

test('el bloque contiene las 30 politicas vigentes', async () => {
  const c = await cargarCorpusContext(pool);
  assert.equal(c.totalPoliticas, 30);
  assert.equal(c.idsValidos.length, 30);
  for (const id of c.idsValidos) assert.ok(c.bloque.includes(`[${id}]`), `falta ${id} en el bloque`);
});

test('el bloque trae el texto literal de cada politica', async () => {
  const c = await cargarCorpusContext(pool);
  const { rows } = await pool.query<{ text: string }>("SELECT text FROM policies WHERE id = 'POL-2.3'");
  assert.ok(c.bloque.includes(rows[0]!.text));
});

test('las relaciones regla-excepcion aparecen explicitas y en ambas direcciones', async () => {
  const c = await cargarCorpusContext(pool);
  // POL-9.1 modifica parcialmente a POL-2.3
  assert.match(c.bloque, /POL-9\.1[\s\S]*?RELACIONES: modifica parcialmente a POL-2\.3/);
  // y POL-2.3 declara que la modifican
  assert.match(c.bloque, /POL-2\.3[\s\S]*?RELACIONES:[^\n]*modificada parcialmente por POL-9\.1/);
});

test('cada tipo de relacion se representa con su frase', async () => {
  const c = await cargarCorpusContext(pool);
  assert.ok(c.bloque.includes('modifica parcialmente a'));
  assert.ok(c.bloque.includes('complementa a'));
  assert.ok(c.bloque.includes('depende de'));
  assert.equal(c.totalRelaciones, 10);
});

test('el bloque cabe holgadamente en el contexto', async () => {
  const c = await cargarCorpusContext(pool);
  assert.ok(c.bloque.length < 20_000, `el bloque mide ${c.bloque.length} caracteres`);
});

// --- schema dinamico ---------------------------------------------------------

test('el enum de policy_ids son los ids reales del corpus', async () => {
  const c = await cargarCorpusContext(pool);
  const schema = construirResponseFormat(c.idsValidos) as {
    json_schema: { schema: { properties: { policy_ids: { items: { enum: string[] } } } } };
  };
  const enumerados = schema.json_schema.schema.properties.policy_ids.items.enum;
  assert.deepEqual([...enumerados].sort(), [...c.idsValidos].sort());
  // Los identificadores que el modelo invento en la primera evaluacion real
  // no estan en el enum.
  for (const inventado of ['POL-ELIG-001', 'ELEG-001', 'CAP-001', 'POL-001', 'POL-002']) {
    assert.ok(!enumerados.includes(inventado), `${inventado} no deberia ser un valor valido`);
  }
});

// --- hidratacion de citas ----------------------------------------------------

test('hidratar construye la cita desde el corpus, no desde el modelo', async () => {
  const { citas, desconocidos } = await hidratarCitas(pool, ['POL-2.1', 'POL-3.1']);
  assert.equal(desconocidos.length, 0);
  assert.equal(citas.length, 2);

  const { rows } = await pool.query<{ id: string; section: string; text: string }>(
    "SELECT id, section, text FROM policies WHERE id = 'POL-2.1'");
  const esperada = rows[0]!;
  const cita = citas.find((c) => c.id_politica === 'POL-2.1')!;
  assert.equal(cita.seccion, esperada.section);
  assert.equal(cita.texto_literal, esperada.text);
});

test('un id inventado no produce cita y se reporta como desconocido', async () => {
  const { citas, desconocidos } = await hidratarCitas(pool, ['POL-2.1', 'POL-ELIG-001', 'CAP-001']);
  assert.deepEqual(citas.map((c) => c.id_politica), ['POL-2.1']);
  assert.deepEqual(desconocidos.sort(), ['CAP-001', 'POL-ELIG-001']);
});

test('hidratar deduplica y tolera espacios', async () => {
  const { citas } = await hidratarCitas(pool, ['POL-2.1', ' POL-2.1 ', '']);
  assert.equal(citas.length, 1);
});

test('sin referencias no hay citas', async () => {
  assert.deepEqual(await hidratarCitas(pool, []), { citas: [], desconocidos: [] });
});
