import type { Pool } from 'pg';
import { StateConflictError, type AutorizacionInput, type OperationalStatus } from '@credit/contracts';
import { DomainError } from '@credit/contracts';

export class DecisionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Dictamen no encontrado: ${id}`, 'DECISION_NOT_FOUND', { id });
  }
}

export interface AutorizacionResult {
  id_dictamen: string;
  operational_status: OperationalStatus;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

interface DecisionStateRow {
  id: string;
  operational_status: OperationalStatus;
  requires_human_authorization: boolean;
}

/**
 * G4, segunda mitad: la confirmacion humana.
 *
 * Es un endpoint separado, sin ninguna participacion del modelo. Valida el
 * estado actual, escribe la bitacora y cambia el estado en una transaccion.
 * El bloqueo FOR UPDATE evita que dos analistas confirmen el mismo dictamen.
 */
export async function autorizarDictamen(pool: Pool, input: AutorizacionInput): Promise<AutorizacionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<DecisionStateRow>(
      'SELECT id, operational_status, requires_human_authorization FROM decisions WHERE id = $1 FOR UPDATE',
      [input.id_dictamen],
    );
    const decision = rows[0];
    if (!decision) throw new DecisionNotFoundError(input.id_dictamen);

    if (decision.operational_status !== 'PENDING_AUTHORIZATION') {
      throw new StateConflictError(
        `El dictamen esta en estado ${decision.operational_status}; solo se puede resolver uno en PENDING_AUTHORIZATION`,
        { id_dictamen: decision.id, estado_actual: decision.operational_status },
      );
    }

    const nuevoEstado: OperationalStatus = input.accion === 'CONFIRMAR' ? 'CONFIRMED' : 'REJECTED_BY_ANALYST';

    await client.query(
      `INSERT INTO decision_authorizations (decision_id, action, analyst, comment) VALUES ($1,$2,$3,$4)`,
      [decision.id, input.accion, input.analista, input.comentario ?? null],
    );

    const { rows: actualizado } = await client.query<{
      id: string;
      operational_status: OperationalStatus;
      confirmed_at: Date | null;
      confirmed_by: string | null;
    }>(
      // $2 se castea explicitamente: sin el cast PostgreSQL intenta deducir un
      // unico tipo para el parametro usado a la vez como enum y como texto.
      `UPDATE decisions
          SET operational_status = $2::operational_status_t,
              confirmed_at = CASE WHEN $2::text = 'CONFIRMED' THEN now() ELSE confirmed_at END,
              confirmed_by = CASE WHEN $2::text = 'CONFIRMED' THEN $3::text ELSE confirmed_by END
        WHERE id = $1
        RETURNING id, operational_status, confirmed_at, confirmed_by`,
      [decision.id, nuevoEstado, input.analista],
    );

    await client.query('COMMIT');

    const fila = actualizado[0];
    if (!fila) throw new Error('El UPDATE del dictamen no devolvio fila');
    return {
      id_dictamen: fila.id,
      operational_status: fila.operational_status,
      confirmed_at: fila.confirmed_at ? fila.confirmed_at.toISOString() : null,
      confirmed_by: fila.confirmed_by,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
