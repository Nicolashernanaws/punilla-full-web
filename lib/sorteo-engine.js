'use strict';
/**
 * Motor del PUNILLA FULL SORTEO — todo lo que toca la base.
 *
 * `db` es inyectable (último parámetro) para poder testear la mecánica sin
 * Postgres. `engine.test.js` de Fundadores necesita una base real y por eso
 * nunca corre en la máquina de Nico; esta campaña dura tres días y medio, no
 * hay margen para tests que en la práctica no se ejecutan.
 */
const crypto = require('crypto');
const dbReal = require('../db/db');
const { normalizePhone } = require('./phone');
const {
  PREMIOS,
  NOMBRE_COMERCIO,
  chancesDe,
  comercioValido,
  diaArg,
  registroCuenta,
  armarPadron,
  ventanaAbierta,
} = require('./sorteo');

/** Error de negocio: lo que el vecino tiene que leer, con su status HTTP. */
function fallo(status, mensaje, code) {
  const e = new Error(code || mensaje);
  e.status = status;
  e.mensajeUsuario = mensaje;
  return e;
}

/**
 * Anota un registro.
 *
 * Devuelve SIEMPRE el estado completo del teléfono (chances, sellos, si ya
 * participa), no sólo "ok": la landing muestra ese estado en la pantalla de
 * confirmación y no tiene que salir a pedirlo de nuevo.
 */
async function registrar(datos, db = dbReal) {
  const { nombre, telefonoRaw, comercio, consent, ip, userAgent } = datos;
  const ahora = datos.ahora || new Date();

  if (!ventanaAbierta(ahora)) {
    throw fallo(403, 'El sorteo ya cerró la carga. Seguinos para el próximo.', 'CERRADO');
  }
  if (!consent) {
    throw fallo(400, 'Para participar tenés que aceptar las bases del sorteo.', 'SIN_BASES');
  }
  const nombreLimpio = String(nombre || '').trim();
  if (nombreLimpio.length < 2) {
    throw fallo(400, 'Poné tu nombre.', 'SIN_NOMBRE');
  }
  if (!comercioValido(comercio)) {
    throw fallo(400, 'Elegí dónde compraste.', 'COMERCIO_INVALIDO');
  }
  const telefonoNorm = normalizePhone(telefonoRaw);
  if (!telefonoNorm || telefonoNorm.length !== 10) {
    throw fallo(
      400,
      'Fijate el número — necesitamos un WhatsApp válido para avisarte si ganás.',
      'TEL_INVALIDO'
    );
  }

  const dia = diaArg(ahora);

  return db.withTx(async (client) => {
    // Alta o actualización del participante.
    //
    // COALESCE y no EXCLUDED a secas: en la segunda carga el formulario vuelve
    // a mandar el nombre, pero si alguna vez llega vacío, un dato que no vino
    // es "no lo mandó", no "borralo". Un nombre nuevo SÍ pisa al anterior (lo
    // había escrito mal, o se anota otro de la familia con el mismo teléfono).
    await client.query(
      `INSERT INTO sorteo_participante (telefono_norm, telefono_raw, nombre, consent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telefono_norm) DO UPDATE
         SET nombre = COALESCE(NULLIF(EXCLUDED.nombre, ''), sorteo_participante.nombre),
             telefono_raw = COALESCE(EXCLUDED.telefono_raw, sorteo_participante.telefono_raw),
             consent = sorteo_participante.consent OR EXCLUDED.consent`,
      [telefonoNorm, telefonoRaw || null, nombreLimpio, !!consent]
    );

    // Row lock ANTES de contar. Sin esto, dos POSTs simultáneos del mismo
    // teléfono leen los dos el mismo "lleva 9 hoy" y los dos se anotan como
    // que cuentan: el tope de 10 se convierte en 11. Con el lock, el segundo
    // espera y ve el 10.
    await client.query(
      `SELECT 1 FROM sorteo_participante WHERE telefono_norm = $1 FOR UPDATE`,
      [telefonoNorm]
    );

    const yaHoy = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM sorteo_registro
        WHERE telefono_norm = $1 AND comercio = $2 AND dia = $3 AND cuenta = TRUE`,
      [telefonoNorm, comercio, dia]
    );
    const cuenta = registroCuenta(yaHoy.rows[0].n);

    await client.query(
      `INSERT INTO sorteo_registro (telefono_norm, comercio, dia, cuenta, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [telefonoNorm, comercio, dia, cuenta, ip || null, (userAgent || '').slice(0, 300) || null]
    );

    // El total se recalcula SIEMPRE desde los registros, nunca se persiste.
    const registros = await client.query(
      `SELECT comercio FROM sorteo_registro WHERE telefono_norm = $1 AND cuenta = TRUE`,
      [telefonoNorm]
    );
    const part = await client.query(
      `SELECT compartio FROM sorteo_participante WHERE telefono_norm = $1`,
      [telefonoNorm]
    );

    const estado = chancesDe({
      registros: registros.rows,
      compartio: part.rows[0] ? part.rows[0].compartio : false,
    });

    return {
      ...estado,
      nombre: nombreLimpio,
      comercio,
      comercioNombre: NOMBRE_COMERCIO[comercio],
    };
  });
}

