# Bitácora de decisiones técnicas

Formato por entrada: Problema / Opciones / Decisión / Motivo / Trade-off / Evidencia.

---

## 2026-09-08 — Gestor de monorepo: npm workspaces

### Problema
Se necesita un monorepo con `apps/*` y `packages/*` compartiendo tipos, sin gastar tiempo en tooling.

### Opciones consideradas
1. npm workspaces (nativo).
2. pnpm + Turborepo.
3. Nx.

### Decisión
npm workspaces con TypeScript project references.

### Motivo
Cero instalación adicional, funciona con el `npm install` que el evaluador ya va a ejecutar, y los paquetes internos se resuelven por symlink sin paso de build en desarrollo (`tsx` lee el TS fuente).

### Trade-off
Sin caché de build incremental entre paquetes. Irrelevante en un proyecto de este tamaño.

### Evidencia
`npm install` en la raíz resuelve `@credit/contracts` y `@credit/policies` en API y web.

---

## 2026-09-08 — El dinero nunca es `number`

### Problema
JavaScript representa `0.1 + 0.2` como `0.30000000000000004`. Un indicador financiero mal redondeado invalida el guardarraíl G2.

### Opciones consideradas
1. `number` con redondeo al final.
2. Enteros en centavos.
3. `decimal.js` + transporte como string.

### Decisión
`decimal.js` internamente; **string decimal con escala fija** en toda frontera (HTTP, JSON, DB). `NUMERIC` en PostgreSQL, con los type parsers de `pg` forzados a devolver string (`setTypeParser(1700, ...)`).

### Motivo
`pg` por defecto convertiría `NUMERIC` a `number` y perdería precisión al leer. Fijar la escala (2 para dinero, 6 para ratios) hace que la comparación de G2 sea igualdad de strings, determinista y auditable.

### Trade-off
Hay que serializar/deserializar explícitamente en cada borde. A cambio, no existe ningún punto del sistema donde un flotante pueda contaminar un cálculo.

### Evidencia
`packages/contracts/src/money.ts`, tests en `indicators-calc.test.ts`.

---

## 2026-09-08 — Las fórmulas de indicadores viven en `packages/contracts`

### Problema
El documento base ubica el dominio en `apps/api/src/domain`. Pero el mismo cálculo lo necesitan la API, el script de seed (precálculo) y el evaluation harness.

### Opciones consideradas
1. Dejarlo en `apps/api` y que seed/eval importen con rutas relativas hacia adentro de la app.
2. Crear un cuarto paquete `packages/domain`.
3. Ponerlo en `packages/contracts`, que ya contiene los helpers Decimal.

### Decisión
Opción 3: `packages/contracts/src/indicators-calc.ts`. `apps/api/src/domain/index.ts` lo reexporta, así que dentro de la API el punto de entrada al dominio sigue siendo `src/domain`.

### Motivo
Son funciones puras sin I/O sobre los mismos helpers Decimal que ya están en ese paquete. Una sola fuente de verdad numérica y un solo import path para los tres consumidores. Crear un paquete extra habría sido burocracia.

### Trade-off
`contracts` deja de ser estrictamente "solo esquemas". Se documenta y se acota: solo funciones puras, nunca acceso a datos.

### Evidencia
`packages/contracts/src/indicators-calc.ts`, reexportado en `apps/api/src/domain/index.ts`.

---

## 2026-09-08 — `null` en indicadores significa "no calculable"

### Problema
Con `ventas_anuales = 0`, el margen neto no es 0: no existe. Devolver 0 haría que una solicitud inválida pareciera simplemente mala.

### Decisión
`safeDiv` devuelve `null` ante denominador cero; la columna en DB es NULL-able; el contrato Zod acepta `null`. En paralelo, `detectarAnomalias` emite códigos (`VENTAS_NO_POSITIVAS`, `UTILIDAD_MAYOR_VENTAS`, `PASIVOS_MAYORES_ACTIVOS`, …).

### Motivo
Los 5 casos obligatorios de datos inconsistentes del dataset deben poder distinguirse de forma determinista, sin que el LLM tenga que "notar" la inconsistencia.

### Trade-off
Todo consumidor debe manejar `null`. TypeScript lo obliga.

