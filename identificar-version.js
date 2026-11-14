'use strict';
// Identifica la versión del código sobre la que se ejecutan las pruebas (hallazgos N1 y H5).
// Uso (desde la raíz del proyecto):  node identificar-version.js
// Imprime fecha, Node.js, sistema, commit de git (si hay repositorio) y una huella SHA-256 del código
// (backend/src, backend/schema.sql, backend/sql, frontend/src). La huella ignora los finales de línea,
// así que es la misma en Windows y Linux, y no cambia si solo se tocan archivos de respaldo (.bak-*).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const RUTAS = [['backend', 'src'], ['backend', 'schema.sql'], ['backend', 'sql'], ['frontend', 'src']];

function archivos(ruta, salida = []) {
  if (!fs.existsSync(ruta)) return salida;
  const st = fs.statSync(ruta);
  if (st.isFile()) { if (!/\.bak-/.test(ruta)) salida.push(ruta); return salida; }
  for (const n of fs.readdirSync(ruta).sort()) {
    if (n === 'node_modules' || n === 'dist') continue;
    archivos(path.join(ruta, n), salida);
  }
  return salida;
}

function huellaCodigo(raiz) {
  const h = crypto.createHash('sha256');
  let n = 0;
  for (const r of RUTAS) {
    for (const f of archivos(path.join(raiz, ...r))) {
      h.update(path.relative(raiz, f).split(path.sep).join('/') + '\n');
      h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
      n++;
    }
  }
  return { huella: h.digest('hex').slice(0, 12), archivos: n };
}

function git(raiz, ...args) {
  try {
    return execFileSync('git', args, { cwd: raiz, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

function identificar(raiz = process.cwd()) {
  const commit = git(raiz, 'rev-parse', '--short', 'HEAD');
  const sucio = commit ? (git(raiz, 'status', '--porcelain') || '').length > 0 : null;
  const { huella, archivos: n } = huellaCodigo(raiz);
  return {
    fecha: new Date().toISOString(),
    node: process.version,
    sistema: `${process.platform} ${process.arch}`,
    commit: commit ? commit + (sucio ? ' (con cambios sin guardar)' : '') : 'sin repositorio git',
    huella_codigo: huella,
    archivos_huella: n,
  };
}

module.exports = { identificar, huellaCodigo };

if (require.main === module) {
  const v = identificar(__dirname);
  for (const [k, val] of Object.entries(v)) console.log(`${k.padEnd(16)} ${val}`);
}