/**
 * Trae, para cada teléfono, sus registros que cuentan y el flag `compartio`.
 *
 * Es la MISMA pregunta que responde el listado del admin y el padrón del
 * sorteo, así que sale de una sola función: dos consultas distintas para el
 * mismo número es exactamente cómo el listado y el padrón terminan sin
 * coincidir, y eso se descubre el jueves a las 21, en vivo.
 */
async function participantes(db = dbReal) {
  const r = await db.query(
    `SELECT p.telefono_norm,
            p.nombre,
            p.compartio,
            p.compartio_via,
            p.creado_en,
            COALESCE(
              ARRAY_AGG(reg.comercio) FILTER (WHERE reg.id IS NOT NULL),
              ARRAY[]::text[]
            ) AS comercios
       FROM sorteo_participante p
       LEFT JOIN sorteo_registro reg
              ON reg.telefono_norm = p.telefono_norm AND reg.cuenta = TRUE
      GROUP BY p.telefono_norm
      ORDER BY p.creado_en`
  );
  return r.rows.map((row) => {
    const registros = (row.comercios || []).map((c) => ({ comercio: c }));
    return { ...row, registros, ...chancesDe({ registros, compartio: row.compartio }) };
  });
}

/** Marca (o desmarca) que un teléfono compartió la historia. Lo hace el admin. */
async function marcarCompartio(telefonoRaw, via, valor, db = dbReal) {
  const telefonoNorm = normalizePhone(telefonoRaw);
  if (!telefonoNorm || telefonoNorm.length !== 10) {
    throw fallo(400, 'Ese teléfono no se entiende.', 'TEL_INVALIDO');
  }
  const r = await db.query(
    `UPDATE sorteo_participante
        SET compartio = $2,
            compartio_via = CASE WHEN $2 THEN $3 ELSE NULL END
      WHERE telefono_norm = $1
      RETURNING telefono_norm, nombre, compartio, compartio_via`,
    [telefonoNorm, valor !== false, via === 'caja' ? 'caja' : 'historia']
  );
  if (!r.rowCount) throw fallo(404, 'Ese teléfono no está anotado en el sorteo.', 'NO_EXISTE');
  return r.rows[0];
}

/**
 * PRNG determinista a partir de una semilla.
 *
 * No es `Math.random`: con la semilla guardada, cualquiera puede volver a
 * correr el sorteo y obtener exactamente los mismos cuatro ganadores. Eso es
 * lo que convierte "confiá en mí" en "acá está la semilla, verificalo" — y en
 * un sorteo donde los tres comercios son del mismo dueño, esa diferencia
 * importa más que de costumbre.
 */
function prngDesde(semilla) {
  let bloque = crypto.createHash('sha256').update(String(semilla)).digest();
  let i = 0;
  return function siguiente() {
    if (i + 4 > bloque.length) {
      bloque = crypto.createHash('sha256').update(bloque).digest();
      i = 0;
    }
    const n = bloque.readUInt32BE(i);
    i += 4;
    return n / 0x100000000;
  };
}

/**
 * Sortea los cuatro premios. Idempotente: si ya se sorteó, devuelve lo guardado.
 *
 * Cuatro ganadores DISTINTOS: cuando sale un teléfono que ya ganó, se descarta
 * y se sigue. Se sortea sobre el padrón expandido (una entrada por chance),
 * que es lo que se puede contar en pantalla delante de la gente.
 */
async function sortear({ semilla, forzar = false } = {}, db = dbReal) {
  const ya = await db.query(
    `SELECT puesto, telefono_norm, nombre, premio, semilla, padron_size, sorteado_en
       FROM sorteo_resultado ORDER BY puesto`
  );
  if (ya.rowCount && !forzar) return { nuevo: false, resultados: ya.rows };

  const gente = await participantes(db);
  const padron = armarPadron(gente);
  if (padron.length === 0) {
    throw fallo(
      409,
      'No hay nadie en el padrón todavía: nadie tiene la historia verificada.',
      'PADRON_VACIO'
    );
  }

  const semillaUsada = String(semilla || crypto.randomBytes(8).toString('hex'));
  const rnd = prngDesde(semillaUsada);
  const porTelefono = new Map(gente.map((p) => [p.telefono_norm, p]));

  const ganadores = [];
  const vistos = new Set();
  // Tope de intentos: si el padrón tiene menos de 4 personas distintas, esto
  // corta en vez de girar para siempre.
  const maxIntentos = padron.length * 20 + 100;
  for (let intento = 0; intento < maxIntentos && ganadores.length < 4; intento++) {
    const tel = padron[Math.floor(rnd() * padron.length)];
    if (vistos.has(tel)) continue;
    vistos.add(tel);
    ganadores.push(tel);
  }

  const filas = ganadores.map((tel, idx) => ({
    puesto: idx + 1,
    telefono_norm: tel,
    nombre: (porTelefono.get(tel) || {}).nombre || null,
    premio: PREMIOS[idx + 1],
  }));

  await db.withTx(async (client) => {
    if (forzar) await client.query('DELETE FROM sorteo_resultado');
    for (const f of filas) {
      await client.query(
        `INSERT INTO sorteo_resultado (puesto, telefono_norm, nombre, premio, semilla, padron_size)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [f.puesto, f.telefono_norm, f.nombre, f.premio, semillaUsada, padron.length]
      );
    }
  });

  return { nuevo: true, semilla: semillaUsada, padron_size: padron.length, resultados: filas };
}

module.exports = { registrar, participantes, marcarCompartio, sortear, prngDesde, fallo };
