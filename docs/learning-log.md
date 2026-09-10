# Learning log

## A. Conceptos aprendidos o reforzados

- Un guardarraíl en el prompt no es suficiente: debe reforzarse con validaciones en backend, herramientas limitadas y restricciones en base de datos.
- Para montos e indicadores financieros, la autoridad debe ser determinista de extremo a extremo: `decimal.js`, strings decimales y `NUMERIC` en PostgreSQL.
- Una pieza puede funcionar de forma aislada y aun así fallar en integración.
- El presupuesto de generación y el modo de generación son problemas distintos.
- Un agente puede diagnosticarse sin almacenar chain-of-thought: bastan fases, `finish_reason`, métricas, herramientas y resultados.

## B. Cómo se verificaron

El sistema se validó contra PostgreSQL 16 real y con pruebas de backend, frontend, base de datos y build. Los guardarraíles se comprobaron tanto en aplicación como mediante restricciones directas en base de datos.

La evaluación final se ejecutó contra OpenRouter con `google/gemma-4-31b-it`, no contra un stub, obteniendo 10/10 casos aprobados.

## C. Decisiones que cambiaron por evidencia

**Retrieval.** Aunque `buscar_politica` funcionaba correctamente, el modelo formulaba consultas deficientes. Con solo 30 políticas se decidió incluir el corpus completo como contexto y dejar el retrieval como complemento.

**Nivel de riesgo.** Permitir que el modelo asignara riesgo podía activar G4 sin respaldo. El nivel pasó a cálculo determinista y luego se corrigió al comprobar que incumplir una política no implica automáticamente riesgo alto.

**Structured output.** Un caso consumía el presupuesto sin producir una salida válida. Se separó una fase FINALIZER con salida estructurada forzada y errores explícitos.

**Integración.** El frontend reportaba `API_UNREACHABLE` mientras el backend seguía ejecutándose. El problema estaba en el manejo del socket con `reply.hijack()` y los headers CORS.

## D. Con una semana adicional

1. Medir recall y precisión de citas.
2. Estructurar `destino_fondos`.
3. Mejorar la detección de cobertura semántica.
4. Definir una política real para riesgo bajo.
5. Registrar identidad del analista que autoriza.