'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/demanda');
const R = require('../src/resumen');

const HOY = '2026-11-13'; // viernes

function fila(nombre, stock, { consumo = 20, entrega = 1, minimo = 5, ventas = null, unidad = 'kg', id = 1 } = {}) {
  const producto = { id, nombre, unidad, stock, dias_entrega: entrega, stock_minimo: minimo, consumo_diario: consumo };
  const prediccion = ventas
    ? D.prediccionDemanda(ventas, HOY, { consumo_manual: consumo })
    : D.prediccionDemanda([], HOY, { consumo_manual: consumo, desde_registro: HOY });
  return { producto, prediccion, reposicion: D.evaluarReposicion(producto, stock, prediccion, HOY) };
}
// 28 días de ventas: domingo = 3 veces el resto.
const ventasSemanales = () => {
  const v = [];
  for (let i = 28; i >= 1; i--) {
    const f = D.sumarDias(HOY, -i);
    v.push({ fecha: f, cantidad: D.diaSemana(f) === 0 ? 60 : 20 });
  }
  return v;
};
const lote = (id, producto, cant, venc, costo = 1000, unidad = 'kg') =>
  ({ id, producto, unidad, cantidad_actual: cant, costo_unitario: costo, fecha_vencimiento: venc });

test('inventario en orden: titular tranquilo y sin puntos críticos', () => {
  const r = R.construirResumen({
    fecha: HOY,
    filas: [fila('Papa', 500, { ventas: ventasSemanales() })],
    lotes: [lote(1, 'Papa', 500, '2026-12-20')],
    movimientos: [{ tipo: 'S', producto: 'Papa', unidad: 'kg', cantidad: 140, n: 7 }],
  });
  assert.match(r.titular, /en orden/);
  assert.equal(r.puntos.some((p) => p.nivel === 'critico' || p.nivel === 'atencion'), false);
  assert.equal(r.indicadores[0].detalle, '1 lote con saldo');
});

test('lote vencido con saldo es crítico y aparece primero', () => {
  const r = R.construirResumen({
    fecha: HOY,
    filas: [fila('Pollo crudo', 500, { ventas: ventasSemanales() })],
    lotes: [lote(7, 'Pollo crudo', 12, '2026-11-10', 12500), lote(8, 'Pollo crudo', 500, '2026-12-20')],
  });
  assert.equal(r.puntos[0].nivel, 'critico');
  assert.match(r.puntos[0].detalle, /lote 7: 12 kg \(venció hace 3 días\)/);
  assert.match(r.titular, /^Atención urgente: 1 lote vencido con saldo\./);
  assert.equal(r.indicadores[3].valor, '1');
});

test('lotes por vencer: dice cuándo vencen y el valor en riesgo', () => {
  const r = R.construirResumen({
    fecha: HOY,
    filas: [fila('Papa', 500, { ventas: ventasSemanales() })],
    lotes: [lote(4, 'Papa', 10, '2026-11-14', 2000), lote(5, 'Papa', 5, '2026-11-13', 2000), lote(6, 'Papa', 99, '2026-12-01')],
  });
  const p = r.puntos.find((x) => /por vencer/.test(x.titulo));
  assert.equal(p.titulo, '2 lotes por vencer');
  assert.match(p.detalle, /lote 5: 5 kg, vence hoy; Papa lote 4: 10 kg, vence mañana/);
  assert.match(p.detalle, /\$\s?30\.000/); // 10*2000 + 5*2000
});

test('reposición: crítica si se agota antes de la entrega, con cantidad a comprar', () => {
  const f = fila('Pollo crudo', 5, { consumo: 30, entrega: 1, minimo: 10 });
  const r = R.construirResumen({ fecha: HOY, filas: [f] });
  const p = r.puntos.find((x) => x.titulo === 'Reponer Pollo crudo');
  assert.equal(p.nivel, 'critico');
  assert.match(p.detalle, /Comprar unos 95 kg/); // punto 40 (30*1 + 10) + 2 días de cobertura (60) - stock 5
  assert.match(p.detalle, /se agotaría antes de recibir el pedido/);
});

