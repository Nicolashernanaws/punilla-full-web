'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// El front de /parte. Es un archivo grande y de una sola pieza, así que lo que
// se fija acá es que no vuelva a colarse lo que se sacó: la capa de persistencia
// del artifact y el nombre escrito a mano.

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'parte.html'), 'utf8');

test('🔴 no queda nada de la persistencia del artifact', () => {
  // Guardaba en la nube de Claude, que sólo abren cuentas de la organización.
  for (const rastro of ['claude.use', 'onSnapshot', 'docRef', 'db.doc(']) {
    assert.equal(html.includes(rastro), false, 'quedó ' + rastro);
  }
});

test('habla con la API propia', () => {
  // El helper arma la URL como '/parte/api/' + ruta, así que se chequean las dos
  // mitades por separado en vez de la cadena entera.
  assert.ok(html.includes("'/parte/api/' + ruta"), 'falta el helper api()');
  for (const ruta of ["api('dia')", "api('evento'", "api('traspaso')", '/parte/api/login']) {
    assert.ok(html.includes(ruta), 'falta ' + ruta);
  }
});

test('🔴 el nombre viene del servidor, no lo escribe la persona', () => {
  // Antes se tecleaba libre: cualquiera podía firmar con el nombre de otro, y
  // el parte vale justamente porque dice QUIÉN dijo que algo se hizo.
  assert.equal(html.includes('pedirNombre'), false);
  assert.ok(html.includes('pedirPin'));
  assert.ok(html.includes('type = \'password\''));
});

test('🔴 el 429 del login se le explica a la persona', () => {
  // Si sólo dijera "error", volvería a probar y se comería la ventana entera.
  assert.match(html, /status === 429[\s\S]{0,400}Esperá 15 minutos/);
});

test('🔴 la cola sobrevive a quedarse sin conexión (criterio 6)', () => {
  assert.ok(html.includes('pf_cola'));
  assert.match(html, /sin conexión · se guarda igual/);
  // Y se reintenta cuando vuelve la red.
  assert.match(html, /addEventListener\('online', drenarCola\)/);
});

test('destildar manda un evento propio, no borra el tilde', () => {
  assert.match(html, /evento\(estaba \? 'destilde' : 'tilde', it\.id\)/);
});

test('los campos de texto mantienen el debounce de 400 ms', () => {
  assert.match(html, /setTimeout\(\(\) => evento\(tipo, itemId, valor\), 400\)/);
});

test('el poll para ver lo que cargó el otro es cada 20 s', () => {
  assert.match(html, /setInterval\([\s\S]{0,120}20000\)/);
});

test('salir cierra la sesión del servidor, no sólo el localStorage', () => {
  // Si sólo borrara el localStorage, la cookie seguiría viva y el próximo que
  // agarre el teléfono escribiría con el nombre del anterior.
  assert.match(html, /\/parte\/api\/logout/);
});

test('se conserva lo que el handoff pidió no tocar', () => {
  // Las listas, el bloque de cierre, el traspaso y el filtrado por puesto.
  assert.ok(html.includes('bloqueCierre'), 'bloqueCierre');
  assert.ok(html.includes('Armar traspaso') || html.includes('btnWA'), 'traspaso');
  assert.match(html, /LISTAS\.filter\(L => L\.id === yo\.puesto \|\| L\.reglas\)/);
});

// ── Una URL por sector (31/8) ───────────────────────────────────────────────
//
// Nico: "quiero que encargado tenga una url y fiambrería otra, no compartir".
// En el teléfono cada uno abre la suya y va derecho a lo suyo.
//
// ⚠️ ES COMODIDAD, NO SEGURIDAD: la separación de verdad la hace el PIN, y está
// probada contra producción (un PIN de fiambrería no abre un puesto de
// encargado). Entrar por /parte y elegir el puesto de otro no sirve sin su PIN.
test('cada sector tiene su URL y ve sólo sus puestos', () => {
  assert.match(html, /encargado:\s*\['enc_m', 'enc_t'\]/);
  assert.match(html, /fiambreria:\s*\['fiam_m', 'fiam_t'\]/);
  assert.match(html, /produccion:\s*\['prod'\]/);
  // El área sale de la URL, no de algo que se pueda tipear.
  assert.match(html, /location\.pathname/);
});

test('🔴 /parte a secas sigue mostrando todos', () => {
  // Es el que usa Nico: si filtrara, se quedaría sin poder entrar a ninguno.
  assert.match(html, /return AREAS\[t\] \? t : null;/);
  assert.match(html, /AREA \? PUESTOS\.filter[\s\S]{0,40}: PUESTOS/);
});

