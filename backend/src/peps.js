
'use strict';

/**
 * Lógica de negocio FEFO y reposición.
 * Las funciones puras pueden probarse sin MySQL.
 * Fechas en formato YYYY-MM-DD.
 */

class ErrorNegocio extends Error {
  constructor(mensaje, codigo = 400) {
    super(mensaje);
    this.name = 'ErrorNegocio';
    this.codigo = codigo;
  }
}

function aISO(f) {
  if (typeof f === 'string') return f.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
}

function diasEntre(a, b) {
  const [ya, ma, da] = aISO(a).split('-').map(Number);
  const [yb, mb, db] = aISO(b).split('-').map(Number);

  return Math.round(
    (Date.UTC(yb, mb - 1, db) -
      Date.UTC(ya, ma - 1, da)) / 86400000
  );
}

function estaVencido(lote, hoy = new Date()) {
  return aISO(lote.fecha_vencimiento) < aISO(hoy);
}

function planificarSalida(lotes, cantidad, hoy = new Date()) {
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new ErrorNegocio(
      'La cantidad debe ser un número mayor que cero.'
    );
  }

  const vigentes = lotes
    .filter(
      l => Number(l.cantidad_actual) > 0 &&
        !estaVencido(l, hoy)
    )
    .sort((a, b) => {
      const c = aISO(a.fecha_vencimiento)
        .localeCompare(aISO(b.fecha_vencimiento));

      return c !== 0 ? c : a.id - b.id;
    });

  const disponible = vigentes.reduce(
    (s, l) => s + Number(l.cantidad_actual),
    0
  );

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

    const tomar = Math.min(
      falta,
      Number(l.cantidad_actual)
    );

    plan.push({
      lote_id: l.id,
      cantidad: tomar
    });

    falta = Math.round((falta - tomar) * 100) / 100;
  }

  return plan;
}

function validarEntrada(
  { cantidad, fecha_vencimiento },
  hoy = new Date()
) {
  const errores = [];

  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    errores.push('La cantidad debe ser mayor que cero.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_vencimiento))) {
    errores.push(
      'La fecha de vencimiento no es válida (AAAA-MM-DD).'
    );
  } else if (aISO(fecha_vencimiento) < aISO(hoy)) {
    errores.push(
      'La fecha de vencimiento no puede ser pasada.'
    );
  }

  return errores;
}

function lotesPorVencer(
  lotes,
  hoy = new Date(),
  dias = 2
) {
  return lotes
    .filter(
      l => Number(l.cantidad_actual) > 0 &&
        diasEntre(hoy, l.fecha_vencimiento) <= dias
    )
    .sort((a, b) =>
      aISO(a.fecha_vencimiento)
        .localeCompare(aISO(b.fecha_vencimiento))
    );
}

function puntoReorden({
  consumo_diario,
  dias_entrega,
  stock_minimo
}) {
  return Number(consumo_diario) *
    Number(dias_entrega) +
    Number(stock_minimo);
}

function requiereReposicion(producto, stockActual) {
  return Number(stockActual) <= puntoReorden(producto);
}

function cantidadSugerida(producto, stockActual) {
  const objetivo = puntoReorden(producto) +
    2 * Number(producto.consumo_diario);

  return Math.max(
    0,
    Math.round(
      (objetivo - Number(stockActual)) * 100
    ) / 100
  );
}

/**
 * Salida FEFO transaccional.
 * Reserva una clave de idempotencia.
 * Evita descuentos duplicados de una misma solicitud.
 */
async function ejecutarSalida(
  conn,
  {
    producto_id,
    cantidad,
    usuario_id,
    observacion = null,
    clave_idempotencia = null,
    huella = null
  },
  hoy = new Date()
) {
  if (clave_idempotencia && !huella) {
    throw new ErrorNegocio(
      'Falta identificar la operación.',
      400
    );
  }

  await conn.beginTransaction();

  try {
    // La clave se registra en la misma transacción.
    if (clave_idempotencia) {
      await conn.query(
        `INSERT INTO solicitud_idempotente
         (clave, usuario_id, huella)
         VALUES (?, ?, ?)`,
        [clave_idempotencia, usuario_id, huella]
      );
    }

    // Bloquea lotes para impedir descuentos concurrentes.
    const [lotes] = await conn.query(
      `SELECT id, cantidad_actual, fecha_vencimiento
       FROM lote
       WHERE producto_id = ?
         AND cantidad_actual > 0
       ORDER BY fecha_vencimiento, id
       FOR UPDATE`,
      [producto_id]
    );

    const plan = planificarSalida(
      lotes,
      cantidad,
      hoy
    );

    for (const p of plan) {
      await conn.query(
        `UPDATE lote
         SET cantidad_actual = cantidad_actual - ?
         WHERE id = ?`,
        [p.cantidad, p.lote_id]
      );

      await conn.query(
        `INSERT INTO movimiento
         (tipo, lote_id, producto_id, usuario_id,
          cantidad, observacion)
         VALUES ('S', ?, ?, ?, ?, ?)`,
        [
          p.lote_id,
          producto_id,
          usuario_id,
          p.cantidad,
          observacion
        ]
      );
    }

    // Guarda la respuesta para futuros reintentos.
    if (clave_idempotencia) {
      await conn.query(
        `UPDATE solicitud_idempotente
         SET respuesta = ?
         WHERE clave = ?`,
        [
          JSON.stringify({ descontado: plan }),
          clave_idempotencia
        ]
      );
    }

    await conn.commit();

    return plan;

  } catch (err) {
    await conn.rollback();

    // Detecta una solicitud ya procesada.
    if (
      clave_idempotencia &&
      err.code === 'ER_DUP_ENTRY'
    ) {
      const [[previa]] = await conn.query(
        `SELECT usuario_id, huella, respuesta
         FROM solicitud_idempotente
         WHERE clave = ?`,
        [clave_idempotencia]
      );

      if (previa) {
        if (
          Number(previa.usuario_id) !== Number(usuario_id) ||
          previa.huella !== huella
        ) {
          throw new ErrorNegocio(
            'Esta clave ya pertenece a otra operación.',
            409
          );
        }

        const respuesta =
          typeof previa.respuesta === 'string'
            ? JSON.parse(previa.respuesta)
            : previa.respuesta;

        if (
          !respuesta ||
          !Array.isArray(respuesta.descontado)
        ) {
          throw new ErrorNegocio(
            'La operación anterior no tiene respuesta disponible.',
            409
          );
        }

        // Devuelve el resultado anterior sin descontar otra vez.
        return respuesta.descontado;
      }
    }

    throw err;
  }
}

module.exports = {
  ErrorNegocio,
  aISO,
  diasEntre,
  estaVencido,
  planificarSalida,
  validarEntrada,
  lotesPorVencer,
  puntoReorden,
  requiereReposicion,
  cantidadSugerida,
  ejecutarSalida
};
