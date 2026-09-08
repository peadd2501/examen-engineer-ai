import type { ReactNode } from 'react';

export type Tono = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function Badge({ tono = 'neutral', children, title }: {
  tono?: Tono;
  children: ReactNode;
  title?: string;
}) {
  return <span className={`badge badge--${tono}`} title={title}>{children}</span>;
}

const TONO_DECISION: Record<string, Tono> = {
  APROBADO: 'ok',
  RECHAZADO: 'danger',
  ESCALADO_A_COMITE: 'warn',
};

const ETIQUETA_DECISION: Record<string, string> = {
  APROBADO: 'APROBADO',
  RECHAZADO: 'RECHAZADO',
  ESCALADO_A_COMITE: 'ESCALADO A COMITÉ',
};

export function DecisionBadge({ decision }: { decision: string }) {
  return <Badge tono={TONO_DECISION[decision] ?? 'neutral'}>{ETIQUETA_DECISION[decision] ?? decision}</Badge>;
}

const TONO_RIESGO: Record<string, Tono> = { BAJO: 'ok', MEDIO: 'warn', ALTO: 'danger' };

export function RiesgoBadge({ nivel }: { nivel: string }) {
  return <Badge tono={TONO_RIESGO[nivel] ?? 'neutral'}>Riesgo {nivel}</Badge>;
}

const ESTADO_OPERATIVO: Record<string, { etiqueta: string; tono: Tono }> = {
  DRAFT: { etiqueta: 'Borrador', tono: 'neutral' },
  GENERATED: { etiqueta: 'Generado', tono: 'info' },
  PENDING_AUTHORIZATION: { etiqueta: 'Pendiente de autorización', tono: 'warn' },
  PENDING_COMMITTEE: { etiqueta: 'Pendiente de comité', tono: 'warn' },
  CONFIRMED: { etiqueta: 'Confirmado por analista', tono: 'ok' },
  REJECTED_BY_ANALYST: { etiqueta: 'Rechazado por analista', tono: 'danger' },
};

export function EstadoOperativoBadge({ estado }: { estado: string }) {
  const info = ESTADO_OPERATIVO[estado] ?? { etiqueta: estado, tono: 'neutral' as Tono };
  return <Badge tono={info.tono} title={`operational_status = ${estado}`}>{info.etiqueta}</Badge>;
}