### Evidencia
`safeDiv` en `money.ts`; test "denominador cero produce null, no cero".

---

## 2026-09-08 — Cuota anual estimada: amortización lineal de capital

### Problema
La cobertura de servicio de deuda necesita una `cuota_anual_estimada_nuevo_credito` que el enunciado no define.

### Decisión
`cuota_anual = monto_solicitado * 12 / plazo_meses` (capital, sin interés), aislada en `cuotaAnualEstimada()`.

### Motivo
Determinista, explicable en 10 segundos durante la defensa y suficiente para discriminar capacidad de pago. Introducir tasa exigiría definir tasa por sector/score, que no está en el enunciado.

### Trade-off
Subestima el servicio real de deuda. Mitigación: la fórmula está en una sola función y `INDICATOR_CALC_VERSION` versiona el cálculo, así que cambiarla es un cambio localizado y trazable.

### Evidencia
`packages/contracts/src/indicators-calc.ts`.

---

## 2026-09-08 — Migraciones: SQL plano + runner propio

### Problema
Se necesitan migraciones reproducibles desde cero sin sumar dependencias pesadas.

### Opciones consideradas
1. Prisma / Drizzle.
2. node-pg-migrate.
3. Archivos `.sql` numerados + runner de ~50 líneas.

### Decisión
Opción 3, con tabla `schema_migrations` y cada archivo dentro de su propia transacción.

### Motivo
El SQL queda a la vista, que es exactamente lo que hay que defender: los CHECK de G3, el UNIQUE de idempotencia y el trigger de G1. Un ORM escondería esas restricciones detrás de un DSL.

### Trade-off
Sin rollback de migraciones. Para un MVP con `npm run db:reset` es suficiente.

### Evidencia
`database/migrations/*.sql`, `database/migrate.ts`.

---

## 2026-09-08 — Los guardarraíles G3, G4 y G1 tienen respaldo en la base de datos

### Problema
El principio rector es "el software verifica; la base de datos restringe". Un guardarraíl que solo existe en TypeScript se salta con un `INSERT` directo.

### Decisión
- **G3**: `decisions` guarda `requested_amount_snapshot` y `max_allowed_amount` en la propia fila, con `CHECK (recommended_amount <= requested_amount_snapshot)` y `CHECK (recommended_amount <= max_allowed_amount)`. Se usan snapshots porque un CHECK no puede consultar otras tablas.
- **G4**: `CHECK (requires_human_authorization = false OR operational_status IN ('PENDING_AUTHORIZATION','CONFIRMED','REJECTED_BY_ANALYST'))`. Un dictamen que requiere autorización no puede nacer firme.
- **G1**: trigger `CONSTRAINT ... DEFERRABLE INITIALLY DEFERRED` que exige al menos una cita para toda decisión `APROBADO` o `RECHAZADO`. Diferido porque las citas se insertan después del dictamen dentro de la misma transacción.

### Motivo
Cada guardarraíl queda demostrable en la defensa con un `INSERT` que la base rechaza.

### Trade-off
El trigger de G1 solo verifica *existencia* de cita; la verificación de que `texto_literal` coincide con el corpus es imposible en un CHECK y se hace en código antes de persistir, marcando `verified` en `decision_policy_citations`.

### Evidencia
`database/migrations/0003_decisions.sql`.

---

## 2026-09-08 — Recuperación de políticas: full text search de PostgreSQL

### Problema
25–30 políticas. Hay que recuperarlas de forma auditable.

### Decisión
Columna `search_vector tsvector GENERATED ALWAYS AS (...) STORED` con configuración `spanish`, índice GIN, y `setweight` (sección y categoría con peso A, texto con peso B). Sin embeddings.

### Motivo
Determinista, explicable, cero infraestructura extra, y el ranking es inspeccionable con `ts_rank`. Con 25 políticas los embeddings no aportan recall y sí añaden latencia, costo y una dependencia.

### Trade-off
No captura sinónimos semánticos. Se compensa con filtro por categoría y con `policy_relations`, que arrastra las excepciones relacionadas sin que el modelo tenga que inferirlas. Documentado en README como el punto que cambiaría con ~500 políticas.

### Evidencia
`database/migrations/0002_policies.sql`.

