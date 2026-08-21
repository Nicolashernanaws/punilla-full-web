// Normalización de teléfonos argentinos.
//
// El formato lo fija la tabla `fundadores`, que ya tiene 75 filas cargadas de la
// campaña anterior: 10 dígitos, sin +54, sin el 9 de celular, sin el 0 de larga
// distancia y sin el 15. Ej: 3541267595.
//
// POR QUÉ IMPORTA TANTO: el teléfono es la CLAVE PRIMARIA del participante. Si
// el mismo vecino carga un ticket como "3541 15 267595" y otro como
// "+5493541267595" y no normalizan igual, quedan como dos personas distintas,
// cada una con sus chances, y el ×2 de punilla+tomato nunca se activa.

/** Códigos de área argentinos: 2, 3 o 4 dígitos. */
const LARGOS_DE_AREA = [2, 3, 4];

/**
 * Devuelve el teléfono en 10 dígitos, o `null` si no es un argentino válido.
 *
 * `null` y no una cadena vacía a propósito: el endpoint tiene que poder
 * distinguir "no lo pude leer" de "no lo mandaron", y contestar distinto.
 */
export function normalizarTelefono(raw) {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/\D/g, '');
  if (!d) return null;

  // Prefijo de discado internacional (00 54 …).
  if (d.startsWith('00')) d = d.slice(2);
  // 0 de larga distancia nacional (0 3541 …).
  if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  // Código de país.
  if (d.length > 10 && d.startsWith('54')) d = d.slice(2);
  // El 9 que va entre el país y el área en los celulares (+54 9 3541 …).
  if (d.length > 10 && d.startsWith('9')) d = d.slice(1);

  // El 15 va DESPUÉS del código de área, así que hay que saber cuánto mide.
  // Se prueban los tres largos posibles y se saca el 15 sólo si eso deja
  // exactamente 10 dígitos: si no cierra, es preferible rechazar el número a
  // inventar un recorte que arme un teléfono de otra persona.
  if (d.length === 12) {
    for (const area of LARGOS_DE_AREA) {
      if (d.slice(area, area + 2) === '15') {
        d = d.slice(0, area) + d.slice(area + 2);
        break;
      }
    }
  }

  return /^[1-9]\d{9}$/.test(d) ? d : null;
}
