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
  // Fiambrería: las tres rotan entre los dos turnos (Nico, 31/8). "Bren O." y
  // "Bren R." van con la inicial del apellido porque el nombre solo no las
  // distingue, y el parte vale justamente porque dice QUIÉN hizo cada cosa.
  { nombre: 'Abril', puesto: 'fiam_m' },
  { nombre: 'Bren O.', puesto: 'fiam_m' },
  { nombre: 'Bren R.', puesto: 'fiam_m' },
  { nombre: 'Abril', puesto: 'fiam_t' },
  { nombre: 'Bren O.', puesto: 'fiam_t' },
  { nombre: 'Bren R.', puesto: 'fiam_t' },
];

// Los que faltan definir. Se listan para que no se olviden, pero no se crean:
// dar de alta a "a definir" sería repartir un PIN que no es de nadie.
const A_DEFINIR = ['prod'];

/** PIN de 4 dígitos con aleatoriedad criptográfica, no Math.random. */
function pinAlAzar() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

/**
 * 🔴 UN PIN POR PERSONA, NO POR FILA. Julián está cargado en los dos turnos
 * (enc_m y enc_t) para poder rotar, pero es UNA persona: darle un PIN distinto
 * por turno lo obligaría a acordarse de cuál va con cuál, y el que se equivoca
 * dos veces se come el freno de 15 minutos justo cuando entra a trabajar.
 * Elige el puesto en la pantalla; el PIN es suyo y no cambia.
 *
 * 🔴 Y NO SE REPITE DENTRO DE UN PUESTO. El login prueba el PIN contra todas
 * las personas de ese puesto y se queda con la primera que cierra: si Julián y
 * Vanesa sacaran el mismo número, uno de los dos firmaría con el nombre del
 * otro y el parte diría que lo hizo quien no lo hizo.
 */
function repartirPines(personas) {
  const porPersona = new Map();
  const usadosPorPuesto = new Map();
  for (const p of personas) {
    if (!usadosPorPuesto.has(p.puesto)) usadosPorPuesto.set(p.puesto, new Set());
  }
  for (const p of personas) {
    if (!porPersona.has(p.nombre)) {
      const puestosDeEsta = personas.filter((x) => x.nombre === p.nombre).map((x) => x.puesto);
      let pin;
      let intentos = 0;
      do {
        pin = pinAlAzar();
        if (++intentos > 500) throw new Error('no encontré un PIN libre');
      } while (puestosDeEsta.some((q) => usadosPorPuesto.get(q).has(pin)));
      for (const q of puestosDeEsta) usadosPorPuesto.get(q).add(pin);
      porPersona.set(p.nombre, pin);
    }
  }
  return porPersona;
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

  // El PIN se reparte por PERSONA y después se aplica a todas sus filas: los que
  // ya estaban cargados en otro puesto no cuentan acá, porque sólo se le asigna
  // PIN a lo que se crea.
  const pines = repartirPines(aCrear);
  const nuevos = [];
  for (const p of aCrear) {
    const pin = pines.get(p.nombre);
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

  console.log('\n' + '='.repeat(52));
  console.log('  PIN — SE MUESTRAN UNA SOLA VEZ. Anotalos ahora.');
  console.log('='.repeat(52));
  // Una línea por persona: el mismo PIN le sirve en todos sus puestos.
  const yaImpreso = new Set();
  for (const n of nuevos) {
    if (yaImpreso.has(n.nombre)) continue;
    yaImpreso.add(n.nombre);
    const puestos = nuevos.filter((x) => x.nombre === n.nombre).map((x) => x.puesto).join(' y ');
    console.log(`  ${n.nombre.padEnd(10)} ${n.pin}    (${puestos})`);
  }
  console.log('='.repeat(52));
  console.log('  No quedan guardados en ningún lado. Si se pierde uno,');
  console.log('  se regenera con --reset "Nombre:puesto".\n');
}

main()
  .catch((e) => {
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
