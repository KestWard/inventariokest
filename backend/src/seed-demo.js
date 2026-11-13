'use strict';
// Inventario SIMULADO de prueba (supuestos de simulación, no recomendaciones sanitarias).
// Uso: node src/seed-demo.js                       -> diagnóstico, no escribe nada
//      node src/seed-demo.js --ejecutar --db=<DB_NAME> [--reemplazar-demo]
// Marca: cada entrada lleva movimiento.observacion = 'SIMULADO seed-inventario-v1 #NN' (el esquema no tiene columna demo).
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const P = require('./peps');

const MARCA = 'SIMULADO seed-inventario-v1';
// producto -> [nombre del proveedor, proveedor de ejemplo del schema.sql que se renombra si existe]
const PROVEEDORES = {
  'Pollo crudo': ['Proveedor de pollo - Soacha sector 1', 'Proveedor Avícola (ejemplo)'],
  Papa: ['Proveedor de papa - Soacha sector 2', 'Distribuidor de Abarrotes (ejemplo)'],
  Adobo: ['Proveedor de adobo - Soacha sector 3'],
  Salsas: ['Proveedor de salsas - Soacha sector 4'],
};
const UNIDAD = { 'Pollo crudo': 'kg', Papa: 'kg', Adobo: 'kg', Salsas: 'lt' };
const LOTES = [
  ['Pollo crudo', 30, 12500, '2026-11-18'], ['Pollo crudo', 35, 12500, '2026-11-19'], ['Pollo crudo', 35, 12800, '2026-11-20'],
  ['Papa', 28, 2800, '2026-11-18'], ['Papa', 30, 2800, '2026-11-19'], ['Papa', 30, 2900, '2026-11-20'],
  ['Adobo', 2, 18000, '2026-11-18'], ['Adobo', 2, 18000, '2026-11-19'], ['Adobo', 2, 18500, '2026-11-20'],
  ['Salsas', 6, 9500, '2026-11-18'], ['Salsas', 6, 9500, '2026-11-19'], ['Salsas', 6, 9800, '2026-11-20'],
].map(([producto, cantidad, costo, venc], i) => ({ producto, cantidad, costo, venc, marca: `${MARCA} #${String(i + 1).padStart(2, '0')}` }));
const TOTALES = { 'Pollo crudo': 100, Papa: 88, Adobo: 6, Salsas: 18 };

const sumar = (filas, campo) => filas.reduce((t, f) => ({ ...t, [f.producto]: (t[f.producto] || 0) + Number(f[campo]) }), {});
assert.deepEqual(sumar(LOTES, 'cantidad'), TOTALES); // autocomprobación del conjunto

const args = process.argv.slice(2);
const ejecutar = args.includes('--ejecutar');
const reemplazar = args.includes('--reemplazar-demo');
const fallar = (msg) => { throw Object.assign(new Error(msg), { esperado: true }); };

