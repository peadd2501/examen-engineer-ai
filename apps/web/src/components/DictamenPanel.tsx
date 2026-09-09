import type { AnalisisResultado, EstadoAnalisis, ErrorAnalisis } from '../types/view.js';
import { comoQuetzales, describirError } from '../features/analysis/format.js';
import { EstadoOperativoBadge, RiesgoBadge } from './StatusBadge.js';
import { PolicyCitationList } from './PolicyCitationCard.js';
import { CommitteePanel, HumanAuthorizationPanel } from './HumanAuthorizationPanel.js';

interface Props {
  resultado: AnalisisResultado | null;
  estado: EstadoAnalisis;
  error: ErrorAnalisis | null;
  onAutorizar: (idDictamen: string, accion: 'CONFIRMAR' | 'RECHAZAR') => Promise<void>;
  onReintentar: () => void;
}

/**
 * Dictamen: la fuente visual del estado estructurado y persistido.
 *
 * Orden de lectura: decisión, riesgo, estado operativo, confianza, cifras,
 * motivos y políticas citadas. El color se reserva para la decisión y el
 * estado; el resto va en gris para que la jerarquía la marque el tamaño.
 */
const TONO_VEREDICTO: Record<string, string> = {
  APROBADO: 'ok',
  RECHAZADO: 'danger',
  ESCALADO_A_COMITE: 'warn',
};

const TEXTO_VEREDICTO: Record<string, string> = {
  APROBADO: 'APROBADO',
  RECHAZADO: 'RECHAZADO',
  ESCALADO_A_COMITE: 'ESCALADO A COMITÉ',
};

export function DictamenPanel({ resultado, estado, error, onAutorizar, onReintentar }: Props) {
  const dictamen = resultado?.dictamen ?? null;
  const confirmacion = resultado?.confirmacion ?? null;

  return (
    <section className="panel panel--dictamen">
      <header className="panel__head"><h2>Dictamen</h2></header>

      {/* El error se muestra sin borrar lo que ya había en pantalla. */}
      {error && (
        <div className="aviso aviso--danger">
          <strong>{describirError(error.code)}</strong>
          <p className="muted small mono">{error.code}</p>
          {error.detalle && (
            <details><summary>Detalle técnico</summary><p className="mono small">{error.detalle}</p></details>
          )}
          <button type="button" className="btn btn--ghost" onClick={onReintentar}>Reintentar</button>
        </div>
      )}

      {estado === 'cancelado' && !error && (
        <div className="aviso aviso--warn"><strong>Análisis cancelado.</strong></div>
      )}

      {!dictamen && !error && estado !== 'corriendo' && (
        <p className="muted pad">Todavía no hay dictamen para esta solicitud.</p>
      )}

      {estado === 'corriendo' && !dictamen && <p className="muted pad">Generando recomendación…</p>}

      {dictamen && confirmacion && (
        <>
          {/* Veredicto: lo primero que se lee, con el color del resultado. */}
          <div className={`veredicto-card veredicto-card--${TONO_VEREDICTO[confirmacion.decision] ?? 'neutral'}`}>
            <div className="veredicto-card__top">
              <span className="veredicto-card__texto">
                {TEXTO_VEREDICTO[confirmacion.decision] ?? confirmacion.decision}
              </span>
              <RiesgoBadge nivel={dictamen.nivel_riesgo} />
            </div>

            {/* La banda ámbar ya dice que está pendiente de autorización; repetirlo
                además como badge sería decir dos veces lo mismo en la misma tarjeta. */}
            {confirmacion.requiere_autorizacion_humana ? (
              <p className="aviso-humano">
                <span aria-hidden="true">⚠</span> Pendiente de autorización humana
              </p>
            ) : (
              <div className="veredicto__meta">
                <EstadoOperativoBadge estado={confirmacion.operational_status} />
              </div>
            )}

            <div className="confianza">
              <span>Confianza</span>
              <div className="confianza__barra">
                <div className="confianza__fill" style={{ width: `${Math.round(dictamen.confianza * 100)}%` }} />
              </div>
              <span>{(dictamen.confianza * 100).toFixed(0)} %</span>
            </div>
          </div>

          <div className="metricas metricas--dictamen">
            <div className="metrica">
              <span className="metrica__label">Monto recomendado</span>
              <span className="metrica__valor">{comoQuetzales(dictamen.monto_recomendado)}</span>
            </div>
            <div className="metrica">
              <span className="metrica__label">Plazo recomendado</span>
              <span className="metrica__valor">
                {dictamen.plazo_recomendado_meses === null ? 'N/D' : `${dictamen.plazo_recomendado_meses} meses`}
              </span>
            </div>
          </div>

          <h3>Motivos</h3>
          <ul className="motivos">{dictamen.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul>

          <h3>Políticas citadas</h3>
          <PolicyCitationList citas={dictamen.politicas_citadas} />

          {confirmacion.operational_status === 'PENDING_AUTHORIZATION' && (
            <HumanAuthorizationPanel
              idDictamen={confirmacion.id_dictamen}
              onResolver={(accion) => onAutorizar(confirmacion.id_dictamen, accion)}
            />
          )}

          {confirmacion.operational_status === 'PENDING_COMMITTEE' && (
            <CommitteePanel motivo={resultado?.findings.find((f) => f.guardrail === 'G1')?.message} />
          )}

          {confirmacion.operational_status === 'CONFIRMED' && (
            <div className="aviso aviso--ok"><strong>Confirmado por el analista.</strong></div>
          )}
          {confirmacion.operational_status === 'REJECTED_BY_ANALYST' && (
            <div className="aviso aviso--danger"><strong>Rechazado por el analista.</strong></div>
          )}
        </>
      )}
    </section>
  );
}
