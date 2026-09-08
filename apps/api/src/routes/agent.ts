import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analizarSolicitud } from '../application/analyze-application.js';
import { buildAgentProvider } from '../agents/index.js';
import { pool } from '../infrastructure/db.js';
import { DEFAULT_AGENT_LIMITS } from '../agents/agent-limits.js';
import { config } from '../config.js';
import { AgentEventSchema, type AgentEvent } from '@credit/contracts';
import { statusForError, toErrorBody } from '../infrastructure/error-mapper.js';

const Body = z.object({
  session_id: z.string().min(1).max(120).optional(),
  intento_logico: z.string().min(1).max(120).optional(),
  consulta: z.string().max(500).optional(),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/applications/:id/analyze', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = Body.parse(request.body ?? {});

    // La cancelacion se detecta en la RESPUESTA, no en la peticion:
    // `request.raw` emite 'close' en cuanto termina de leerse el body, asi que
    // escuchar ahi abortaba todos los analisis apenas empezaban. `reply.raw`
    // cierra cuando el cliente se desconecta de verdad.
    const controller = new AbortController();
    let terminado = false;
    reply.raw.on('close', () => {
      if (!terminado) controller.abort();
    });

    const provider = buildAgentProvider(pool, DEFAULT_AGENT_LIMITS);
    const resultado = await analizarSolicitud(pool, provider, {
      idSolicitud: id,
      signal: controller.signal,
      ...(body.session_id ? { sessionId: body.session_id } : {}),
      ...(body.intento_logico ? { intentoLogico: body.intento_logico } : {}),
      ...(body.consulta ? { consultaAnalista: body.consulta } : {}),
    });

    terminado = true;
    if (resultado.failure) return reply.status(422).send(resultado);
    return resultado;
  });
}

/**
 * Origen permitido para esta peticion, segun CORS_ORIGIN.
 *
 * Se resuelve contra la lista configurada y se devuelve el origen EXACTO que
 * mando el navegador. Nunca '*': ademas de ser mala practica, seria incompatible
 * con credenciales si mas adelante se agregan.
 */
function origenPermitido(origen: string | undefined): string | null {
  if (!origen) return null;
  const permitidos = config.CORS_ORIGIN.split(',').map((o) => o.trim());
  return permitidos.includes(origen) ? origen : null;
}

/**
 * Streaming del analisis por SSE.
 *
 * Es POST porque inicia una ejecucion con efectos, asi que el frontend lo
 * consume con fetch + ReadableStream en vez de EventSource. La cancelacion
 * viaja por el cierre de la conexion: el AbortController del navegador cierra
 * el request, Fastify emite 'close' y ese signal se propaga hasta la llamada
 * al proveedor.
 *
 * Se transmite unicamente progreso, acciones, fuentes y resultado. Nunca
 * razonamiento, prompt interno ni tokens del modelo.
 */
export async function agentStreamRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/applications/:id/analyze/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = Body.parse(request.body ?? {});

    // Se toma control del socket: a partir de aqui Fastify no intenta enviar su
    // propia respuesta. Sin esto el stream escribe bien pero nunca cierra,
    // porque Fastify sigue esperando serializar un payload.
    //
    // El precio de hijack() es que TODOS los headers que @fastify/cors habia
    // preparado con reply.header() se pierden: esos viven en el objeto reply de
    // Fastify y se vuelcan al socket al enviar, cosa que ya no ocurre. El
    // preflight OPTIONS seguia respondiendo 204 correctamente porque lo maneja
    // el plugin antes de llegar aqui, asi que el problema era invisible desde
    // el lado del servidor: el navegador recibia los eventos y los descartaba
    // por falta de Access-Control-Allow-Origin.
    //
    // Por eso los headers CORS se escriben explicitamente sobre reply.raw.
    reply.hijack();

    const origen = origenPermitido(request.headers.origin);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // La respuesta depende del Origin, asi que no puede cachearse compartida.
      Vary: 'Origin',
      ...(origen === null ? {} : { 'Access-Control-Allow-Origin': origen }),
    });
    reply.raw.flushHeaders();

    let sequence = 0;
    let cerrado = false;

    const enviar = (evento: AgentEvent): void => {
      if (cerrado) return;
      reply.raw.write(`event: ${evento.type}\ndata: ${JSON.stringify(evento)}\n\n`);
    };

    const controller = new AbortController();
    let terminado = false;
    reply.raw.on('close', () => {
      cerrado = true;
      if (!terminado) controller.abort();
    });

    // Se usa un uuid provisional hasta que llega el run.started con el real:
    // asi todo evento cumple AgentEventSchema desde el primero.
    let runId: string = randomUUID();

    const emitir = (e: { type: string; label?: string; data?: Record<string, unknown> }): void => {
      // El run_id real aparece con el primer evento; antes de eso se usa uno
      // provisional para que el contrato AgentEvent se cumpla siempre.
      if (e.type === 'run.started' && typeof e.data?.['run_id'] === 'string') {
        runId = e.data['run_id'];
      }
      sequence += 1;
      const parsed = AgentEventSchema.safeParse({
        type: e.type,
        run_id: runId,
        sequence,
        at: new Date().toISOString(),
        ...(e.label ? { label: e.label } : {}),
        ...(e.data ? { data: e.data } : {}),
      });
      if (parsed.success) enviar(parsed.data);
    };

    try {
      const provider = buildAgentProvider(pool, DEFAULT_AGENT_LIMITS);
      const resultado = await analizarSolicitud(pool, provider, {
        idSolicitud: id,
        signal: controller.signal,
        onEvent: emitir,
        ...(body.session_id ? { sessionId: body.session_id } : {}),
        ...(body.intento_logico ? { intentoLogico: body.intento_logico } : {}),
        ...(body.consulta ? { consultaAnalista: body.consulta } : {}),
      });

      // Evento terminal con el resultado completo, para que la UI no tenga que
      // rearmarlo a partir del stream.
      sequence += 1;
      enviar({
        type: resultado.failure ? 'run.failed' : 'run.completed',
        run_id: resultado.runId,
        sequence,
        at: new Date().toISOString(),
        label: resultado.failure ? 'Analisis finalizado con error' : 'Resultado disponible',
        data: { resultado: resultado as unknown as Record<string, unknown> },
      });
    } catch (error) {
      request.log.warn({ err: error }, 'fallo el analisis en streaming');
      sequence += 1;
      enviar({
        type: 'run.failed',
        run_id: runId,
        sequence,
        at: new Date().toISOString(),
        label: 'El analisis no pudo completarse',
        data: {
          status: statusForError(error),
          code: toErrorBody(error).error.code,
          detail: toErrorBody(error).error.message,
        },
      });
    } finally {
      terminado = true;
      if (!cerrado) reply.raw.end();
      cerrado = true;
    }
  });
}