test('con un solo puesto va derecho al PIN', () => {
  // Producción tiene uno solo: hacer elegir de una lista de uno es un paso de
  // más, y un paso de más en la caja es un paso que alguien se saltea.
  assert.match(html, /visibles\.length === 1[\s\S]{0,80}pedirPin\(visibles\[0\]\)/);
});

test('el server sirve la misma página en las cuatro rutas', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /'\/parte', '\/parte\/encargado', '\/parte\/fiambreria', '\/parte\/produccion'/);
});

// ── Se veían las tareas de los demás sin poner el PIN (4/9) ─────────────────
//
// Nico: "esta el problema que entre ellos se ven las tareas y no pide el pin".
//
// 🔴 QUÉ PASABA. `renderTabs()` decía `!yo ? LISTAS : LISTAS.filter(...)`: sin
// sesión dibujaba LAS OCHO listas. La API estaba bien (sin cookie devuelve 401 y
// no larga un dato), pero los TEXTOS de las tareas están acá, en el HTML. Así
// que Abril abría el link de fiambrería, veía las solapas de Julián y de
// producción y las leía enteras antes de escribir un solo dígito.
//
// Y `puestosVisibles()` —lo que hacía que cada URL fuera de su área— se usaba en
// un solo lugar: el selector del login. Nunca en el render. La URL por área no
// filtraba nada de lo que se veía.

test('🔴 sin sesión no se dibuja ninguna lista de tareas', () => {
  // Sólo las Reglas, que son del local y las puede leer cualquiera.
  assert.match(html, /const visibles = !yo \? LISTAS\.filter\(L => L\.reglas\)/);
  // Y el cuerpo tampoco: sin sesión, donde iba la lista va el pedido de PIN.
  assert.match(html, /function render\(\)[\s\S]{0,400}if\(!yo && !L\.reglas\)/);
});

test('🔴 una sesión de otra área no dibuja su lista en esta URL', () => {
  // Si abre /parte/fiambreria con la cookie de encargado, la cookie sigue
  // valiendo (no se la tiramos: perdería la sesión sin querer), pero acá no se
  // dibuja nada suyo y se le pide el PIN del área que abrió.
  assert.match(html, /function fueraDelArea\(puesto\)/);
  assert.match(html, /AREA && !AREAS\[AREA\]\.includes\(puesto\)/);
  // El cruce se hace en los DOS lados: al arrancar (localStorage) y cuando
  // contesta el servidor, que es la verdad.
  assert.match(html, /if\(yo && fueraDelArea\(yo\.puesto\)\) yo = null;/);
  assert.match(html, /traerDia[\s\S]{0,600}fueraDelArea\(d\.puesto\)/);
});

test('la lista inicial cae dentro del área de la URL', () => {
  // Antes arrancaba siempre en enc_m/enc_t: en /parte/fiambreria la primera
  // pantalla era, literalmente, la lista del encargado.
  assert.match(html, /listaActiva = primeraDelArea\(\)/);
});

// ── La página no arrancaba (4/9) ────────────────────────────────────────────
//
// 🔴 AL PORTAR EL FRONT DEL ARTIFACT ME LLEVÉ PUESTO EL BLOQUE DEL MODAL.
// `modal()`, `cerrarModal()` y `textoTraspaso()` se usan en catorce lugares y no
// estaban definidos en ningún lado: tocar «Entrar» tiraba `ReferenceError: modal
// is not defined` y el pedido de PIN NUNCA se abría. Nadie podía entrar al parte
// desde el día que se desplegó.
//
// Se me pasó porque verifiqué los siete criterios contra la API con curl y no
// abrí la página en un navegador ni una vez. La API estaba impecable; la
// pantalla no arrancaba. Este test es el que faltaba.

