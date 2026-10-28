'use strict';
require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const P = require('./peps');

if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET en .env');

// decimalNumbers: DECIMAL llega como número; dateStrings: DATE llega como 'YYYY-MM-DD' (sin zona horaria)
const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS,
  database: process.env.DB_NAME, decimalNumbers: true, dateStrings: true,
});

const app = express();
app.use(cors());
app.use(express.json());

const hoy = () => P.aISO(new Date());

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const [[u]] = await pool.query('SELECT id, nombre, rol, password_hash FROM usuario WHERE email = ? AND activo = 1', [String(email)]);
  if (!u || !(await bcrypt.compare(String(password), u.password_hash))) {
    return res.status(401).json({ error: 'Correo o clave incorrectos.' });
  }
  const token = jwt.sign({ id: u.id, rol: u.rol }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, nombre: u.nombre, rol: u.rol });
});

app.post('/api/auth/register', async (req, res) => {
  const { nombre, email, password } = req.body ?? {};
  if (!String(nombre).trim() || !/^\S+@\S+\.\S+$/.test(String(email)) || String(password).length < 8) {
    return res.status(400).json({ error: 'Nombre, correo válido y clave de mínimo 8 caracteres son obligatorios.' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const [r] = await pool.query(
      "INSERT INTO usuario (nombre, email, password_hash, rol) VALUES (?, ?, ?, 'encargado')",
      [String(nombre).trim(), String(email).trim().toLowerCase(), hash]
    );
    res.status(201).json({ id: r.insertId, mensaje: 'Cuenta creada. Ya puedes iniciar sesión.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese correo ya está registrado.' });
    throw err;
  }
});

// Todo lo que sigue requiere token
app.use('/api', (req, res, next) => {
  try {
    req.usuario = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }
});

/** Productos activos con su stock vigente (sin lotes vencidos). */
async function productosConStock() {
  const [rows] = await pool.query(
    `SELECT p.id, p.nombre, p.unidad, p.consumo_diario, p.dias_entrega, p.stock_minimo,
            COALESCE(SUM(l.cantidad_actual), 0) AS stock
       FROM producto p
       LEFT JOIN lote l ON l.producto_id = p.id AND l.fecha_vencimiento >= ?
      WHERE p.activo = 1
      GROUP BY p.id ORDER BY p.nombre`,
    [hoy()]
  );
  return rows;
}

app.get('/api/productos', async (req, res) => res.json(await productosConStock()));

app.post('/api/productos', async (req, res) => {
  const { nombre, unidad, consumo_diario = 0, dias_entrega = 1, stock_minimo = 0 } = req.body ?? {};
  if (!String(nombre).trim() || !String(unidad).trim() || [consumo_diario, dias_entrega, stock_minimo].some((v) => !Number.isFinite(Number(v)) || Number(v) < 0)) {
    return res.status(400).json({ error: 'Nombre, unidad y valores de inventario válidos son obligatorios.' });
  }
  try {
    const [r] = await pool.query(
      'INSERT INTO producto (nombre, unidad, consumo_diario, dias_entrega, stock_minimo) VALUES (?, ?, ?, ?, ?)',
      [String(nombre).trim(), String(unidad).trim(), Number(consumo_diario), Number(dias_entrega), Number(stock_minimo)]
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese producto ya existe.' });
    throw err;
  }
});

app.get('/api/proveedores', async (req, res) => {
  const [rows] = await pool.query('SELECT id, nombre FROM proveedor WHERE activo = 1 ORDER BY nombre');
  res.json(rows);
});

app.get('/api/alertas', async (req, res) => {
  const h = hoy();
  const [lotes] = await pool.query(
    'SELECT l.id, l.cantidad_actual, l.fecha_vencimiento, p.nombre AS producto FROM lote l JOIN producto p ON p.id = l.producto_id WHERE l.cantidad_actual > 0'
  );
  const vencimientos = P.lotesPorVencer(lotes, h).map((l) => ({ ...l, dias: P.diasEntre(h, l.fecha_vencimiento) }));
  const reposicion = (await productosConStock())
    .filter((p) => P.requiereReposicion(p, p.stock))
    .map((p) => ({ producto_id: p.id, producto: p.nombre, stock: p.stock, sugerido: P.cantidadSugerida(p, p.stock) }));
  res.json({ vencimientos, reposicion });
});

app.post('/api/lotes', async (req, res) => {
  const { producto_id, proveedor_id, cantidad, costo_unitario, fecha_vencimiento } = req.body ?? {};
  const errores = P.validarEntrada({ cantidad, fecha_vencimiento }, hoy());
  if (!Number(producto_id)) errores.push('Seleccione un producto.');
  if (!Number(proveedor_id)) errores.push('Seleccione un proveedor.');
  if (!Number.isFinite(costo_unitario) || costo_unitario < 0) errores.push('El costo unitario no es válido.');
  if (errores.length) return res.status(400).json({ error: errores.join(' ') });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      'INSERT INTO lote (producto_id, proveedor_id, cantidad_inicial, cantidad_actual, costo_unitario, fecha_ingreso, fecha_vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [producto_id, proveedor_id, cantidad, cantidad, costo_unitario, hoy(), fecha_vencimiento]
    );
    await conn.query(
      "INSERT INTO movimiento (tipo, lote_id, producto_id, usuario_id, cantidad) VALUES ('E', ?, ?, ?, ?)",
      [r.insertId, producto_id, req.usuario.id, cantidad]
    );
    await conn.commit();
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/salidas', async (req, res) => {
  const { producto_id, cantidad, observacion } = req.body ?? {};
  if (!Number(producto_id)) return res.status(400).json({ error: 'Seleccione un producto.' });
  const conn = await pool.getConnection();
  try {
    const descontado = await P.ejecutarSalida(
      conn, { producto_id, cantidad, usuario_id: req.usuario.id, observacion: observacion || null }, hoy()
    );
    res.json({ descontado });
  } finally {
    conn.release();
  }
});

app.get('/api/reportes/movimientos', async (req, res) => {
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
  const [movimientos] = await pool.query(
    `SELECT DATE_FORMAT(m.fecha, '%Y-%m-%d %H:%i') AS fecha, m.tipo, p.nombre AS producto, m.cantidad
       FROM movimiento m JOIN producto p ON p.id = m.producto_id
      WHERE m.fecha >= NOW() - INTERVAL ? DAY ORDER BY m.fecha DESC`,
    [dias]
  );
  const merma = {};
  for (const m of movimientos) if (m.tipo === 'M') merma[m.producto] = (merma[m.producto] || 0) + m.cantidad;
  res.json({ movimientos, merma: Object.entries(merma).map(([producto, total]) => ({ producto, merma: total })) });
});

app.use((err, req, res, next) => {
  if (err instanceof P.ErrorNegocio) return res.status(err.codigo).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error de servidor' });
});

const port = Number(process.env.PORT) || 3000;
// Express 5 entrega errores como EADDRINUSE al callback; sin esto el proceso termina en silencio
app.listen(port, (err) => {
  if (err) throw err;
  console.log(`API en http://localhost:${port}`);
});
