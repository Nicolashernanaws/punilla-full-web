'use strict';
const express = require('express');
const { query, withTx } = require('../db/db');
const { fechaOperativa } = require('./parte-fecha');
const { aplicarEvento } = require('./parte');
const {
  crearToken, leerToken, cookieDe, cabeceraCookie, cabeceraBorrar, verificarPin,
} = require('./parte-sesion');

/**
 * El Parte Diario: checklists de turno con rastro auditable.
 *
 * Va montado bajo /parte y no toca nada de la raspadita ni de Fundadores.
 */
const PUESTOS = ['enc_m', 'enc_t', 'fiam_m', 'fiam_t', 'prod'];

/** De qué puesto de la mañana lee cada puesto de la tarde para el traspaso. */
const TRASPASO = { enc_t: 'enc_m', fiam_t: 'fiam_m' };

/**
 * Rate limit por IP **y puesto**, no sólo por IP.
 *
 * 🔴 UN PIN DE 4 DÍGITOS SON 10.000 COMBINACIONES: sin freno se rompe en
 * minutos, y en los campos del parte hay montos de caja. Por IP sola no alcanza
 * —el local sale por una sola IP y ahí un ataque contra un puesto consumiría el
 * cupo de todos—; por puesto solo tampoco, porque no distingue a quién.
 */
function rateLimitPorClave(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [k, arr] of hits) {
      const quedan = arr.filter((t) => ahora - t < windowMs);
      if (quedan.length) hits.set(k, quedan);
      else hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ahora = Date.now();
    const clave = (req.ip || 'x') + '|' + String(req.body?.puesto || '-');
    const arr = (hits.get(clave) || []).filter((t) => ahora - t < windowMs);
    arr.push(ahora);
    hits.set(clave, arr);
    if (arr.length > max) {
      return res.status(429).json({ error: 'demasiados_intentos' });
    }
    next();
  };
}

