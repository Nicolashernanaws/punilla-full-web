'use strict';
/**
 * Bootstrap de arranque: aplica el esquema (idempotente) y siembra los premios
 * si la tabla está vacía. Se llama desde server.js antes de escuchar, así en
 * Railway el deploy migra solo sin un paso release aparte.
 * NUNCA pisa stock existente (el seed usa ON CONFLICT DO NOTHING).
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function bootstrap() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  // El Parte Diario va en su propio archivo: es un módulo aparte y no comparte
  // ninguna tabla con la raspadita ni con Fundadores. Igual de idempotente.
  const parte = fs.readFileSync(path.join(__dirname, 'parte-schema.sql'), 'utf8');
  await pool.query(parte);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM premios');
  if (rows[0].c === 0) {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config', 'premios.json'), 'utf8')
    );
    for (const p of cfg.premios) {
      const stock = p.stock === undefined ? null : p.stock;
      await pool.query(
        `INSERT INTO premios
           (nombre, prob, stock_inicial, stock_restante, vigencia_dias, vigencia_texto, nivel, es_consuelo, orden)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (nombre) DO NOTHING`,
        [p.nombre, p.prob ?? 1, stock, p.vigencia_dias ?? 15, p.vigencia_texto ?? '15 días',
         p.nivel ?? 'comun', !!p.es_consuelo, p.orden ?? 0]
      );
    }
    console.log(`[bootstrap] premios sembrados (${cfg.premios.length})`);
  }
  console.log('[bootstrap] esquema OK');
}

module.exports = { bootstrap };
