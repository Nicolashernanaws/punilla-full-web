'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { play, stockRestante, totalFundadores } = require('./lib/engine');
const { query } = require('./db/db');
const { bootstrap } = require('./db/bootstrap');

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

// ---------- páginas ----------
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/fundador', (_req, res) => res.sendFile(path.join(PUBLIC, 'fundador.html')));
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
