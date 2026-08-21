// Rutas de admin del PUNILLA FULL SORTEO: listado/CSV de jugadas, marcar
// "compartió la historia" y el sorteo final de los 4 puestos.
//
// `db` es inyectable (segundo parámetro, default = db.js real), mismo patrón
// que `rutaJugada` en jugada.js. El tercer parámetro es un objeto de
// dependencias con default a las implementaciones reales (esAdmin de
// auth.js, crypto.randomInt/randomBytes, PREMIOS de config.js): así el test
// puede inyectar un doble sin pisar ADMIN_KEY real ni depender del flag
// --experimental-test-module-mocks de node:test.
import crypto from 'node:crypto';
import * as dbReal from './db.js';
import { esAdmin as esAdminReal } from './auth.js';
import { normalizarTelefono } from './telefono.js';
import { totalDeChances } from './chances.js';
import { PREMIOS } from './config.js';

const CANTIDAD_GANADORES = 4;

export function rutasAdmin(
  app,
  db = dbReal,
  {
    esAdmin = esAdminReal,
    randomInt = crypto.randomInt,
    randomBytes = crypto.randomBytes,
    premios = PREMIOS,
  } = {}
) {
  // Todas las rutas de acá son admin: un solo guard adelante de las tres.
  function requireAdmin(req, res, next) {
    if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado' });
    next();
  }

  // Envuelve el handler async: si tira un error con `.status` (400, etc.) lo
  // devuelve tal cual; cualquier otra cosa es un 500 genérico. Sin esto, un
  // throw dentro de un handler async de Express se pierde como unhandled
  // rejection en vez de contestarle algo al admin.
  function manejar(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (e) {
        const status = e?.status ?? 500;
        if (status >= 500) console.error('Error inesperado en admin del sorteo:', e);
        res.status(status).json({ error: status >= 500 ? 'Error interno.' : e.message });
      }
    };
  }

  // ── GET /api/sorteo/admin/jugadas ─────────────────────────────────────────
  app.get(
    '/api/sorteo/admin/jugadas',
    requireAdmin,
    manejar(async (req, res) => {
      const { comercio, desde, hasta, telefono, formato } = req.query;

      let telefonoNorm;
      if (telefono !== undefined) {
        telefonoNorm = normalizarTelefono(telefono);
        if (!telefonoNorm) {
          const err = new Error('El teléfono del filtro no es válido.');
          err.status = 400;
          throw err;
        }
      }

      const condiciones = [];
      const params = [];
      if (comercio) {
        params.push(comercio);
        condiciones.push(`j.comercio = $${params.length}`);
      }
      if (desde) {
        params.push(desde);
        condiciones.push(`j.creado_en >= $${params.length}`);
      }
      if (hasta) {
        params.push(hasta);
        condiciones.push(`j.creado_en <= $${params.length}`);
      }
      if (telefonoNorm) {
        params.push(telefonoNorm);
        condiciones.push(`p.telefono_norm = $${params.length}`);
      }
      const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

      const { rows } = await db.query(
        `
        SELECT p.telefono_norm AS telefono, p.barrio, p.ok_novedades, p.compartio, p.sin_compra,
               j.comercio, j.ticket_nro, j.monto, j.chances, j.creado_en
        FROM sorteo_jugada j
        JOIN sorteo_participante p ON p.telefono_norm = j.telefono_norm
        ${where}
        ORDER BY j.creado_en DESC
      `,
        params
      );

      // El total de chances es por teléfono y se calcula sobre TODAS sus
      // jugadas, no sólo las que entraron en el filtro de este listado: si el
      // admin filtra por comercio "lucy", igual quiere ver el total real que
      // ese vecino tiene en el padrón del sorteo.
      const totalChances = {};
      const porTelefono = agruparPorTelefono(await filasParaChances(db, null, telefonoNorm));
      for (const [tel, datos] of porTelefono) {
        totalChances[tel] = totalDeChances(datos);
      }

      if (formato === 'csv') {
        const header = [
          'telefono',
          'barrio',
          'comercio',
          'ticket',
          'monto',
          'chances',
          'ok_novedades',
          'compartio',
          'sin_compra',
          'creado_en',
        ];
        const lineas = [header.join(',')];
        for (const r of rows) {
          lineas.push(
            [
              r.telefono,
              r.barrio,
              r.comercio,
              r.ticket_nro,
              r.monto,
              r.chances,
              r.ok_novedades,
              r.compartio,
              r.sin_compra,
              r.creado_en instanceof Date ? r.creado_en.toISOString() : r.creado_en,
            ]
              .map(escaparCsv)
              .join(',')
          );
        }
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="jugadas-sorteo.csv"');
        res.send(lineas.join('\r\n'));
        return;
      }

      res.json({ jugadas: rows, totalChances });
    })
  );

  // ── POST /api/sorteo/admin/compartio ──────────────────────────────────────
  app.post(
    '/api/sorteo/admin/compartio',
    requireAdmin,
    manejar(async (req, res) => {
      const telefonoNorm = normalizarTelefono(req.body?.telefono);
      if (!telefonoNorm) {
        const err = new Error('El teléfono no es válido.');
        err.status = 400;
        throw err;
      }

      // Idempotente por diseño: un UPDATE que pone compartio=true no cambia
      // nada si ya estaba en true, y correrlo dos veces devuelve lo mismo.
      const { rows } = await db.query(
        `UPDATE sorteo_participante SET compartio = true WHERE telefono_norm = $1 RETURNING telefono_norm`,
        [telefonoNorm]
      );
      if (rows.length === 0) {
        const err = new Error('Ese teléfono no está participando del sorteo.');
        err.status = 404;
        throw err;
      }

      res.json({ telefono: telefonoNorm, compartio: true });
    })
  );

  // ── POST /api/sorteo/admin/sortear ────────────────────────────────────────
  app.post(
    '/api/sorteo/admin/sortear',
    requireAdmin,
    manejar(async (req, res) => {
      const force = req.body?.force === true;

      // Sin force, si ya hay resultado NO se sortea de nuevo: correr esto dos
      // veces sin querer (o que alguien lo abra dos veces desde el celular)
      // no puede cambiar quién ganó.
      if (!force) {
        const { rows } = await db.query(
          `SELECT puesto, telefono_norm AS telefono, semilla, padron_size FROM sorteo_resultado ORDER BY puesto`
        );
        if (rows.length > 0) {
          return res.json({ yaSorteado: true, resultados: conPremio(rows, premios) });
        }
      }

      const resultados = await db.conTransaccion(async (cliente) => {
        if (force) {
          // Con force se pisa el sorteo anterior; el borrado va DENTRO de la
          // misma transacción que el insert nuevo para que nunca quede el
          // padrón sin ningún resultado guardado si algo falla en el medio.
          await cliente.query(`DELETE FROM sorteo_resultado`);
        }

        const porTelefono = agruparPorTelefono(await filasParaChances(db, cliente));

        // El padrón es un array donde cada teléfono aparece tantas veces como
        // chances tiene: sortear "sacar una bolilla" de ahí es proporcional
        // sin tener que armar una ruleta ponderada a mano.
        const padron = [];
        for (const [tel, datos] of porTelefono) {
          const total = totalDeChances(datos);
          for (let i = 0; i < total; i++) padron.push(tel);
        }

        const unicos = [...new Set(padron)];
        if (unicos.length < CANTIDAD_GANADORES) {
          const err = new Error(
            `El padrón tiene ${unicos.length} teléfono(s) único(s) y hacen falta ${CANTIDAD_GANADORES} para sortear.`
          );
          err.status = 400;
          throw err;
        }

        // Fisher-Yates con crypto.randomInt: Math.random() no es
        // criptográficamente seguro (es predecible con el estado del PRNG) y
        // en un sorteo con premio en juego hay que poder defender que nadie
        // pudo predecir ni reproducir el resultado de antemano.
        for (let i = padron.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [padron[i], padron[j]] = [padron[j], padron[i]];
        }

        const ganadores = [];
        const vistos = new Set();
        for (const tel of padron) {
          if (vistos.has(tel)) continue;
          vistos.add(tel);
          ganadores.push(tel);
          if (ganadores.length === CANTIDAD_GANADORES) break;
        }

        const semilla = randomBytes(16).toString('hex');
        const padronSize = padron.length;

        const filas = [];
        for (let i = 0; i < CANTIDAD_GANADORES; i++) {
          const puesto = i + 1;
          const telefono = ganadores[i];
          await cliente.query(
            `INSERT INTO sorteo_resultado (puesto, telefono_norm, semilla, padron_size) VALUES ($1, $2, $3, $4)`,
            [puesto, telefono, semilla, padronSize]
          );
          filas.push({ puesto, telefono, semilla, padron_size: padronSize });
        }
        return filas;
      });

      res.json({ yaSorteado: false, resultados: conPremio(resultados, premios) });
    })
  );
}

