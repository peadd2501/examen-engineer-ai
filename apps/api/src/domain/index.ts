/**
 * Nucleo de dominio de la API.
 * Las formulas financieras puras viven en @credit/contracts (indicators-calc)
 * porque las comparten API, seed y evaluacion. Aqui se reexportan para que
 * el resto de la API tenga un unico punto de entrada al dominio.
 */
export {
  calcularIndicadores,
  cuotaAnualEstimada,
  detectarAnomalias,
} from '@credit/contracts';
export * from './risk.js';
