import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Solicitud } from '@credit/contracts';
import { api } from '../services/api.js';

/** Extrae el codigo de fixture (CASE-01, ADV-INJ-03...) del nombre de la empresa. */
export function codigoFixture(nombre: string): string | null {
  const evalCase = /EVAL-(CASE-\d+)/.exec(nombre);
  if (evalCase) return evalCase[1] as string;
  const adversarial = /(ADV-(?:INJ|INC)-\d+)/.exec(nombre);
  return adversarial ? (adversarial[1] as string) : null;
}

export type FiltroSolicitudes = 'todas' | 'fixtures' | 'adversariales';

export function useApplications() {
  const [items, setItems] = useState<Solicitud[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<FiltroSolicitudes>('fixtures');
  const [busqueda, setBusqueda] = useState('');

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      const { items: recibidos } = await api.applications(200);
      setItems(recibidos);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las solicitudes');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return items
      .filter((s) => {
        const codigo = codigoFixture(s.nombre_empresa);
        if (filtro === 'fixtures') return codigo?.startsWith('CASE-') ?? false;
        if (filtro === 'adversariales') return codigo?.startsWith('ADV-') ?? false;
        return true;
      })
      .filter((s) => texto === '' || s.nombre_empresa.toLowerCase().includes(texto) || s.sector.includes(texto))
      .sort((a, b) => a.nombre_empresa.localeCompare(b.nombre_empresa));
  }, [items, filtro, busqueda]);

  return { items, visibles, cargando, error, filtro, setFiltro, busqueda, setBusqueda, recargar };
}