---

## 2026-09-08 — Estructura del corpus: relaciones explícitas

### Problema
Una excepción (POL-7.3) que modifica parcialmente una regla (POL-2.3) debe recuperarse junto con la regla.

### Decisión
Tabla `policy_relations (source, target, relation_type)` con enum `OVERRIDES_PARTIALLY | OVERRIDES_FULLY | COMPLEMENTS | DEPENDS_ON`, integridad referencial validada además en `loadCorpus()` antes del seed.

### Motivo
Que un corpus mal formado falle en el seed y no a mitad de una ejecución del agente.

### Evidencia
`packages/policies/src/index.ts`, `database/migrations/0002_policies.sql`.

---

## 2026-09-08 — La categoría de política no entra al `tsvector`

### Problema
El diseño inicial incluía `category::text` en la columna generada `search_vector`. PostgreSQL lo rechaza: `ERROR: generation expression is not immutable`. El cast enum → text es `STABLE`, no `IMMUTABLE`, y una columna `GENERATED ... STORED` solo admite expresiones inmutables.

### Opciones consideradas
1. Duplicar la categoría en una columna `TEXT` redundante solo para indexarla.
2. Sacar la categoría del vector y filtrarla por su propia columna.

### Decisión
Opción 2. `search_vector` cubre `section` (peso A) y `text` (peso B); la categoría se filtra con `WHERE category = $n` usando `policies_category_idx`.

### Motivo
El filtro por categoría es exacto, no aproximado: es mejor como predicado que como término de ranking. Además evita una columna duplicada que habría que mantener sincronizada.

### Trade-off
Una consulta cuyo único término relevante fuera el nombre de la categoría ya no hace match textual. Se cubre con el parámetro opcional `categoria` de `buscar_politica`.

### Evidencia
Migración `0002_policies.sql` aplicada sin error tras el cambio.

---

## 2026-09-08 — Verificación de FASE 1 contra PostgreSQL 16 real

Las cuatro migraciones se aplicaron desde cero sobre PostgreSQL 16 y se probó cada restricción con `INSERT` directos, sin pasar por la aplicación. Resultado:

| Prueba | Resultado |
|---|---|
| 4 migraciones desde base vacía | 9 tablas creadas |
| **G3** `recommended_amount` (300 000) > `max_allowed_amount` (250 000) | `ERROR: violates check constraint "g3_amount_le_policy_cap"` |
| **G4** `requires_human_authorization = true` con `operational_status = 'GENERATED'` | `ERROR: violates check constraint "g4_requires_authorization_flow"` |
| **G1** `APROBADO` sin cita, dentro de una transacción | `ERROR: G1: la decision ... requiere al menos una cita de politica verificada` (en `COMMIT`, trigger diferido) |
| Camino feliz: dictamen + cita en la misma transacción | `APROBADO | 180000.00 | GENERATED` |
| **Idempotencia**: reusar `idempotency_key` | `ERROR: duplicate key value violates unique constraint "decisions_idempotency_key_uidx"` |
| FTS `'cobertura de servicio de deuda'` | `POL-2.3` (score 0.7727) + `POL-7.3` arrastrada por `OVERRIDES_PARTIALLY` |

Esto es lo que hace defendible el principio: **ninguno de esos rechazos vino de TypeScript.** Vinieron de la base de datos.

Otras verificaciones: `npm run typecheck` limpio en los 4 paquetes (API, web, contracts, policies) con `strict` y `noUncheckedIndexedAccess`; `npm test` 3/3 sobre el cálculo de indicadores.

---

## 2026-09-08 — Gestor de paquetes: migración de npm a pnpm

### Problema
El proyecto arrancó con npm workspaces. Se decidió estandarizar en pnpm.

### Opciones consideradas
1. Quedarse en npm workspaces.
2. Migrar a pnpm con `pnpm-workspace.yaml` y protocolo `workspace:`.

### Decisión
pnpm 10, declarado con `"packageManager": "pnpm@10.15.0"`, workspaces en `pnpm-workspace.yaml`, dependencias internas con `workspace:*`, y `package-lock.json` eliminado.

