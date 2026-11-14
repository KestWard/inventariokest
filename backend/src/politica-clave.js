'use strict';

/**
 * Política mínima de contraseña para cuentas nuevas (crear-usuario.js y cambiar-clave.js).
 * Devuelve la lista de errores; vacía si la clave es aceptable.
 */
const MIN_LONGITUD = 12;
const MAX_BYTES = 72; // bcrypt ignora lo que pase de 72 bytes

function validarClave(clave, { email = '' } = {}) {
  if (typeof clave !== 'string') return ['La clave debe ser texto.'];
  const errores = [];

  if (clave.length < MIN_LONGITUD) errores.push(`Debe tener al menos ${MIN_LONGITUD} caracteres.`);
  if (Buffer.byteLength(clave, 'utf8') > MAX_BYTES) errores.push(`Debe ocupar como máximo ${MAX_BYTES} bytes (límite de bcrypt).`);
  if (!/\p{L}/u.test(clave)) errores.push('Debe incluir al menos una letra.');
  if (!/\d/.test(clave)) errores.push('Debe incluir al menos un número.');
  if (clave.length > 0 && /^(.)\1+$/u.test(clave)) errores.push('No puede repetir un mismo carácter.');

  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && clave.toLowerCase().includes(local)) errores.push('No debe contener el correo.');

  return errores;
}

module.exports = { MIN_LONGITUD, MAX_BYTES, validarClave };
