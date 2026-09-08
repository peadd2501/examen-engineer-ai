/**
 * Constantes de version. Se persisten en agent_runs para trazabilidad.
 * Cambiar cualquiera de estas obliga a re-ejecutar la evaluacion.
 */
export const PROMPT_VERSION = 'v2' as const;
export const POLICY_CORPUS_VERSION = '1.0' as const;
export const INDICATOR_CALC_VERSION = 1 as const;

/** Tope duro de autorizacion humana (G4). Quetzales. */
export const HUMAN_AUTHORIZATION_THRESHOLD_GTQ = '250000.00' as const;
