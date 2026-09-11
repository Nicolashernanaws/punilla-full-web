'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { query, withTx } = require('../db/db');
const { fechaOperativa } = require('./parte-fecha');
const { aplicarEvento } = require('./parte');
const {
  crearToken, leerToken, cookieDe, cabeceraCookie, cabeceraBorrar, verificarPin,
  DURACION_MS,
} = require('./parte-sesion');

/**
 * El Parte Diario: checklists de turno con rastro auditable.
 *
 * Va montado bajo /parte y no toca nada de la raspadita ni de Fundadores.
 */
const PUESTOS = ['enc_m', 'enc_t', 'fiam_m', 'fiam_t', 'prod'];

/**
 * La cookie del TABLERO, aparte de la de la gente.
 *
 * 🔴 EL PATH IMPORTA. Con `Path=/parte` esta cookie viajaría a las pantallas de
 * los puestos, y una sesión de dueño no tiene nada que hacer ahí. Va sólo a
 * /parte/admin.
 */
const COOKIE_ADMIN = 'parte_admin';
/**
 * Bajo qué "puesto" se anotan los intentos fallidos del tablero.
 *
 * No es un puesto de verdad: es la clave con la que `frenadoEnBase` cuenta. Se
 * usa el mismo mecanismo que el login de la gente a propósito, porque el freno
 * en memoria no sirve —Railway corre más de una réplica— y éste ya está probado
 * contra producción.
 */
const PUESTO_ADMIN = 'admin';

/**
 * Cuánto dura la sesión del tablero. Nico, 10/9: "no quiero entrar con token".
 *
 * EL PIN SE PONE UNA VEZ Y NO SE PIDE MÁS. Un año, y se renueva en cada request
 * autorizado: mientras abra el tablero una vez al año —o sea, siempre— no vuelve
 * a tipear nada. Eso es lo que reemplaza al link con token, que había que
 * generar, pegar en Railway, desplegar y después buscar en los logs.
 *
 * 🔴 UN AÑO ES EL TECHO ÚTIL, NO UN NÚMERO AL AZAR. Chrome recorta cualquier
 * cookie a 400 días: pedir más no da más, sólo da la ilusión de haberlo pedido.
 *
 * 🔴 NO ES LO MISMO QUE LA SESIÓN DE LA GENTE, Y POR ESO ES OTRA CONSTANTE. La
 * de los puestos dura 16 h porque el teléfono del local pasa de mano en mano al
 * cambio de turno: ahí una sesión larga sería que el que entra escriba con el
 * nombre del que se fue. El tablero es el teléfono de Nico y no lo agarra nadie
 * más, así que el riesgo es el otro —perder el teléfono—, y contra eso lo que
 * sirve es cambiar CODE_SECRET, que mata todas las sesiones de una.
 */
const DURACION_ADMIN_MS = 365 * 24 * 3600 * 1000;

/** La página de los puestos. La vista de lectura del dueño sirve ESTA MISMA. */
const PAGINA_PARTE = path.join(__dirname, '..', 'public', 'parte.html');

/** De qué puesto de la mañana lee cada puesto de la tarde para el traspaso. */
const TRASPASO = { enc_t: 'enc_m', fiam_t: 'fiam_m' };

/**
 * Primera línea del freno: contador en memoria, por IP **y puesto**.
 *
 * 🔴 UN PIN DE 4 DÍGITOS SON 10.000 COMBINACIONES: sin freno se rompe en
 * minutos, y en los campos del parte hay montos de caja. Por IP sola no alcanza
 * —el local sale por una sola IP y ahí un ataque contra un puesto consumiría el
 * cupo de todos—; por puesto solo tampoco, porque no distingue a quién.
 *
 * ⚠️ NO ALCANZA SOLO. Medido contra producción el 30/8: Railway corre más de una
 * réplica y cada una tiene su propio Map, así que el límite efectivo era 5 × la
 * cantidad de réplicas — y esa cantidad cambia sin avisar. Por eso el freno de
 * verdad está en la base (`frenadoEnBase`), que lo comparten todas. Éste queda
 * como primera barrera barata: evita que la ráfaga llegue a Postgres.
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
    const clave = (ipCliente(req) || 'x') + '|' + String(req.body?.puesto || '-');
    const arr = (hits.get(clave) || []).filter((t) => ahora - t < windowMs);
    arr.push(ahora);
    hits.set(clave, arr);
    if (arr.length > max) {
      return res.status(429).json({ error: 'demasiados_intentos' });
    }
    next();
  };
}

/** Identifica a quien golpea sin guardar su IP en claro. */
function huella(ip) {
  return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 12);
}

