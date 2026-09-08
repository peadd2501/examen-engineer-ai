import test from 'node:test';
import assert from 'node:assert/strict';
import { DictamenLLMSchema, LIMITES_DICTAMEN_LLM } from './decision.js';

function candidato(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'APROBADO',
    monto_recomendado: '80000.00',
    plazo_recomendado_meses: 24,
    policy_ids: ['POL-2.1'],
    motivos: ['Indicadores dentro de umbral.'],
    nivel_riesgo: 'BAJO',
    confianza: 0.85,
    ...over,
  };
}

test('un candidato normal valida', () => {
  assert.equal(DictamenLLMSchema.safeParse(candidato()).success, true);
});

// --- motivos ---------------------------------------------------------------

test('un motivo de mas de 350 caracteres se rechaza', () => {
  const largo = 'a'.repeat(LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS + 1);
  const r = DictamenLLMSchema.safeParse(candidato({ motivos: [largo] }));
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error?.issues), /motivos/);
});

test('un motivo de exactamente 350 caracteres pasa', () => {
  const justo = 'a'.repeat(LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ motivos: [justo] })).success, true);
});

test('mas de 5 motivos se rechaza', () => {
  const seis = Array.from({ length: 6 }, (_, i) => `motivo ${i + 1}`);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ motivos: seis })).success, false);
});

test('exactamente 5 motivos pasa', () => {
  const cinco = Array.from({ length: 5 }, (_, i) => `motivo ${i + 1}`);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ motivos: cinco })).success, true);
});

test('cero motivos se rechaza', () => {
  assert.equal(DictamenLLMSchema.safeParse(candidato({ motivos: [] })).success, false);
});

test('un motivo vacio se rechaza', () => {
  assert.equal(DictamenLLMSchema.safeParse(candidato({ motivos: [''] })).success, false);
});

// --- policy_ids ------------------------------------------------------------

test('un identificador de politica desmesurado se rechaza', () => {
  const largo = 'P'.repeat(LIMITES_DICTAMEN_LLM.POLICY_ID_MAX_CHARS + 1);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ policy_ids: [largo] })).success, false);
});

test('mas de 10 referencias se rechaza', () => {
  const once = Array.from({ length: 11 }, (_, i) => `POL-${i}`);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ policy_ids: once })).success, false);
});

// --- monto -----------------------------------------------------------------

test('un monto con una cadena desmesurada se rechaza antes de normalizar', () => {
  const enorme = '9'.repeat(LIMITES_DICTAMEN_LLM.MONTO_MAX_CHARS + 1);
  assert.equal(DictamenLLMSchema.safeParse(candidato({ monto_recomendado: enorme })).success, false);
});

test('un monto normal se normaliza a dos decimales', () => {
  const r = DictamenLLMSchema.safeParse(candidato({ monto_recomendado: '80000' }));
  assert.equal(r.success, true);
  assert.equal(r.data?.monto_recomendado, '80000.00');
});

test('monto null es valido', () => {
  const r = DictamenLLMSchema.safeParse(candidato({ monto_recomendado: null }));
  assert.equal(r.success, true);
  assert.equal(r.data?.monto_recomendado, null);
});
