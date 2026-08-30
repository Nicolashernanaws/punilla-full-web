'use strict';
const crypto = require('crypto');

/**
 * Sesión del Parte: una cookie firmada con HMAC. Sin dependencias nuevas — el
 * repo tiene express y pg y nada más, y para esto alcanza con `crypto`.
 *
 * 🔴 EL PUESTO VIVE EN LA COOKIE, NUNCA EN EL BODY. Con PIN de 4 dígitos, dejar
 * que el cliente diga qué puesto es sería habilitar a fiambrería mañana a
 * tildarle la lista a fiambrería tarde cambiando un campo del request. La cookie
 * está firmada: si alguien la edita, la firma no cierra y la sesión se cae.
 *
 * La firma es sobre el payload EXACTO que se manda, y se compara en tiempo
 * constante para no filtrar por cuánto tarda en fallar.
 */
const DURACION_MS = 16 * 3600 * 1000; // el turno más largo entra holgado
const COOKIE = 'parte_sess';

function firmar(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function crearToken(datos, secret, ahora = Date.now()) {
  const payload = { ...datos, exp: ahora + DURACION_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b64 + '.' + firmar(b64, secret);
}

/** `null` ante cualquier problema: firma mala, vencida o basura. Nunca lanza. */
function leerToken(token, secret, ahora = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const b64 = token.slice(0, i);
  const firma = token.slice(i + 1);
  const esperada = firmar(b64, secret);
  const a = Buffer.from(esperada);
  const b = Buffer.from(firma);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let datos;
  try {
    datos = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!datos || typeof datos.exp !== 'number' || datos.exp < ahora) return null;
  return datos;
}

/** Parsea la cookie a mano: no hay cookie-parser en el repo y no hace falta. */
function cookieDe(req, nombre = COOKIE) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function cabeceraCookie(token, { secure = true } = {}) {
  const partes = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/parte',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(DURACION_MS / 1000)}`,
  ];
  if (secure) partes.push('Secure');
  return partes.join('; ');
}

function cabeceraBorrar({ secure = true } = {}) {
  const partes = [`${COOKIE}=`, 'Path=/parte', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) partes.push('Secure');
  return partes.join('; ');
}

// ── PIN ──────────────────────────────────────────────────────────────────────
//
// scrypt con salt por persona. 4 dígitos son 10.000 combinaciones: el hash NO
// alcanza como defensa, por eso el rate limit del login es obligatorio y no
// opcional. El hash protege el caso de que se filtre la tabla.
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const dk = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `scrypt$${salt}$${dk}`;
}

function verificarPin(pin, hash) {
  const partes = String(hash || '').split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  const esperado = Buffer.from(partes[2], 'hex');
  const dado = crypto.scryptSync(String(pin), partes[1], 32);
  return esperado.length === dado.length && crypto.timingSafeEqual(esperado, dado);
}

module.exports = {
  COOKIE, DURACION_MS,
  crearToken, leerToken, cookieDe, cabeceraCookie, cabeceraBorrar,
  hashPin, verificarPin,
};
