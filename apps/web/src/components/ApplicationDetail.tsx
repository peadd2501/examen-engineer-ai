import type { Indicadores, Solicitud } from '@credit/contracts';
import { comoQuetzales, describirAnomalia, idCorto } from '../features/analysis/format.js';
import { Badge } from './StatusBadge.js';
import { IndicatorPanel } from './IndicatorPanel.js';

interface Props {
  solicitud: Solicitud;
  indicadores: Indicadores | null;
  /** Hallazgo sobre el texto del solicitante, si el análisis lo produjo. */
  g5Detectado: boolean;
  patronesG5: string[];
}

/**
 * Resumen de la solicitud: datos principales, cifras reportadas, indicadores y
 * destino de fondos en un solo panel. Los bloques se separan por titulo y no por
 * paneles, para que el chat entre en la primera pantalla.
 *
 * `destino_fondos` se presenta SIEMPRE como dato aportado por el solicitante: el
 * analista tiene que ver que ese texto no tiene autoridad.
 */
export function ApplicationDetail({ solicitud, indicadores, g5Detectado, patronesG5 }: Props) {
  const montoAlto = Number(solicitud.monto_solicitado) > 250_000;
  const anomalias = indicadores?.anomalias ?? [];

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>{solicitud.nombre_empresa}</h2>
        <span className="muted small mono">{idCorto(solicitud.id_solicitud)}</span>
      </header>

      {(anomalias.length > 0 || g5Detectado || montoAlto) && (
        <div className="badges">
          {anomalias.length > 0 && <Badge tono="danger">Datos inconsistentes</Badge>}
          {g5Detectado && <Badge tono="danger">Texto no confiable detectado</Badge>}
          {montoAlto && <Badge tono="warn">Monto &gt; Q250,000</Badge>}
        </div>
      )}

      <div className="bloque">
        <div className="bloque__titulo">Datos principales</div>
        <dl className="datos">
          <div><dt>Monto solicitado</dt><dd>{comoQuetzales(solicitud.monto_solicitado)}</dd></div>
          <div><dt>Plazo</dt><dd>{solicitud.plazo_meses} meses</dd></div>
          <div><dt>Garantía</dt><dd>{solicitud.garantia_ofrecida}</dd></div>
          <div><dt>Score de historial</dt><dd>{solicitud.score_historial} / 100</dd></div>
          <div><dt>Sector</dt><dd>{solicitud.sector}</dd></div>
          <div><dt>Meses de operación</dt><dd>{solicitud.meses_operacion}</dd></div>
          <div><dt>Fecha</dt><dd>{solicitud.fecha_solicitud}</dd></div>
        </dl>
      </div>

      <div className="bloque">
        <div className="bloque__titulo">Cifras financieras reportadas</div>
        <div className="metricas metricas--cifras">
          {([
            ['Ventas anuales', solicitud.ventas_anuales],
            ['Utilidad neta', solicitud.utilidad_neta],
            ['Activos totales', solicitud.activos_totales],
            ['Pasivos totales', solicitud.pasivos_totales],
            ['Deuda vigente anual', solicitud.deuda_vigente_anual],
          ] as const).map(([etiqueta, valor]) => (
            <div className="metrica" key={etiqueta}>
              <span className="metrica__label">{etiqueta}</span>
              <span className="metrica__valor">{comoQuetzales(valor)}</span>
            </div>
          ))}
        </div>
      </div>

      <IndicatorPanel indicadores={indicadores} />

      {anomalias.length > 0 && (
        <div className="aviso aviso--danger">
          <strong>Inconsistencias en los datos financieros</strong>
          <ul>
            {anomalias.map((a) => <li key={a}>{describirAnomalia(a)}</li>)}
          </ul>
        </div>
      )}

      <div className={`no-confiable ${g5Detectado ? 'no-confiable--alerta' : ''}`}>
        <div className="no-confiable__head">
          <span>Destino de fondos</span>
          <span className={`chip-aviso ${g5Detectado ? 'chip-aviso--danger' : ''}`}>
            Texto proporcionado por el solicitante — no confiable
          </span>
        </div>
        <blockquote>{solicitud.destino_fondos}</blockquote>

        {g5Detectado && (
          <div className="aviso aviso--danger">
            <strong>Se detectó contenido potencialmente manipulador.</strong>
            <p>
              Fue tratado únicamente como dato. No modificó los indicadores, los topes de monto
              ni la decisión.
            </p>
            {patronesG5.length > 0 && (
              <details>
                <summary>Detalle técnico</summary>
                <p className="mono">Patrones marcados: {patronesG5.join(', ')}</p>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
