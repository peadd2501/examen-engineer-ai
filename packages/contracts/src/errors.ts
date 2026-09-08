/** Errores tipados del dominio. La capa HTTP los mapea a status codes. */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ApplicationNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Solicitud no encontrada: ${id}`, 'APPLICATION_NOT_FOUND', { id });
  }
}

export class InvalidFinancialDataError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_FINANCIAL_DATA', details);
  }
}

export class PolicyNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Politica no encontrada: ${id}`, 'POLICY_NOT_FOUND', { id });
  }
}

export class InvalidCitationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_CITATION', details);
  }
}

export class GuardrailViolationError extends DomainError {
  readonly guardrail: 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
  constructor(guardrail: 'G1' | 'G2' | 'G3' | 'G4' | 'G5', message: string, details?: unknown) {
    super(message, `GUARDRAIL_${guardrail}`, details);
    this.guardrail = guardrail;
  }
}

export class AgentSchemaValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'AGENT_SCHEMA_VALIDATION', details);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string, details?: unknown) {
    super(`Conflicto de idempotencia para la clave ${key}`, 'IDEMPOTENCY_CONFLICT', details);
  }
}

export class StateConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'STATE_CONFLICT', details);
  }
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly reason?: unknown;
  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.reason = reason;
  }
}

export class ProviderTimeoutError extends Error {
  readonly code = 'PROVIDER_TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}
