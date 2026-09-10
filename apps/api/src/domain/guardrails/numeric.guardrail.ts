import type { Indicadores } from '@credit/contracts';
import { ratiosEqual } from '@credit/contracts';
import { fail, ok, type GuardrailFinding, type GuardrailOutcome } from './types.js';

/**
 * G2 — Coherencia numerica.
 *
 * Los indicadores del dictamen persistido SIEMPRE vienen del backend. Si el
 * modelo devuelve indicadores y difieren de los autoritativos se rechaza la
 * persistencia: significa que esta intentando sustituir el calculo.
 */
export function verificarCoherenciaNumerica(
  autoritativos: Indicadores,
  delModelo: Partial<Indicadores> | null | undefined,
): GuardrailOutcome {
  if (!delModelo) return ok();

  const campos = [
    'razon_endeudamiento',
    'margen_neto',
    'cobertura_servicio_deuda',
    'relacion_monto_ventas',
    'cuota_anual_estimada',
  ] as const;

  const findings: GuardrailFinding[] = [];

  for (const campo of campos) {
    const propuesto = delModelo[campo];
    if (propuesto === undefined) continue;
    if (!ratiosEqual(autoritativos[campo], propuesto as string | null)) {
      findings.push({
        guardrail: 'G2',
        code: 'INDICATOR_MISMATCH',
        message: `El indicador ${campo} propuesto por el modelo no coincide con el calculo autoritativo`,
        details: { campo, autoritativo: autoritativos[campo], propuesto },
      });
    }
  }

  if (delModelo.antiguedad_meses !== undefined && delModelo.antiguedad_meses !== autoritativos.antiguedad_meses) {
    findings.push({
      guardrail: 'G2',
      code: 'INDICATOR_MISMATCH',
      message: 'La antiguedad propuesta por el modelo no coincide con la autoritativa',
      details: { campo: 'antiguedad_meses', autoritativo: autoritativos.antiguedad_meses, propuesto: delModelo.antiguedad_meses },
    });
  }

  // Mismatch numerico = rechazar persistencia, no degradar a escalamiento.
  return findings.length > 0 ? fail(findings, false) : ok();
}
