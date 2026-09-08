/** Formateo de presentacion. No hay calculo financiero aqui: solo formato. */

/** Un ratio del backend (string decimal) a porcentaje legible. */
export function comoPorcentaje(valor: string | null): string {
  if (valor === null) return 'N/D';
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'N/D';
  return `${(n * 100).toFixed(2)} %`;
}

/** Un ratio de cobertura a "2.73x". */
export function comoVeces(valor: string | null): string {
  if (valor === null) return 'N/D';
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'N/D';
  return `${n.toFixed(2)}x`;
}

export function comoQuetzales(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return 'N/D';
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'N/D';
  return `Q ${n.toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function comoMeses(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return 'N/D';
  return `${valor} meses`;
}

export function idCorto(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

const ANOMALIAS: Record<string, string> = {
  VENTAS_NO_POSITIVAS: 'Ventas anuales en cero o negativas',
  ACTIVOS_NO_POSITIVOS: 'Activos totales en cero o negativos',
  UTILIDAD_MAYOR_VENTAS: 'La utilidad neta excede las ventas anuales',
  PASIVOS_MAYORES_ACTIVOS: 'Los pasivos totales exceden los activos totales',
  PASIVOS_NEGATIVOS: 'Pasivos totales negativos',
  DEUDA_NEGATIVA: 'Deuda vigente negativa',
  SIN_ANTIGUEDAD: 'La empresa no acredita meses de operacion',
};

export function describirAnomalia(codigo: string): string {
  return ANOMALIAS[codigo] ?? codigo;
}

/** Mensajes de error del proveedor y del agente, en lenguaje de analista. */
const ERRORES: Record<string, string> = {
  PROVIDER_RATE_LIMITED: 'El proveedor de IA alcanzó temporalmente su límite de solicitudes.',
  PROVIDER_TIMEOUT: 'El proveedor tardó demasiado en responder.',
  PROVIDER_UNAVAILABLE: 'El proveedor de IA no está disponible en este momento.',
  PROVIDER_PARAMETER_REJECTED: 'El proveedor rechazó un parámetro de la petición.',
  OUTPUT_TOKEN_LIMIT_EXCEEDED: 'La generación no pudo completarse dentro del límite configurado.',
  EMPTY_PROVIDER_RESPONSE: 'El modelo respondió sin contenido.',
  STRUCTURED_OUTPUT_UNSUPPORTED: 'El modelo seleccionado no soporta el formato estructurado requerido.',
  REASONING_EFFORT_UNSUPPORTED: 'El modelo no acepta la configuración de razonamiento actual.',
  AGENT_SCHEMA_VALIDATION_FAILED: 'La respuesta del modelo no cumplió el formato requerido.',
  MAX_ITERATIONS_EXCEEDED: 'El análisis excedió el número máximo de pasos permitidos.',
  MAX_TOOL_CALLS_EXCEEDED: 'El análisis excedió el número máximo de consultas permitidas.',
  TOTAL_TIMEOUT: 'El análisis excedió el tiempo máximo permitido.',
  CANCELLED: 'Análisis cancelado.',
  PROVIDER_NOT_CONFIGURED: 'El proveedor de IA no está configurado. Revisa OPENROUTER_API_KEY en el archivo .env.',
  API_UNREACHABLE: 'No se pudo contactar la API.',
  GUARDRAIL_G1: 'El dictamen se detuvo: las citas de política no pudieron verificarse contra el corpus.',
  GUARDRAIL_G2: 'El dictamen se detuvo: los indicadores propuestos no coinciden con el cálculo autoritativo.',
  GUARDRAIL_G3: 'El dictamen se detuvo: el monto recomendado excede un tope de política.',
  GUARDRAIL_G4: 'El dictamen se detuvo: violación del flujo de autorización humana.',
};

export function describirError(code: string): string {
  return ERRORES[code] ?? 'El análisis no pudo completarse.';
}
