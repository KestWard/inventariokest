'use strict';
// Endurece el inicio de sesión (N4) y deja la instalación en un solo script (N3).
//  - Límite de intentos fallidos de login (429) y JWT de 2 h (configurable con JWT_EXPIRA).
//  - Política de contraseña en crear-usuario.js (mínimo 12 caracteres, letra y número).
//  - backend/schema.sql incluye la tabla solicitud_idempotente (un solo comando de instalación).
// Uso (desde la carpeta raíz del proyecto):  node aplicar-seguridad.js
// Hace copia de seguridad (.bak-seguridad); si falta un punto de anclaje obligatorio, NO modifica nada.
// Se puede ejecutar dos veces sin duplicar cambios.
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(...p);
const SERVER = R('backend', 'src', 'server.js');
const CREAR = R('backend', 'src', 'crear-usuario.js');
const SCHEMA = R('backend', 'schema.sql');
const README = 'README.md';
const ENVEX = R('backend', '.env.example');

const SERVER_LOGIN_CHEQUEO = `  const { email, password } = req.body ?? {};

  // Límite de intentos fallidos por cuenta e IP.
  const espera = limiteLogin.segundosBloqueo(req.ip, email);

  if (espera > 0) {
    res.set('Retry-After', String(espera));
    return res.status(429).json({
      error: \`Demasiados intentos fallidos. Intente de nuevo en \${Math.ceil(espera / 60)} minuto(s).\`
    });
  }
`;

const TABLA_IDEMPOTENTE = `-- Claves de idempotencia para las salidas FEFO (antes estaba en sql/01_solicitud_idempotente.sql).
CREATE TABLE IF NOT EXISTS solicitud_idempotente (
  clave VARCHAR(64) NOT NULL PRIMARY KEY,
  usuario_id INT NOT NULL,
  huella CHAR(64) NOT NULL,
  respuesta JSON NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

`;

const ENV_EXTRA = `
# Seguridad de la sesión (opcionales; estos son los valores por defecto)
JWT_EXPIRA=2h
LOGIN_MAX_INTENTOS=5
LOGIN_VENTANA_MIN=15
`;

const cambiosServer = (t) => [
  ['importar límite de intentos', t.includes("require('./limite-intentos')"),
    "const P = require('./peps');",
    "const P = require('./peps');\nconst { crearLimitador } = require('./limite-intentos');"],
  ['crear el limitador', t.includes('const limiteLogin'),
    'const hoy = () => P.aISO(new Date());\n',
    `const hoy = () => P.aISO(new Date());

const limiteLogin = crearLimitador({
  maxPorCuenta: Number(process.env.LOGIN_MAX_INTENTOS) || 5,
  ventanaMs: (Number(process.env.LOGIN_VENTANA_MIN) || 15) * 60 * 1000
});
`],
  ['bloquear tras demasiados fallos', t.includes('limiteLogin.segundosBloqueo'),
    '  const { email, password } = req.body ?? {};\n', SERVER_LOGIN_CHEQUEO],
  ['registrar el fallo', t.includes('limiteLogin.registrarFallo'),
    "    return res.status(401).json({\n      error: 'Correo o clave incorrectos.'\n    });\n",
    "    limiteLogin.registrarFallo(req.ip, email);\n\n    return res.status(401).json({\n      error: 'Correo o clave incorrectos.'\n    });\n"],
  ['reiniciar el contador al entrar', t.includes('limiteLogin.registrarExito'),
    '  const token = jwt.sign(\n',
    '  limiteLogin.registrarExito(req.ip, email);\n\n  const token = jwt.sign(\n'],
  ['vigencia del token', t.includes('JWT_EXPIRA'),
    "{ expiresIn: '12h' }", "{ expiresIn: process.env.JWT_EXPIRA || '2h' }"],
];

const cambiosCrear = (t) => [
  ['importar la política de clave', t.includes("require('./politica-clave')"),
    "const mysql = require('mysql2/promise');",
    "const mysql = require('mysql2/promise');\nconst { validarClave } = require('./politica-clave');"],
  ['validar la clave', t.includes('validarClave(clave'),
    '  const conn = await mysql.createConnection({\n',
    `  const errores = validarClave(clave, { email });
  if (errores.length) {
    console.error('Clave rechazada: ' + errores.join(' '));
    process.exit(1);
  }
  const conn = await mysql.createConnection({
`],
];

