// Tests de la ruta POST /api/sorteo/jugada.
// No tocamos Postgres: en vez de mock.module (que en Node 24 todavía pide el
// flag experimental --experimental-test-module-mocks, y el enunciado pide
// poder correr `node --test` a secas) le INYECTAMOS un doble de db.js como
// segundo argumento de rutaJugada(app, db) — la propia consigna lo habilita
// ("mockeá ... o inyectá un doble"). telefono.js y chances.js SÍ se usan
// reales porque son funciones puras (sin efectos de lado) y ya tienen su
// propia batería de tests en sorteo-logica.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rutaJugada } from '../src/jugada.js';

// --- Fake de Postgres en memoria -------------------------------------------
// Guarda participantes y jugadas como lo haría el schema real. Las queries
// se reconocen por fragmentos de texto porque no vale la pena parsear SQL
// de verdad para un mock: alcanza con que jugada.js use SIEMPRE los mismos
// fragmentos reconocibles (ver comentarios en src/jugada.js).
let estado;

function resetEstado() {
  estado = { participantes: new Map(), jugadas: [] };
}

function normalizarSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function ejecutarQueryFake(sql, params = []) {
  const s = normalizarSql(sql);

  if (s.includes('INSERT INTO sorteo_participante') && s.includes('ON CONFLICT')) {
    const [telefonoNorm, telefonoRaw, barrio, okNovedades] = params;
    const previo = estado.participantes.get(telefonoNorm);
    // Se emula la semántica REAL de Postgres: si el UPDATE usa COALESCE, un
    // valor nulo conserva el que ya estaba; si pisa con EXCLUDED a secas, lo
    // sobreescribe. Así el test distingue las dos variantes del SQL.
    const conservaBarrio = s.includes('COALESCE') && s.includes('barrio');
    const conservaNovedades = s.includes('COALESCE') && s.includes('ok_novedades');
    estado.participantes.set(telefonoNorm, {
      telefono_norm: telefonoNorm,
      telefono_raw: telefonoRaw,
      barrio: conservaBarrio && barrio == null ? previo?.barrio ?? null : barrio,
      ok_novedades:
        conservaNovedades && okNovedades == null ? previo?.ok_novedades ?? false : okNovedades,
      compartio: previo?.compartio ?? false,
      sin_compra: previo?.sin_compra ?? false,
    });
    return { rows: [] };
  }

  if (s.includes('SELECT') && s.includes('barrio') && s.includes('FROM sorteo_participante')) {
    const [telefonoNorm] = params;
    const p = estado.participantes.get(telefonoNorm);
    return { rows: p ? [p] : [] };
  }

  if (s.includes('SELECT') && s.includes('sorteo_participante') && s.includes('FOR UPDATE')) {
    const [telefonoNorm] = params;
    const p = estado.participantes.get(telefonoNorm);
    return { rows: p ? [{ sin_compra: p.sin_compra }] : [] };
  }

  if (s.includes('UPDATE sorteo_participante') && s.includes('sin_compra')) {
    const [telefonoNorm] = params;
    const p = estado.participantes.get(telefonoNorm);
    p.sin_compra = true;
    return { rows: [] };
  }

  if (s.includes('INSERT INTO sorteo_jugada')) {
    const [telefonoNorm, comercio, ticketNro, monto, chances] = params;
    const dup = estado.jugadas.some((j) => j.comercio === comercio && j.ticket_nro === ticketNro);
    if (dup) {
      // Mismo código que tira Postgres ante un UNIQUE (comercio, ticket_nro).
      const err = new Error('duplicate key value violates unique constraint "sorteo_jugada_comercio_ticket_nro_key"');
      err.code = '23505';
      throw err;
    }
    estado.jugadas.push({ telefono_norm: telefonoNorm, comercio, ticket_nro: ticketNro, monto, chances });
    return { rows: [] };
  }

  if (s.includes('SELECT') && s.includes('comercio') && s.includes('chances') && s.includes('FROM sorteo_jugada')) {
    const [telefonoNorm] = params;
    return {
      rows: estado.jugadas
        .filter((j) => j.telefono_norm === telefonoNorm)
        .map((j) => ({ comercio: j.comercio, chances: j.chances })),
    };
  }

  if (s.includes('SELECT') && s.includes('sin_compra') && s.includes('compartio') && s.includes('FROM sorteo_participante')) {
    const [telefonoNorm] = params;
    const p = estado.participantes.get(telefonoNorm);
    return { rows: [{ sin_compra: p.sin_compra, compartio: p.compartio }] };
  }

  throw new Error('Query no soportada por el mock de db.js: ' + s);
}

