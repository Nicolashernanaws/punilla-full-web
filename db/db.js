'use strict';
const { Pool } = require('pg');

// Railway inyecta DATABASE_URL al agregar el plugin Postgres.
// En local usamos la de desarrollo.
const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://punilla:punilla@localhost:5432/punilla_dev';

// Railway Postgres público requiere SSL; el interno no. Detectamos por host.
const needsSSL = /proxy\.rlwy\.net|\.railway\.app|sslmode=require/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] error inesperado en cliente idle', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Corre fn dentro de una transacción con un cliente dedicado.
 * fn recibe el client; si lanza, se hace ROLLBACK; si retorna, COMMIT.
 */
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx };
