import { useCallback, useEffect, useState } from 'react';
import type { Indicadores, Solicitud } from '@credit/contracts';
import { ApplicationDetail } from './components/ApplicationDetail.js';
import { ApplicationList } from './components/ApplicationList.js';
import { AgentActivityTimeline } from './components/AgentActivityTimeline.js';
import { DictamenPanel } from './components/DictamenPanel.js';
import { ExecutionDetails } from './components/ExecutionDetails.js';
import { IndicatorPanel } from './components/IndicatorPanel.js';
import { MetricsPanel } from './components/MetricsPanel.js';
import { Badge } from './components/StatusBadge.js';
import { useAnalysisStream } from './hooks/useAnalysisStream.js';
import { useApplications } from './hooks/useApplications.js';
import { api, type RunDetalle, type VersionInfo } from './services/api.js';
import type { AnalisisResultado } from './types/view.js';

type Tab = 'analisis' | 'metricas';

export function App() {
  const solicitudes = useApplications();
  const analisis = useAnalysisStream();

  const [seleccionada, setSeleccionada] = useState<Solicitud | null>(null);
  const [indicadores, setIndicadores] = useState<Indicadores | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [dbArriba, setDbArriba] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('analisis');
  const [refrescoMetricas, setRefrescoMetricas] = useState(0);
  const [runDetalle, setRunDetalle] = useState<RunDetalle | null>(null);

  useEffect(() => {
    api.version().then(setVersion).catch(() => setVersion(null));
    api.health().then((h) => setDbArriba(h.database === 'up')).catch(() => setDbArriba(false));
  }, []);

  // La metadata de ejecucion vive en el agent_run, no en el dictamen. Cuando hay
  // un run asociado se lee de la API; si no existe, la UI muestra N/D en vez de
  // rellenar con ceros.
  const runId = analisis.resultado?.runId ?? null;
  useEffect(() => {
    if (!runId) {
      setRunDetalle(null);
      return;
    }
    let cancelado = false;
    api.run(runId)
      .then((r) => { if (!cancelado) setRunDetalle(r); })
      .catch(() => { if (!cancelado) setRunDetalle(null); });
    return () => { cancelado = true; };
  }, [runId]);

  // Al cambiar de solicitud se cargan sus indicadores y su último dictamen, si existe.
  const seleccionar = useCallback(async (s: Solicitud) => {
    setSeleccionada(s);
    analisis.limpiar();
    setIndicadores(null);

    try {
      setIndicadores(await api.indicators(s.id_solicitud));
    } catch {
      setIndicadores(null);
    }
    try {
      const previo = await api.decisionDeSolicitud(s.id_solicitud);
      analisis.setResultado(reconstruirDesdeDictamen(previo));
    } catch {
      // Sin dictamen previo: es lo normal antes del primer análisis.
    }
  }, [analisis]);

  const autorizar = useCallback(async (idDictamen: string, accion: 'CONFIRMAR' | 'RECHAZAR') => {
    const r = await api.autorizar(idDictamen, accion);
    analisis.setResultado((previo) =>
      previo && previo.confirmacion
        ? { ...previo, confirmacion: { ...previo.confirmacion, operational_status: r.operational_status as never } }
        : previo,
    );
    setRefrescoMetricas((n) => n + 1);
  }, [analisis]);

  const g5 = (analisis.resultado?.findings ?? []).find((f) => f.guardrail === 'G5');
  const patronesG5 = ((g5?.details as { patrones?: string[] } | undefined)?.patrones) ?? [];

  const corriendo = analisis.estado === 'corriendo';

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Asistente de Originación PyME</h1>
          <span className="muted small">El LLM propone · el software verifica · la base restringe · el humano confirma</span>
        </div>
        <div className="topbar__estado">
          <Badge tono={dbArriba === null ? 'neutral' : dbArriba ? 'ok' : 'danger'}>
            API {dbArriba === null ? '…' : dbArriba ? 'conectada' : 'sin base'}
          </Badge>
          <Badge tono={version?.config.llm_configured ? 'ok' : 'warn'}>
            {version?.config.model ?? 'modelo no configurado'}
          </Badge>
        </div>
      </header>

      <nav className="tabs">
        <button type="button" className={tab === 'analisis' ? 'tab tab--on' : 'tab'} onClick={() => setTab('analisis')}>
          Análisis
        </button>
        <button type="button" className={tab === 'metricas' ? 'tab tab--on' : 'tab'} onClick={() => setTab('metricas')}>
          Métricas
        </button>
      </nav>

      {tab === 'metricas' ? (
        <main className="contenido contenido--simple">
          <MetricsPanel refrescar={refrescoMetricas} />
        </main>
      ) : (
        <main className="contenido">
          <div className="col col--izq">
            <ApplicationList
              visibles={solicitudes.visibles}
              seleccionada={seleccionada?.id_solicitud ?? null}
              onSeleccionar={(s) => void seleccionar(s)}
              cargando={solicitudes.cargando}
              error={solicitudes.error}
              filtro={solicitudes.filtro}
              onFiltro={solicitudes.setFiltro}
              busqueda={solicitudes.busqueda}
              onBusqueda={solicitudes.setBusqueda}
            />
          </div>

          <div className="col col--centro">
            {!seleccionada && (
              <section className="panel">
                <p className="muted pad">
                  Selecciona una solicitud del listado para ver sus datos e iniciar el análisis.
                </p>
              </section>
            )}

            {seleccionada && (
              <>
                <ApplicationDetail
                  solicitud={seleccionada}
                  indicadores={indicadores}
                  g5Detectado={g5 !== undefined}
                  patronesG5={patronesG5}
                />

                <div className="acciones">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={corriendo}
                    onClick={() => void analisis.analizar(seleccionada.id_solicitud)}
                  >
                    {corriendo ? 'Analizando…' : 'Analizar solicitud'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!corriendo}
                    onClick={analisis.cancelar}
                  >
                    Cancelar
                  </button>
                </div>

                <AgentActivityTimeline eventos={analisis.eventos} estado={analisis.estado} />
                <IndicatorPanel indicadores={indicadores} />
              </>
            )}
          </div>

          <div className="col col--der">
            <DictamenPanel
              resultado={analisis.resultado}
              estado={analisis.estado}
              error={analisis.error}
              onAutorizar={autorizar}
              onReintentar={() => seleccionada && void analisis.analizar(seleccionada.id_solicitud)}
            />
            {analisis.resultado && (
              <ExecutionDetails resultado={analisis.resultado} version={version} runDetalle={runDetalle} />
            )}
          </div>
        </main>
      )}
    </div>
  );
}

