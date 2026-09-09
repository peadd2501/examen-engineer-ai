# Learning log

## A. Conceptos aprendidos o reforzados

- **Un guardarraíl que vive en el prompt no es un guardarraíl.** Lo sostienen las herramientas fijadas en backend, la validación de toda salida y los `CHECK` de la base.
- **Autoridad numérica end-to-end:** `decimal.js`, string decimal de escala fija en cada frontera, `NUMERIC` con type parsers forzados a string. Y `null` no es `0`.
- **La distancia entre "el componente funciona" y "el sistema funciona":** tres veces hubo una pieza verde en aislamiento con comportamiento incorrecto en integración.
- **Modo de generación ≠ presupuesto de generación.**
- **Se puede diagnosticar un agente sin persistir chain-of-thought:** bastan fases, `finish_reason`, longitudes y conteos.
- **El diseño asistido por IA no es fuente funcional de verdad:** produce artefactos verosímiles que mezclan dirección visual legítima con funcionalidad imaginada.

## B. Cómo se verificaron

Contra PostgreSQL 16 real, migrado y sembrado — no contra mocks:

```
typecheck PASS · test 88/88 · test:web 56/56 · test:db 129/129 · build:web PASS
```

Los guardarraíles se prueban en sus **dos** capas: hay tests que hacen el `INSERT` directo para comprobar que la base rechaza lo mismo que la aplicación. Y la evaluación se cerró **contra el proveedor real**, no contra un stub: `google/gemma-4-31b-it`, reasoning `off`, seed 20260907 → **10/10 PASS**, 10/10 en decisión y en citas, `finish_reason: tool_calls`.

## C. Decisiones que cambiaron por evidencia

**1. Retrieval.** Los 15 tests pasaban, pero end-to-end `buscar_politica` acertaba y era *el modelo* quien formulaba consultas deficientes. Con 30 políticas el corpus entero cabe en ~9 KB: se inyecta completo y el retrieval queda complementario. A ~500 haría falta recuperación híbrida con embeddings — **nada de eso está implementado**.

**2. Nivel de riesgo.** El modelo podía etiquetar `ALTO` sin respaldo en ninguna política, y `ALTO` dispara G4: activaba la autorización humana con un dato inventado. Pasó a cálculo determinista desde el corpus. Al escribir la matriz cometí el error contrario —`ALTO` ante cualquier incumplimiento— y una prueba en vivo lo expuso: CASE-04 salía `RECHAZADO / ALTO / PENDING_AUTHORIZATION`, rompiendo cuatro expected results. Incumplir POL-1.1 es causa de rechazo, no nivel de riesgo. No se emite `BAJO`: el corpus no define condiciones suficientes.

**3. Structured output.** CASE-09 fallaba mecánicamente: 5000 tokens y ~5188 caracteres que no validaban; la reparación gastó los 1400 **enteros en razonamiento**, con contenido vacío. No se arregla con más presupuesto. Se separó una fase FINALIZER con `tool_choice` forzado a una única función: siete códigos de error explícitos, una sola reparación, sin fallback silencioso.

**4. Stitch como exploración, no como especificación.** Las tres maquetas generadas traían firma digital, exportación a PDF, usuarios inventados e infraestructura que este sistema no tiene. Se adoptó la jerarquía y la paleta; se rechazó la funcionalidad, y la frontera quedó escrita en un test que falla si alguno de esos elementos reaparece.

**Y un fallo de integración que ningún test veía:** el frontend reportaba `API_UNREACHABLE` mientras el servidor seguía 96 segundos. `reply.hijack()` entrega el socket crudo y los headers de CORS nunca se escriben. Un `OPTIONS` 204 prueba solo el preflight.

## D. Con una semana adicional

1. Métrica de recall y precisión de citas — prerequisito de cualquier retrieval híbrido.
2. Destino de fondos como campo estructurado: resuelve POL-5.3 y elimina la inyección de raíz.
3. Cobertura por semántica en vez de vocabularios cerrados, con su set de evaluación.
4. Ampliar el corpus con una política de riesgo bajo con respaldo real, para emitir `BAJO` sin inventar umbrales.
5. Identidad en la autorización humana: hoy el acto es transaccional, pero no dice quién firmó.
