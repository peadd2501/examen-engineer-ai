import type { CitaPolitica } from '../types/view.js';

/**
 * Cita de política.
 *
 * El texto es literal del corpus: lo trae el backend desde la base de datos,
 * no lo escribe el modelo ni el frontend. Es la evidencia de que la decisión
 * está respaldada por una política verificable.
 */
export function PolicyCitationCard({ cita }: { cita: CitaPolitica }) {
  return (
    <article className="cita">
      <header className="cita__head">
        <code className="cita__id">{cita.id_politica}</code>
        <span className="cita__seccion">Sección {cita.seccion}</span>
      </header>
      <blockquote className="cita__texto">{cita.texto_literal}</blockquote>
    </article>
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
      <p className="muted small">
        Texto literal del corpus vigente, recuperado por el backend. El asistente solo indicó
        qué políticas aplican; no redactó estas citas.
      </p>
      {citas.map((c) => <PolicyCitationCard key={`${c.id_politica}-${c.seccion}`} cita={c} />)}
    </div>
  );
}
