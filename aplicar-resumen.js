'use strict';
// Agrega el resumen del inventario (ruta /api/resumen y panel en el Inicio).
// Requiere haber aplicado antes aplicar-demanda.js.
// Uso (desde la carpeta raíz del proyecto):  node aplicar-resumen.js
// - Hace copia de seguridad (.bak-resumen) antes de modificar.
// - Si algún punto de anclaje no se encuentra, NO modifica nada.
// - Se puede ejecutar dos veces sin duplicar cambios.
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join('backend', 'src', 'server.js');
const APP = path.join('frontend', 'src', 'App.jsx');
const CSS = path.join('frontend', 'src', 'styles.css');

const SERVER_RUTA = `// Resumen en lenguaje natural del inventario (reglas, sin servicios externos).
app.get('/api/resumen', async (req, res) => {
  const h = hoy();
  const filas = await evaluarProductos();

  const [lotes] = await pool.query(
    \`SELECT l.id, l.cantidad_actual, l.costo_unitario, l.fecha_vencimiento,
            p.nombre AS producto, p.unidad
       FROM lote l
       JOIN producto p ON p.id = l.producto_id
      WHERE l.cantidad_actual > 0\`
  );

  const [movimientos] = await pool.query(
    \`SELECT m.tipo, p.nombre AS producto, p.unidad,
            SUM(m.cantidad) AS cantidad, COUNT(*) AS n
       FROM movimiento m
       JOIN producto p ON p.id = m.producto_id
      WHERE m.fecha >= ? AND m.fecha < ?
      GROUP BY m.tipo, p.nombre, p.unidad\`,
    [D.sumarDias(h, -6), D.sumarDias(h, 1)]
  );

  res.json(R.construirResumen({ fecha: h, filas, lotes, movimientos }));
});

`;

const APP_COMPONENTE = `function ResumenInventario() {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const [copiado, setCopiado] = useState(false);

  const generar = () => {
    setErr("");
    api("/resumen").then(setRes).catch(x => setErr(x.message));
  };

  useEffect(generar, []);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(res.texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setErr("No se pudo copiar el resumen.");
    }
  };

  return (
    <section className="panel resumen-panel">
      <div className="panel-heading">
        <div>
          <h2>Resumen del inventario</h2>
          <p className="muted">
            Generado con reglas del sistema a partir de existencias,
            vencimientos, demanda estimada y movimientos recientes.
          </p>
        </div>
        <div className="report-actions">
          <button className="secondary-action" onClick={generar}>
            Actualizar resumen
          </button>
          <button
            className="secondary-action"
            onClick={copiar}
            disabled={!res}
          >
            {copiado ? "Copiado" : "Copiar texto"}
          </button>
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      {!res && !err && <p className="empty-state">Generando resumen...</p>}

      {res && (
        <>
          <p className="resumen-titular">{res.titular}</p>

          <div className="resumen-indicadores">
            {res.indicadores.map(i => (
              <article key={i.etiqueta} className="stat-card">
                <span className="stat-label">{i.etiqueta}</span>
                <strong>{i.valor}</strong>
                <span className="stat-detail">{i.detalle}</span>
              </article>
            ))}
          </div>

          <ul className="resumen-lista">
            {res.puntos.map((p, i) => (
              <li key={i} className={"resumen-punto resumen-" + p.nivel}>
                <span className="resumen-cabecera">
                  <em className="resumen-etiqueta">{p.etiqueta}</em>
                  <strong>{p.titulo}</strong>
                </span>
                <span>{p.detalle}</span>
              </li>
            ))}
          </ul>

          <p className="muted resumen-pie">
            Datos al {res.fecha}. El pronóstico usa las salidas de las
            últimas 4 semanas y es una estimación, no una garantía.
          </p>
        </>
      )}
    </section>
  );
}

`;

