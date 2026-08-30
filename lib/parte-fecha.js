'use strict';

/**
 * La fecha OPERATIVA, que no es la del reloj.
 *
 * 🔴 EL TURNO TARDE CIERRA A LAS 00:05. Sus últimas cinco tildes caen en el día
 * calendario siguiente. Con `CURRENT_DATE`, el cierre del sábado aparecería como
 * parte del domingo y el tablero quedaría inservible: el sábado se vería a
 * medias y el domingo tendría movimientos de un turno que nunca existió.
 *
 * Por eso el día operativo CORTA A LAS 05:00 de Córdoba, no a medianoche. A esa
 * hora no hay nadie en el local, así que ningún turno queda partido al medio.
 *
 * 🔴 SE CALCULA SIEMPRE EN EL SERVIDOR. El cliente nunca manda la fecha: el
 * reloj de un teléfono puede estar en cualquier lado, y con él se podría
 * escribir en el parte de otro día.
 */
const ZONA = 'America/Argentina/Cordoba';
const CORTE_HORA = 5;

/** Partes de la fecha en hora de Córdoba, sin depender de la zona del proceso. */
function enCordoba(d) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t) => Number(f.find((p) => p.type === t).value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute') };
}

function fechaOperativa(d = new Date()) {
  const { y, m, d: dia, h } = enCordoba(d);
  // Se resta un día ANTES de formatear, con aritmética UTC sobre una fecha sin
  // hora: hacerlo con `setDate` sobre una fecha local arrastra la zona del
  // proceso, que en Railway es UTC y no Córdoba.
  const base = Date.UTC(y, m - 1, dia);
  const ajustada = new Date(base - (h < CORTE_HORA ? 86400000 : 0));
  return ajustada.toISOString().slice(0, 10);
}

/** "08:12" en hora de Córdoba: lo que se guarda en el tilde y ve la gente. */
function horaCordoba(d = new Date()) {
  const { h, min } = enCordoba(d);
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

module.exports = { fechaOperativa, horaCordoba, CORTE_HORA, ZONA };
