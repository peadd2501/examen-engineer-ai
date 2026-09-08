import type { Indicadores, Solicitud } from '@credit/contracts';

const BASE_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface VersionInfo {
  prompt_version: string;
  policy_corpus_version: string;
  indicator_calc_version: number;
  config: Record<string, unknown>;
}

export const api = {
  version: () => request<VersionInfo>('/version'),
  dbHealth: () => request<{ status: string; database: string }>('/health/db'),
  applications: (limit = 20) =>
    request<{ items: Solicitud[]; limit: number; offset: number }>(`/api/applications?limit=${limit}`),
  indicators: (id: string) => request<Indicadores>(`/api/applications/${id}/indicators`),
};
