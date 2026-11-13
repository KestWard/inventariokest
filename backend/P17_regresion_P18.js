
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Base independiente para la prueba de regresion
const bd = `asadero_p17_reg_${crypto.randomBytes(4).toString('hex')}`;

let servidor;
let conexion;

async function principal() {
  try {

    // 1. CONEXION A MYSQL

    conexion = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    // 2. CREAR BASE DE DATOS DE ENSAYO

    const esquema = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8'
    ).replace(/asadero_inventario/g, bd);

    await conexion.query(esquema);

    console.log('Base de ensayo creada:', bd);

    // 3. PREPARAR TABLA DE IDEMPOTENCIA

    await conexion.query(`
      CREATE TABLE IF NOT EXISTS solicitud_idempotente (
        clave VARCHAR(64) NOT NULL PRIMARY KEY,
        usuario_id INT NOT NULL,
        huella CHAR(64) NOT NULL,
        respuesta JSON NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    console.log('Tabla de idempotencia preparada.');

    // 4. VERIFICAR PROVEEDOR DE ENSAYO

    const [proveedores] = await conexion.query(
      'SELECT id FROM proveedor LIMIT 1'
    );

    if (!proveedores.length) {
      throw new Error(
        'La base de ensayo no tiene proveedor.'
      );
    }

    // 5. OBTENER UN PUERTO LIBRE

    const libre = net.createServer();

    await new Promise((ok, mal) =>
      libre.once('error', mal).listen(
        0,
        '127.0.0.1',
        ok
      )
    );

    const puerto = libre.address().port;

    await new Promise((ok) => libre.close(ok));

    // 6. INICIAR SERVIDOR CORREGIDO DEL LABORATORIO

    servidor = spawn(
      process.execPath,
      ['_laboratorio_P18/server.js'],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          DB_NAME: bd,
          PORT: String(puerto),
          JWT_SECRET: crypto.randomBytes(32).toString('hex')
        },
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );

    servidor.stderr.on('data', (datos) =>
      process.stderr.write(datos)
    );

    const url = `http://127.0.0.1:${puerto}`;

    let listo = false;

    for (let n = 0; n < 50; n++) {
      try {
        const respuesta = await fetch(
          `${url}/api/productos`
        );

        if (respuesta.status === 401) {
          listo = true;
          break;
        }
      } catch {}

      await pausa(200);
    }

    if (!listo) {
      throw new Error(
        'No inicio la API corregida del laboratorio.'
      );
    }

    console.log('API corregida iniciada.');
    console.log('Puerto de ensayo:', puerto);

    // 7. FUNCION PARA ENVIAR SOLICITUDES HTTP
    // Permite agregar una clave unica de idempotencia.

    async function enviar(
      ruta,
      datos,
      token,
      clave = null
    ) {
      const respuesta = await fetch(url + ruta, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token
            ? { Authorization: `Bearer ${token}` }
            : {}),
          ...(clave
            ? { 'Idempotency-Key': clave }
            : {})
        },
        body: JSON.stringify(datos)
      });

      return {
        estado: respuesta.status,
        cuerpo: await respuesta.json()
      };
    }

    // 8. REGISTRAR USUARIO DE ENSAYO

    const email =
      `p17-${crypto.randomBytes(5).toString('hex')}@example.invalid`;

    const password =
      crypto.randomBytes(16).toString('hex');

    const registro = await enviar(
      '/api/auth/register',
      {
        nombre: 'Ensayo P17',
        email,
        password
      }
    );

    if (registro.estado !== 201) {
      throw new Error(
        'Fallo el registro: ' +
        JSON.stringify(registro)
      );
    }

    // 9. INICIAR SESION

    const inicio = await enviar(
      '/api/auth/login',
      {
        email,
        password
      }
    );

    if (inicio.estado !== 200) {
      throw new Error(
        'Fallo el login: ' +
        JSON.stringify(inicio)
      );
    }

    const token = inicio.cuerpo.token;

    const vencimiento = new Date(
      Date.now() + 30 * 86400000
    ).toISOString().slice(0, 10);

    // 10. EJECUTAR 50 REPETICIONES

    const resultados = [];

    console.log('\n================================');
    console.log('P17 - REGRESION DESPUES DE P18');
    console.log('================================');
    console.log('Repeticiones programadas: 50');
    console.log('Existencias iniciales por prueba: 5');
    console.log('Dos solicitudes simultaneas de 4 unidades');
    console.log('Cada solicitud utiliza un UUID diferente.\n');

    for (let i = 1; i <= 50; i++) {

      // Crear un producto independiente por repeticion

      const producto = await enviar(
        '/api/productos',
        {
          nombre: `Producto P17 ${bd} ${i}`,
          unidad: 'und',
          consumo_diario: 0,
          dias_entrega: 1,
          stock_minimo: 0
        },
        token
      );

      if (producto.estado !== 201) {
        throw new Error(
          `Fallo crear producto ${i}: ` +
          JSON.stringify(producto)
        );
      }

      const productoId = producto.cuerpo.id;

      // Registrar entrada de cinco unidades

      const entrada = await enviar(
        '/api/lotes',
        {
          producto_id: productoId,
          proveedor_id: proveedores[0].id,
          cantidad: 5,
          costo_unitario: 1,
          fecha_vencimiento: vencimiento
        },
        token
      );

      if (entrada.estado !== 201) {
        throw new Error(
          `Fallo crear lote ${i}: ` +
          JSON.stringify(entrada)
        );
      }

      // Dos operaciones independientes y simultaneas.
      // IMPORTANTE: cada una lleva una clave UUID distinta.

      const respuestas = await Promise.all([
        enviar(
          '/api/salidas',
          {
            producto_id: productoId,
            cantidad: 4,
            observacion: 'P17 A'
          },
          token,
          crypto.randomUUID()
        ),

        enviar(
          '/api/salidas',
          {
            producto_id: productoId,
            cantidad: 4,
            observacion: 'P17 B'
          },
          token,
          crypto.randomUUID()
        )
      ]);

      // Ordenar los codigos HTTP recibidos

      const estados = respuestas
        .map((r) => r.estado)
        .sort((a, b) => a - b);

      // Comprobar saldo directamente en MySQL

      const [[stock]] = await conexion.query(
        `SELECT COALESCE(
            SUM(cantidad_actual), 0
          ) AS saldo
         FROM lote
         WHERE producto_id = ?`,
        [productoId]
      );

      // Comprobar movimientos registrados

      const [[mov]] = await conexion.query(
        `SELECT COUNT(*) AS total
         FROM movimiento
         WHERE producto_id = ?
         AND tipo = 'S'`,
        [productoId]
      );

      // Resultado esperado:
      // Una solicitud HTTP 200
      // Una solicitud HTTP 409
      // Saldo final de una unidad
      // Un unico movimiento de salida

      const correcto =
        estados[0] === 200 &&
        estados[1] === 409 &&
        Number(stock.saldo) === 1 &&
        Number(mov.total) === 1;

      resultados.push({
        iteracion: i,
        estados: estados.join('/'),
        saldo: stock.saldo,
        movimientos: mov.total,
        resultado: correcto
          ? 'CORRECTO'
          : 'REVISAR'
      });

      if (!correcto || i % 10 === 0) {
        console.log(
          `Ronda ${i}/50` +
          ` | HTTP ${estados.join('/')}` +
          ` | Saldo ${stock.saldo}` +
          ` | Movimientos ${mov.total}` +
          ` | ${correcto ? 'CORRECTO' : 'REVISAR'}`
        );
      }
    }

    // 11. RESUMEN FINAL

    const correctas = resultados.filter(
      (r) => r.resultado === 'CORRECTO'
    ).length;

    const informe = [
      'P17 - PRUEBA DE REGRESION DESPUES DE P18',
      `Fecha: ${new Date().toISOString()}`,
      `Base aislada: ${bd}`,
      'Servidor: backend corregido de laboratorio',
      'Operaciones: 2 salidas independientes con UUID distintos',
      `Resultados: ${correctas}/50 correctos`,
      '',
      'Iteracion;HTTP;Saldo;Movimientos;Resultado',
      ...resultados.map(
        (r) =>
          `${r.iteracion};${r.estados};${r.saldo};` +
          `${r.movimientos};${r.resultado}`
      )
    ].join('\n');

    // 12. GUARDAR EVIDENCIA

    const archivo = path.join(
      __dirname,
      `P17_regresion_resultados_${bd}.txt`
    );

    fs.writeFileSync(
      archivo,
      informe,
      'utf8'
    );

    console.log('\n================================');
    console.log('RESULTADO FINAL P17 - REGRESION');
    console.log('================================');

    console.log(
      `Comprobaciones satisfactorias: ${correctas}/50`
    );

    console.log(
      'ESTADO:',
      correctas === 50
        ? 'REGRESION VERIFICADA'
        : 'EXISTEN RESULTADOS POR REVISAR'
    );

    console.log('Base de datos de ensayo:', bd);
    console.log('Evidencia guardada:', archivo);

    if (correctas !== 50) {
      process.exitCode = 1;
    }

  } finally {

    // Detener solamente el servidor de ensayo

    if (servidor) {
      servidor.kill();
    }

    if (conexion) {
      await conexion.end();
    }
  }
}

principal().catch((error) => {
  console.error('ERROR P17:', error.message);
  process.exitCode = 1;
});
