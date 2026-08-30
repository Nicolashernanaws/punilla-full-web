'use strict';
/**
 * Alta de las personas del Parte con su PIN.
 *
 * 🔴 LOS PIN SE IMPRIMEN UNA SOLA VEZ Y NO SE GUARDAN EN CLARO EN NINGÚN LADO.
 * Ni en la base, ni en un archivo, ni en el log del deploy. Se generan al azar,
 * salen por consola, y Nico los reparte en mano. Si se pierde uno, se corre
 * `--reset` para esa persona y sale uno nuevo: no hay forma de recuperarlo, y
 * eso es a propósito.
 *
 * Uso:
 *   node scripts/parte-seed.js                 # simulación: dice qué haría
 *   node scripts/parte-seed.js --confirmar     # da de alta a los que faltan
 *   node scripts/parte-seed.js --confirmar --reset "Julián:enc_m"
 */
const crypto = require('crypto');
const { pool, query } = require('../db/db');
const { hashPin } = require('../lib/parte-sesion');

// Julián y Vanesa van en los dos turnos: rotan, y el PIN identifica a la
// persona DENTRO del puesto. Los de fiambrería y producción los define Nico.
const PERSONAS = [
  { nombre: 'Julián', puesto: 'enc_m' },
  { nombre: 'Vanesa', puesto: 'enc_m' },
  { nombre: 'Julián', puesto: 'enc_t' },
  { nombre: 'Vanesa', puesto: 'enc_t' },
];

// Los que faltan definir. Se listan para que no se olviden, pero no se crean:
// dar de alta a "a definir" sería repartir un PIN que no es de nadie.
const A_DEFINIR = ['fiam_m', 'fiam_t', 'prod'];

/** PIN de 4 dígitos con aleatoriedad criptográfica, no Math.random. */
function pinAlAzar() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function main() {
  const args = process.argv.slice(2);
  const confirmar = args.includes('--confirmar');
  const reset = (args.find((a) => a.startsWith('--reset')) ? args[args.indexOf('--reset') + 1] : null) || null;

  const { rows: existentes } = await query(
    'SELECT id, nombre, puesto, activo FROM parte_persona ORDER BY puesto, nombre',
  );
  const clave = (n, p) => `${n}:${p}`;
  const yaEstan = new Set(existentes.map((e) => clave(e.nombre, e.puesto)));

  const aCrear = PERSONAS.filter((p) => !yaEstan.has(clave(p.nombre, p.puesto)));

  console.log(`\nYa cargadas: ${existentes.length}`);
  for (const e of existentes) console.log(`   ${e.activo ? ' ' : '✗'} ${e.puesto.padEnd(7)} ${e.nombre}`);
  console.log(`\nA dar de alta: ${aCrear.length}`);
  for (const p of aCrear) console.log(`   + ${p.puesto.padEnd(7)} ${p.nombre}`);
  if (reset) console.log(`\nA regenerar el PIN: ${reset}`);
  console.log(`\nPuestos sin gente definida: ${A_DEFINIR.join(', ')}`);
  console.log('   (no se crean: repartir un PIN que no es de nadie no sirve)');

  if (!confirmar) {
    console.log('\n>> SIMULACIÓN. No se escribió nada. Repetí con --confirmar.');
    return;
  }

  const nuevos = [];
  for (const p of aCrear) {
    const pin = pinAlAzar();
    const { rows } = await query(
      `INSERT INTO parte_persona (nombre, puesto, pin_hash) VALUES ($1,$2,$3) RETURNING id`,
      [p.nombre, p.puesto, hashPin(pin)],
    );
    nuevos.push({ ...p, pin, id: rows[0].id });
  }

  if (reset) {
    const [nombre, puesto] = reset.split(':');
    const pin = pinAlAzar();
    const { rowCount } = await query(
      `UPDATE parte_persona SET pin_hash = $3 WHERE nombre = $1 AND puesto = $2`,
      [nombre, puesto, hashPin(pin)],
    );
    if (rowCount) nuevos.push({ nombre, puesto, pin, id: '(reset)' });
    else console.log(`\n⚠ No encontré a ${reset}`);
  }

  if (!nuevos.length) {
    console.log('\n>> Nada que hacer: ya estaban todos.');
    return;
  }

  console.log('\n' + '='.repeat(46));
  console.log('  PIN — SE MUESTRAN UNA SOLA VEZ. Anotalos ahora.');
  console.log('='.repeat(46));
  for (const n of nuevos) console.log(`  ${n.puesto.padEnd(7)} ${n.nombre.padEnd(10)} ${n.pin}`);
  console.log('='.repeat(46));
  console.log('  No quedan guardados en ningún lado. Si se pierde uno,');
  console.log('  se regenera con --reset "Nombre:puesto".\n');
}

main()
  .catch((e) => {
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
