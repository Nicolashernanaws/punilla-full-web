'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitPorClave, PUESTOS, TRASPASO } = require('../lib/parte-rutas');
const { crearToken, leerToken } = require('../lib/parte-sesion');
const fs = require('node:fs');
const path = require('node:path');

// Los criterios de aceptación que se pueden fijar sin levantar Postgres.
// Los que necesitan base (merge concurrente real) van en el ensayo manual del
// README: acá se fija la FORMA, que es lo que se rompe al refactorizar.

const SECRET = 'secreto-de-prueba';

test('🔴 seis intentos seguidos devuelven 429 (criterio 5)', () => {
  // Un PIN de 4 dígitos son 10.000 combinaciones: sin freno se rompe en
  // minutos, y en los campos del parte hay montos de caja.
  const mw = rateLimitPorClave(5, 60_000);
  const req = { headers: {}, ip: '1.2.3.4', body: { puesto: 'enc_m' } };
  let ultimo = 0;
  const res = { status(c) { ultimo = c; return this; }, json() { return this; } };
  let pasaron = 0;
  for (let i = 0; i < 6; i++) mw(req, res, () => pasaron++);
  assert.equal(pasaron, 5);
  assert.equal(ultimo, 429);
});

test('🔴 el freno es por IP Y PUESTO, no sólo por IP', () => {
  // El local sale por una sola IP: si fuera sólo por IP, un ataque contra un
  // puesto dejaría sin login a todos los demás.
  const mw = rateLimitPorClave(2, 60_000);
  const res = { status() { return this; }, json() { return this; } };
  let ok = 0;
  const golpe = (puesto) => mw({ headers: {}, ip: '1.1.1.1', body: { puesto } }, res, () => ok++);
  golpe('enc_m'); golpe('enc_m'); golpe('enc_m'); // el tercero se frena
  golpe('fiam_t');                                 // otro puesto, sigue pasando
  assert.equal(ok, 3);
});

test('la ventana del freno se libera con el tiempo', () => {
  const mw = rateLimitPorClave(1, 30);
  const res = { status() { return this; }, json() { return this; } };
  let ok = 0;
  const req = { headers: {}, ip: '9.9.9.9', body: { puesto: 'prod' } };
  mw(req, res, () => ok++);
  mw(req, res, () => ok++); // frenado
  return new Promise((r) => setTimeout(r, 45)).then(() => {
    mw(req, res, () => ok++);
    assert.equal(ok, 2);
  });
});

test('🔴 el puesto de la sesión no se puede falsificar (criterio 4)', () => {
  // Fiambrería mañana no puede escribir en el parte de fiambrería tarde ni
  // cambiando el body: el puesto sale de la cookie firmada, y el body se ignora.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // El handler de evento toma el puesto de req.parte (la cookie), nunca de req.body.
  assert.match(rutas, /const \{ puesto, personaId, nombre \} = req\.parte;/);
  assert.doesNotMatch(rutas, /puesto\s*=\s*req\.body\.puesto/);
  assert.doesNotMatch(rutas, /req\.body\?\.puesto[\s\S]{0,80}INSERT INTO parte_dia/);
});

test('🔴 la fecha la pone el servidor, nunca el cliente (criterio 2)', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // No hay ningún lugar donde la fecha del parte salga del body.
  assert.doesNotMatch(rutas, /fecha\s*=\s*req\.body/);
  // Y el handler de evento la calcula.
  assert.match(rutas, /const fecha = fechaOperativa\(\);[\s\S]{0,200}req\.parte;/);
});

test('🔴 parte_evento nunca se hace UPDATE ni DELETE (criterio 3)', () => {
  // Es el historial. Destildar escribe un `destilde`, no borra el `tilde`.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.doesNotMatch(rutas, /UPDATE parte_evento/i);
  assert.doesNotMatch(rutas, /DELETE FROM parte_evento/i);
  assert.match(rutas, /INSERT INTO parte_evento/);
});

