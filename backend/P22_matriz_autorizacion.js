'use strict';
/**
 * P22 · Matriz de autorización de rutas y límite de intentos de inicio de sesión.
 *
 * Comprueba, para cada ruta protegida de la API, la respuesta con: sin token, token inválido,
 * token vencido, rol "encargado" y rol "admin". Con "admin" solo se envían GET y POST con cuerpo
 * vacío ({}), que el servidor rechaza con 400 antes de tocar la base de datos: no se crea ni se
 * modifica ningún dato. Al final comprueba el bloqueo tras intentos fallidos de login.
 *
 * Uso (con el backend en marcha, idealmente sobre la base de ensayo):
 *   cd backend
 *   node P22_matriz_autorizacion.js                  # usa http://localhost:3000
 *   P22_URL=http://localhost:3100 node P22_matriz_autorizacion.js
 *   node P22_matriz_autorizacion.js --sin-limite     # omite la prueba del límite de intentos
 *
 * Los tokens de ensayo se firman con el JWT_SECRET de backend/.env (el mismo que usa el servidor).
 * La prueba del límite hace 6 inicios de sesión fallidos con un correo inventado desde esta IP;
 * no repetirla más de 3 veces en 15 minutos para no bloquear la IP con el contador general.
 * Escribe el resultado en P22_resultados_<fecha>.txt.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function leerEnv() {
  const env = { ...process.env };
  const f = path.join(__dirname, '.env');
  if (fs.existsSync(f)) {
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function firmar(payload, secreto, ttlSeg = 300) {
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ ...payload, iat: ahora, exp: ahora + ttlSeg });
  return cuerpo + '.' + crypto.createHmac('sha256', secreto).update(cuerpo).digest('base64url');
}

const RUTAS = [
  ['GET', '/api/productos'],
  ['POST', '/api/productos'],
  ['GET', '/api/proveedores'],
  ['GET', '/api/alertas'],
  ['POST', '/api/lotes'],
  ['POST', '/api/salidas'],
  ['GET', '/api/reportes/movimientos'],
  ['GET', '/api/demanda', true],  // opcionales: solo existen si se aplicó la integración
  ['GET', '/api/resumen', true],
];

async function main() {
  const env = leerEnv();
  const base = (env.P22_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
  const secreto = env.JWT_SECRET;
  if (!secreto) throw new Error('No se encontró JWT_SECRET (backend/.env).');
  const omitirLimite = process.argv.includes('--sin-limite');

  const lineas = [];
  const salida = (...a) => { const t = a.join(' '); lineas.push(t); console.log(t); };
  let fallos = 0;

  const llamar = async (metodo, ruta, token, cuerpo, extra = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
      body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo ?? {}),
    });
    return { status: r.status, retry: r.headers.get('retry-after') };
  };

  let version = { commit: 'no disponible', huella_codigo: 'no disponible', node: process.version };
  try { version = require('../identificar-version').identificar(path.join(__dirname, '..')); } catch { /* opcional */ }

  salida(`P22 matriz de autorización · ${new Date().toISOString()}`);
  salida(`Servidor: ${base} | Node ${version.node} | commit: ${version.commit} | huella del código: ${version.huella_codigo}`);
  salida('');

  const tokens = {
    inv: firmar({ id: 1, rol: 'admin' }, secreto + '-incorrecto'),
    venc: firmar({ id: 1, rol: 'admin' }, secreto, -60),
    enc: firmar({ id: 999, rol: 'encargado' }, secreto),
    adm: firmar({ id: 1, rol: 'admin' }, secreto),
  };

  const col = (s, n) => String(s).padEnd(n);
  salida(col('Ruta', 34) + col('sin token', 11) + col('inválido', 10) + col('vencido', 9) + col('encargado', 11) + 'admin');
  const marca = (real, ok) => `${real}${ok ? '' : ' ✗'}`;

  for (const [metodo, ruta, opcional] of RUTAS) {
    const admin = await llamar(metodo, ruta, tokens.adm);
    if (opcional && admin.status === 404) { salida(col(`${metodo} ${ruta}`, 34) + 'no existe en esta versión (se omite)'); continue; }
    const [a, b, c, d] = [
      await llamar(metodo, ruta, null),
      await llamar(metodo, ruta, tokens.inv),
      await llamar(metodo, ruta, tokens.venc),
      await llamar(metodo, ruta, tokens.enc),
    ];
    const esperadoAdmin = metodo === 'GET' ? 200 : 400;
    const oks = [a.status === 401, b.status === 401, c.status === 401, d.status === 403, admin.status === esperadoAdmin];
    fallos += oks.filter((x) => !x).length;
    salida(col(`${metodo} ${ruta}`, 34) + col(marca(a.status, oks[0]), 11) + col(marca(b.status, oks[1]), 10) +
      col(marca(c.status, oks[2]), 9) + col(marca(d.status, oks[3]), 11) + marca(admin.status, oks[4]));
  }
  salida('Esperado: sin token / inválido / vencido = 401; encargado = 403; admin = 200 (GET) o 400 (POST con cuerpo vacío).');

  // Registro público y acceso con cuerpo vacío al login.
  const reg = await llamar('POST', '/api/auth/register', null, {});
  const regAdm = await llamar('POST', '/api/auth/register', tokens.adm, {});
  const okReg = reg.status === 403 && regAdm.status === 403;
  if (!okReg) fallos++;
  salida('');
  salida(`POST /api/auth/register: sin token ${reg.status}, con admin ${regAdm.status}${okReg ? '' : ' ✗'} (esperado 403 en ambos)`);

  if (!omitirLimite) {
    const correo = `p22-${crypto.randomBytes(4).toString('hex')}@prueba.invalid`;
    const estados = [];
    let ultimo;
    for (let i = 0; i < 6; i++) {
      ultimo = await llamar('POST', '/api/auth/login', null, { email: correo, password: 'clave-incorrecta-1' });
      estados.push(ultimo.status);
    }
    const okLimite = estados.slice(0, 5).every((s) => s === 401) && ultimo.status === 429 && Number(ultimo.retry) > 0;
    if (!okLimite) fallos++;
    salida('');
    salida(`Límite de intentos (6 logins fallidos con un correo inventado): ${estados.join(', ')} | Retry-After: ${ultimo.retry ?? 'ausente'}${okLimite ? '' : ' ✗'}`);
    salida('Esperado: 401 ×5 y, al sexto intento, 429 con Retry-After.');
  }

  salida('');
  salida(fallos === 0 ? 'RESULTADO: todas las comprobaciones cumplen lo esperado.' : `RESULTADO: ${fallos} comprobación(es) no cumplen lo esperado (marcadas con ✗).`);
  if (fallos && tokens.adm) salida('Nota: si "admin" devuelve 401, el JWT_SECRET de backend/.env no coincide con el del servidor que está en marcha.');

  const archivo = path.join(__dirname, `P22_resultados_${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(archivo, lineas.join('\n') + '\n', 'utf8');
  console.log(`\nResultado guardado en ${path.basename(archivo)}`);
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('P22 no pudo ejecutarse: ' + e.message); process.exit(1); });
