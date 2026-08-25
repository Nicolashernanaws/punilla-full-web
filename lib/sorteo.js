'use strict';
/**
 * PUNILLA FULL SORTEO — reglas puras.
 *
 * Todo lo que decide "cuántas chances tenés" y "¿podés cargar?" vive acá, sin
 * tocar la base ni Express, para que se pueda testear entero sin Postgres
 * (`engine.test.js` de Fundadores necesita una base real y por eso no corre en
 * la máquina de Nico; esto tenía que poder correr siempre).
 *
 * MECÁNICA (definida el 24/8, reemplaza a la de tickets):
 *   - Se participa escaneando el QR y anotándose. SIN ticket, SIN monto.
 *   - 1 chance por registro. Registros ilimitados.
 *   - ×2 si el mismo teléfono se anotó en Punilla Full Y en Tomato.
 *   - Compartir la historia etiquetando a las tres cuentas es REQUISITO:
 *     sin eso el teléfono se anota pero NO entra al padrón del sorteo.
 *   - Tope antifraude de 10 por día / teléfono / comercio. NO se anuncia.
 */

const TZ = 'America/Argentina/Cordoba';

/** Los tres comercios que participan. */
const COMERCIOS = ['punilla', 'tomato', 'lucy'];

/** Nombre lindo de cada comercio, para los mensajes al vecino. */
const NOMBRE_COMERCIO = {
  punilla: 'Punilla Full',
  tomato: 'Tomato',
  lucy: 'Lucy',
};

/**
 * Los dos comercios que activan el ×2.
 *
 * Lucy suma chances pero NO entra acá: es online y de otro rubro, y lo que se
 * comunica es "comprás acá, cenás allá". Si Lucy activara el multiplicador, el
 * mensaje de la media cuadra entre Punilla Full y Tomato pierde sentido.
 */
const PAR_MULTIPLICADOR = ['punilla', 'tomato'];

/**
 * Tope antifraude: registros por día, por teléfono y por comercio.
 *
 * NO SE ANUNCIA, y es a propósito. Sin ticket no hay forma de verificar la
 * compra, así que esta es la única defensa contra el que se anota cincuenta
 * veces desde el mismo celular. Al que lo pasa no se le dice nada (si lo
 * decimos, aprende el número exacto y lo esquiva): el registro se guarda con
 * `cuenta = false` y simplemente no suma.
 */
const TOPE_DIARIO = 10;

/** Cierre de la carga: jueves 27/8 20:00 de Argentina, una hora antes del vivo. */
const CIERRE = new Date(process.env.SORTEO_CIERRE || '2026-08-27T20:00:00-03:00');

/** Cuándo se sortea, en texto, para que la landing y las bases digan lo mismo. */
const SORTEO_TEXTO = process.env.SORTEO_TEXTO || 'el jueves 27 a las 21';

/** Qué se lleva cada puesto. Cuatro premios, cuatro ganadores distintos. */
const PREMIOS = {
  1: 'Campera de Lucy',
  2: 'Cena para dos en Tomato',
  3: 'Compra de $25.000 en Punilla Full',
  4: 'Compra de $25.000 en Punilla Full',
};

/**
 * ¿Se puede seguir cargando?
 *
 * El cierre es exclusivo: a las 20:00:00 en punto ya está cerrado. Es lo que
 * dicen las bases, y en una campaña con premios hay que poder defender el corte
 * con el reloj en la mano.
 */
function ventanaAbierta(ahora, cierre = CIERRE) {
  return ahora.getTime() < cierre.getTime();
}

/**
 * El día calendario argentino de una fecha, como 'YYYY-MM-DD'.
 *
 * Se calcula acá y se manda a la base como parámetro en vez de usar `now()` en
 * el SQL: así el tope diario se puede testear sin Postgres y sin esperar a que
 * cambie el día de verdad. Argentina no tiene horario de verano, pero igual se
 * resuelve con Intl y no restando 3 horas a mano.
 */
function diaArg(fecha) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha);
}

/** ¿Este comercio participa del sorteo? */
function comercioValido(c) {
  return COMERCIOS.includes(c);
}

/**
 * El ×2 pide haberse anotado en Punilla Full Y en Tomato.
 * Recibe la lista de comercios en los que el teléfono ya se anotó.
 */
function tieneMultiplicador(comercios) {
  const hay = new Set(comercios || []);
  return PAR_MULTIPLICADOR.every((c) => hay.has(c));
}

/**
 * Chances de un teléfono.
 *
 * NO se persiste: se recalcula siempre desde los registros. Un contador
 * cacheado que se despega del padrón real es el bug más caro de esta campaña,
 * porque se descubre el jueves a las 21, en vivo y delante de todos.
 *
 * `participa` es el requisito de la historia compartida. Ojo con la
 * diferencia: alguien puede tener 6 chances y NO participar todavía. La
 * landing tiene que mostrar las dos cosas por separado, porque "tenés 6
 * chances" a secas, sin haber compartido, es mentirle al vecino.
 *
 * @param {{comercio:string}[]} registros - los que cuentan (cuenta = true)
 * @param {boolean} compartio - lo marca el admin, nunca el que se anota
 */
function chancesDe({ registros = [], compartio = false } = {}) {
  const comercios = registros.map((r) => r && r.comercio);
  const multiplicador = tieneMultiplicador(comercios);
  const base = registros.length;
  return {
    chances: base * (multiplicador ? 2 : 1),
    multiplicador,
    participa: !!compartio && base > 0,
    sellos: {
      punilla: comercios.includes('punilla'),
      tomato: comercios.includes('tomato'),
      lucy: comercios.includes('lucy'),
    },
  };
}

/**
 * ¿Este registro cuenta, o se pasó del tope diario?
 * `yaHoy` = cuántos registros que cuentan ya tiene ese teléfono, ese día, en
 * ese comercio.
 */
function registroCuenta(yaHoy, tope = TOPE_DIARIO) {
  return yaHoy < tope;
}

/**
 * Arma el padrón del sorteo: una entrada por chance.
 *
 * Se expande a una fila por chance en vez de sortear ponderado porque es lo
 * que se puede mostrar en pantalla y contar delante de la gente. "Sos el 47 de
 * 312" se entiende; "tenés peso 6 sobre un total de 312" no.
 *
 * Sólo entra el que compartió: es el requisito.
 */
function armarPadron(participantes) {
  const padron = [];
  for (const p of participantes) {
    const r = chancesDe(p);
    if (!r.participa) continue;
    for (let i = 0; i < r.chances; i++) padron.push(p.telefono_norm);
  }
  return padron;
}

module.exports = {
  TZ,
  COMERCIOS,
  NOMBRE_COMERCIO,
  PAR_MULTIPLICADOR,
  TOPE_DIARIO,
  CIERRE,
  SORTEO_TEXTO,
  PREMIOS,
  ventanaAbierta,
  diaArg,
  comercioValido,
  tieneMultiplicador,
  chancesDe,
  registroCuenta,
  armarPadron,
};
