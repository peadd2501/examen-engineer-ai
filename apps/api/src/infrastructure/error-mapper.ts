import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  ApplicationNotFoundError,
  AgentSchemaValidationError,
  DomainError,
  GuardrailViolationError,
  IdempotencyConflictError,
  InvalidCitationError,
  InvalidFinancialDataError,
  PolicyNotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  StateConflictError,
} from '@credit/contracts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Un unico punto de traduccion error de dominio -> status HTTP. */
/** Detecta errores que exponen su codigo sin obligar a importar su clase. */
function codigoDe(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function statusForError(error: unknown): number {
  if (error instanceof ZodError) return 400;
  // El proveedor sin configurar es un problema de despliegue, no un bug: la UI
  // tiene que poder decirle al analista que revise OPENROUTER_API_KEY.
  if (codigoDe(error) === 'PROVIDER_NOT_CONFIGURED') return 503;
  if (error instanceof ApplicationNotFoundError) return 404;
  if (error instanceof PolicyNotFoundError) return 404;
  if (error instanceof IdempotencyConflictError) return 409;
  if (error instanceof StateConflictError) return 409;
  if (error instanceof GuardrailViolationError) return 422;
  if (error instanceof AgentSchemaValidationError) return 422;
  if (error instanceof InvalidCitationError) return 422;
  if (error instanceof InvalidFinancialDataError) return 422;
  if (error instanceof ProviderTimeoutError) return 504;
  if (error instanceof ProviderUnavailableError) return 502;
  if (error instanceof DomainError) return 400;
  return 500;
}

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ZodError) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Entrada invalida',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  if (codigoDe(error) === 'PROVIDER_NOT_CONFIGURED') {
    return {
      error: {
        code: 'PROVIDER_NOT_CONFIGURED',
        message: error instanceof Error ? error.message : 'Proveedor de IA no configurado',
      },
    };
  }
  if (error instanceof DomainError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof ProviderUnavailableError || error instanceof ProviderTimeoutError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'Error interno' } };
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const status = statusForError(error);
  if (status >= 500) request.log.error({ err: error }, 'error no controlado');
  else request.log.warn({ err: error }, 'error controlado');
  void reply.status(status).send(toErrorBody(error));
}
