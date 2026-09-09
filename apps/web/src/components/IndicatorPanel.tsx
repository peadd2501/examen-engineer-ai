import type { Indicadores } from '@credit/contracts';
import { comoMeses, comoPorcentaje, comoVeces, describirAnomalia } from '../features/analysis/format.js';

/**
 * Indicadores calculados.
 *
 * El frontend NO calcula nada: todos estos valores llegan ya calculados.
 * `null` significa "no calculable con los datos dados" y se muestra como N/D,
 * que es distinto de cero.
 *
 * Es un BLOQUE, no un panel: vive dentro del resumen de la solicitud, junto a
 * los datos de los que sale. Tenerlo como panel aparte costaba encabezado,
 * bordes y separación propios —casi cien píxeles— y empujaba el chat fuera de
 * la primera pantalla sin aportar ninguna separación conceptual real.
 */
export function IndicatorPanel({ indicadores }: { indicadores: Indicadores | null }) {
  if (!indicadores) {
    return (
      <div className="bloque">
        <div className="bloque__titulo">Indicadores calculados</div>
        <p className="muted small">Selecciona una solicitud.</p>
      </div>
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
    <div className="bloque">
      <div className="bloque__titulo">
        Indicadores calculados
        <span className="bloque__nota">
          calculados automáticamente a partir de la información financiera registrada
        </span>
      </div>

      <div className="metricas">
        {filas.map((f) => (
          <div className="metrica" key={f.etiqueta}>
            <span className="metrica__label">{f.etiqueta}</span>
            <span className={f.valor === 'N/D' ? 'metrica__valor nd' : 'metrica__valor'}>{f.valor}</span>
          </div>
        ))}
      </div>

      {indicadores.anomalias.length > 0 && (
        <div className="aviso aviso--danger">
          <strong>Anomalías en los datos financieros</strong>
          <ul>{indicadores.anomalias.map((a) => <li key={a}>{describirAnomalia(a)}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