const CSS_NUEVO = `.resumen-titular{font-size:17px;font-weight:700;color:var(--ink);margin:0 0 18px;line-height:1.4}.resumen-indicadores{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}.resumen-indicadores .stat-card strong{font-size:24px}.resumen-lista{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}.resumen-punto{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:8px;border-left:4px solid var(--green);background:var(--soft-green);font-size:14px;line-height:1.5}.resumen-punto>span:last-child{color:#344256}.resumen-cabecera{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.resumen-etiqueta{font-style:normal;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--green)}.resumen-critico{border-left-color:var(--red);background:var(--soft-red)}.resumen-critico .resumen-etiqueta{color:var(--red)}.resumen-atencion{border-left-color:#b7791f;background:#fdf6e7}.resumen-atencion .resumen-etiqueta{color:#8a5a00}.resumen-pie{margin-top:16px;font-size:12px}@media(max-width:760px){.resumen-indicadores{grid-template-columns:1fr 1fr}}
`;

function leer(ruta) {
  const crudo = fs.readFileSync(ruta, 'utf8');
  return { texto: crudo.replace(/\r\n/g, '\n'), crlf: crudo.includes('\r\n') };
}

function planificar(ruta, cambios) {
  const { texto, crlf } = leer(ruta);
  let nuevo = texto;
  const log = [];
  for (const [desc, hecho, buscar, reemplazo] of cambios(texto)) {
    if (hecho) { log.push(`  = ${desc}: ya estaba aplicado`); continue; }
    const n = nuevo.split(buscar).length - 1;
    if (n !== 1) throw new Error(`${ruta}: no se encontró (o es ambiguo) el punto "${desc}" (${n} coincidencias).`);
    nuevo = nuevo.replace(buscar, () => reemplazo);
    log.push(`  + ${desc}`);
  }
  return { ruta, nuevo, crlf, cambio: nuevo !== texto, log };
}

const cambiosServer = (t) => [
  ['importar resumen.js', t.includes("require('./resumen')"),
    "const D = require('./demanda');",
    "const D = require('./demanda');\nconst R = require('./resumen');"],
  ['ruta /api/resumen', t.includes('/api/resumen'),
    '// Consultar alertas.\n', SERVER_RUTA + '// Consultar alertas.\n'],
];

const cambiosApp = (t) => [
  ['componente ResumenInventario', t.includes('function ResumenInventario'),
    'function Dashboard() {\n', APP_COMPONENTE + 'function Dashboard() {\n'],
  ['mostrar el resumen en el Inicio', t.includes('<ResumenInventario />'),
    '      <section className="stats-grid">\n',
    '      <ResumenInventario />\n\n      <section className="stats-grid">\n'],
];

const cambiosCss = (t) => [
  ['estilos del resumen', t.includes('.resumen-titular'), null, null],
];

try {
  for (const f of [SERVER, APP, CSS, path.join('backend', 'src', 'resumen.js')]) {
    if (!fs.existsSync(f)) throw new Error(`No existe ${f}. Ejecute este script desde la carpeta raíz del proyecto (donde están backend y frontend).`);
  }
  if (!leer(SERVER).texto.includes("require('./demanda')") || !leer(APP).texto.includes('ETIQUETA_METODO')) {
    throw new Error('Falta la integración de demanda estimada. Ejecute primero: node aplicar-demanda.js');
  }
  const planes = [planificar(SERVER, cambiosServer), planificar(APP, cambiosApp)];
  const css = leer(CSS);
  const cssHecho = css.texto.includes('.resumen-titular');
  for (const p of planes) { console.log(p.ruta); p.log.forEach((l) => console.log(l)); }
  console.log(CSS);
  console.log(cssHecho ? '  = estilos del resumen: ya estaba aplicado' : '  + estilos del resumen');

  for (const p of planes) {
    if (!p.cambio) continue;
    const bak = p.ruta + '.bak-resumen';
    if (!fs.existsSync(bak)) fs.copyFileSync(p.ruta, bak);
    fs.writeFileSync(p.ruta, p.crlf ? p.nuevo.replace(/\n/g, '\r\n') : p.nuevo, 'utf8');
  }
  if (!cssHecho) {
    const bak = CSS + '.bak-resumen';
    if (!fs.existsSync(bak)) fs.copyFileSync(CSS, bak);
    const base = css.texto.endsWith('\n') ? css.texto : css.texto + '\n';
    const salida = base + CSS_NUEVO;
    fs.writeFileSync(CSS, css.crlf ? salida.replace(/\n/g, '\r\n') : salida, 'utf8');
  }
  console.log('\nListo. Reinicie el backend (npm start) y recargue el navegador.');
} catch (e) {
  console.error('\nNo se modificó ningún archivo.\n' + e.message);
  process.exit(1);
}