async function conTransaccionFake(fn) {
  // No hace falta simular rollback: los tests no ejercitan fallas a mitad de
  // transacción más allá de los 409, que ya vienen como excepciones normales.
  const cliente = { query: (sql, params) => ejecutarQueryFake(sql, params) };
  return fn(cliente);
}

const dbFake = {
  query: async (sql, params) => ejecutarQueryFake(sql, params),
  conTransaccion: conTransaccionFake,
};

// --- Helpers de Express falso ------------------------------------------------
function crearApp() {
  const rutas = {};
  const app = { post: (path, handler) => { rutas[path] = handler; } };
  return { app, rutas };
}

function crearRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function post(rutas, body) {
  const req = { body };
  const res = crearRes();
  await rutas['/api/sorteo/jugada'](req, res);
  return res;
}

function appConRuta() {
  const { app, rutas } = crearApp();
  rutaJugada(app, dbFake);
  return rutas;
}

// Teléfono válido de ejemplo (formato ya normalizado por telefono.js).
const TEL = '+543541267595';
const TEL_NORM = '3541267595';

describe('POST /api/sorteo/jugada', () => {
  test('registra un ticket y calcula las chances por monto', async () => {
    resetEstado();
    const rutas = appConRuta();
    const res = await post(rutas, {
      telefono: TEL,
      comercio: 'punilla',
      ticket: 'A-001',
      monto: 62000,
      barrio: 'Centro',
      okBases: true,
      okNovedades: true,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chancesTotal, 2); // 62000/25000 = 2 (redondeo abajo)
    assert.equal(res.body.sellos.punilla, true);
    assert.equal(res.body.sellos.tomato, false);
  });

  test('mismo (comercio, ticket) dos veces -> 409 y no suma chances', async () => {
    resetEstado();
    const rutas = appConRuta();
    const body = {
      telefono: TEL,
      comercio: 'tomato',
      ticket: 'B-777',
      monto: 30000,
      barrio: 'Centro',
      okBases: true,
      okNovedades: false,
    };
    const primera = await post(rutas, body);
    assert.equal(primera.statusCode, 200);
    assert.equal(primera.body.chancesTotal, 1);

    const segunda = await post(rutas, body);
    assert.equal(segunda.statusCode, 409);
    assert.ok(segunda.body.error);

    // Confirmamos que no se duplicó: sumamos otra jugada distinta y el total
    // solo refleja la primera carga + esta nueva, nunca dos veces la del dup.
    const tercera = await post(rutas, {
      telefono: TEL,
      comercio: 'lucy',
      ticket: 'C-1',
      monto: 25000,
      barrio: 'Centro',
      okBases: true,
      okNovedades: false,
    });
    assert.equal(tercera.statusCode, 200);
    assert.equal(tercera.body.chancesTotal, 2); // 1 (tomato) + 1 (lucy)
  });

  test('chances por monto: 62000 -> 2, 24999 -> 0, 300000 -> 10 (tope)', async () => {
    resetEstado();
    const rutas = appConRuta();

    const r1 = await post(rutas, {
      telefono: '3541111111', comercio: 'punilla', ticket: 'T1', monto: 62000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    assert.equal(r1.body.chancesTotal, 2);

    const r2 = await post(rutas, {
      telefono: '3541222222', comercio: 'punilla', ticket: 'T2', monto: 24999,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    assert.equal(r2.body.chancesTotal, 0);

    const r3 = await post(rutas, {
      telefono: '3541333333', comercio: 'punilla', ticket: 'T3', monto: 300000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    assert.equal(r3.body.chancesTotal, 10);
  });

  test('x2 solo se activa con punilla Y tomato juntos; lucy sola no alcanza', async () => {
    resetEstado();
    const rutas = appConRuta();
    const tel = '3549999999';

    // Solo lucy: sin multiplicador.
    await post(rutas, {
      telefono: tel, comercio: 'lucy', ticket: 'L1', monto: 25000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    const soloLucy = await post(rutas, {
      telefono: tel, comercio: 'lucy', ticket: 'L2', monto: 25000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    assert.equal(soloLucy.body.chancesTotal, 2); // 1 + 1, sin duplicar

    // Ahora sumamos punilla y tomato -> el total acumulado se duplica.
    await post(rutas, {
      telefono: tel, comercio: 'punilla', ticket: 'P1', monto: 25000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    const conAmbos = await post(rutas, {
      telefono: tel, comercio: 'tomato', ticket: 'TT1', monto: 25000,
      barrio: 'B', okBases: true, okNovedades: false,
    });
    // jugadas: lucy(1)+lucy(1)+punilla(1)+tomato(1) = 4, con x2 -> 8
    assert.equal(conAmbos.body.chancesTotal, 8);
  });

  test('chance gratis una sola vez por teléfono; la segunda es 409', async () => {
    resetEstado();
    const rutas = appConRuta();
    const body = { telefono: TEL, barrio: 'Centro', okBases: true, okNovedades: true };

    const primera = await post(rutas, body);
    assert.equal(primera.statusCode, 200);
    assert.equal(primera.body.chancesTotal, 1);

    const segunda = await post(rutas, body);
    assert.equal(segunda.statusCode, 409);
    assert.ok(segunda.body.error);
  });

  test('carga fuera de la ventana (después del cierre) se rechaza', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-24T10:00:00-03:00') });
    resetEstado();
    const rutas = appConRuta();
    const res = await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'X1', monto: 30000,
      barrio: 'Centro', okBases: true, okNovedades: false,
    });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.error);
  });

  test('sin okBases -> 400', async () => {
    resetEstado();
    const rutas = appConRuta();
    const res = await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'X2', monto: 30000,
      barrio: 'Centro', okNovedades: false,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
  });

  test('teléfono inválido -> 400', async () => {
    resetEstado();
    const rutas = appConRuta();
    const res = await post(rutas, {
      telefono: 'holaaaa', comercio: 'punilla', ticket: 'X3', monto: 30000,
      barrio: 'Centro', okBases: true, okNovedades: false,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
  });

  test('monto bajo el umbral: el mensaje dice cuánto falta', async () => {
    resetEstado();
    const rutas = appConRuta();
    const res = await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'X4', monto: 20000,
      barrio: 'Centro', okBases: true, okNovedades: false,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chancesTotal, 0);
    // falta = UMBRAL - (monto % UMBRAL) = 25000 - 20000 = 5000, mostrado con
    // separador de miles porque lo lee gente grande en el celular.
    assert.match(res.body.mensaje, /\$5\.000/);
  });
});

// Bug encontrado corriendo el flujo completo contra la base real el 21/8: el
// vecino carga su primer ticket con barrio "Centro" y okNovedades true, después
// carga un segundo ticket (el formulario ya no le vuelve a pedir el barrio) y
// el UPDATE le pisaba las dos cosas con null/false.
//
// Es pérdida de datos silenciosa: el barrio es EL dato de marketing de la
// campaña y ok_novedades es la base de la lista de difusión.
describe('el participante no pierde datos entre cargas', () => {
  test('una segunda carga sin barrio NO borra el barrio de la primera', async () => {
    resetEstado();
    const rutas = appConRuta();

    await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'B1', monto: 62000,
      barrio: 'Centro', okBases: true, okNovedades: true,
    });
    // El segundo ticket viene sin barrio ni okNovedades: el form no los repite.
    await post(rutas, {
      telefono: TEL, comercio: 'tomato', ticket: 'B2', monto: 50000, okBases: true,
    });

    const p = estado.participantes.get(TEL_NORM);
    assert.equal(p.barrio, 'Centro');
  });

  test('una segunda carga sin okNovedades NO borra el consentimiento', async () => {
    resetEstado();
    const rutas = appConRuta();

    await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'B3', monto: 62000,
      barrio: 'Centro', okBases: true, okNovedades: true,
    });
    await post(rutas, {
      telefono: TEL, comercio: 'tomato', ticket: 'B4', monto: 50000, okBases: true,
    });

    const p = estado.participantes.get(TEL_NORM);
    assert.equal(p.ok_novedades, true);
  });

  test('un barrio nuevo SÍ pisa al anterior (el vecino se mudó o lo corrigió)', async () => {
    resetEstado();
    const rutas = appConRuta();

    await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'B5', monto: 62000,
      barrio: 'Centro', okBases: true, okNovedades: true,
    });
    await post(rutas, {
      telefono: TEL, comercio: 'tomato', ticket: 'B6', monto: 50000,
      barrio: 'La Toma', okBases: true,
    });

    assert.equal(estado.participantes.get(TEL_NORM).barrio, 'La Toma');
  });

  // Un barrio vacío es "no lo cargó", no "borralo".
  test('un barrio vacío no borra el que ya estaba', async () => {
    resetEstado();
    const rutas = appConRuta();

    await post(rutas, {
      telefono: TEL, comercio: 'punilla', ticket: 'B7', monto: 62000,
      barrio: 'Centro', okBases: true, okNovedades: true,
    });
    await post(rutas, {
      telefono: TEL, comercio: 'tomato', ticket: 'B8', monto: 50000,
      barrio: '   ', okBases: true,
    });

    assert.equal(estado.participantes.get(TEL_NORM).barrio, 'Centro');
  });
});
