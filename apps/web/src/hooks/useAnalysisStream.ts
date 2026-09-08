import { useCallback, useRef, useState } from 'react';
import type { AgentEvent } from '@credit/contracts';
import { analizarConStream } from '../services/analysis-stream.js';
import type { AnalisisResultado, ErrorAnalisis, EstadoAnalisis } from '../types/view.js';

/**
 * Ejecucion del analisis con streaming y cancelacion.
 *
 * Regla de la UI: al cancelar o fallar se conservan los eventos ya recibidos y
 * el resultado previo si lo habia. Un error del proveedor no borra la pantalla.
 */
export function useAnalysisStream() {
  const [estado, setEstado] = useState<EstadoAnalisis>('idle');
  const [eventos, setEventos] = useState<AgentEvent[]>([]);
  const [resultado, setResultado] = useState<AnalisisResultado | null>(null);
  const [error, setError] = useState<ErrorAnalisis | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancelar = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setEstado('cancelado');
  }, []);

  const limpiar = useCallback(() => {
    setEventos([]);
    setResultado(null);
    setError(null);
    setEstado('idle');
  }, []);

  const analizar = useCallback(async (idSolicitud: string) => {
    // Doble click: si ya hay una ejecucion en curso no se lanza otra.
    if (abortRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setEstado('corriendo');
    setEventos([]);
    setError(null);
    setResultado(null);

    let terminoEnError = false;

    await analizarConStream(
      idSolicitud,
      {
        onEvent: (evento) => {
          setEventos((previos) => [...previos, evento]);

          const payload = evento.data as Record<string, unknown> | undefined;

          if (payload && 'resultado' in payload) {
            const r = payload['resultado'] as AnalisisResultado;
            setResultado(r);
            if (r.failure) {
              terminoEnError = true;
              setError({ code: r.failure.code, mensaje: evento.label ?? 'El analisis no pudo completarse', detalle: r.failure.message });
            }
            return;
          }

          if (evento.type === 'run.failed') {
            terminoEnError = true;
            const code = typeof payload?.['code'] === 'string' ? (payload['code'] as string) : 'RUN_FAILED';
            const detalle = typeof payload?.['detail'] === 'string' ? (payload['detail'] as string) : undefined;
            setError({ code, mensaje: evento.label ?? 'El analisis no pudo completarse', ...(detalle ? { detalle } : {}) });
          }
        },
        onError: (e) => {
          terminoEnError = true;
          setError({ code: e.code, mensaje: e.mensaje });
        },
        onDone: () => undefined,
      },
      controller.signal,
    );

    const cancelado = controller.signal.aborted;
    abortRef.current = null;
    setEstado(cancelado ? 'cancelado' : terminoEnError ? 'error' : 'completado');
  }, []);

  return { estado, eventos, resultado, error, analizar, cancelar, limpiar, setResultado };
}