test('🔴 no se llama a ninguna función que no exista', () => {
  // Los comentarios se sacan primero: la prosa en castellano trae paréntesis y
  // el patrón leería "muestra todos (…)" como una llamada a todos().
  const js = html
    .slice(html.indexOf('<script>'), html.lastIndexOf('</script>'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  const definidas = new Set(
    [...js.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  // Las asignadas a una variable y las flecha.
  for (const m of js.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=>|=\s*(?:async\s*)?function)/g)) definidas.add(m[1]);
  // Y los PARÁMETROS, que dentro del cuerpo se llaman como cualquier función:
  // `modal(titulo, sub, fill)` llama a fill() y fill no se declara en ningún
  // lado. Sin esto el test se llenaría de falsos positivos.
  for (const m of js.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const a of m[1].split(',')) {
      const nom = a.trim().split(/[\s=]/)[0];
      if (nom) definidas.add(nom);
    }
  }

  // Palabras del lenguaje y del navegador. Sólo hace falta listar las que
  // empiezan en minúscula: el patrón de abajo no toma las que van en mayúscula
  // (String, JSON, Math, Date, Promise…) ni los métodos, que van tras un punto.
  const NATIVAS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'typeof',
    'function', 'new', 'await', 'of', 'in', 'delete', 'void', 'yield', 'throw',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'fetch', 'setTimeout',
    'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa', 'structuredClone',
    'alert', 'confirm', 'prompt', 'eval', 'require', 'async',
  ]);

  const huerfanas = [...new Set(
    [...js.matchAll(/(?:^|[^.\w$'"`])([a-z][A-Za-z0-9_$]*)\s*\(/gm)].map((m) => m[1]),
  )].filter((n) => !definidas.has(n) && !NATIVAS.has(n)).sort();

  assert.deepEqual(huerfanas, [], 'se llaman pero no existen: ' + huerfanas.join(', '));
});

// ── El modal tapaba la lista y se comia los clicks (4/9) ────────────────────
//
// Nico: "Se supone que deberia dejar tildar el check al lado de la tarea? xq a
// mi no me deja / solo editar ciertos campos como lo del dinero de la caja".
//
// 🔴 QUE PASABA. Al arrancar, `yo` sale del localStorage. Si ahi no hay nada
// pero la cookie del servidor SIGUE VIVA, pasaba esto:
//
//   1. yo = null            -> se dibuja el cartel del PIN
//   2. setTimeout(abrirQuien) -> se abre el selector de turno
//   3. traerDia() responde  -> hay sesion, se dibuja la lista entera
//   4. nadie cierra el modal
//
// Y el `.scrim` es `position:fixed; inset:0; z-index:50`: la lista quedaba
// dibujada DEBAJO, visible y muerta. Medido en produccion con
// `document.elementFromPoint()` sobre la primera tarea: el click lo recibia
// `.pick`, un boton del modal, no la tarea. Los campos de la derecha asomaban
// por fuera del recuadro y por eso parecian los unicos que andaban.

test('🔴 si el servidor confirma la sesion se cierra el pedido de PIN', () => {
  // El flag distingue el modal del login de los otros (traspaso, cierre): sólo
  // el del login se cierra solo.
  assert.match(html, /let modalDeLogin = false;/);
  assert.match(html, /function cerrarModal\(\)\{[\s\S]{0,120}modalDeLogin = false/);
  assert.match(html, /async function traerDia[\s\S]{0,1600}if\(modalDeLogin\) cerrarModal\(\);/);
});

test('el pedido de PIN del arranque espera la respuesta del servidor', () => {
  // Con la cookie viva, abrirlo a los 200 ms era un modal que aparecia y se
  // cerraba solo en la cara de la persona.
  assert.match(html, /setTimeout\(\(\) => \{ if\(!yo\) abrirQuien\(\); \}, 1200\)/);
});

// ── Lo mismo para el tablero ────────────────────────────────────────────────
//
// El tablero es otro archivo de una sola pieza y le corre el mismo riesgo: una
// funcion que se llama y no existe no la ve ningun test de regex, y la pagina
// se abre igual, con las tarjetas vacias y sin un error a la vista.

const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'parte-admin.html'), 'utf8');

test('🔴 el tablero no llama a ninguna funcion que no exista', () => {
  const js = admin
    .slice(admin.indexOf('<script>'), admin.lastIndexOf('</script>'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  const definidas = new Set(
    [...js.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  for (const m of js.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=>|=\s*(?:async\s*)?function)/g)) definidas.add(m[1]);
  for (const m of js.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const a of m[1].split(',')) {
      const nom = a.trim().split(/[\s=]/)[0];
      if (nom) definidas.add(nom);
    }
  }

  const NATIVAS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'typeof',
    'function', 'new', 'await', 'of', 'in', 'delete', 'void', 'yield', 'throw',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'fetch', 'setTimeout',
    'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'encodeURIComponent', 'decodeURIComponent', 'atob', 'btoa', 'structuredClone',
    'alert', 'confirm', 'prompt', 'eval', 'require', 'async', 'super',
    // `var(--x)` de CSS adentro de un template literal, no una llamada.
    'var',
  ]);

  const huerfanas = [...new Set(
    [...js.matchAll(/(?:^|[^.\w$'"`])([a-z][A-Za-z0-9_$]*)\s*\(/gm)].map((m) => m[1]),
  )].filter((n) => !definidas.has(n) && !NATIVAS.has(n)).sort();

  assert.deepEqual(huerfanas, [], 'se llaman pero no existen: ' + huerfanas.join(', '));
});
