import type { Solicitud } from '@credit/contracts';
import { codigoFixture, type FiltroSolicitudes } from '../hooks/useApplications.js';
import { comoQuetzales } from '../features/analysis/format.js';

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

/**
 * Listado de solicitudes.
 *
 * Jerarquia: nombre o codigo del caso primero, monto a la derecha, y el resto
 * de metadatos en una linea secundaria de menor peso. Las marcas (monto alto,
 * caso adversarial) son etiquetas discretas, no badges de color saturado.
 */
export function ApplicationList(p: Props) {
  return (
    <section className="panel panel--list">
      <header className="panel__head">
        <h2>Solicitudes</h2>
        <span className="muted small">{p.visibles.length}</span>
      </header>

      <div className="filtros">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`chip ${p.filtro === f.id ? 'chip--on' : ''}`}
            aria-pressed={p.filtro === f.id}
            onClick={() => p.onFiltro(f.id)}
          >
            {f.etiqueta}
          </button>
        ))}
      </div>

      <input
        className="input"
        placeholder="Buscar por empresa o sector"
        aria-label="Buscar solicitudes"
        value={p.busqueda}
        onChange={(e) => p.onBusqueda(e.target.value)}
      />

      {p.cargando && <p className="muted pad">Cargando solicitudes…</p>}
      {p.error && <p className="err pad">{p.error}</p>}

      <ul className="lista">
        {p.visibles.map((s) => {
          const codigo = codigoFixture(s.nombre_empresa);
          const adversarial = codigo?.startsWith('ADV-') ?? false;
          const montoAlto = Number(s.monto_solicitado) > 250_000;
          const elegida = p.seleccionada === s.id_solicitud;
          return (
            <li key={s.id_solicitud}>
              <button
                type="button"
                className={`fila ${elegida ? 'fila--on' : ''}`}
                aria-current={elegida ? 'true' : undefined}
                onClick={() => p.onSeleccionar(s)}
              >
                <div className="fila__top">
                  <span className="fila__nombre">{codigo ?? s.nombre_empresa.slice(0, 24)}</span>
                  <span className="fila__monto">{comoQuetzales(s.monto_solicitado)}</span>
                </div>
                <div className="fila__sub">
                  <span>{s.sector}</span>
                  <span>·</span>
                  <span>{s.meses_operacion} meses</span>
                  {montoAlto && <span className="marca marca--warn">Autorización</span>}
                  {adversarial && <span className="marca marca--danger">Adversarial</span>}
                </div>
              </button>
            </li>
          );
        })}
        {!p.cargando && p.visibles.length === 0 && <li className="muted pad">Sin resultados.</li>}
      </ul>
    </section>
  );
}
