'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { play, stockRestante, totalFundadores } = require('./lib/engine');
const {
  registrar: registrarSorteo,
  participantes: participantesSorteo,
  marcarCompartio,
  sortear: sortearPremios,
} = require('./lib/sorteo-engine');
const { ventanaAbierta, armarPadron, CIERRE, SORTEO_TEXTO } = require('./lib/sorteo');
const { query } = require('./db/db');
const { bootstrap } = require('./db/bootstrap');
const { crearRutasParte } = require('./lib/parte-rutas');

const app = express();
app.set('trust proxy', 1); // Railway está detrás de proxy
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const PUBLIC = path.join(__dirname, 'public');
const WA_NUMBER = process.env.WA_NUMBER || '5493541000000'; // PLACEHOLDER: número real de WhatsApp Business
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin';

// ---------- helpers ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.k || '';
  if (!safeEqual(key, ADMIN_KEY)) return res.status(401).json({ error: 'no_autorizado' });
  next();
}

// ---------- rate limit simple en memoria (best-effort anti-spam) ----------
const hits = new Map(); // ip -> [timestamps]
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'x';
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) return res.status(429).json({ error: 'demasiadas_solicitudes' });
    next();
  };
}
// limpieza periódica
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const keep = arr.filter((t) => now - t < 60000);
    if (keep.length) hits.set(ip, keep); else hits.delete(ip);
  }
}, 60000).unref();

// ---------- API pública ----------
app.get('/api/config', async (_req, res) => {
  try {
    const [quedan, total] = await Promise.all([stockRestante(), totalFundadores()]);
    res.json({ waNumber: WA_NUMBER, quedan, total });
  } catch (e) {
    res.json({ waNumber: WA_NUMBER, quedan: null, total: null });
  }
});

app.get('/api/stock', async (_req, res) => {
  try {
    const [quedan, total] = await Promise.all([stockRestante(), totalFundadores()]);
    res.json({ quedan, total });
  } catch (e) {
    res.status(500).json({ error: 'db' });
  }
});

app.post('/api/fundador', rateLimit(8, 60000), async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const telefonoRaw = String(b.telefono || '').trim();
  const barrio = b.barrio ? String(b.barrio).trim() : null;
  const consent = b.consent === true || b.consent === 'true' || b.consent === 1;
  const canal = b.canal ? String(b.canal).slice(0, 40) : null;

  const errores = {};
  if (nombre.length < 2) errores.nombre = 'Poné tu nombre.';
  if (!consent) errores.consent = 'Tenés que aceptar las bases para jugar.';
  // teléfono lo valida el motor (normalización AR)

  if (Object.keys(errores).length) return res.status(400).json({ ok: false, errores });

  try {
    const r = await play({
      nombre,
      telefonoRaw,
      barrio,
      consent,
      canal,
      userAgent: (req.get('user-agent') || '').slice(0, 300),
    });
    if (r.agotado) {
      return res.status(200).json({ ok: false, agotado: true });
    }
    const f = r.fundador;
    return res.json({
      ok: true,
      nuevo: r.nuevo,
      fundador: {
        numero: f.numero,
        premio: f.premio_nombre,
        codigo: f.codigo,
        vigencia: f.vigencia_texto,
        vence_el: f.vence_el,
        nivel: f.nivel,
      },
    });
  } catch (e) {
    if (e.code === 'TEL_INVALIDO') {
      return res
        .status(400)
        .json({ ok: false, errores: { telefono: 'Fijate el número — necesitamos un WhatsApp válido.' } });
    }
    console.error('[/api/fundador] error', e);
    return res.status(500).json({ ok: false, error: 'servidor' });
  }
});

// ---------- API sorteo ----------
// PUNILLA FULL SORTEO: carga del 24/8 al jueves 27/8 20:00, se sortea a las 21.
// Convive con Fundadores; son campañas distintas sobre la misma base.

app.get('/api/sorteo/config', async (_req, res) => {
  const abierto = ventanaAbierta(new Date());
  try {
    const r = await query('SELECT COUNT(*)::int AS c FROM sorteo_participante');
    res.json({ abierto, cierre: CIERRE.toISOString(), sorteoTexto: SORTEO_TEXTO, anotados: r.rows[0].c });
  } catch (e) {
    // El contador es decorativo: si la base no contesta, la landing tiene que
    // seguir dejando anotarse igual.
    res.json({ abierto, cierre: CIERRE.toISOString(), sorteoTexto: SORTEO_TEXTO, anotados: null });
  }
});

