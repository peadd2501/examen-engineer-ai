import { fail, ok, type GuardrailFinding, type GuardrailOutcome } from './types.js';

/**
 * G5 — Entrada no confiable.
 *
 * `destino_fondos` lo escribe el solicitante. Es DATO, nunca instruccion.
 *
 * Lo importante primero: este modulo NO es la defensa. La defensa de G5 es
 * arquitectonica y esta en otro lado —
 *   - el texto jamas entra en el mensaje `system`, solo en un mensaje `user`
 *     aparte y serializado con JSON.stringify (no con etiquetas XML);
 *   - las herramientas ejecutables salen de una allowlist en codigo;
 *   - `registrar_dictamen` no se ofrece al modelo en absoluto;
 *   - los indicadores y los topes los pone el backend;
 *   - la clave de idempotencia la genera el backend;
 *   - la autorizacion humana es un endpoint separado;
 *   - la base de datos tiene la ultima palabra.
 *
 * Uno de los fixtures del seed contiene literalmente `</UNTRUSTED_APPLICANT_TEXT>`,
 * justamente para dejar constancia de que delimitar con etiquetas no sirve como
 * mecanismo de seguridad. Lo que sigue es deteccion para TRAZABILIDAD: marcar el
 * intento en la auditoria, no impedirlo.
 */

const PATRONES: Array<{ code: string; re: RegExp }> = [
  { code: 'INSTRUCTION_OVERRIDE', re: /\b(ignor[ae]|olvid[ae]|descart[ae])\b[^.]{0,40}\b(pol[ií]tica|regla|instrucci[oó]n)/i },
  { code: 'ROLE_IMPERSONATION', re: /\b(system|developer|assistant)\s*:/i },
  { code: 'DELIMITER_BREAKOUT', re: /<\/?\s*[A-Z_]{4,}\s*>/ },
  { code: 'FORCED_DECISION', re: /\b(aprueb[ae]|apruebe|siempre aprueba|decision\s*[:=]?\s*APROBADO)\b/i },
  { code: 'TOOL_ABUSE', re: /\b(llama|invoca|ejecuta|call)\b[^.]{0,40}\b(registrar_dictamen|obtener_solicitud|calcular_indicadores|buscar_politica|metricas_cartera)\b/i },
  { code: 'FAKE_AUTHORIZATION', re: /\b(ya\s+)?(autoriz[oó]|aprob[oó])\b[^.]{0,40}\b(analista|comit[eé]|gerente)\b|\b(analista|comit[eé])\b[^.]{0,40}\b(ya\s+)?(autoriz[oó]|aprob[oó])\b/i },
];

export interface UntrustedScan {
  sospechoso: boolean;
  codigos: string[];
}

/** Analiza el texto del solicitante. No lo modifica ni lo bloquea. */
export function analizarEntradaNoConfiable(texto: string): UntrustedScan {
  const codigos = PATRONES.filter((p) => p.re.test(texto)).map((p) => p.code);
  return { sospechoso: codigos.length > 0, codigos: [...new Set(codigos)] };
}

/**
 * Serializacion segura para el contexto del modelo. JSON.stringify escapa
 * comillas, saltos de linea y cualquier caracter de control, de modo que el
 * texto llega como un valor de cadena y no como estructura del mensaje.
 *
 * NOTA: desde FASE 3.3 el texto crudo ya NO viaja al contexto decisional. Esta
 * funcion se conserva para usos donde el texto si deba mostrarse serializado
 * (auditoria, depuracion), no para la llamada que produce el dictamen.
 */
export function serializarTextoNoConfiable(texto: string): string {
  return JSON.stringify(texto);
}

/**
 * Vocabulario cerrado de destinos. Es la representacion SEGURA que sustituye al
 * texto crudo en el contexto decisional.
 *
 * Motivo: escapar el texto no basta. Mientras el texto del solicitante llegue
 * al modelo, sigue compitiendo por su atencion con las instrucciones legitimas,
 * y ninguna cantidad de delimitadores ni de "ignora lo que sigue" cambia eso.
 * La unica defensa robusta es que el texto no llegue.
 *
 * Lo que viaja es una etiqueta de un conjunto fijo. Un atacante puede, como
 * mucho, elegir cual de estas siete etiquetas se emite; no puede introducir
 * texto propio en el prompt. La superficie pasa de "cualquier cadena" a "una de
 * siete constantes que nosotros escribimos".
 */
export const CATEGORIAS_DESTINO = [
  'capital_trabajo',
  'inventario',
  'maquinaria_equipo',
  'unidades_transporte',
  'expansion_local',
  'cuentas_por_cobrar',
  'no_clasificado',
] as const;

export type CategoriaDestino = (typeof CATEGORIAS_DESTINO)[number];

const REGLAS_DESTINO: Array<{ categoria: CategoriaDestino; re: RegExp }> = [
  { categoria: 'unidades_transporte', re: /\b(unidad(es)?|camion|camiones|vehiculo|veh[ií]culo|flota|reparto)\b/i },
  { categoria: 'maquinaria_equipo', re: /\b(maquinaria|maquina|equipo|mobiliario|computo|c[oó]mputo)\b/i },
  { categoria: 'inventario', re: /\b(inventario|mercader[ií]a|materia prima|insumos)\b/i },
  { categoria: 'expansion_local', re: /\b(sucursal|local|remodelaci[oó]n|ampliaci[oó]n|bodega)\b/i },
  { categoria: 'cuentas_por_cobrar', re: /\b(cuentas por cobrar|factoraje|cartera)\b/i },
  { categoria: 'capital_trabajo', re: /\bcapital de trabajo\b/i },
];

/**
 * Resumen seguro del destino de fondos: una etiqueta cerrada y metricas.
 * Nunca devuelve texto del solicitante.
 */
export interface ResumenDestino {
  categoria: CategoriaDestino;
  longitud_caracteres: number;
  marcado_no_confiable: boolean;
}

export function resumirDestinoFondos(texto: string): ResumenDestino {
  const scan = analizarEntradaNoConfiable(texto);
  const regla = REGLAS_DESTINO.find((r) => r.re.test(texto));
  return {
    categoria: regla?.categoria ?? 'no_clasificado',
    longitud_caracteres: texto.length,
    marcado_no_confiable: scan.sospechoso,
  };
}

export function registrarEntradaNoConfiable(texto: string): GuardrailOutcome {
  const scan = analizarEntradaNoConfiable(texto);
  if (!scan.sospechoso) return ok();

  const findings: GuardrailFinding[] = [{
    guardrail: 'G5',
    code: 'UNTRUSTED_INPUT_FLAGGED',
    message: 'El destino de fondos contiene patrones de inyeccion de instrucciones',
    details: { patrones: scan.codigos },
  }];

  // No bloquea: una solicitud con texto malicioso sigue siendo evaluable por sus
  // numeros. Queda marcada en la auditoria del run.
  return { passed: true, findings, forceEscalation: false };
}

/** Version bloqueante, para el caso en que se quiera rechazar de plano. */
export function bloquearEntradaNoConfiable(texto: string): GuardrailOutcome {
  const outcome = registrarEntradaNoConfiable(texto);
  return outcome.findings.length > 0 ? fail(outcome.findings, true) : ok();
}
