import { SolicitudSchema, type Solicitud, type Garantia, type Sector } from '@credit/contracts';

export interface ApplicationRow {
  id: string;
  company_name: string;
  sector: Sector;
  months_operation: number;
  requested_amount: string;
  term_months: number;
  funds_destination: string;
  annual_sales: string;
  net_income: string;
  total_assets: string;
  total_liabilities: string;
  annual_existing_debt: string;
  history_score: number;
  collateral: Garantia;
  application_date: Date | string;
  created_at: Date | string;
}

function toIsoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Mapea fila de DB (snake_case, ingles) al contrato de dominio (español). */
export function rowToSolicitud(row: ApplicationRow): Solicitud {
  return SolicitudSchema.parse({
    id_solicitud: row.id,
    nombre_empresa: row.company_name,
    sector: row.sector,
    meses_operacion: Number(row.months_operation),
    monto_solicitado: row.requested_amount,
    plazo_meses: Number(row.term_months),
    destino_fondos: row.funds_destination,
    ventas_anuales: row.annual_sales,
    utilidad_neta: row.net_income,
    activos_totales: row.total_assets,
    pasivos_totales: row.total_liabilities,
    deuda_vigente_anual: row.annual_existing_debt,
    score_historial: Number(row.history_score),
    garantia_ofrecida: row.collateral,
    fecha_solicitud: toIsoDate(row.application_date),
  });
}
