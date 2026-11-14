'use strict';
// Aplica la integración de demanda estimada a backend/src/server.js y frontend/src/App.jsx.
// Uso (desde la carpeta raíz del proyecto):  node aplicar-demanda.js
// - Hace copia de seguridad (.bak-demanda) antes de modificar.
// - Si algún punto de anclaje no se encuentra, NO modifica nada.
// - Se puede ejecutar dos veces sin duplicar cambios.
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join('backend', 'src', 'server.js');
const APP = path.join('frontend', 'src', 'App.jsx');

const SERVER_HELPER = `// Demanda estimada con las salidas reales (promedio móvil + estacionalidad semanal).
async function evaluarProductos() {
  const h = hoy();
  const desde = D.sumarDias(h, -D.VENTANA_DIAS);
  const productos = await productosConStock();

  const [ventas] = await pool.query(
    \`SELECT producto_id, DATE(fecha) AS fecha, SUM(cantidad) AS cantidad
       FROM movimiento
      WHERE tipo = 'S' AND fecha >= ? AND fecha < ?
      GROUP BY producto_id, DATE(fecha)\`,
    [desde, h]
  );

  const [primeros] = await pool.query(
    \`SELECT producto_id, MIN(DATE(fecha)) AS primero
       FROM movimiento
      GROUP BY producto_id\`
  );

  const primeroDe = Object.fromEntries(
    primeros.map(r => [r.producto_id, r.primero])
  );

  return productos.map(p => {
    const prediccion = D.prediccionDemanda(
      ventas.filter(v => v.producto_id === p.id),
      h,
      {
        consumo_manual: p.consumo_diario,
        desde_registro: primeroDe[p.id] || null
      }
    );

    return {
      producto: p,
      prediccion,
      reposicion: D.evaluarReposicion(p, p.stock, prediccion, h)
    };
  });
}

// Consultar la demanda estimada por producto y día de la semana.
app.get('/api/demanda', async (req, res) => {
  const filas = await evaluarProductos();

  res.json(filas.map(({ producto: p, prediccion: d }) => ({
    producto_id: p.id,
    producto: p.nombre,
    unidad: p.unidad,
    consumo_manual: p.consumo_diario,
    metodo: d.metodo,
    ventana_dias: d.ventana_dias,
    promedio_diario: d.promedio_diario,
    por_dia_semana: d.por_dia_semana
  })));
});

`;

const SERVER_REPOSICION_NUEVA = `  const reposicion = (await evaluarProductos())
    .filter(f => f.reposicion.requiere)
    .map(({ producto: p, reposicion: r }) => ({
      producto_id: p.id,
      producto: p.nombre,
      stock: p.stock,
      sugerido: r.sugerido,
      consumo_estimado: r.consumo_estimado,
      metodo: r.metodo,
      demanda_entrega: r.demanda_entrega,
      punto_reorden: r.punto_reorden
    }));`;

const SERVER_REPOSICION_VIEJA = `  const reposicion = (await productosConStock())
    .filter(p => P.requiereReposicion(p, p.stock))
    .map(p => ({
      producto_id: p.id,
      producto: p.nombre,
      stock: p.stock,
      sugerido: P.cantidadSugerida(p, p.stock)
    }));`;

const APP_ETIQUETAS = `const ETIQUETA_METODO = {
  estacional: "modelo por día de la semana",
  promedio_movil: "promedio móvil",
  manual: "consumo manual"
};
const ORDEN_DIAS = [1, 2, 3, 4, 5, 6, 0];
const NOMBRE_DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

`;

const APP_PANEL = `      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Demanda estimada por día de la semana</h2>
            <p className="muted">
              Calculada con las salidas reales de las últimas 4 semanas
              (promedio móvil con estacionalidad semanal).
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Método</th>
                {ORDEN_DIAS.map(d => (
                  <th key={d}>{NOMBRE_DIAS[d]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dem.map(d => (
                <tr key={d.producto_id}>
                  <td><strong>{d.producto}</strong></td>
                  <td>
                    {ETIQUETA_METODO[d.metodo] || d.metodo}
                    {" "}({d.ventana_dias} d)
                  </td>
                  {ORDEN_DIAS.map(i => (
                    <td key={i}>
                      {d.por_dia_semana[i]} {d.unidad}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

`;

