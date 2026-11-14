'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/peps');
const D = require('../src/demanda');

const HOY = '2026-11-13'; // viernes

// Genera ventas diarias para los `dias` días anteriores a HOY; `f(fecha)` da la cantidad de cada día.
function ventas(dias, f) {
  const filas = [];
  for (let i = dias; i >= 1; i--) {
    const fecha = D.sumarDias(HOY, -i);
    filas.push({ fecha, cantidad: f(fecha) });
  }
  return filas;
}

test('sumarDias y diaSemana: cruce de mes y día conocido', () => {
  assert.equal(D.sumarDias('2026-11-30', 1), '2026-12-01');
  assert.equal(D.sumarDias('2026-03-01', -1), '2026-02-28');
  assert.equal(D.diaSemana('2026-11-13'), 5); // viernes
  assert.equal(D.diaSemana('2026-11-15'), 0); // domingo
});

test('sin historia suficiente usa el consumo manual y coincide con peps.js', () => {
  const prod = { consumo_diario: 30, dias_entrega: 1, stock_minimo: 10 };
  const pred = D.prediccionDemanda(ventas(5, () => 99), HOY, {
    consumo_manual: 30,
    desde_registro: D.sumarDias(HOY, -5), // el producto tiene solo 5 días de movimientos
  });
  assert.equal(pred.metodo, 'manual');
  assert.equal(pred.promedio_diario, 30);
  for (const stock of [0, 25, 40, 41, 200]) {
    const r = D.evaluarReposicion(prod, stock, pred, HOY);
    assert.equal(r.punto_reorden, P.puntoReorden(prod));
    assert.equal(r.requiere, P.requiereReposicion(prod, stock));
    assert.equal(r.sugerido, P.cantidadSugerida(prod, stock));
  }
});

test('el registro reciente del producto recorta la ventana', () => {
  const v = ventas(28, () => 10);
  const pred = D.prediccionDemanda(v, HOY, { consumo_manual: 7, desde_registro: D.sumarDias(HOY, -5) });
  assert.equal(pred.ventana_dias, 5);
  assert.equal(pred.metodo, 'manual');
  const pred2 = D.prediccionDemanda(v, HOY, { desde_registro: D.sumarDias(HOY, -10) });
  assert.equal(pred2.ventana_dias, 10);
  assert.equal(pred2.metodo, 'promedio_movil');
});

test('de 7 a 13 días: promedio móvil simple', () => {
  const pred = D.prediccionDemanda(ventas(10, () => 12), HOY, { desde_registro: D.sumarDias(HOY, -10) });
  assert.equal(pred.metodo, 'promedio_movil');
  assert.equal(pred.promedio_diario, 12);
  assert.deepEqual(pred.por_dia_semana, Array(7).fill(12));
});

test('28 días: estacionalidad semanal (domingo vende el triple)', () => {
  const pred = D.prediccionDemanda(ventas(28, (f) => (D.diaSemana(f) === 0 ? 60 : 20)), HOY);
  assert.equal(pred.metodo, 'estacional');
  assert.equal(pred.ventana_dias, 28);
  assert.equal(pred.por_dia_semana[0], 60);
  for (const w of [1, 2, 3, 4, 5, 6]) assert.equal(pred.por_dia_semana[w], 20);
  assert.equal(pred.promedio_diario, 25.71); // (4*60 + 24*20) / 28
  assert.deepEqual(pred.observaciones_por_dia, Array(7).fill(4));
});

test('la reposición usa los días reales de la entrega (fin de semana pesa más)', () => {
  const pred = D.prediccionDemanda(ventas(28, (f) => (D.diaSemana(f) === 0 ? 60 : 20)), HOY);
  const prod = { dias_entrega: 2, stock_minimo: 10 };
  // Desde el viernes 13: la entrega cubre sábado (20) + domingo (60) = 80; la cobertura, lunes + martes = 40.
  const r = D.evaluarReposicion(prod, 50, pred, HOY);
  assert.equal(r.demanda_entrega, 80);
  assert.equal(r.punto_reorden, 90);
  assert.equal(r.requiere, true);
  assert.equal(r.sugerido, 80); // 90 + 40 - 50
  // Con promedio plano (25,71/día) habría calculado una demanda de entrega de solo 51,42.
  assert.equal(D.evaluarReposicion(prod, 91, pred, HOY).requiere, false);
});

test('los días sin ventas cuentan como cero', () => {
  const v = [{ fecha: D.sumarDias(HOY, -3), cantidad: 140 }];
  const pred = D.prediccionDemanda(v, HOY, { ventana: 14 });
  assert.equal(pred.ventana_dias, 14);
  assert.equal(pred.promedio_diario, 10); // 140 / 14
});

test('ignora hoy, fechas fuera de la ventana y suma varias salidas del mismo día', () => {
  const v = [
    { fecha: HOY, cantidad: 1000 },                   // hoy no está completo
    { fecha: D.sumarDias(HOY, -40), cantidad: 1000 }, // fuera de la ventana
    { fecha: D.sumarDias(HOY, -1), cantidad: 20 },
    { fecha: D.sumarDias(HOY, -1), cantidad: 8 },     // dos salidas FEFO el mismo día
  ];
  const pred = D.prediccionDemanda(v, HOY);
  const ayer = D.diaSemana(D.sumarDias(HOY, -1));
  assert.equal(pred.por_dia_semana[ayer], 7); // 28 / 4 jueves
  assert.equal(pred.promedio_diario, 1); // 28 / 28
});

test('sin ventas pero con historia: demanda 0, no cae al manual', () => {
  const pred = D.prediccionDemanda([], HOY, { consumo_manual: 30 });
  assert.equal(pred.metodo, 'estacional');
  assert.equal(pred.promedio_diario, 0);
});
