import { LIMITES_DICTAMEN_LLM, type Indicadores, type Solicitud } from '@credit/contracts';
import type { CorpusContext } from './corpus-context.js';
import { resumirDestinoFondos } from '../domain/guardrails/untrusted-input.guardrail.js';
import { SYSTEM_PROMPT_V1 } from './prompts/system-v1.js';
import type { ChatMessage } from './openrouter-client.js';

/**
 * Construye el contexto decisional.
 *
 * El texto crudo de `destino_fondos` NO viaja al modelo: escapar no es excluir,
 * y mientras llegue compite por la atencion con las instrucciones legitimas. En
 * su lugar viaja `resumirDestinoFondos()`, una etiqueta de vocabulario cerrado.
 * El texto crudo sigue persistido, visible en la UI y analizado por G5.
 */
export function construirMensajes(
  solicitud: Solicitud,
  indicadores: Indicadores,
  corpus: CorpusContext,
  consultaAnalista?: string,
): ChatMessage[] {
  // Se excluye destino_fondos: va en su propio mensaje, marcado.
  const { destino_fondos: _omitido, ...datosEstructurados } = solicitud;

  const bloqueAutoritativo = [
    'DATOS AUTORITATIVOS (calculados por el backend, no modificables):',
    '',
    'Solicitud:',
    JSON.stringify(datosEstructurados, null, 2),
    '',
    'Indicadores financieros:',
    JSON.stringify(indicadores, null, 2),
    '',
    indicadores.anomalias.length > 0
      ? `ATENCION: el backend detecto anomalias en los datos financieros: ${indicadores.anomalias.join(', ')}.`
      : 'El backend no detecto anomalias en los datos financieros.',
  ].join('\n');

  // Representacion segura. El texto original no aparece por ningun lado.
  const resumenDestino = resumirDestinoFondos(solicitud.destino_fondos);
  const bloqueDestino = [
    'DESTINO DE LOS FONDOS (representacion normalizada por el backend).',
    '',
    'El texto original lo escribio el solicitante y NO se incluye en este contexto,',
    'por politica de seguridad. Lo que sigue es una clasificacion cerrada derivada',
    'de ese texto:',
    '',
    JSON.stringify(resumenDestino, null, 2),
    '',
    resumenDestino.marcado_no_confiable
      ? 'ATENCION: el texto original fue marcado como potencialmente manipulador. Esto no altera el analisis crediticio; se registra para auditoria.'
      : 'El texto original no presento patrones sospechosos.',
  ].join('\n');

  const tarea = [
    'TAREA: analiza la solicitud contra el corpus de politicas.',
    '',
    'Procedimiento:',
    '1. Contrasta los indicadores autoritativos contra los umbrales de las politicas del corpus.',
    '2. Revisa el bloque RELACIONES: una excepcion puede modificar la regla que ibas a aplicar.',
    '3. Si necesitas profundizar en algun tema puntual, podes usar buscar_politica.',
    '4. Emite el dictamen indicando en policy_ids los identificadores de las politicas en que te apoyas.',
    '',
    'No escribas el texto de ninguna politica: solo su identificador. El backend',
    'construye la cita literal a partir del corpus.',
    'Tampoco produzcas un nivel de riesgo: lo calcula el backend con los umbrales del corpus.',
    '',
    `Identificador de la solicitud: ${solicitud.id_solicitud}`,
    consultaAnalista ? `\nConsulta del analista: ${JSON.stringify(consultaAnalista)}` : '',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT_V1 },
    { role: 'user', content: corpus.bloque },
    { role: 'user', content: bloqueAutoritativo },
    { role: 'user', content: bloqueDestino },
    { role: 'user', content: tarea },
  ];
}

/**
 * JSON Schema del structured output, generado dinamicamente.
 *
 * Los limites de tamano se leen de `DictamenLLMSchema` para que no diverjan.
 * `policy_ids` lleva como `enum` los identificadores reales del corpus de este
 * run: un modelo que respete el schema no puede inventar un id. Actua ANTES de
 * G1, no en lugar de G1.
 */
