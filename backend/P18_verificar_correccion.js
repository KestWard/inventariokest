
'use strict';

const crypto = require('node:crypto');
const API = 'http://127.0.0.1:3101';

// Funcion para enviar solicitudes al servidor.
async function solicitud(ruta, metodo = 'GET', datos, token, clave) {
  const respuesta = await fetch(API + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(clave ? { 'Idempotency-Key': clave } : {})
    },
    ...(datos ? { body: JSON.stringify(datos) } : {})
  });

  return {
    estado: respuesta.status,
    datos: await respuesta.json()
  };
}

async function probar() {

  // PREPARACION DEL ENTORNO DE ENSAYO

  const codigo = crypto.randomBytes(5).toString('hex');
  const nombre = 'Prueba P18 ' + codigo;
  const email = `p18-${codigo}@example.invalid`;
  const password = crypto.randomBytes(12).toString('hex');

  const registro = await solicitud('/api/auth/register', 'POST', {
    nombre: 'Verificacion P18',
    email,
    password
  });

  if (registro.estado !== 201) {
    throw new Error('Registro: ' + JSON.stringify(registro));
  }

  const login = await solicitud('/api/auth/login', 'POST', {
    email,
    password
  });

  if (login.estado !== 200) {
    throw new Error('Login: ' + JSON.stringify(login));
  }

  const token = login.datos.token;

  const producto = await solicitud('/api/productos', 'POST', {
    nombre,
    unidad: 'und',
    consumo_diario: 0,
    dias_entrega: 1,
    stock_minimo: 0
  }, token);

  if (producto.estado !== 201) {
    throw new Error('Producto: ' + JSON.stringify(producto));
  }

  const productoId = producto.datos.id;

  const proveedores = await solicitud(
    '/api/proveedores', 'GET', null, token
  );

  const proveedorId = proveedores.datos[0]?.id;

  if (!proveedorId) {
    throw new Error('No hay proveedor de ensayo');
  }

  const vencimiento = new Date(
    Date.now() + 30 * 86400000
  ).toISOString().slice(0, 10);

  const entrada = await solicitud('/api/lotes', 'POST', {
    producto_id: productoId,
    proveedor_id: proveedorId,
    cantidad: 5,
    costo_unitario: 1,
    fecha_vencimiento: vencimiento
  }, token);

  if (entrada.estado !== 201) {
    throw new Error('Entrada: ' + JSON.stringify(entrada));
  }

  const clave = crypto.randomUUID();

  const salida = {
    producto_id: productoId,
    cantidad: 1,
    observacion: 'Verificacion P18'
  };

  // PRUEBA 1: MISMA SOLICITUD, MISMA CLAVE

  const primera = await solicitud(
    '/api/salidas', 'POST', salida, token, clave
  );

  const segunda = await solicitud(
    '/api/salidas', 'POST', salida, token, clave
  );

  const productos = await solicitud(
    '/api/productos', 'GET', null, token
  );

  const reportes = await solicitud(
    '/api/reportes/movimientos', 'GET', null, token
  );

  const actual = productos.datos.find(
    p => Number(p.id) === Number(productoId)
  );

  const movimientos = reportes.datos.movimientos.filter(
    m => m.producto === nombre && m.tipo === 'S'
  );

  const correcto1 =
    primera.estado === 200 &&
    segunda.estado === 200 &&
    Number(actual?.stock) === 4 &&
    movimientos.length === 1 &&
    JSON.stringify(primera.datos) ===
      JSON.stringify(segunda.datos);

  console.log('\n================================');
  console.log('P18 - PRUEBA 1: SOLICITUD REPETIDA');
  console.log('================================');
  console.log('Primera respuesta HTTP:', primera.estado);
  console.log('Segunda respuesta HTTP:', segunda.estado);
  console.log('Saldo inicial: 5');
  console.log('Saldo final:', actual?.stock);
  console.log('Movimientos:', movimientos.length);
  console.log('RESULTADO:',
    correcto1 ? 'CORRECCION VERIFICADA' : 'REVISAR'
  );

  // PRUEBA 2: OTRA OPERACION LEGITIMA CON CLAVE DIFERENTE

  const tercera = await solicitud(
    '/api/salidas',
    'POST',
    salida,
    token,
    crypto.randomUUID()
  );

  const lista = await solicitud(
    '/api/productos', 'GET', null, token
  );

  const reporte = await solicitud(
    '/api/reportes/movimientos', 'GET', null, token
  );

  const saldo = lista.datos.find(
    p => Number(p.id) === Number(productoId)
  )?.stock;

  const total = reporte.datos.movimientos.filter(
    m => m.producto === nombre && m.tipo === 'S'
  ).length;

  const correcto2 =
    tercera.estado === 200 &&
    Number(saldo) === 3 &&
    total === 2;

  console.log('\n================================');
  console.log('P18 - PRUEBA 2: OPERACION INDEPENDIENTE');
  console.log('================================');
  console.log('HTTP:', tercera.estado);
  console.log('Saldo final:', saldo);
  console.log('Movimientos:', total);
  console.log('RESULTADO:',
    correcto2 ? 'CORRECTO' : 'REVISAR'
  );

  // PRUEBA 3: MISMA CLAVE, PERO DATOS DIFERENTES

  const intentoAlterado = await solicitud(
    '/api/salidas',
    'POST',
    { ...salida, cantidad: 2 },
    token,
    clave
  );

  const consultaFinal = await solicitud(
    '/api/productos', 'GET', null, token
  );

  const reporteFinal = await solicitud(
    '/api/reportes/movimientos', 'GET', null, token
  );

  const saldoFinal = consultaFinal.datos.find(
    p => Number(p.id) === Number(productoId)
  )?.stock;

  const movimientosFinales =
    reporteFinal.datos.movimientos.filter(
      m => m.producto === nombre && m.tipo === 'S'
    ).length;

  const correcto3 =
    intentoAlterado.estado === 409 &&
    Number(saldoFinal) === 3 &&
    movimientosFinales === 2;

  console.log('\n================================');
  console.log('P18 - PRUEBA 3: MISMA CLAVE, DATOS DIFERENTES');
  console.log('================================');
  console.log('HTTP:', intentoAlterado.estado);
  console.log('Saldo final:', saldoFinal);
  console.log('Movimientos:', movimientosFinales);
  console.log('RESULTADO:',
    correcto3 ? 'CORRECTO' : 'REVISAR'
  );

  // RESUMEN DE LOS TRES ESCENARIOS

  const aprobadas = [correcto1, correcto2, correcto3]
    .filter(Boolean).length;

  console.log('\n================================');
  console.log('RESULTADO FINAL P18');
  console.log('================================');
  console.log('Comprobaciones satisfactorias:', aprobadas, '/ 3');
  console.log(
    'ESTADO:',
    aprobadas === 3
      ? 'CORRECCION VERIFICADA EN LABORATORIO'
      : 'EXISTEN RESULTADOS POR REVISAR'
  );

  if (aprobadas !== 3) {
    process.exitCode = 1;
  }
}

probar().catch(error => {
  console.error('ERROR P18:', error.message);
  process.exitCode = 1;
});