interface DictamenPersistido {
  id?: string;
  application_id?: string;
  agent_run_id?: string | null;
  decision?: string;
  recommended_amount?: string | null;
  recommended_term_months?: number | null;
  risk_level?: string;
  confidence?: string;
  requires_human_authorization?: boolean;
  operational_status?: string;
  reasons?: string[];
  indicators_snapshot?: Record<string, unknown>;
  citas?: Array<{ id_politica: string; seccion: string; texto_literal: string }>;
  created_at?: string;
}

/**
 * Reconstruye la vista a partir del último dictamen persistido, para que al
 * volver a una solicitud ya analizada no se pierda el resultado.
 *
 * Los campos de ejecución quedan en `null`, no en cero: pertenecen al
 * `agent_run` y se recuperan aparte con `GET /api/runs/:id` usando el
 * `agent_run_id` de esta fila. Si ese run no existe, la UI muestra N/D.
 */
function reconstruirDesdeDictamen(fila: Record<string, unknown>): AnalisisResultado {
  const d = fila as DictamenPersistido;
  return {
    runId: d.agent_run_id ?? null,
    confirmacion: {
      id_dictamen: d.id ?? '',
      id_solicitud: d.application_id ?? '',
      operational_status: (d.operational_status ?? 'GENERATED') as never,
      decision: (d.decision ?? 'ESCALADO_A_COMITE') as never,
      requiere_autorizacion_humana: d.requires_human_authorization ?? false,
      reutilizado: true,
      created_at: d.created_at ?? '',
    },
    dictamen: {
      id_solicitud: d.application_id ?? '',
      decision: (d.decision ?? 'ESCALADO_A_COMITE') as never,
      monto_recomendado: d.recommended_amount ?? null,
      plazo_recomendado_meses: d.recommended_term_months ?? null,
      indicadores: (d.indicators_snapshot ?? {}) as never,
      politicas_citadas: d.citas ?? [],
      motivos: d.reasons ?? [],
      nivel_riesgo: (d.risk_level ?? 'MEDIO') as never,
      requiere_autorizacion_humana: d.requires_human_authorization ?? false,
      confianza: Number(d.confidence ?? 0),
    },
    politicasRecuperadas: [],
    findings: [],
    // null, no cero: esta metadata es del run y todavia no se conoce.
    usage: null,
    latencyMs: null,
    toolSequence: null,
    resolvedModel: null,
    lastFinishReason: null,
    iterationDiagnostics: [],
  };
}
