import { useEffect, useState } from 'react';
import { api, type VersionInfo } from './services/api.js';

type Estado = 'cargando' | 'ok' | 'error';

export function App() {
  const [estado, setEstado] = useState<Estado>('cargando');
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [db, setDb] = useState<string>('desconocido');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [v, health] = await Promise.all([api.version(), api.dbHealth().catch(() => ({ database: 'down' }))]);
        if (cancelado) return;
        setVersion(v);
        setDb(health.database);
        setEstado('ok');
      } catch (e) {
        if (cancelado) return;
        setError(e instanceof Error ? e.message : 'error desconocido');
        setEstado('error');
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <main className="shell">
      <header>
        <h1>AI Credit Originator</h1>
        <p className="sub">Asistente de originacion crediticia PyME — FASE 1 (dominio determinista)</p>
      </header>

      <section className="card">
        <h2>Estado del sistema</h2>
        {estado === 'cargando' && <p>Consultando API...</p>}
        {estado === 'error' && <p className="err">API no disponible: {error}</p>}
        {estado === 'ok' && version && (
          <dl>
            <div><dt>API</dt><dd className="ok">conectada</dd></div>
            <div><dt>PostgreSQL</dt><dd className={db === 'up' ? 'ok' : 'err'}>{db}</dd></div>
            <div><dt>prompt_version</dt><dd>{version.prompt_version}</dd></div>
            <div><dt>policy_corpus_version</dt><dd>{version.policy_corpus_version}</dd></div>
            <div><dt>indicator_calc_version</dt><dd>{version.indicator_calc_version}</dd></div>
          </dl>
        )}
      </section>

      <section className="card muted">
        <h2>Pendiente</h2>
        <p>
          Chat, streaming SSE, panel de dictamen, citas, autorizacion humana y metricas se implementan
          en FASE 3 y FASE 5. Esta vista solo verifica el arranque del monorepo.
        </p>
      </section>
    </main>
  );
}