// Rate limit más holgado que el de Fundadores: acá la gracia es anotarse varias
// veces, así que 20 por minuto por IP corta al bot sin molestar a la familia
// que se anota junta desde el wifi del local.
app.post('/api/sorteo/registro', rateLimit(20, 60000), async (req, res) => {
  const b = req.body || {};
  try {
    const r = await registrarSorteo({
      nombre: b.nombre,
      telefonoRaw: b.telefono,
      comercio: b.comercio,
      // Sin tilde en el formulario, el campo puede no venir. `undefined` NO es
      // rechazo: apretar "Anotarme" con el aviso a la vista es la aceptacion.
      consent: b.consent === false || b.consent === 'false' ? false : true,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.mensajeUsuario, code: e.message });
    console.error('[/api/sorteo/registro] error', e);
    res.status(500).json({
      ok: false,
      error: 'Se nos cayó el sistema un segundo. Probá de nuevo, y si sigue igual avisanos en la caja.',
    });
  }
});

// ---------- API admin del sorteo ----------
app.get('/api/sorteo/admin/padron', requireAdmin, async (_req, res) => {
  const gente = await participantesSorteo();
  const padron = armarPadron(gente);
  res.json({
    anotados: gente.length,
    participando: gente.filter((p) => p.participa).length,
    pendientes_de_historia: gente.filter((p) => !p.compartio).length,
    padron_size: padron.length,
    gente: gente.map((p) => ({
      telefono: p.telefono_norm,
      nombre: p.nombre,
      chances: p.chances,
      multiplicador: p.multiplicador,
      compartio: p.compartio,
      via: p.compartio_via,
      participa: p.participa,
      comercios: [...new Set(p.registros.map((r) => r.comercio))],
    })),
  });
});

app.post('/api/sorteo/admin/compartio', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await marcarCompartio(b.telefono, b.via, b.valor !== false);
    res.json({ ok: true, participante: r });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.mensajeUsuario });
    throw e;
  }
});

app.post('/api/sorteo/admin/sortear', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    res.json({ ok: true, ...(await sortearPremios({ semilla: b.semilla, forzar: b.forzar === true })) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.mensajeUsuario });
    throw e;
  }
});

