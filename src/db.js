// Acceso a Postgres. Un solo pool para todo el proceso.
import pg from 'pg';

const { Pool } = pg;

// Railway expone la interna `postgres.railway.internal` (que sólo se alcanza
// desde adentro del proyecto) y la pública. En el contenedor va DATABASE_URL.
const connectionString = process.env.DATABASE_URL;

// `pg` devuelve los NUMERIC como string para no perder precisión. Acá los
// montos son enteros de pesos y las chances son chicas: se leen como número
// para que el JSON de la API no mande "2" cuando el front espera 2.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export const pool = new Pool({
  connectionString,
  // Railway corta TLS con certificado propio; sin esto el pool no levanta.
  ssl: connectionString && !connectionString.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function query(sql, params) {
  return pool.query(sql, params);
}

/**
 * Corre `fn` adentro de una transacción y hace rollback si algo tira.
 *
 * Existe porque la carga de una jugada toca DOS tablas (participante y jugada)
 * y toma un row lock por teléfono: si el insert de la jugada falla por ticket
 * repetido, el participante NO tiene que quedar a medio crear.
 */
export async function conTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
