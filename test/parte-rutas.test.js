'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitPorClave, PUESTOS, TRASPASO } = require('../lib/parte-rutas');
const { crearToken, leerToken } = require('../lib/parte-sesion');
const fs = require('node:fs');
const path = require('node:path');

// Los criterios de aceptación que se pueden fijar sin levantar Postgres.
// Los que necesitan base (merge concurrente real) van en el ensayo manual del
// README: acá se fija la FORMA, que es lo que se rompe al refactorizar.

const SECRET = 'secreto-de-prueba';

test('🔴 seis intentos seguidos devuelven 429 (criterio 5)', () => {
  // Un PIN de 4 dígitos son 10.000 combinaciones: sin freno se rompe en
  // minutos, y en los campos del parte hay montos de caja.
  const mw = rateLimitPorClave(5, 60_000);
  const req = { headers: {}, ip: '1.2.3.4', body: { puesto: 'enc_m' } };
  let ultimo = 0;
  const res = { status(c) { ultimo = c; return this; }, json() { return this; } };
  let pasaron = 0;
  for (let i = 0; i < 6; i++) mw(req, res, () => pasaron++);
  assert.equal(pasaron, 5);
  assert.equal(ultimo, 429);
});

test('🔴 el freno es por IP Y PUESTO, no sólo por IP', () => {
  // El local sale por una sola IP: si fuera sólo por IP, un ataque contra un
  // puesto dejaría sin login a todos los demás.
  const mw = rateLimitPorClave(2, 60_000);
  const res = { status() { return this; }, json() { return this; } };
  let ok = 0;
  const golpe = (puesto) => mw({ headers: {}, ip: '1.1.1.1', body: { puesto } }, res, () => ok++);
  golpe('enc_m'); golpe('enc_m'); golpe('enc_m'); // el tercero se frena
  golpe('fiam_t');                                 // otro puesto, sigue pasando
  assert.equal(ok, 3);
});

test('la ventana del freno se libera con el tiempo', () => {
  const mw = rateLimitPorClave(1, 30);
  const res = { status() { return this; }, json() { return this; } };
  let ok = 0;
  const req = { headers: {}, ip: '9.9.9.9', body: { puesto: 'prod' } };
  mw(req, res, () => ok++);
  mw(req, res, () => ok++); // frenado
  return new Promise((r) => setTimeout(r, 45)).then(() => {
    mw(req, res, () => ok++);
    assert.equal(ok, 2);
  });
});

test('🔴 el puesto de la sesión no se puede falsificar (criterio 4)', () => {
  // Fiambrería mañana no puede escribir en el parte de fiambrería tarde ni
  // cambiando el body: el puesto sale de la cookie firmada, y el body se ignora.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // El handler de evento toma el puesto de req.parte (la cookie), nunca de req.body.
  assert.match(rutas, /const \{ puesto, personaId, nombre \} = req\.parte;/);
  assert.doesNotMatch(rutas, /puesto\s*=\s*req\.body\.puesto/);
  assert.doesNotMatch(rutas, /req\.body\?\.puesto[\s\S]{0,80}INSERT INTO parte_dia/);
});

test('🔴 la fecha la pone el servidor, nunca el cliente (criterio 2)', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // No hay ningún lugar donde la fecha del parte salga del body.
  assert.doesNotMatch(rutas, /fecha\s*=\s*req\.body/);
  // Y el handler de evento la calcula.
  assert.match(rutas, /const fecha = fechaOperativa\(\);[\s\S]{0,200}req\.parte;/);
});

test('🔴 parte_evento nunca se hace UPDATE ni DELETE (criterio 3)', () => {
  // Es el historial. Destildar escribe un `destilde`, no borra el `tilde`.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.doesNotMatch(rutas, /UPDATE parte_evento/i);
  assert.doesNotMatch(rutas, /DELETE FROM parte_evento/i);
  assert.match(rutas, /INSERT INTO parte_evento/);
});