app.get('/api/sorteo/admin/export.csv', requireAdmin, async (_req, res) => {
  const gente = await participantesSorteo();
  const cols = ['telefono', 'nombre', 'chances', 'multiplicador', 'compartio', 'via', 'participa', 'comercios'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const p of gente) {
    lines.push(
      [
        p.telefono_norm,
        p.nombre,
        p.chances,
        p.multiplicador,
        p.compartio,
        p.compartio_via,
        p.participa,
        [...new Set(p.registros.map((r) => r.comercio))].join(' '),
      ]
        .map(esc)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sorteo.csv"');
  res.send('﻿' + lines.join('\n')); // BOM para Excel
});

// ---------- API admin ----------
app.get('/api/admin/premios', requireAdmin, async (_req, res) => {
  const r = await query(
    `SELECT id, nombre, prob, stock_inicial, stock_restante, es_consuelo, nivel, activo, orden
       FROM premios ORDER BY orden, id`
  );
  res.json(r.rows);
});

app.get('/api/admin/fundadores', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  let sql = `SELECT numero, nombre, telefono_norm, barrio, premio_nombre, codigo,
                    vigencia_texto, vence_el, canal, created_at, canjeado_at, canjeado_por
               FROM fundadores`;
  const params = [];
  if (q) {
    params.push('%' + q.toUpperCase() + '%', '%' + q + '%');
    sql += ` WHERE UPPER(codigo) LIKE $1 OR telefono_norm LIKE $2 OR UPPER(nombre) LIKE $1`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  const r = await query(sql, params);
  res.json(r.rows);
});

app.post('/api/admin/canje', requireAdmin, async (req, res) => {
  const codigo = String((req.body && req.body.codigo) || '').trim().toUpperCase();
  const porQuien = String((req.body && req.body.por) || '').slice(0, 60) || null;
  if (!codigo) return res.status(400).json({ error: 'falta_codigo' });
  // Canje atómico e irreversible: sólo marca si aún no estaba canjeado.
  const upd = await query(
    `UPDATE fundadores SET canjeado_at = now(), canjeado_por = $2
       WHERE UPPER(codigo) = $1 AND canjeado_at IS NULL
       RETURNING numero, nombre, premio_nombre, codigo, vence_el`,
    [codigo, porQuien]
  );
  if (upd.rowCount) return res.json({ ok: true, ya_estaba: false, fundador: upd.rows[0] });
  // No se actualizó: o no existe, o ya estaba canjeado. Distinguimos.
  const cur = await query(
    `SELECT numero, nombre, premio_nombre, codigo, vence_el, canjeado_at, canjeado_por
       FROM fundadores WHERE UPPER(codigo) = $1`,
    [codigo]
  );
  if (!cur.rowCount) return res.status(404).json({ ok: false, error: 'no_existe' });
  return res.status(409).json({ ok: false, ya_estaba: true, fundador: cur.rows[0] });
});

app.get('/api/admin/export.csv', requireAdmin, async (_req, res) => {
  const r = await query(
    `SELECT numero, nombre, telefono_norm, telefono_raw, barrio, premio_nombre,
            codigo, vigencia_texto, vence_el, canal, consent, created_at, canjeado_at, canjeado_por
       FROM fundadores ORDER BY numero`
  );
  const cols = [
    'numero', 'nombre', 'telefono_norm', 'telefono_raw', 'barrio', 'premio_nombre',
    'codigo', 'vigencia_texto', 'vence_el', 'canal', 'consent', 'created_at', 'canjeado_at', 'canjeado_por',
  ];
  const fmt = (v, col) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      // vence_el es DATE -> sólo fecha; timestamps -> ISO
      return col === 'vence_el' ? v.toISOString().slice(0, 10) : v.toISOString();
    }
    return String(v);
  };
  const esc = (v, col) => {
    const s = fmt(v, col);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const row of r.rows) lines.push(cols.map((c) => esc(row[c], c)).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fundadores.csv"');
  res.send('﻿' + lines.join('\n')); // BOM para Excel
});

// ---------- Parte Diario ----------
//
// Módulo autocontenido bajo /parte: checklists de turno con rastro auditable.
// Vive acá y no en el POS porque el POS es hoy el bloqueante de ARCA y no se le
// mete trabajo que no sea fiscal. No toca la raspadita ni Fundadores.
app.use(
  '/parte',
  crearRutasParte({
    secret: process.env.CODE_SECRET || 'dev-secret-inseguro',
    adminKey: ADMIN_KEY,
    // En local no hay HTTPS: con Secure la cookie no viajaría y no se podría
    // probar nada.
    secure: process.env.NODE_ENV === 'production',
  }),
);
// Una URL por sector: en el teléfono cada uno abre la suya y va derecho a lo
// suyo, sin ver la lista de puestos de los demás. Es la MISMA página; lo que
// cambia es qué puestos ofrece el login, y eso lo decide el front mirando la
// URL. La separación de verdad la hace el PIN, no la ruta.
for (const ruta of ['/parte', '/parte/encargado', '/parte/fiambreria', '/parte/produccion']) {
  app.get(ruta, (_req, res) => res.sendFile(path.join(PUBLIC, 'parte.html')));
}
app.get('/parte/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'parte-admin.html')));

// ---------- páginas ----------
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/fundador', (_req, res) => res.sendFile(path.join(PUBLIC, 'fundador.html')));
// Sin .html: son las URLs del QR del cartel y de la bio de las tres cuentas.
// Una vez impresas no se pueden cambiar, así que tienen que ser cortas y estables.
app.get('/sorteo', (_req, res) => res.sendFile(path.join(PUBLIC, 'sorteo.html')));
app.get('/bases-sorteo', (_req, res) => res.sendFile(path.join(PUBLIC, 'bases-sorteo.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// estáticos (css/img/js sueltos si los hubiera)
app.use(express.static(PUBLIC, { extensions: ['html'] }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // Avisos de configuración en producción
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.CODE_SECRET) console.warn('[punilla] ⚠ CODE_SECRET no seteado (usando default inseguro)');
    if (!process.env.ADMIN_KEY) console.warn('[punilla] ⚠ ADMIN_KEY no seteado (usando default inseguro)');
    if (process.env.WA_NUMBER === undefined) console.warn('[punilla] ⚠ WA_NUMBER no seteado (usando placeholder)');
  }
  bootstrap()
    .then(() => app.listen(PORT, () => console.log(`[punilla] escuchando en :${PORT}`)))
    .catch((e) => {
      console.error('[punilla] fallo en bootstrap, no arranco:', e);
      process.exit(1);
    });
}

module.exports = app;
