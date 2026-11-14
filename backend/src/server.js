
'use strict';

const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const P = require('./peps');
const D = require('./demanda');

if (!process.env.JWT_SECRET) {
  throw new Error('Falta JWT_SECRET en .env');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  decimalNumbers: true,
  dateStrings: true
});

const app = express();
app.use(cors());
app.use(express.json());

const hoy = () => P.aISO(new Date());

// Solo el administrador puede iniciar sesion.
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  const [[u]] = await pool.query(
    'SELECT id, nombre, rol, password_hash FROM usuario WHERE email = ? AND activo = 1',
    [String(email ?? '')]
  );

  if (
    !u ||
    u.rol !== 'admin' ||
    !(await bcrypt.compare(
      String(password ?? ''),
      u.password_hash
    ))
  ) {
    return res.status(401).json({
      error: 'Correo o clave incorrectos.'
    });
  }

  const token = jwt.sign(
    { id: u.id, rol: u.rol },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    nombre: u.nombre,
    rol: u.rol
  });
});

// Registro publico deshabilitado.
app.post('/api/auth/register', (req, res) => {
  return res.status(403).json({
    error: 'El registro publico de cuentas esta deshabilitado.'
  });
});

// Verificar autenticacion JWT.
app.use('/api', (req, res, next) => {
  try {
    const autorizacion = req.headers.authorization || '';

    req.usuario = jwt.verify(
      autorizacion.replace(/^Bearer\s+/i, ''),
      process.env.JWT_SECRET
    );

    next();
  } catch {
    res.status(401).json({
      error: 'Sesion invalida o expirada.'
    });
  }
});

// Restringir operaciones al administrador.
app.use('/api', (req, res, next) => {
  if (
    !req.usuario ||
    req.usuario.rol !== 'admin'
  ) {
    return res.status(403).json({
      error: 'Acceso exclusivo del administrador.'
    });
  }

  next();
});

// Consultar stock vigente por producto.
async function productosConStock() {
  const [rows] = await pool.query(
    `SELECT p.id, p.nombre, p.unidad, p.consumo_diario,
            p.dias_entrega, p.stock_minimo,
            COALESCE(SUM(l.cantidad_actual), 0) AS stock
       FROM producto p
       LEFT JOIN lote l
         ON l.producto_id = p.id
        AND l.fecha_vencimiento >= ?
      WHERE p.activo = 1
      GROUP BY p.id
      ORDER BY p.nombre`,
    [hoy()]
  );

  return rows;
}

app.get('/api/productos', async (req, res) => {
  res.json(await productosConStock());
});

