
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

require('dotenv').config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

const BASE = 'asadero_p21_' + crypto.randomBytes(4).toString('hex');
const SECRETO = crypto.randomBytes(32).toString('hex');
const pausa = ms => new Promise(ok => setTimeout(ok, ms));

let db;
let servidor;

async function principal() {
  try {
    // 1. Preparar base de datos exclusiva para P21.

    db = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    const [[existe]] = await db.query(
      'SELECT COUNT(*) AS total FROM information_schema.schemata WHERE schema_name = ?',
      [BASE]
    );

    if (Number(existe.total) !== 0) {
      throw new Error(
        'La base de ensayo ya existe. Se cancela la prueba.'
      );
    }

    const esquema = fs.readFileSync(
      path.join(__dirname, 'schema.sql'),
      'utf8'
    );

    if (
      !esquema.includes('asadero_inventario') ||
      /DROP\s+DATABASE/i.test(esquema)
    ) {
      throw new Error(
        'schema.sql no supera la validacion de aislamiento.'
      );
    }

    await db.query(
      esquema.replace(/asadero_inventario/g, BASE)
    );

    const [[activa]] = await db.query(
      'SELECT DATABASE() AS nombre'
    );

    if (activa.nombre !== BASE) {
      throw new Error(
        'MySQL no esta utilizando la base aislada.'
      );
    }

    // 2. Crear cuentas exclusivamente en la base temporal.

    const codigo = crypto.randomBytes(5).toString('hex');

    const claveAdmin =
      'P21-Aa9!' + crypto.randomBytes(16).toString('hex');

    const claveEncargado =
      'P21-Bb9!' + crypto.randomBytes(16).toString('hex');

    const emailAdmin =
      `p21-admin-${codigo}@example.invalid`;

    const emailEncargado =
      `p21-enc-${codigo}@example.invalid`;

    function crearCuenta(nombre, correo, clave, rol) {
      try {
        execFileSync(
          process.execPath,
          [
            'src/crear-usuario.js',
            nombre,
            correo,
            clave,
            rol
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
        throw new Error(
          'No se pudo crear la cuenta de ensayo: ' +
          String(error.stderr || error.message).trim()
        );
      }
    }

    crearCuenta(
      'Administrador P21',
      emailAdmin,
      claveAdmin,
      'admin'
    );

    // El rol encargado se usa solo para comprobar
    // que un usuario sin autorizacion sea rechazado.

    crearCuenta(
      'Encargado P21',
      emailEncargado,
      claveEncargado,
      'encargado'
    );

    const [[admin]] = await db.query(
      'SELECT id, rol FROM usuario WHERE email = ?',
      [emailAdmin]
    );

    const [[encargado]] = await db.query(
      'SELECT id, rol FROM usuario WHERE email = ?',
      [emailEncargado]
    );

    if (
      !admin ||
      admin.rol !== 'admin' ||
      !encargado ||
      encargado.rol !== 'encargado'
    ) {
      throw new Error(
        'No se confirmaron los roles en la base de ensayo.'
      );
    }

    // 3. Iniciar API aislada con secreto JWT temporal.

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
          JWT_SECRET: SECRETO
        },
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );

    servidor.stderr.on('data', dato =>
      process.stderr.write(dato)
    );

    const API = `http://127.0.0.1:${puerto}`;

    async function solicitar(
      ruta,
      metodo = 'GET',
      token,
      cuerpo
    ) {
      const respuesta = await fetch(
        API + ruta,
        {
          method: metodo,
          headers: {
            ...(cuerpo
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...(token
              ? { Authorization: `Bearer ${token}` }
              : {})
          },
          ...(cuerpo
            ? { body: JSON.stringify(cuerpo) }
            : {}),
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

    // Esperar a que la API aislada este disponible.

    let disponible = false;

    for (let n = 0; n < 50; n++) {
      try {
        const respuesta = await solicitar(
          '/api/productos'
        );

        if (respuesta.estado === 401) {
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

    // 4. Ejecutar escenarios P21.

    const resultados = [];

    function registrar(
      caso,
      esperado,
      observado,
      grupo
    ) {
      const correcto = esperado === observado;

      resultados.push({
        caso,
        esperado,
        observado,
        correcto,
        grupo
      });

      console.log(
        `${caso}: HTTP ${observado} ` +
        `(esperado ${esperado}) - ` +
        (correcto ? 'CORRECTO' : 'REVISAR')
      );
    }

    // P21-01: Solicitud sin token.

    const sinToken = await solicitar(
      '/api/productos'
    );

    registrar(
      'P21-01 Sin token',
      401,
      sinToken.estado,
      'P21'
    );

    // P21-02: Token invalido.

    const invalido = await solicitar(
      '/api/productos',
      'GET',
      'token.no.valido'
    );

    registrar(
      'P21-02 Token invalido',
      401,
      invalido.estado,
      'P21'
    );

    // P21-03: Token expirado.

    const ahora = Math.floor(Date.now() / 1000);

    const expirado = jwt.sign(
      {
        id: Number(admin.id),
        rol: 'admin',
        iat: ahora - 3600,
        exp: ahora - 60
      },
      SECRETO
    );

    const vencido = await solicitar(
      '/api/productos',
      'GET',
      expirado
    );

    registrar(
      'P21-03 Token expirado',
      401,
      vencido.estado,
      'P21'
    );

    // 5. Controles complementarios de autorizacion.

    // Comprobar que encargado no pueda consultar
    // una ruta exclusiva del administrador.

    const tokenEncargado = jwt.sign(
      {
        id: Number(encargado.id),
        rol: 'encargado'
      },
      SECRETO,
      { expiresIn: '1h' }
    );

    const sinPermiso = await solicitar(
      '/api/productos',
      'GET',
      tokenEncargado
    );

    registrar(
      'Acceso rol encargado',
      403,
      sinPermiso.estado,
      'ACCESO'
    );

    // Login del administrador.

    const login = await solicitar(
      '/api/auth/login',
      'POST',
      undefined,
      {
        email: emailAdmin,
        password: claveAdmin
      }
    );

    registrar(
      'Login administrador',
      200,
      login.estado,
      'ACCESO'
    );

    // Acceso autorizado del administrador.

    if (
      login.estado === 200 &&
      login.datos &&
      login.datos.token
    ) {
      const autorizado = await solicitar(
        '/api/productos',
        'GET',
        login.datos.token
      );

      registrar(
        'Consulta administrador',
        200,
        autorizado.estado,
        'ACCESO'
      );
    } else {
      registrar(
        'Consulta administrador',
        200,
        0,
        'ACCESO'
      );
    }

    // Verificar que el registro publico este bloqueado.

    const registroPublico = await solicitar(
      '/api/auth/register',
      'POST',
      undefined,
      {
        nombre: 'Registro rechazado P21',
        email:
          `p21-registro-${codigo}@example.invalid`,
        password: claveAdmin
      }
    );

    registrar(
      'Registro publico bloqueado',
      403,
      registroPublico.estado,
      'ACCESO'
    );

    // 6. Registrar commit y entorno de prueba.

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

    const [[versionSql]] = await db.query(
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

    const hashPrueba = crypto
      .createHash('sha256')
      .update(
        fs.readFileSync(__filename)
      )
      .digest('hex');

    // 7. Calcular resultados.

    const p21 = resultados.filter(
      r => r.grupo === 'P21'
    );

    const acceso = resultados.filter(
      r => r.grupo === 'ACCESO'
    );

    const aprobadoP21 = p21.filter(
      r => r.correcto
    ).length;

    const aprobadoAcceso = acceso.filter(
      r => r.correcto
    ).length;

    const informe = [
      'P21 - SEGURIDAD DE AUTENTICACION Y AUTORIZACION',
      `Fecha UTC: ${new Date().toISOString()}`,
      `Commit de referencia: ${commit}`,
      `Node.js: ${process.version}`,
      `Plataforma: ${process.platform}/${process.arch}`,
      `MySQL: ${versionSql.version}`,
      `SHA256 backend/src/server.js: ${hashServidor}`,
      `SHA256 script P21 local: ${hashPrueba}`,
      `Base aislada: ${BASE}`,

      ...resultados.map(r =>
        `${r.caso}: HTTP ${r.observado}; ` +
        `esperado ${r.esperado}; ` +
        (r.correcto ? 'CORRECTO' : 'REVISAR')
      ),

      `RESULTADO FINAL P21: ` +
        `${aprobadoP21}/${p21.length} CORRECTAS`,

      `CONTROLES COMPLEMENTARIOS: ` +
        `${aprobadoAcceso}/${acceso.length} CORRECTOS`,

      `ESTADO: ` +
        (
          resultados.every(r => r.correcto)
            ? 'VERIFICADO'
            : 'REVISAR'
        )
    ].join('\n');

    // 8. Guardar evidencia.

    const archivo = path.join(
      __dirname,
      `P21_resultados_${BASE}.txt`
    );

    fs.writeFileSync(
      archivo,
      informe,
      'utf8'
    );

    console.log('\n' + informe);

    console.log(
      'Evidencia guardada: ' + archivo
    );

    if (!resultados.every(r => r.correcto)) {
      process.exitCode = 1;
    }

  } finally {

    // 9. Cerrar servidor y conexion MySQL.

    if (servidor) {
      servidor.kill();
    }

    if (db) {
      await db.end();
    }
  }
}

principal().catch(error => {
  console.error(
    'ERROR P21:',
    error.message
  );

  process.exitCode = 1;
});