test('🔴 el evento se aplica con SELECT … FOR UPDATE (criterio 1)', () => {
  // Sin el lock, dos teléfonos leen el mismo estado y el segundo pisa al
  // primero: la tilde del otro desaparece sin que nadie entienda por qué.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /FOR UPDATE/);
  assert.match(rutas, /withTx\(/);
});

test('el traspaso es de la tarde y sólo lectura', () => {
  assert.deepEqual(TRASPASO, { enc_t: 'enc_m', fiam_t: 'fiam_m' });
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // La ruta de traspaso no escribe nada. El corte va hasta el ENCABEZADO de la
  // seccion del tablero y no hasta `admin/api/dia`: entre medio hay ahora el
  // login del tablero, que si escribe (anota los intentos fallidos), y tomarlo
  // dentro del bloque haria fallar esto sin que la ruta del traspaso cambie.
  const bloque = rutas.slice(
    rutas.indexOf("'/api/traspaso'"),
    rutas.indexOf('── Tablero del administrador'),
  );
  assert.doesNotMatch(bloque, /INSERT|UPDATE|DELETE/);
});

test('los cinco puestos son los del handoff', () => {
  assert.deepEqual(PUESTOS, ['enc_m', 'enc_t', 'fiam_m', 'fiam_t', 'prod']);
});

test('una sesión de un puesto no sirve para otro', () => {
  const t = crearToken({ personaId: 1, puesto: 'fiam_m', nombre: 'X' }, SECRET);
  assert.equal(leerToken(t, SECRET).puesto, 'fiam_m');
});

// ── El freno compartido (medido en producción el 30/8) ──────────────────────
//
// 🔴 EL CONTADOR EN MEMORIA NO ALCANZABA. Railway corre más de una réplica y
// cada una tiene su propio Map: el límite efectivo era 5 × réplicas, y esa
// cantidad cambia sin avisar. Se vio en prod — 6 intentos seguidos dieron
// 401,401,401,429,401,429: el round-robin repartía los golpes entre dos.
const { huella, FRENO_MAX, FRENO_MINUTOS } = require('../lib/parte-rutas');

test('🔴 el freno de verdad cuenta en la base, no en memoria', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /FROM parte_evento\s*\n\s*WHERE tipo = 'login_fallido'/);
  // Y se chequea ANTES de comparar el PIN, no después.
  assert.match(rutas, /frenadoEnBase\(puesto, ipCliente\(req\)\)[\s\S]{0,200}SELECT id, nombre, pin_hash/);
});

test('🔴 se cuenta por puesto Y huella de IP, no sólo por puesto', () => {
  // Si fuera sólo por puesto, cualquiera podría dejar a Julián sin poder entrar
  // tirando PINs al azar desde afuera.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /COUNT\(\*\) FILTER \(WHERE valor = \$2\)::int AS por_ip/);
});

test('la IP no se guarda en claro', () => {
  const h = huella('190.55.1.2');
  assert.equal(h.length, 12);
  assert.equal(h.includes('190'), false);
  assert.notEqual(h, huella('190.55.1.3'));
});

test('el intento fallido queda anotado en la línea de tiempo', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /INSERT INTO parte_evento[\s\S]{0,80}'login_fallido'/);
});

test('el freno son 5 intentos en 15 minutos', () => {
  assert.equal(FRENO_MAX, 5);
  assert.equal(FRENO_MINUTOS, 15);
});

// ── La IP del cliente (medido en produccion el 30/8) ────────────────────────
const { ipCliente, FRENO_PUESTO_MAX } = require('../lib/parte-rutas');

test('🔴 la IP sale del PRIMER X-Forwarded-For, no de req.ip', () => {
  // Ocho intentos desde la misma máquina quedaron anotados con DOS huellas
  // distintas: con `trust proxy 1` Express toma el último salto —el proxy de
  // Railway, que rota— y el contador por IP nunca llegaba a cinco.
  const req = { headers: { 'x-forwarded-for': '190.55.1.2, 10.0.0.7, 10.0.0.9' }, ip: '10.0.0.9' };
  assert.equal(ipCliente(req), '190.55.1.2');
});

test('sin cabecera cae en req.ip', () => {
  assert.equal(ipCliente({ headers: {}, ip: '1.2.3.4' }), '1.2.3.4');
});

test('sin nada devuelve cadena vacía, no rompe', () => {
  assert.equal(ipCliente({ headers: {} }), '');
});