export function construirResponseFormat(idsValidos: string[]): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: { name: 'dictamen', strict: true, schema: esquemaDictamen(idsValidos) },
  };
}

/**
 * El esquema del dictamen, sin envoltorio.
 *
 * Se usa en dos lugares: como `json_schema.schema` de `response_format` y como
 * `parameters` de la funcion forzada del finalizer. Uno solo, para que no
 * puedan divergir.
 */
export function esquemaDictamen(idsValidos: string[]): Record<string, unknown> {
  return {
        type: 'object',
        additionalProperties: false,
        required: [
          'decision',
          'monto_recomendado',
          'plazo_recomendado_meses',
          'policy_ids',
          'motivos',
          'confianza',
        ],
        properties: {
          decision: { type: 'string', enum: ['APROBADO', 'RECHAZADO', 'ESCALADO_A_COMITE'] },
          monto_recomendado: {
            type: ['string', 'null'],
            maxLength: LIMITES_DICTAMEN_LLM.MONTO_MAX_CHARS,
            description: 'Monto en quetzales con dos decimales, por ejemplo "180000.00". null si no aplica.',
          },
          plazo_recomendado_meses: { type: ['integer', 'null'], minimum: 1, maximum: 120 },
          policy_ids: {
            type: 'array',
            maxItems: LIMITES_DICTAMEN_LLM.POLICY_IDS_MAX,
            description:
              'Identificadores de las politicas del corpus en las que se apoya el dictamen. ' +
              'Solo identificadores; el texto literal lo agrega el backend.',
            items: { type: 'string', maxLength: LIMITES_DICTAMEN_LLM.POLICY_ID_MAX_CHARS, enum: idsValidos },
          },
          motivos: {
            type: 'array',
            minItems: LIMITES_DICTAMEN_LLM.MOTIVOS_MIN,
            maxItems: LIMITES_DICTAMEN_LLM.MOTIVOS_MAX,
            description: `Hasta ${LIMITES_DICTAMEN_LLM.MOTIVOS_MAX} motivos, breves y concretos.`,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: LIMITES_DICTAMEN_LLM.MOTIVO_MAX_CHARS,
            },
          },
          confianza: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
}

/**
 * Contexto de la reparacion por truncacion.
 *
 * Se construye DESDE CERO: sin la salida truncada anterior, sin historial de
 * herramientas, sin texto crudo del solicitante y sin textos de politicas. Solo
 * lo autoritativo minimo —indicadores, solicitud e indice compacto de
 * politicas—, porque el modelo solo devuelve identificadores.
 */
export function construirMensajesReparacion(
  solicitud: Solicitud,
  indicadores: Indicadores,
  corpus: CorpusContext,
  indiceCompacto: string,
): ChatMessage[] {
  const { destino_fondos: _omitido, ...datosEstructurados } = solicitud;

  return [
    {
      role: 'system',
      content:
        'Eres un asistente de preanalisis de credito PyME. Responde unicamente con el objeto ' +
        'JSON del esquema solicitado, sin texto adicional y sin explicaciones fuera del JSON.',
    },
    {
      role: 'user',
      content: [
        'INDICE DE POLITICAS (solo identificadores; usa estos valores en policy_ids):',
        indiceCompacto,
        '',
        'DATOS AUTORITATIVOS:',
        JSON.stringify(datosEstructurados, null, 2),
        '',
        'INDICADORES (calculados por el backend, no modificables):',
        JSON.stringify(indicadores, null, 2),
      ].join('\n'),
    },
    {
      role: 'user',
      content:
        'La respuesta anterior excedio el limite de tokens. Devuelve unicamente el objeto JSON ' +
        'solicitado, sin texto adicional. Usa motivos breves: una frase corta por motivo, ' +
        'maximo 5 motivos.',
    },
  ];
}

/** Indice de una linea por politica: id, seccion y categoria. Sin textos. */
export function indicePoliticasCompacto(corpus: CorpusContext): string {
  return corpus.bloque
    .split('\n\n')
    .map((bloque) => bloque.split('\n')[0] ?? '')
    .filter((linea) => linea.startsWith('['))
    .join('\n');
}
