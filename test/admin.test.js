// Rutas de admin del PUNILLA FULL SORTEO: listado/CSV de jugadas, marcar
// "compartió" y el sorteo final.
//
// NO se toca Postgres acá: `db` se inyecta (mismo patrón que rutaJugada en
// jugada.js) y el chequeo de ADMIN_KEY / randomInt / randomBytes / premios
// también se inyectan por un tercer parámetro opcional. Así el test no
// depende de setear ADMIN_KEY real en config.js ni del flag experimental
// --experimental-test-module-mocks: es un doble de verdad, no un mock de
// módulo.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

import { rutasAdmin } from '../src/admin.js';

// ── Doble de base de datos ──────────────────────────────────────────────────
//
// Reacciona por el texto de la SQL (siempre el mismo, porque lo escribimos acá
// al lado en admin.js) en vez de simular una tabla relacional entera. Es
// frágil a un refactor de las queries, pero ambos archivos son de este mismo
// cambio y quedan sincronizados.
function crearDbFake({ participantes = [], jugadas = [], resultados = [] } = {}) {
  let resultadosState = resultados.map((r) => ({ ...r }));

  function filasPadron(telefonoNorm) {
    const filas = [];
    for (const p of participantes) {
      if (telefonoNorm && p.telefono_norm !== telefonoNorm) continue;
      const propias = jugadas.filter((j) => j.telefono_norm === p.telefono_norm);
      if (propias.length === 0) {
        filas.push({
          telefono: p.telefono_norm,
          sin_compra: p.sin_compra,
          compartio: p.compartio,
          comercio: null,
          chances: null,
        });
      } else {
        for (const j of propias) {
          filas.push({
            telefono: p.telefono_norm,
            sin_compra: p.sin_compra,
            compartio: p.compartio,
            comercio: j.comercio,
            chances: j.chances,
          });
        }
      }
    }
    return filas;
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT puesto, telefono_norm AS telefono, semilla, padron_size FROM sorteo_resultado')) {
      return { rows: [...resultadosState].sort((a, b) => a.puesto - b.puesto) };
    }

    if (s.startsWith('UPDATE sorteo_participante SET compartio')) {
      const [telefono] = params;
      const p = participantes.find((x) => x.telefono_norm === telefono);
      if (!p) return { rows: [] };
      p.compartio = true;
      return { rows: [{ telefono_norm: telefono }] };
    }

    if (s.includes('FROM sorteo_participante p') && s.includes('LEFT JOIN sorteo_jugada j')) {
      const telefonoNorm = s.includes('WHERE p.telefono_norm = $1') ? params[0] : null;
      return { rows: filasPadron(telefonoNorm) };
    }

    if (s.includes('FROM sorteo_jugada j') && s.includes('JOIN sorteo_participante p')) {
      const filas = jugadas.map((j) => {
        const p = participantes.find((x) => x.telefono_norm === j.telefono_norm);
        return {
          telefono: p.telefono_norm,
          barrio: p.barrio,
          ok_novedades: p.ok_novedades,
          compartio: p.compartio,
          sin_compra: p.sin_compra,
          comercio: j.comercio,
          ticket_nro: j.ticket_nro,
          monto: j.monto,
          chances: j.chances,
          creado_en: j.creado_en,
        };
      });
      return { rows: filas };
    }

    throw new Error(`fake db: query no reconocida: ${s}`);
  }

  async function conTransaccion(fn) {
    const cliente = {
      query: async (sql, params) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith('DELETE FROM sorteo_resultado')) {
          resultadosState = [];
          return { rows: [] };
        }
        if (s.startsWith('INSERT INTO sorteo_resultado')) {
          const [puesto, telefono_norm, semilla, padron_size] = params;
          resultadosState.push({ puesto, telefono: telefono_norm, semilla, padron_size });
          return { rows: [] };
        }
        return query(sql, params);
      },
    };
    return fn(cliente);
  }

  return {
    query,
    conTransaccion,
    estado: () => ({ participantes, jugadas, resultados: resultadosState }),
  };
}

