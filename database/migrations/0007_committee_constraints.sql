-- 0007: restricciones sobre el nuevo estado.
-- Va en su propia migracion porque PostgreSQL no permite usar un valor de enum
-- recien agregado dentro de la misma transaccion que lo agrego.

-- Datos existentes anteriores a la separacion.
UPDATE decisions
   SET operational_status = 'PENDING_COMMITTEE',
       requires_human_authorization = false
 WHERE decision = 'ESCALADO_A_COMITE'
   AND operational_status IN ('GENERATED', 'PENDING_AUTHORIZATION');

-- El UPDATE anterior encola el trigger diferido de G1, y PostgreSQL no permite
-- ALTER TABLE con eventos de trigger pendientes. Se fuerzan ahora: las filas
-- tocadas son escalamientos, que el trigger no exige citar.
SET CONSTRAINTS ALL IMMEDIATE;

-- Un escalamiento no es una recomendacion firme: no puede quedar CONFIRMED
-- ni marcarse como pendiente de autorizacion G4.
ALTER TABLE decisions
  ADD CONSTRAINT escalation_goes_to_committee
  CHECK (
    decision <> 'ESCALADO_A_COMITE'
    OR (operational_status = 'PENDING_COMMITTEE' AND requires_human_authorization = false)
  );

-- Simetrico: solo un escalamiento usa el estado de comite.
ALTER TABLE decisions
  ADD CONSTRAINT committee_only_for_escalation
  CHECK (operational_status <> 'PENDING_COMMITTEE' OR decision = 'ESCALADO_A_COMITE');
