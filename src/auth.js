// Autenticación del admin del sorteo.
import crypto from 'node:crypto';
import { ADMIN_KEY } from './config.js';

/**
 * ¿El request trae la ADMIN_KEY?
 *
 * Comparación en tiempo constante: `===` sobre un secreto filtra, por el tiempo
 * que tarda en cortar, cuántos caracteres del principio acertaste. Con una key
 * que además hay que rotar (venía sin rotar desde las pruebas de julio), no
 * cuesta nada hacerlo bien.
 *
 * Si `ADMIN_KEY` está vacía, NADIE es admin. Es deliberado: un default abierto
 * en producción es peor que un admin que no entra.
 */
export function esAdmin(req) {
  const dada = req?.get?.('x-admin-key') ?? '';
  if (!ADMIN_KEY || !dada) return false;
  const a = Buffer.from(String(dada));
  const b = Buffer.from(String(ADMIN_KEY));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