test('🔴 el evento se aplica con SELECT … FOR UPDATE (criterio 1)', () => {
  // Sin el lock, dos teléfonos leen el mismo estado y el segundo pisa al
  // primero: la tilde del otro desaparece sin que nadie entienda por qué.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /FOR UPDATE/);
  assert.match(rutas, /withTx\(/);
});

test('el traspaso es de la tarde y sólo lectura', () => {
  assert.deepEqual(TRASPASO, { enc_t: 'enc_m', fiam_t: 'fiam_m' });
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // La ruta de traspaso no escribe nada.
  const bloque = rutas.slice(rutas.indexOf("'/api/traspaso'"), rutas.indexOf("admin/api/dia"));
  assert.doesNotMatch(bloque, /INSERT|UPDATE|DELETE/);
});

test('los cinco puestos son los del handoff', () => {
  assert.deepEqual(PUESTOS, ['enc_m', 'enc_t', 'fiam_m', 'fiam_t', 'prod']);
});

test('una sesión de un puesto no sirve para otro', () => {
  const t = crearToken({ personaId: 1, puesto: 'fiam_m', nombre: 'X' }, SECRET);
  assert.equal(leerToken(t, SECRET).puesto, 'fiam_m');
});

// ── El freno compartido (medido en producción el 30/8) ──────────────────────
//
// 🔴 EL CONTADOR EN MEMORIA NO ALCANZABA. Railway corre más de una réplica y
// cada una tiene su propio Map: el límite efectivo era 5 × réplicas, y esa
// cantidad cambia sin avisar. Se vio en prod — 6 intentos seguidos dieron
// 401,401,401,429,401,429: el round-robin repartía los golpes entre dos.
const { huella, FRENO_MAX, FRENO_MINUTOS } = require('../lib/parte-rutas');

test('🔴 el freno de verdad cuenta en la base, no en memoria', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /FROM parte_evento\s*\n\s*WHERE tipo = 'login_fallido'/);
  // Y se chequea ANTES de comparar el PIN, no después.
  assert.match(rutas, /frenadoEnBase\(puesto, ipCliente\(req\)\)[\s\S]{0,200}SELECT id, nombre, pin_hash/);
});

test('🔴 se cuenta por puesto Y huella de IP, no sólo por puesto', () => {
  // Si fuera sólo por puesto, cualquiera podría dejar a Julián sin poder entrar
  // tirando PINs al azar desde afuera.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /COUNT\(\*\) FILTER \(WHERE valor = \$2\)::int AS por_ip/);
});

test('la IP no se guarda en claro', () => {
  const h = huella('190.55.1.2');
  assert.equal(h.length, 12);
  assert.equal(h.includes('190'), false);
  assert.notEqual(h, huella('190.55.1.3'));
});

test('el intento fallido queda anotado en la línea de tiempo', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /INSERT INTO parte_evento[\s\S]{0,80}'login_fallido'/);
});

test('el freno son 5 intentos en 15 minutos', () => {
  assert.equal(FRENO_MAX, 5);
  assert.equal(FRENO_MINUTOS, 15);
});

// ── La IP del cliente (medido en produccion el 30/8) ────────────────────────
const { ipCliente, FRENO_PUESTO_MAX } = require('../lib/parte-rutas');

test('🔴 la IP sale del PRIMER X-Forwarded-For, no de req.ip', () => {
  // Ocho intentos desde la misma máquina quedaron anotados con DOS huellas
  // distintas: con `trust proxy 1` Express toma el último salto —el proxy de
  // Railway, que rota— y el contador por IP nunca llegaba a cinco.
  const req = { headers: { 'x-forwarded-for': '190.55.1.2, 10.0.0.7, 10.0.0.9' }, ip: '10.0.0.9' };
  assert.equal(ipCliente(req), '190.55.1.2');
});

test('sin cabecera cae en req.ip', () => {
  assert.equal(ipCliente({ headers: {}, ip: '1.2.3.4' }), '1.2.3.4');
});

test('sin nada devuelve cadena vacía, no rompe', () => {
  assert.equal(ipCliente({ headers: {} }), '');
});

test('🔴 hay un tope por PUESTO además del de IP', () => {
  // El primer X-Forwarded-For lo escribe el cliente y se puede falsificar
  // rotándolo. Éste no se puede esquivar.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /por_puesto >= FRENO_PUESTO_MAX/);
});

test('el tope por puesto es alto a propósito', () => {
  // Uno bajo dejaría a Julián sin poder entrar con que alguien tire PINs desde
  // afuera. Con 30 cada 15 min, agotar las 10.000 combinaciones lleva 80+ horas.
  assert.equal(FRENO_PUESTO_MAX, 30);
  assert.ok(FRENO_PUESTO_MAX > FRENO_MAX * 4);
});
