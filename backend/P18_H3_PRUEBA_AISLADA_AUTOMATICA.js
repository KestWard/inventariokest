
'use strict';

/*
  Pruebas H3 y P18 sobre base de ensayo aislada.

  Base: asadero_h3_p18_final_20261113
  Puerto temporal: 3018

  Nunca modifica asadero_inventario.
  No ejecuta salidas si fallan las verificaciones iniciales.
*/

require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

const BASE = 'asadero_h3_p18_final_20261113';
const PUERTO = 3018;
const URL = `http://127.0.0.1:${PUERTO}`;
const NOMBRE = 'Producto Ensayo P18';
const CORREO = 'admin.p18@pruebas.local';

const REGISTRO = path.join(
  __dirname,
  'P18_H3_resultados_verificacion_final.txt'
);

const mensajes = [];

function log(...valores) {
  const linea = valores.join(' ');
  console.log(linea);
  mensajes.push(linea);
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function puertoDisponible() {
  return new Promise(resolve => {
    const servidor = net.createServer();

    servidor.once('error', () => resolve(false));

    servidor.listen(PUERTO, '127.0.0.1', () => {
      servidor.close(() => resolve(true));
    });
  });
}

async function llamar(
  ruta,
  metodo = 'GET',
  cuerpo,
  token,
  clave
) {
  const respuesta = await fetch(URL + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',

      ...(token
        ? { Authorization: `Bearer ${token}` }
        : {}),

      ...(clave
        ? { 'Idempotency-Key': clave }
        : {})
    },

    ...(cuerpo === undefined
      ? {}
      : { body: JSON.stringify(cuerpo) }),

    signal: AbortSignal.timeout(12000)
  });

  const texto = await respuesta.text();

  let data;

  try {
    data = JSON.parse(texto);
  } catch {
    data = { texto };
  }

  return {
    status: respuesta.status,
    data
  };
}