// Crear producto.
app.post('/api/productos', async (req, res) => {
  const {
    nombre,
    unidad,
    consumo_diario = 0,
    dias_entrega = 1,
    stock_minimo = 0
  } = req.body ?? {};

  if (
    !String(nombre ?? '').trim() ||
    !String(unidad ?? '').trim() ||
    [consumo_diario, dias_entrega, stock_minimo].some(
      v => !Number.isFinite(Number(v)) || Number(v) < 0
    )
  ) {
    return res.status(400).json({
      error: 'Nombre, unidad y valores de inventario validos son obligatorios.'
    });
  }

  try {
    const [r] = await pool.query(
      `INSERT INTO producto
       (nombre, unidad, consumo_diario,
        dias_entrega, stock_minimo)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(nombre).trim(),
        String(unidad).trim(),
        Number(consumo_diario),
        Number(dias_entrega),
        Number(stock_minimo)
      ]
    );

    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Ese producto ya existe.'
      });
    }

    throw err;
  }
});

// Consultar proveedores.
app.get('/api/proveedores', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, nombre
       FROM proveedor
      WHERE activo = 1
      ORDER BY nombre`
  );

  res.json(rows);
});

// Demanda estimada con las salidas reales (promedio móvil + estacionalidad semanal).
async function evaluarProductos() {
  const h = hoy();
  const desde = D.sumarDias(h, -D.VENTANA_DIAS);
  const productos = await productosConStock();

  const [ventas] = await pool.query(
    `SELECT producto_id, DATE(fecha) AS fecha, SUM(cantidad) AS cantidad
       FROM movimiento
      WHERE tipo = 'S' AND fecha >= ? AND fecha < ?
      GROUP BY producto_id, DATE(fecha)`,
    [desde, h]
  );

  const [primeros] = await pool.query(
    `SELECT producto_id, MIN(DATE(fecha)) AS primero
       FROM movimiento
      GROUP BY producto_id`
  );

  const primeroDe = Object.fromEntries(
    primeros.map(r => [r.producto_id, r.primero])
  );

  return productos.map(p => {
    const prediccion = D.prediccionDemanda(
      ventas.filter(v => v.producto_id === p.id),
      h,
      {
        consumo_manual: p.consumo_diario,
        desde_registro: primeroDe[p.id] || null
      }
    );

    return {
      producto: p,
      prediccion,
      reposicion: D.evaluarReposicion(p, p.stock, prediccion, h)
    };
  });
}

// Consultar la demanda estimada por producto y día de la semana.
app.get('/api/demanda', async (req, res) => {
  const filas = await evaluarProductos();

  res.json(filas.map(({ producto: p, prediccion: d }) => ({
    producto_id: p.id,
    producto: p.nombre,
    unidad: p.unidad,
    consumo_manual: p.consumo_diario,
    metodo: d.metodo,
    ventana_dias: d.ventana_dias,
    promedio_diario: d.promedio_diario,
    por_dia_semana: d.por_dia_semana
  })));
});

// Consultar alertas.
app.get('/api/alertas', async (req, res) => {
  const h = hoy();

  const [lotes] = await pool.query(
    `SELECT l.id, l.cantidad_actual,
            l.fecha_vencimiento,
            p.nombre AS producto
       FROM lote l
       JOIN producto p ON p.id = l.producto_id
      WHERE l.cantidad_actual > 0`
  );

  const vencimientos = P.lotesPorVencer(lotes, h)
    .map(l => ({
      ...l,
      dias: P.diasEntre(h, l.fecha_vencimiento)
    }));

  const reposicion = (await evaluarProductos())
    .filter(f => f.reposicion.requiere)
    .map(({ producto: p, reposicion: r }) => ({
      producto_id: p.id,
      producto: p.nombre,
      stock: p.stock,
      sugerido: r.sugerido,
      consumo_estimado: r.consumo_estimado,
      metodo: r.metodo,
      demanda_entrega: r.demanda_entrega,
      punto_reorden: r.punto_reorden
    }));

  res.json({
    vencimientos,
    reposicion
  });
});

// Registrar entrada de inventario.
app.post('/api/lotes', async (req, res) => {
  const {
    producto_id,
    proveedor_id,
    cantidad,
    costo_unitario,
    fecha_vencimiento
  } = req.body ?? {};

  const errores = P.validarEntrada(
    { cantidad, fecha_vencimiento },
    hoy()
  );

  if (!Number(producto_id)) {
    errores.push('Seleccione un producto.');
  }

  if (!Number(proveedor_id)) {
    errores.push('Seleccione un proveedor.');
  }

  if (!Number.isFinite(costo_unitario) || costo_unitario < 0) {
    errores.push('El costo unitario no es valido.');
  }

  if (errores.length) {
    return res.status(400).json({
      error: errores.join(' ')
    });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      `INSERT INTO lote
       (producto_id, proveedor_id, cantidad_inicial,
        cantidad_actual, costo_unitario,
        fecha_ingreso, fecha_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        producto_id,
        proveedor_id,
        cantidad,
        cantidad,
        costo_unitario,
        hoy(),
        fecha_vencimiento
      ]
    );

    await conn.query(
      `INSERT INTO movimiento
       (tipo, lote_id, producto_id, usuario_id, cantidad)
       VALUES ('E', ?, ?, ?, ?)`,
      [
        r.insertId,
        producto_id,
        req.usuario.id,
        cantidad
      ]
    );

    await conn.commit();

    res.status(201).json({
      id: r.insertId
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// UNICA ruta de salidas: FEFO + idempotencia P18.
app.post('/api/salidas', async (req, res) => {
  const {
    producto_id,
    cantidad,
    observacion
  } = req.body ?? {};

  if (!Number(producto_id)) {
    return res.status(400).json({
      error: 'Seleccione un producto.'
    });
  }

  // Identificador de la operacion.
  const clave_idempotencia = String(
    req.get('Idempotency-Key') || ''
  ).trim();

  const formatoUUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!formatoUUID.test(clave_idempotencia)) {
    return res.status(400).json({
      error: 'Falta una clave valida para identificar la operacion.'
    });
  }

  // Huella para distinguir operaciones diferentes.
  const huella = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      producto_id: Number(producto_id),
      cantidad: Number(cantidad),
      observacion: observacion || null
    }))
    .digest('hex');

  const conn = await pool.getConnection();

  try {
    const descontado = await P.ejecutarSalida(
      conn,
      {
        producto_id,
        cantidad,
        usuario_id: req.usuario.id,
        observacion: observacion || null,
        clave_idempotencia,
        huella
      },
      hoy()
    );

    res.json({ descontado });
  } finally {
    conn.release();
  }
});

// Reporte de movimientos.
app.get('/api/reportes/movimientos', async (req, res) => {
  const dias = Math.min(
    Math.max(parseInt(req.query.dias, 10) || 30, 1),
    365
  );

  const [movimientos] = await pool.query(
    `SELECT DATE_FORMAT(m.fecha, '%Y-%m-%d %H:%i') AS fecha,
            m.tipo, p.nombre AS producto, m.cantidad
       FROM movimiento m
       JOIN producto p ON p.id = m.producto_id
      WHERE m.fecha >= NOW() - INTERVAL ? DAY
      ORDER BY m.fecha DESC`,
    [dias]
  );

  const merma = {};

  for (const m of movimientos) {
    if (m.tipo === 'M') {
      merma[m.producto] =
        (merma[m.producto] || 0) + m.cantidad;
    }
  }

  res.json({
    movimientos,
    merma: Object.entries(merma)
      .map(([producto, total]) => ({
        producto,
        merma: total
      }))
  });
});

// Manejo de errores.
app.use((err, req, res, next) => {
  if (err instanceof P.ErrorNegocio) {
    return res.status(err.codigo).json({
      error: err.message
    });
  }

  console.error(err);

  res.status(500).json({
    error: 'Error de servidor'
  });
});

// Iniciar el servidor.
const port = Number(process.env.PORT) || 3000;

app.listen(port, err => {
  if (err) throw err;

  console.log(`API en http://localhost:${port}`);
});