### Motivo
Además de la instalación por enlaces duros, `node_modules` deja de estar hoisteado: un paquete solo ve lo que declaró. Eso convirtió en error de instalación dos dependencias que npm resolvía por accidente — los scripts de `database/` importaban `@credit/policies` y `@credit/contracts` sin declararlos en el `package.json` raíz. En npm funcionaba; en pnpm falla, que es el comportamiento correcto.

### Trade-off
Hay que declarar cada dependencia donde se usa. Es exactamente el punto. Además pnpm 10 no ejecuta scripts `postinstall` de dependencias por defecto, así que `esbuild` (que descarga su binario nativo) tuvo que autorizarse explícitamente en `onlyBuiltDependencies`.

### Evidencia
`pnpm install` limpio, `pnpm typecheck`, `pnpm test` 20/20, `pnpm db:migrate` 4/4 migraciones.

---

## 2026-09-08 — Dataset determinista: PRNG propio y UUID derivados

### Problema
Los 10 casos de evaluación tienen que referirse a solicitudes concretas. Si los IDs cambian en cada seed, el harness no puede afirmar nada.

### Opciones consideradas
1. `Math.random()` + `crypto.randomUUID()` y guardar los IDs en un archivo.
2. Una librería de faker con seed.
3. PRNG propio (mulberry32) + UUID derivados de `sha256(SEED:index)`.

### Decisión
Opción 3. `mulberry32` en 8 líneas, y `deterministicUuid(seed, index)` que produce un UUID v4 válido y estable.

### Motivo
Mismo SEED, mismos 222 UUID, en cualquier máquina y en cualquier corrida. No hay archivo de IDs que mantener sincronizado ni dependencia extra. `pnpm seed` es idempotente: hace TRUNCATE y recarga dentro de una sola transacción.

### Trade-off
El PRNG usa `number`. Es correcto: genera *entradas* (enteros de quetzales, índices, días). En el momento en que un valor pasa a ser una cifra financiera se construye con Decimal y se serializa con escala fija; ningún cálculo monetario ocurre en punto flotante.

### Evidencia
`database/generator.test.ts`: mismo seed → dataset idéntico; seed distinto → dataset distinto; 222 IDs sin repetir.

---

## 2026-09-08 — Los 10 casos de evaluación son fixtures escritos a mano

### Problema
¿Se eligen los 10 casos de evaluación entre las 200 solicitudes aleatorias, o se construyen?

### Decisión
Se construyen: 10 fixtures (`EVAL-CASE-01` … `EVAL-CASE-10`) generados de forma determinista pero con valores escritos a mano, sobre una plantilla financieramente sana en la que solo varía la variable que el caso debe probar.

### Motivo
Un caso de evaluación que depende del PRNG no es un caso, es una coincidencia. `CASE-06` tiene que rechazarse **por endeudamiento** y por nada más: se le pone razón 0.85 y todo lo demás sano. Además se eligieron los atributos para que las excepciones NO apliquen donde no deben — `CASE-04` lleva score 70 justamente para que POL-9.2 (que exige 85) no lo rescate, y `CASE-06` es de comercio para que POL-9.3 (que solo cubre manufactura) no aplique.

### Trade-off
El dataset tiene 222 filas y no 200 exactas. Es deliberado: 200 aleatorias + 5 inyecciones + 7 inconsistentes + 10 fixtures.

### Evidencia
Los indicadores precalculados de cada fixture confirman el objetivo: CASE-06 `debt_ratio=0.850000`, CASE-05 `history_score=45`, CASE-04 `months_operation=6`, CASE-07 `requested_amount=400000.00`.

---

## 2026-09-08 — El retrieval necesita una compuerta de cobertura de términos

### Problema
El escenario deliberadamente no cubierto (una carta de crédito para importación en euros) **sí devolvía resultados**. La consulta traía POL-2.3 con `ts_rank_cd = 0.64`, por encima de aciertos legítimos de otras consultas. Un sistema que nunca puede decir "no hay política aplicable" no puede escalar a comité por esa causa, y el caso CASE-08 sería imposible.

### Causa
La búsqueda usa semántica OR. Se eligió OR porque `plainto_tsquery` une los términos con AND y una consulta de seis palabras no encontraría nada. Pero con OR basta con que la consulta comparta *una* palabra común con una política —"crédito", "cobertura"— para producir un acierto. PostgreSQL FTS no aplica IDF, así que un término frecuente pesa igual que uno discriminante.

