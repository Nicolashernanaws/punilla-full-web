/*
 * Cómo se llama cada campo del parte, y cuáles son pareja.
 *
 * POR QUÉ EXISTE (8/9). El tablero mostraba los ids crudos: `bj_fia 14`,
 * `m_bj_out 6,12,1`, `hormas 21`. Nico: "de los fiambreros a mi ver no entiendo
 * qué se puso". Los nombres estaban en la pantalla de ellas y el tablero no los
 * conocía.
 *
 * 🔴 ESTE ARCHIVO NO LO CARGA `parte.html`, A PROPÓSITO. Esa pantalla la usan
 * cinco personas todos los días y ya se rompió una vez; no vale meterle una
 * dependencia nueva para arreglar una pantalla que mira una sola persona. La
 * copia se mantiene sincronizada por un TEST (`parte-campos` en
 * test/parte-front.test.js): si alguien cambia una etiqueta en `parte.html` y no
 * acá, o al revés, no compila el test.
 */
(function (global) {
  /** id → { lab, unidad }. `lab` es EXACTAMENTE el de parte.html. */
  const CAMPOS = {
    // Fiambrería, al entrar
    f_temp: { lab: 'Mostrador al entrar', unidad: '°C' },
    bj_pic: { lab: 'Bandejas de picada', unidad: 'u' },
    bj_fia: { lab: 'Bandejas de fiambre', unidad: 'u' },
    bj_piz: { lab: 'Bandejas de pizza', unidad: 'u' },
    hormas: { lab: 'Hormas abiertas', unidad: 'u' },
    // Fiambrería, al salir
    m_merma: { lab: 'Merma del turno', unidad: 'kg' },
    m_bj_out: { lab: 'Bandejas al salir (pic/fia/piz)', unidad: 'u' },
    t_merma: { lab: 'Merma del turno', unidad: 'kg' },
    t_bj_out: { lab: 'Bandejas al salir (pic/fia/piz)', unidad: 'u' },
    // Encargado
    caja_ap: { lab: 'Fondo de caja verificado', unidad: '$' },
    c_sistema: { lab: 'Corte por sistema', unidad: '$' },
    c_contado: { lab: 'Contado', unidad: '$' },
    c_dif: { lab: 'Diferencia', unidad: '$' },
    z_sistema: { lab: 'Corte por sistema', unidad: '$' },
    z_retiro: { lab: 'Retiro contado', unidad: '$' },
    z_fondo: { lab: 'Fondo para mañana', unidad: '$' },
    y_ultimo: { lab: 'Lo que quedó en caja', unidad: '$' },
    y_total: { lab: 'Total del día', unidad: '$' },
    y_dif: { lab: 'Diferencia', unidad: '$' },
    // Producción de carne
    p_temp: { lab: 'Temperatura de la carne', unidad: '°C' },
    p_in: { lab: 'Kilos que entraron', unidad: 'kg' },
    p_out: { lab: 'Kilos en bandeja', unidad: 'kg' },
    p_merma: { lab: 'Recorte y merma', unidad: 'kg' },
  };

  /**
   * Los campos que cuentan LO MISMO al principio y al final del turno.
   *
   * Ésta es la información que el tablero perdía del todo: la fiambrería abre
   * con 14 bandejas de fiambre y cierra con 12, y eso estaba partido en dos
   * campos que ni se nombraban. Al lado uno del otro, se lee el turno.
   *
   * `salidaEn` guarda los tres números en un solo campo, separados por coma, en
   * el orden que dice su etiqueta: picada, fiambre, pizza.
   */
  const PARES = [
    {
      titulo: 'Bandejas',
      salidaEn: 'm_bj_out',
      filas: [
        { nombre: 'Picada', abrio: 'bj_pic' },
        { nombre: 'Fiambre', abrio: 'bj_fia' },
        { nombre: 'Pizza', abrio: 'bj_piz' },
      ],
    },
    {
      titulo: 'Bandejas',
      salidaEn: 't_bj_out',
      filas: [
        { nombre: 'Picada', abrio: null },
        { nombre: 'Fiambre', abrio: null },
        { nombre: 'Pizza', abrio: null },
      ],
    },
  ];

  /** Los ids que ya muestra un bloque de pares y no hay que repetir en la lista. */
  const enPares = new Set(
    PARES.flatMap((p) => [p.salidaEn, ...p.filas.map((f) => f.abrio)]).filter(Boolean),
  );

  /**
   * Las tres cosas que se cuentan en el mostrador, en el orden en que se
   * escriben en el campo de salida: picada, fiambre, pizza.
   */
  const BANDEJAS = [
    { nombre: 'Picada', abrio: 'bj_pic' },
    { nombre: 'Fiambre', abrio: 'bj_fia' },
    { nombre: 'Pizza', abrio: 'bj_piz' },
  ];

  global.PARTE_BANDEJAS = BANDEJAS;
  global.PARTE_CAMPOS = CAMPOS;
  global.PARTE_PARES = PARES;
  global.PARTE_EN_PARES = enPares;
})(typeof window !== 'undefined' ? window : globalThis);
