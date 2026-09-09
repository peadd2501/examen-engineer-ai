import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentEvent } from '@credit/contracts';
import { App } from '../App.js';
import { ChatPanel } from './ChatPanel.js';
import { IndicatorPanel } from './IndicatorPanel.js';
import { AgentActivityTimeline } from './AgentActivityTimeline.js';
import { DictamenPanel } from './DictamenPanel.js';
import { analizarConStream } from '../services/analysis-stream.js';
import {
  CONSULTA_ANALISIS_POR_DEFECTO,
  SALUDO_ASISTENTE,
  estadoDeStreaming,
  narrativaDeResultado,
  proyectarRespuesta,
  type MensajeChat,
} from '../features/chat/transcript.js';
import type { AnalisisResultado } from '../types/view.js';

/**
 * Tests del chat. Igual que los de UI: renderToStaticMarkup para lo visual y
 * funciones puras para la logica de transcripcion, sin stack adicional.
 */

const RUN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

let seq = 0;
function evento(type: AgentEvent['type'], label: string, data?: Record<string, unknown>): AgentEvent {
  seq += 1;
  return { type, run_id: RUN_ID, sequence: seq, at: '2026-09-09T00:00:00.000Z', label, ...(data ? { data } : {}) };
}

const EVENTOS_BASE: AgentEvent[] = [
  evento('run.started', 'Analisis iniciado'),
  evento('application.loaded', 'Solicitud cargada'),
  evento('indicators.loaded', 'Indicadores calculados'),
  evento('tool.started', 'Buscando politicas'),
  evento('tool.completed', 'Busqueda de politicas: listo', { status: 'OK', latency_ms: 7 }),
  evento('policy.found', 'Politica POL-2.1 consultada', { id_politica: 'POL-2.1', seccion: '2.1 Razon de endeudamiento' }),
];

const DICTAMEN = {
  id_solicitud: '11111111-1111-4111-8111-111111111111',
  decision: 'APROBADO',
  monto_recomendado: '180000.00',
  plazo_recomendado_meses: 36,
  indicadores: {},
  politicas_citadas: [{ id_politica: 'POL-2.1', seccion: '2.1 Razón de endeudamiento', texto_literal: 'No debe exceder 0.70.' }],
  motivos: ['Indicadores dentro de los umbrales de política.'],
  nivel_riesgo: 'MEDIO',
  requiere_autorizacion_humana: false,
  confianza: 0.88,
};

function resultado(over: Partial<AnalisisResultado> = {}, confirmacionOver = {}): AnalisisResultado {
  return {
    runId: RUN_ID,
    confirmacion: {
      id_dictamen: 'bbbbbbbb-2222-4222-8222-222222222222',
      id_solicitud: DICTAMEN.id_solicitud,
      operational_status: 'GENERATED',
      decision: 'APROBADO',
      requiere_autorizacion_humana: false,
      reutilizado: false,
      created_at: '2026-09-09T00:00:00.000Z',
      ...confirmacionOver,
    } as never,
    dictamen: DICTAMEN as never,
    politicasRecuperadas: [],
    findings: [],
    usage: null,
    latencyMs: null,
    toolSequence: null,
    resolvedModel: null,
    lastFinishReason: null,
    iterationDiagnostics: [],
    ...over,
  };
}

const enBlanco: MensajeChat = { id: 'a1', rol: 'asistente', texto: '', estado: 'streaming' };

const renderChat = (mensajes: MensajeChat[], corriendo = false, eventos: AgentEvent[] = []): string =>
  renderToStaticMarkup(
    <ChatPanel
      mensajes={mensajes}
      eventos={eventos}
      corriendo={corriendo}
      habilitado
      onEnviar={() => undefined}
      onCancelar={() => undefined}
    />,
  );

// --- el chat existe y es identificable -------------------------------------

test('el chat expone un input de texto y un boton Enviar visibles', () => {
  const html = renderChat([]);
  assert.ok(html.includes('Chat de análisis'), 'el panel se identifica como chat');
  assert.ok(html.includes('<input'), 'hay input de texto');
  assert.ok(html.includes('Pregunta sobre esta solicitud...'), 'el input tiene placeholder visible');
  assert.ok(html.includes('Enviar'), 'hay botón Enviar');
});