/**
 * La IP del cliente de verdad.
 *
 * 🔴 `req.ip` NO SIRVE ACÁ. Medido contra producción el 30/8: ocho intentos
 * seguidos desde la misma máquina quedaron anotados con DOS huellas distintas
 * (`fe41564257bf` y `d2d2de60daca`), así que el contador por IP nunca llegaba a
 * cinco. Con `trust proxy 1`, Express toma el último salto del
 * `X-Forwarded-For` —el proxy interno de Railway, que rota—; el cliente real es
 * el PRIMERO de la lista.
 */
function ipCliente(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const primera = xff.split(',')[0].trim();
  return primera || req.ip || '';
}

const FRENO_MAX = 5;
const FRENO_MINUTOS = 15;
/**
 * Tope por PUESTO, además del que va por IP.
 *
 * 🔴 EL DE ARRIBA SOLO NO ALCANZA porque el primer `X-Forwarded-For` lo escribe
 * el cliente y se puede falsificar rotándolo. Éste no se puede esquivar.
 *
 * Es más alto a propósito: un tope bajo por puesto dejaría a Julián sin poder
 * entrar con que alguien tire PINs desde afuera. Con 30 cada 15 minutos, agotar
 * las 10.000 combinaciones lleva más de 80 horas, y una persona que se equivoca
 * dos veces sigue entrando.
 */
const FRENO_PUESTO_MAX = 30;

/**
 * El freno compartido: cuenta los intentos fallidos en `parte_evento`.
 *
 * Va en la base y no en memoria porque hay más de una réplica y cada una tendría
 * su propio contador. Y se cuenta por (puesto, huella de IP) y no sólo por
 * puesto: si fuera por puesto, cualquiera podría dejar a Julián sin poder entrar
 * tirando PINs al azar desde afuera.
 *
 * Los fallidos quedan además a la vista del administrador en la línea de tiempo,
 * que es donde se nota si alguien está probando.
 */
