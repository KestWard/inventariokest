'use strict';

/**
 * Estimación de demanda a partir de las salidas reales (tabla movimiento, tipo 'S').
 * Modelo: promedio móvil con estacionalidad semanal.
 *   - Ventana: los últimos VENTANA_DIAS días completos (no incluye hoy, que aún no termina).
 *   - Los días sin salidas cuentan como 0 (también son demanda).
 *   - Con 14 días o más de historia: promedio por día de la semana (método "estacional").
 *   - Con 7 a 13 días: promedio simple de todos los días (método "promedio_movil").
 *   - Con menos de 7 días: se usa el consumo diario digitado por el admin (método "manual").
 * Son funciones puras: se prueban con `node --test` sin MySQL.
 * Fechas en formato YYYY-MM-DD.
 */

const { aISO, diasEntre } = require('./peps');

const VENTANA_DIAS = 28;       // 4 semanas completas: 4 observaciones por cada día de la semana
const MIN_DIAS_PROMEDIO = 7;
const MIN_DIAS_ESTACIONAL = 14; // 14 días consecutivos contienen cada día de la semana 2 veces

const r2 = (x) => Math.round(x * 100) / 100;

function partes(f) {
  return aISO(f).split('-').map(Number);
}

function sumarDias(f, n) {
  const [y, m, d] = partes(f);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 0 = domingo, 1 = lunes, ... 6 = sábado.
function diaSemana(f) {
  const [y, m, d] = partes(f);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * @param ventas  [{ fecha: 'YYYY-MM-DD', cantidad }] salidas (pueden repetirse fechas)
 * @param hoy     fecha actual
 * @param opciones.consumo_manual  consumo diario digitado por el admin (respaldo)
 * @param opciones.ventana         días hacia atrás (por defecto 28)
 * @param opciones.desde_registro  primera fecha con movimientos del producto (evita
 *                                 contar como "cero ventas" días anteriores a su registro)
 */
function prediccionDemanda(ventas, hoy = new Date(), opciones = {}) {
  const { consumo_manual = 0, ventana = VENTANA_DIAS, desde_registro = null } = opciones;
  const h = aISO(hoy);
  let inicio = sumarDias(h, -ventana);
  if (desde_registro && aISO(desde_registro) > inicio) inicio = aISO(desde_registro);

  const dias = Math.max(0, diasEntre(inicio, h)); // días completos: inicio ... ayer
  const manual = Number(consumo_manual) || 0;

  const obs = Array(7).fill(0);
  for (let i = 0; i < dias; i++) obs[diaSemana(sumarDias(inicio, i))]++;

  if (dias < MIN_DIAS_PROMEDIO) {
    return {
      metodo: 'manual',
      ventana_dias: dias,
      promedio_diario: r2(manual),
      por_dia_semana: Array(7).fill(r2(manual)),
      observaciones_por_dia: obs,
    };
  }

  const suma = Array(7).fill(0);
  let total = 0;
  for (const v of ventas || []) {
    const f = aISO(v.fecha);
    const c = Number(v.cantidad);
    if (f < inicio || f >= h || !Number.isFinite(c)) continue;
    suma[diaSemana(f)] += c;
    total += c;
  }

  const promedio = total / dias;
  const estacional = dias >= MIN_DIAS_ESTACIONAL;

  return {
    metodo: estacional ? 'estacional' : 'promedio_movil',
    ventana_dias: dias,
    promedio_diario: r2(promedio),
    por_dia_semana: suma.map((s, w) => r2(estacional ? s / obs[w] : promedio)),
    observaciones_por_dia: obs,
  };
}

/** Demanda esperada en `dias` días a partir de mañana (se pueden saltar los primeros `saltar`). */
function demandaFutura(prediccion, hoy, dias, saltar = 0) {
  let total = 0;
  for (let i = saltar + 1; i <= saltar + dias; i++) {
    total += prediccion.por_dia_semana[diaSemana(sumarDias(hoy, i))];
  }
  return r2(total);
}

/**
 * Misma lógica de reposición de peps.js, pero la demanda sale del pronóstico:
 *   punto de reorden = demanda durante la entrega + stock mínimo
 *   cantidad sugerida = punto de reorden + 2 días de cobertura - stock actual
 * Con método "manual" el resultado coincide con puntoReorden/cantidadSugerida de peps.js.
 */
function evaluarReposicion(producto, stock, prediccion, hoy = new Date()) {
  const h = aISO(hoy);
  const entrega = Number(producto.dias_entrega);
  const minimo = Number(producto.stock_minimo);
  const demandaEntrega = demandaFutura(prediccion, h, entrega);
  const cobertura = demandaFutura(prediccion, h, 2, entrega);
  const punto = r2(demandaEntrega + minimo);
  const actual = Number(stock);

  return {
    metodo: prediccion.metodo,
    consumo_estimado: prediccion.promedio_diario,
    demanda_entrega: demandaEntrega,
    punto_reorden: punto,
    requiere: actual <= punto,
    sugerido: Math.max(0, r2(punto + cobertura - actual)),
  };
}

module.exports = {
  VENTANA_DIAS,
  MIN_DIAS_PROMEDIO,
  MIN_DIAS_ESTACIONAL,
  sumarDias,
  diaSemana,
  prediccionDemanda,
  demandaFutura,
  evaluarReposicion,
};
