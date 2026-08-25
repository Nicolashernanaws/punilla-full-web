'use strict';
/**
 * Tests del PUNILLA FULL SORTEO.
 *
 * Corren SIN Postgres, contra una base falsa en memoria. Es deliberado:
 * `engine.test.js` de Fundadores pide un Postgres real y por eso en la práctica
 * nunca se ejecuta. Una campaña de tres días y medio no se puede permitir una
 * suite que nadie corre.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chancesDe,
  tieneMultiplicador,
  ventanaAbierta,
  registroCuenta,
  armarPadron,
  diaArg,
  TOPE_DIARIO,
} = require('../lib/sorteo');
const { registrar, participantes, marcarCompartio, sortear } = require('../lib/sorteo-engine');

// ─── Base falsa ─────────────────────────────────────────────────────────────
// Enruta por la forma de la consulta. No es un Postgres: es lo mínimo para que
// la mecánica se pueda ejercitar de verdad (tope diario, ×2, requisito).
function baseFalsa() {
  const participantesTbl = new Map(); // telefono_norm -> fila
  const registros = []; // {id, telefono_norm, comercio, dia, cuenta}
  const resultados = [];

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO sorteo_participante')) {
      const [tel, raw, nombre, consent] = params;
      const previo = participantesTbl.get(tel);
      if (!previo) {
        participantesTbl.set(tel, {
          telefono_norm: tel,
          telefono_raw: raw,
          nombre,
          consent: !!consent,
          compartio: false,
          compartio_via: null,
          creado_en: new Date(Date.now() + participantesTbl.size),
        });
      } else {
        if (nombre) previo.nombre = nombre;
        if (raw) previo.telefono_raw = raw;
        previo.consent = previo.consent || !!consent;
      }
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT 1 FROM sorteo_participante')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (s.startsWith('SELECT COUNT(*)::int AS n FROM sorteo_registro')) {
      const [tel, comercio, dia] = params;
      const n = registros.filter(
        (r) => r.telefono_norm === tel && r.comercio === comercio && r.dia === dia && r.cuenta
      ).length;
      return { rows: [{ n }], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO sorteo_registro')) {
      const [tel, comercio, dia, cuenta] = params;
      registros.push({ id: registros.length + 1, telefono_norm: tel, comercio, dia, cuenta });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT comercio FROM sorteo_registro')) {
      const [tel] = params;
      return {
        rows: registros
          .filter((r) => r.telefono_norm === tel && r.cuenta)
          .map((r) => ({ comercio: r.comercio })),
      };
    }

    if (s.startsWith('SELECT compartio FROM sorteo_participante')) {
      const [tel] = params;
      const p = participantesTbl.get(tel);
      return { rows: p ? [{ compartio: p.compartio }] : [], rowCount: p ? 1 : 0 };
    }

    if (s.startsWith('SELECT p.telefono_norm')) {
      const rows = [...participantesTbl.values()]
        .sort((a, b) => a.creado_en - b.creado_en)
        .map((p) => ({
          ...p,
          comercios: registros
            .filter((r) => r.telefono_norm === p.telefono_norm && r.cuenta)
            .map((r) => r.comercio),
        }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('UPDATE sorteo_participante')) {
      const [tel, valor, via] = params;
      const p = participantesTbl.get(tel);
      if (!p) return { rows: [], rowCount: 0 };
      p.compartio = valor;
      p.compartio_via = valor ? via : null;
      return { rows: [{ ...p }], rowCount: 1 };
    }

    if (s.startsWith('SELECT puesto, telefono_norm')) {
      return { rows: [...resultados], rowCount: resultados.length };
    }

    if (s.startsWith('DELETE FROM sorteo_resultado')) {
      resultados.length = 0;
      return { rows: [], rowCount: 0 };
    }

    if (s.startsWith('INSERT INTO sorteo_resultado')) {
      const [puesto, telefono_norm, nombre, premio, semilla, padron_size] = params;
      resultados.push({ puesto, telefono_norm, nombre, premio, semilla, padron_size });
      return { rows: [], rowCount: 1 };
    }

    throw new Error('La base falsa no conoce esta consulta: ' + s.slice(0, 90));
  }

  return {
    query,
    withTx: (fn) => fn({ query }),
    _tablas: { participantes: participantesTbl, registros, resultados },
  };
}

// Un momento dentro de la ventana de carga, para que los tests no dependan de
// cuándo se corran. El 26/8 a las 15 hs está entre el arranque y el cierre.
const ENVENTANA = new Date('2026-08-26T15:00:00-03:00');

function datos(extra = {}) {
  return {
    nombre: 'Vecina de Cosquín',
    telefonoRaw: '3541623456',
    comercio: 'punilla',
    consent: true,
    ahora: ENVENTANA,
    ...extra,
  };
}

// ─── Reglas puras ───────────────────────────────────────────────────────────
test('reglas de chances', async (t) => {
  await t.test('un registro = una chance', () => {
    assert.equal(chancesDe({ registros: [{ comercio: 'punilla' }] }).chances, 1);
  });

  await t.test('tres registros en un mismo comercio = tres chances', () => {
    const regs = [{ comercio: 'punilla' }, { comercio: 'punilla' }, { comercio: 'punilla' }];
    assert.equal(chancesDe({ registros: regs }).chances, 3);
  });

  await t.test('el x2 pide punilla Y tomato; lucy sola no alcanza', () => {
    assert.equal(tieneMultiplicador(['punilla', 'tomato']), true);
    assert.equal(tieneMultiplicador(['punilla', 'lucy']), false);
    assert.equal(tieneMultiplicador(['lucy']), false);
    assert.equal(tieneMultiplicador([]), false);
  });

  await t.test('el x2 se aplica sobre TODO lo acumulado, no sobre el ultimo', () => {
    const regs = [
      { comercio: 'punilla' },
      { comercio: 'punilla' },
      { comercio: 'lucy' },
      { comercio: 'tomato' },
    ];
    // 4 registros x2 = 8, aunque lucy no active el multiplicador ella sola.
    assert.equal(chancesDe({ registros: regs }).chances, 8);
  });

  await t.test('sin compartir la historia NO participa, aunque tenga chances', () => {
    const r = chancesDe({ registros: [{ comercio: 'punilla' }], compartio: false });
    assert.equal(r.chances, 1);
    assert.equal(r.participa, false, 'el requisito de la historia es lo que habilita');
  });

  await t.test('compartir sin ningun registro tampoco participa', () => {
    assert.equal(chancesDe({ registros: [], compartio: true }).participa, false);
  });
});

test('la ventana de carga', async (t) => {
  const cierre = new Date('2026-08-27T20:00:00-03:00');

  await t.test('un minuto antes del cierre todavia se puede', () => {
    assert.equal(ventanaAbierta(new Date('2026-08-27T19:59:00-03:00'), cierre), true);
  });

  await t.test('a las 20:00:00 en punto ya esta cerrado', () => {
    assert.equal(ventanaAbierta(new Date('2026-08-27T20:00:00-03:00'), cierre), false);
  });
});

test('el dia argentino no se corre por UTC', () => {
  // 23:30 del 26 en Argentina son las 02:30 UTC del 27. Si el dia saliera de
  // UTC, el tope diario se reiniciaria a las 21 y no a medianoche.
  assert.equal(diaArg(new Date('2026-08-26T23:30:00-03:00')), '2026-08-26');
  assert.equal(diaArg(new Date('2026-08-27T00:10:00-03:00')), '2026-08-27');
});

test('el tope antifraude corta en 10', () => {
  assert.equal(registroCuenta(0), true);
  assert.equal(registroCuenta(TOPE_DIARIO - 1), true, 'el decimo todavia cuenta');
  assert.equal(registroCuenta(TOPE_DIARIO), false, 'el once ya no');
});

// ─── Mecánica completa contra la base falsa ─────────────────────────────────
test('POST de registro', async (t) => {
  await t.test('anotarse una vez da una chance y el sello del comercio', async () => {
    const db = baseFalsa();
    const r = await registrar(datos(), db);
    assert.equal(r.chances, 1);
    assert.equal(r.sellos.punilla, true);
    assert.equal(r.sellos.tomato, false);
    assert.equal(r.multiplicador, false);
  });

  await t.test('anotarse en punilla y en tomato activa el x2', async () => {
    const db = baseFalsa();
    await registrar(datos({ comercio: 'punilla' }), db);
    const r = await registrar(datos({ comercio: 'tomato' }), db);
    assert.equal(r.multiplicador, true);
    assert.equal(r.chances, 4, '2 registros x2');
  });

  await t.test('el mismo telefono en dos formatos es UNA sola persona', async () => {
    const db = baseFalsa();
    await registrar(datos({ telefonoRaw: '+54 9 3541 62-3456', comercio: 'punilla' }), db);
    const r = await registrar(datos({ telefonoRaw: '03541 15 623456', comercio: 'tomato' }), db);
    assert.equal(db._tablas.participantes.size, 1, 'no puede quedar como dos vecinos distintos');
    assert.equal(r.multiplicador, true, 'y por eso el x2 se le activa');
  });

  await t.test('registros ilimitados: el quinto suma como el primero', async () => {
    const db = baseFalsa();
    let r;
    for (let i = 0; i < 5; i++) r = await registrar(datos(), db);
    assert.equal(r.chances, 5);
  });

  await t.test('pasado el tope diario deja de sumar, y no se lo decimos', async () => {
    const db = baseFalsa();
    let r;
    for (let i = 0; i < TOPE_DIARIO + 3; i++) r = await registrar(datos(), db);
    assert.equal(r.chances, TOPE_DIARIO, 'las de mas no cuentan');
    assert.equal(
      db._tablas.registros.length,
      TOPE_DIARIO + 3,
      'pero quedan guardadas para poder auditar el intento'
    );
    assert.ok(!('tope' in r), 'la respuesta no delata el tope');
  });

  await t.test('el tope es por comercio, no global', async () => {
    const db = baseFalsa();
    for (let i = 0; i < TOPE_DIARIO; i++) await registrar(datos({ comercio: 'punilla' }), db);
    const r = await registrar(datos({ comercio: 'tomato' }), db);
    // 10 de punilla + 1 de tomato = 11, y ademas se activo el x2.
    assert.equal(r.chances, 22);
  });

  await t.test('el tope se reinicia al dia siguiente', async () => {
    const db = baseFalsa();
    for (let i = 0; i < TOPE_DIARIO + 2; i++) await registrar(datos(), db);
    const r = await registrar(datos({ ahora: new Date('2026-08-27T10:00:00-03:00') }), db);
    assert.equal(r.chances, TOPE_DIARIO + 1);
  });

  await t.test('con la carga cerrada devuelve 403', async () => {
    const db = baseFalsa();
    await assert.rejects(
      () => registrar(datos({ ahora: new Date('2026-08-27T20:00:01-03:00') }), db),
      (e) => e.status === 403
    );
  });

  await t.test('sin aceptar las bases devuelve 400', async () => {
    const db = baseFalsa();
    await assert.rejects(() => registrar(datos({ consent: false }), db), (e) => e.status === 400);
  });

  await t.test('sin nombre devuelve 400', async () => {
    const db = baseFalsa();
    await assert.rejects(() => registrar(datos({ nombre: ' ' }), db), (e) => e.status === 400);
  });

  await t.test('telefono invalido devuelve 400', async () => {
    const db = baseFalsa();
    await assert.rejects(() => registrar(datos({ telefonoRaw: '123' }), db), (e) => e.status === 400);
  });

  await t.test('un comercio que no participa devuelve 400', async () => {
    const db = baseFalsa();
    await assert.rejects(
      () => registrar(datos({ comercio: 'kiosco-de-la-esquina' }), db),
      (e) => e.status === 400
    );
  });

  await t.test('el vecino NO puede marcarse la historia como compartida', async () => {
    const db = baseFalsa();
    const r = await registrar(datos({ compartio: true, participa: true }), db);
    assert.equal(r.participa, false, 'mandarlo en el body no tiene que servir de nada');
  });

  await t.test('una segunda carga sin nombre no borra el que ya estaba', async () => {
    const db = baseFalsa();
    await registrar(datos({ nombre: 'Marta Gómez' }), db);
    await registrar(datos({ nombre: 'Marta Gómez' }), db);
    assert.equal(db._tablas.participantes.get('3541623456').nombre, 'Marta Gómez');
  });
});

// ─── Padrón y sorteo ────────────────────────────────────────────────────────
async function conGente(db, cuantos) {
  for (let i = 0; i < cuantos; i++) {
    const tel = '354162' + String(1000 + i).slice(-4);
    await registrar(datos({ telefonoRaw: tel, nombre: 'Vecino ' + i }), db);
    await marcarCompartio(tel, 'historia', true, db);
  }
}

test('el padron y el sorteo', async (t) => {
  await t.test('solo entra al padron el que compartio', async () => {
    const db = baseFalsa();
    await registrar(datos({ telefonoRaw: '3541620001' }), db);
    await registrar(datos({ telefonoRaw: '3541620002' }), db);
    await marcarCompartio('3541620002', 'historia', true, db);

    const padron = armarPadron(await participantes(db));
    assert.deepEqual(padron, ['3541620002']);
  });

  await t.test('la via presencial vale igual que la historia', async () => {
    const db = baseFalsa();
    await registrar(datos({ telefonoRaw: '3541620003' }), db);
    await marcarCompartio('3541620003', 'caja', true, db);
    const [p] = await participantes(db);
    assert.equal(p.participa, true);
    assert.equal(p.compartio_via, 'caja');
  });

  await t.test('el padron pone una entrada por chance', async () => {
    const db = baseFalsa();
    await registrar(datos({ telefonoRaw: '3541620004', comercio: 'punilla' }), db);
    await registrar(datos({ telefonoRaw: '3541620004', comercio: 'punilla' }), db);
    await registrar(datos({ telefonoRaw: '3541620004', comercio: 'tomato' }), db);
    await marcarCompartio('3541620004', 'historia', true, db);

    const padron = armarPadron(await participantes(db));
    assert.equal(padron.length, 6, '3 registros x2 del multiplicador');
  });

  await t.test('desmarcar la historia lo saca del padron', async () => {
    const db = baseFalsa();
    await registrar(datos({ telefonoRaw: '3541620005' }), db);
    await marcarCompartio('3541620005', 'historia', true, db);
    await marcarCompartio('3541620005', 'historia', false, db);
    assert.equal(armarPadron(await participantes(db)).length, 0);
  });

  await t.test('marcar un telefono que no se anoto devuelve 404', async () => {
    const db = baseFalsa();
    await assert.rejects(
      () => marcarCompartio('3541629999', 'historia', true, db),
      (e) => e.status === 404
    );
  });

  await t.test('salen 4 ganadores DISTINTOS', async () => {
    const db = baseFalsa();
    await conGente(db, 30);
    const r = await sortear({ semilla: 'punilla-2026' }, db);
    assert.equal(r.resultados.length, 4);
    assert.equal(new Set(r.resultados.map((g) => g.telefono_norm)).size, 4);
  });

  await t.test('cada puesto se lleva su premio', async () => {
    const db = baseFalsa();
    await conGente(db, 30);
    const r = await sortear({ semilla: 'punilla-2026' }, db);
    assert.match(r.resultados[0].premio, /Lucy/);
    assert.match(r.resultados[1].premio, /Tomato/);
    assert.match(r.resultados[2].premio, /25\.000/);
    assert.match(r.resultados[3].premio, /25\.000/);
  });

  await t.test('la misma semilla da los mismos ganadores (es auditable)', async () => {
    const db1 = baseFalsa();
    const db2 = baseFalsa();
    await conGente(db1, 30);
    await conGente(db2, 30);
    const a = await sortear({ semilla: 'la-misma' }, db1);
    const b = await sortear({ semilla: 'la-misma' }, db2);
    assert.deepEqual(
      a.resultados.map((g) => g.telefono_norm),
      b.resultados.map((g) => g.telefono_norm)
    );
  });

  await t.test('volver a sortear devuelve lo ya sorteado, no vuelve a tirar', async () => {
    const db = baseFalsa();
    await conGente(db, 30);
    const primero = await sortear({ semilla: 'una-sola-vez' }, db);
    const segundo = await sortear({ semilla: 'otra-distinta' }, db);
    assert.equal(segundo.nuevo, false);
    assert.deepEqual(
      segundo.resultados.map((g) => g.telefono_norm),
      primero.resultados.map((g) => g.telefono_norm)
    );
  });

  await t.test('guarda semilla y tamaño del padron para poder auditarlo', async () => {
    const db = baseFalsa();
    await conGente(db, 12);
    const r = await sortear({ semilla: 'auditame' }, db);
    assert.equal(r.padron_size, 12);
    assert.equal(db._tablas.resultados[0].semilla, 'auditame');
    assert.equal(db._tablas.resultados[0].padron_size, 12);
  });

  await t.test('con padron vacio avisa y no inventa ganadores', async () => {
    const db = baseFalsa();
    await registrar(datos(), db); // se anoto pero nadie le verifico la historia
    await assert.rejects(() => sortear({ semilla: 'x' }, db), (e) => e.status === 409);
  });

  await t.test('con menos de 4 personas no se cuelga: entrega las que hay', async () => {
    const db = baseFalsa();
    await conGente(db, 2);
    const r = await sortear({ semilla: 'poquitos' }, db);
    assert.equal(r.resultados.length, 2);
  });
});
