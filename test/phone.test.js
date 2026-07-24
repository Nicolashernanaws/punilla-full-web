'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizePhone, isValidPhone } = require('../lib/phone');

test('mismo número Cosquín en todos los formatos colisiona', () => {
  const esperado = '3541623456';
  const variantes = [
    '3541623456',
    '3541 62-3456',
    '03541623456',
    '0 3541 62 3456',
    '+543541623456',
    '54 3541 623456',
    '+54 9 3541 62-3456',
    '5493541623456',
    '93541623456',
    '03541 15 623456',   // formato viejo con 15
    '3541-15-623456',
    '+54 9 3541 15 623456',
  ];
  for (const v of variantes) {
    assert.strictEqual(normalizePhone(v), esperado, `falló: ${v} -> ${normalizePhone(v)}`);
  }
});

test('Córdoba capital (área 351) con y sin 15', () => {
  const esperado = '3515123456';
  for (const v of ['3515123456', '0351 15 5123456', '+54 9 351 512-3456', '351 5123456', '00549 351 5123456']) {
    assert.strictEqual(normalizePhone(v), esperado, `falló: ${v} -> ${normalizePhone(v)}`);
  }
});

test('CABA (área 11) con y sin 15', () => {
  const esperado = '1145678901';
  for (const v of ['1145678901', '011 15 4567 8901', '+54 9 11 4567-8901', '011 4567 8901']) {
    assert.strictEqual(normalizePhone(v), esperado, `falló: ${v} -> ${normalizePhone(v)}`);
  }
});

test('números distintos NO colisionan', () => {
  assert.notStrictEqual(normalizePhone('3541623456'), normalizePhone('3541623457'));
  assert.notStrictEqual(normalizePhone('3541623456'), normalizePhone('3515123456'));
});

test('validez', () => {
  assert.ok(isValidPhone('+54 9 3541 623456'));
  assert.ok(!isValidPhone('123'));
  assert.ok(!isValidPhone(''));
  assert.ok(!isValidPhone(null));
});
