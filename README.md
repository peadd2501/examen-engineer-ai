# AI Credit Originator

Asistente de originación crediticia PyME. Pre-analiza solicitudes de crédito contra un corpus de políticas vigentes y produce un dictamen **verificable**, no vinculante.

> **Principio rector:** el LLM propone; el software verifica; la base de datos restringe; el humano confirma.

Estado actual: **FASE 1 — Bootstrap + Domain Core** (sin LLM conectado).

---

## Requisitos

- Node.js ≥ 20 (probado con 22)
- pnpm 10 (`corepack enable`)
- Docker + Docker Compose

## Puesta en marcha

```bash
cp .env.example .env
corepack enable               # habilita pnpm (viene con Node)
pnpm install
docker compose up -d          # PostgreSQL 16 en el puerto 5433
pnpm db:migrate               # aplica database/migrations/*.sql
pnpm seed                     # 222 solicitudes + 30 politicas + indicadores
pnpm dev                      # API :3001 + Web :5173
```

Verificación rápida:

```bash
curl localhost:3001/health
curl localhost:3001/health/db
curl localhost:3001/version
```

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | API y frontend en paralelo |
| `pnpm dev:api` | Solo la API (`tsx watch`) |
| `pnpm dev:web` | Solo el frontend (Vite) |
| `pnpm db:migrate` | Aplica migraciones pendientes |
| `pnpm db:reset` | Borra el schema y vuelve a migrar desde cero |
| `pnpm seed` | Carga corpus + dataset sintético + indicadores (idempotente) |
| `pnpm typecheck` | `tsc` sobre los 4 paquetes |
| `pnpm test` | Tests deterministas: fórmulas y generador (no requieren DB) |
| `pnpm test:db` | Tests de integración del retrieval (requieren `pnpm seed`) |
| `pnpm test:all` | Ambos |
| `pnpm eval` | Harness de evaluación, 10 casos (FASE 4) |

El puerto de PostgreSQL es **5433** para no chocar con una instalación local en 5432.

---

## Arquitectura

```
React (Vite)  ──SSE──▶  Fastify API  ──▶  PostgreSQL
                             │
                             ├── Agent Orchestrator (FASE 3)
                             ├── Tools: obtener_solicitud, calcular_indicadores,
                             │          buscar_politica, registrar_dictamen,
                             │          metricas_cartera
                             └── Guardrail Layer G1..G5
```

Separación de responsabilidades:

- **`packages/contracts`** — esquemas Zod, helpers Decimal, errores tipados y las fórmulas financieras puras. Única fuente de verdad numérica.
- **`packages/policies`** — corpus de políticas y validación de integridad regla ↔ excepción.
- **`apps/api`** — HTTP, orquestación, guardarraíles, persistencia.
- **`apps/web`** — chat, dictamen en vivo, autorización humana.
- **`database`** — migraciones SQL planas y seed determinista.

---

## Decisiones que definen el sistema

**El dinero nunca es `number`.** `decimal.js` internamente, string decimal de escala fija en toda frontera (HTTP y DB), `NUMERIC` en PostgreSQL con los type parsers de `pg` forzados a devolver string. Sin esto, G2 (coherencia numérica) sería incomparable.

**`null` ≠ `0` en los indicadores.** Con `ventas_anuales = 0` el margen neto no es cero: no existe. Se devuelve `null` y se emite un código de anomalía.

**Los guardarraíles no viven en el prompt.** G3 (topes) y G4 (autorización humana) son `CHECK` constraints; G1 (cita obligatoria) es un trigger `DEFERRABLE INITIALLY DEFERRED`; la idempotencia es un `UNIQUE INDEX`. Se pueden demostrar con un `INSERT` que la base rechaza.

**`destino_fondos` es dato, no instrucción (G5).** Se almacena literal, se delimita al construir contexto y nunca se interpola en instrucciones de sistema. La defensa real no es el prompt: son las herramientas fijadas en backend y la validación de toda salida.

Bitácora completa: [`docs/engineering-notes.md`](docs/engineering-notes.md).

---

## Recuperación de políticas

```
consulta → lexemas (to_tsvector 'spanish') → filtro opcional por categoría
        → FTS con semántica OR → compuerta de cobertura → ranking ts_rank_cd
        → top_k → expansión de policy_relations
```

**Sin embeddings**: con 30 políticas no aportan recall y sí añaden latencia, costo y una dependencia.

Dos señales, no una. `ts_rank_cd` mide relevancia; la **cobertura de términos** (qué fracción de los lexemas de la consulta contiene la política) decide si la política aplica. Sin esa segunda señal el sistema nunca puede decir "no hay política aplicable": una consulta sobre cartas de crédito en euros hace match con la política de *cobertura* de servicio de *crédito* solo por compartir dos palabras comunes, y ningún umbral sobre el rank separa ese caso de un acierto legítimo. La cobertura sí: 0.29 contra 0.75.

La expansión de `policy_relations` se agrega **además** del `top_k` y **cruza** el filtro de categoría, porque una excepción crítica no puede quedar fuera por un parámetro de paginación ni por vivir en otra categoría.

Si el corpus creciera a ~500 políticas o cambiara semanalmente, el diseño a adoptar sería recuperación híbrida: BM25/full-text como candidato base, embeddings con pgvector para cobertura semántica, filtros por metadata (categoría, vigencia), reranking cruzado sobre el top-N, y una métrica de recall y precisión de citas para poder comparar configuraciones en vez de opinar sobre ellas.

---

## Roadmap

- [x] **FASE 1** — monorepo, Fastify, React/Vite, PostgreSQL, migraciones, contratos Zod, helpers Decimal
- [x] **FASE 2** — 222 solicitudes sintéticas, 30 políticas, relaciones, precálculo de indicadores, `buscar_politica`
- [ ] **FASE 3** — 5 tools, orquestador, structured output, G1–G5, idempotencia, observabilidad
- [ ] **FASE 4** — evaluation harness (10 casos)
- [ ] **FASE 5** — SSE, cancelación, frontend, autorización humana, métricas

---

## Nota sobre `node_modules`

Las dependencias se instalaron durante el bootstrap desde un entorno Linux. Antes del primer `pnpm dev` en macOS, ejecutá `rm -rf node_modules && pnpm install` para que esbuild y Rollup bajen sus binarios nativos de macOS.

## Verificación

**FASE 1** — Las 4 migraciones aplican desde cero sobre PostgreSQL 16 → 9 tablas. G1, G3, G4 e idempotencia rechazan `INSERT` directos **desde la base de datos**, sin pasar por la aplicación.

**FASE 2** — `pnpm seed` carga 30 políticas (10 categorías, 10 relaciones) y 222 solicitudes con sus indicadores precalculados: 200 aleatorias, 5 con inyección de prompt, 7 con datos inconsistentes y 10 fixtures de evaluación. `pnpm typecheck` limpio con `strict` + `noUncheckedIndexedAccess`; `pnpm test` 20/20; `pnpm test:db` 15/15.

Detalle y salidas exactas en [`docs/engineering-notes.md`](docs/engineering-notes.md).
