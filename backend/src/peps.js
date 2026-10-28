'use strict';
/**
 * Lógica de negocio PEPS (primero en expirar, primero en salir) y reposición.
 * Las funciones puras no tocan la base de datos, por eso se prueban sin MySQL.
 * Fechas: se manejan como texto 'YYYY-MM-DD' para evitar errores de zona horaria.
 */

class ErrorNegocio extends Error {
  constructor(mensaje, codigo = 400) {
    super(mensaje);
    this.name = 'ErrorNegocio';
    this.codigo = codigo;
  }
}

/** Convierte Date o texto a 'YYYY-MM-DD' (hora local). */
function aISO(f) {
  if (typeof f === 'string') return f.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
}

/** Días enteros entre dos fechas ISO (b - a). */
function diasEntre(a, b) {
  const [ya, ma, da] = aISO(a).split('-').map(Number);
  const [yb, mb, db] = aISO(b).split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

/** Un lote está vencido si su fecha es anterior a hoy (vence hoy = aún utilizable). */
function estaVencido(lote, hoy = new Date()) {
  return aISO(lote.fecha_vencimiento) < aISO(hoy);
}

/**
 * Reparte `cantidad` entre los lotes: primero el que vence antes.
 * Ignora lotes vencidos o sin stock. No modifica los lotes recibidos.
 * @returns {{lote_id:number, cantidad:number}[]}
 * @throws {ErrorNegocio} si la cantidad es inválida o el stock vigente no alcanza.
 */
function planificarSalida(lotes, cantidad, hoy = new Date()) {
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new ErrorNegocio('La cantidad debe ser un número mayor que cero.');
  }
  const vigentes = lotes
    .filter((l) => Number(l.cantidad_actual) > 0 && !estaVencido(l, hoy))
    .sort((a, b) => {
      const c = aISO(a.fecha_vencimiento).localeCompare(aISO(b.fecha_vencimiento));
      return c !== 0 ? c : a.id - b.id; // desempate estable
    });
  const disponible = vigentes.reduce((s, l) => s + Number(l.cantidad_actual), 0);
  if (disponible < cantidad) {
    throw new ErrorNegocio(
      `Stock insuficiente: se pidieron ${cantidad} y solo hay ${disponible} disponibles (sin lotes vencidos).`,
      409
    );
  }
  let falta = cantidad;
  const plan = [];
  for (const l of vigentes) {
    if (falta <= 0) break;
    const tomar = Math.min(falta, Number(l.cantidad_actual));
    plan.push({ lote_id: l.id, cantidad: tomar });
    falta = Math.round((falta - tomar) * 100) / 100; // evita errores de coma flotante
  }
  return plan;
}

/** Valida datos de una entrada de lote (RF3). Devuelve lista de errores (vacía = válido). */
function validarEntrada({ cantidad, fecha_vencimiento }, hoy = new Date()) {
  const errores = [];
  if (!Number.isFinite(cantidad) || cantidad <= 0) errores.push('La cantidad debe ser mayor que cero.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_vencimiento))) errores.push('La fecha de vencimiento no es válida (AAAA-MM-DD).');
  else if (aISO(fecha_vencimiento) < aISO(hoy)) errores.push('La fecha de vencimiento no puede ser pasada.');
  return errores;
}

/** RF6: lotes con stock que vencen en `dias` días o menos (incluye los ya vencidos con stock). */
function lotesPorVencer(lotes, hoy = new Date(), dias = 2) {
  return lotes
    .filter((l) => Number(l.cantidad_actual) > 0 && diasEntre(hoy, l.fecha_vencimiento) <= dias)
    .sort((a, b) => aISO(a.fecha_vencimiento).localeCompare(aISO(b.fecha_vencimiento)));
}

/** RF7: punto de reorden = consumo diario × días de entrega + stock mínimo. */
function puntoReorden({ consumo_diario, dias_entrega, stock_minimo }) {
  return Number(consumo_diario) * Number(dias_entrega) + Number(stock_minimo);
}

/** RF6: ¿el producto está en o bajo el punto de reorden? */
function requiereReposicion(producto, stockActual) {
  return Number(stockActual) <= puntoReorden(producto);
}

/** RF7: cantidad a comprar = punto de reorden + 2 días de consumo − stock vigente (mínimo 0). */
function cantidadSugerida(producto, stockActual) {
  const objetivo = puntoReorden(producto) + 2 * Number(producto.consumo_diario);
  return Math.max(0, Math.round((objetivo - Number(stockActual)) * 100) / 100);
}

/**
 * Ejecuta una salida PEPS dentro de una transacción (RF4).
 * `conn` es una conexión mysql2/promise ya obtenida del pool. Todas las consultas son parametrizadas.
 * FOR UPDATE bloquea los lotes del producto para que dos salidas simultáneas no descuenten lo mismo.
 */
async function ejecutarSalida(conn, { producto_id, cantidad, usuario_id, observacion = null }, hoy = new Date()) {
  await conn.beginTransaction();
  try {
    const [lotes] = await conn.query(
      'SELECT id, cantidad_actual, fecha_vencimiento FROM lote WHERE producto_id = ? AND cantidad_actual > 0 ORDER BY fecha_vencimiento, id FOR UPDATE',
      [producto_id]
    );
    const plan = planificarSalida(lotes, cantidad, hoy);
    for (const p of plan) {
      await conn.query('UPDATE lote SET cantidad_actual = cantidad_actual - ? WHERE id = ?', [p.cantidad, p.lote_id]);
      await conn.query(
        "INSERT INTO movimiento (tipo, lote_id, producto_id, usuario_id, cantidad, observacion) VALUES ('S', ?, ?, ?, ?, ?)",
        [p.lote_id, producto_id, usuario_id, p.cantidad, observacion]
      );
    }
    await conn.commit();
    return plan;
  } catch (err) {
    await conn.rollback(); // si algo falla no cambia nada
    throw err;
  }
}

module.exports = {
  ErrorNegocio, aISO, diasEntre, estaVencido, planificarSalida, validarEntrada,
  lotesPorVencer, puntoReorden, requiereReposicion, cantidadSugerida, ejecutarSalida,
};
