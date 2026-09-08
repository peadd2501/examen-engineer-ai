import { d } from './money.js';
import type { NivelRiesgo } from './enums.js';
import type { Solicitud } from './application.js';
import type { Indicadores } from './indicators.js';

/**
 * Nivel de riesgo autoritativo.
 *
 * MOTIVO DEL CAMBIO (FASE 3.3): `nivel_riesgo` lo generaba libremente el modelo
 * y alimentaba G4. En CASE-09 el modelo devolvio ALTO sin ningun respaldo del
 * corpus —la solicitud pide Q120,000 y tiene score 80— y G4 se activo
 * correctamente sobre un dato inventado. Un campo que decide si hace falta
 * firma humana no puede salir del modelo.
 *
 * Ahora se calcula aqui, de forma pura y deterministica, sobre los indicadores
 * autoritativos y los datos estructurados de la solicitud. Cada condicion cita
 * la politica que la sustenta.
 *
 * === QUE ES UN NIVEL DE RIESGO Y QUE NO ===
 *
 * Un incumplimiento de umbral (endeudamiento sobre 0.70, score bajo 60,
 * antiguedad insuficiente) es una CAUSAL DE RECHAZO, no un nivel de riesgo.
 * Son cosas distintas y confundirlas tiene una consecuencia concreta: POL-8.2
 * obliga a autorizacion humana ante riesgo ALTO, asi que marcar ALTO cada
 * rechazo haria que toda solicitud rechazada necesitara firma de un analista.
 * El corpus no dice eso en ninguna parte.
 *
 * La decision (aprobar, rechazar, escalar) sale de contrastar los indicadores
 * contra las politicas. El nivel de riesgo es otra cosa, y el corpus solo lo
 * define en dos situaciones. Los incumplimientos se registran igual, en
 * `incumplimientos`, para trazabilidad; simplemente no elevan el nivel.
 *
 * === LIMITACION DECLARADA: no se emite BAJO ===
 *
 * El corpus vigente (30 politicas) contiene UNA sola politica que asigna un
 * nivel de riesgo explicito: POL-3.2, que clasifica como ALTO el score entre 60
 * y 69. No existe ninguna politica que defina condiciones suficientes para
 * afirmar riesgo BAJO. (El borrador de 35 politicas tenia una POL-3.3 de "score
 * preferente" que hacia justamente eso, pero se elimino al recortar el corpus
 * al rango 25-30 pedido en FASE 2.)
 *
 * Inventar un umbral de BAJO seria exactamente lo que este cambio busca
 * eliminar: un numero sin respaldo decidiendo sobre autorizacion humana. Asi
 * que el sistema emite MEDIO o ALTO, y MEDIO es el valor por defecto cuando no
 * se cumple ninguna condicion de ALTO. Es la lectura conservadora: ante
 * ausencia de norma, no se afirma riesgo bajo.
 *
 * Consecuencia practica: ninguna aprobacion queda etiquetada BAJO. No afecta a
 * G4 (solo ALTO lo dispara) ni a los expected results de la evaluacion, que no
 * fijan `nivel_riesgo`. Ver docs/engineering-notes.md para la alternativa.
 */

export interface FactorRiesgo {
  codigo: string;
  /** Politica del corpus que sustenta la condicion. */
  politica: string;
  detalle: string;
}

export interface EvaluacionRiesgo {
  nivel: NivelRiesgo;
  /** Condiciones que elevaron el nivel a ALTO. Cada una cita su politica. */
  factores: FactorRiesgo[];
  /**
   * Umbrales incumplidos. Se registran para trazabilidad pero NO elevan el
   * nivel: alimentan la decision, no la necesidad de autorizacion humana.
   */
  incumplimientos: FactorRiesgo[];
  /** true cuando el nivel es MEDIO solo por ausencia de condiciones de ALTO. */
  medioPorDefecto: boolean;
}

