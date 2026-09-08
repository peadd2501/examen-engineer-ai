import type { Indicadores } from '@credit/contracts';
import { comoMeses, comoPorcentaje, comoVeces, describirAnomalia } from '../features/analysis/format.js';

/**
 * Indicadores autoritativos.
 *
 * El frontend NO calcula nada: todos estos valores vienen de la capa
 * determinista del backend (decimal.js). `null` significa "no calculable con
 * los datos dados" y se muestra como N/D, que es distinto de cero.
 */
export function IndicatorPanel({ indicadores }: { indicadores: Indicadores | null }) {
  if (!indicadores) {
    return (
      <section className="panel">
        <header className="panel__head"><h2>Indicadores calculados</h2></header>
        <p className="muted pad">Selecciona una solicitud.</p>
      </section>
    );
  }

  const filas: Array<{ etiqueta: string; valor: string }> = [
    { etiqueta: 'Razón de endeudamiento', valor: comoPorcentaje(indicadores.razon_endeudamiento) },
    { etiqueta: 'Margen neto', valor: comoPorcentaje(indicadores.margen_neto) },
    { etiqueta: 'Cobertura del servicio de deuda', valor: comoVeces(indicadores.cobertura_servicio_deuda) },
    { etiqueta: 'Monto solicitado / ventas', valor: comoPorcentaje(indicadores.relacion_monto_ventas) },
    { etiqueta: 'Meses de operación', valor: comoMeses(indicadores.antiguedad_meses) },
  ];

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>Indicadores calculados</h2>
        <span className="muted" title="indicator_calc_version">v{indicadores.calculation_version}</span>
      </header>

      <table className="tabla">
        <tbody>
          {filas.map((f) => (
            <tr key={f.etiqueta}>
              <th>{f.etiqueta}</th>
              <td className={f.valor === 'N/D' ? 'nd' : 'num'}>{f.valor}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted small">
        Calculados por el backend con aritmética decimal. El asistente los recibe como dato
        autoritativo y no puede modificarlos.
      </p>

      {indicadores.anomalias.length > 0 && (
        <div className="aviso aviso--danger">
          <strong>Anomalías en los datos financieros</strong>
          <ul>{indicadores.anomalias.map((a) => <li key={a}>{describirAnomalia(a)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
