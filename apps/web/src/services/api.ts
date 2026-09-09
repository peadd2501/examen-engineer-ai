import type { Indicadores, MetricasCartera, Solicitud } from '@credit/contracts';
import type { AnalisisResultado } from '../types/view.js';
import { BASE_URL } from './base-url.js';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      body?.error?.code ?? `HTTP_${response.status}`,
      body?.error?.message ?? `Error ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export interface VersionInfo {
  prompt_version: string;
  policy_corpus_version: string;
  indicator_calc_version: number;
  config: { model?: string; agent_provider?: string; llm_configured?: boolean; reasoning_effort?: string };
}

export interface RunDetalle {
  run: Record<string, unknown>;
  iteraciones: Array<Record<string, unknown>>;
  tool_calls: Array<{ sequence: number; tool_name: string; status: string; latency_ms: number | null }>;
  hallazgos: Array<{ guardrail: string; code: string; message: string }>;
}

export const api = {
  baseUrl: BASE_URL,
  version: () => request<VersionInfo>('/version'),
  health: () => request<{ status: string; database: string }>('/health/db'),
  applications: (limit = 60) =>
    request<{ items: Solicitud[] }>(`/api/applications?limit=${limit}`),
  application: (id: string) => request<Solicitud>(`/api/applications/${id}`),
  indicators: (id: string) => request<Indicadores>(`/api/applications/${id}/indicators`),
  decisionDeSolicitud: (id: string) => request<Record<string, unknown>>(`/api/applications/${id}/decision`),
  run: (id: string) => request<RunDetalle>(`/api/runs/${id}`),
  metrics: () => request<MetricasCartera>('/api/metrics'),
  autorizar: (idDictamen: string, accion: 'CONFIRMAR' | 'RECHAZAR', analista = 'analista-demo') =>
    request<{ id_dictamen: string; operational_status: string; confirmed_at: string | null }>(
      `/api/decisions/${idDictamen}/authorize`,
      { method: 'POST', body: JSON.stringify({ accion, analista }) },
    ),
  /** Analisis sin streaming. Se conserva como respaldo; la UI usa el stream. */
  analizar: (id: string) =>
    request<AnalisisResultado>(`/api/applications/${id}/analyze`, { method: 'POST', body: '{}' }),
};