test('mientras genera aparece el boton de cancelar y desaparece al terminar', () => {
  const generando = renderChat([enBlanco], true);
  assert.ok(generando.includes('Cancelar'), 'se puede cancelar en pleno streaming');
  assert.ok(generando.includes('generando respuesta'));

  const terminado = renderChat([{ ...enBlanco, estado: 'listo', texto: 'Listo.' }], false);
  assert.ok(!terminado.includes('Cancelar'), 'sin generación en curso no hay nada que cancelar');
});

// --- mensajes del usuario y del asistente ----------------------------------

test('el mensaje del analista se renderiza en el hilo', () => {
  const html = renderChat([{ id: 'u1', rol: 'usuario', texto: '¿Aplica la excepción POL-9.1 en este caso?' }]);
  assert.ok(html.includes('¿Aplica la excepción POL-9.1 en este caso?'));
  assert.ok(html.includes('Analista'), 'el turno se atribuye al analista');
});

test('«Analizar solicitud» escribe en el chat la consulta equivalente', () => {
  assert.match(CONSULTA_ANALISIS_POR_DEFECTO, /Analiza esta solicitud/);
  assert.match(CONSULTA_ANALISIS_POR_DEFECTO, /qué políticas aplican/);

  const html = renderChat([{ id: 'u1', rol: 'usuario', texto: CONSULTA_ANALISIS_POR_DEFECTO }]);
  assert.ok(html.includes('Analiza esta solicitud'), 'la acción queda reflejada en el hilo');
  assert.ok(html.includes('chat__msg--usuario'), 'aparece como turno del Analista');
});

// --- streaming progresivo ---------------------------------------------------

test('durante la generacion la burbuja muestra solo el estado, nunca la lista de eventos', () => {
  const enCurso = proyectarRespuesta(enBlanco, {
    eventos: EVENTOS_BASE, estado: 'corriendo', resultado: null, error: null,
  });
  assert.equal(enCurso.estado, 'streaming');
  assert.equal(enCurso.texto, '', 'sin texto hasta que haya respuesta');

  const html = renderChat([enCurso], true, EVENTOS_BASE);
  assert.ok(html.includes('Revisando políticas aplicables'), 'estado discreto');
  assert.ok(html.includes('chat__puntos'), 'con su indicador de actividad');

  // Ninguna etiqueta de evento entra a la burbuja: eso vive en Progreso.
  for (const etiqueta of EVENTOS_BASE.map((e) => e.label as string)) {
    assert.ok(!html.includes(etiqueta), `la burbuja no debe repetir «${etiqueta}»`);
  }
  assert.ok(!html.includes('POL-2.1'), 'las politicas se nombran en la respuesta, no paso a paso');
  assert.ok(!html.includes('<ol'), 'sin enumeracion de eventos dentro del chat');
});

test('el estado de generacion avanza con el analisis, en tres frases fijas', () => {
  assert.equal(estadoDeStreaming([]), 'Analizando la solicitud');
  assert.equal(estadoDeStreaming(EVENTOS_BASE.slice(0, 3)), 'Analizando la solicitud');
  assert.equal(estadoDeStreaming(EVENTOS_BASE), 'Revisando políticas aplicables');
  assert.equal(
    estadoDeStreaming([...EVENTOS_BASE, evento('guardrail.checked', 'Validaciones de seguridad completadas')]),
    'Validando el resultado',
  );
});

test('el progreso paso a paso sigue estando, pero en su propio panel', () => {
  const progreso = renderToStaticMarkup(<AgentActivityTimeline eventos={EVENTOS_BASE} estado="corriendo" />);
  assert.ok(progreso.includes('Progreso del análisis'));
  for (const etiqueta of EVENTOS_BASE.map((e) => e.label as string)) {
    assert.ok(progreso.includes(etiqueta), `«${etiqueta}» debe seguir siendo observable`);
  }
  assert.ok(progreso.includes('POL-2.1'), 'la observabilidad no se recorto');
});

