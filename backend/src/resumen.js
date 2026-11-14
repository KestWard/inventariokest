'use strict';

/**
 * Resumen en lenguaje natural del inventario, generado por reglas (sin servicios externos).
 * Combina existencias, vencimientos, reposición, demanda estimada y movimientos recientes.
 * Es una función pura: se prueba con `node --test` sin MySQL.
 */

const P = require('./peps');
const D = require('./demanda');

const moneda = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const numero = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const cant = (n, u) => `${numero.format(Number(n))}${u ? ' ' + u : ''}`;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ETIQUETA_NIVEL = { critico: 'Crítico', atencion: 'Atención', info: 'Informativo' };
const RANGO = { critico: 0, atencion: 1, info: 2 };

const lista = (items, max = 4) =>
  items.length <= max ? items.join('; ') : `${items.slice(0, max).join('; ')}; y ${items.length - max} más`;
const plural = (n, uno, varios) => (n === 1 ? uno : varios);
const valorLotes = (ls) => ls.reduce((s, l) => s + Number(l.cantidad_actual) * Number(l.costo_unitario || 0), 0);

/**
 * @param fecha        fecha de hoy (YYYY-MM-DD)
 * @param filas        [{ producto, prediccion, reposicion }] (ver evaluarProductos en server.js)
 * @param lotes        lotes con saldo: { id, cantidad_actual, costo_unitario, fecha_vencimiento, producto, unidad }
 * @param movimientos  últimos 7 días agrupados: { tipo, producto, unidad, cantidad, n }
 */
