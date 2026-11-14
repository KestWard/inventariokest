'use strict';
// Uso: node src/cambiar-clave.js correo@x.com "NuevaClaveSegura123"
// Cambia la clave de una cuenta existente aplicando la misma política que crear-usuario.js.
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { validarClave } = require('./politica-clave');

(async () => {
  const [email, clave] = process.argv.slice(2);
  if (!email || !clave) {
    console.error('Uso: node src/cambiar-clave.js correo@x.com "NuevaClave"');
    process.exit(1);
  }
  const errores = validarClave(clave, { email });
  if (errores.length) {
    console.error('Clave rechazada: ' + errores.join(' '));
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  const [r] = await conn.query('UPDATE usuario SET password_hash = ? WHERE email = ?', [await bcrypt.hash(clave, 10), email]);
  await conn.end();
  if (!r.affectedRows) {
    console.error(`No existe una cuenta con el correo ${email}.`);
    process.exit(1);
  }
  console.log(`Clave de ${email} actualizada.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
