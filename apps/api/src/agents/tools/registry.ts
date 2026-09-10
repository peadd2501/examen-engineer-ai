import type { Pool } from 'pg';
import type { z } from 'zod';
import { DomainError } from '@credit/contracts';

/** Se levanta cuando el modelo pide ejecutar un nombre de funcion que no existe o no esta expuesto. */
export class ToolNotAllowedError extends DomainError {
  constructor(nombre: string) {
    super(`Herramienta no permitida: ${nombre}`, 'TOOL_NOT_ALLOWED', { tool: nombre });
  }
}

export interface ToolContext {
  pool: Pool;
  /** Registro de politicas recuperadas durante el run, para verificar citas (G1). */
  registrarPoliticas: (fragmentos: unknown[]) => void;
}

/**
 * Herramienta ya registrada, con los tipos borrados.
 *
 * El borrado hace falta porque los esquemas Zod hacen invariante al generico. En
 * vez de recurrir a `any`, `defineTool` conserva el tipado estricto dentro de
 * cada herramienta y expone `run`, que valida entrada y salida con los mismos
 * esquemas.
 */
export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  exposedToModel: boolean;
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  run: (rawArgs: unknown, ctx: ToolContext) => Promise<{ args: unknown; result: unknown }>;
}

export interface ToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  description: string;
  /** JSON Schema que se envia al proveedor. */
  parameters: Record<string, unknown>;
  /** false = existe como capacidad del sistema pero NO se ofrece al modelo. */
  exposedToModel: boolean;
  input: I;
  output: O;
  execute: (args: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: ToolDefinition<I, O>,
): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    exposedToModel: def.exposedToModel,
    input: def.input,
    output: def.output,
    async run(rawArgs, ctx) {
      const args = def.input.parse(rawArgs) as z.infer<I>;
      const salida = await def.execute(args, ctx);
      return { args, result: def.output.parse(salida) as unknown };
    },
  };
}

export type ToolRegistry = Readonly<Record<string, RegisteredTool>>;

/**
 * Allowlist. El loop solo despacha nombres presentes aqui y marcados como
 * expuestos; cualquier otro nombre devuelto por el modelo termina en
 * ToolNotAllowedError. El modelo nunca elige que codigo corre.
 */
export function buildRegistry(tools: RegisteredTool[]): ToolRegistry {
  const registry: Record<string, RegisteredTool> = {};
  for (const tool of tools) registry[tool.name] = tool;
  return Object.freeze(registry);
}

/** Solo las herramientas expuestas viajan al proveedor. */
export function toProviderTools(registry: ToolRegistry): Array<Record<string, unknown>> {
  return Object.values(registry)
    .filter((t) => t.exposedToModel)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}