function construirResumen({ fecha, filas = [], lotes = [], movimientos = [] }) {
  const hoy = P.aISO(fecha);
  const conSaldo = lotes.filter((l) => Number(l.cantidad_actual) > 0);
  const vencidos = conSaldo.filter((l) => P.aISO(l.fecha_vencimiento) < hoy);
  const vigentes = conSaldo.filter((l) => P.aISO(l.fecha_vencimiento) >= hoy);
  const porVencer = vigentes
    .filter((l) => P.diasEntre(hoy, l.fecha_vencimiento) <= 2)
    .sort((a, b) => P.aISO(a.fecha_vencimiento).localeCompare(P.aISO(b.fecha_vencimiento)));

  const puntos = [];

  // 1. Lotes vencidos que aún tienen saldo.
  if (vencidos.length) {
    const items = vencidos.map((l) => {
      const dias = P.diasEntre(l.fecha_vencimiento, hoy);
      return `${l.producto} lote ${l.id}: ${cant(l.cantidad_actual, l.unidad)} (venció hace ${dias} ${plural(dias, 'día', 'días')})`;
    });
    puntos.push({
      nivel: 'critico',
      titulo: 'Lotes vencidos con saldo',
      detalle: `${lista(items)}. Valor aproximado: ${moneda.format(valorLotes(vencidos))}. ` +
        'El sistema ya los excluye del stock utilizable, pero deben retirarse físicamente.',
    });
  }

  // 2. Lotes por vencer en 2 días o menos.
  if (porVencer.length) {
    const items = porVencer.map((l) => {
      const d = P.diasEntre(hoy, l.fecha_vencimiento);
      const cuando = d === 0 ? 'vence hoy' : d === 1 ? 'vence mañana' : `vence en ${d} días`;
      return `${l.producto} lote ${l.id}: ${cant(l.cantidad_actual, l.unidad)}, ${cuando}`;
    });
    puntos.push({
      nivel: 'atencion',
      titulo: `${porVencer.length} ${plural(porVencer.length, 'lote por vencer', 'lotes por vencer')}`,
      detalle: `${lista(items)}. Valor en riesgo: ${moneda.format(valorLotes(porVencer))}. ` +
        'Las salidas usan primero el lote que vence antes (FEFO).',
    });
  }

  // 3. Productos bajo el punto de reorden, del más urgente al menos urgente.
  const reponer = filas
    .filter((f) => f.reposicion.requiere)
    .map((f) => {
      const { producto: p, reposicion: r } = f;
      const cobertura = r.consumo_estimado > 0 ? Number(p.stock) / r.consumo_estimado : null;
      const critico = cobertura !== null && cobertura < Number(p.dias_entrega);
      return { p, r, cobertura, critico };
    })
    .sort((a, b) => (a.cobertura ?? Infinity) - (b.cobertura ?? Infinity));

  for (const { p, r, cobertura, critico } of reponer) {
    let detalle = `Stock ${cant(p.stock, p.unidad)}; punto de reorden ${cant(r.punto_reorden, p.unidad)}. ` +
      `Comprar unos ${cant(r.sugerido, p.unidad)}.`;
    if (cobertura !== null) {
      detalle += ` Al ritmo estimado (${cant(r.consumo_estimado, p.unidad)} por día) alcanza para ${numero.format(cobertura)} día(s)`;
      detalle += critico
        ? `, menos que los ${p.dias_entrega} día(s) que tarda la entrega: se agotaría antes de recibir el pedido.`
        : '.';
    }
    puntos.push({ nivel: critico ? 'critico' : 'atencion', titulo: `Reponer ${p.nombre}`, detalle });
  }

  // 4. Días de mayor consumo (solo con el modelo estacional).
  const picos = filas
    .filter((f) => f.prediccion.metodo === 'estacional' && f.prediccion.promedio_diario > 0)
    .map((f) => {
      const v = f.prediccion.por_dia_semana;
      const dia = v.indexOf(Math.max(...v));
      return { f, dia, razon: v[dia] / f.prediccion.promedio_diario };
    })
    .filter((x) => x.razon >= 1.3)
    .sort((a, b) => b.razon - a.razon)
    .slice(0, 3);
  if (picos.length) {
    puntos.push({
      nivel: 'info',
      titulo: 'Días de mayor consumo',
      detalle: lista(picos.map(({ f, dia }) =>
        `${f.producto.nombre}: el ${DIAS[dia]} (${cant(f.prediccion.por_dia_semana[dia], f.producto.unidad)} ` +
        `frente a ${cant(f.prediccion.promedio_diario, f.producto.unidad)} de promedio)`)) + '.',
    });
  }

  // 5. Pronóstico para mañana y productos que aún usan consumo manual.
  const conModelo = filas.filter((f) => f.prediccion.metodo !== 'manual' && f.prediccion.promedio_diario > 0);
  if (conModelo.length) {
    const w = D.diaSemana(D.sumarDias(hoy, 1));
    puntos.push({
      nivel: 'info',
      titulo: `Pronóstico para mañana (${DIAS[w]})`,
      detalle: lista(conModelo.map((f) => `${f.producto.nombre} ${cant(f.prediccion.por_dia_semana[w], f.producto.unidad)}`), 8) + '.',
    });
  }
  const manuales = filas.filter((f) => f.prediccion.metodo === 'manual');
  if (manuales.length) {
    puntos.push({
      nivel: 'info',
      titulo: 'Pronóstico limitado',
      detalle: `${manuales.map((f) => f.producto.nombre).join(', ')} ${plural(manuales.length, 'usa', 'usan')} el consumo diario ` +
        'digitado porque tienen menos de 7 días de movimientos.',
    });
  }

  // 6. Movimientos de los últimos 7 días.
  const por = (t) => movimientos.filter((m) => m.tipo === t);
  const registros = (t) => por(t).reduce((s, m) => s + Number(m.n), 0);
  if (!movimientos.length) {
    puntos.push({ nivel: 'info', titulo: 'Movimientos de los últimos 7 días', detalle: 'No se registraron movimientos.' });
  } else {
    let detalle = `${registros('E')} ${plural(registros('E'), 'entrada', 'entradas')} y ` +
      `${registros('S')} ${plural(registros('S'), 'salida', 'salidas')} registradas.`;
    const salidas = por('S').sort((a, b) => Number(b.n) - Number(a.n) || Number(b.cantidad) - Number(a.cantidad));
    if (salidas.length) {
      detalle += ` Con más salidas: ${lista(salidas.map((m) => `${m.producto} ${cant(m.cantidad, m.unidad)}`), 3)}.`;
    }
    if (registros('M')) detalle += ` Mermas registradas: ${registros('M')}.`;
    puntos.push({ nivel: 'info', titulo: 'Movimientos de los últimos 7 días', detalle });
  }

  puntos.sort((a, b) => RANGO[a.nivel] - RANGO[b.nivel]); // estable: conserva el orden dentro de cada nivel

  const urgente = puntos.some((p) => p.nivel === 'critico');
  const partes = [];
  if (reponer.length) partes.push(`${reponer.length} ${plural(reponer.length, 'producto por reponer', 'productos por reponer')}`);
  if (porVencer.length) partes.push(`${porVencer.length} ${plural(porVencer.length, 'lote por vencer', 'lotes por vencer')}`);
  if (vencidos.length) partes.push(`${vencidos.length} ${plural(vencidos.length, 'lote vencido con saldo', 'lotes vencidos con saldo')}`);
  const titular = partes.length
    ? `${urgente ? 'Atención urgente' : 'Requiere atención'}: ${partes.join(', ')}.`
    : 'El inventario está en orden: ningún producto está bajo su punto de reorden y no hay lotes vencidos ni por vencer en los próximos 2 días.';

  const indicadores = [
    { etiqueta: 'Valor del inventario vigente', valor: moneda.format(valorLotes(vigentes)), detalle: `${vigentes.length} ${plural(vigentes.length, 'lote', 'lotes')} con saldo` },
    { etiqueta: 'Productos por reponer', valor: `${reponer.length} de ${filas.length}`, detalle: reponer.length ? 'Bajo el punto de reorden' : 'Stock suficiente' },
    { etiqueta: 'Lotes por vencer (2 días)', valor: String(porVencer.length), detalle: `Valor en riesgo ${moneda.format(valorLotes(porVencer))}` },
    { etiqueta: 'Lotes vencidos con saldo', valor: String(vencidos.length), detalle: vencidos.length ? `Valor ${moneda.format(valorLotes(vencidos))}` : 'Sin lotes vencidos' },
  ];

  const texto = [
    `Resumen del inventario al ${hoy}`,
    titular,
    '',
    ...indicadores.map((i) => `${i.etiqueta}: ${i.valor} (${i.detalle})`),
    '',
    ...puntos.map((p) => `- [${ETIQUETA_NIVEL[p.nivel]}] ${p.titulo}: ${p.detalle}`),
  ].join('\n');

  return { fecha: hoy, titular, indicadores, puntos: puntos.map((p) => ({ ...p, etiqueta: ETIQUETA_NIVEL[p.nivel] })), texto };
}

module.exports = { construirResumen };
