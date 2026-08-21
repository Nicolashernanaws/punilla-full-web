// Configuración del sorteo. Todo lo que Nico puede querer cambiar sin tocar
// código vive acá y se puede pisar por variable de entorno.

/**
 * Cuánto hay que gastar para llevarse UNA chance.
 *
 * ⚠️ 25000 es PROVISORIO: Nico lo confirma contra el ticket promedio del POS.
 * Vive en una sola constante justamente para que cambiarlo sea una variable de
 * entorno en Railway y no una cacería de números por todo el repo.
 *
 * Ojo al cambiarlo con la campaña andando: las jugadas ya cargadas guardan las
 * chances que se calcularon en su momento y NO se recalculan. Es a propósito
 * (al vecino no se le sacan chances que ya le mostramos), pero significa que
 * mover el umbral a mitad de campaña deja dos criterios conviviendo.
 */
export const UMBRAL = Number(process.env.SORTEO_UMBRAL || 25000);

/** Cierre de la ventana de carga: domingo 23/8 23:00, hora de Argentina. */
export const CIERRE = new Date(process.env.SORTEO_CIERRE || '2026-08-23T23:00:00-03:00');

/** Lucy suma chances pero no cuenta para el ×2 (ver `chances.js`). */
export const COMERCIOS = ['punilla', 'tomato', 'lucy'];

/** Qué se lleva cada puesto. Se muestra al proyectar el resultado el lunes. */
export const PREMIOS = {
  1: 'Campera de cuero — Lucy Camperas',
  2: 'Cena para dos — Tomato',
  3: 'Compra de $25.000 — Punilla Full',
  4: 'Compra de $25.000 — Punilla Full',
};

export const ADMIN_KEY = process.env.ADMIN_KEY || '';
export const PORT = Number(process.env.PORT || 3000);
