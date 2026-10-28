'use strict';
// Uso: node src/crear-usuario.js "Nombre" correo@x.com clave admin|encargado
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const [nombre, email, clave, rol] = process.argv.slice(2);
  if (!nombre || !email || !clave || !['admin', 'encargado'].includes(rol)) {
    console.error('Uso: node src/crear-usuario.js "Nombre" correo@x.com clave admin|encargado');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  await conn.query('INSERT INTO usuario (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)',
    [nombre, email, await bcrypt.hash(clave, 10), rol]);
  await conn.end();
  console.log(`Usuario ${email} creado.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
