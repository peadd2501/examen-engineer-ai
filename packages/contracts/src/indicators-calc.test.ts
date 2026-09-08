import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularIndicadores, cuotaAnualEstimada, detectarAnomalias } from './indicators-calc.js';
import { SolicitudSchema, type Solicitud } from './application.js';
import { d, moneyEqual, ratiosEqual, safeDiv, toMoney, toRatio } from './money.js';

function solicitud(over: Partial<Solicitud> = {}): Solicitud {
  return SolicitudSchema.parse({
    id_solicitud: '11111111-1111-4111-8111-111111111111',
    nombre_empresa: 'Demo',
    sector: 'comercio',
    meses_operacion: 36,
    monto_solicitado: '120000.00',
    plazo_meses: 24,
    destino_fondos: 'capital de trabajo',
    ventas_anuales: '900000.00',
    utilidad_neta: '90000.00',
    activos_totales: '500000.00',
    pasivos_totales: '200000.00',
    deuda_vigente_anual: '30000.00',
    score_historial: 70,
    garantia_ofrecida: 'fiduciaria',
    fecha_solicitud: '2026-09-01',
    ...over,
  });
}

// --- formulas ---------------------------------------------------------------

test('indicadores basicos', () => {
  const i = calcularIndicadores(solicitud());
  assert.equal(i.razon_endeudamiento, '0.400000');       // 200000 / 500000
  assert.equal(i.margen_neto, '0.100000');               // 90000 / 900000
  assert.equal(i.relacion_monto_ventas, '0.133333');     // 120000 / 900000
  assert.equal(i.cuota_anual_estimada, '60000.000000');  // 120000 * 12 / 24
  assert.equal(i.cobertura_servicio_deuda, '1.000000');  // 90000 / (60000 + 30000)
  assert.equal(i.antiguedad_meses, 36);
  assert.deepEqual(i.anomalias, []);
});

test('la antiguedad es meses_operacion sin transformar', () => {
  assert.equal(calcularIndicadores(solicitud({ meses_operacion: 7 })).antiguedad_meses, 7);
});

test('la cuota anual estimada es lineal sobre el plazo', () => {
  assert.equal(cuotaAnualEstimada('360000.00', 36)?.toFixed(2), '120000.00');
  assert.equal(cuotaAnualEstimada('100000.00', 0), null);
});

// --- exactitud decimal ------------------------------------------------------

test('decimal exacto donde el punto flotante falla', () => {
  // 0.1 + 0.2 === 0.30000000000000004 en punto flotante
  assert.equal(d('0.1').plus('0.2').toFixed(2), '0.30');
  assert.notEqual(0.1 + 0.2, 0.3);

  // Un tercio no se pierde a la escala de ratio
  const i = calcularIndicadores(solicitud({ monto_solicitado: '300000.00', ventas_anuales: '900000.00' }));
  assert.equal(i.relacion_monto_ventas, '0.333333');
});

test('montos grandes sin perdida de precision', () => {
  const i = calcularIndicadores(
    solicitud({ ventas_anuales: '9007199254740993.00', utilidad_neta: '9007199254740993.00' }),
  );
  assert.equal(i.margen_neto, '1.000000');
});

test('los centavos sobreviven al redondeo de escala', () => {
  assert.equal(toMoney('1234.005'), '1234.00'); // ROUND_HALF_EVEN
  assert.equal(toMoney('1234.015'), '1234.02');
  assert.equal(toRatio('0.1234565'), '0.123456');
});

// --- denominadores invalidos ------------------------------------------------

test('denominador cero produce null, no cero', () => {
  const i = calcularIndicadores(solicitud({ ventas_anuales: '0.00', activos_totales: '0.00' }));
  assert.equal(i.margen_neto, null);
  assert.equal(i.razon_endeudamiento, null);
  assert.equal(i.relacion_monto_ventas, null);
  assert.ok(i.anomalias.includes('VENTAS_NO_POSITIVAS'));
  assert.ok(i.anomalias.includes('ACTIVOS_NO_POSITIVOS'));
});

test('safeDiv devuelve null y nunca Infinity ni NaN', () => {
  assert.equal(safeDiv('100', '0'), null);
  assert.equal(safeDiv('0', '0'), null);
  assert.equal(safeDiv('0', '100')?.toFixed(2), '0.00');
});

test('cobertura null cuando el servicio de deuda total es cero', () => {
  const i = calcularIndicadores(solicitud({ monto_solicitado: '0.01', deuda_vigente_anual: '0.00' }));
  assert.notEqual(i.cobertura_servicio_deuda, null); // hay cuota, hay denominador
  const j = calcularIndicadores(solicitud({ plazo_meses: 24, monto_solicitado: '0.00', deuda_vigente_anual: '0.00' }));
  assert.equal(j.cobertura_servicio_deuda, null);
});

test('cobertura negativa cuando la utilidad es negativa', () => {
  const i = calcularIndicadores(solicitud({ utilidad_neta: '-45000.00' }));
  assert.equal(i.cobertura_servicio_deuda, '-0.500000');
  assert.equal(i.margen_neto, '-0.050000');
});

// --- datos inconsistentes ---------------------------------------------------

test('detecta utilidad > ventas y pasivos > activos', () => {
  const i = calcularIndicadores(solicitud({ utilidad_neta: '999999.00', pasivos_totales: '900000.00' }));
  assert.ok(i.anomalias.includes('UTILIDAD_MAYOR_VENTAS'));
  assert.ok(i.anomalias.includes('PASIVOS_MAYORES_ACTIVOS'));
});

test('detecta ausencia de antiguedad y valores negativos', () => {
  const anomalias = detectarAnomalias(
    solicitud({ meses_operacion: 0, pasivos_totales: '-1.00', deuda_vigente_anual: '-5.00' }),
  ).map((a) => a.codigo);
  assert.ok(anomalias.includes('SIN_ANTIGUEDAD'));
  assert.ok(anomalias.includes('PASIVOS_NEGATIVOS'));
  assert.ok(anomalias.includes('DEUDA_NEGATIVA'));
});

test('una solicitud sana no levanta anomalias', () => {
  assert.deepEqual(detectarAnomalias(solicitud()), []);
});

// --- determinismo y comparacion (base de G2) --------------------------------

test('el calculo es puro: misma entrada, misma salida', () => {
  assert.deepEqual(calcularIndicadores(solicitud()), calcularIndicadores(solicitud()));
});

test('comparacion normalizada para G2', () => {
  assert.ok(ratiosEqual('0.400000', '0.4'));
  assert.ok(ratiosEqual(null, null));
  assert.ok(!ratiosEqual('0.400000', null));
  assert.ok(!ratiosEqual('0.400000', '0.400001'));
  assert.ok(moneyEqual('180000.00', '180000'));
  assert.ok(!moneyEqual('180000.00', '180000.01'));
});