const cambiosSchema = (t) => [
  ['tabla solicitud_idempotente en el esquema base', t.includes('solicitud_idempotente'),
    '-- Datos semilla: valores de EJEMPLO', TABLA_IDEMPOTENTE + '-- Datos semilla: valores de EJEMPLO'],
];

const cambiosReadme = (t) => [
  ['instalación en un solo script', !t.includes('backend/sql/01_solicitud_idempotente.sql'),
    'mysql -u root -p < backend/schema.sql\nmysql -u root -p < backend/sql/01_solicitud_idempotente.sql\n',
    'mysql -u root -p < backend/schema.sql   # incluye la tabla de idempotencia\n'],
];

function leer(ruta) {
  const crudo = fs.readFileSync(ruta, 'utf8');
  return { texto: crudo.replace(/\r\n/g, '\n'), crlf: crudo.includes('\r\n') };
}

function planificar(ruta, cambios, { opcional = false } = {}) {
  if (!fs.existsSync(ruta)) {
    if (opcional) return { ruta, omitido: true, log: ['  (no existe; se omite)'] };
    throw new Error(`No existe ${ruta}. Ejecute este script desde la carpeta raíz del proyecto (donde están backend y frontend).`);
  }
  const { texto, crlf } = leer(ruta);
  let nuevo = texto;
  const log = [];
  for (const [desc, hecho, buscar, reemplazo] of cambios(texto)) {
    if (hecho) { log.push(`  = ${desc}: ya estaba aplicado`); continue; }
    const n = nuevo.split(buscar).length - 1;
    if (n !== 1) {
      if (opcional) { log.push(`  ! ${desc}: no se encontró el texto; cámbielo a mano`); continue; }
      throw new Error(`${ruta}: no se encontró (o es ambiguo) el punto "${desc}" (${n} coincidencias).`);
    }
    nuevo = nuevo.replace(buscar, () => reemplazo);
    log.push(`  + ${desc}`);
  }
  return { ruta, nuevo, crlf, cambio: nuevo !== texto, log };
}

function planEnv() {
  if (!fs.existsSync(ENVEX)) return { ruta: ENVEX, omitido: true, log: ['  (no existe; se omite)'] };
  const { texto, crlf } = leer(ENVEX);
  if (texto.includes('JWT_EXPIRA')) return { ruta: ENVEX, nuevo: texto, crlf, cambio: false, log: ['  = variables de sesión: ya estaban'] };
  const base = texto.endsWith('\n') ? texto : texto + '\n';
  return { ruta: ENVEX, nuevo: base + ENV_EXTRA, crlf, cambio: true, log: ['  + variables JWT_EXPIRA, LOGIN_MAX_INTENTOS, LOGIN_VENTANA_MIN'] };
}

try {
  for (const f of [R('backend', 'src', 'limite-intentos.js'), R('backend', 'src', 'politica-clave.js')]) {
    if (!fs.existsSync(f)) throw new Error(`Falta ${f}. Extraiga primero el zip dentro de la carpeta del proyecto.`);
  }
  const planes = [
    planificar(SERVER, cambiosServer),
    planificar(CREAR, cambiosCrear),
    planificar(SCHEMA, cambiosSchema),
    planificar(README, cambiosReadme, { opcional: true }),
    planEnv(),
  ];
  for (const p of planes) { console.log(p.ruta); p.log.forEach((l) => console.log(l)); }
  for (const p of planes) {
    if (!p.cambio) continue;
    const bak = p.ruta + '.bak-seguridad';
    if (!fs.existsSync(bak)) fs.copyFileSync(p.ruta, bak);
    fs.writeFileSync(p.ruta, p.crlf ? p.nuevo.replace(/\n/g, '\r\n') : p.nuevo, 'utf8');
  }
  console.log('\nListo. Reinicie el backend (npm start). Las pruebas P16, P17, P18, P20 y P21 deben repetirse sobre esta versión.');
} catch (e) {
  console.error('\nNo se modificó ningún archivo.\n' + e.message);
  process.exit(1);
}