test('🔴 hay un tope por PUESTO además del de IP', () => {
  // El primer X-Forwarded-For lo escribe el cliente y se puede falsificar
  // rotándolo. Éste no se puede esquivar.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /por_puesto >= FRENO_PUESTO_MAX/);
});

test('el tope por puesto es alto a propósito', () => {
  // Uno bajo dejaría a Julián sin poder entrar con que alguien tire PINs desde
  // afuera. Con 30 cada 15 min, agotar las 10.000 combinaciones lleva 80+ horas.
  assert.equal(FRENO_PUESTO_MAX, 30);
  assert.ok(FRENO_PUESTO_MAX > FRENO_MAX * 4);
});

// ── Entrar al tablero con un PIN, no con la ADMIN_KEY (4/9) ─────────────────
//
// Nico: "pero sacale la key ...es un embole quiero entrar y ver mas rapido".
//
// La clave NO se saca del todo: el tablero muestra los nombres de todos, la
// linea de tiempo completa y los campos de plata de la caja, en una URL que se
// adivina. Lo que se saca es tener que TIPEARLA cada vez.
//
// En su lugar: un PIN, la misma mecanica que ya usa la gente, con una sesion que
// se renueva sola en cada request autorizado. Entra una vez y no se lo pide mas
// mientras siga abriendo el tablero seguido.

test('el tablero se puede abrir con la cookie, sin la ADMIN_KEY', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /function sesionAdmin\(req\)/);
  // Acepta las dos: la cookie para la persona, la key para curl y los scripts,
  // que es como se verifica esto sin un navegador. Desde el 10/9 el chequeo vive
  // en admitidoComoAdmin(), porque lo comparten la API (401 con JSON) y las
  // páginas (redirect al tablero, que un JSON en blanco no se puede ni tocar).
  assert.match(rutas, /function admitidoComoAdmin[\s\S]{0,400}sesionAdmin\(req\)/);
  assert.match(rutas, /function requiereAdmin\(req, res, next\)[\s\S]{0,200}admitidoComoAdmin/);
  assert.match(rutas, /function requiereAdminPagina[\s\S]{0,300}redirect\('\/parte\/admin'\)/);
});

test('🔴 la cookie del tablero no vale para /parte', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Con Path=/parte, la cookie del tablero viajaria a las pantallas de la gente.
  assert.match(rutas, /Path=\/parte\/admin/);
  assert.match(rutas, /COOKIE_ADMIN = 'parte_admin'/);
});

test('🔴 el PIN del tablero tiene el mismo freno que el de la gente', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // El freno en memoria no sirve: Railway corre mas de una replica. Se cuenta en
  // la base, igual que el login de los puestos.
  assert.match(rutas, /admin\/api\/login[\s\S]{0,700}frenadoEnBase\(PUESTO_ADMIN, ipCliente\(req\)\)/);
  assert.match(rutas, /admin\/api\/login[\s\S]{0,1400}login_fallido/);
  // Y se compara en tiempo constante, como el PIN de los puestos.
  assert.match(rutas, /timingSafeEqual/);
});

test('sin PARTE_ADMIN_PIN seteado, la ADMIN_KEY sigue sirviendo', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Para no quedarse afuera del tablero por una variable que falta.
  assert.match(rutas, /process\.env\.PARTE_ADMIN_PIN/);
  assert.match(rutas, /pin_no_configurado/);
});

test('el front del tablero pide un PIN, no la ADMIN_KEY', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'parte-admin.html'), 'utf8');
  assert.equal(html.includes('ADMIN_KEY'), false, 'todavia dice ADMIN_KEY');
  assert.match(html, /\/parte\/admin\/api\/login/);
  // Y si la sesion sigue viva, entra solo: eso es lo que lo hace rapido.
  assert.match(html, /credentials: 'same-origin'/);
});

