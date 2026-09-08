import { useCallback, useRef, useState } from 'react';
import type { AgentEvent } from '@credit/contracts';
import { analizarConStream, type StreamDiagnostico } from '../services/analysis-stream.js';
import type { AnalisisResultado, ErrorAnalisis, EstadoAnalisis } from '../types/view.js';

/**
 * Ejecucion del analisis con streaming y cancelacion.
 *
 * Dos reglas:
 *
 * 1. Al cancelar o fallar se conservan los eventos ya recibidos y el resultado
 *    previo. Un error del proveedor no borra la pantalla.
 *
 * 2. Un error de DOMINIO que llego por `run.failed` (por ejemplo
 *    OUTPUT_TOKEN_LIMIT_EXCEEDED) tiene prioridad sobre cualquier error de
 *    transporte posterior. El backend ya dijo que fallo y por que; que despues
 *    se corte el socket no cambia el diagnostico, y pisarlo con un generico
 *    convierte una causa concreta en ruido.
 */
export function useAnalysisStream() {
  const [estado, setEstado] = useState<EstadoAnalisis>('idle');
  const [eventos, setEventos] = useState<AgentEvent[]>([]);
  const [resultado, setResultado] = useState<AnalisisResultado | null>(null);
  const [error, setError] = useState<ErrorAnalisis | null>(null);
  const [diagnostico, setDiagnostico] = useState<StreamDiagnostico | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Cerrojo sincronico: un click = un analisis, pase lo que pase con el estado. */
  const enCursoRef = useRef(false);

  const cancelar = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    enCursoRef.current = false;
    setEstado('cancelado');
  }, []);

  const limpiar = useCallback(() => {
    setEventos([]);
    setResultado(null);
    setError(null);
    setDiagnostico(null);
    setEstado('idle');
  }, []);

  const analizar = useCallback(async (idSolicitud: string) => {
    // El cerrojo se toma antes de cualquier await: dos clicks seguidos, o un
    // click mientras el estado de React todavia no se propago, no lanzan dos
    // analisis. El servidor cobra por cada uno.
    if (enCursoRef.current) return;
    enCursoRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    setEstado('corriendo');
    setEventos([]);
    setError(null);
    setResultado(null);
    setDiagnostico(null);

    // Refs y no estado: se leen dentro de callbacks que corren durante el await.
    let errorDeDominio = false;
    let huboFallo = false;

    try {
      await analizarConStream(
        idSolicitud,
        {
          onEvent: (evento) => {
            setEventos((previos) => [...previos, evento]);

            const payload = evento.data as Record<string, unknown> | undefined;

            // Evento terminal: trae el resultado completo.
            if (payload && 'resultado' in payload) {
              const r = payload['resultado'] as AnalisisResultado;
              setResultado(r);
              if (r.failure) {
                huboFallo = true;
                errorDeDominio = true;
                setError({
                  code: r.failure.code,
                  mensaje: evento.label ?? 'El analisis no pudo completarse',
                  detalle: r.failure.message,
                });
              }
              return;
            }

            if (evento.type === 'run.failed') {
              huboFallo = true;
              errorDeDominio = true;
              const code = typeof payload?.['code'] === 'string' ? (payload['code'] as string) : 'RUN_FAILED';
              const detalle = typeof payload?.['detail'] === 'string' ? (payload['detail'] as string) : undefined;
              setError({
                code,
                mensaje: evento.label ?? 'El analisis no pudo completarse',
                ...(detalle ? { detalle } : {}),
              });
            }
          },

          onError: (e) => {
            huboFallo = true;
            // Un fallo de transporte no pisa un diagnostico del backend.
            if (errorDeDominio) return;
            setError({ code: e.code, mensaje: e.mensaje, ...(e.detalle ? { detalle: e.detalle } : {}) });
          },

          onDone: (d) => setDiagnostico(d),
        },
        controller.signal,
      );
    } finally {
      const cancelado = controller.signal.aborted;
      abortRef.current = null;
      enCursoRef.current = false;
      setEstado(cancelado ? 'cancelado' : huboFallo ? 'error' : 'completado');
    }
  }, []);

  return { estado, eventos, resultado, error, diagnostico, analizar, cancelar, limpiar, setResultado };
}
