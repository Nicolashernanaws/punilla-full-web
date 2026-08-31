'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// El front de /parte. Es un archivo grande y de una sola pieza, así que lo que
// se fija acá es que no vuelva a colarse lo que se sacó: la capa de persistencia
// del artifact y el nombre escrito a mano.

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'parte.html'), 'utf8');

test('🔴 no queda nada de la persistencia del artifact', () => {
  // Guardaba en la nube de Claude, que sólo abren cuentas de la organización.
  for (const rastro of ['claude.use', 'onSnapshot', 'docRef', 'db.doc(']) {
    assert.equal(html.includes(rastro), false, 'quedó ' + rastro);
  }
});

test('habla con la API propia', () => {
  // El helper arma la URL como '/parte/api/' + ruta, así que se chequean las dos
  // mitades por separado en vez de la cadena entera.
  assert.ok(html.includes("'/parte/api/' + ruta"), 'falta el helper api()');
  for (const ruta of ["api('dia')", "api('evento'", "api('traspaso')", '/parte/api/login']) {
    assert.ok(html.includes(ruta), 'falta ' + ruta);
  }
});

test('🔴 el nombre viene del servidor, no lo escribe la persona', () => {
  // Antes se tecleaba libre: cualquiera podía firmar con el nombre de otro, y
  // el parte vale justamente porque dice QUIÉN dijo que algo se hizo.
  assert.equal(html.includes('pedirNombre'), false);
  assert.ok(html.includes('pedirPin'));
  assert.ok(html.includes('type = \'password\''));
});

test('🔴 el 429 del login se le explica a la persona', () => {
  // Si sólo dijera "error", volvería a probar y se comería la ventana entera.
  assert.match(html, /status === 429[\s\S]{0,400}Esperá 15 minutos/);
});

test('🔴 la cola sobrevive a quedarse sin conexión (criterio 6)', () => {
  assert.ok(html.includes('pf_cola'));
  assert.match(html, /sin conexión · se guarda igual/);
  // Y se reintenta cuando vuelve la red.
  assert.match(html, /addEventListener\('online', drenarCola\)/);
});

test('destildar manda un evento propio, no borra el tilde', () => {
  assert.match(html, /evento\(estaba \? 'destilde' : 'tilde', it\.id\)/);
});

test('los campos de texto mantienen el debounce de 400 ms', () => {
  assert.match(html, /setTimeout\(\(\) => evento\(tipo, itemId, valor\), 400\)/);
});

test('el poll para ver lo que cargó el otro es cada 20 s', () => {
  assert.match(html, /setInterval\([\s\S]{0,120}20000\)/);
});

test('salir cierra la sesión del servidor, no sólo el localStorage', () => {
  // Si sólo borrara el localStorage, la cookie seguiría viva y el próximo que
  // agarre el teléfono escribiría con el nombre del anterior.
  assert.match(html, /\/parte\/api\/logout/);
});

test('se conserva lo que el handoff pidió no tocar', () => {
  // Las listas, el bloque de cierre, el traspaso y el filtrado por puesto.
  assert.ok(html.includes('bloqueCierre'), 'bloqueCierre');
  assert.ok(html.includes('Armar traspaso') || html.includes('btnWA'), 'traspaso');
  assert.match(html, /LISTAS\.filter\(L => L\.id === yo\.puesto \|\| L\.reglas\)/);
});
