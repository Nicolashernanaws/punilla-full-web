'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pool, query } = require('../db/db');
const { play, stockRestante, totalFundadores } = require('../lib/engine');

async function reset() {
  await query('TRUNCATE fundadores RESTART IDENTITY');
  await query(`UPDATE counters SET val = 0 WHERE name='fundador'`);
  await query(`UPDATE premios SET stock_restante = stock_inicial`);
}

test('contador atómico: N jugadas concurrentes -> N números únicos y contiguos', async () => {
  await reset();
  const N = 60;
  const jugadas = Array.from({ length: N }, (_, i) =>
    play({ nombre: 'P' + i, telefonoRaw: '3541' + String(600000 + i), consent: true })
  );
  const res = await Promise.all(jugadas);
  const numeros = res.map((r) => r.fundador.numero).sort((a, b) => a - b);
  const set = new Set(numeros);
  assert.strictEqual(set.size, N, 'hay números repetidos');
  assert.strictEqual(numeros[0], 1);
  assert.strictEqual(numeros[N - 1], N);
  // contigüidad
  for (let i = 0; i < N; i++) assert.strictEqual(numeros[i], i + 1);
  assert.strictEqual(await totalFundadores(), N);
});

test('dedupe: mismo teléfono en 2 formatos -> 1 solo registro, mismo premio', async () => {
  await reset();
  const r1 = await play({ nombre: 'Ana', telefonoRaw: '+54 9 3541 623456', consent: true });
  const r2 = await play({ nombre: 'Ana', telefonoRaw: '03541 15 623456', consent: true });
  assert.strictEqual(r1.nuevo, true);
  assert.strictEqual(r2.nuevo, false);
  assert.strictEqual(r1.fundador.numero, r2.fundador.numero);
  assert.strictEqual(r1.fundador.codigo, r2.fundador.codigo);
  assert.strictEqual(r1.fundador.premio, undefined); // shape: premio_nombre
  assert.strictEqual(r1.fundador.premio_nombre, r2.fundador.premio_nombre);
  const cnt = await query('SELECT COUNT(*)::int c FROM fundadores');
  assert.strictEqual(cnt.rows[0].c, 1);
});

test('dedupe bajo carrera: mismo teléfono concurrente -> 1 registro', async () => {
  await reset();
  const tel = '3541777001';
  const res = await Promise.all([
    play({ nombre: 'x', telefonoRaw: tel, consent: true }),
    play({ nombre: 'x', telefonoRaw: '0' + tel, consent: true }),
    play({ nombre: 'x', telefonoRaw: '+549' + tel, consent: true }),
  ]);
  const nums = new Set(res.map((r) => r.fundador.numero));
  assert.strictEqual(nums.size, 1, 'la carrera creó más de un Fundador');
  const cnt = await query('SELECT COUNT(*)::int c FROM fundadores');
  assert.strictEqual(cnt.rows[0].c, 1);
  assert.strictEqual(await totalFundadores(), 1);
});

test('stock como tope duro: nunca negativo y el premium no se sobre-entrega', async () => {
  await reset();
  // Dejamos un único premio premium con stock 5 y el consuelo ilimitado.
  await query(`UPDATE premios SET activo = FALSE WHERE es_consuelo = FALSE`);
  await query(`UPDATE premios SET activo = TRUE, stock_restante = 5 WHERE nombre = '10% en toda la fiambrería'`);

  const N = 40;
  const res = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      play({ nombre: 'S' + i, telefonoRaw: '3548' + String(500000 + i), consent: true })
    )
  );
  // stock nunca negativo
  const st = await query(`SELECT stock_restante FROM premios WHERE nombre = '10% en toda la fiambrería'`);
  assert.strictEqual(st.rows[0].stock_restante, 0, 'el stock no llegó a 0 exacto');
  // exactamente 5 recibieron el premio premium; el resto, el consuelo
  const premium = res.filter((r) => r.fundador.premio_nombre === '10% en toda la fiambrería').length;
  const consuelo = res.filter((r) => r.fundador.premio_nombre === '5% en tu primera compra').length;
  assert.strictEqual(premium, 5, `se entregaron ${premium} premium (esperaba 5)`);
  assert.strictEqual(consuelo, N - 5, `consuelo=${consuelo}`);
  // reactivar para no ensuciar otros tests
  await query(`UPDATE premios SET activo = TRUE`);
});

test('teléfono inválido -> error TEL_INVALIDO', async () => {
  await reset();
  await assert.rejects(
    () => play({ nombre: 'x', telefonoRaw: '123', consent: true }),
    (e) => e.code === 'TEL_INVALIDO'
  );
});

test('stockRestante refleja la suma premium', async () => {
  await reset();
  const inicial = await stockRestante();
  assert.strictEqual(inicial, 150); // 40+30+30+25+15+10
  await play({ nombre: 'z', telefonoRaw: '3541900001', consent: true });
  const despues = await stockRestante();
  assert.strictEqual(despues, 149, 'no descontó del total premium');
});

test.after(async () => { await pool.end(); });
