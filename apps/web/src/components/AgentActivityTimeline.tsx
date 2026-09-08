import type { AgentEvent } from '@credit/contracts';
import type { EstadoAnalisis } from '../types/view.js';

/**
 * Timeline de actividad del agente.
 *
 * Muestra progreso, acciones y fuentes. No muestra razonamiento, prompt interno
 * ni el payload completo de las herramientas: solo nombre amigable, estado y
 * duración.
 */
const ICONO: Record<string, string> = {
  'run.started': '▶',
  'application.loaded': '✓',
  'indicators.loaded': '✓',
  'tool.started': '…',
  'tool.completed': '✓',
  'policy.found': '§',
  'guardrail.checked': '⛨',
  'dictamen.partial': '✓',
  'dictamen.completed': '✓',
  'run.completed': '✓',
  'run.failed': '✕',
  'run.cancelled': '⃠',
};

function detalle(evento: AgentEvent): string | null {
  const d = evento.data as Record<string, unknown> | undefined;
  if (!d) return null;

  if (evento.type === 'tool.completed' && typeof d['latency_ms'] === 'number') {
    return `${d['status'] === 'OK' ? 'OK' : 'ERROR'} · ${d['latency_ms']} ms`;
  }
  if (evento.type === 'policy.found') {
    const via = d['incluido_por_relacion'] === true ? ' · traída por relación regla↔excepción' : '';
    return `${String(d['seccion'] ?? '')}${via}`;
  }
  if (evento.type === 'indicators.loaded') return 'Fuente autoritativa: backend';
  if (evento.type === 'guardrail.checked') {
    const hallazgos = d['hallazgos'];
    if (Array.isArray(hallazgos) && hallazgos.length > 0) return `Hallazgos: ${hallazgos.join(', ')}`;
    if (typeof d['guardrail'] === 'string') return `Guardarraíl ${d['guardrail']}`;
    return 'Sin hallazgos bloqueantes';
  }
  return null;
}

export function AgentActivityTimeline({ eventos, estado }: { eventos: AgentEvent[]; estado: EstadoAnalisis }) {
  // El evento terminal lleva el resultado completo; en el timeline no aporta.
  const visibles = eventos.filter((e) => !(e.data && 'resultado' in (e.data as object)));

  return (
    <section className="panel panel--timeline">
      <header className="panel__head">
        <h2>Actividad del agente</h2>
        {estado === 'corriendo' && <span className="pulso">en ejecución</span>}
      </header>

      {visibles.length === 0 && (
        <p className="muted pad">
          {estado === 'corriendo' ? 'Iniciando…' : 'Sin actividad. Inicia un análisis para ver el detalle paso a paso.'}
        </p>
      )}

      <ol className="timeline">
        {visibles.map((e) => {
          const d = detalle(e);
          const falla = e.type === 'run.failed';
          const cancelado = e.type === 'run.cancelled';
          return (
            <li key={`${e.sequence}-${e.type}`} className={falla ? 'ev ev--err' : cancelado ? 'ev ev--warn' : 'ev'}>
              <span className="ev__icono">{ICONO[e.type] ?? '·'}</span>
              <div>
                <div className="ev__label">{e.label ?? e.type}</div>
                {d && <div className="ev__detalle muted">{d}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
