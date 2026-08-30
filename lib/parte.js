'use strict';
const { horaCordoba } = require('./parte-fecha');

/**
 * Cómo un evento cambia el estado del parte.
 *
 * 🔴 SE MERGEA, NUNCA SE REEMPLAZA EL OBJETO ENTERO. Dos teléfonos del mismo
 * puesto tildando al mismo tiempo es el caso normal, no el raro: si cada uno
 * mandara su copia completa de `items`, el último en llegar pisaría lo que el
 * otro acaba de tildar y la tilde desaparecería de la pantalla sin que nadie
 * entienda por qué. Por eso el cliente manda UN evento —"tildé ésta"— y el
 * servidor lo aplica sobre lo que hay en la base, dentro de una transacción con
 * `SELECT … FOR UPDATE`.
 *
 * Esta función es la parte pura: recibe el estado leído y el evento, devuelve el
 * estado nuevo. La transacción y el lock viven en la ruta.
 */
const TIPOS = ['tilde', 'destilde', 'campo', 'nota', 'cierre', 'reapertura'];

function aplicarEvento(estado, evento, persona, ahora = new Date()) {
  const { tipo, itemId, valor } = evento;
  if (!TIPOS.includes(tipo)) throw new Error('tipo de evento desconocido: ' + tipo);

  const items = { ...(estado.items || {}) };
  const campos = { ...(estado.campos || {}) };
  let nota = estado.nota || '';
  let cierre = estado.cierre || null;

  switch (tipo) {
    case 'tilde':
      if (!itemId) throw new Error('falta itemId');
      // Se guarda QUIÉN y A QUÉ HORA, no un booleano: el valor del parte está en
      // poder decir quién dijo que esto se hizo.
      items[itemId] = { n: persona.nombre, at: horaCordoba(ahora) };
      break;

    case 'destilde':
      if (!itemId) throw new Error('falta itemId');
      // 🔴 Se saca del estado, pero el `tilde` original QUEDA en parte_evento.
      // El estado dice cómo está la lista; el historial dice qué pasó, y son
      // dos preguntas distintas.
      delete items[itemId];
      break;

    case 'campo':
      if (!itemId) throw new Error('falta itemId');
      // Un campo vaciado se borra en vez de guardarse como cadena vacía: así
      // "no lo cargó" y "cargó vacío" no se confunden en el tablero.
      if (valor == null || String(valor).trim() === '') delete campos[itemId];
      else campos[itemId] = String(valor);
      break;

    case 'nota':
      nota = String(valor == null ? '' : valor);
      break;

    case 'cierre':
      cierre = {
        // 'ok' cerró todo · 'pend' cerró con pendientes. Se distingue a
        // propósito: cerrar con pendientes es válido, ocultarlos no.
        estado: valor === 'ok' ? 'ok' : 'pend',
        by: persona.nombre,
        at: horaCordoba(ahora),
        detalle: evento.detalle == null ? null : String(evento.detalle),
      };
      break;

    case 'reapertura':
      cierre = null;
      break;
  }

  return { items, campos, nota, cierre };
}

/** Cuántas tildes tiene el parte. El total lo sabe el front, que tiene la lista. */
function progreso(estado) {
  return Object.keys((estado && estado.items) || {}).length;
}

module.exports = { aplicarEvento, progreso, TIPOS };