/**
 * Trae, para cada participante, sus jugadas (comercio + chances) más los
 * flags sin_compra/compartio. Se usa tanto para el total del listado como
 * para armar el padrón del sorteo: es la MISMA pregunta ("cuántas chances
 * tiene cada teléfono") en los dos casos.
 *
 * `cliente` opcional: dentro de la transacción del sorteo hay que leer con el
 * cliente de esa transacción (mismo row lock/consistencia), no con el pool.
 */
async function filasParaChances(db, cliente, telefonoNorm) {
  const q = cliente ? cliente.query.bind(cliente) : db.query;
  const params = [];
  let where = '';
  if (telefonoNorm) {
    params.push(telefonoNorm);
    where = 'WHERE p.telefono_norm = $1';
  }
  const { rows } = await q(
    `
    SELECT p.telefono_norm AS telefono, p.sin_compra, p.compartio, j.comercio, j.chances
    FROM sorteo_participante p
    LEFT JOIN sorteo_jugada j ON j.telefono_norm = p.telefono_norm
    ${where}
  `,
    params
  );
  return rows;
}

function agruparPorTelefono(rows) {
  const porTelefono = new Map();
  for (const row of rows) {
    if (!porTelefono.has(row.telefono)) {
      porTelefono.set(row.telefono, { jugadas: [], sinCompra: row.sin_compra, compartio: row.compartio });
    }
    if (row.comercio) {
      porTelefono.get(row.telefono).jugadas.push({ comercio: row.comercio, chances: row.chances });
    }
  }
  return porTelefono;
}

function conPremio(filas, premios) {
  return filas.map((f) => ({ ...f, premio: premios[f.puesto] }));
}

/** Escapado RFC 4180: si la celda tiene coma, comilla o salto de línea, va
 * entre comillas y las comillas internas se duplican. */
function escaparCsv(valor) {
  const str = valor === null || valor === undefined ? '' : String(valor);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
