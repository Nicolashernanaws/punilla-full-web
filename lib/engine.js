'use strict';
const { withTx, query } = require('../db/db');
const { normalizePhone } = require('./phone');
const { shortCode, signCode } = require('./code');

const SECRET = process.env.CODE_SECRET || 'dev-secret-cambiar-en-prod';
const TZ = 'America/Argentina/Cordoba';

/** Pick ponderado sobre filas [{id, prob, ...}]. Determinista si se pasa rnd. */
function weightedPick(rows, rnd = Math.random) {
  const total = rows.reduce((a, r) => a + Math.max(0, r.prob), 0);
  if (total <= 0) return rows[0];
  let r = rnd() * total;
  for (const row of rows) {
    r -= Math.max(0, row.prob);
    if (r < 0) return row;
  }
  return rows[rows.length - 1];
}

function tieneStock(p) {
  return p.stock_restante === null || p.stock_restante > 0;
}

/**
 * Jugada de un Fundador. Idempotente por teléfono.
 * @returns {nuevo, agotado, fundador}
 */
async function play({ nombre, telefonoRaw, barrio, consent, canal, userAgent }, opts = {}) {
  const rnd = opts.rnd || Math.random;
  const telefono_norm = normalizePhone(telefonoRaw);
  if (!telefono_norm || telefono_norm.length !== 10) {
    const err = new Error('telefono_invalido');
    err.code = 'TEL_INVALIDO';
    throw err;
  }

  try {
    return await withTx(async (client) => {
      // (a) dedupe: ¿ya jugó este teléfono?
      const ya = await client.query(
        `SELECT numero, premio_nombre, codigo, token, vigencia_texto, vence_el, nivel
           FROM fundadores WHERE telefono_norm = $1`,
        [telefono_norm]
      );
      if (ya.rowCount) {
        return { nuevo: false, agotado: false, fundador: ya.rows[0] };
      }

      // (b) bloqueo de premios comunes en orden consistente (evita deadlocks)
      const premios = (
        await client.query(
          `SELECT id, nombre, prob, stock_restante, es_consuelo, vigencia_dias, vigencia_texto
             FROM premios
            WHERE activo = TRUE AND nivel = 'comun'
            ORDER BY id
            FOR UPDATE`
        )
      ).rows;

      // (c) elegir: primero premium con stock; si no hay, cae al consuelo
      const premium = premios.filter((p) => !p.es_consuelo && tieneStock(p));
      const consuelo = premios.filter((p) => p.es_consuelo && tieneStock(p));
      const pool = premium.length ? premium : consuelo;

      if (!pool.length) {
        // no queda absolutamente nada -> agotado (sólo si no hay consuelo ilimitado)
        return { nuevo: false, agotado: true, fundador: null };
      }
      const elegido = weightedPick(pool, rnd);

      // (d) descontar stock (si es finito)
      if (elegido.stock_restante !== null) {
        await client.query(
          `UPDATE premios SET stock_restante = stock_restante - 1 WHERE id = $1`,
          [elegido.id]
        );
      }

      // (e) contador de Fundadores atómico (row lock -> secuencial)
      const cnt = await client.query(
        `UPDATE counters SET val = val + 1 WHERE name = 'fundador' RETURNING val`
      );
      const numero = Number(cnt.rows[0].val);

      // (f) código único + firma (pre-chequeo dentro de la tx; el UNIQUE es el guard final)
      let codigo = shortCode();
      for (let i = 0; i < 10; i++) {
        const dup = await client.query(`SELECT 1 FROM fundadores WHERE codigo = $1`, [codigo]);
        if (!dup.rowCount) break;
        codigo = shortCode();
      }
      const token = signCode(codigo, SECRET);

      // (g) insertar Fundador; vence_el calculado en TZ Córdoba
      const ins = await client.query(
        `INSERT INTO fundadores
           (numero, telefono_norm, telefono_raw, nombre, barrio, consent,
            premio_id, premio_nombre, nivel, codigo, token, vigencia_texto,
            vence_el, canal, user_agent)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,'comun',$9,$10,$11,
            ((now() AT TIME ZONE $13)::date + ($12 || ' days')::interval)::date,
            $14,$15)
         RETURNING numero, premio_nombre, codigo, token, vigencia_texto, vence_el, nivel`,
        [
          numero,
          telefono_norm,
          telefonoRaw,
          nombre || null,
          barrio || null,
          !!consent,
          elegido.id,
          elegido.nombre,
          codigo,
          token,
          elegido.vigencia_texto,
          String(elegido.vigencia_dias || 0),
          TZ,
          canal || null,
          userAgent || null,
        ]
      );

      return { nuevo: true, agotado: false, fundador: ins.rows[0] };
    });
  } catch (e) {
    // Carrera: dos jugadas del mismo teléfono a la vez -> una gana el UNIQUE.
    // La perdedora hizo ROLLBACK (no consumió stock ni número) -> devolvemos la existente.
    if (e.code === '23505' && /telefono_norm/.test(e.constraint || e.detail || '')) {
      const ya = await query(
        `SELECT numero, premio_nombre, codigo, token, vigencia_texto, vence_el, nivel
           FROM fundadores WHERE telefono_norm = $1`,
        [telefono_norm]
      );
      if (ya.rowCount) return { nuevo: false, agotado: false, fundador: ya.rows[0] };
    }
    throw e;
  }
}

/** Suma del stock premium restante (para el chip público "Quedan X premios hoy"). */
async function stockRestante() {
  const r = await query(
    `SELECT COALESCE(SUM(stock_restante),0)::int AS quedan
       FROM premios
      WHERE activo = TRUE AND nivel='comun' AND es_consuelo = FALSE AND stock_restante IS NOT NULL`
  );
  return r.rows[0].quedan;
}

/** Total de Fundadores registrados (para "somos N"). */
async function totalFundadores() {
  const r = await query(`SELECT val FROM counters WHERE name='fundador'`);
  return r.rowCount ? Number(r.rows[0].val) : 0;
}

module.exports = { play, stockRestante, totalFundadores, weightedPick };
