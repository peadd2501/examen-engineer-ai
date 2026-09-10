import type { Solicitud } from './application.js';

/**
 * COBERTURA — ¿existe política aplicable a esta solicitud?
 *
 * Pregunta distinta de la de G1: G1 responde "¿esta cita EXISTE en el corpus?"
 * (integridad); aquí, "¿el corpus LEGISLA esta operación?" (aplicabilidad). G1 no
 * se toca ni se relaja.
 *
 * Hace falta porque, con el corpus completo en el contexto, siempre hay reglas
 * generales que "aplican" a cualquier solicitud cuyos números estén en rango. El
 * modelo no puede emitir este juicio: solo ve las políticas que existen, nunca
 * las que faltan.
 *
 * Respaldo en el corpus: POL-1.2, POL-10.2 y POL-10.3 enuncian el mismo principio
 * —"no puede resolverse automáticamente -> comité"—, y POL-1.1 y POL-6.1
 * delimitan el producto y su moneda. LIMITACIÓN DECLARADA: ninguna política dice
 * literalmente que una operación fuera del producto se escale; extenderlo ahí es
 * una inferencia, y es la lectura conservadora — la alternativa, aprobar algo que
 * ninguna política regula, no tiene respaldo de ningún tipo.
 *
 * El destino de fondos se inspecciona aquí determinísticamente en el backend,
 * nunca como instrucción, y solo puede empujar hacia la revisión humana: escribir
 * "carta de crédito en euros" únicamente consigue escalar la propia solicitud.
 */

export type CodigoSinCobertura =
  | 'SECTOR_NO_RESOLUBLE'
  | 'MONEDA_FUERA_DE_ALCANCE'
  | 'INSTRUMENTO_FUERA_DE_ALCANCE';

export interface MotivoSinCobertura {
  codigo: CodigoSinCobertura;
  /** Política del corpus que sustenta el escalamiento. */
  politica: string;
  detalle: string;
  /** true cuando la política lo dice literalmente; false si es inferencia. */
  literal: boolean;
}

export interface EvaluacionCobertura {
  /** false = ninguna política del corpus regula esta operación. */
  cubierta: boolean;
  motivos: MotivoSinCobertura[];
}

/** POL-1.2: sectores que el corpus admite resolver automáticamente. */
export const SECTORES_RESOLUBLES = [
  'comercio',
  'manufactura',
  'servicios',
  'agropecuario',
  'transporte',
  'construccion',
] as const;

/**
 * Monedas distintas del quetzal. Todos los topes del corpus están en Q, así que
 * una operación denominada en otra moneda no tiene límite aplicable.
 */
const MARCADORES_MONEDA: Array<{ nombre: string; re: RegExp }> = [
  { nombre: 'euro', re: /\beuros?\b|\bEUR\b|€/i },
  { nombre: 'dolar', re: /\bd[oó]lar(es)?\b|\bUSD\b/i },
  { nombre: 'otra divisa', re: /\b(yen(es)?|libras? esterlinas?|francos? suizos?|yuan(es)?)\b/i },
  { nombre: 'moneda extranjera', re: /\b(moneda extranjera|divisas?|cobertura cambiaria|tipo de cambio|riesgo cambiario)\b/i },
];

/**
 * Instrumentos financieros que no son el crédito PyME que el corpus legisla.
 *
 * Cada entrada nombra un INSTRUMENTO, nunca una actividad: "importación",
 * "exportación" y "comercio exterior" estuvieron aquí y se quitaron, porque una
 * PyME que importa insumos con un crédito PyME ordinario está cubierta y
 * escalarla era un falso positivo. Lo que saca del alcance es el instrumento o la
 * moneda, no el origen de la mercadería.
 */
const MARCADORES_INSTRUMENTO: Array<{ nombre: string; re: RegExp }> = [
  { nombre: 'carta de credito', re: /\bcartas? de cr[eé]dito\b|\bcr[eé]ditos? documentarios?\b/i },
  { nombre: 'arrendamiento financiero', re: /\bleasing\b|\barrendamiento financiero\b/i },
  { nombre: 'aval o fianza', re: /\b(avales?|fianzas?|garant[ií]as? bancarias?|stand ?by)\b/i },
  { nombre: 'descuento de documentos', re: /\bdescuento de (documentos|facturas)\b|\bforfaiting\b/i },
];

function primerMarcador(texto: string, marcadores: Array<{ nombre: string; re: RegExp }>): string | null {
  return marcadores.find((m) => m.re.test(texto))?.nombre ?? null;
}

/**
 * Evalúa si el corpus vigente regula la operación solicitada.
 *
 * No mira si los indicadores están en rango —de eso se ocupan la decisión y el
 * nivel de riesgo—, sino si existe norma aplicable. Una solicitud puede tener
 * números impecables y aun así no estar cubierta.
 */
export function evaluarCobertura(solicitud: Solicitud): EvaluacionCobertura {
  const motivos: MotivoSinCobertura[] = [];
  const destino = solicitud.destino_fondos;

  // --- POL-1.2, literal ----------------------------------------------------
  if (!(SECTORES_RESOLUBLES as readonly string[]).includes(solicitud.sector)) {
    motivos.push({
      codigo: 'SECTOR_NO_RESOLUBLE',
      politica: 'POL-1.2',
      detalle: `El sector "${solicitud.sector}" no figura entre los sectores que el corpus admite resolver automaticamente`,
      literal: true,
    });
  }

  // --- Fuera del producto que el corpus legisla (inferencia declarada) ------
  const moneda = primerMarcador(destino, MARCADORES_MONEDA);
  if (moneda !== null) {
    motivos.push({
      codigo: 'MONEDA_FUERA_DE_ALCANCE',
      politica: 'POL-6.1',
      detalle: `La operacion declara ${moneda}; todos los topes del corpus estan expresados en quetzales`,
      literal: false,
    });
  }

  const instrumento = primerMarcador(destino, MARCADORES_INSTRUMENTO);
  if (instrumento !== null) {
    motivos.push({
      codigo: 'INSTRUMENTO_FUERA_DE_ALCANCE',
      politica: 'POL-6.1',
      detalle: `La operacion declara ${instrumento}, que no es el producto de credito PyME que el corpus regula`,
      literal: false,
    });
  }

  return { cubierta: motivos.length === 0, motivos };
}