test('reposición no crítica cuando alcanza hasta que llegue el pedido', () => {
  const f = fila('Papa', 45, { consumo: 20, entrega: 1, minimo: 30 }); // punto 50, cobertura 2,25 días
  const r = R.construirResumen({ fecha: HOY, filas: [f] });
  assert.equal(r.puntos.find((x) => x.titulo === 'Reponer Papa').nivel, 'atencion');
  assert.match(r.titular, /^Requiere atención: 1 producto por reponer\./);
});

test('reposición se ordena del producto con menos cobertura al de más', () => {
  const a = fila('Papa', 45, { consumo: 20, entrega: 1, minimo: 30, id: 1 });
  const b = fila('Pollo crudo', 5, { consumo: 30, entrega: 1, minimo: 10, id: 2 });
  const r = R.construirResumen({ fecha: HOY, filas: [a, b] });
  const titulos = r.puntos.filter((x) => x.titulo.startsWith('Reponer')).map((x) => x.titulo);
  assert.deepEqual(titulos, ['Reponer Pollo crudo', 'Reponer Papa']);
});

test('con modelo estacional informa el día pico y el pronóstico de mañana (sábado)', () => {
  const r = R.construirResumen({
    fecha: HOY,
    filas: [fila('Pollo crudo', 500, { ventas: ventasSemanales() })],
  });
  const pico = r.puntos.find((x) => x.titulo === 'Días de mayor consumo');
  assert.match(pico.detalle, /el domingo \(60 kg frente a 25,71 kg de promedio\)/);
  const man = r.puntos.find((x) => x.titulo.startsWith('Pronóstico para mañana'));
  assert.equal(man.titulo, 'Pronóstico para mañana (sábado)');
  assert.match(man.detalle, /Pollo crudo 20 kg/);
});

test('productos con poca historia se avisan como consumo manual y no entran al pronóstico', () => {
  const r = R.construirResumen({ fecha: HOY, filas: [fila('Adobo', 50, { consumo: 1 })] });
  assert.match(r.puntos.find((x) => x.titulo === 'Pronóstico limitado').detalle, /Adobo usa el consumo diario digitado/);
  assert.equal(r.puntos.some((x) => x.titulo.startsWith('Pronóstico para mañana')), false);
});

test('movimientos: sin movimientos y con movimientos', () => {
  const sin = R.construirResumen({ fecha: HOY, filas: [] });
  assert.equal(sin.puntos.find((x) => x.titulo.startsWith('Movimientos')).detalle, 'No se registraron movimientos.');
  const con = R.construirResumen({
    fecha: HOY,
    filas: [],
    movimientos: [
      { tipo: 'E', producto: 'Papa', unidad: 'kg', cantidad: 100, n: 2 },
      { tipo: 'S', producto: 'Papa', unidad: 'kg', cantidad: 40, n: 5 },
      { tipo: 'S', producto: 'Pollo crudo', unidad: 'kg', cantidad: 70, n: 6 },
    ],
  });
  const d = con.puntos.find((x) => x.titulo.startsWith('Movimientos')).detalle;
  assert.match(d, /2 entradas y 11 salidas/);
  assert.match(d, /Con más salidas: Pollo crudo 70 kg; Papa 40 kg/);
});

test('texto plano incluye titular, indicadores y cada punto con su nivel', () => {
  const r = R.construirResumen({
    fecha: HOY,
    filas: [fila('Pollo crudo', 5, { consumo: 30, entrega: 1, minimo: 10 })],
    lotes: [lote(7, 'Pollo crudo', 12, '2026-11-10')],
  });
  assert.match(r.texto, /^Resumen del inventario al 2026-11-13\n/);
  assert.match(r.texto, /- \[Crítico\] Lotes vencidos con saldo:/);
  assert.match(r.texto, /Valor del inventario vigente:/);
  assert.ok(r.puntos.every((p) => p.etiqueta));
});