(async () => {
  if (ejecutar && process.env.NODE_ENV === 'production') fallar('NODE_ENV=production: el seed no se ejecuta en producción.');
  if (ejecutar && !args.includes(`--db=${process.env.DB_NAME}`)) fallar(`Confirme la base de pruebas con --db=${process.env.DB_NAME}`);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
    database: process.env.DB_NAME, decimalNumbers: true, dateStrings: true,
  });
  try {
    if (ejecutar) await conn.beginTransaction();
    const lock = ejecutar ? ' FOR UPDATE' : ''; // serializa ejecuciones concurrentes del seed
    const hoy = P.aISO(new Date());

    const [prods] = await conn.query(`SELECT id, nombre, unidad FROM producto WHERE nombre IN (?)${lock}`, [Object.keys(UNIDAD)]);
    const prod = Object.fromEntries(prods.map((p) => [p.nombre, p]));
    for (const [n, u] of Object.entries(UNIDAD)) if (prod[n]?.unidad !== u) fallar(`Falta el producto "${n}" con unidad ${u}.`);

    const [demo] = await conn.query(
      `SELECT l.id, l.cantidad_inicial, l.cantidad_actual, m.observacion AS marca FROM lote l
         JOIN movimiento m ON m.lote_id = l.id AND m.tipo = 'E' AND m.observacion LIKE ?${lock}`, [`${MARCA} #%`]);
    const ids = demo.map((d) => d.id).concat(0);
    const [[{ previos }]] = await conn.query('SELECT COUNT(*) AS previos FROM lote WHERE id NOT IN (?)', [ids]);
    const [[{ tocados }]] = await conn.query(
      "SELECT COUNT(*) AS tocados FROM movimiento WHERE lote_id IN (?) AND tipo <> 'E'", [ids]);
    const [[admin]] = await conn.query("SELECT id FROM usuario WHERE rol = 'admin' AND activo = 1 ORDER BY id LIMIT 1");
    const faltan = reemplazar ? LOTES : LOTES.filter((l) => !demo.some((d) => d.marca === l.marca));

    console.log(`Base ${process.env.DB_NAME}@${process.env.DB_HOST}: lotes previos no simulados=${previos}, lotes demo=${demo.length}, ` +
      `salidas/mermas sobre demo=${tocados}, lotes a cargar=${faltan.length}`);
    if (previos > 0) fallar('Hay inventario previo no simulado: no se suma ni se borra nada. Use una base de pruebas vacía.');
    if (!admin) fallar('No hay usuario admin activo para registrar las entradas (npm run crear-usuario).');
    if (tocados > 0) fallar('Los lotes demo tienen salidas o mermas registradas: no se reemplazan automáticamente.');
    if (!reemplazar && demo.some((d) => d.cantidad_actual !== d.cantidad_inicial)) fallar('Lotes demo con saldo alterado: use --reemplazar-demo.');
    for (const l of faltan) {
      const e = P.validarEntrada({ cantidad: l.cantidad, fecha_vencimiento: l.venc }, hoy);
      if (e.length) fallar(`${l.marca}: ${e.join(' ')}`);
    }
    if (!ejecutar) return console.log('Diagnóstico sin cambios. Para cargar: --ejecutar --db=<DB_NAME> [--reemplazar-demo]');

    const prov = {};
    for (const [producto, [nombre, ejemplo]] of Object.entries(PROVEEDORES)) {
      const [[actual]] = await conn.query('SELECT id FROM proveedor WHERE nombre = ? LIMIT 1 FOR UPDATE', [nombre]);
      const [[viejo]] = actual || !ejemplo ? [[]] : await conn.query('SELECT id FROM proveedor WHERE nombre = ? LIMIT 1 FOR UPDATE', [ejemplo]);
      if (actual) prov[producto] = actual.id;
      else if (viejo) await conn.query('UPDATE proveedor SET nombre = ? WHERE id = ?', [nombre, (prov[producto] = viejo.id)]);
      else prov[producto] = (await conn.query('INSERT INTO proveedor (nombre) VALUES (?)', [nombre]))[0].insertId;
    }

    if (reemplazar && demo.length) {
      await conn.query("DELETE FROM movimiento WHERE lote_id IN (?) AND tipo = 'E'", [ids]);
      await conn.query('DELETE FROM lote WHERE id IN (?)', [ids]);
    }
    for (const l of faltan) {
      const p = prod[l.producto].id;
      const [r] = await conn.query(
        'INSERT INTO lote (producto_id, proveedor_id, cantidad_inicial, cantidad_actual, costo_unitario, fecha_ingreso, fecha_vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [p, prov[l.producto], l.cantidad, l.cantidad, l.costo, hoy, l.venc]);
      await conn.query("INSERT INTO movimiento (tipo, lote_id, producto_id, usuario_id, cantidad, observacion) VALUES ('E', ?, ?, ?, ?, ?)",
        [r.insertId, p, admin.id, l.cantidad, l.marca]);
    }

    // Verificación antes de confirmar: saldos = movimientos y totales esperados
    const [fin] = await conn.query(
      `SELECT p.nombre AS producto, l.cantidad_actual, l.fecha_vencimiento,
              (SELECT SUM(IF(m.tipo = 'E', m.cantidad, -m.cantidad)) FROM movimiento m WHERE m.lote_id = l.id) AS neto
         FROM lote l JOIN producto p ON p.id = l.producto_id
        WHERE EXISTS (SELECT 1 FROM movimiento m WHERE m.lote_id = l.id AND m.tipo = 'E' AND m.observacion LIKE ?)`, [`${MARCA} #%`]);
    assert.equal(fin.length, LOTES.length);
    assert.deepEqual(sumar(fin, 'cantidad_actual'), TOTALES);
    assert.deepEqual(sumar(fin, 'neto'), TOTALES);
    assert.deepEqual(fin.map((f) => f.fecha_vencimiento).sort(), LOTES.map((l) => l.venc).sort());
    await conn.commit();
    console.log('Carga confirmada. Totales demo:', TOTALES);
  } catch (e) {
    if (ejecutar) await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error(e.esperado ? e.message : e); process.exit(e.esperado ? 2 : 1); });
