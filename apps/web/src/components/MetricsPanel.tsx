import { useEffect, useState } from 'react';
import type { MetricasCartera } from '@credit/contracts';
import { api } from '../services/api.js';
import { comoQuetzales } from '../features/analysis/format.js';

/** Métricas de cartera, tomadas de la misma fuente que la tool `metricas_cartera`. */
export function MetricsPanel({ refrescar }: { refrescar: number }) {
  const [m, setM] = useState<MetricasCartera | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    api.metrics()
      .then((r) => { if (!cancelado) { setM(r); setError(null); } })
      .catch((e: unknown) => { if (!cancelado) setError(e instanceof Error ? e.message : 'error'); });
    return () => { cancelado = true; };
  }, [refrescar]);

  if (error) return <section className="panel"><p className="err pad">No se pudieron cargar las métricas: {error}</p></section>;
  if (!m) return <section className="panel"><p className="muted pad">Cargando métricas…</p></section>;

  const pct = (n: number): string => `${(n * 100).toFixed(1)} %`;
  const aprobados = m.por_decision['APROBADO'] ?? 0;
  const tasaAprobacion = m.total_dictamenes === 0 ? 0 : aprobados / m.total_dictamenes;
  const pendientes = m.por_estado_operativo['PENDING_AUTHORIZATION'] ?? 0;
  const comite = m.por_estado_operativo['PENDING_COMMITTEE'] ?? 0;

  return (
    <section className="panel">
      <header className="panel__head"><h2>Métricas de cartera</h2></header>
      <div className="cards">
        <Card etiqueta="Solicitudes" valor={String(m.total_solicitudes)} />
        <Card etiqueta="Dictámenes emitidos" valor={String(m.total_dictamenes)} />
        <Card etiqueta="Tasa de aprobación" valor={pct(tasaAprobacion)} />
        <Card etiqueta="Tasa de escalamiento" valor={pct(m.tasa_escalamiento)} />
        <Card etiqueta="Pendientes de autorización" valor={String(pendientes)} />
        <Card etiqueta="Pendientes de comité" valor={String(comite)} />
        <Card etiqueta="Monto promedio recomendado" valor={comoQuetzales(m.monto_promedio_recomendado)} />
      </div>

      <h3>Distribución por decisión</h3>
      <table className="tabla">
        <tbody>
          {Object.entries(m.por_decision).map(([k, v]) => (
            <tr key={k}><th>{k}</th><td className="num">{v}</td></tr>
          ))}
          {Object.keys(m.por_decision).length === 0 && <tr><td className="muted">Sin dictámenes todavía.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function Card({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="card">
      <span className="card__valor">{valor}</span>
      <span className="card__etiqueta">{etiqueta}</span>
    </div>
  );
}
