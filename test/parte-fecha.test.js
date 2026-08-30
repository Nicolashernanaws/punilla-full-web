'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fechaOperativa, horaCordoba } = require('../lib/parte-fecha');

// La fecha operativa corta a las 05:00 de Córdoba, no a medianoche.
//
// 🔴 EL CASO QUE LA JUSTIFICA: el turno tarde cierra a las 00:05, así que sus
// últimas tildes caen en el día calendario siguiente. Si se usara la fecha del
// reloj, el cierre del sábado aparecería como parte del domingo.

// Córdoba es UTC-3 todo el año.
const cba = (iso) => new Date(iso + '-03:00');

test('media tarde es el día que uno diría', () => {
  assert.equal(fechaOperativa(cba('2026-08-30T15:00')), '2026-08-30');
});

test('🔴 una tilde a las 00:03 del domingo es del SÁBADO', () => {
  // Criterio de aceptación 2 del handoff.
  assert.equal(fechaOperativa(cba('2026-08-31T00:03')), '2026-08-30');
});

test('a las 04:59 sigue siendo el día anterior', () => {
  assert.equal(fechaOperativa(cba('2026-08-31T04:59')), '2026-08-30');
});

test('a las 05:00 ya es el día nuevo', () => {
  assert.equal(fechaOperativa(cba('2026-08-31T05:00')), '2026-08-31');
});

test('cruza fin de mes hacia atrás', () => {
  assert.equal(fechaOperativa(cba('2026-09-01T02:00')), '2026-08-31');
});

test('cruza fin de año hacia atrás', () => {
  assert.equal(fechaOperativa(cba('2027-01-01T01:00')), '2026-12-31');
});

test('🔴 no depende de la zona del proceso', () => {
  // Railway corre en UTC. Las 02:00 de Córdoba son las 05:00 UTC del mismo día:
  // si se calculara con el reloj del server, daría el día equivocado.
  assert.equal(fechaOperativa(new Date('2026-08-31T05:00:00Z')), '2026-08-30');
});

test('horaCordoba devuelve la hora local, no la del server', () => {
  assert.equal(horaCordoba(new Date('2026-08-30T11:12:00Z')), '08:12');
});