// Cada cambio: [descripción, ya aplicado?, buscar, reemplazar]
function cambiosServer(t) {
  return [
    ['importar demanda.js', t.includes("require('./demanda')"),
      "const P = require('./peps');",
      "const P = require('./peps');\nconst D = require('./demanda');"],
    ['helper y /api/demanda', t.includes('/api/demanda'),
      '// Consultar alertas.\n',
      SERVER_HELPER + '// Consultar alertas.\n'],
    ['reposición con demanda estimada', t.includes('evaluarProductos()') && !t.includes(SERVER_REPOSICION_VIEJA),
      SERVER_REPOSICION_VIEJA, SERVER_REPOSICION_NUEVA],
  ];
}

function cambiosApp(t) {
  return [
    ['etiquetas', t.includes('ETIQUETA_METODO ='),
      'function Dashboard() {\n',
      APP_ETIQUETAS + 'function Dashboard() {\n'],
    ['estado dem', t.includes('setDem'),
      'function Dashboard() {\n  const [prods, setProds] = useState([]);\n',
      'function Dashboard() {\n  const [prods, setProds] = useState([]);\n  const [dem, setDem] = useState([]);\n'],
    ['cargar /demanda', t.includes('api("/demanda")'),
      '    api("/alertas").then(setAl);\n',
      '    api("/alertas").then(setAl);\n    api("/demanda").then(setDem);\n'],
    ['panel de demanda', t.includes('Demanda estimada por día'),
      '      <div className="alert-grid">\n',
      APP_PANEL + '      <div className="alert-grid">\n'],
    ['detalle en sugerencias', t.includes('consumo estimado'),
      '<span>Stock actual: {r.stock}</span>',
      '<span>\n                  Stock: {r.stock} · consumo estimado {r.consumo_estimado}/día\n                  ({ETIQUETA_METODO[r.metodo] || r.metodo})\n                </span>'],
  ];
}

function leer(ruta) {
  const crudo = fs.readFileSync(ruta, 'utf8');
  const crlf = crudo.includes('\r\n');
  return { texto: crudo.replace(/\r\n/g, '\n'), crlf };
}

function planificar(ruta, fnCambios) {
  const { texto, crlf } = leer(ruta);
  let nuevo = texto;
  const log = [];
  for (const [desc, hecho, buscar, reemplazo] of fnCambios(texto)) {
    if (hecho) { log.push(`  = ${desc}: ya estaba aplicado`); continue; }
    const n = nuevo.split(buscar).length - 1;
    if (n !== 1) throw new Error(`${ruta}: no se encontró (o es ambiguo) el punto "${desc}" (${n} coincidencias).`);
    nuevo = nuevo.replace(buscar, () => reemplazo);
    log.push(`  + ${desc}`);
  }
  return { ruta, nuevo, crlf, cambio: nuevo !== texto, log };
}

try {
  for (const f of [SERVER, APP, path.join('backend', 'src', 'demanda.js')]) {
    if (!fs.existsSync(f)) throw new Error(`No existe ${f}. Ejecute este script desde la carpeta raíz del proyecto (donde están backend y frontend).`);
  }
  const planes = [planificar(SERVER, cambiosServer), planificar(APP, cambiosApp)];
  for (const p of planes) {
    console.log(p.ruta);
    p.log.forEach((l) => console.log(l));
  }
  for (const p of planes) {
    if (!p.cambio) continue;
    const bak = p.ruta + '.bak-demanda';
    if (!fs.existsSync(bak)) fs.copyFileSync(p.ruta, bak);
    fs.writeFileSync(p.ruta, p.crlf ? p.nuevo.replace(/\n/g, '\r\n') : p.nuevo, 'utf8');
  }
  console.log('\nListo. Reinicie el backend (npm start) y recargue el navegador.');
} catch (e) {
  console.error('\nNo se modificó ningún archivo.\n' + e.message);
  process.exit(1);
}
