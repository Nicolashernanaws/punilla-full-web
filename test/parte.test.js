'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aplicarEvento } = require('../lib/parte');

const VACIO = { items: {}, campos: {}, nota: '', cierre: null };
const JULI = { nombre: 'Julián', id: 1 };
const VANE = { nombre: 'Vanesa', id: 2 };
const T = new Date('2026-08-30T11:12:00Z'); // 08:12 en Córdoba

test('una tilde guarda quién y a qué hora', () => {
  const r = aplicarEvento(VACIO, { tipo: 'tilde', itemId: 'abrir_camara' }, JULI, T);
  assert.deepEqual(r.items.abrir_camara, { n: 'Julián', at: '08:12' });
});

test('🔴 dos personas tildando distinto NO se pisan', () => {
  // Criterio de aceptación 1. El cliente manda UN evento, no su copia entera
  // del estado: por eso lo que tildó el otro sobrevive.
  let e = aplicarEvento(VACIO, { tipo: 'tilde', itemId: 'a' }, JULI, T);
  e = aplicarEvento(e, { tipo: 'tilde', itemId: 'b' }, VANE, T);
  assert.deepEqual(Object.keys(e.items).sort(), ['a', 'b']);
  assert.equal(e.items.a.n, 'Julián');
  assert.equal(e.items.b.n, 'Vanesa');
});

test('🔴 destildar saca del estado (el tilde queda en el historial)', () => {
  // Criterio 3: el rastro no se borra, y eso lo garantiza parte_evento.
  let e = aplicarEvento(VACIO, { tipo: 'tilde', itemId: 'a' }, JULI, T);
  e = aplicarEvento(e, { tipo: 'destilde', itemId: 'a' }, VANE, T);
  assert.equal(e.items.a, undefined);
});

test('destildar una que no estaba no rompe', () => {
  assert.doesNotThrow(() => aplicarEvento(VACIO, { tipo: 'destilde', itemId: 'x' }, JULI, T));
});

test('un campo guarda el valor tal cual lo escribieron', () => {
  const e = aplicarEvento(VACIO, { tipo: 'campo', itemId: 'temp_mostrador', valor: '4.2' }, JULI, T);
  assert.equal(e.campos.temp_mostrador, '4.2');
});

test('🔴 vaciar un campo lo borra, no lo deja como cadena vacía', () => {
  // "No lo cargó" y "cargó vacío" son distintos, y el tablero tiene que poder
  // separarlos: uno es un pendiente, el otro no.
  let e = aplicarEvento(VACIO, { tipo: 'campo', itemId: 't', valor: '4.2' }, JULI, T);
  e = aplicarEvento(e, { tipo: 'campo', itemId: 't', valor: '  ' }, JULI, T);
  assert.equal('t' in e.campos, false);
});

test('la nota se reemplaza entera', () => {
  const e = aplicarEvento(VACIO, { tipo: 'nota', valor: 'faltó leche' }, JULI, T);
  assert.equal(e.nota, 'faltó leche');
});

test('el cierre distingue "cerró todo" de "cerró con pendientes"', () => {
  const ok = aplicarEvento(VACIO, { tipo: 'cierre', valor: 'ok' }, JULI, T);
  assert.equal(ok.cierre.estado, 'ok');
  const pend = aplicarEvento(VACIO, { tipo: 'cierre', valor: 'pend', detalle: 'falta freezer' }, JULI, T);
  assert.equal(pend.cierre.estado, 'pend');
  assert.equal(pend.cierre.detalle, 'falta freezer');
  assert.equal(pend.cierre.by, 'Julián');
});

test('cualquier valor raro de cierre cae en pendiente, nunca en ok', () => {
  // Ante la duda, pendiente: dar por cerrado algo que no se sabe es peor.
  assert.equal(aplicarEvento(VACIO, { tipo: 'cierre', valor: 'xx' }, JULI, T).cierre.estado, 'pend');
});

test('reabrir saca el cierre y deja las tildes', () => {
  let e = aplicarEvento(VACIO, { tipo: 'tilde', itemId: 'a' }, JULI, T);
  e = aplicarEvento(e, { tipo: 'cierre', valor: 'ok' }, JULI, T);
  e = aplicarEvento(e, { tipo: 'reapertura' }, VANE, T);
  assert.equal(e.cierre, null);
  assert.ok(e.items.a);
});

test('un tipo desconocido tira, no escribe cualquier cosa', () => {
  assert.throws(() => aplicarEvento(VACIO, { tipo: 'borrar_todo' }, JULI, T));
});

test('tilde y campo sin itemId tiran', () => {
  assert.throws(() => aplicarEvento(VACIO, { tipo: 'tilde' }, JULI, T));
  assert.throws(() => aplicarEvento(VACIO, { tipo: 'campo' }, JULI, T));
});

test('no muta el estado que recibe', () => {
  const base = { items: { a: { n: 'x', at: '01:00' } }, campos: {}, nota: '', cierre: null };
  aplicarEvento(base, { tipo: 'tilde', itemId: 'b' }, JULI, T);
  assert.deepEqual(Object.keys(base.items), ['a']);
});
