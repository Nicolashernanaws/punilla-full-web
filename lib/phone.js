'use strict';
/**
 * Normalización de teléfonos argentinos para DEDUPE.
 *
 * Objetivo (spec v2 §3): que el mismo número escrito con o sin +54, 9, 0 y 15
 * colisione en un único valor canónico. El NSN (número significativo nacional)
 * argentino SIEMPRE tiene 10 dígitos = código de área (2–4) + abonado.
 *
 *   +54 9 3541 623456   ->  3541623456
 *   0 3541 15 623456    ->  3541623456
 *   3541 15-62 34 56    ->  3541623456
 *   3541-623456         ->  3541623456
 *   +5493541623456      ->  3541623456
 *
 * Estrategia:
 *   1. Dejar solo dígitos.
 *   2. Sacar prefijo internacional 00 y país 54.
 *   3. Sacar el 9 de móvil y el 0 de trunk.
 *   4. Sacar el 15 insertado después del código de área (usa tabla de áreas;
 *      el 15 solo existe cuando la longitud queda en 12 = NSN(10) + 15).
 *   5. Canónico = últimos 10 dígitos.
 *
 * Nota: la tabla cubre el Valle de Punilla, Córdoba y las áreas grandes del país
 * (la abrumadora mayoría de una campaña local + turistas de CABA/Córdoba/Rosario).
 * Para un código de área raro CON formato 15 el 15 puede no removerse; se documenta.
 */

// Códigos de área AR relevantes, ordenados por longitud desc para hacer
// "longest prefix match". Punilla y Córdoba primero por ser el grueso local.
const AREA_CODES = [
  // Valle de Punilla / Sierras (4 dígitos)
  '3541', // Cosquín, La Falda, Villa Carlos Paz zona
  '3542', // Capilla del Monte, La Cumbre
  '3544', // Villa Carlos Paz
  '3543', // Alta Gracia
  '3548', // Jesús María / Colonia Caroya
  '3549', '3546', '3547', '3521', '3522', '3524', '3525', '3532', '3533',
  '3562', '3563', '3564', '3571', '3572', '3573', '3574', '3575', '3576',
  '3582', '3583', '3584', '3585',
  // Otras provincias (4 dígitos) — muestra de turistas frecuentes
  '2604', '2622', '2646', '2652', '2657', '2901', '2920', '2966', '2972', '2983',
  '3705', '3711', '3715', '3716', '3718', '3721', '3725', '3731', '3734', '3741',
  '3751', '3754', '3757', '3758', '3772', '3773', '3774', '3775', '3777', '3781',
  '3782', '3821', '3825', '3826', '3827', '3835', '3837', '3841', '3843', '3844',
  '3845', '3846', '3854', '3855', '3856', '3857', '3858', '3861', '3862', '3863',
  '3865', '3867', '3868', '3869', '3873', '3876', '3877', '3878', '3885', '3886',
  '3887', '3888', '3891', '3892', '3894',
  // 3 dígitos (capitales / grandes)
  '351', // Córdoba capital
  '341', // Rosario
  '342', // Santa Fe
  '343', // Paraná
  '345', // Concordia
  '336', // San Nicolás
  '353', // Villa María
  '358', // Río Cuarto
  '260', '261', '263', '264', '266', '280', '291', '294', '297', '299',
  '370', '379', '380', '381', '383', '385', '387', '388',
  '221', // La Plata
  '223', // Mar del Plata
  '230', '236', '237', '249', '264', '299',
  // 2 dígitos
  '11', // CABA / GBA
];

// Orden longest-first para el prefix match.
const AREA_SORTED = [...new Set(AREA_CODES)].sort((a, b) => b.length - a.length);

/**
 * Quita el "15" insertado justo después del código de área, cuando la longitud
 * indica que hay un 15 (12 dígitos = NSN de 10 + los 2 del 15).
 */
function stripInserted15(d) {
  if (d.length !== 12) return d; // el 15 insertado siempre deja 12 dígitos
  for (const area of AREA_SORTED) {
    if (d.startsWith(area) && d.slice(area.length, area.length + 2) === '15') {
      return d.slice(0, area.length) + d.slice(area.length + 2);
    }
  }
  // Fallback: no matcheó un área conocida pero hay 12 dígitos con "15" plausible.
  // Probamos removerlo en las fronteras de área válidas (2,3,4) que dejen 10.
  for (const pos of [4, 3, 2]) {
    if (d.slice(pos, pos + 2) === '15') return d.slice(0, pos) + d.slice(pos + 2);
  }
  return d;
}

/**
 * Devuelve el número canónico (string de 10 dígitos, o los que haya) para dedupe.
 * Devuelve null si no hay dígitos utilizables.
 */
function normalizePhone(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;

  // 00 internacional
  if (d.startsWith('00')) d = d.slice(2);
  // país 54 (solo si sobra longitud, para no comer un área que empiece con 54... no existe)
  if (d.startsWith('54') && d.length > 10) d = d.slice(2);
  // 9 de móvil (los códigos de área no empiezan con 9)
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);
  // 0 de trunk
  if (d.startsWith('0')) d = d.slice(1);
  // por si venía 54 9 ... y quedó un 9 pegado tras sacar el 54
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);

  // 15 insertado
  d = stripInserted15(d);

  // canónico: últimos 10 dígitos
  if (d.length >= 10) d = d.slice(-10);
  return d;
}

/**
 * ¿Es un teléfono con pinta de válido para poder mandarle WhatsApp?
 * Aceptamos 10 dígitos (NSN completo). Con menos, lo damos por inválido.
 */
function isValidPhone(raw) {
  const n = normalizePhone(raw);
  return !!n && n.length === 10;
}

/**
 * Formato E.164 para armar el link de WhatsApp del cliente si hiciera falta:
 * +54 9 <NSN>.
 */
function toE164AR(raw) {
  const n = normalizePhone(raw);
  if (!n || n.length !== 10) return null;
  return '549' + n;
}

module.exports = { normalizePhone, isValidPhone, toE164AR, stripInserted15 };
