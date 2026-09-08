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
    hormas_cerr: { lab: 'Hormas cerradas', unidad: 'u' },
    // Fiambrería, al salir
    m_merma: { lab: 'Merma del turno', unidad: 'kg' },
    m_arm_pic: { lab: 'Picadas que armaste', unidad: 'u' },
    m_arm_fia: { lab: 'Bandejas de fiambre que armaste', unidad: 'u' },
    m_arm_piz: { lab: 'Pizzas que armaste', unidad: 'u' },
    m_out_pic: { lab: 'Bandejas de picada al salir', unidad: 'u' },
    m_out_fia: { lab: 'Bandejas de fiambre al salir', unidad: 'u' },
    m_out_piz: { lab: 'Bandejas de pizza al salir', unidad: 'u' },
    m_hormas_out: { lab: 'Hormas abiertas al salir', unidad: 'u' },
    t_merma: { lab: 'Merma del turno', unidad: 'kg' },
    t_arm_pic: { lab: 'Picadas que armaste', unidad: 'u' },
    t_arm_fia: { lab: 'Bandejas de fiambre que armaste', unidad: 'u' },
    t_arm_piz: { lab: 'Pizzas que armaste', unidad: 'u' },
    t_out_pic: { lab: 'Bandejas de picada al salir', unidad: 'u' },
    t_out_fia: { lab: 'Bandejas de fiambre al salir', unidad: 'u' },
    t_out_piz: { lab: 'Bandejas de pizza al salir', unidad: 'u' },
    t_hormas_out: { lab: 'Hormas abiertas al salir', unidad: 'u' },
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
   * Campos que YA NO se piden, pero que están en los partes viejos.
   *
   * 🔴 NO SE BORRAN. Hasta el 8/9 los tres conteos de salida iban en una sola
   * casilla, y esos días son datos reales de gente que trabajó: si el catálogo
   * los olvida, el tablero muestra `m_bj_out` en crudo y el histórico se vuelve
   * ilegible. Van acá y no en CAMPOS porque el test de sincronía compara CAMPOS
   * contra la pantalla, y éstos ya no están en la pantalla.
   */
  const CAMPOS_VIEJOS = {
    m_bj_out: { lab: 'Bandejas al salir (pic/fia/piz)', unidad: 'u', hasta: '2026-09-07' },
    t_bj_out: { lab: 'Bandejas al salir (pic/fia/piz)', unidad: 'u', hasta: '2026-09-07' },
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
      // El campo viejo, de cuando los tres numeros iban en una sola casilla.
      // Sigue leyendose para los dias anteriores al 8/9: son datos reales y no
      // se tiran porque haya cambiado el formulario.
      legacy: 'm_bj_out',
      filas: [
        { nombre: 'Picada', abrio: 'bj_pic', salio: 'm_out_pic' },
        { nombre: 'Fiambre', abrio: 'bj_fia', salio: 'm_out_fia' },
        { nombre: 'Pizza', abrio: 'bj_piz', salio: 'm_out_piz' },
      ],
    },
    {
      titulo: 'Bandejas',
      legacy: 't_bj_out',
      filas: [
        { nombre: 'Picada', abrio: 'bj_pic', salio: 't_out_pic' },
        { nombre: 'Fiambre', abrio: 'bj_fia', salio: 't_out_fia' },
        { nombre: 'Pizza', abrio: 'bj_piz', salio: 't_out_piz' },
      ],
    },
  ];

  /** Los ids que ya muestra un bloque de pares y no hay que repetir en la lista. */
  const enPares = new Set(
    PARES.flatMap((p) => [
      p.legacy,
      ...p.filas.map((f) => f.abrio),
      ...p.filas.map((f) => f.salio),
    ]).filter(Boolean),
  );

  /**
   * Las tres cosas que se cuentan en el mostrador, en el orden en que se
   * escriben en el campo de salida: picada, fiambre, pizza.
   */
  const BANDEJAS = [
    { nombre: 'Picada', abrio: 'bj_pic',
      mArm: 'm_arm_pic', mOut: 'm_out_pic', tArm: 't_arm_pic', tOut: 't_out_pic' },
    { nombre: 'Fiambre', abrio: 'bj_fia',
      mArm: 'm_arm_fia', mOut: 'm_out_fia', tArm: 't_arm_fia', tOut: 't_out_fia' },
    { nombre: 'Pizza', abrio: 'bj_piz',
      mArm: 'm_arm_piz', mOut: 'm_out_piz', tArm: 't_arm_piz', tOut: 't_out_piz' },
  ];

  global.PARTE_BANDEJAS = BANDEJAS;
  global.PARTE_CAMPOS_VIEJOS = CAMPOS_VIEJOS;
  global.PARTE_CAMPOS = CAMPOS;
  global.PARTE_PARES = PARES;
  global.PARTE_EN_PARES = enPares;
})(typeof window !== 'undefined' ? window : globalThis);