test('al completar, la burbuja responde y deja de mostrar el estado', () => {
  const final = proyectarRespuesta(enBlanco, {
    eventos: EVENTOS_BASE, estado: 'completado', resultado: resultado(), error: null,
  });
  assert.equal(final.estado, 'listo');

  const html = renderChat([final]);
  assert.ok(html.includes('Asistente'));
  assert.ok(!html.includes('chat__puntos'), 'ya no muestra el indicador de generación');
  assert.ok(!html.includes('Analizando la solicitud'));
  assert.ok(!html.includes('Citas verificadas'), 'las citas van una sola vez, dentro de la respuesta');
});

// --- la respuesta contesta la pregunta -------------------------------------

test('una aprobacion responde que si, con monto, plazo, riesgo y politicas', () => {
  const texto = narrativaDeResultado(resultado());
  assert.ok(texto.startsWith('Sí. La solicitud puede aprobarse por Q 180,000.00 a 36 meses.'));
  assert.ok(texto.includes('Indicadores dentro de los umbrales de política.'), 'los motivos, en prosa');
  assert.ok(texto.includes('El nivel de riesgo es MEDIO.'));
  assert.ok(texto.includes('Políticas aplicables: POL-2.1.'), 'ids compactos, sin texto literal');
  assert.ok(texto.includes('panel Dictamen'), 'remite al detalle completo');
  assert.ok(!texto.includes('No debe exceder 0.70'), 'el texto literal pertenece al panel');
});

test('una aprobacion con autorizacion humana no se anuncia como definitiva', () => {
  const texto = narrativaDeResultado(
    resultado({}, { operational_status: 'PENDING_AUTHORIZATION', requiere_autorizacion_humana: true }),
  );
  assert.ok(texto.startsWith('Sí puede recibir una recomendación favorable'));
  assert.ok(texto.includes('no queda aprobada de forma definitiva hasta contar con la autorización humana'));
});

test('un escalamiento dice que no puede resolverse automaticamente', () => {
  const texto = narrativaDeResultado(resultado(
    { dictamen: { ...DICTAMEN, decision: 'ESCALADO_A_COMITE', monto_recomendado: null, plazo_recomendado_meses: null } as never },
    { operational_status: 'PENDING_COMMITTEE', decision: 'ESCALADO_A_COMITE' },
  ));
  assert.ok(texto.startsWith('No puede resolverse automáticamente con las políticas disponibles y debe escalarse a comité.'));
  assert.ok(!texto.includes('nivel de riesgo'), 'no se anuncia riesgo de algo que no se resolvio');
  assert.ok(!/^S[íi]\b/.test(texto));
});

test('un rechazo lo dice sin rodeos y con sus motivos', () => {
  const texto = narrativaDeResultado(resultado(
    { dictamen: { ...DICTAMEN, decision: 'RECHAZADO', monto_recomendado: null, plazo_recomendado_meses: null,
      motivos: ['El score de historial está por debajo del mínimo de 60 puntos.'] } as never },
    { decision: 'RECHAZADO' },
  ));
  assert.ok(texto.startsWith('No recomiendo aprobarla.'));
  assert.ok(texto.includes('por debajo del mínimo de 60 puntos'));
});

test('la respuesta no usa jerga de implementacion', () => {
  const textos = [
    narrativaDeResultado(resultado()),
    narrativaDeResultado(resultado({}, { operational_status: 'PENDING_AUTHORIZATION', requiere_autorizacion_humana: true })),
    narrativaDeResultado(null),
  ];
  for (const texto of textos) {
    for (const jerga of ['backend', 'LLM', 'schema', 'tool', 'reasoning', 'prompt', 'guardrail', 'corpus', 'dictamen estructurado']) {
      assert.ok(!texto.toLowerCase().includes(jerga.toLowerCase()), `«${jerga}» no debe aparecer: ${texto}`);
    }
  }
});

test('las tildes de la interfaz estan escritas, no omitidas', () => {
  const texto = narrativaDeResultado(resultado());
  assert.ok(texto.includes('Sí.'));
  assert.ok(texto.includes('Políticas'));
  assert.ok(texto.includes('Podés'));
  assert.ok(!/\bPoliticas\b|\bAnalisis\b|\brecomendacion\b/.test(texto), 'sin palabras sin tilde');
  assert.ok(estadoDeStreaming(EVENTOS_BASE).includes('políticas'));
});