// ── El acceso directo al tablero (8/9) ──────────────────────────────────────
//
// Nico: "pasame mi url que yo pueda entrar sin contraseña. acceso directo".
//
// 🔴 NO ES "SIN CONTRASEÑA": ES QUE LA CONTRASEÑA SEA EL LINK. El tablero muestra
// los nombres de todos, la línea de tiempo entera y los montos de la caja. Un
// `/parte/admin` abierto lo deja a la vista de cualquiera que adivine la URL —y
// `/parte/admin` se adivina en el primer intento.
//
// El link lleva un token largo al azar: se guarda en favoritos, se toca una vez y
// entra. Lo que cambia respecto de dejarlo abierto es que ese link NO se adivina,
// y que se puede matar cambiando una variable en Railway sin tocar código.
//
// Lo que hay que decirle a Nico y está escrito en el commit: quien tenga el link,
// entra. No va a un grupo.

test('el link directo deja una sesión y manda al tablero', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /r\.get\('\/t\/:token'/);
  // Deja la MISMA cookie que el PIN: no hay un segundo camino de sesión que
  // mantener sincronizado. Los tres caminos pasan por sembrarSesionAdmin().
  assert.match(rutas, /\/t\/:token'[\s\S]{0,2600}sembrarSesionAdmin\(res\)/);
  assert.match(rutas, /\/t\/:token'[\s\S]{0,2700}redirect\('\/parte\/admin'\)/);
});

test('🔴 el token se compara en tiempo constante y con largo mínimo', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Un `===` se corta en el primer carácter distinto y eso se puede medir.
  assert.match(rutas, /\/t\/:token'[\s\S]{0,2200}timingSafeEqual/);
  // Y un token corto en la URL es peor que un PIN: no lo frena ningún límite de
  // intentos porque no hay a quién atribuírselos.
  assert.match(rutas, /LARGO_MINIMO_TOKEN|token.*length\s*<\s*\d{2}/);
});

test('🔴 un intento con token equivocado queda anotado', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Si alguien está probando links, tiene que verse en la línea de tiempo igual
  // que los PIN fallidos.
  assert.match(rutas, /\/t\/:token'[\s\S]{0,2500}login_fallido/);
});

test('sin PARTE_ADMIN_TOKEN seteado, el link directo no existe', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Que la variable esté vacía no puede significar "entra cualquiera".
  assert.match(rutas, /PARTE_ADMIN_TOKEN/);
  assert.match(rutas, /\/t\/:token'[\s\S]{0,1800}esperado[\s\S]{0,400}404/);
});

// ── La clave se pone UNA vez (10/9) ─────────────────────────────────────────
//
// Nico: "que la ADMIN_KEY quede guardada en una cookie de 30 días después de
// ponerla una vez, así desde el celular no la tecleo más".
//
// Antes la key autorizaba el request y no dejaba nada: cada vez había que
// volver a tipearla. Y la sesión que dejaba el PIN duraba 16 h, que es la del
// turno de la gente: en un teléfono que se abre dos veces por semana, eso es
// pedirlo siempre.

const { DURACION_ADMIN_MS } = require('../lib/parte-rutas');

test('🔴 la sesión del tablero dura 30 días y el token la acompaña', () => {
  // No alcanza con estirar el Max-Age de la cookie: si el `exp` del token se
  // quedara en 16 h, el navegador seguiría mandándola un mes y el servidor la
  // rechazaría. El síntoma sería un tablero que pide el PIN igual, con la
  // cookie viva al lado.
  const t0 = Date.parse('2026-09-10T12:00:00Z');
  const tok = crearToken({ admin: true }, SECRET, t0, DURACION_ADMIN_MS);
  assert.ok(leerToken(tok, SECRET, t0 + 29 * 86400000), 'a los 29 días tendría que entrar');
  assert.equal(leerToken(tok, SECRET, t0 + 31 * 86400000), null, 'a los 31 no');
  assert.equal(DURACION_ADMIN_MS, 30 * 24 * 3600 * 1000);
});

test('🔴 la sesión de la GENTE sigue durando un turno, no un mes', () => {
  // El teléfono del local pasa de mano en mano al cambio de turno: una sesión
  // larga ahí es que el que entra escriba con el nombre del que se fue.
  const t0 = Date.parse('2026-09-10T12:00:00Z');
  const tok = crearToken({ puesto: 'fiam_m', nombre: 'Abril' }, SECRET, t0);
  assert.ok(leerToken(tok, SECRET, t0 + 15 * 3600 * 1000));
  assert.equal(leerToken(tok, SECRET, t0 + 17 * 3600 * 1000), null);
});

test('el login del tablero acepta la clave además del PIN', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // Con el mismo freno y la misma comparación en tiempo constante: son dos
  // entradas al mismo lugar, no dos mecanismos.
  assert.match(rutas, /req\.body\?\.clave/);
  assert.match(rutas, /clave \? \[clave, String\(adminKey\)\] : \[pin, esperado\]/);
});

