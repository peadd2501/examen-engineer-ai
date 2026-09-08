import { z } from 'zod';

/**
 * Eventos SSE. Se transmite progreso y resultados seguros;
 * nunca chain-of-thought ni tokens internos del modelo.
 */
export const AGENT_EVENT_TYPES = [
  'run.started',
  'application.loaded',
  'indicators.loaded',
  'tool.started',
  'tool.completed',
  'policy.found',
  'dictamen.partial',
  'dictamen.completed',
  'guardrail.checked',
  'run.completed',
  'run.failed',
  'run.cancelled',
] as const;

export const AgentEventTypeSchema = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z.object({
  type: AgentEventTypeSchema,
  run_id: z.string().uuid(),
  sequence: z.number().int().min(0),
  at: z.string(),
  /** Mensaje corto y seguro para mostrar en UI */
  label: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;