async function frenadoEnBase(puesto, ip) {
  // Las dos cuentas salen de una sola consulta: el login es el camino caliente y
  // no vale la pena ir dos veces a la base para lo mismo.
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE valor = $2)::int AS por_ip,
            COUNT(*)::int                          AS por_puesto
       FROM parte_evento
      WHERE tipo = 'login_fallido' AND puesto = $1
        AND ts > now() - ($3 || ' minutes')::interval`,
    [puesto, huella(ip), String(FRENO_MINUTOS)],
  );
  return rows[0].por_ip >= FRENO_MAX || rows[0].por_puesto >= FRENO_PUESTO_MAX;
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
  /**
   * La cabecera de la cookie del tablero.
   *
   * No se usa `cabeceraCookie()` de parte-sesion porque ésa va con `Path=/parte`
   * y esta cookie NO tiene que llegar a las pantallas de la gente.
   */
  function cabeceraCookieAdmin(token) {
    const partes = [
      `${COOKIE_ADMIN}=${encodeURIComponent(token)}`,
      'Path=/parte/admin',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(DURACION_ADMIN_MS / 1000)}`,
    ];
    if (secure) partes.push('Secure');
    return partes.join('; ');
  }

  /**
   * Deja la sesión del tablero en el navegador, por 30 días.
   *
   * 🔴 EL `exp` DEL TOKEN Y EL `Max-Age` DE LA COOKIE TIENEN QUE IR JUNTOS. Si
   * sólo se estirara el Max-Age, la cookie seguiría viajando un mes y el
   * servidor la rechazaría a las 16 h: el síntoma sería un tablero que pide el
   * PIN igual, con una cookie viva al lado, y no habría por dónde agarrarlo.
   */
  function sembrarSesionAdmin(res) {
    res.setHeader(
      'Set-Cookie',
      cabeceraCookieAdmin(crearToken({ admin: true }, secret, Date.now(), DURACION_ADMIN_MS)),
    );
  }

  /** La sesión del tablero, o null. `admin` explícito: un token de puesto no sirve. */
  function sesionAdmin(req) {
    const d = leerToken(cookieDe(req, COOKIE_ADMIN), secret);
    return d && d.admin === true ? d : null;
  }

  /**
   * Dos caminos para entrar al tablero:
   *
   *   - la COOKIE, que es la persona desde el navegador. Nico, 4/9: "sacale la
   *     key, es un embole, quiero entrar y ver mas rapido". La clave no se saca
   *     —el tablero muestra los nombres de todos, la línea de tiempo entera y
   *     los campos de plata de la caja, en una URL que se adivina— pero deja de
   *     haber que tipearla cada vez.
   *   - la ADMIN_KEY por cabecera, que es como entran curl y los scripts. Es lo
   *     que permite verificar el tablero sin abrir un navegador.
   */
  function admitidoComoAdmin(req, res) {
    if (sesionAdmin(req)) {
      // Se renueva sola: mientras siga abriendo el tablero de vez en cuando, no
      // se le vuelve a pedir nada.
      sembrarSesionAdmin(res);
      return true;
    }
    const dada = String(req.get('x-admin-key') || req.query.key || '');
    // Comparación de largo primero para no reventar en timingSafeEqual.
    if (dada.length !== String(adminKey).length || dada !== String(adminKey)) return false;
    /*
     * 🔴 ACÁ ESTÁ EL "PONERLA UNA VEZ". Antes la key autorizaba el request y no
     * dejaba nada: cada vez había que volver a tipearla. Ahora deja la misma
     * cookie de 30 días que el PIN, así que `?key=…` desde el celular se pone
     * una sola vez.
     *
     * A curl tampoco le molesta: recibe un Set-Cookie que ignora.
     */
    sembrarSesionAdmin(res);
    return true;
  }

  function requiereAdmin(req, res, next) {
    if (admitidoComoAdmin(req, res)) return next();
    return res.status(401).json({ error: 'no_autorizado' });
  }

  /**
   * Lo mismo, pero para las PÁGINAS.
   *
   * Un 401 con JSON en la cara es lo correcto para la API y lo peor posible en
   * el navegador: quien abre un link vencido vería `{"error":"no_autorizado"}`
   * en blanco, sin nada para tocar. Se lo manda al tablero, que sabe pedir el
   * PIN y, si la cookie estaba viva, ni lo pide.
   */
  function requiereAdminPagina(req, res, next) {
    if (admitidoComoAdmin(req, res)) return next();
    return res.redirect('/parte/admin');
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
    const fecha = fechaOperativa();
    if (await frenadoEnBase(puesto, ipCliente(req))) {
      return res.status(429).json({ error: 'demasiados_intentos' });
    }

    const { rows } = await query(
      `SELECT id, nombre, pin_hash FROM parte_persona WHERE puesto = $1 AND activo`,
      [puesto],
    );
    // Se prueban todas las personas del puesto: el PIN identifica a la persona
    // DENTRO del puesto, así que Julián y Vanesa pueden rotar sin cambiar nada.
    const persona = rows.find((p) => verificarPin(pin, p.pin_hash));
    if (!persona) {
      // Queda anotado: es lo que hace que el freno lo compartan las réplicas, y
      // de paso el administrador ve en la línea de tiempo si alguien prueba.
      await query(
        `INSERT INTO parte_evento (fecha, puesto, tipo, valor) VALUES ($1,$2,'login_fallido',$3)`,
        [fecha, puesto, huella(ipCliente(req))],
      );
      return res.status(401).json({ error: 'pin_incorrecto' });
    }

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

  /**
   * Entrar al tablero con un PIN.
   *
   * El PIN sale de `PARTE_ADMIN_PIN` y NO de la base: es una sola persona y no
   * hace falta una tabla para eso. Si la variable no está seteada devuelve 503 y
   * la ADMIN_KEY sigue sirviendo, para no quedarse afuera del tablero por una
   * variable que falta.
   *
   * También entra con la ADMIN_KEY en el campo `clave`. Es el mismo secreto que
   * ya viajaba por `?key=` y por la cabecera; lo que cambia es que ahora
   * cualquiera de los tres caminos deja la sesión de 30 días, y por eso se pone
   * UNA vez. Sin esto, "guardarla en el celular" terminaba siendo el navegador
   * recordando la key en la barra de direcciones, que es el peor lugar donde
   * puede quedar.
   */
  r.post('/admin/api/login', async (req, res) => {
    const pin = String(req.body?.pin || '');
    const clave = String(req.body?.clave || '');
    const esperado = String(process.env.PARTE_ADMIN_PIN || '');
    if (!clave && !esperado) return res.status(503).json({ error: 'pin_no_configurado' });
    if (!clave && !/^\d{4,10}$/.test(pin)) return res.status(400).json({ error: 'datos_invalidos' });
    if (await frenadoEnBase(PUESTO_ADMIN, ipCliente(req))) {
      return res.status(429).json({ error: 'demasiados_intentos' });
    }

    // Los dos caminos terminan en la MISMA sesión de 30 días, y por eso se
    // comparan con el mismo código: dos entradas distintas serían dos lugares
    // donde equivocarse.
    const [dado, contra] = clave ? [clave, String(adminKey)] : [pin, esperado];
    // En tiempo constante, igual que el PIN de los puestos: comparar con === se
    // corta en el primer dígito distinto y eso se puede medir.
    const a = Buffer.from(dado);
    const b = Buffer.from(contra);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await query(
        `INSERT INTO parte_evento (fecha, puesto, tipo, valor) VALUES ($1,$2,'login_fallido',$3)`,
        [fechaOperativa(), PUESTO_ADMIN, huella(ipCliente(req))],
      );
      return res.status(401).json({ error: 'pin_incorrecto' });
    }

    sembrarSesionAdmin(res);
    res.json({ ok: true, dias: Math.round(DURACION_ADMIN_MS / 86400000) });
  });

  r.post('/admin/api/logout', (req, res) => {
    const partes = [`${COOKIE_ADMIN}=`, 'Path=/parte/admin', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
    res.json({ ok: true });
  });

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
      // `campos` va incluido: el panel de bandejas necesita los conteos de cada
      // día, y pedirlos día por día serían 30 requests para dibujar una pantalla.
      `SELECT fecha, puesto,
              jsonb_array_length(COALESCE(jsonb_path_query_array(items, '$.keyvalue()'), '[]'::jsonb)) AS hechas,
              cierre->>'estado' AS cierre,
              campos
         FROM parte_dia
        WHERE fecha BETWEEN $1 AND $2
        ORDER BY fecha DESC, puesto`,
      [desde, hasta],
    );
    res.json({ desde, hasta, dias: rows });
  });

  // ── Ver como lo ve el puesto ──────────────────────────────────────────────
  //
  // Nico, 10/9: "desde cada tarjeta del tablero, un botón «Ver como lo ve él»
  // que abra la lista del puesto en modo lectura, con la misma pantalla que usan
  // los empleados, sin PIN — se ve todo, no se puede tildar".
  //
  // 🔴 ES LA MISMA PÁGINA, NO UNA COPIA. Si fuera un HTML aparte, el día que se
  // agregue una tarea a fiambrería el dueño estaría mirando la lista vieja y no
  // tendría cómo enterarse. `public/parte.html` se dibuja en modo lectura cuando
  // la URL es ésta.
  //
  // 🔴 Y NO ABRE UNA SESIÓN DE PUESTO. El dueño entra con SU cookie de tablero;
  // la cookie del Parte no se toca. Si se le diera una sesión de fiambrería para
  // que la pantalla funcione, cualquier cosa que tocara quedaría firmada con el
  // nombre de otra persona, y el parte vale justamente porque dice QUIÉN dijo
  // que algo se hizo.

  const fechaPedida = (req) => (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || ''))
    ? String(req.query.fecha)
    : fechaOperativa());

  /**
   * Queda anotado que el dueño miró.
   *
   * Va con la FECHA MIRADA, no con la de hoy: así la apertura aparece en la
   * línea de tiempo del día que se estaba mirando, que es donde se la busca.
   *
   * Sin persona_id —el tablero no tiene una fila en parte_persona— y con la
   * huella de la IP en `valor`, igual que los intentos fallidos: alcanza para
   * distinguir dispositivos sin guardar la IP en claro.
   *
   * Si la escritura falla, la pantalla se abre igual. Es un registro, no un
   * permiso: dejar a Nico sin ver el turno porque no se pudo anotar que lo vio
   * sería tener la cosa al revés.
   */
  async function anotarVista(fecha, puesto, req) {
    try {
      await query(
        `INSERT INTO parte_evento (fecha, puesto, tipo, valor) VALUES ($1,$2,'admin_view',$3)`,
        [fecha, puesto, huella(ipCliente(req))],
      );
    } catch (e) {
      console.warn('[parte] no se pudo anotar la vista del tablero:', e.message);
    }
  }

  r.get('/admin/ver/:puesto', requiereAdminPagina, async (req, res) => {
    const puesto = String(req.params.puesto || '');
    if (!PUESTOS.includes(puesto)) return res.status(404).send('No existe.');
    await anotarVista(fechaPedida(req), puesto, req);
    res.sendFile(PAGINA_PARTE);
  });

  /**
   * El día de un puesto, para la vista de lectura. SÓLO LECTURA de verdad: es un
   * GET y no hay ningún POST que acepte la cookie del tablero.
   *
   * No usa `leerConLock`: ése hace INSERT del día si no existe, y mirar un
   * puesto no puede crearle el parte. Un día sin nada devuelve vacío.
   *
   * El traspaso viaja en la misma respuesta: la pantalla del turno tarde lo
   * dibuja arriba de todo, y sin él Nico no estaría viendo lo que ve el
   * empleado, que es el punto.
   */
  r.get('/admin/api/ver/:puesto', requiereAdmin, async (req, res) => {
    const puesto = String(req.params.puesto || '');
    if (!PUESTOS.includes(puesto)) return res.status(404).json({ error: 'puesto_desconocido' });
    const fecha = fechaPedida(req);
    const vacio = { items: {}, campos: {}, nota: '', cierre: null };
    const origen = TRASPASO[puesto];
    const [dia, previo] = await Promise.all([
      query(
        `SELECT items, campos, nota, cierre FROM parte_dia WHERE fecha = $1 AND puesto = $2`,
        [fecha, puesto],
      ),
      origen
        ? query(
          `SELECT items, campos, nota, cierre FROM parte_dia WHERE fecha = $1 AND puesto = $2`,
          [fecha, origen],
        )
        : Promise.resolve({ rows: [] }),
    ]);
    res.json({
      fecha,
      puesto,
      ...(dia.rows[0] || vacio),
      traspaso: origen ? (previo.rows[0] || vacio) : null,
    });
  });

  return r;
}

module.exports = {
  crearRutasParte, PUESTOS, TRASPASO, rateLimitPorClave,
  huella, ipCliente, FRENO_MAX, FRENO_MINUTOS, FRENO_PUESTO_MAX,
  COOKIE_ADMIN, PUESTO_ADMIN, DURACION_ADMIN_MS,
};