// --- cancelacion ------------------------------------------------------------

test('cancelar aborta la peticion via AbortController y no la reporta como error', async () => {
  const original = globalThis.fetch;
  let señalRecibida: AbortSignal | null = null;

  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    señalRecibida = init?.signal ?? null;
    // Un fetch que nunca resuelve por si mismo: solo el abort lo termina.
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }) as typeof fetch;

  const controller = new AbortController();
  const errores: string[] = [];
  let termino = false;

  const corriendo = analizarConStream(
    DICTAMEN.id_solicitud,
    { onEvent: () => undefined, onError: (e) => errores.push(e.code), onDone: () => { termino = true; } },
    controller.signal,
    'consulta del analista',
  );

  await new Promise((r) => setTimeout(r, 0));
  assert.ok(señalRecibida, 'la petición viaja con el signal del AbortController');
  assert.equal(señalRecibida, controller.signal);

  controller.abort();
  await corriendo;

  globalThis.fetch = original;

  assert.ok(controller.signal.aborted);
  assert.ok(termino, 'el stream cierra limpiamente');
  assert.deepEqual(errores, [], 'cancelar es una acción del usuario, no un fallo');
});

test('la cancelacion no borra el hilo y no asume rollback en el servidor', () => {
  const cancelado = proyectarRespuesta(enBlanco, {
    eventos: EVENTOS_BASE, estado: 'cancelado', resultado: null, error: null,
  });
  assert.equal(cancelado.estado, 'cancelado');
  assert.ok(cancelado.texto.includes('Análisis cancelado'));

  const html = renderChat([{ id: 'u1', rol: 'usuario', texto: 'consulta previa' }, cancelado]);
  assert.ok(html.includes('consulta previa'), 'los mensajes anteriores siguen ahí');
  assert.ok(!/rollback|revertid/i.test(html), 'no se promete deshacer efectos ya confirmados');
});

// --- errores ----------------------------------------------------------------

test('un error de dominio se muestra sin borrar el estado previo ni inventar dictamen', () => {
  const conError = proyectarRespuesta(enBlanco, {
    eventos: EVENTOS_BASE,
    estado: 'error',
    resultado: resultado(),
    error: { code: 'OUTPUT_TOKEN_LIMIT_EXCEEDED', mensaje: 'x' },
  });

  assert.equal(conError.estado, 'error');
  assert.ok(conError.texto.includes('dentro del límite configurado'), 'mensaje comprensible');
  assert.ok(conError.texto.includes('panel Dictamen'), 'remite al estado autoritativo');
  assert.ok(!/puede aprobarse/.test(conError.texto), 'no se narra una recomendacion que no se emitio');
  assert.ok(!/Políticas aplicables/.test(conError.texto), 'un fallo no produce citas');

  const html = renderChat([{ id: 'u1', rol: 'usuario', texto: 'primera consulta' }, conError]);
  assert.ok(html.includes('primera consulta'), 'el historial sobrevive al error');
});

// --- el chat no puede contradecir al panel ---------------------------------

test('la narrativa sale del mismo resultado que el panel Dictamen', () => {
  const pendiente = narrativaDeResultado(
    resultado({}, { operational_status: 'PENDING_AUTHORIZATION', requiere_autorizacion_humana: true }),
  );
  assert.ok(pendiente.includes('no queda aprobada de forma definitiva'), 'el chat no declara firme lo que el panel deja pendiente');
  assert.ok(pendiente.includes('autorización humana'));

  // Aunque el candidato dijera APROBADO, si el panel lo dejo en comite el chat
  // no puede anunciar una aprobacion: manda la decision confirmada.
  const comite = narrativaDeResultado(resultado({}, { operational_status: 'PENDING_COMMITTEE' }));
  assert.ok(comite.startsWith('No puede resolverse automáticamente'));
  assert.ok(!comite.includes('puede aprobarse'), 'el chat no contradice al panel');
  assert.ok(!comite.includes('autorización humana'), 'escalar no es autorizar');
});

// --- nunca chain-of-thought -------------------------------------------------