// --- Umbrales, todos literales del corpus -----------------------------------
export const UMBRALES_RIESGO = {
  /** POL-3.1: score minimo. */
  SCORE_MINIMO: 60,
  /** POL-3.2: banda de vigilancia, clasificada ALTO por la propia politica. */
  SCORE_VIGILANCIA_MIN: 60,
  SCORE_VIGILANCIA_MAX: 69,
  /** POL-2.1: razon de endeudamiento maxima. */
  ENDEUDAMIENTO_MAXIMO: '0.70',
  /** POL-9.3: excepcion de endeudamiento para manufactura con hipotecaria. */
  ENDEUDAMIENTO_MAXIMO_EXCEPCION: '0.80',
  POL_9_3_MESES_MINIMOS: 48,
  /** POL-2.2: margen neto minimo. */
  MARGEN_MINIMO: '0.05',
  /** POL-2.3: cobertura de servicio de deuda minima. */
  COBERTURA_MINIMA: '1.20',
  /** POL-9.1: excepcion de cobertura con garantia hipotecaria. */
  COBERTURA_MINIMA_EXCEPCION: '1.05',
  POL_9_1_SCORE_MINIMO: 75,
  /** POL-2.4: relacion monto sobre ventas maxima. */
  RELACION_MONTO_VENTAS_MAXIMA: '0.50',
  /** POL-1.1 y POL-5.1: antiguedad minima general y agropecuaria. */
  ANTIGUEDAD_MINIMA: 12,
  ANTIGUEDAD_MINIMA_AGROPECUARIO: 24,
  /** POL-9.2: excepcion de antiguedad por historial preferente. */
  ANTIGUEDAD_MINIMA_EXCEPCION: 9,
  POL_9_2_SCORE_MINIMO: 85,
} as const;

const GARANTIAS_REALES = new Set(['prendaria', 'hipotecaria']);

/** POL-9.1: cobertura desde 1.05 con garantia hipotecaria y score >= 75. */
function aplicaExcepcionCobertura(s: Solicitud): boolean {
  return s.garantia_ofrecida === 'hipotecaria' && s.score_historial >= UMBRALES_RIESGO.POL_9_1_SCORE_MINIMO;
}

/** POL-9.2: antiguedad desde 9 meses con score >= 85 y garantia real. */
function aplicaExcepcionAntiguedad(s: Solicitud): boolean {
  return s.score_historial >= UMBRALES_RIESGO.POL_9_2_SCORE_MINIMO && GARANTIAS_REALES.has(s.garantia_ofrecida);
}

/** POL-9.3: endeudamiento hasta 0.80 en manufactura con hipotecaria y >48 meses. */
function aplicaExcepcionEndeudamiento(s: Solicitud): boolean {
  return (
    s.sector === 'manufactura' &&
    s.garantia_ofrecida === 'hipotecaria' &&
    s.meses_operacion > UMBRALES_RIESGO.POL_9_3_MESES_MINIMOS
  );
}

/**
 * Evalua el riesgo. Funcion pura: mismos datos, mismo resultado.
 * No lee `destino_fondos` — es texto del solicitante y no tiene autoridad.
 */
