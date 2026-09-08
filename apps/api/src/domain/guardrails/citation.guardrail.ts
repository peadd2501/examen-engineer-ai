import type { Pool } from 'pg';
import type { CitaPolitica } from '@credit/contracts';
import { fail, ok, type GuardrailFinding, type GuardrailOutcome } from './types.js';

interface PolicyRow { id: string; section: string; text: string; active: boolean }

/**
 * G1 — Cita verificable.
 *
 * No basta con que exista la politica. Se exige que la terna
 * (id_politica, seccion, texto_literal) coincida EXACTAMENTE con la fila del
 * corpus. Un id correcto con texto inventado, o un texto real atribuido a otra
 * seccion, son citas falsas.
 *
 * Se comparan las cadenas normalizadas solo en espacios en blanco: un modelo
 * puede reflowear saltos de linea sin que eso sea una cita falsa, pero no puede
 * cambiar una palabra ni una cifra.
 */
function normalizar(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

export interface CitationCheckInput {
  citas: CitaPolitica[];
  /** Decision firme = APROBADO o RECHAZADO. Un escalamiento puede no tener citas. */
  decisionFirme: boolean;
  /** Ids efectivamente devueltos por buscar_politica durante este run. */
  politicasRecuperadas: string[];
}

export interface CitationOutcome extends GuardrailOutcome {
  /**
   * Solo las citas que coincidieron exactamente con el corpus. Es lo unico que
   * se persiste: una cita inventada no puede quedar en la base ni siquiera
   * marcada como no verificada, porque su policy_id puede no existir.
   */
  citasVerificadas: CitaPolitica[];
}

export async function verificarCitas(pool: Pool, input: CitationCheckInput): Promise<CitationOutcome> {
  const findings: GuardrailFinding[] = [];
  const citasVerificadas: CitaPolitica[] = [];

  if (input.citas.length === 0) {
    if (input.decisionFirme) {
      return {
        ...fail(
          [{ guardrail: 'G1', code: 'MISSING_POLICY_CITATION', message: 'Una decision firme requiere al menos una cita de politica' }],
          true,
        ),
        citasVerificadas,
      };
    }
    return { ...ok(), citasVerificadas };
  }

  const ids = [...new Set(input.citas.map((c) => c.id_politica))];
  const { rows } = await pool.query<PolicyRow>(
    'SELECT id, section, text, active FROM policies WHERE id = ANY($1::text[])',
    [ids],
  );
  const porId = new Map(rows.map((r) => [r.id, r]));

  for (const cita of input.citas) {
    const politica = porId.get(cita.id_politica);

    if (!politica) {
      findings.push({
        guardrail: 'G1',
        code: 'UNVERIFIABLE_POLICY_CITATION',
        message: `La politica ${cita.id_politica} no existe en el corpus`,
        details: { id_politica: cita.id_politica, motivo: 'POLICY_NOT_FOUND' },
      });
      continue;
    }
    if (!politica.active) {
      findings.push({
        guardrail: 'G1',
        code: 'UNVERIFIABLE_POLICY_CITATION',
        message: `La politica ${cita.id_politica} no esta vigente`,
        details: { id_politica: cita.id_politica, motivo: 'POLICY_INACTIVE' },
      });
      continue;
    }
    if (normalizar(politica.section) !== normalizar(cita.seccion)) {
      findings.push({
        guardrail: 'G1',
        code: 'UNVERIFIABLE_POLICY_CITATION',
        message: `La seccion citada para ${cita.id_politica} no coincide con el corpus`,
        details: { id_politica: cita.id_politica, motivo: 'SECTION_MISMATCH', esperado: politica.section, recibido: cita.seccion },
      });
      continue;
    }
    if (normalizar(politica.text) !== normalizar(cita.texto_literal)) {
      findings.push({
        guardrail: 'G1',
        code: 'UNVERIFIABLE_POLICY_CITATION',
        message: `El texto literal citado para ${cita.id_politica} no coincide con el corpus`,
        details: { id_politica: cita.id_politica, motivo: 'TEXT_MISMATCH' },
      });
      continue;
    }
    // Una cita valida pero de una politica que el run nunca recupero indica que
    // el modelo la trajo de su memoria, no de la evidencia. Se registra sin
    // bloquear: el texto es verificablemente correcto.
    if (!input.politicasRecuperadas.includes(cita.id_politica)) {
      findings.push({
        guardrail: 'G1',
        code: 'CITATION_NOT_RETRIEVED',
        message: `La politica ${cita.id_politica} se cito sin haber sido recuperada en este run`,
        details: { id_politica: cita.id_politica },
      });
    }

    citasVerificadas.push(cita);
  }

  const bloqueantes = findings.filter((f) => f.code === 'UNVERIFIABLE_POLICY_CITATION');
  if (bloqueantes.length > 0) return { ...fail(findings, true), citasVerificadas };
  return { passed: true, findings, forceEscalation: false, citasVerificadas };
}