test('el chat no renderiza razonamiento del modelo aunque venga en el evento', () => {
  const envenenados: AgentEvent[] = [
    evento('tool.completed', 'Búsqueda de políticas: listo', {
      status: 'OK',
      latency_ms: 7,
      reasoning: 'Primero pienso que el cliente miente y luego decido...',
      reasoning_details: [{ text: 'cadena de pensamiento interna' }],
      system_prompt: 'Eres un asistente de preanalisis...',
    }),
    // Un tipo de evento fuera de la lista blanca no debe llegar nunca al hilo.
    { ...evento('run.completed', 'Analisis completado'), type: 'modelo.penso' as never },
  ];

  const html = renderChat([proyectarRespuesta(enBlanco, {
    eventos: envenenados, estado: 'corriendo', resultado: null, error: null,
  })], true, envenenados);

  for (const prohibido of ['Primero pienso', 'cadena de pensamiento', 'reasoning_details', 'Eres un asistente de preanalisis']) {
    assert.ok(!html.includes(prohibido), `no debe renderizarse: ${prohibido}`);
  }
  // Ni siquiera la etiqueta segura del evento entra al chat: de los eventos solo
  // se usa el `type` para elegir una de tres frases propias.
  assert.ok(!html.includes('Búsqueda de políticas: listo'), 'el texto del evento vive en Progreso');
  assert.ok(html.includes('Revisando políticas aplicables'), 'la burbuja muestra una frase nuestra');
});

// --- textos de producto -----------------------------------------------------

test('los encabezados y notas usan lenguaje de producto, no de arquitectura', () => {
  const timeline = renderToStaticMarkup(<AgentActivityTimeline eventos={[]} estado="idle" />);
  assert.ok(timeline.includes('Progreso del análisis'));
  assert.ok(!timeline.includes('Actividad del agente'));

  const indicadores = renderToStaticMarkup(
    <IndicatorPanel
      indicadores={{
        id_solicitud: DICTAMEN.id_solicitud, razon_endeudamiento: '0.375000', margen_neto: '0.150000',
        cobertura_servicio_deuda: '2.727273', relacion_monto_ventas: '0.080000', antiguedad_meses: 96,
        cuota_anual_estimada: '50000.000000', calculation_version: 1, anomalias: [],
      }}
    />,
  );
  assert.ok(indicadores.includes('Indicadores calculados'));
  assert.ok(indicadores.includes('calculados automáticamente a partir de la información financiera registrada'));
  assert.ok(!indicadores.includes('aritmética decimal'));
  assert.ok(!indicadores.includes('dato autoritativo'));
});

test('la barra superior no expone jerga tecnica', () => {
  const html = renderToStaticMarkup(<App />);

  assert.ok(html.includes('Preanálisis y evaluación de solicitudes PyME'), 'subtítulo orientado al producto');
  assert.ok(html.includes('Base de datos no disponible') || html.includes('Verificando conexión'));
  assert.ok(html.includes('Servicio de análisis no disponible') || html.includes('Servicio de análisis activo'));

  for (const viejo of ['El LLM propone', 'modelo no configurado', 'API sin base', 'Actividad del agente']) {
    assert.ok(!html.includes(viejo), `el texto técnico «${viejo}» ya no debe aparecer`);
  }
});

// --- FASE 4.2: presentación ------------------------------------------------

test('el hilo vacio saluda en vez de quedar en blanco', () => {
  const html = renderChat([]);
  assert.ok(html.includes(SALUDO_ASISTENTE));
  assert.ok(html.includes('Puedo ayudarte a analizar esta solicitud'));
  assert.ok(html.includes('chat__msg--asistente'), 'el saludo se ve como mensaje del asistente');
});

test('los turnos se distinguen por burbuja, no solo por la etiqueta', () => {
  const html = renderChat([
    { id: 'u1', rol: 'usuario', texto: 'mi consulta' },
    { id: 'a1', rol: 'asistente', texto: 'mi respuesta', estado: 'listo' },
  ]);
  const posUsuario = html.indexOf('chat__msg--usuario');
  const posAsistente = html.indexOf('chat__msg--asistente');
  assert.ok(posUsuario > -1 && posAsistente > -1, 'cada rol tiene su propia burbuja');
  assert.ok(posUsuario < posAsistente, 'y conservan el orden del hilo');
});

