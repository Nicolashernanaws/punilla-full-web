// Reglas de negocio del PUNILLA FULL SORTEO. Campaña de 4 días: lo que esté mal
// acá no se arregla a tiempo, así que cada regla del handoff tiene su test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizarTelefono } from '../src/telefono.js';
import { chancesDeMonto, totalDeChances, tieneMultiplicador, ventanaAbierta } from '../src/chances.js';

// El formato lo fija la tabla `fundadores`, que ya tiene 75 filas cargadas:
// 10 dígitos, sin +54, sin 9, sin 0 y sin 15. Ej: 3541267595.
describe('normalizarTelefono', () => {
  test('normaliza igual con +54, 9, 0 y 15', () => {
    const esperado = '3541267595';
    assert.equal(normalizarTelefono('+543541267595'), esperado);
    assert.equal(normalizarTelefono('+5493541267595'), esperado);
    assert.equal(normalizarTelefono('03541267595'), esperado);
    assert.equal(normalizarTelefono('0354115267595'), esperado);
    assert.equal(normalizarTelefono('3541267595'), esperado);
    assert.equal(normalizarTelefono('3541 15 267595'), esperado);
    assert.equal(normalizarTelefono('(03541) 15-26-75-95'), esperado);
  });

  test('un teléfono que no es argentino válido devuelve null', () => {
    assert.equal(normalizarTelefono(''), null);
    assert.equal(normalizarTelefono('123'), null);
    assert.equal(normalizarTelefono('holaaaa'), null);
    assert.equal(normalizarTelefono('1234567890123456'), null);
  });

  test('acepta celulares de Córdoba capital (351) y del valle (3541)', () => {
    assert.equal(normalizarTelefono('+5493512487291'), '3512487291');
    assert.equal(normalizarTelefono('+5493521407578'), '3521407578');
  });
});

describe('chancesDeMonto', () => {
  const UMBRAL = 25000;

  test('1 chance cada $UMBRAL, redondeando para abajo', () => {
    assert.equal(chancesDeMonto(62000, UMBRAL), 2);
    assert.equal(chancesDeMonto(25000, UMBRAL), 1);
    assert.equal(chancesDeMonto(49999, UMBRAL), 1);
  });

  test('por debajo del umbral no da ninguna chance', () => {
    assert.equal(chancesDeMonto(24999, UMBRAL), 0);
    assert.equal(chancesDeMonto(0, UMBRAL), 0);
  });

  test('el tope es 10 por ticket', () => {
    assert.equal(chancesDeMonto(300000, UMBRAL), 10);
    assert.equal(chancesDeMonto(9999999, UMBRAL), 10);
  });
});

describe('multiplicador ×2', () => {
  test('se activa con punilla Y tomato', () => {
    assert.equal(tieneMultiplicador(['punilla', 'tomato']), true);
    assert.equal(tieneMultiplicador(['tomato', 'punilla', 'punilla']), true);
  });

  test('lucy sola NO lo activa', () => {
    assert.equal(tieneMultiplicador(['lucy']), false);
    assert.equal(tieneMultiplicador(['lucy', 'lucy']), false);
  });

  // Lucy suma chances pero no cuenta para el ×2: es de otro rubro y la promo
  // conjunta que se comunicó es "comprá en los dos".
  test('lucy no reemplaza a ninguno de los dos', () => {
    assert.equal(tieneMultiplicador(['punilla', 'lucy']), false);
    assert.equal(tieneMultiplicador(['tomato', 'lucy']), false);
  });

  test('un solo comercio nunca alcanza', () => {
    assert.equal(tieneMultiplicador(['punilla']), false);
    assert.equal(tieneMultiplicador([]), false);
  });
});

// El total NO se persiste: se calcula. Un total desnormalizado en una campaña
// de 4 días es la forma más rápida de que el número que ve el vecino y el
// padrón del sorteo no coincidan.
describe('totalDeChances', () => {
  test('suma las jugadas', () => {
    const t = totalDeChances({
      jugadas: [{ comercio: 'punilla', chances: 2 }, { comercio: 'punilla', chances: 1 }],
      sinCompra: false,
      compartio: false,
    });
    assert.equal(t, 3);
  });

  test('la chance gratis suma 1', () => {
    assert.equal(totalDeChances({ jugadas: [], sinCompra: true, compartio: false }), 1);
  });

  test('compartir la historia suma 2', () => {
    assert.equal(totalDeChances({ jugadas: [], sinCompra: false, compartio: true }), 2);
  });

  test('el ×2 se aplica al final, sobre todo lo acumulado', () => {
    const t = totalDeChances({
      jugadas: [{ comercio: 'punilla', chances: 2 }, { comercio: 'tomato', chances: 1 }],
      sinCompra: true,
      compartio: true,
    });
    // (2 + 1 + 1 + 2) = 6, por 2 = 12
    assert.equal(t, 12);
  });

  test('sin punilla+tomato no se duplica', () => {
    const t = totalDeChances({
      jugadas: [{ comercio: 'punilla', chances: 2 }, { comercio: 'lucy', chances: 3 }],
      sinCompra: false,
      compartio: false,
    });
    assert.equal(t, 5);
  });
});

describe('ventana de carga', () => {
  const CIERRE = new Date('2026-08-23T23:00:00-03:00');

  test('el jueves de arranque está abierta', () => {
    assert.equal(ventanaAbierta(new Date('2026-08-20T21:00:00-03:00'), CIERRE), true);
  });

  test('un minuto antes del cierre todavía entra', () => {
    assert.equal(ventanaAbierta(new Date('2026-08-23T22:59:00-03:00'), CIERRE), true);
  });

  test('después del domingo 23/8 23:00 ART se rechaza', () => {
    assert.equal(ventanaAbierta(new Date('2026-08-23T23:00:01-03:00'), CIERRE), false);
    assert.equal(ventanaAbierta(new Date('2026-08-24T10:00:00-03:00'), CIERRE), false);
  });
});
