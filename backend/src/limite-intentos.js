'use strict';

/**
 * Límite de intentos fallidos de inicio de sesión (en memoria, sin dependencias).
 *  - Por cuenta: `maxPorCuenta` fallos desde una misma IP contra un mismo correo.
 *  - Por IP: `maxPorIp` fallos desde una misma IP contra cualquier correo.
 * Al alcanzar el máximo se bloquea durante `ventanaMs`. Un inicio de sesión correcto
 * borra el contador de esa cuenta. Es una función pura con reloj inyectable, por lo
 * que se prueba con `node --test` sin servidor.
 *
 * Limitaciones: el estado vive en la memoria del proceso (se reinicia con el servidor)
 * y detrás de un proxy la IP puede ser la del proxy (configurar `trust proxy`).
 */
function crearLimitador({
  maxPorCuenta = 5,
  maxPorIp = 20,
  ventanaMs = 15 * 60 * 1000,
  ahora = Date.now,
} = {}) {
  const registros = new Map(); // clave -> { fallos: number[], hasta: number }

  const normalizar = (email) => String(email ?? '').trim().toLowerCase().slice(0, 120);
  const claves = (ip, email) => [
    { k: `c|${ip}|${normalizar(email)}`, max: maxPorCuenta },
    { k: `i|${ip}`, max: maxPorIp },
  ];

  function limpiar() {
    const t = ahora();
    for (const [k, r] of registros) {
      r.fallos = r.fallos.filter((f) => t - f < ventanaMs);
      if (!r.fallos.length && r.hasta <= t) registros.delete(k);
    }
  }

  // Segundos que faltan para poder reintentar (0 = no está bloqueado).
  function segundosBloqueo(ip, email) {
    const t = ahora();
    let espera = 0;
    for (const { k } of claves(ip, email)) {
      const r = registros.get(k);
      if (r && r.hasta > t) espera = Math.max(espera, Math.ceil((r.hasta - t) / 1000));
    }
    return espera;
  }

  function registrarFallo(ip, email) {
    const t = ahora();
    if (registros.size > 5000) limpiar();
    for (const { k, max } of claves(ip, email)) {
      const r = registros.get(k) || { fallos: [], hasta: 0 };
      r.fallos = r.fallos.filter((f) => t - f < ventanaMs);
      r.fallos.push(t);
      if (r.fallos.length >= max) {
        r.hasta = t + ventanaMs;
        r.fallos = [];
      }
      registros.set(k, r);
    }
  }

  function registrarExito(ip, email) {
    registros.delete(claves(ip, email)[0].k);
  }

  return { segundosBloqueo, registrarFallo, registrarExito, limpiar, tamano: () => registros.size };
}

module.exports = { crearLimitador };
