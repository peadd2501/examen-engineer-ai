import { useState } from 'react';

interface Props {
  idDictamen: string;
  onResolver: (accion: 'CONFIRMAR' | 'RECHAZAR') => Promise<void>;
}

/**
 * G4 — Human in the loop.
 *
 * Aparece solo cuando el backend marcó `requires_human_authorization` y el
 * estado operativo es PENDING_AUTHORIZATION. La confirmación ejecuta el
 * endpoint real; no hay simulación en el frontend.
 */
export function HumanAuthorizationPanel({ idDictamen, onResolver }: Props) {
  const [enviando, setEnviando] = useState<'CONFIRMAR' | 'RECHAZAR' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolver = async (accion: 'CONFIRMAR' | 'RECHAZAR'): Promise<void> => {
    if (enviando) return; // evita doble submit
    setEnviando(accion);
    setError(null);
    try {
      await onResolver(accion);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la decisión');
    } finally {
      setEnviando(null);
    }
  };

  return (
    <div className="autorizacion">
      <h3>Requiere autorización del analista</h3>
      <p>
        El sistema generó una recomendación, pero no puede quedar firme hasta que un analista
        la confirme.
      </p>
      <div className="autorizacion__acciones">
        <button
          type="button"
          className="btn btn--ok"
          disabled={enviando !== null}
          onClick={() => void resolver('CONFIRMAR')}
        >
          {enviando === 'CONFIRMAR' ? 'Confirmando…' : 'Confirmar recomendación'}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={enviando !== null}
          onClick={() => void resolver('RECHAZAR')}
        >
          {enviando === 'RECHAZAR' ? 'Rechazando…' : 'Rechazar recomendación'}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      <p className="muted small">Dictamen {idDictamen.slice(0, 8)}</p>
    </div>
  );
}

/**
 * Escalamiento a comité. NO lleva botón de confirmar: no hay recomendación
 * firme que autorizar. Es la separación introducida en FASE 3.1 —
 * PENDING_COMMITTEE no es PENDING_AUTHORIZATION.
 */
export function CommitteePanel({ motivo }: { motivo?: string }) {
  return (
    <div className="comite">
      <h3>Escalado a comité</h3>
      <p>
        El sistema no emitió una recomendación firme y requiere revisión del comité.
        No hay nada que autorizar aquí: el comité resuelve el caso desde cero.
      </p>
      {motivo && <p className="muted small">{motivo}</p>}
    </div>
  );
}
