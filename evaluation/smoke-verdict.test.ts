import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluarRespuestaSmoke } from './smoke-verdict.js';

const VALIDO = JSON.stringify({ ok: true, modelo_respondio: 'si' });

// --- el caso que se colo: HTTP 200 con nada dentro ---------------------------

test('el caso Liquid: finish_reason length con content null es FALLO', () => {
  const v = evaluarRespuestaSmoke({ content: null, finishReason: 'length' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TRUNCATED');
});

test('truncacion con contenido parcial tambien es FALLO', () => {
  const v = evaluarRespuestaSmoke({ content: '{"ok": tr', finishReason: 'length' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TRUNCATED');
});

test('un JSON completo pero cortado por length no se acepta', () => {
  // Aunque el JSON sea parseable, la generacion se corto: no es fiable.
  const v = evaluarRespuestaSmoke({ content: VALIDO, finishReason: 'length' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TRUNCATED');
});

// --- contenido ausente -------------------------------------------------------

test('content null con stop es NO_CONTENT', () => {
  const v = evaluarRespuestaSmoke({ content: null, finishReason: 'stop' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'NO_CONTENT');
});

test('content vacio o solo espacios es NO_CONTENT', () => {
  assert.equal(evaluarRespuestaSmoke({ content: '', finishReason: 'stop' }).code, 'NO_CONTENT');
  assert.equal(evaluarRespuestaSmoke({ content: '   \n ', finishReason: 'stop' }).code, 'NO_CONTENT');
});

// --- finish_reason -----------------------------------------------------------

test('finish_reason inesperado es FALLO aunque el JSON sea valido', () => {
  const v = evaluarRespuestaSmoke({ content: VALIDO, finishReason: 'content_filter' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'UNEXPECTED_FINISH_REASON');
});

test('tool_calls no es una finalizacion exitosa para el smoke', () => {
  assert.equal(evaluarRespuestaSmoke({ content: VALIDO, finishReason: 'tool_calls' }).code, 'UNEXPECTED_FINISH_REASON');
});

test('se aceptan las variantes de finalizacion limpia entre proveedores', () => {
  for (const finish of ['stop', 'end_turn', 'eos', 'completed', 'finished']) {
    assert.equal(evaluarRespuestaSmoke({ content: VALIDO, finishReason: finish }).ok, true, finish);
  }
});

test('sin finish_reason se acepta pero se avisa', () => {
  const v = evaluarRespuestaSmoke({ content: VALIDO, finishReason: null });
  assert.equal(v.ok, true);
  assert.ok(v.aviso, 'deberia avisar que el proveedor no informo finish_reason');
});

// --- contenido invalido ------------------------------------------------------

test('contenido que no es JSON es INVALID_JSON', () => {
  const v = evaluarRespuestaSmoke({ content: 'Claro, aqui tienes el resultado:', finishReason: 'stop' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'INVALID_JSON');
});

test('JSON valido que no cumple el esquema es SCHEMA_MISMATCH', () => {
  const v = evaluarRespuestaSmoke({ content: '{"ok": "si"}', finishReason: 'stop' });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'SCHEMA_MISMATCH');
});

test('campos de mas tampoco pasan: el esquema es estricto', () => {
  const v = evaluarRespuestaSmoke({
    content: JSON.stringify({ ok: true, modelo_respondio: 'si', extra: 'sobra' }),
    finishReason: 'stop',
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'SCHEMA_MISMATCH');
});

// --- unico camino a PASS -----------------------------------------------------

test('PASS solo con contenido, finalizacion limpia y esquema cumplido', () => {
  const v = evaluarRespuestaSmoke({ content: VALIDO, finishReason: 'stop' });
  assert.equal(v.ok, true);
  assert.equal(v.code, 'OK');
  assert.equal(v.aviso, undefined);
});
