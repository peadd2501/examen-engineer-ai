import { LIMITES_DICTAMEN_LLM, type Indicadores, type Solicitud } from '@credit/contracts';
import type { CorpusContext } from './corpus-context.js';
import { resumirDestinoFondos } from '../domain/guardrails/untrusted-input.guardrail.js';
import { SYSTEM_PROMPT_V1 } from './prompts/system-v1.js';
import type { ChatMessage } from './openrouter-client.js';

/**
 * Construye el contexto decisional.
 *
 * FASE 3.3: el texto crudo de `destino_fondos` YA NO VIAJA al modelo.
 *
 * Antes se enviaba en un mensaje aparte, serializado con JSON.stringify. Eso
 * impedia que rompiera la estructura del mensaje, pero no impedia lo otro: que
 * compitiera por la atencion del modelo con las instrucciones legitimas.
 * Escapar no es lo mismo que excluir, y ningun delimitador ni ninguna
 * instruccion de "ignora lo que sigue" resuelve eso.
 *
 * En su lugar viaja `resumirDestinoFondos()`: una etiqueta de un vocabulario
 * cerrado de siete valores mas dos metricas. Un atacante puede elegir cual de
 * esas siete etiquetas se emite; no puede meter texto propio en el prompt.
 *
 * El texto crudo sigue existiendo: persistido en la base, visible en la UI como
 * dato no confiable, analizado por la deteccion de G5 y registrado como
 * hallazgo. Lo unico que cambia es que no entra en la llamada que decide.
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
 * Los limites de tamano son EXACTAMENTE los de `DictamenLLMSchema`: se leen de
 * la misma constante, para que no puedan divergir. El proveedor los aplica
 * durante la generacion; Zod los vuelve a aplicar despues, porque no todo
 * proveedor respeta el schema.
 *
 * `policy_ids` lleva como `enum` los identificadores reales del corpus de este
 * run. Un modelo que respete el schema no puede devolver POL-ELIG-001 ni
 * ningun otro identificador inventado: el valor no esta en el enum. Es la
 * defensa que actua ANTES de G1, no en lugar de G1.
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
 * Se construye DESDE CERO. No incluye:
 *  - la salida truncada anterior (reenviar 5000 tokens rotos invita a repetirlos);
 *  - el historial de herramientas;
 *  - el texto crudo del solicitante;
 *  - los textos completos de las politicas.
 *
 * Incluye solo lo autoritativo minimo para poder emitir el dictamen: los
 * indicadores calculados por el backend, los datos estructurados de la
 * solicitud y un indice compacto de politicas (id, seccion y categoria). El
 * modelo solo devuelve identificadores, asi que no necesita los textos.
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
