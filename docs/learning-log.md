# Learning log

## A. Conceptos aprendidos o reforzados

- **Un guardarraíl que vive en el prompt no es un guardarraíl.** Lo que sostiene el sistema son las herramientas fijadas en backend, la validación de toda salida y los `CHECK` de PostgreSQL.
- **Autoridad numérica end-to-end:** `decimal.js`, string decimal de escala fija en cada frontera, `NUMERIC` con los type parsers de `pg` forzados a string. Y `null` no es `0`: con ventas en cero el margen neto no existe.
- **La distancia entre "el componente funciona" y "el sistema funciona":** tres veces apareció una pieza verde en aislamiento con comportamiento incorrecto en integración.
- **Modo de generación ≠ presupuesto de generación.**
- **Se puede diagnosticar un agente sin persistir chain-of-thought:** bastan fases, `finish_reason`, longitudes y conteos.

## B. Cómo se verificaron

Contra PostgreSQL 16 real, migrado y sembrado — no contra mocks:

```
typecheck PASS · test 70/70 · test:web 23/23 · test:db 118/118 · build:web PASS
```

Los guardarraíles se prueban en sus **dos** capas: hay tests que hacen el `INSERT` directo para comprobar que la base rechaza lo mismo que la aplicación. El payload al proveedor se afirmó campo por campo contra un stub HTTP local. La evaluación con LLM real **no está cerrada** y este documento no la da por buena.

## C. Decisiones que cambiaron por evidencia

**1. Retrieval.** Los 15 tests de recuperación pasaban, pero end-to-end `buscar_politica` acertaba y era *el modelo* quien formulaba consultas deficientes y decidía sobre evidencia equivocada. Con 30 políticas el corpus entero cabe en ~9 KB: se inyecta completo, con las relaciones regla ↔ excepción explícitas, y el retrieval queda complementario. A ~500 haría falta recuperación híbrida con embeddings y reranking — **nada de eso está implementado**.

**2. Nivel de riesgo.** El modelo podía etiquetar `ALTO` sin respaldo en ninguna política, y `ALTO` dispara G4: podía activar la autorización humana con un dato inventado. Pasó a cálculo determinista desde el corpus. Al escribir la matriz cometí el error contrario —`ALTO` ante cualquier incumplimiento de umbral— y una prueba en vivo lo expuso: CASE-04 salía `RECHAZADO / ALTO / PENDING_AUTHORIZATION`, lo que habría roto cuatro expected results. Incumplir POL-1.1 es causa de rechazo, no nivel de riesgo. No se emite `BAJO` porque el corpus no define condiciones suficientes.

**3. Structured output.** CASE-09 fallaba mecánicamente: 5000 tokens y ~5188 caracteres que no validaban; la reparación gastó los 1400 tokens **enteros en razonamiento** y devolvió contenido vacío. Ninguno se arregla con más presupuesto. Se separó una fase FINALIZER con `tool_choice` forzado a una única función cuyos `parameters` son el esquema del dictamen: siete códigos de error explícitos, una sola reparación con la misma función, sin fallback silencioso.

**Y un fallo de integración que ningún test inicial veía:** el frontend reportaba `API_UNREACHABLE` mientras el servidor seguía trabajando 96 segundos. `reply.hijack()` entrega el socket crudo y los headers de CORS nunca se escriben. Un `OPTIONS` 204 prueba solo el preflight; los tests nuevos afirman sobre la respuesta POST real.

## D. Con una semana adicional

1. Cerrar la evaluación en vivo y publicar la matriz de los 10 casos con sus fallos.
2. Métrica de recall y precisión de citas — prerequisito de cualquier cambio a retrieval híbrido.
3. Destino de fondos como campo estructurado: resuelve POL-5.3 y elimina la inyección de raíz.
4. Ampliar el corpus con una política de riesgo bajo con respaldo real, para emitir `BAJO` sin inventar umbrales.
5. Identidad en la autorización humana: hoy el acto es transaccional, pero no dice quién firmó.
