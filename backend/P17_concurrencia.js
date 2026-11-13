'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
const bd = `asadero_p17_${crypto.randomBytes(4).toString('hex')}`;
let servidor;
let conexion;

async function principal() {
  try {
    conexion = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      multipleStatements: true
    });

    const esquema = fs.readFileSync(
      path.join(__dirname, 'schema.sql'), 'utf8'
    ).replace(/asadero_inventario/g, bd);

    await conexion.query(esquema);

    const [proveedores] = await conexion.query(
      'SELECT id FROM proveedor LIMIT 1'
    );

    if (!proveedores.length) {
      throw new Error('La base de ensayo no tiene proveedor');
    }

    const libre = net.createServer();
    await new Promise((ok, mal) =>
      libre.once('error', mal).listen(0, '127.0.0.1', ok)
    );
    const puerto = libre.address().port;
    await new Promise((ok) => libre.close(ok));

    servidor = spawn(process.execPath, ['src/server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        DB_NAME: bd,
        PORT: String(puerto),
        JWT_SECRET: crypto.randomBytes(32).toString('hex')
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });

    servidor.stderr.on('data', (datos) =>
      process.stderr.write(datos)
    );

    const url = `http://127.0.0.1:${puerto}`;
    let listo = false;

    for (let n = 0; n < 50; n++) {
      try {
        const respuesta = await fetch(`${url}/api/productos`);
        if (respuesta.status === 401) {
          listo = true;
          break;
        }
      } catch {}
      await pausa(200);
    }

    if (!listo) {
      throw new Error('No inicio la API aislada');
    }

    async function enviar(ruta, datos, token) {
      const respuesta = await fetch(url + ruta, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token
            ? { Authorization: `Bearer ${token}` }
            : {})
        },
        body: JSON.stringify(datos)
      });

      return {
        estado: respuesta.status,
        cuerpo: await respuesta.json()
      };
    }

    const email =
      `p17-${crypto.randomBytes(5).toString('hex')}@example.invalid`;
    const password = crypto.randomBytes(16).toString('hex');

    const registro = await enviar('/api/auth/register', {
      nombre: 'Ensayo P17', email, password
    });

    if (registro.estado !== 201) {
      throw new Error(
        'Fallo el registro: ' + JSON.stringify(registro)
      );
    }

    const inicio = await enviar('/api/auth/login', {
      email, password
    });

    if (inicio.estado !== 200) {
      throw new Error(
        'Fallo el login: ' + JSON.stringify(inicio)
      );
    }

    const token = inicio.cuerpo.token;
    const vencimiento = new Date(
      Date.now() + 30 * 86400000
    ).toISOString().slice(0, 10);

    const resultados = [];

    for (let i = 1; i <= 50; i++) {
      const producto = await enviar('/api/productos', {
        nombre: `Producto P17 ${bd} ${i}`,
        unidad: 'und',
        consumo_diario: 0,
        dias_entrega: 1,
        stock_minimo: 0
      }, token);

      if (producto.estado !== 201) {
        throw new Error(
          `Producto ${i}: ` + JSON.stringify(producto)
        );
      }

      const productoId = producto.cuerpo.id;

      const entrada = await enviar('/api/lotes', {
        producto_id: productoId,
        proveedor_id: proveedores[0].id,
        cantidad: 5,
        costo_unitario: 1,
        fecha_vencimiento: vencimiento
      }, token);

      if (entrada.estado !== 201) {
        throw new Error(
          `Entrada ${i}: ` + JSON.stringify(entrada)
        );
      }

      const respuestas = await Promise.all([
        enviar('/api/salidas', {
          producto_id: productoId,
          cantidad: 4,
          observacion: 'P17 A'
        }, token),
        enviar('/api/salidas', {
          producto_id: productoId,
          cantidad: 4,
          observacion: 'P17 B'
        }, token)
      ]);

      const estados = respuestas
        .map((r) => r.estado)
        .sort((a, b) => a - b);

      const [[stock]] = await conexion.query(
        `SELECT COALESCE(SUM(cantidad_actual),0) AS saldo
         FROM lote WHERE producto_id=?`,
        [productoId]
      );

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

    const correctas = resultados.filter(
      (r) => r.resultado === 'CORRECTO'
    ).length;

    const informe = [
      `PRUEBA P17 - ${new Date().toISOString()}`,
      `Base aislada: ${bd}`,
      `Resultados: ${correctas}/50 correctos`,
      'Iteracion;HTTP;Saldo;Movimientos;Resultado',
      ...resultados.map(
        (r) =>
          `${r.iteracion};${r.estados};${r.saldo};` +
          `${r.movimientos};${r.resultado}`
      )
    ].join('\n');

    const archivo = path.join(
      __dirname, `P17_resultados_${bd}.txt`
    );

    fs.writeFileSync(archivo, informe, 'utf8');

    console.log(
      `\nRESULTADO FINAL P17: ${correctas}/50 correctas`
    );
    console.log(`Base de datos de ensayo: ${bd}`);
    console.log(`Evidencia guardada: ${archivo}`);

  } finally {
    if (servidor) servidor.kill();
    if (conexion) await conexion.end();
  }
}

principal().catch((error) => {
  console.error('ERROR P17:', error.message);
  process.exitCode = 1;
});