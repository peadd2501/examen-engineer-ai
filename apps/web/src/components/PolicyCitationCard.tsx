import type { CitaPolitica } from '../types/view.js';

/**
 * Cita de política.
 *
 * El texto es literal del reglamento vigente y lo recupera el sistema desde el
 * corpus: no lo redacta el asistente ni el frontend.
 *
 * Acordeón con la primera abierta: con nueve o diez citas verificadas, dejarlas
 * todas desplegadas convertía la columna en un muro de texto.
 */
export function PolicyCitationCard({ cita, abierta = false }: { cita: CitaPolitica; abierta?: boolean }) {
  return (
    <details className="cita" open={abierta}>
      <summary>
        <code className="cita__id">{cita.id_politica}</code>
        <span className="cita__seccion">Sección {cita.seccion}</span>
      </summary>
      <blockquote className="cita__texto">{cita.texto_literal}</blockquote>
    </details>
  );
}

export function PolicyCitationList({ citas }: { citas: CitaPolitica[] }) {
  if (citas.length === 0) {
    return (
      <div className="aviso aviso--warn">
        <strong>Sin citas de política</strong>
        <p>
          El dictamen no se apoya en ninguna política verificada. Por eso no puede quedar como
          decisión firme.
        </p>
      </div>
    );
  }

  return (
    <div className="citas">
      {citas.map((c, i) => (
        <PolicyCitationCard key={`${c.id_politica}-${c.seccion}`} cita={c} abierta={i === 0} />
      ))}
    </div>
  );
}
