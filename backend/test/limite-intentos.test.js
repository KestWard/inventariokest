'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearLimitador } = require('../src/limite-intentos');

const MIN = 60 * 1000;
function conReloj(opciones = {}) {
  const reloj = { t: 1_000_000 };
  const lim = crearLimitador({ ahora: () => reloj.t, ...opciones });
  return { reloj, lim };
}

test('4 fallos no bloquean; el 5.º bloquea esa cuenta por 15 minutos', () => {
  const { lim } = conReloj();
  for (let i = 0; i < 4; i++) lim.registrarFallo('1.1.1.1', 'admin@x.com');
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 0);
  lim.registrarFallo('1.1.1.1', 'admin@x.com');
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 15 * 60);
});

test('el bloqueo termina al pasar la ventana y la cuenta puede intentar de nuevo', () => {
  const { reloj, lim } = conReloj();
  for (let i = 0; i < 5; i++) lim.registrarFallo('1.1.1.1', 'admin@x.com');
  reloj.t += 14 * MIN;
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 60);
  reloj.t += 1 * MIN;
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 0);
  lim.registrarFallo('1.1.1.1', 'admin@x.com'); // vuelve a contar desde cero
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 0);
});

test('los fallos antiguos salen de la ventana y no se acumulan', () => {
  const { reloj, lim } = conReloj();
  for (let i = 0; i < 4; i++) lim.registrarFallo('1.1.1.1', 'admin@x.com');
  reloj.t += 16 * MIN;
  lim.registrarFallo('1.1.1.1', 'admin@x.com');
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 0);
});

test('un inicio de sesión correcto borra el contador de la cuenta', () => {
  const { lim } = conReloj();
  for (let i = 0; i < 4; i++) lim.registrarFallo('1.1.1.1', 'admin@x.com');
  lim.registrarExito('1.1.1.1', 'admin@x.com');
  lim.registrarFallo('1.1.1.1', 'admin@x.com');
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'admin@x.com'), 0);
});

test('el correo se normaliza (mayúsculas y espacios) y cada IP cuenta aparte', () => {
  const { lim } = conReloj();
  for (let i = 0; i < 5; i++) lim.registrarFallo('1.1.1.1', '  ADMIN@x.com ');
  assert.ok(lim.segundosBloqueo('1.1.1.1', 'admin@x.com') > 0);
  assert.equal(lim.segundosBloqueo('2.2.2.2', 'admin@x.com'), 0);
});

test('una IP que prueba muchas cuentas distintas se bloquea por completo', () => {
  const { lim } = conReloj();
  for (let i = 0; i < 20; i++) lim.registrarFallo('9.9.9.9', `usuario${i}@x.com`);
  assert.ok(lim.segundosBloqueo('9.9.9.9', 'otro@x.com') > 0);
  assert.equal(lim.segundosBloqueo('8.8.8.8', 'otro@x.com'), 0);
});

test('los parámetros son configurables y limpiar() libera registros vencidos', () => {
  const { reloj, lim } = conReloj({ maxPorCuenta: 2, ventanaMs: MIN });
  lim.registrarFallo('1.1.1.1', 'a@x.com');
  lim.registrarFallo('1.1.1.1', 'a@x.com');
  assert.equal(lim.segundosBloqueo('1.1.1.1', 'a@x.com'), 60);
  reloj.t += 2 * MIN;
  lim.limpiar();
  assert.equal(lim.tamano(), 0);
});
