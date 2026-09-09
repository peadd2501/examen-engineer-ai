import { useEffect, useRef, useState } from 'react';
import { estadoDeStreaming, SALUDO_ASISTENTE, type MensajeChat } from '../features/chat/transcript.js';
import type { AgentEvent } from '../types/view.js';

interface Props {
  mensajes: MensajeChat[];
  /** Eventos del análisis en curso. Alimentan el estado discreto de generación. */
  eventos: AgentEvent[];
  corriendo: boolean;
  /** Deshabilita el envío cuando no hay solicitud seleccionada. */
  habilitado: boolean;
  onEnviar: (texto: string) => void;
  onCancelar: () => void;
}

/**
 * Chat del analista.
 *
 * Es la vista conversacional del MISMO analisis que alimenta el panel Dictamen:
 * escribir aqui dispara el stream SSE existente pasando el texto como consulta
 * del analista. No hay endpoint nuevo ni segundo backend.
 *
 * El hilo es conversación: la pregunta del analista, un estado discreto
 * mientras se genera, y la respuesta. Los pasos de ejecución NO viven aquí,
 * sino en «Progreso del análisis»: duplicarlos empujaba la respuesta fuera de
 * la vista. El contenido lo construye `features/chat/transcript.ts`, que solo
 * emite constantes propias y datos del dictamen ya validado.
 */
export function ChatPanel({ mensajes, eventos, corriendo, habilitado, onEnviar, onCancelar }: Props) {
  const [borrador, setBorrador] = useState('');
  const hilo = useRef<HTMLDivElement | null>(null);

  // Autoscroll: se baja el contenedor del hilo, nunca la página. Si el analista
  // subió a releer, no se le arrastra hacia abajo.
  const ultimo = mensajes[mensajes.length - 1];
  useEffect(() => {
    const nodo = hilo.current;
    if (!nodo) return;
    const cercaDelFondo = nodo.scrollHeight - nodo.scrollTop - nodo.clientHeight < 120;
    if (cercaDelFondo) nodo.scrollTop = nodo.scrollHeight;
  }, [mensajes.length, ultimo?.texto, ultimo?.estado, eventos.length]);

  const enviar = (): void => {
    const texto = borrador.trim();
    if (texto === '' || corriendo || !habilitado) return;
    setBorrador('');
    onEnviar(texto);
  };

  return (
    <section className="panel chat" aria-label="Chat de análisis">
      <header className="panel__head">
        <h2>Chat de análisis</h2>
        {corriendo && <span className="pulso">generando respuesta…</span>}
      </header>

      <div className="chat__hilo" ref={hilo} role="log" aria-live="polite">
        {mensajes.length === 0 && (
          <article className="chat__msg chat__msg--asistente">
            <span className="chat__autor">Asistente</span>
            <p className="chat__texto">{SALUDO_ASISTENTE}</p>
          </article>
        )}

        {mensajes.map((m) => (
          <article
            key={m.id}
            className={m.rol === 'usuario' ? 'chat__msg chat__msg--usuario' : 'chat__msg chat__msg--asistente'}
          >
            <span className="chat__autor">{m.rol === 'usuario' ? 'Analista' : 'Asistente'}</span>

            {m.texto !== '' && <p className="chat__texto">{m.texto}</p>}

            {m.estado === 'streaming' && (
              <p className="chat__estado">
                <span className="chat__puntos" aria-hidden="true"><i /><i /><i /></span>
                {estadoDeStreaming(eventos)}…
              </p>
            )}
          </article>
        ))}
      </div>

      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          enviar();
        }}
      >
        <input
          className="chat__input"
          type="text"
          name="consulta"
          placeholder="Pregunta sobre esta solicitud..."
          aria-label="Mensaje para el asistente"
          value={borrador}
          disabled={!habilitado}
          maxLength={500}
          onChange={(e) => setBorrador(e.target.value)}
        />
        {corriendo && (
          <button type="button" className="btn btn--ghost chat__cancelar" onClick={onCancelar}>
            Cancelar
          </button>
        )}
        <button type="submit" className="btn btn--primary chat__enviar" disabled={corriendo || !habilitado}>
          Enviar
        </button>
      </form>
    </section>
  );
}
