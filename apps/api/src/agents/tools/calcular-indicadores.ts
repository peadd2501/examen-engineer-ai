import { z } from 'zod';
import {
  ApplicationNotFoundError,
  IndicadoresSchema,
  InvalidFinancialDataError,
  calcularIndicadores,
  ratiosEqual,
} from '@credit/contracts';
import { rowToSolicitud, type ApplicationRow } from '../../infrastructure/application-repository.js';
import { defineTool } from './registry.js';

const Input = z.object({ id_solicitud: z.string().uuid() });

interface IndicatorRow {
  debt_ratio: string | null;
  net_margin: string | null;
  debt_service_coverage: string | null;
  amount_sales_ratio: string | null;
  calculation_version: number;
}

/**
 * Recalcula de forma determinista y ademas VERIFICA contra lo precalculado.
 * Una divergencia significa que los datos de la solicitud cambiaron sin
 * recalcular indicadores: es un error de integridad, no algo que el agente
 * deba interpretar.
 */
export const calcularIndicadoresTool = defineTool({
  name: 'calcular_indicadores',
  description:
    'Calcula los indicadores financieros de una solicitud (razon de endeudamiento, margen neto, ' +
    'cobertura de servicio de deuda, relacion monto sobre ventas y antiguedad). Estos valores son ' +
    'autoritativos: no deben recalcularse ni corregirse.',
  input: Input,
  output: IndicadoresSchema,
  exposedToModel: true,
  parameters: {
    type: 'object',
    properties: { id_solicitud: { type: 'string', description: 'UUID de la solicitud' } },
    required: ['id_solicitud'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { rows } = await ctx.pool.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [
      args.id_solicitud,
    ]);
    const row = rows[0];
    if (!row) throw new ApplicationNotFoundError(args.id_solicitud);

    const indicadores = calcularIndicadores(rowToSolicitud(row));

    const { rows: pre } = await ctx.pool.query<IndicatorRow>(
      'SELECT debt_ratio, net_margin, debt_service_coverage, amount_sales_ratio, calculation_version FROM application_indicators WHERE application_id = $1',
      [args.id_solicitud],
    );
    const guardado = pre[0];
    if (guardado && guardado.calculation_version === indicadores.calculation_version) {
      const divergencias = (
        [
          ['razon_endeudamiento', guardado.debt_ratio, indicadores.razon_endeudamiento],
          ['margen_neto', guardado.net_margin, indicadores.margen_neto],
          ['cobertura_servicio_deuda', guardado.debt_service_coverage, indicadores.cobertura_servicio_deuda],
          ['relacion_monto_ventas', guardado.amount_sales_ratio, indicadores.relacion_monto_ventas],
        ] as const
      ).filter(([, persistido, recalculado]) => !ratiosEqual(persistido, recalculado));

      if (divergencias.length > 0) {
        throw new InvalidFinancialDataError(
          'Los indicadores precalculados no coinciden con el recalculo determinista',
          { id_solicitud: args.id_solicitud, divergencias: divergencias.map(([campo]) => campo) },
        );
      }
    }

    return indicadores;
  },
});
