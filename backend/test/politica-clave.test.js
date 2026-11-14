'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validarClave } = require('../src/politica-clave');

test('acepta una clave larga con letras y números', () => {
  assert.deepEqual(validarClave('Asadero2026Soacha', { email: 'admin@correo.com' }), []);
});

test('rechaza claves cortas, sin números o sin letras', () => {
  assert.match(validarClave('Corta1').join(' '), /al menos 12/);
  assert.match(validarClave('SoloLetrasLargas').join(' '), /número/);
  assert.match(validarClave('123456789012').join(' '), /letra/);
});

test('rechaza una clave que repite un carácter o contiene el correo', () => {
  assert.match(validarClave('aaaaaaaaaaaa').join(' '), /repetir/);
  assert.match(validarClave('Nicolas12345678', { email: 'nicolas@x.com' }).join(' '), /contener el correo/);
});

test('rechaza claves de más de 72 bytes y valores que no son texto', () => {
  assert.match(validarClave('a1'.repeat(37)).join(' '), /72 bytes/);
  assert.deepEqual(validarClave(undefined), ['La clave debe ser texto.']);
});

test('la clave de ensayo anterior (10 caracteres) ya no cumple la política', () => {
  assert.ok(validarClave('TuClave123').length > 0);
});