### Opciones consideradas
1. Subir el umbral de `ts_rank_cd`. Medido: el falso positivo puntúa 0.64 y aciertos legítimos secundarios puntúan 0.50–0.58. No hay umbral que los separe.
2. Volver a semántica AND. Rompe las consultas normales.
3. Añadir una segunda señal: qué fracción de los lexemas de la consulta contiene la política.

### Decisión
Opción 3. Se calcula `cobertura = |lexemas de la consulta presentes en la política| / |lexemas de la consulta|` usando `tsvector_to_array`, y se exige `cobertura >= 0.5`. **La cobertura decide si la política aplica; `ts_rank_cd` decide cuánto importa.** El ranking sigue ordenando por relevancia.

### Motivo
Separa los dos casos de forma limpia y medible, no por calibración fina de un umbral:

| consulta | política | cobertura | veredicto |
|---|---|---|---|
| "carta de crédito … euros … cobertura cambiaria" | POL-2.3 | 0.29 | descartada |
| "cobertura de servicio de deuda mínima" | POL-2.3 | 0.75 | acierto |
| "razón de endeudamiento pasivos entre activos totales" | POL-2.1 | 1.00 | acierto |

Es determinista, se calcula en SQL, y `cobertura` viaja en cada fragmento para que la decisión sea auditable.

### Trade-off
Una consulta mal formulada, con muchas palabras irrelevantes, puede quedar por debajo de la compuerta y no devolver nada. Se prefiere ese error al contrario: **es mejor escalar a comité que citar una política que no venía al caso.** El umbral es un parámetro de la función, no una constante escondida.

### Evidencia
`policy-search.test.ts`: 15/15, incluyendo "un escenario no cubierto devuelve vacío, no un falso positivo" y "la cobertura de términos separa el acierto del falso positivo".

---

## 2026-09-08 — La expansión de relaciones ignora top_k y el filtro de categoría

### Problema
¿Debe una excepción competir por un lugar en el `top_k`? ¿Debe respetar el filtro por categoría?

### Decisión
No a las dos. Las políticas traídas por `policy_relations` se agregan **además** del `top_k`, y **cruzan** el filtro de categoría. Vienen marcadas con `incluido_por_relacion: true` y `relacionado_con: [...]`.

### Motivo
Una excepción crítica no puede quedar fuera porque el llamador pidió `top_k=3`. Y las excepciones viven en la categoría `excepcion`, así que un filtro por `elegibilidad` las excluiría siempre — justo cuando más se necesitan. Evidencia real: `buscar_politica("antigüedad mínima meses de operación continua", top_k=3, categoria=elegibilidad)` devuelve POL-1.1 como acierto directo y arrastra POL-5.1 (categoría `sector`, endurece a 24 meses para agropecuario) y POL-9.2 (categoría `excepcion`, relaja a 9 meses con score ≥ 85). Ninguna de las dos habría pasado el filtro por sí sola, y omitir cualquiera daría un dictamen equivocado.

### Trade-off
El resultado puede exceder `top_k`. Por eso `buscar_politica` documenta que `top_k` acota los **aciertos por texto**, no el total devuelto.

### Evidencia
Tests "la expansión no consume cupo de top_k" y "la antigüedad mínima arrastra sus dos modificadores".

---

## 2026-09-08 — Vacío deliberado en el corpus

### Decisión
El corpus de 30 políticas **no contiene ninguna** sobre operaciones de comercio exterior, cartas de crédito ni financiamiento en moneda extranjera. Está declarado explícitamente en `corpus.json` bajo `_nota_cobertura`.

### Motivo
El enunciado exige al menos un escenario no cubierto. Dejarlo implícito lo volvería indistinguible de un olvido; declararlo lo convierte en un requisito verificable. `EVAL-CASE-08` usa ese destino de fondos y debe terminar en `ESCALADO_A_COMITE` por ausencia de política aplicable, no por incumplimiento.

### Evidencia
`buscar_politica("carta de credito documentaria para importacion en euros con cobertura cambiaria", 5)` → 0 resultados.
