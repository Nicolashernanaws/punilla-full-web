// Cálculo de chances del sorteo.
//
// REGLA DE ORO: el total NO se persiste, se calcula. En una campaña de 4 días,
// un total desnormalizado es la forma más rápida de que el número que ve el
// vecino en la pantalla y el padrón real del sorteo no coincidan — y eso se
// descubre el lunes, en vivo, delante de todos. Una sola fuente de verdad.

/** Chances por ticket: 1 cada $umbral, con tope. */
export const TOPE_POR_TICKET = 10;

/** Los dos comercios que activan el ×2. Lucy suma chances pero no entra acá. */
const PAR_MULTIPLICADOR = ['punilla', 'tomato'];

/**
 * Chances que da un ticket. Redondea SIEMPRE para abajo: $24.999 con umbral
 * $25.000 da cero, y esa es justamente la frustración que empuja al vecino a
 * agregar un producto más.
 */
export function chancesDeMonto(monto, umbral) {
  if (!Number.isFinite(monto) || !Number.isFinite(umbral)) return 0;
  if (monto <= 0 || umbral <= 0) return 0;
  return Math.min(TOPE_POR_TICKET, Math.floor(monto / umbral));
}

/**
 * El ×2 pide ticket de Punilla Full Y de Tomato.
 *
 * Lucy NO cuenta: es de otro rubro y lo que se comunicó es "comprá en los dos".
 * Si Lucy activara el multiplicador, la promo conjunta perdería sentido.
 */
export function tieneMultiplicador(comercios) {
  const hay = new Set(comercios ?? []);
  return PAR_MULTIPLICADOR.every((c) => hay.has(c));
}

/**
 * Total de chances de un teléfono.
 *
 * El ×2 se aplica AL FINAL, sobre todo lo acumulado (jugadas + chance gratis +
 * compartir), no sólo sobre las jugadas: es lo que se comunicó en la landing.
 */
export function totalDeChances({ jugadas = [], sinCompra = false, compartio = false } = {}) {
  const base =
    jugadas.reduce((a, j) => a + (Number(j?.chances) || 0), 0) +
    (sinCompra ? 1 : 0) +
    (compartio ? 2 : 0);
  return base * (tieneMultiplicador(jugadas.map((j) => j?.comercio)) ? 2 : 1);
}

/**
 * ¿Se puede seguir cargando?
 *
 * El cierre es exclusivo: a las 23:00:00 en punto ya está cerrado. Es lo que
 * dicen las bases ("hasta las 23:00"), y en una campaña con premio hay que
 * poder defender el corte con el reloj en la mano.
 */
export function ventanaAbierta(ahora, cierre) {
  return ahora.getTime() < cierre.getTime();
}
