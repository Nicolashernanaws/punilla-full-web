'use strict';
/**
 * Seed idempotente de premios. Uso: node db/seed.js
 * REGLA DURA: no pisa el stock ya consumido. Inserta los premios que falten
 * (por nombre) y deja intactos los existentes. Para cambiar stocks/probs de un
 * premio existente, editarlo desde el panel o con un UPDATE explícito, NO acá.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'premios.json'), 'utf8')
  );
  let insertados = 0;
  let saltados = 0;
  for (const p of cfg.premios) {
    const stock = p.stock === undefined ? null : p.stock;
    const res = await pool.query(
      `INSERT INTO premios
         (nombre, prob, stock_inicial, stock_restante, vigencia_dias, vigencia_texto, nivel, es_consuelo, orden)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (nombre) DO NOTHING
       RETURNING id`,
      [
        p.nombre,
        p.prob ?? 1,
        stock,
        p.vigencia_dias ?? 15,
        p.vigencia_texto ?? '15 días',
        p.nivel ?? 'comun',
        !!p.es_consuelo,
        p.orden ?? 0,
      ]
    );
    if (res.rowCount) insertados++;
    else saltados++;
  }
  console.log(`[seed] premios insertados: ${insertados} · ya existentes (sin tocar): ${saltados}`);
  await pool.end();
}

main().catch((e) => {
  console.error('[seed] ERROR', e);
  process.exit(1);
});
