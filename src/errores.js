// Log de errores en memoria.
//
// POR QUÉ EXISTE: la campaña dura 4 días y no hay plan B en papel. Si el
// endpoint de carga falla el sábado a la tarde, se pierden esas cargas y nadie
// se entera hasta el lunes. Esto no reemplaza los logs de Railway — los duplica
// en un lugar que Nico puede abrir desde el celular en diez segundos.
//
// En memoria y no en tabla a propósito: si lo que está roto es la base, un log
// que escribe en la base tampoco anda.

const MAXIMO = 50;
const buffer = [];

export function registrarError(err, req) {
  const entrada = {
    ts: new Date().toISOString(),
    mensaje: err?.message ?? String(err),
    stack: err?.stack?.split('\n').slice(0, 4).join('\n'),
    ruta: req ? `${req.method} ${req.originalUrl}` : null,
    // El teléfono ayuda a llamar al vecino cuya carga se perdió. El resto del
    // body no se guarda: no hace falta y es dato personal.
    telefono: req?.body?.telefono ?? null,
  };
  buffer.unshift(entrada);
  if (buffer.length > MAXIMO) buffer.length = MAXIMO;
  console.error('[sorteo]', entrada.ts, entrada.ruta ?? '-', entrada.mensaje);
}

export function ultimosErrores() {
  return buffer;
}