const ADMIN_KEY_TEST = 'clave-de-test-1234';

function crearApp(dbFake, overridesDeps = {}) {
  const app = express();
  app.use(express.json());
  rutasAdmin(app, dbFake, {
    esAdmin: (req) => req.get('x-admin-key') === ADMIN_KEY_TEST,
    ...overridesDeps,
  });
  return app;
}

async function conServidor(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(base, path, headers = {}) {
  return fetch(`${base}${path}`, { headers });
}
function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

// ── Datos de prueba: 5 vecinos, cada uno con una jugada de $ que da 2 chances,
// sin chance gratis ni compartir (para que padron_size sea previsible: 5*2=10).
function participantesBase() {
  return [
    { telefono_norm: '3541000001', telefono_raw: '3541000001', barrio: 'Centro', ok_novedades: true, compartio: false, sin_compra: false },
    { telefono_norm: '3541000002', telefono_raw: '3541000002', barrio: 'Villa Munich, sector 2', ok_novedades: false, compartio: false, sin_compra: false },
    { telefono_norm: '3541000003', telefono_raw: '3541000003', barrio: 'San Roque', ok_novedades: true, compartio: false, sin_compra: false },
    { telefono_norm: '3541000004', telefono_raw: '3541000004', barrio: 'Centro', ok_novedades: true, compartio: false, sin_compra: false },
    { telefono_norm: '3541000005', telefono_raw: '3541000005', barrio: 'Centro', ok_novedades: false, compartio: false, sin_compra: false },
  ];
}
function jugadasBase() {
  return participantesBase().map((p, i) => ({
    telefono_norm: p.telefono_norm,
    comercio: 'lucy',
    ticket_nro: `T${i}`,
    monto: 50000,
    chances: 2,
    creado_en: new Date('2026-08-20T12:00:00-03:00'),
  }));
}

describe('rutasAdmin', () => {
  describe('autenticación', () => {
    test('sin ADMIN_KEY válida devuelve 401', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const sinHeader = await get(base, '/api/sorteo/admin/jugadas');
        assert.equal(sinHeader.status, 401);

        const keyMala = await get(base, '/api/sorteo/admin/jugadas', { 'x-admin-key': 'no-es-la-key' });
        assert.equal(keyMala.status, 401);

        const compartioSinKey = await post(base, '/api/sorteo/admin/compartio', { telefono: '3541000001' });
        assert.equal(compartioSinKey.status, 401);

        const sortearSinKey = await post(base, '/api/sorteo/admin/sortear', {});
        assert.equal(sortearSinKey.status, 401);
      });
    });
  });

  describe('GET /jugadas', () => {
    test('el CSV escapa una celda con coma (RFC 4180)', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const resp = await get(base, '/api/sorteo/admin/jugadas?formato=csv', {
          'x-admin-key': ADMIN_KEY_TEST,
        });
        assert.equal(resp.status, 200);
        assert.match(resp.headers.get('content-type'), /text\/csv/);
        assert.match(resp.headers.get('content-disposition'), /attachment/);

        const texto = await resp.text();
        // La celda con coma tiene que sobrevivir entrecomillada, y el resto de
        // la fila no se tiene que correr de columna.
        assert.match(texto, /"Villa Munich, sector 2"/);
        const filas = texto.trim().split('\r\n');
        assert.equal(filas[0], 'telefono,barrio,comercio,ticket,monto,chances,ok_novedades,compartio,sin_compra,creado_en');
        // 1 header + 5 jugadas.
        assert.equal(filas.length, 6);
      });
    });
  });

  describe('POST /compartio', () => {
    test('sobre un teléfono inexistente devuelve 404', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const resp = await post(
          base,
          '/api/sorteo/admin/compartio',
          { telefono: '3541999999' },
          { 'x-admin-key': ADMIN_KEY_TEST }
        );
        assert.equal(resp.status, 404);
      });
    });

    test('marca compartio=true y es idempotente', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const r1 = await post(
          base,
          '/api/sorteo/admin/compartio',
          { telefono: '+543541000001' }, // sin normalizar: el endpoint normaliza
          { 'x-admin-key': ADMIN_KEY_TEST }
        );
        assert.equal(r1.status, 200);
        const r2 = await post(
          base,
          '/api/sorteo/admin/compartio',
          { telefono: '3541000001' },
          { 'x-admin-key': ADMIN_KEY_TEST }
        );
        assert.equal(r2.status, 200);
        assert.equal(db.estado().participantes[0].compartio, true);
      });
    });
  });

  describe('POST /sortear', () => {
    test('elige 4 teléfonos distintos y guarda semilla + padron_size', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const resp = await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST });
        assert.equal(resp.status, 200);
        const body = await resp.json();

        assert.equal(body.yaSorteado, false);
        assert.equal(body.resultados.length, 4);

        const telefonos = body.resultados.map((r) => r.telefono);
        assert.equal(new Set(telefonos).size, 4, 'los 4 ganadores tienen que ser distintos');

        const semillas = new Set(body.resultados.map((r) => r.semilla));
        assert.equal(semillas.size, 1, 'las 4 filas comparten la misma semilla');
        assert.match(body.resultados[0].semilla, /^[0-9a-f]{32}$/);

        // 5 participantes, 2 chances cada uno (lucy, sin gratis ni compartir,
        // sin multiplicador) => padrón de 10.
        for (const r of body.resultados) {
          assert.equal(r.padron_size, 10);
        }

        // El puesto 1 tiene que traer el nombre del premio.
        assert.ok(body.resultados.find((r) => r.puesto === 1).premio);
      });
    });

    test('correr el sorteo dos veces sin force NO cambia el resultado', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const r1 = await (await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST })).json();
        const r2 = await (await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST })).json();

        assert.equal(r1.yaSorteado, false);
        assert.equal(r2.yaSorteado, true);
        assert.deepEqual(r2.resultados.map((r) => r.telefono), r1.resultados.map((r) => r.telefono));
        assert.deepEqual(r2.resultados.map((r) => r.semilla), r1.resultados.map((r) => r.semilla));
      });
    });

    test('con force:true sí vuelve a sortear (semilla nueva)', async () => {
      const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const r1 = await (await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST })).json();
        const r2 = await (
          await post(base, '/api/sorteo/admin/sortear', { force: true }, { 'x-admin-key': ADMIN_KEY_TEST })
        ).json();

        assert.equal(r2.yaSorteado, false);
        assert.notEqual(r2.resultados[0].semilla, r1.resultados[0].semilla);
        // Se pisó el resultado anterior, no se acumuló (siguen siendo 4 filas).
        assert.equal(db.estado().resultados.length, 4);
      });
    });

    test('con menos de 4 teléfonos únicos en el padrón devuelve 400 y no repite ganadores', async () => {
      const tresParticipantes = participantesBase().slice(0, 3);
      const tresJugadas = jugadasBase().slice(0, 3);
      const db = crearDbFake({ participantes: tresParticipantes, jugadas: tresJugadas });
      const app = crearApp(db);
      await conServidor(app, async (base) => {
        const resp = await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST });
        assert.equal(resp.status, 400);
        const body = await resp.json();
        assert.match(body.error, /4/); // mensaje claro, menciona que hacen falta 4
        assert.equal(db.estado().resultados.length, 0, 'no se guardó nada');
      });
    });

    test('nunca usa Math.random para elegir ganadores', async () => {
      const original = Math.random;
      Math.random = () => {
        throw new Error('¡Math.random no debería llamarse nunca acá!');
      };
      try {
        const db = crearDbFake({ participantes: participantesBase(), jugadas: jugadasBase() });
        const app = crearApp(db);
        await conServidor(app, async (base) => {
          const resp = await post(base, '/api/sorteo/admin/sortear', {}, { 'x-admin-key': ADMIN_KEY_TEST });
          assert.equal(resp.status, 200);
        });
      } finally {
        Math.random = original;
      }
    });
  });
});
