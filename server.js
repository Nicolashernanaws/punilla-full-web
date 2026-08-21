// punilla-full-web — landing + PUNILLA FULL SORTEO.
//
// Hasta el 20/8 esto era un nginx sirviendo un index.html. Ahora es Node,
// porque el sorteo necesita persistencia. La landing se sigue sirviendo igual:
// si algo de esto rompe, lo primero que hay que verificar es que
// `GET /` siga devolviendo el index.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORT } from './src/config.js';
import { rutaJugada } from './src/jugada.js';
import { rutasAdmin } from './src/admin.js';
import { registrarError, ultimosErrores } from './src/errores.js';
import { esAdmin } from './src/auth.js';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway va detrás de proxy: sin esto req.ip miente.
app.use(express.json({ limit: '32kb' }));

// ── Salud ──────────────────────────────────────────────────────────────────
app.get('/api/salud', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Sorteo ─────────────────────────────────────────────────────────────────
rutaJugada(app);
rutasAdmin(app);

/**
 * Log de errores visible.
 *
 * El riesgo real de esta campaña: si el endpoint falla un sábado a la tarde, se
 * pierden las cargas de ese rato y NADIE se entera hasta el lunes. Los errores
 * van a stderr (que Railway guarda) y además quedan los últimos en memoria acá,
 * para poder mirarlos desde el celular sin abrir el dashboard.
 */
app.get('/api/sorteo/admin/errores', (req, res) => {
  if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
  res.json({ errores: ultimosErrores() });
});

// ── Estáticos ──────────────────────────────────────────────────────────────
// `/sorteo` y `/bases-sorteo` sin .html: son las URLs que se van a pegar en
// Instagram y en el cartel del local, y tienen que ser cortas y escribibles.
//
// Al 21/8 `sorteo.html` y `bases-sorteo.html` todavía no están en el repo. Si
// faltan, se contesta una página de "todavía no" en vez de un 500: estas dos
// URLs se publican en redes, y el vecino que entra antes de tiempo tiene que
// ver algo que se entienda, no un error del servidor.
function servirPagina(archivo) {
  return (_req, res) => {
    const destino = path.join(raiz, archivo);
    res.sendFile(destino, (err) => {
      if (!err) return;
      res
        .status(503)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Punilla Full</title>
<div style="font-family:system-ui,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;text-align:center;line-height:1.6">
  <h1 style="font-size:1.5rem">Todavía no está publicada esta página</h1>
  <p>Estamos terminando de prepararla. Volvé en un rato.</p>
  <p><a href="/" style="color:#D62820">Ir a la página de Punilla Full</a></p>
</div>`,
        );
    });
  };
}

app.get('/sorteo', servirPagina('sorteo.html'));
app.get('/bases-sorteo', servirPagina('bases-sorteo.html'));
app.use(express.static(raiz, { extensions: ['html'], index: 'index.html' }));

// Cualquier otra cosa cae en la landing (la SPA-ish del nginx anterior).
app.get('*', (_req, res) => res.sendFile(path.join(raiz, 'index.html')));

// ── Errores ────────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  registrarError(err, req);
  // Al vecino no se le muestra el stack: se le muestra qué hacer.
  res.status(500).json({
    error: 'Se nos cayó el sistema un segundo. Probá de nuevo en un minuto, y si sigue igual escribinos por WhatsApp.',
  });
});

process.on('unhandledRejection', (e) => registrarError(e, null));
process.on('uncaughtException', (e) => registrarError(e, null));

app.listen(PORT, () => {
  console.log(`punilla-full-web escuchando en :${PORT}`);
});

export default app;
