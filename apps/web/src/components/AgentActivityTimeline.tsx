import type { AgentEvent } from '@credit/contracts';
import type { EstadoAnalisis } from '../types/view.js';

/**
 * Progreso del análisis, paso a paso.
 *
 * Secundario al chat: compacto, sin fondo propio y con marcas simples. Muestra
 * progreso, acciones y fuentes. No muestra razonamiento, instrucciones internas
 * ni el payload completo de las consultas: solo nombre amigable, estado y
 * duración.
 */

type TonoPaso = 'ok' | 'activo' | 'error' | 'aviso';

interface Paso {
  clave: string;
  marca: string;
  tono: TonoPaso;
  texto: string;
  detalle: string | null;
}

function detalle(evento: AgentEvent): string | null {
  const d = evento.data as Record<string, unknown> | undefined;
  if (!d) return null;

  if (evento.type === 'tool.completed' && typeof d['latency_ms'] === 'number') {
    return `${d['status'] === 'OK' ? 'OK' : 'error'} · ${d['latency_ms']} ms`;
  }
  if (evento.type === 'policy.found') {
    const via = d['incluido_por_relacion'] === true ? ' · traída por relación regla↔excepción' : '';
    return `${String(d['seccion'] ?? '')}${via}`;
  }
  if (evento.type === 'guardrail.checked') {
    const hallazgos = d['hallazgos'];
    if (Array.isArray(hallazgos) && hallazgos.length > 0) return `Hallazgos: ${hallazgos.join(', ')}`;
    return null;
  }
  return null;
}

function tonoDe(tipo: string): TonoPaso {
  if (tipo === 'run.failed') return 'error';
  if (tipo === 'run.cancelled') return 'aviso';
  if (tipo === 'tool.started') return 'activo';
  return 'ok';
}

const MARCA: Record<TonoPaso, string> = { ok: '✓', activo: '○', error: '✕', aviso: '⃠' };

export function AgentActivityTimeline({ eventos, estado }: { eventos: AgentEvent[]; estado: EstadoAnalisis }) {
  // El evento terminal lleva el resultado completo; en el progreso no aporta.
  const visibles = eventos.filter((e) => !(e.data && 'resultado' in (e.data as object)));

  const pasos: Paso[] = visibles.map((e) => {
    const tono = tonoDe(e.type);
    return {
      clave: `${e.sequence}-${e.type}`,
      marca: MARCA[tono],
      tono,
      texto: e.label ?? e.type,
      detalle: detalle(e),
    };
  });

  // Mientras corre y todavía no llegó ningún evento de dictamen, se muestra
  // explícitamente lo que falta. Es un pendiente real, no un paso inventado.
  if (estado === 'corriendo' && !visibles.some((e) => e.type.startsWith('dictamen.'))) {
    pasos.push({ clave: 'pendiente-dictamen', marca: '○', tono: 'activo', texto: 'Generando dictamen', detalle: null });
  }

  return (
    <section className="panel panel--progreso">
      <header className="panel__head">
        <h2>Progreso del análisis</h2>
        {estado === 'corriendo' && <span className="pulso">en ejecución</span>}
      </header>

      {pasos.length === 0 && (
        <p className="muted small">{estado === 'corriendo' ? 'Iniciando…' : 'Sin actividad todavía.'}</p>
      )}

      <ol className="progreso">
        {pasos.map((p) => (
          <li key={p.clave} className={`paso paso--${p.tono}`}>
            <span className="paso__marca" aria-hidden="true">{p.marca}</span>
            <span>
              {p.texto}
              {p.detalle && <span className="paso__detalle"> · {p.detalle}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