async function iniciarServidor() {
  assert.ok(
    await puertoDisponible(),
    `El puerto ${PUERTO} esta ocupado. No se detendra otro proceso.`
  );

  const env = {
    ...process.env,
    DB_NAME: BASE,
    PORT: String(PUERTO)
  };

  log(
    'ARCHIVO API:',
    path.join(__dirname, 'src', 'server.js')
  );

  const proceso = spawn(
    process.execPath,
    ['src/server.js'],
    {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  let salida = '';

  proceso.stdout.on('data', d => {
    salida += d.toString();
  });

  proceso.stderr.on('data', d => {
    salida += d.toString();
  });

  for (let i = 0; i < 45; i++) {
    if (proceso.exitCode !== null) break;

    if (
      salida.includes(
        `API en http://localhost:${PUERTO}`
      )
    ) {
      log('SERVIDOR INICIADO PID:', proceso.pid);

      return {
        proceso,
        salida: () => salida
      };
    }

    await esperar(200);
  }

  proceso.kill();

  throw new Error(
    `No inicio servidor P18: ${salida.slice(-800)}`
  );
}

async function ejecutar() {
  assert.ok(
    process.env.P18_TEST_PASSWORD,
    'Falta la contraseña temporal del administrador P18.'
  );

  assert.ok(
    process.env.DB_PASS,
    'Falta DB_PASS en backend/.env'
  );

  // Conexion directa exclusivamente a la base de ensayo.
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS,
    database: BASE,
    dateStrings: true,
    decimalNumbers: true
  });

  let servidor;

  try {
    // VERIFICACION INICIAL DE MYSQL

    const [[baseInfo]] = await db.query(
      'SELECT DATABASE() AS base, CURDATE() AS hoy'
    );

    assert.equal(
      baseInfo.base,
      BASE,
      'La conexion no corresponde a la base aislada.'
    );

    const [[producto]] = await db.query(
      `SELECT id
       FROM producto
       WHERE nombre = ?
         AND activo = 1`,
      [NOMBRE]
    );

    assert.ok(
      producto,
      'No existe el producto de ensayo.'
    );

    const id = Number(producto.id);

    const [[loteInicial]] = await db.query(
      `SELECT COUNT(*) AS lotes,
              COALESCE(SUM(cantidad_actual), 0) AS stock
       FROM lote
       WHERE producto_id = ?
         AND fecha_vencimiento >= CURDATE()`,
      [id]
    );

    const [[movInicial]] = await db.query(
      `SELECT COUNT(*) AS n
       FROM movimiento
       WHERE producto_id = ?`,
      [id]
    );

    const [[clavesIniciales]] = await db.query(
      `SELECT COUNT(*) AS n
       FROM solicitud_idempotente`
    );

    log(
      'PREVALIDACION MYSQL:',
      baseInfo.base,
      'PRODUCTO:', id,
      'STOCK:', loteInicial.stock,
      'LOTES:', loteInicial.lotes,
      'MOVIMIENTOS:', movInicial.n,
      'CLAVES:', clavesIniciales.n
    );

    assert.equal(Number(loteInicial.stock), 5);
    assert.equal(Number(loteInicial.lotes), 1);
    assert.equal(Number(movInicial.n), 0);
    assert.equal(Number(clavesIniciales.n), 0);

    // INICIAR API TEMPORAL

    servidor = await iniciarServidor();

    log(
      'SERVIDOR TEMPORAL:',
      PUERTO,
      'BASE IMPUESTA:',
      BASE
    );

    // H3: COMPROBAR SEGURIDAD

    const registro = await llamar(
      '/api/auth/register',
      'POST',
      {}
    );

    const sinSesion = await llamar('/api/productos');

    const simulado = jwt.sign(
      { id: 999, rol: 'encargado' },
      process.env.JWT_SECRET,
      { expiresIn: '1m' }
    );

    const rolNoAutorizado = await llamar(
      '/api/productos',
      'GET',
      undefined,
      simulado
    );

    // Mostrar los tres resultados ANTES de validarlos.
    log(
      'H3 REGISTRO:',
      registro.status,
      JSON.stringify(registro.data)
    );

    log(
      'H3 SIN TOKEN:',
      sinSesion.status,
      JSON.stringify(sinSesion.data)
    );

    log(
      'H3 ROL ENCARGADO:',
      rolNoAutorizado.status,
      JSON.stringify(rolNoAutorizado.data)
    );

    if (
      registro.status !== 403 ||
      sinSesion.status !== 401 ||
      rolNoAutorizado.status !== 403
    ) {
      log(
        'SERVIDOR STDOUT:',
        servidor.salida()
          .trim()
          .replace(/\r?\n/g, ' | ')
          .slice(-800)
      );

      throw new Error(
        `H3 rechazado: registro=${registro.status}, ` +
        `sinToken=${sinSesion.status}, ` +
        `encargado=${rolNoAutorizado.status}. ` +
        'No se hicieron salidas.'
      );
    }

    log(
      'H3 OK | registro 403 | sin token 401 | encargado 403'
    );

    // LOGIN DEL ADMINISTRADOR DE ENSAYO

    const login = await llamar(
      '/api/auth/login',
      'POST',
      {
        email: CORREO,
        password: process.env.P18_TEST_PASSWORD
      }
    );

    log('ADMIN P18 LOGIN HTTP:', login.status);

    assert.equal(login.status, 200);
    assert.equal(login.data.rol, 'admin');

    const token = login.data.token;

    // COMPROBAR STOCK DESDE LA API

    const lista = await llamar(
      '/api/productos',
      'GET',
      undefined,
      token
    );

    log('API PRODUCTOS HTTP:', lista.status);

    assert.equal(lista.status, 200);

    assert.ok(
      Array.isArray(lista.data),
      'La API no devolvio una lista de productos.'
    );

    const productoAPI = lista.data.find(
      p => Number(p.id) === id
    );

    const stockAPI = productoAPI
      ? Number(productoAPI.stock)
      : null;

    log(
      'PREVALIDACION API:',
      'PRODUCTO:', id,
      'STOCK:', stockAPI
    );

    log(
      'API PRODUCTOS:',
      JSON.stringify(lista.data).slice(0, 1100)
    );

    if (stockAPI !== 5) {
      log(
        'DIAGNOSTICO DEL SERVIDOR:',
        servidor.salida()
          .trim()
          .replace(/\r?\n/g, ' | ')
          .slice(-950)
      );
    }

    // Nunca descontar si la API no reconoce los 5 kg.
    assert.equal(
      stockAPI,
      5,
      'La API no muestra 5 kg. Prueba detenida sin salidas.'
    );

    log('PREVALIDACION APROBADA.');

    // DATOS DE LAS SALIDAS DE ENSAYO

    const cuerpo = {
      producto_id: id,
      cantidad: 1,
      observacion: 'Ensayo H3-P18'
    };

    async function estado() {
      const [[s]] = await db.query(
        `SELECT COALESCE(SUM(cantidad_actual), 0) AS stock
         FROM lote
         WHERE producto_id = ?`,
        [id]
      );

      const [[m]] = await db.query(
        `SELECT COUNT(*) AS n
         FROM movimiento
         WHERE producto_id = ?
           AND tipo = 'S'`,
        [id]
      );

      return {
        stock: Number(s.stock),
        movimientos: Number(m.n)
      };
    }

    async function verificar(n, stock, movimientos) {
      const actual = await estado();

      assert.equal(
        actual.stock,
        stock,
        `Caso ${n}: stock incorrecto`
      );

      assert.equal(
        actual.movimientos,
        movimientos,
        `Caso ${n}: movimientos incorrectos`
      );
    }

    // P18 CASO 1: REENVIO IDENTICO

    const claveA = crypto.randomUUID();

    const r1 = await llamar(
      '/api/salidas',
      'POST',
      cuerpo,
      token,
      claveA
    );

    const r2 = await llamar(
      '/api/salidas',
      'POST',
      cuerpo,
      token,
      claveA
    );

    log('P18 CASO 1 HTTP:', r1.status, r2.status);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(r1.data, r2.data);

    await verificar(1, 4, 1);

    log(
      'CASO 1/4 OK | reenvio 200/200 | stock 5 a 4 | 1 movimiento'
    );

    // P18 CASO 2: SALIDA INDEPENDIENTE

    const claveB = crypto.randomUUID();

    const r3 = await llamar(
      '/api/salidas',
      'POST',
      cuerpo,
      token,
      claveB
    );

    log('P18 CASO 2 HTTP:', r3.status);

    assert.equal(r3.status, 200);

    await verificar(2, 3, 2);

    log(
      'CASO 2/4 OK | nueva salida 200 | stock 4 a 3'
    );

    // P18 CASO 3: CLAVE CON DATOS DIFERENTES

    const r4 = await llamar(
      '/api/salidas',
      'POST',
      { ...cuerpo, cantidad: 2 },
      token,
      claveB
    );

    log('P18 CASO 3 HTTP:', r4.status);

    assert.equal(r4.status, 409);

    await verificar(3, 3, 2);

    log(
      'CASO 3/4 OK | clave reutilizada 409 | stock 3'
    );

    // P18 CASO 4: DOS SOLICITUDES SIMULTANEAS

    const claveC = crypto.randomUUID();

    const [r5, r6] = await Promise.all([
      llamar(
        '/api/salidas',
        'POST',
        cuerpo,
        token,
        claveC
      ),
      llamar(
        '/api/salidas',
        'POST',
        cuerpo,
        token,
        claveC
      )
    ]);

    log('P18 CASO 4 HTTP:', r5.status, r6.status);

    assert.deepEqual(
      [r5.status, r6.status].sort(),
      [200, 200]
    );

    assert.deepEqual(r5.data, r6.data);

    await verificar(4, 2, 3);

    const [[finalClaves]] = await db.query(
      'SELECT COUNT(*) AS n FROM solicitud_idempotente'
    );

    assert.equal(Number(finalClaves.n), 3);

    log(
      'CASO 4/4 OK | simultaneas 200/200 | stock 3 a 2'
    );

    log(
      'RESULTADO FINAL: 4/4 OK | stock 5 a 2 | 3 movimientos | 3 claves'
    );

  } finally {
    if (
      servidor &&
      servidor.proceso &&
      servidor.proceso.exitCode === null
    ) {
      servidor.proceso.kill();

      log('SERVIDOR TEMPORAL 3018: DETENIDO');
    }

    await db.end();
  }
}

ejecutar()
  .catch(e => {
    log('VERIFICACION DETENIDA:', e.message);

    log(
      'No repetir si hubo un fallo parcial sin revisar stock y movimientos.'
    );

    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync(
      REGISTRO,
      mensajes.join('\n') + '\n',
      'utf8'
    );

    console.log('REGISTRO:', REGISTRO);
  });
