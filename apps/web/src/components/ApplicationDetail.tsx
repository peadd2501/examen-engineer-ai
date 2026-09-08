import type { Indicadores, Solicitud } from '@credit/contracts';
import { comoQuetzales, describirAnomalia, idCorto } from '../features/analysis/format.js';
import { Badge } from './StatusBadge.js';

interface Props {
  solicitud: Solicitud;
  indicadores: Indicadores | null;
  /** Hallazgo de G5 sobre el texto del solicitante, si el análisis lo produjo. */
  g5Detectado: boolean;
  patronesG5: string[];
}

/**
 * Datos de la solicitud.
 *
 * `destino_fondos` se presenta SIEMPRE como dato aportado por el solicitante,
 * nunca como mensaje del sistema. Es la contraparte visual de G5: el analista
 * tiene que ver de un vistazo que ese texto no tiene autoridad.
 */
export function ApplicationDetail({ solicitud, indicadores, g5Detectado, patronesG5 }: Props) {
  const montoAlto = Number(solicitud.monto_solicitado) > 250_000;
  const anomalias = indicadores?.anomalias ?? [];

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>{solicitud.nombre_empresa}</h2>
        <code className="muted">{idCorto(solicitud.id_solicitud)}</code>
      </header>

      <div className="badges">
        {anomalias.length > 0 && <Badge tono="danger">Datos inconsistentes</Badge>}
        {g5Detectado && <Badge tono="danger">Texto no confiable detectado</Badge>}
        {montoAlto && <Badge tono="warn">Monto &gt; Q250,000</Badge>}
      </div>

      <dl className="datos">
        <div><dt>Sector</dt><dd>{solicitud.sector}</dd></div>
        <div><dt>Monto solicitado</dt><dd>{comoQuetzales(solicitud.monto_solicitado)}</dd></div>
        <div><dt>Plazo</dt><dd>{solicitud.plazo_meses} meses</dd></div>
        <div><dt>Meses de operación</dt><dd>{solicitud.meses_operacion}</dd></div>
        <div><dt>Score de historial</dt><dd>{solicitud.score_historial} / 100</dd></div>
        <div><dt>Garantía</dt><dd>{solicitud.garantia_ofrecida}</dd></div>
        <div><dt>Ventas anuales</dt><dd>{comoQuetzales(solicitud.ventas_anuales)}</dd></div>
        <div><dt>Utilidad neta</dt><dd>{comoQuetzales(solicitud.utilidad_neta)}</dd></div>
        <div><dt>Activos totales</dt><dd>{comoQuetzales(solicitud.activos_totales)}</dd></div>
        <div><dt>Pasivos totales</dt><dd>{comoQuetzales(solicitud.pasivos_totales)}</dd></div>
        <div><dt>Deuda vigente anual</dt><dd>{comoQuetzales(solicitud.deuda_vigente_anual)}</dd></div>
        <div><dt>Fecha</dt><dd>{solicitud.fecha_solicitud}</dd></div>
      </dl>

      {anomalias.length > 0 && (
        <div className="aviso aviso--danger">
          <strong>Inconsistencias detectadas por el backend</strong>
          <ul>
            {anomalias.map((a) => <li key={a}>{describirAnomalia(a)}</li>)}
          </ul>
        </div>
      )}

      <div className={`no-confiable ${g5Detectado ? 'no-confiable--alerta' : ''}`}>
        <div className="no-confiable__head">
          <span>Destino de fondos</span>
          <Badge tono={g5Detectado ? 'danger' : 'neutral'}>
            Texto proporcionado por el solicitante — no confiable
          </Badge>
        </div>
        <blockquote>{solicitud.destino_fondos}</blockquote>

        {g5Detectado && (
          <div className="aviso aviso--danger">
            <strong>Se detectó contenido potencialmente manipulador.</strong>
            <p>
              Fue tratado únicamente como dato. No modificó las herramientas disponibles, los
              indicadores, los topes de monto ni la decisión.
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