test('🔴 los tres caminos dejan la MISMA sesión', () => {
  // El PIN, la clave y el link directo. Un segundo camino de sesión sería un
  // segundo lugar donde equivocarse.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  const veces = (rutas.match(/sembrarSesionAdmin\(res\)/g) || []).length;
  assert.ok(veces >= 4, 'la siembra de la cookie está duplicada o falta: ' + veces);
  // Y una sola función la arma, con la duración larga explícita.
  assert.match(rutas, /function sembrarSesionAdmin[\s\S]{0,300}DURACION_ADMIN_MS/);
});

// ── Ver como lo ve él (10/9) ────────────────────────────────────────────────
//
// Nico: "desde cada tarjeta del tablero, un botón «Ver como lo ve él» que abra
// la lista del puesto en modo lectura, con la misma pantalla que usan los
// empleados, sin PIN — se ve todo, no se puede tildar".

test('🔴 la vista de lectura sirve la MISMA página que usan los puestos', () => {
  // Una copia se desincroniza en el primer cambio de lista, y entonces muestra
  // un turno que ya no existe con toda la cara de ser el de verdad.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /PAGINA_PARTE = path\.join\(__dirname, '\.\.', 'public', 'parte\.html'\)/);
  assert.match(rutas, /r\.get\('\/admin\/ver\/:puesto', requiereAdminPagina/);
  assert.match(rutas, /res\.sendFile\(PAGINA_PARTE\)/);
});

test('🔴 mirar no abre una sesión de puesto', () => {
  // Si se le diera una sesión de fiambrería para que la pantalla funcione, todo
  // lo que tocara quedaría firmado con el nombre de otra persona.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  // La ruta de datos es un GET y va con la cookie del TABLERO.
  assert.match(rutas, /r\.get\('\/admin\/api\/ver\/:puesto', requiereAdmin/);
  // Y no hay ningún POST que acepte esa cookie.
  assert.doesNotMatch(rutas, /r\.post\('\/admin\/api\/ver/);
  assert.doesNotMatch(rutas, /r\.post\([^)]*requiereAdmin\b/);
});

test('🔴 mirar un puesto no le crea el parte del día', () => {
  // leerConLock() hace INSERT si el día no existe: usarlo acá sería que abrir la
  // pantalla de producción un domingo deje un parte vacío de producción.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /api\/ver\/:puesto'[\s\S]{0,900}SELECT items, campos, nota, cierre FROM parte_dia/);
  assert.doesNotMatch(rutas, /api\/ver\/:puesto'[\s\S]{0,900}leerConLock/);
});

test('la apertura queda anotada como admin_view', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /'admin_view'/);
  // Con la fecha MIRADA, no la de hoy: así aparece en la línea de tiempo del día
  // que se estaba mirando, que es donde se la busca.
  assert.match(rutas, /anotarVista\(fechaPedida\(req\), puesto, req\)/);
  // Sin la IP en claro, igual que los intentos fallidos.
  assert.match(rutas, /anotarVista[\s\S]{0,700}huella\(ipCliente\(req\)\)/);
});

test('🔴 si no se puede anotar, la pantalla se abre igual', () => {
  // Es un registro, no un permiso: dejar a Nico sin ver el turno porque no se
  // pudo anotar que lo vio sería tener la cosa al revés.
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /async function anotarVista[\s\S]{0,600}catch \(e\)[\s\S]{0,200}console\.warn/);
});

test('un puesto inventado no abre nada', () => {
  const rutas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parte-rutas.js'), 'utf8');
  assert.match(rutas, /admin\/ver\/:puesto'[\s\S]{0,300}!PUESTOS\.includes\(puesto\)/);
  assert.match(rutas, /admin\/api\/ver\/:puesto'[\s\S]{0,300}!PUESTOS\.includes\(puesto\)/);
});
