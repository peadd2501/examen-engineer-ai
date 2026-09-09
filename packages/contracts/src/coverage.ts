import type { Solicitud } from './application.js';

/**
 * COBERTURA — ¿existe política aplicable a esta solicitud?
 *
 * Es una pregunta distinta de las que ya responden los otros guardarraíles, y
 * la distinción importa:
 *
 *   G1  responde "¿esta cita EXISTE en el corpus?"        -> integridad
 *   aquí responde "¿el corpus LEGISLA esta operación?"    -> aplicabilidad
 *
 * Una política puede existir y estar correctamente citada, y aun así no aplicar
 * al caso. G1 no se toca ni se relaja: sigue exigiendo que toda cita sea real.
 *
 * === POR QUE HACE FALTA ===
 *
 * Desde FASE 3.1 el corpus completo viaja en el contexto. Eso arregló que el
 * modelo decidiera sobre evidencia equivocada, pero introdujo el problema
 * inverso: con las 30 políticas a la vista, siempre hay reglas generales
 * (endeudamiento, score, garantía) que "aplican" a cualquier solicitud cuyos
 * números estén en rango. El modelo concluye que puede aprobar aunque no exista
 * ninguna política que regule la operación que se le está pidiendo financiar.
 *
 * La cobertura no puede depender del modelo: es exactamente el juicio que el
 * modelo no está en posición de emitir, porque solo ve las políticas que sí
 * existen y nunca las que faltan.
 *
 * === RESPALDO EN EL CORPUS ===
 *
 * El corpus enuncia UN principio de escalamiento, tres veces, siempre con la
 * misma forma — "no puede resolverse automáticamente -> comité":
 *
 *   POL-1.2   sector `otros`: "no pueden resolverse automáticamente y deben
 *             escalarse a comité". Literal y directamente aplicable.
 *   POL-10.2  información financiera inconsistente -> comité.
 *   POL-10.3  indicador obligatorio no calculable -> comité.
 *
 * Y delimita el producto que legisla:
 *
 *   POL-1.1   "elegible a cualquier producto de crédito PyME".
 *   POL-6.1   "el monto máximo autorizable para el producto de crédito PyME es
 *             de Q500,000.00" — junto con POL-1.3, POL-4.1, POL-4.2, POL-4.3,
 *             POL-5.2 y POL-8.1, TODOS los límites del corpus están expresados
 *             en quetzales.
 *
 * LIMITACIÓN DECLARADA: ninguna política dice literalmente "una operación fuera
 * del producto se escala". Extender a ese caso el principio de escalamiento que
 * el corpus sí enuncia es una inferencia, y queda anotada como tal. Es la
 * lectura conservadora: la alternativa —aprobar automáticamente una operación
 * que ninguna política regula, con topes fijados en otra moneda— no tiene
 * respaldo de ningún tipo. Ante ausencia de norma, decide un humano.
 *
 * === POR QUE EL DESTINO DE FONDOS, SIENDO TEXTO NO CONFIABLE ===
 *
 * POL-1.4 obliga a tratar el destino como dato no verificado, y G5 lo mantiene
 * fuera del contexto decisional del modelo. Aquí NO se usa como instrucción:
 * se inspecciona determinísticamente en el backend, y solo puede empujar en una
 * dirección — hacia la revisión humana. Un atacante que escriba "carta de
 * crédito en euros" consigue únicamente que su propia solicitud escale a un
 * analista. No existe combinación de texto que apruebe nada.
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
 * Cada uno tiene su propia normativa —plazos, comisiones, contragarantías— que
 * este corpus no contiene.
 *
 * Cada entrada nombra un INSTRUMENTO, nunca una actividad. "Importación",
 * "exportación" o "comercio exterior" estuvieron aquí y se quitaron: describen
 * lo que la empresa hace, no el producto financiero que pide, y una PyME que
 * importa insumos con un crédito PyME ordinario está perfectamente cubierta.
 * Escalarla habría sido un falso positivo. Lo que saca a una operación del
 * alcance es el instrumento (una carta de crédito) o la moneda, no el origen de
 * la mercadería.
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
