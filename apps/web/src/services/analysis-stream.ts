import { AgentEventSchema, type AgentEvent } from '@credit/contracts';
import { BASE_URL } from './base-url.js';

/**
 * Cliente SSE del analisis.
 *
 * fetch + ReadableStream en vez de EventSource porque iniciar un analisis es un
 * POST con efectos. La cancelacion es el AbortController del navegador: al
 * abortar, el backend recibe 'close' y propaga el signal hasta el proveedor.
 */

/**
 * Causas de fallo del TRANSPORTE, distinguidas una por una.
 *
 * `API_UNREACHABLE` queda reservado para un fetch que ni siquiera llego a
 * producir respuesta. Colapsarlo todo en "API inalcanzable" fue lo que hizo
 * invisible un problema de CORS durante una sesion entera, con el servidor
 * respondiendo perfectamente.
 */
export type StreamErrorCode =
  | 'API_UNREACHABLE'
  | 'HTTP_ERROR'
  | 'STREAM_SIN_CUERPO'
  | 'STREAM_INTERRUMPIDO';

export interface StreamError {
  code: StreamErrorCode;
  mensaje: string;
  detalle?: string;
}

export interface StreamDiagnostico {
  framesRecibidos: number;
  framesInvalidos: number;
  eventosInvalidos: number;
}

export interface StreamHandlers {
  onEvent: (evento: AgentEvent) => void;
  /** Fallo de transporte. Los errores de dominio llegan como evento run.failed. */
  onError: (error: StreamError) => void;
  onDone: (diagnostico: StreamDiagnostico) => void;
}

/**
 * `consulta` es el texto que el analista escribio en el chat. Viaja como
 * `consulta` en el cuerpo del POST, que la ruta ya aceptaba desde FASE 3 y
 * expone al agente como "consulta del analista". El chat NO estrena endpoint:
 * usa este mismo stream.
 */
export async function analizarConStream(
  idSolicitud: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
  consulta?: string,
): Promise<void> {
  const diagnostico: StreamDiagnostico = { framesRecibidos: 0, framesInvalidos: 0, eventosInvalidos: 0 };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/applications/${idSolicitud}/analyze/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        session_id: `web-${Date.now()}`,
        ...(consulta && consulta.trim() !== '' ? { consulta: consulta.trim().slice(0, 500) } : {}),
      }),
      signal,
    });
  } catch (error) {
    // Abortar es una accion del usuario, no un fallo.
    if (signal.aborted) {
      handlers.onDone(diagnostico);
      return;
    }
    // Unico caso legitimo de API_UNREACHABLE: no hubo respuesta.
    handlers.onError({
      code: 'API_UNREACHABLE',
      mensaje: `No se pudo establecer la conexion con la API en ${BASE_URL}.`,
      detalle:
        'La peticion no produjo respuesta. Puede ser que la API no este corriendo, o que el ' +
        'navegador haya bloqueado la respuesta por CORS. Revisa la consola del navegador: si el ' +
        'servidor registro la peticion, el problema es CORS y no conectividad.',
    });
    handlers.onDone(diagnostico);
    return;
  }

  if (!response.ok) {
    let detalle: string | undefined;
    try {
      const cuerpo = (await response.json()) as { error?: { code?: string; message?: string } };
      detalle = cuerpo.error ? `${cuerpo.error.code ?? ''} ${cuerpo.error.message ?? ''}`.trim() : undefined;
    } catch {
      detalle = undefined;
    }
    handlers.onError({
      code: 'HTTP_ERROR',
      mensaje: `La API respondio ${response.status}.`,
      ...(detalle ? { detalle } : {}),
    });
    handlers.onDone(diagnostico);
    return;
  }

  if (!response.body) {
    handlers.onError({
      code: 'STREAM_SIN_CUERPO',
      mensaje: 'La API respondio correctamente pero sin cuerpo de streaming.',
    });
    handlers.onDone(diagnostico);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Los eventos SSE se separan por linea en blanco.
      let corte = buffer.indexOf('\n\n');
      while (corte !== -1) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        procesarBloque(bloque, handlers, diagnostico);
        corte = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      // El stream se corto a mitad. NO es API_UNREACHABLE: la conexion existio
      // y hubo respuesta; lo que fallo fue la lectura.
      handlers.onError({
        code: 'STREAM_INTERRUMPIDO',
        mensaje: 'La conexion con el analisis se interrumpio mientras se recibian eventos.',
        detalle: `${diagnostico.framesRecibidos} eventos recibidos antes del corte.`,
      });
    }
  } finally {
    handlers.onDone(diagnostico);
  }
}

/**
 * Un frame corrupto o un evento que no cumple el contrato se cuentan y se
 * descartan, pero no tumban el stream ni se reportan como fallo de transporte:
 * el resto de los eventos sigue siendo util.
 */
function procesarBloque(bloque: string, handlers: StreamHandlers, diagnostico: StreamDiagnostico): void {
  const datos = bloque
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');

  if (datos === '') {
    diagnostico.framesInvalidos += 1;
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(datos);
  } catch {
    diagnostico.framesInvalidos += 1;
    return;
  }

  const parsed = AgentEventSchema.safeParse(json);
  if (!parsed.success) {
    diagnostico.eventosInvalidos += 1;
    return;
  }

  diagnostico.framesRecibidos += 1;
  handlers.onEvent(parsed.data);
}
