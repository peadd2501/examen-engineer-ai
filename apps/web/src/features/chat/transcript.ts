import type { AgentEvent } from '@credit/contracts';
import { comoQuetzales, describirError } from '../analysis/format.js';
import type { AnalisisResultado, ErrorAnalisis, EstadoAnalisis } from '../../types/view.js';

/**
 * Transcripción del chat.
 *
 * CHAT es conversación —la pregunta del analista y una respuesta en prosa—;
 * PROGRESO son los pasos de ejecución. El chat no enumera eventos: hacerlo
 * duplicaba la misma lista en pantalla y empujaba la respuesta hacia abajo.
 *
 * Todo texto de esta capa es constante escrita aquí o dato del resultado ya
 * validado por el backend. De los eventos se usa únicamente el `type`, nunca su
 * texto, así que no hay superficie por la que puedan filtrarse razonamiento
 * interno ni contenido no verificado. La narrativa se deriva del MISMO objeto que
 * alimenta el panel Dictamen, así que las dos vistas no pueden contradecirse.
 */

export type RolChat = 'usuario' | 'asistente';
export type EstadoMensaje = 'streaming' | 'listo' | 'error' | 'cancelado';

export interface MensajeChat {
  id: string;
  rol: RolChat;
  texto: string;
  /** Solo para mensajes del asistente. */
  estado?: EstadoMensaje;
}

/** Lo que el botón «Analizar solicitud» escribe en el chat. */
export const CONSULTA_ANALISIS_POR_DEFECTO =
  'Analiza esta solicitud y determina qué políticas aplican.';

/** Estado inicial del hilo, antes del primer mensaje. */
export const SALUDO_ASISTENTE =
  'Hola. Puedo ayudarte a analizar esta solicitud, revisar políticas aplicables o explicar sus indicadores.';

/** Vista del análisis que el chat consume. Es la del hook de streaming. */
export interface VistaAnalisis {
  eventos: AgentEvent[];
  estado: EstadoAnalisis;
  resultado: AnalisisResultado | null;
  error: ErrorAnalisis | null;
}

/**
 * Estado discreto durante la generación.
 *
 * Tres frases fijas; cuál se muestra lo decide el último evento recibido, no un
 * temporizador. Del evento se usa únicamente el `type`.
 */
export function estadoDeStreaming(eventos: AgentEvent[]): string {
  for (let i = eventos.length - 1; i >= 0; i -= 1) {
    const tipo = eventos[i]?.type;
    if (tipo === 'dictamen.partial' || tipo === 'dictamen.completed' || tipo === 'guardrail.checked') {
      return 'Validando el resultado';
    }
    if (tipo === 'policy.found' || tipo === 'tool.started' || tipo === 'tool.completed') {
      return 'Revisando políticas aplicables';
    }
  }
  return 'Analizando la solicitud';
}

/** Apertura de la respuesta, según qué resolvió el sistema. */
function apertura(decision: string, requiereAutorizacion: boolean, monto: string): string {
  if (decision === 'APROBADO' && requiereAutorizacion) {
    return (
      `Sí puede recibir una recomendación favorable${monto}, pero no queda aprobada de forma ` +
      'definitiva hasta contar con la autorización humana requerida.'
    );
  }
  if (decision === 'APROBADO') return `Sí. La solicitud puede aprobarse${monto}.`;
  if (decision === 'RECHAZADO') return 'No recomiendo aprobarla.';
  return 'No puede resolverse automáticamente con las políticas disponibles y debe escalarse a comité.';
}

/** Une los motivos del dictamen en una sola frase legible. */
function motivosEnProsa(motivos: string[]): string | null {
  if (motivos.length === 0) return null;
  return motivos
    .map((m) => m.trim())
    .filter((m) => m !== '')
    .map((m) => (m.endsWith('.') ? m : `${m}.`))
    .join(' ');
}

/**
 * Respuesta del asistente: contesta la pregunta y remite al panel para el
 * detalle. Todo lo que afirma sale del dictamen ya validado.
 */
export function narrativaDeResultado(resultado: AnalisisResultado | null): string {
  const dictamen = resultado?.dictamen ?? null;
  if (!dictamen) {
    return 'El análisis terminó sin una recomendación. Revisá el panel Dictamen para ver el estado registrado.';
  }

  const estado = resultado?.confirmacion?.operational_status ?? null;
  const requiereAutorizacion =
    estado === 'PENDING_AUTHORIZATION' || resultado?.confirmacion?.requiere_autorizacion_humana === true;

  // La decisión que manda es la CONFIRMADA, la misma que muestra el panel. El
  // dictamen candidato puede traer otra si el backend la degradó, y el chat no
  // puede anunciar una aprobación que el panel dejó en comité.
  const decision = estado === 'PENDING_COMMITTEE'
    ? 'ESCALADO_A_COMITE'
    : resultado?.confirmacion?.decision ?? dictamen.decision;

  const monto =
    dictamen.monto_recomendado !== null
      ? ` por ${comoQuetzales(dictamen.monto_recomendado)}` +
        (dictamen.plazo_recomendado_meses !== null ? ` a ${dictamen.plazo_recomendado_meses} meses` : '')
      : '';

  const partes: string[] = [apertura(decision, requiereAutorizacion, monto)];

  const motivos = motivosEnProsa(dictamen.motivos);
  if (motivos !== null) partes.push(motivos);

  if (decision !== 'ESCALADO_A_COMITE') {
    partes.push(`El nivel de riesgo es ${dictamen.nivel_riesgo}.`);
  }

  const citas = dictamen.politicas_citadas.map((c) => c.id_politica);
  if (citas.length > 0) partes.push(`Políticas aplicables: ${citas.join(', ')}.`);

  partes.push('Podés consultar el detalle completo y las citas verificadas en el panel Dictamen.');
  return partes.join(' ');
}

/** Mensaje de fallo, en lenguaje de analista y sin borrar lo anterior. */
export function textoDeError(error: ErrorAnalisis | null): string {
  const base = error ? describirError(error.code) : 'El análisis no pudo completarse.';
  return `${base} No se generó ninguna recomendación nueva; el panel Dictamen conserva el último estado registrado.`;
}

/**
 * Proyecta el mensaje del asistente para el estado actual del análisis.
 *
 * Mientras corre, el mensaje no tiene texto: la burbuja muestra el estado
 * discreto. Al terminar, el texto pasa a ser la respuesta.
 */
export function proyectarRespuesta(base: MensajeChat, vista: VistaAnalisis): MensajeChat {
  if (vista.estado === 'corriendo') {
    return { ...base, estado: 'streaming', texto: '' };
  }

  if (vista.estado === 'cancelado') {
    return {
      ...base,
      estado: 'cancelado',
      texto:
        'Análisis cancelado. Lo que el servidor haya confirmado antes de la cancelación se mantiene: ' +
        'revisá el panel Dictamen.',
    };
  }

  // El error de dominio gana sobre cualquier resultado parcial: no se narra una
  // recomendación a partir de un análisis que falló.
  if (vista.estado === 'error' || vista.error !== null) {
    return { ...base, estado: 'error', texto: textoDeError(vista.error) };
  }

  if (vista.estado === 'completado') {
    return { ...base, estado: 'listo', texto: narrativaDeResultado(vista.resultado) };
  }

  return base;
}
