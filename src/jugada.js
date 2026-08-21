// Ruta de carga de jugadas del PUNILLA FULL SORTEO (campaña de 4 días).
//
// `db` es inyectable (segundo parámetro, default = db.js real) para poder
// testear sin Postgres sin depender del flag experimental de node:test para
// mockear módulos. En producción, server.js llama rutaJugada(app) tal cual
// y usa el db.js de siempre.
import * as dbReal from './db.js';
import { normalizarTelefono } from './telefono.js';
import { chancesDeMonto, totalDeChances, ventanaAbierta } from './chances.js';
import { UMBRAL, CIERRE, COMERCIOS } from './config.js';

export function rutaJugada(app, db = dbReal) {
  app.post('/api/sorteo/jugada', async (req, res) => {
    const body = req.body ?? {};
    const { telefono, comercio, ticket, monto, barrio, okBases, okNovedades } = body;

    // 1) Ventana de carga. Se evalúa `new Date()` acá adentro (en el momento
    // de cada request), no una vez al arrancar el server.
    if (!ventanaAbierta(new Date(), CIERRE)) {
      return res.status(403).json({ error: 'El sorteo ya cerró la carga de jugadas.' });
    }

    // 2) Aceptar bases y condiciones es obligatorio.
    if (!okBases) {
      return res
        .status(400)
        .json({ error: 'Para participar tenés que aceptar las bases y condiciones del sorteo.' });
    }

    // 3) Teléfono argentino válido.
    const telefonoNorm = normalizarTelefono(telefono);
    if (!telefonoNorm) {
      return res
        .status(400)
        .json({ error: 'Ese número de teléfono no es válido. Revisalo e intentá de nuevo.' });
    }

    // 4) y 5): según venga o no el comercio, esto es una jugada con ticket de
    // compra, o la chance gratis (una sola por persona, sin comprar nada).
    let esChanceGratis = false;
    let montoEntero = null;

    if (comercio !== undefined && comercio !== null && comercio !== '') {
      if (!COMERCIOS.includes(comercio)) {
        return res.status(400).json({ error: 'Ese comercio no participa del sorteo.' });
      }
      if (!ticket) {
        return res.status(400).json({ error: 'Falta el número de ticket.' });
      }
      if (!Number.isInteger(monto) || monto <= 0) {
        return res
          .status(400)
          .json({ error: 'El monto tiene que ser un número entero mayor a cero.' });
      }
      montoEntero = monto;
    } else if (!ticket) {
      esChanceGratis = true;
    } else {
      // Vino ticket pero no comercio: no encaja en ninguno de los dos casos
      // del enunciado, así que lo tratamos como dato incompleto.
      return res.status(400).json({ error: 'Falta indicar en qué comercio compraste ese ticket.' });
    }

    try {
      const resultado = await db.conTransaccion(async (cliente) => {
        // Alta o actualización del participante.
        //
        // COALESCE y no EXCLUDED a secas: el vecino carga su primer ticket con
        // barrio y consentimiento, y en el segundo el formulario ya no se los
        // vuelve a pedir. Pisando con EXCLUDED, esa segunda carga le borraba el
        // barrio y le daba de baja de las novedades sin que nadie lo notara.
        // Un dato que no vino es "no lo mandó", no "borralo".
        //
        // Un valor NUEVO sí pisa al anterior (se mudó, o lo había escrito mal).
        const barrioLimpio = typeof barrio === 'string' && barrio.trim() ? barrio.trim() : null;
        // undefined = no vino la clave → se conserva. false explícito = se da
        // de baja de verdad, que es un pedido legítimo del vecino.
        const novedades = okNovedades === undefined ? null : !!okNovedades;
        await cliente.query(
          `INSERT INTO sorteo_participante (telefono_norm, telefono_raw, barrio, ok_novedades)
           VALUES ($1, $2, $3, COALESCE($4, false))
           ON CONFLICT (telefono_norm) DO UPDATE
             SET barrio = COALESCE(EXCLUDED.barrio, sorteo_participante.barrio),
                 ok_novedades = COALESCE($4, sorteo_participante.ok_novedades)`,
          [telefonoNorm, telefono, barrioLimpio, novedades]
        );

        // Row lock: bloqueamos la fila del participante ANTES de leer o
        // escribir jugadas. Sin este lock, dos POSTs simultáneos con el
        // mismo teléfono podrían leer las dos sin_compra=false y ganar la
        // chance gratis dos veces (carrera clásica de "leer, decidir,
        // escribir"). Con el lock, la segunda transacción espera a que
        // termine la primera y ya ve sin_compra actualizado.
        const { rows: filasLock } = await cliente.query(
          `SELECT sin_compra FROM sorteo_participante WHERE telefono_norm = $1 FOR UPDATE`,
          [telefonoNorm]
        );
        const participanteLock = filasLock[0];

        let mensaje = '¡Listo, quedaste participando del sorteo!';

        if (esChanceGratis) {
          if (participanteLock.sin_compra) {
            const err = new Error('chance gratis ya usada');
            err.status = 409;
            err.mensajeUsuario = 'Ya usaste tu chance gratis, te corresponde una sola vez por persona.';
            throw err;
          }
          await cliente.query(
            `UPDATE sorteo_participante SET sin_compra = true WHERE telefono_norm = $1`,
            [telefonoNorm]
          );
          mensaje = '¡Listo, sumaste tu chance gratis!';
        } else {
          const chances = chancesDeMonto(montoEntero, UMBRAL);
          try {
            await cliente.query(
              `INSERT INTO sorteo_jugada (telefono_norm, comercio, ticket_nro, monto, chances)
               VALUES ($1, $2, $3, $4, $5)`,
              [telefonoNorm, comercio, ticket, montoEntero, chances]
            );
          } catch (e) {
            // 23505 = unique_violation de Postgres, salta por el UNIQUE
            // (comercio, ticket_nro). Lo detectamos por el error del INSERT
            // y no con un SELECT previo: un SELECT antes del INSERT tiene la
            // misma ventana de carrera que el row lock de arriba, dos
            // requests casi simultáneos podrían pasar el SELECT los dos y
            // cargar el mismo ticket dos veces.
            if (e.code === '23505') {
              const err = new Error('ticket duplicado');
              err.status = 409;
              err.mensajeUsuario = 'Ese ticket ya fue cargado antes, no se puede repetir.';
              throw err;
            }
            throw e;
          }

          if (chances === 0) {
            // Requisito de negocio: si no llegó al umbral, decirle cuánto le
            // faltó empuja el ticket promedio de la próxima compra.
            const falta = UMBRAL - (montoEntero % UMBRAL);
            // Con separador de miles: "$15.000" y no "$15000". Este mensaje es
            // el que empuja a agregar un producto más, y lo lee gente grande en
            // el celular — un número pegoteado se lee mal y pierde el efecto.
            mensaje = `Por $${falta.toLocaleString('es-AR')} más te llevabas una chance.`;
          }
        }

        // El total de chances NUNCA se persiste desnormalizado: se recalcula
        // siempre releyendo jugadas + flags del participante. En una
        // campaña de 4 días con carga manual de tickets, un contador
        // cacheado que se desincroniza del padrón real del sorteo es el bug
        // más caro (y más difícil de auditar) que se puede arrastrar.
        const { rows: jugadasRows } = await cliente.query(
          `SELECT comercio, chances FROM sorteo_jugada WHERE telefono_norm = $1`,
          [telefonoNorm]
        );
        const { rows: partRows } = await cliente.query(
          `SELECT sin_compra, compartio FROM sorteo_participante WHERE telefono_norm = $1`,
          [telefonoNorm]
        );
        const participante = partRows[0];

        const chancesTotal = totalDeChances({
          jugadas: jugadasRows,
          sinCompra: participante.sin_compra,
          compartio: participante.compartio,
        });

        const sellos = {
          punilla: jugadasRows.some((j) => j.comercio === 'punilla'),
          tomato: jugadasRows.some((j) => j.comercio === 'tomato'),
        };

        return { chancesTotal, sellos, mensaje };
      });

      return res.status(200).json(resultado);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.mensajeUsuario });
      }
      // No debería pasar en una campaña de 4 días, pero si pasa, mejor un
      // 500 genérico y prolijo que un stack trace crudo al vecino.
      console.error('Error inesperado en /api/sorteo/jugada:', e);
      return res
        .status(500)
        .json({ error: 'Uy, algo falló de nuestro lado. Probá de nuevo en un rato.' });
    }
  });
}
