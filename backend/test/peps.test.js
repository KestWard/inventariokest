'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/peps');

const HOY = '2026-10-01';
const lote = (id, cant, venc) => ({ id, cantidad_actual: cant, fecha_vencimiento: venc });

test('criterio: salida de 12 con lotes de 10 (vence antes) y 5 -> 10 del primero y 2 del segundo', () => {
  const lotes = [lote(2, 5, '2026-10-10'), lote(1, 10, '2026-10-05')];
  assert.deepEqual(P.planificarSalida(lotes, 12, HOY), [
    { lote_id: 1, cantidad: 10 },
    { lote_id: 2, cantidad: 2 },
  ]);
});

test('criterio: salida mayor al stock lanza error 409 y no modifica los lotes', () => {
  const lotes = [lote(1, 10, '2026-10-05'), lote(2, 5, '2026-10-10')];
  const copia = JSON.stringify(lotes);
  assert.throws(() => P.planificarSalida(lotes, 16, HOY), (e) => e.name === 'ErrorNegocio' && e.codigo === 409);
  assert.equal(JSON.stringify(lotes), copia);
});

test('ignora lotes vencidos y lotes vacíos', () => {
  const lotes = [lote(1, 50, '2026-09-30'), lote(2, 0, '2026-10-02'), lote(3, 4, '2026-10-03')];
  assert.deepEqual(P.planificarSalida(lotes, 4, HOY), [{ lote_id: 3, cantidad: 4 }]);
  assert.throws(() => P.planificarSalida(lotes, 5, HOY), /Stock insuficiente/);
});

test('un lote que vence hoy todavía se puede usar', () => {
  assert.deepEqual(P.planificarSalida([lote(1, 3, HOY)], 3, HOY), [{ lote_id: 1, cantidad: 3 }]);
});

test('rechaza cantidades <= 0 o no numéricas', () => {
  for (const c of [0, -1, NaN, undefined]) assert.throws(() => P.planificarSalida([lote(1, 5, '2026-10-05')], c, HOY), /mayor que cero/);
});

test('decimales no generan residuos de coma flotante', () => {
  const plan = P.planificarSalida([lote(1, 0.1, '2026-10-05'), lote(2, 0.2, '2026-10-06')], 0.3, HOY);
  assert.deepEqual(plan, [{ lote_id: 1, cantidad: 0.1 }, { lote_id: 2, cantidad: 0.2 }]);
});

test('validarEntrada (RF3): rechaza fecha pasada y cantidad <= 0', () => {
  assert.equal(P.validarEntrada({ cantidad: 5, fecha_vencimiento: '2026-10-05' }, HOY).length, 0);
  assert.equal(P.validarEntrada({ cantidad: 0, fecha_vencimiento: '2026-10-05' }, HOY).length, 1);
  assert.equal(P.validarEntrada({ cantidad: 5, fecha_vencimiento: '2026-09-30' }, HOY).length, 1);
  assert.equal(P.validarEntrada({ cantidad: 5, fecha_vencimiento: 'mañana' }, HOY).length, 1);
});

test('lotesPorVencer (RF6): 2 días o menos', () => {
  const lotes = [lote(1, 5, '2026-10-03'), lote(2, 5, '2026-10-04'), lote(3, 0, '2026-10-02'), lote(4, 5, '2026-09-30')];
  assert.deepEqual(P.lotesPorVencer(lotes, HOY).map((l) => l.id), [4, 1]);
});

test('punto de reorden y sugerencia de compra (RF7)', () => {
  const prod = { consumo_diario: 30, dias_entrega: 1, stock_minimo: 10 };
  assert.equal(P.puntoReorden(prod), 40);
  assert.equal(P.requiereReposicion(prod, 40), true);
  assert.equal(P.requiereReposicion(prod, 41), false);
  assert.equal(P.cantidadSugerida(prod, 25), 75); // 40 + 2*30 - 25
  assert.equal(P.cantidadSugerida(prod, 500), 0);
});

// --- ejecutarSalida con conexión simulada (verifica transacción y rollback, NO sustituye prueba con MySQL real)
function conexionFalsa(lotes) {
  const log = [];
  return {
    log,
    beginTransaction: async () => log.push('BEGIN'),
    commit: async () => log.push('COMMIT'),
    rollback: async () => log.push('ROLLBACK'),
    query: async (sql, params) => { log.push(sql.split(' ')[0]); return sql.startsWith('SELECT') ? [lotes] : [{}]; },
  };
}

test('ejecutarSalida: éxito hace UPDATE+INSERT por lote y COMMIT', async () => {
  const c = conexionFalsa([lote(1, 10, '2026-10-05'), lote(2, 5, '2026-10-10')]);
  const plan = await P.ejecutarSalida(c, { producto_id: 1, cantidad: 12, usuario_id: 1 }, HOY);
  assert.equal(plan.length, 2);
  assert.deepEqual(c.log, ['BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'UPDATE', 'INSERT', 'COMMIT']);
});

test('ejecutarSalida: stock insuficiente hace ROLLBACK sin UPDATE ni INSERT', async () => {
  const c = conexionFalsa([lote(1, 10, '2026-10-05')]);
  await assert.rejects(P.ejecutarSalida(c, { producto_id: 1, cantidad: 99, usuario_id: 1 }, HOY), /Stock insuficiente/);
  assert.deepEqual(c.log, ['BEGIN', 'SELECT', 'ROLLBACK']);
});
