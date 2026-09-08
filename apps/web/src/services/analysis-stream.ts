import { AgentEventSchema, type AgentEvent } from '@credit/contracts';

const BASE_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';

/**
 * Cliente SSE del analisis.
 *
 * Se usa fetch + ReadableStream en vez de EventSource porque iniciar un
 * analisis es un POST con efectos. La cancelacion es el AbortController del
 * navegador: al abortar se cierra la conexion, el backend recibe 'close' y
 * propaga el signal hasta la llamada al proveedor.
 */
export interface StreamHandlers {
  onEvent: (evento: AgentEvent) => void;
  onError: (error: { code: string; mensaje: string }) => void;
  onDone: () => void;
}

export async function analizarConStream(
  idSolicitud: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/applications/${idSolicitud}/analyze/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ session_id: `web-${Date.now()}` }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    handlers.onError({
      code: 'API_UNREACHABLE',
      mensaje: `No se pudo contactar la API en ${BASE_URL}. Verifica que este corriendo.`,
    });
    return;
  }

  if (!response.ok || !response.body) {
    handlers.onError({ code: `HTTP_${response.status}`, mensaje: `La API respondio ${response.status}.` });
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
        procesarBloque(bloque, handlers);
        corte = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    // Abortar es una accion del usuario, no un error.
    if (!signal.aborted) {
      handlers.onError({ code: 'STREAM_INTERRUMPIDO', mensaje: 'La conexion con el analisis se interrumpio.' });
    }
  } finally {
    handlers.onDone();
  }
}

function procesarBloque(bloque: string, handlers: StreamHandlers): void {
  const datos = bloque
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  if (datos === '') return;

  try {
    const parsed = AgentEventSchema.safeParse(JSON.parse(datos));
    if (parsed.success) handlers.onEvent(parsed.data);
  } catch {
    // Un bloque corrupto no debe tumbar el stream.
  }
}
