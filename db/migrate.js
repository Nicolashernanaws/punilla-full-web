'use strict';
// Corre el esquema (idempotente). Uso: node db/migrate.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] esquema aplicado OK');
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] ERROR', e);
  process.exit(1);
});
