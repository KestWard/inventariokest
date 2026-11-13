
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const mysql = require('mysql2/promise');

const BASE = 'asadero_p20_' + crypto.randomBytes(4).toString('hex');
const REPETICIONES = 30;
const esperar = ms => new Promise(ok => setTimeout(ok, ms));

let db;
let servidor;

function estadisticas(datos) {
  const ordenados = [...datos].sort((a, b) => a - b);

  return {
    promedio: datos.reduce((a, b) => a + b, 0) / datos.length,
    minimo: ordenados[0],
    maximo: ordenados[ordenados.length - 1],
    p95: ordenados[Math.ceil(datos.length * 0.95) - 1]
  };
}

async function ejecutar() {
  try {
    // 1. Crear una base independiente.
    db = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    const original = fs.readFileSync(
      path.join(__dirname, 'schema.sql'), 'utf8'
    );

    if (!original.includes('asadero_inventario')) {
      throw new Error('No se reconoce el esquema de la base.');
    }

    const esquema = original.replace(/asadero_inventario/g, BASE);
    await db.query(esquema);

    const [[verificacion]] = await db.query(
      'SELECT DATABASE() AS nombre'
    );

    if (verificacion.nombre !== BASE) {
      throw new Error('No se confirmó la base de ensayo.');
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS solicitud_idempotente (
        clave VARCHAR(64) NOT NULL PRIMARY KEY,
        usuario_id INT NOT NULL,
        huella CHAR(64) NOT NULL,
        respuesta JSON NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const [proveedores] = await db.query(
      'SELECT id FROM proveedor LIMIT 1'
    );

    if (!proveedores.length) {
      throw new Error('Falta un proveedor de ensayo.');
    }

    // 2. Iniciar una API aislada en un puerto disponible.
    const libre = net.createServer();

    await new Promise((ok, error) => {
      libre.once('error', error);
      libre.listen(0, '127.0.0.1', ok);
    });

    const puerto = libre.address().port;
    await new Promise(ok => libre.close(ok));

    servidor = spawn(process.execPath, ['src/server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        DB_NAME: BASE,
        PORT: String(puerto),
        JWT_SECRET: crypto.randomBytes(32).toString('hex')
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });

    servidor.stderr.on('data', dato => {
      process.stderr.write(dato);
    });

    const API = `http://127.0.0.1:${puerto}`;

    async function solicitar(ruta, datos, token, clave) {
      const inicio = performance.now();

      const respuesta = await fetch(API + ruta, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(clave ? { 'Idempotency-Key': clave } : {})
        },
        body: JSON.stringify(datos),
        signal: AbortSignal.timeout(15000)
      });

      const cuerpo = await respuesta.json();
      const tiempo = performance.now() - inicio;

      return { estado: respuesta.status, cuerpo, tiempo };
    }

    let activo = false;

    for (let i = 0; i < 50; i++) {
      try {
        const respuesta = await fetch(API + '/api/productos');
        if (respuesta.status === 401) {
          activo = true;
          break;
        }
      } catch {}

      await esperar(200);
    }

    if (!activo) {
      throw new Error('No inició la API de ensayo.');
    }

    // 3. Registrar un usuario de ensayo.
    const codigo = crypto.randomBytes(5).toString('hex');
    const email = `p20-${codigo}@example.invalid`;
    const password = crypto.randomBytes(16).toString('hex');

    const registro = await solicitar('/api/auth/register', {
      nombre: 'Usuario prueba P20',
      email,
      password
    });

    if (registro.estado !== 201) {
      throw new Error('No se pudo crear el usuario de ensayo.');
    }

    const login = await solicitar('/api/auth/login', {
      email,
      password
    });

    if (login.estado !== 200) {
      throw new Error('No se pudo iniciar sesión.');
    }

    const token = login.cuerpo.token;

    const vencimiento = new Date(
      Date.now() + 30 * 86400000
    ).toISOString().slice(0, 10);

    const tiemposEntrada = [];
    const tiemposSalida = [];
    const detalle = [];

    console.log('\nP20 - RENDIMIENTO DE ENTRADAS Y SALIDAS');
    console.log('Base aislada:', BASE);
    console.log('Repeticiones:', REPETICIONES);

    // 4. Ejecutar 30 escenarios.
    for (let i = 1; i <= REPETICIONES; i++) {
      const producto = await solicitar('/api/productos', {
        nombre: `Producto P20 ${codigo} ${i}`,
        unidad: 'und',
        consumo_diario: 0,
        dias_entrega: 1,
        stock_minimo: 0
      }, token);

      if (producto.estado !== 201) {
        throw new Error(`Error creando producto ${i}`);
      }

      const productoId = producto.cuerpo.id;

      // Medir tiempo de entrada.
      const entrada = await solicitar('/api/lotes', {
        producto_id: productoId,
        proveedor_id: proveedores[0].id,
        cantidad: 5,
        costo_unitario: 1,
        fecha_vencimiento: vencimiento
      }, token);

      if (entrada.estado !== 201) {
        throw new Error(`Error de entrada en escenario ${i}`);
      }

      // Medir tiempo de salida.
      const salida = await solicitar('/api/salidas', {
        producto_id: productoId,
        cantidad: 1,
        observacion: 'Prueba P20'
      }, token, crypto.randomUUID());

      if (salida.estado !== 200) {
        throw new Error(`Error de salida en escenario ${i}`);
      }

      const [[stock]] = await db.query(
        `SELECT COALESCE(SUM(cantidad_actual), 0) AS saldo
         FROM lote WHERE producto_id = ?`,
        [productoId]
      );

      if (Number(stock.saldo) !== 4) {
        throw new Error(`Saldo inesperado en escenario ${i}`);
      }

      tiemposEntrada.push(entrada.tiempo);
      tiemposSalida.push(salida.tiempo);

      detalle.push({
        repeticion: i,
        entrada: entrada.tiempo,
        salida: salida.tiempo,
        saldo: stock.saldo
      });

      if (i % 10 === 0) {
        console.log(`Completadas ${i}/${REPETICIONES} repeticiones`);
      }
    }

    // 5. Calcular indicadores.
    const e = estadisticas(tiemposEntrada);
    const s = estadisticas(tiemposSalida);
    const mostrar = numero => numero.toFixed(2);

    const resumen = [
      'P20 - RESULTADO FINAL',
      `Base de ensayo: ${BASE}`,
      `Entradas exitosas: ${tiemposEntrada.length}/30`,
      `Salidas exitosas: ${tiemposSalida.length}/30`,
      `Entrada promedio: ${mostrar(e.promedio)} ms`,
      `Entrada P95: ${mostrar(e.p95)} ms`,
      `Entrada minima: ${mostrar(e.minimo)} ms`,
      `Entrada maxima: ${mostrar(e.maximo)} ms`,
      `Salida promedio: ${mostrar(s.promedio)} ms`,
      `Salida P95: ${mostrar(s.p95)} ms`,
      `Salida minima: ${mostrar(s.minimo)} ms`,
      `Salida maxima: ${mostrar(s.maximo)} ms`,
      'ESTADO: EJECUCION SATISFACTORIA'
    ].join('\n');

    console.log('\n' + resumen);

    // 6. Guardar evidencia.
    const archivo = path.join(
      __dirname,
      `P20_resultados_${BASE}.txt`
    );

    const contenido = [
      resumen,
      '',
      'Repeticion;Entrada_ms;Salida_ms;Saldo_final',
      ...detalle.map(d =>
        `${d.repeticion};${mostrar(d.entrada)};` +
        `${mostrar(d.salida)};${d.saldo}`
      )
    ].join('\n');

    fs.writeFileSync(archivo, contenido, 'utf8');
    console.log('Evidencia guardada:', archivo);

  } finally {
    if (servidor) servidor.kill();
    if (db) await db.end();
  }
}

ejecutar().catch(error => {
  console.error('ERROR P20:', error.message);
  process.exitCode = 1;
});

