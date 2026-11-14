'use strict';
// Historial SIMULADO de salidas de las últimas 4 semanas, solo para demostrar la demanda estimada.
// Uso: node src/seed-historial.js                                   -> diagnóstico, no escribe nada
//      node src/seed-historial.js --ejecutar --db=<DB_NAME>         -> inserta el historial
//      node src/seed-historial.js --ejecutar --db=<DB_NAME> --reemplazar   -> borra el simulado anterior y lo recrea
// Por producto crea 1 lote histórico (ya agotado y vencido, cantidad_actual = 0) con su entrada y
// una salida por día. Así el stock real no cambia y los movimientos quedan consistentes con los lotes.
// Todo movimiento lleva observacion = 'SIMULADO historial-v1 ...' para reconocerlo.
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const P = require('./peps');
const D = require('./demanda');

const MARCA = 'SIMULADO historial-v1';
const DIAS = 28;
// producto -> [consumo base por día, costo unitario]
const BASE = { 'Pollo crudo': [30, 12500], Papa: [20, 2800], Adobo: [1, 18000], Salsas: [3, 9500] };
// Factor por día de la semana (0 = domingo): el fin de semana se vende más.
const FACTOR = [1.8, 0.7, 0.6, 0.8, 0.9, 1.2, 1.5];

// Determinista (sin Math.random) para que el resultado sea reproducible.
function generarVentas(producto, indice, hoy) {
  const [base] = BASE[producto];
  const filas = [];
  for (let i = DIAS; i >= 1; i--) {
    const fecha = D.sumarDias(hoy, -i);
    const ruido = 1 + (((i * 7 + indice * 3) % 5) - 2) * 0.03; // entre -6 % y +6 %
    const cantidad = Math.round(base * FACTOR[D.diaSemana(fecha)] * ruido * 100) / 100;
    filas.push({ fecha, cantidad });
  }
  return filas;
}

async function main() {
  const args = process.argv.slice(2);
  const ejecutar = args.includes('--ejecutar');
  const reemplazar = args.includes('--reemplazar');
  const hoy = P.aISO(new Date());
  const nombres = Object.keys(BASE);

  console.log(`Historial simulado: ${DIAS} días (${D.sumarDias(hoy, -DIAS)} a ${D.sumarDias(hoy, -1)})`);
  nombres.forEach((n, i) => {
    const v = generarVentas(n, i, hoy);
    const total = v.reduce((s, x) => s + x.cantidad, 0);
    console.log(`  ${n}: ${v.length} salidas, total ${total.toFixed(2)}`);
  });
  if (!ejecutar) { console.log('\nDiagnóstico: no se escribió nada. Use --ejecutar --db=<DB_NAME> para insertar.'); return; }

  if (process.env.NODE_ENV === 'production') throw new Error('NODE_ENV=production: este script no se ejecuta en producción.');
  if (!args.includes(`--db=${process.env.DB_NAME}`)) throw new Error(`Confirme la base de pruebas con --db=${process.env.DB_NAME}`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
    database: process.env.DB_NAME, decimalNumbers: true, dateStrings: true,
  });
  try {
    await conn.beginTransaction();

    const [previos] = await conn.query(
      "SELECT DISTINCT lote_id FROM movimiento WHERE observacion LIKE ? FOR UPDATE", [`${MARCA}%`]);
    if (previos.length && !reemplazar) throw new Error('Ya existe un historial simulado. Use --reemplazar para recrearlo.');
    if (previos.length) {
      const ids = previos.map((r) => r.lote_id);
      await conn.query('DELETE FROM movimiento WHERE lote_id IN (?)', [ids]);
      await conn.query('DELETE FROM lote WHERE id IN (?) AND cantidad_actual = 0', [ids]);
    }

    const [prods] = await conn.query('SELECT id, nombre FROM producto WHERE nombre IN (?)', [nombres]);
    const porNombre = Object.fromEntries(prods.map((p) => [p.nombre, p.id]));
    for (const n of nombres) if (!porNombre[n]) throw new Error(`Falta el producto "${n}". Ejecute antes backend/schema.sql.`);
    const [[prov]] = await conn.query('SELECT id FROM proveedor WHERE activo = 1 ORDER BY id LIMIT 1');
    const [[admin]] = await conn.query("SELECT id FROM usuario WHERE rol = 'admin' AND activo = 1 ORDER BY id LIMIT 1");
    if (!prov) throw new Error('No hay proveedores activos.');
    if (!admin) throw new Error('No hay un usuario admin. Cree uno con crear-usuario.js.');

    for (const [i, n] of nombres.entries()) {
      const ventas = generarVentas(n, i, hoy);
      const total = Math.round(ventas.reduce((s, v) => s + v.cantidad, 0) * 100) / 100;
      const inicio = D.sumarDias(hoy, -DIAS);

      const [lote] = await conn.query(
        `INSERT INTO lote (producto_id, proveedor_id, cantidad_inicial, cantidad_actual, costo_unitario, fecha_ingreso, fecha_vencimiento)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
        [porNombre[n], prov.id, total, BASE[n][1], inicio, D.sumarDias(hoy, -1)]);

      await conn.query(
        `INSERT INTO movimiento (tipo, lote_id, producto_id, usuario_id, cantidad, fecha, observacion)
         VALUES ('E', ?, ?, ?, ?, ?, ?)`,
        [lote.insertId, porNombre[n], admin.id, total, `${inicio} 06:00:00`, `${MARCA} entrada`]);

      for (const v of ventas) {
        await conn.query(
          `INSERT INTO movimiento (tipo, lote_id, producto_id, usuario_id, cantidad, fecha, observacion)
           VALUES ('S', ?, ?, ?, ?, ?, ?)`,
          [lote.insertId, porNombre[n], admin.id, v.cantidad, `${v.fecha} 12:00:00`, `${MARCA} salida`]);
      }
    }

    await conn.commit();
    console.log('\nHistorial simulado insertado. Abra el Inicio de la aplicación para ver la demanda estimada.');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }
}

module.exports = { generarVentas };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