function crearRutasParte({ secret, adminKey, secure = true }) {
  const r = express.Router();

  // ── Sesión ────────────────────────────────────────────────────────────────
  //
  // 🔴 EL PUESTO SALE DE LA COOKIE, NUNCA DEL BODY. Con PIN de 4 dígitos, dejar
  // que el cliente diga qué puesto es sería habilitar a fiambrería mañana a
  // tildarle la lista a fiambrería tarde cambiando un campo del request.
  // Criterio de aceptación 4.
  function sesionDe(req) {
    return leerToken(cookieDe(req), secret);
  }
  function requiereSesion(req, res, next) {
    const s = sesionDe(req);
    if (!s) return res.status(401).json({ error: 'sin_sesion' });
    req.parte = s;
    next();
  }
  function requiereAdmin(req, res, next) {
    const dada = String(req.get('x-admin-key') || req.query.key || '');
    // Comparación de largo primero para no reventar en timingSafeEqual.
    if (dada.length !== String(adminKey).length || dada !== String(adminKey)) {
      return res.status(401).json({ error: 'no_autorizado' });
    }
    next();
  }

  async function anotarEvento(cli, { fecha, puesto, personaId, tipo, itemId, valor }) {
    await cli.query(
      `INSERT INTO parte_evento (fecha, puesto, persona_id, tipo, item_id, valor)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [fecha, puesto, personaId ?? null, tipo, itemId ?? null, valor == null ? null : String(valor).slice(0, 500)],
    );
  }

  /** Lee (o crea) el parte del día y puesto, con el row lock tomado. */
  async function leerConLock(cli, fecha, puesto) {
    // El INSERT ... ON CONFLICT DO NOTHING evita la carrera de dos teléfonos
    // creando la fila del día al mismo tiempo.
    await cli.query(
      `INSERT INTO parte_dia (fecha, puesto) VALUES ($1,$2) ON CONFLICT (fecha, puesto) DO NOTHING`,
      [fecha, puesto],
    );
    const { rows } = await cli.query(
      `SELECT items, campos, nota, cierre FROM parte_dia
        WHERE fecha = $1 AND puesto = $2 FOR UPDATE`,
      [fecha, puesto],
    );
    return rows[0];
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  r.post('/api/login', rateLimitPorClave(5, 15 * 60 * 1000), async (req, res) => {
    const puesto = String(req.body?.puesto || '');
    const pin = String(req.body?.pin || '');
    if (!PUESTOS.includes(puesto) || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    const { rows } = await query(
      `SELECT id, nombre, pin_hash FROM parte_persona WHERE puesto = $1 AND activo`,
      [puesto],
    );
    // Se prueban todas las personas del puesto: el PIN identifica a la persona
    // DENTRO del puesto, así que Julián y Vanesa pueden rotar sin cambiar nada.
    const persona = rows.find((p) => verificarPin(pin, p.pin_hash));
    if (!persona) return res.status(401).json({ error: 'pin_incorrecto' });

    const fecha = fechaOperativa();
    await query(
      `INSERT INTO parte_evento (fecha, puesto, persona_id, tipo) VALUES ($1,$2,$3,'login')`,
      [fecha, puesto, persona.id],
    );
    const token = crearToken({ personaId: persona.id, puesto, nombre: persona.nombre }, secret);
    res.setHeader('Set-Cookie', cabeceraCookie(token, { secure }));
    res.json({ ok: true, nombre: persona.nombre, puesto });
  });

  r.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', cabeceraBorrar({ secure }));
    res.json({ ok: true });
  });

  // ── El día ────────────────────────────────────────────────────────────────

  r.get('/api/dia', requiereSesion, async (req, res) => {
    const fecha = fechaOperativa();
    const { puesto } = req.parte;
    const estado = await withTx((cli) => leerConLock(cli, fecha, puesto));
    res.json({ fecha, puesto, nombre: req.parte.nombre, ...estado });
  });

  r.post('/api/evento', requiereSesion, async (req, res) => {
    // 🔴 La fecha y el puesto los pone el SERVIDOR. El cliente sólo dice qué
    // hizo, nunca dónde ni cuándo: su reloj puede estar en cualquier lado y su
    // puesto sería el de otro.
    const fecha = fechaOperativa();
    const { puesto, personaId, nombre } = req.parte;
    const evento = {
      tipo: String(req.body?.tipo || ''),
      itemId: req.body?.itemId == null ? null : String(req.body.itemId).slice(0, 120),
      valor: req.body?.valor,
      detalle: req.body?.detalle,
    };

    try {
      const estado = await withTx(async (cli) => {
        // El lock es lo que hace que dos teléfonos del mismo puesto no se pisen:
        // el segundo espera, lee lo que escribió el primero y aplica encima.
        const actual = await leerConLock(cli, fecha, puesto);
        const nuevo = aplicarEvento(actual, evento, { nombre, id: personaId });
        await cli.query(
          `UPDATE parte_dia
              SET items = $3, campos = $4, nota = $5, cierre = $6, actualizado_en = now()
            WHERE fecha = $1 AND puesto = $2`,
          [fecha, puesto, nuevo.items, nuevo.campos, nuevo.nota, nuevo.cierre],
        );
        await anotarEvento(cli, {
          fecha, puesto, personaId,
          tipo: evento.tipo, itemId: evento.itemId,
          valor: evento.tipo === 'nota' ? String(evento.valor ?? '').slice(0, 200) : evento.valor,
        });
        return nuevo;
      });
      // Devuelve el estado COMPLETO: el cliente no lo reconstruye por su cuenta,
      // así lo que cargó el otro aparece en la misma respuesta.
      res.json({ fecha, puesto, ...estado });
    } catch (e) {
      res.status(400).json({ error: 'evento_invalido', detalle: e.message });
    }
  });

  /**
   * El traspaso: lo que dejó el turno de la mañana. SÓLO LECTURA.
   *
   * El de la tarde necesita verlo para arrancar, pero no puede escribirlo — si
   * pudiera, el parte de la mañana dejaría de decir qué hizo la mañana.
   */
  r.get('/api/traspaso', requiereSesion, async (req, res) => {
    const origen = TRASPASO[req.parte.puesto];
    if (!origen) return res.status(404).json({ error: 'sin_traspaso' });
    const { rows } = await query(
      `SELECT items, campos, nota, cierre FROM parte_dia WHERE fecha = $1 AND puesto = $2`,
      [fechaOperativa(), origen],
    );
    res.json(rows[0] || { items: {}, campos: {}, nota: '', cierre: null });
  });

  // ── Tablero del administrador ─────────────────────────────────────────────

  r.get('/admin/api/dia', requiereAdmin, async (req, res) => {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || ''))
      ? String(req.query.fecha)
      : fechaOperativa();
    const [partes, eventos] = await Promise.all([
      query(
        `SELECT puesto, items, campos, nota, cierre, actualizado_en
           FROM parte_dia WHERE fecha = $1`,
        [fecha],
      ),
      // La línea de tiempo es el punto del tablero: acá se ve si alguien tildó
      // doce cosas seguidas a las 15:58, que es la señal de que la lista se
      // completa de memoria al final del turno en vez de durante.
      query(
        `SELECT e.puesto, e.tipo, e.item_id, e.valor, e.ts, p.nombre
           FROM parte_evento e LEFT JOIN parte_persona p ON p.id = e.persona_id
          WHERE e.fecha = $1 ORDER BY e.ts ASC`,
        [fecha],
      ),
    ]);
    const porPuesto = new Map(partes.rows.map((p) => [p.puesto, p]));
    res.json({
      fecha,
      puestos: PUESTOS.map((p) => ({
        puesto: p,
        ...(porPuesto.get(p) || { items: {}, campos: {}, nota: '', cierre: null }),
        hechas: Object.keys((porPuesto.get(p) || {}).items || {}).length,
      })),
      eventos: eventos.rows,
    });
  });

  r.get('/admin/api/rango', requiereAdmin, async (req, res) => {
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const hasta = ok(req.query.hasta) ? String(req.query.hasta) : fechaOperativa();
    const desde = ok(req.query.desde)
      ? String(req.query.desde)
      : new Date(Date.parse(hasta) - 29 * 86400000).toISOString().slice(0, 10);
    const { rows } = await query(
      `SELECT fecha, puesto,
              jsonb_array_length(COALESCE(jsonb_path_query_array(items, '$.keyvalue()'), '[]'::jsonb)) AS hechas,
              cierre->>'estado' AS cierre
         FROM parte_dia
        WHERE fecha BETWEEN $1 AND $2
        ORDER BY fecha DESC, puesto`,
      [desde, hasta],
    );
    res.json({ desde, hasta, dias: rows });
  });

  return r;
}

module.exports = { crearRutasParte, PUESTOS, TRASPASO, rateLimitPorClave };
