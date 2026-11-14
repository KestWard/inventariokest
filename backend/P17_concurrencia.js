
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');

require('dotenv').config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

const bd = `asadero_p17_${crypto.randomBytes(4).toString('hex')}`;

let servidor;
let conexion;

async function principal() {
  try {

    // 1. CREAR BASE DE DATOS AISLADA

    conexion = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    const [[encontrada]] = await conexion.query(
      'SELECT COUNT(*) AS total FROM information_schema.schemata WHERE schema_name = ?',
      [bd]
    );

    if (Number(encontrada.total) !== 0) {
      throw new Error('La base de ensayo ya existe; se cancela la prueba.');
    }

    const esquemaBase = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8'
    );

    if (
      !esquemaBase.includes('asadero_inventario') ||
      /DROP\s+DATABASE/i.test(esquemaBase)
    ) {
      throw new Error(
        'El schema.sql no cumple las condiciones de aislamiento.'
      );
    }

    await conexion.query(
      esquemaBase.replace(/asadero_inventario/g, bd)
    );

    const [[activa]] = await conexion.query(
      'SELECT DATABASE() AS nombre'
    );

    if (activa.nombre !== bd) {
      throw new Error(
        'La conexion no esta usando la base de ensayo.'
      );
    }

    // 2. CREAR TABLA DE IDEMPOTENCIA

    await conexion.query(`
      CREATE TABLE IF NOT EXISTS solicitud_idempotente (
        clave VARCHAR(64) NOT NULL PRIMARY KEY,
        usuario_id INT NOT NULL,
        huella CHAR(64) NOT NULL,
        respuesta JSON NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const [proveedores] = await conexion.query(
      'SELECT id FROM proveedor LIMIT 1'
    );

    if (!proveedores.length) {
      throw new Error(
        'La base de ensayo no tiene proveedor.'
      );
    }

    // 3. INICIAR SERVIDOR AISLADO

    const libre = net.createServer();

    await new Promise((ok, mal) =>
      libre.once('error', mal).listen(0, '127.0.0.1', ok)
    );

    const puerto = libre.address().port;

    await new Promise((ok) =>
      libre.close(ok)
    );

    servidor = spawn(
      process.execPath,
      ['src/server.js'],
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
        'No inicio la API aislada.'
      );
    }

    // 4. FUNCION PARA ENVIAR SOLICITUDES

    async function enviar(ruta, datos, token, clave) {
      const respuesta = await fetch(
        url + ruta,
        {
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
          body: JSON.stringify(datos),
          signal: AbortSignal.timeout(15000)
        }
      );

      const respuestaTexto = await respuesta.text();

      let cuerpo;

      try {
        cuerpo = JSON.parse(respuestaTexto);
      } catch {
        cuerpo = respuestaTexto.slice(0, 300);
      }

      return {
        estado: respuesta.status,
        cuerpo
      };
    }

    // 5. CREAR ADMINISTRADOR TEMPORAL
    // No utiliza registro publico.
    // La cuenta existe solo en la base de ensayo.

    const email =
      `p17-${crypto.randomBytes(5).toString('hex')}@example.invalid`;

    const password =
      'P17-Aa9!' + crypto.randomBytes(16).toString('hex');

    try {
      execFileSync(
        process.execPath,
        [
          'src/crear-usuario.js',
          'Administrador temporal P17',
          email,
          password,
          'admin'
        ],
        {
          cwd: __dirname,
          env: {
            ...process.env,
            DB_NAME: bd
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15000
        }
      );

    } catch (err) {
      throw new Error(
        'No fue posible crear el administrador temporal: ' +
        String(err.stderr || err.message).trim()
      );
    }

    console.log(
      'Administrador de ensayo creado en ' + bd
    );

    // 6. INICIAR SESION

    const inicio = await enviar(
      '/api/auth/login',
      {
        email,
        password
      }
    );

    if (inicio.estado !== 200 || !inicio.cuerpo.token) {
      throw new Error(
        'Fallo el login: ' + JSON.stringify(inicio)
      );
    }

    const token = inicio.cuerpo.token;

    const vencimiento = new Date(
      Date.now() + 30 * 86400000
    ).toISOString().slice(0, 10);

    const resultados = [];

    // 7. EJECUTAR 50 RONDAS DE CONCURRENCIA

    for (let i = 1; i <= 50; i++) {

      // Crear un producto para cada ronda.

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
          `Producto ${i}: ` + JSON.stringify(producto)
        );
      }

      const productoId = producto.cuerpo.id;

      // Registrar 5 unidades.

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
          `Entrada ${i}: ` + JSON.stringify(entrada)
        );
      }

      // Enviar dos salidas simultaneas de 4 unidades.
      // Cada solicitud representa una operacion diferente.

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

      const estados = respuestas
        .map((r) => r.estado)
        .sort((a, b) => a - b);

      // Consultar directamente el saldo en MySQL.

      const [[stock]] = await conexion.query(
        `SELECT COALESCE(SUM(cantidad_actual),0) AS saldo
         FROM lote
         WHERE producto_id=?`,
        [productoId]
      );

      // Comprobar cuantos movimientos quedaron registrados.

      const [[mov]] = await conexion.query(
        `SELECT COUNT(*) AS total
         FROM movimiento
         WHERE producto_id=? AND tipo='S'`,
        [productoId]
      );

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
        resultado: correcto ? 'CORRECTO' : 'REVISAR'
      });

      if (!correcto || i % 10 === 0) {
        console.log(
          `Ronda ${i}/50 | HTTP ${estados.join('/')} ` +
          `| Saldo ${stock.saldo} ` +
          `| Movimientos ${mov.total} ` +
          `| ${correcto ? 'CORRECTO' : 'REVISAR'}`
        );
      }
    }

    // 8. CALCULAR RESULTADOS

    const correctas = resultados.filter(
      (r) => r.resultado === 'CORRECTO'
    ).length;

    // 9. IDENTIFICAR COMMIT DEL PROYECTO

    let commit = 'NO DISPONIBLE';

    try {
      commit = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000
        }
      ).trim();

    } catch {}

    const [[versionSql]] = await conexion.query(
      'SELECT VERSION() AS version'
    );

    const shaServidor = crypto
      .createHash('sha256')
      .update(
        fs.readFileSync(
          path.join(__dirname, 'src/server.js')
        )
      )
      .digest('hex');

    const shaScript = crypto
      .createHash('sha256')
      .update(fs.readFileSync(__filename))
      .digest('hex');

    // 10. PREPARAR INFORME DE LA PRUEBA

    const informe = [
      `PRUEBA P17 - ${new Date().toISOString()}`,
      `Commit del backend: ${commit}`,
      `Node.js: ${process.version}`,
      `Plataforma: ${process.platform}/${process.arch}`,
      `MySQL: ${versionSql.version}`,
      `SHA256 backend/src/server.js: ${shaServidor}`,
      `SHA256 script P17 local: ${shaScript}`,
      `Base aislada: ${bd}`,
      `Resultados: ${correctas}/50 correctos`,
      'Iteracion;HTTP;Saldo;Movimientos;Resultado',

      ...resultados.map(
        (r) =>
          `${r.iteracion};${r.estados};${r.saldo};` +
          `${r.movimientos};${r.resultado}`
      )
    ].join('\n');

    // 11. GUARDAR EVIDENCIA

    const archivo = path.join(
      __dirname,
      `P17_resultados_${bd}.txt`
    );

    fs.writeFileSync(
      archivo,
      informe,
      'utf8'
    );

    console.log(
      `\nRESULTADO FINAL P17: ${correctas}/50 correctas`
    );

    console.log(
      `Base de datos de ensayo: ${bd}`
    );

    console.log(
      `Evidencia guardada: ${archivo}`
    );

    if (correctas !== 50) {
      process.exitCode = 1;
    }

  } finally {

    // 12. CERRAR SERVIDOR Y CONEXION MYSQL

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
