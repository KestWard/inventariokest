
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');

// Cargar la configuración local sin mostrar credenciales.
require('dotenv').config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

// Nombre aleatorio para una base de datos de ensayo.
const BASE = 'asadero_p16_' +
  crypto.randomBytes(4).toString('hex');

const pausa = ms =>
  new Promise(ok => setTimeout(ok, ms));

let db;
let servidor;
let triggerCreado = false;

async function principal() {
  try {

    // 1. CONECTAR A MYSQL
    // La prueba utiliza una base independiente.

    db = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    // Impedir que se reutilice una base existente.
    const [[yaExiste]] = await db.query(
      'SELECT COUNT(*) AS total FROM information_schema.schemata WHERE schema_name = ?',
      [BASE]
    );

    if (Number(yaExiste.total) !== 0) {
      throw new Error(
        'La base temporal ya existe; se cancela el ensayo.'
      );
    }

    const sql = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8'
    );

    if (!sql.includes('asadero_inventario')) {
      throw new Error(
        'No se reconoce la base declarada en schema.sql.'
      );
    }

    // Crear las tablas en la base temporal.
    await db.query(
      sql.replace(/asadero_inventario/g, BASE)
    );

    // Confirmar que la conexión apunta a la base aislada.
    const [[actual]] = await db.query(
      'SELECT DATABASE() AS nombre'
    );

    if (actual.nombre !== BASE) {
      throw new Error(
        'No se pudo confirmar el aislamiento de MySQL.'
      );
    }

    // 2. CREAR TABLA DE IDEMPOTENCIA

    await db.query(`
      CREATE TABLE IF NOT EXISTS solicitud_idempotente (
        clave VARCHAR(64) NOT NULL PRIMARY KEY,
        usuario_id INT NOT NULL,
        huella CHAR(64) NOT NULL,
        respuesta JSON NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const [[proveedor]] = await db.query(
      'SELECT id FROM proveedor LIMIT 1'
    );

    if (!proveedor) {
      throw new Error(
        'La base de ensayo no tiene proveedor.'
      );
    }

    // 3. INICIAR SERVIDOR AISLADO

    const libre = net.createServer();

    await new Promise((ok, fallo) => {
      libre.once('error', fallo);
      libre.listen(0, '127.0.0.1', ok);
    });

    const puerto = libre.address().port;

    await new Promise(ok =>
      libre.close(ok)
    );

    servidor = spawn(
      process.execPath,
      ['src/server.js'],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          DB_NAME: BASE,
          PORT: String(puerto),
          JWT_SECRET: crypto
            .randomBytes(32)
            .toString('hex')
        },
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );

    servidor.stderr.on('data', datos =>
      process.stderr.write(datos)
    );

    const API = `http://127.0.0.1:${puerto}`;

    let disponible = false;

    for (let n = 0; n < 50; n++) {
      try {
        const respuesta = await fetch(
          API + '/api/productos'
        );

        if (respuesta.status === 401) {
          disponible = true;
          break;
        }
      } catch {}

      await pausa(200);
    }

    if (!disponible) {
      throw new Error(
        'No inicio la API aislada.'
      );
    }

    // 4. FUNCIÓN PARA ENVIAR SOLICITUDES

    async function enviar(
      ruta,
      cuerpo,
      token,
      clave
    ) {
      const respuesta = await fetch(
        API + ruta,
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
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(15000)
        }
      );

      const texto = await respuesta.text();

      let datos;

      try {
        datos = JSON.parse(texto);
      } catch {
        datos = texto.slice(0, 150);
      }

      return {
        estado: respuesta.status,
        datos
      };
    }

    // 5. CREAR ADMINISTRADOR DE ENSAYO
    // No se utiliza el registro público.
    // La cuenta se crea únicamente en la base aislada.

    const codigo = crypto
      .randomBytes(5)
      .toString('hex');

    const correo =
      `p16-${codigo}@example.invalid`;

    const password =
      'P16-Aa9!' +
      crypto.randomBytes(16).toString('hex');

    try {
      execFileSync(
        process.execPath,
        [
          'src/crear-usuario.js',
          'Ensayo rollback P16',
          correo,
          password,
          'admin'
        ],
        {
          cwd: __dirname,
          env: {
            ...process.env,
            DB_NAME: BASE
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15000
        }
      );
    } catch (error) {
      const detalle = error.stderr
        ? String(error.stderr).trim()
        : error.message;

      throw new Error(
        'No se pudo crear el administrador de ensayo: ' +
        detalle
      );
    }

    console.log(
      'Administrador temporal creado en base de ensayo: ' +
      BASE
    );

    // AUTENTICAR ADMINISTRADOR

    const login = await enviar(
      '/api/auth/login',
      {
        email: correo,
        password
      }
    );

    if (
      login.estado !== 200 ||
      !login.datos.token
    ) {
      throw new Error(
        'Ingreso de prueba: ' +
        JSON.stringify(login)
      );
    }

    const token = login.datos.token;

    // 6. CREAR PRODUCTO DE ENSAYO

    const producto = await enviar(
      '/api/productos',
      {
        nombre: 'Producto rollback P16 ' + codigo,
        unidad: 'und',
        consumo_diario: 0,
        dias_entrega: 1,
        stock_minimo: 0
      },
      token
    );

    if (producto.estado !== 201) {
      throw new Error(
        'Producto de prueba: ' +
        JSON.stringify(producto)
      );
    }

    const id = producto.datos.id;

    const vence = new Date(
      Date.now() + 30 * 86400000
    ).toISOString().slice(0, 10);

    // 7. REGISTRAR CINCO UNIDADES

    const entrada = await enviar(
      '/api/lotes',
      {
        producto_id: id,
        proveedor_id: proveedor.id,
        cantidad: 5,
        costo_unitario: 1,
        fecha_vencimiento: vence
      },
      token
    );

    if (entrada.estado !== 201) {
      throw new Error(
        'Lote de prueba: ' +
        JSON.stringify(entrada)
      );
    }

    // 8. CONSULTAR EXISTENCIAS Y MOVIMIENTOS

    async function estado() {
      const [[saldo]] = await db.query(
        `SELECT COALESCE(SUM(cantidad_actual), 0)
         AS total
         FROM lote
         WHERE producto_id = ?`,
        [id]
      );

      const [[mov]] = await db.query(
        `SELECT COUNT(*) AS total
         FROM movimiento
         WHERE producto_id = ?
         AND tipo = 'S'`,
        [id]
      );

      return {
        saldo: Number(saldo.total),
        movimientos: Number(mov.total)
      };
    }

    const inicial = await estado();

    if (
      inicial.saldo !== 5 ||
      inicial.movimientos !== 0
    ) {
      throw new Error(
        'Las condiciones iniciales son incorrectas.'
      );
    }

    // 9. PROVOCAR UN ERROR CONTROLADO
    // El trigger se crea solo en la base aislada.
    // Esto permite verificar ROLLBACK.

    await db.query(`
      CREATE TRIGGER p16_fallo_controlado
      BEFORE INSERT ON movimiento
      FOR EACH ROW
      SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT =
        'P16 fallo de MySQL provocado para probar ROLLBACK'
    `);

    triggerCreado = true;

    const claveFallida = crypto.randomUUID();

    const fallida = await enviar(
      '/api/salidas',
      {
        producto_id: id,
        cantidad: 1,
        observacion: 'P16: fallo controlado'
      },
      token,
      claveFallida
    );

    // 10. VERIFICAR ROLLBACK

    const trasFallo = await estado();

    const [[marca]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM solicitud_idempotente
       WHERE clave = ?`,
      [claveFallida]
    );

    const rollbackCorrecto =
      fallida.estado >= 500 &&
      trasFallo.saldo === 5 &&
      trasFallo.movimientos === 0 &&
      Number(marca.total) === 0;

    // 11. RETIRAR EL FALLO ARTIFICIAL

    await db.query(
      'DROP TRIGGER IF EXISTS p16_fallo_controlado'
    );

    triggerCreado = false;

    // 12. REGISTRAR UNA SALIDA NORMAL
    // Esto permite verificar COMMIT.

    const correcta = await enviar(
      '/api/salidas',
      {
        producto_id: id,
        cantidad: 1,
        observacion: 'P16: confirmacion tras rollback'
      },
      token,
      crypto.randomUUID()
    );

    const final = await estado();

    const commitCorrecto =
      correcta.estado === 200 &&
      final.saldo === 4 &&
      final.movimientos === 1;

    // 13. REGISTRAR VERSIÓN Y ENTORNO

    let commit = 'NO DISPONIBLE';

    try {
      commit = execFileSync(
        'git',
        ['rev-parse', 'HEAD'],
        {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore']
        }
      ).trim();
    } catch {}

    const [[mysqlVersion]] = await db.query(
      'SELECT VERSION() AS version'
    );

    const hashServidor = crypto
      .createHash('sha256')
      .update(
        fs.readFileSync(
          path.join(__dirname, 'src/server.js')
        )
      )
      .digest('hex');

    // 14. PREPARAR RESUMEN DE RESULTADOS

    const resumen = [
      'Fecha de ejecucion (UTC): ' +
        new Date().toISOString(),

      'Commit de referencia: ' + commit,

      'Node.js: ' + process.version,

      'Plataforma: ' +
        process.platform + ' / ' + process.arch,

      'MySQL: ' + mysqlVersion.version,

      'SHA256 backend/src/server.js: ' + hashServidor,

      'P16 - ROLLBACK REAL Y COMMIT EN MYSQL',

      'Base independiente: ' + BASE,

      'Estado inicial: 5 unidades, 0 salidas',

      'HTTP con fallo provocado: ' + fallida.estado,

      'Despues de ROLLBACK: saldo ' +
        trasFallo.saldo +
        ', movimientos ' + trasFallo.movimientos,

      'Clave fallida persistida: ' +
        Number(marca.total),

      'ROLLBACK: ' +
        (rollbackCorrecto ? 'VERIFICADO' : 'REVISAR'),

      'HTTP salida normal posterior: ' +
        correcta.estado,

      'Despues de COMMIT: saldo ' +
        final.saldo +
        ', movimientos ' + final.movimientos,

      'COMMIT: ' +
        (commitCorrecto ? 'VERIFICADO' : 'REVISAR'),

      'RESULTADO FINAL P16: ' +
        (
          rollbackCorrecto && commitCorrecto
            ? '2/2 CORRECTAS'
            : 'REVISAR'
        )
    ].join('\n');

    console.log('\n' + resumen);

    // 15. GUARDAR EVIDENCIA

    const archivo = path.join(
      __dirname,
      `P16_resultados_${BASE}.txt`
    );

    fs.writeFileSync(
      archivo,
      resumen,
      'utf8'
    );

    console.log(
      'Evidencia guardada: ' + archivo
    );

    if (!rollbackCorrecto || !commitCorrecto) {
      process.exitCode = 1;
    }

  } finally {

    // 16. LIMPIAR TRIGGER Y CERRAR SERVIDOR

    if (triggerCreado && db) {
      try {
        await db.query(
          'DROP TRIGGER IF EXISTS p16_fallo_controlado'
        );
      } catch (err) {
        console.error(
          'Aviso limpieza trigger:',
          err.message
        );
      }
    }

    if (servidor) {
      servidor.kill();
    }

    if (db) {
      await db.end();
    }
  }
}

principal().catch(err => {
  console.error('ERROR P16:', err.message);
  process.exitCode = 1;
});
