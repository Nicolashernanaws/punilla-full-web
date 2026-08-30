'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crearToken, leerToken, cookieDe, cabeceraCookie, hashPin, verificarPin, DURACION_MS,
} = require('../lib/parte-sesion');

const SECRET = 'secreto-de-prueba';

test('un token propio se lee de vuelta', () => {
  const t = crearToken({ personaId: 3, puesto: 'fiam_m', nombre: 'Vanesa' }, SECRET);
  const d = leerToken(t, SECRET);
  assert.equal(d.puesto, 'fiam_m');
  assert.equal(d.nombre, 'Vanesa');
});

test('🔴 un token manoseado no vale', () => {
  // Es lo que impide que fiambrería mañana se haga pasar por fiambrería tarde.
  const t = crearToken({ personaId: 3, puesto: 'fiam_m' }, SECRET);
  const payload = Buffer.from(JSON.stringify({ personaId: 3, puesto: 'fiam_t', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(leerToken(payload + '.' + t.split('.')[1], SECRET), null);
});

test('un token firmado con otro secreto no vale', () => {
  assert.equal(leerToken(crearToken({ puesto: 'prod' }, 'otro'), SECRET), null);
});

test('un token vencido no vale', () => {
  const t = crearToken({ puesto: 'prod' }, SECRET, Date.now() - DURACION_MS - 1000);
  assert.equal(leerToken(t, SECRET), null);
});

test('basura no rompe, devuelve null', () => {
  for (const x of ['', 'a.b', null, undefined, 'sin-punto', {}]) {
    assert.equal(leerToken(x, SECRET), null);
  }
});

test('la cookie se lee de entre otras', () => {
  const req = { headers: { cookie: 'otra=1; parte_sess=abc%2Fdef; mas=2' } };
  assert.equal(cookieDe(req), 'abc/def');
});

test('sin cookies devuelve null', () => {
  assert.equal(cookieDe({ headers: {} }), null);
});

test('la cookie sale httpOnly, sameSite y acotada a /parte', () => {
  const h = cabeceraCookie('tok');
  for (const x of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/parte']) assert.ok(h.includes(x), x);
});

test('🔴 el PIN nunca se guarda en claro', () => {
  const h = hashPin('4821');
  assert.ok(!h.includes('4821'));
  assert.ok(h.startsWith('scrypt$'));
});

test('el PIN correcto verifica y el incorrecto no', () => {
  const h = hashPin('4821');
  assert.equal(verificarPin('4821', h), true);
  assert.equal(verificarPin('4822', h), false);
});

test('dos personas con el mismo PIN tienen hashes distintos', () => {
  // Salt por persona: si no, la tabla filtrada delata quién comparte PIN.
  assert.notEqual(hashPin('1234'), hashPin('1234'));
});

test('un hash corrupto no verifica ni rompe', () => {
  for (const h of ['', 'x', 'scrypt$sal', null]) assert.equal(verificarPin('1234', h), false);
});