export function calcularNivelRiesgo(solicitud: Solicitud, indicadores: Indicadores): EvaluacionRiesgo {
  /** Elevan el nivel a ALTO. Solo lo que el corpus respalda como tal. */
  const factores: FactorRiesgo[] = [];
  /** Se registran, pero no elevan el nivel. */
  const incumplimientos: FactorRiesgo[] = [];
  const u = UMBRALES_RIESGO;

  // --- POL-3.2: la unica politica que asigna un nivel de riesgo explicito ---
  if (
    solicitud.score_historial >= u.SCORE_VIGILANCIA_MIN &&
    solicitud.score_historial <= u.SCORE_VIGILANCIA_MAX
  ) {
    factores.push({
      codigo: 'SCORE_EN_BANDA_DE_VIGILANCIA',
      politica: 'POL-3.2',
      detalle: `Score ${solicitud.score_historial} dentro de la banda ${u.SCORE_VIGILANCIA_MIN}-${u.SCORE_VIGILANCIA_MAX}, clasificada ALTO por la propia politica`,
    });
  }

  // --- Incumplimientos: causales de RECHAZO, no niveles de riesgo -----------
  // Se registran para trazabilidad. La decision los usa; G4 no.

  // POL-3.1: score por debajo del minimo.
  if (solicitud.score_historial < u.SCORE_MINIMO) {
    incumplimientos.push({
      codigo: 'SCORE_INSUFICIENTE',
      politica: 'POL-3.1',
      detalle: `Score ${solicitud.score_historial} por debajo del minimo de ${u.SCORE_MINIMO}`,
    });
  }

  // --- POL-10.2 y POL-10.3: informacion que no permite dictaminar ---
  if (indicadores.anomalias.length > 0) {
    factores.push({
      codigo: 'DATOS_INCONSISTENTES',
      politica: 'POL-10.2',
      detalle: `Anomalias detectadas: ${indicadores.anomalias.join(', ')}`,
    });
  }

  const noCalculables = (
    [
      ['razon_endeudamiento', indicadores.razon_endeudamiento],
      ['margen_neto', indicadores.margen_neto],
      ['cobertura_servicio_deuda', indicadores.cobertura_servicio_deuda],
      ['relacion_monto_ventas', indicadores.relacion_monto_ventas],
    ] as const
  ).filter(([, valor]) => valor === null).map(([campo]) => campo);

  if (noCalculables.length > 0) {
    factores.push({
      codigo: 'INDICADOR_NO_CALCULABLE',
      politica: 'POL-10.3',
      detalle: `Indicadores sin valor: ${noCalculables.join(', ')}`,
    });
  }

  // --- POL-2.1 (con excepcion POL-9.3): endeudamiento ---
  if (indicadores.razon_endeudamiento !== null) {
    const excepcion = aplicaExcepcionEndeudamiento(solicitud);
    const limite = excepcion ? u.ENDEUDAMIENTO_MAXIMO_EXCEPCION : u.ENDEUDAMIENTO_MAXIMO;
    if (d(indicadores.razon_endeudamiento).gt(d(limite))) {
      incumplimientos.push({
        codigo: 'ENDEUDAMIENTO_SOBRE_LIMITE',
        politica: excepcion ? 'POL-2.1 (con excepcion POL-9.3)' : 'POL-2.1',
        detalle: `Razon de endeudamiento ${indicadores.razon_endeudamiento} sobre el limite ${limite}`,
      });
    }
  }

  // --- POL-2.2: margen neto ---
  if (indicadores.margen_neto !== null && d(indicadores.margen_neto).lt(d(u.MARGEN_MINIMO))) {
    incumplimientos.push({
      codigo: 'MARGEN_BAJO_LIMITE',
      politica: 'POL-2.2',
      detalle: `Margen neto ${indicadores.margen_neto} por debajo del minimo ${u.MARGEN_MINIMO}`,
    });
  }

  // --- POL-2.3 (con excepcion POL-9.1): cobertura ---
  if (indicadores.cobertura_servicio_deuda !== null) {
    const excepcion = aplicaExcepcionCobertura(solicitud);
    const limite = excepcion ? u.COBERTURA_MINIMA_EXCEPCION : u.COBERTURA_MINIMA;
    if (d(indicadores.cobertura_servicio_deuda).lt(d(limite))) {
      incumplimientos.push({
        codigo: 'COBERTURA_BAJO_LIMITE',
        politica: excepcion ? 'POL-2.3 (con excepcion POL-9.1)' : 'POL-2.3',
        detalle: `Cobertura ${indicadores.cobertura_servicio_deuda} por debajo del minimo ${limite}`,
      });
    }
  }

  // --- POL-2.4: relacion monto sobre ventas ---
  if (
    indicadores.relacion_monto_ventas !== null &&
    d(indicadores.relacion_monto_ventas).gt(d(u.RELACION_MONTO_VENTAS_MAXIMA))
  ) {
    incumplimientos.push({
      codigo: 'RELACION_MONTO_VENTAS_SOBRE_LIMITE',
      politica: 'POL-2.4',
      detalle: `Relacion monto/ventas ${indicadores.relacion_monto_ventas} sobre el maximo ${u.RELACION_MONTO_VENTAS_MAXIMA}`,
    });
  }

  // --- POL-1.1 y POL-5.1 (con excepcion POL-9.2): antiguedad ---
  const minimoAntiguedad =
    solicitud.sector === 'agropecuario' ? u.ANTIGUEDAD_MINIMA_AGROPECUARIO : u.ANTIGUEDAD_MINIMA;
  const minimoEfectivo = aplicaExcepcionAntiguedad(solicitud)
    ? Math.min(minimoAntiguedad, u.ANTIGUEDAD_MINIMA_EXCEPCION)
    : minimoAntiguedad;

  if (solicitud.meses_operacion < minimoEfectivo) {
    incumplimientos.push({
      codigo: 'ANTIGUEDAD_INSUFICIENTE',
      politica: solicitud.sector === 'agropecuario' ? 'POL-5.1' : 'POL-1.1',
      detalle: `${solicitud.meses_operacion} meses de operacion, por debajo del minimo de ${minimoEfectivo}`,
    });
  }

  // --- POL-1.2: sector no resoluble automaticamente ---
  if (solicitud.sector === 'otros') {
    incumplimientos.push({
      codigo: 'SECTOR_NO_RESOLUBLE',
      politica: 'POL-1.2',
      detalle: 'El sector "otros" no puede resolverse automaticamente',
    });
  }

  if (factores.length > 0) {
    return { nivel: 'ALTO', factores, incumplimientos, medioPorDefecto: false };
  }

  // Sin condicion de ALTO. No se afirma BAJO porque el corpus no define
  // ninguna condicion suficiente para hacerlo. Ver el comentario de cabecera.
  return { nivel: 'MEDIO', factores: [], incumplimientos, medioPorDefecto: true };
}
