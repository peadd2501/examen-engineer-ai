import type { Solicitud } from '@credit/contracts';
import { codigoFixture, type FiltroSolicitudes } from '../hooks/useApplications.js';
import { comoQuetzales, idCorto } from '../features/analysis/format.js';
import { Badge } from './StatusBadge.js';

interface Props {
  visibles: Solicitud[];
  seleccionada: string | null;
  onSeleccionar: (s: Solicitud) => void;
  cargando: boolean;
  error: string | null;
  filtro: FiltroSolicitudes;
  onFiltro: (f: FiltroSolicitudes) => void;
  busqueda: string;
  onBusqueda: (t: string) => void;
}

const FILTROS: Array<{ id: FiltroSolicitudes; etiqueta: string }> = [
  { id: 'fixtures', etiqueta: 'Casos de prueba' },
  { id: 'adversariales', etiqueta: 'Adversariales' },
  { id: 'todas', etiqueta: 'Todas' },
];

export function ApplicationList(p: Props) {
  return (
    <section className="panel panel--list">
      <header className="panel__head">
        <h2>Solicitudes</h2>
        <span className="muted">{p.visibles.length}</span>
      </header>

      <div className="filtros">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`chip ${p.filtro === f.id ? 'chip--on' : ''}`}
            onClick={() => p.onFiltro(f.id)}
          >
            {f.etiqueta}
          </button>
        ))}
      </div>

      <input
        className="input"
        placeholder="Buscar por empresa o sector"
        value={p.busqueda}
        onChange={(e) => p.onBusqueda(e.target.value)}
      />

      {p.cargando && <p className="muted pad">Cargando solicitudes…</p>}
      {p.error && <p className="err pad">{p.error}</p>}

      <ul className="lista">
        {p.visibles.map((s) => {
          const codigo = codigoFixture(s.nombre_empresa);
          const montoAlto = Number(s.monto_solicitado) > 250_000;
          return (
            <li key={s.id_solicitud}>
              <button
                type="button"
                className={`fila ${p.seleccionada === s.id_solicitud ? 'fila--on' : ''}`}
                onClick={() => p.onSeleccionar(s)}
              >
                <div className="fila__top">
                  <strong>{codigo ?? s.nombre_empresa.slice(0, 26)}</strong>
                  <code className="muted">{idCorto(s.id_solicitud)}</code>
                </div>
                <div className="fila__sub">
                  {s.sector} · {comoQuetzales(s.monto_solicitado)} · {s.meses_operacion} meses
                </div>
                <div className="fila__sub muted">{s.fecha_solicitud}</div>
                {montoAlto && <Badge tono="warn">&gt; Q250,000</Badge>}
              </button>
            </li>
          );
        })}
        {!p.cargando && p.visibles.length === 0 && <li className="muted pad">Sin resultados.</li>}
      </ul>
    </section>
  );
}
