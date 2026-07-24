'use strict';
const crypto = require('crypto');

// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L) — fácil de leer/dictar en caja.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Código corto humano para mostrar en caja: PF-XXXX.
 * La unicidad la garantiza el índice UNIQUE en la DB + reintento ante colisión.
 */
function shortCode() {
  const bytes = crypto.randomBytes(4);
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return 'PF-' + s;
}

/**
 * Firma HMAC del código: prueba que el cupón salió de NUESTRO servidor y no fue
 * fabricado. Se guarda junto al registro y puede viajar en un link de verificación.
 * El canje real es por lookup del código en la DB (fuente de verdad), esto es
 * la capa de "código firmado" que pide el spec.
 */
function signCode(code, secret) {
  return crypto.createHmac('sha256', secret).update(code).digest('base64url').slice(0, 16);
}

function verifyCode(code, token, secret) {
  const expected = signCode(code, secret);
  // comparación en tiempo constante
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { shortCode, signCode, verifyCode, ALPHABET };
