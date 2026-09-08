import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITES_DICTAMEN_LLM } from '@credit/contracts';
import { OpenRouterClient, type ReasoningEffort } from './openrouter-client.js';
import { construirResponseFormat } from './context-builder.js';

/**
 * Verifica el payload que sale hacia el proveedor interceptando fetch.
 * No hay red: se comprueba lo que se envia, no lo que responde nadie.
 */
interface Payload {
  model: string;
  max_tokens: number;
  temperature: number;
  reasoning?: { effort: string };
  seed?: number;
  response_format?: unknown;
}

async function capturarPayload(
  config: { reasoningEffort?: ReasoningEffort; seed?: number },
  status = 200,
  errorBody?: string,
): Promise<Payload> {
  let capturado: Payload | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    capturado = JSON.parse(String(init.body)) as Payload;
    if (status !== 200) {
      return new Response(errorBody ?? '{}', { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      JSON.stringify({
        model: 'test/model',
        choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const client = new OpenRouterClient({
    apiKey: 'sk-or-v1-test', baseUrl: 'https://example.invalid/api/v1',
    model: 'test/model', timeoutMs: 5000, ...config,
  });
  try {
    await client.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 5000, temperature: 0 });
  } catch { /* en los casos de error solo interesa el payload capturado */ }
  globalThis.fetch = original;

  assert.ok(capturado, 'no se capturo payload');
  return capturado;
}

// --- reasoning --------------------------------------------------------------

test('reasoning none llega al request', async () => {
  const p = await capturarPayload({ reasoningEffort: 'none' });
  assert.deepEqual(p.reasoning, { effort: 'none' });
});

test('reasoning off omite el campo por completo', async () => {
  const p = await capturarPayload({ reasoningEffort: 'off' });
  assert.equal(p.reasoning, undefined);
});

test('cualquier otro nivel viaja tal cual', async () => {
  assert.deepEqual((await capturarPayload({ reasoningEffort: 'low' })).reasoning, { effort: 'low' });
  assert.deepEqual((await capturarPayload({ reasoningEffort: 'high' })).reasoning, { effort: 'high' });
});

test('si el proveedor rechaza reasoning se clasifica, sin fallback silencioso', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'reasoning.effort is not supported for this model' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const client = new OpenRouterClient({
    apiKey: 'sk-or-v1-test', baseUrl: 'https://example.invalid/api/v1',
    model: 'test/model', timeoutMs: 5000, reasoningEffort: 'none',
  });

  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100, temperature: 0 }),
    (e: unknown) => {
      const err = e as { failure?: string; message: string };
      assert.equal(err.failure, 'REASONING_EFFORT_UNSUPPORTED');
      assert.match(err.message, /OPENROUTER_REASONING_EFFORT=off/);
      return true;
    },
  );
  globalThis.fetch = original;
});

// --- seed -------------------------------------------------------------------

test('la semilla llega al request', async () => {
  const p = await capturarPayload({ seed: 20260907 });
  assert.equal(p.seed, 20260907);
});

test('sin semilla configurada el campo no se envia', async () => {
  const p = await capturarPayload({});
  assert.equal(p.seed, undefined);
});

test('max_tokens se mantiene en 5000, no se sube para tapar el problema', async () => {
  const p = await capturarPayload({ reasoningEffort: 'none' });
  assert.equal(p.max_tokens, 5000);
  assert.equal(p.temperature, 0);
});

// --- limites en el JSON Schema ---------------------------------------------

test('el JSON Schema replica exactamente los limites de Zod', () => {
  const schema = construirResponseFormat(['POL-1.1', 'POL-2.1']) as {
    json_schema: {
      schema: {
        properties: {
          motivos: { minItems: number; maxItems: number; items: { minLength: number; maxLength: number } };
          policy_ids: { maxItems: number; items: { maxLength: number } };
          monto_recomendado: { maxLength: number };
        };
      };
    };
  };
  const props = schema.json_schema.schema.properties;

  assert.equal(props.motivos.minItems, LIMITES_DICTAMEN_LLM.MOTIVOS_MIN);
  assert.equal(props.motivos.maxItems, LIMITES_DICTAMEN_LLM.MOTIVOS_MAX);
  assert.equal(props.motivos.items.minLength, 1);
  assert.equal(props.motivos.items.maxLength, LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS);
  assert.equal(props.policy_ids.maxItems, LIMITES_DICTAMEN_LLM.POLICY_IDS_MAX);
  assert.equal(props.policy_ids.items.maxLength, LIMITES_DICTAMEN_LLM.POLICY_ID_MAX_CHARS);
  assert.equal(props.monto_recomendado.maxLength, LIMITES_DICTAMEN_LLM.MONTO_MAX_CHARS);
});

test('los limites del schema son 5 motivos de 350 caracteres', () => {
  assert.equal(LIMITES_DICTAMEN_LLM.MOTIVOS_MAX, 5);
  assert.equal(LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS, 350);
});
