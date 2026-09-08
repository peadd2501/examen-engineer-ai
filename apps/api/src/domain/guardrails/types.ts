export type GuardrailId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';

export interface GuardrailFinding {
  guardrail: GuardrailId;
  code: string;
  message: string;
  details?: unknown;
}

export interface GuardrailOutcome {
  passed: boolean;
  findings: GuardrailFinding[];
  /** true cuando el hallazgo obliga a degradar la decision a ESCALADO_A_COMITE. */
  forceEscalation: boolean;
}

export function ok(): GuardrailOutcome {
  return { passed: true, findings: [], forceEscalation: false };
}

export function fail(findings: GuardrailFinding[], forceEscalation: boolean): GuardrailOutcome {
  return { passed: false, findings, forceEscalation };
}
