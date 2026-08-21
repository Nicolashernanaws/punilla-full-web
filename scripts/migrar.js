// Corre las migraciones de `migrations/` en orden alfabético.
//
// Es idempotente (todo el SQL usa IF NOT EXISTS) y deja registro en
// `schema_migraciones`, así correrlo dos veces no rompe nada.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, conTransaccion } from '../src/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const archivos = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

await conTransaccion(async (cli) => {
  await cli.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
    nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())`);

  for (const nombre of archivos) {
    const { rows } = await cli.query('SELECT 1 FROM schema_migraciones WHERE nombre = $1', [nombre]);
    if (rows.length) {
      console.log(`· ${nombre} ya estaba aplicada`);
      continue;
    }
    const sql = await fs.readFile(path.join(dir, nombre), 'utf8');
    await cli.query(sql);
    await cli.query('INSERT INTO schema_migraciones (nombre) VALUES ($1)', [nombre]);
    console.log(`✔ ${nombre} aplicada`);
  }
});

// Verificación explícita: que el script termine sin error no prueba que las
// tablas existan. Se listan para poder pegarlo en el chat como evidencia.
const { rows } = await pool.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'sorteo_%' ORDER BY 1`,
);
console.log('tablas del sorteo:', rows.map((r) => r.tablename).join(', ') || '(ninguna)');

await pool.end();