test('el estado de generacion es discreto y sigue al ultimo evento', () => {
  const inicio = renderChat([enBlanco], true, EVENTOS_BASE.slice(0, 2));
  assert.ok(inicio.includes('Analizando la solicitud'), 'todavía no consultó nada');

  const buscando = renderChat([enBlanco], true, EVENTOS_BASE);
  assert.ok(buscando.includes('Revisando políticas aplicables'));

  const validando = renderChat([enBlanco], true, [
    ...EVENTOS_BASE,
    evento('guardrail.checked', 'Validaciones de seguridad completadas'),
  ]);
  assert.ok(validando.includes('Validando el resultado'));
  assert.ok(!validando.includes('Validaciones de seguridad completadas'), 'la etiqueta cruda no entra al chat');

  for (const html of [inicio, buscando, validando]) {
    assert.ok(!/reasoning|prompt|chain-of-thought/i.test(html), 'el estado nunca revela lo interno');
  }
});

test('el progreso se ve como timeline compacto con pendientes marcados', () => {
  const html = renderToStaticMarkup(<AgentActivityTimeline eventos={EVENTOS_BASE} estado="corriendo" />);
  assert.ok(html.includes('✓'), 'los pasos hechos van marcados');
  assert.ok(html.includes('○'), 'y lo que falta también');
  assert.ok(html.includes('Generando dictamen'), 'el pendiente real se nombra');
  assert.ok(html.includes('paso--ok') && html.includes('paso--activo'), 'el estado no depende solo del color');

  const terminado = renderToStaticMarkup(
    <AgentActivityTimeline eventos={[...EVENTOS_BASE, evento('dictamen.completed', 'Dictamen generado')]} estado="completado" />,
  );
  assert.ok(!terminado.includes('Generando dictamen'), 'ya no está pendiente');
});

test('las citas quedan compactas pero con el texto exacto a la vista', () => {
  const html = renderToStaticMarkup(
    <DictamenPanel resultado={resultado()} estado="completado" error={null} onAutorizar={async () => undefined} onReintentar={() => undefined} />,
  );
  assert.ok(html.includes('<details class="cita" open'), 'colapsable, pero abierta por defecto');
  assert.ok(html.includes('POL-2.1'));
  assert.ok(html.includes('No debe exceder 0.70.'), 'la cita literal nunca se oculta');
});

test('el dictamen se lee en orden: decision, riesgo, estado, confianza, cifras', () => {
  const html = renderToStaticMarkup(
    <DictamenPanel resultado={resultado()} estado="completado" error={null} onAutorizar={async () => undefined} onReintentar={() => undefined} />,
  );
  const orden = ['APROBADO', 'Riesgo MEDIO', 'Generado', 'Confianza', 'Monto recomendado', 'Motivos', 'Políticas citadas'];
  let cursor = -1;
  for (const fragmento of orden) {
    const pos = html.indexOf(fragmento);
    assert.ok(pos > cursor, `«${fragmento}» debe ir después de lo anterior`);
    cursor = pos;
  }
});

test('la pantalla principal no usa jerga de implementacion', () => {
  const pantallas = [
    renderToStaticMarkup(<App />),
    renderChat([{ id: 'a1', rol: 'asistente', texto: 'respuesta', estado: 'listo' }]),
    renderToStaticMarkup(<AgentActivityTimeline eventos={EVENTOS_BASE} estado="corriendo" />),
    renderToStaticMarkup(
      <DictamenPanel resultado={resultado()} estado="completado" error={null} onAutorizar={async () => undefined} onReintentar={() => undefined} />,
    ),
  ];
  // "Detalles de ejecución" es el único lugar donde lo técnico está permitido,
  // y no forma parte de estas pantallas.
  for (const html of pantallas) {
    for (const jerga of ['backend autoritativo', 'LLM', 'Zod', 'guardrail', 'Guardarraíl', 'tool call', 'reasoning', 'prompt', 'operational_status']) {
      assert.ok(!html.includes(jerga), `«${jerga}» no debe aparecer en la UI principal`);
    }
  }
});
