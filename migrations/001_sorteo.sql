-- PUNILLA FULL SORTEO — 20/8 al 23/8/2026, se sortea el lunes 24.
--
-- Todo IF NOT EXISTS: esta migración corre contra la base de producción, que ya
-- tiene las tablas de la campaña Fundador (fundadores, premios, counters) con
-- 75 filas cargadas. No toca nada de eso.

CREATE TABLE IF NOT EXISTS sorteo_participante (
  telefono_norm  TEXT PRIMARY KEY,
  telefono_raw   TEXT NOT NULL,
  barrio         TEXT,
  ok_novedades   BOOLEAN NOT NULL DEFAULT false,
  -- Lo marca el ADMIN a mano después de ver la historia, no el usuario:
  -- si lo pudiera marcar el que carga, son 2 chances gratis para cualquiera.
  compartio      BOOLEAN NOT NULL DEFAULT false,
  -- Ya usó la chance sin compra. Es un flag y no un contador porque la regla
  -- es "una sola vez por teléfono", punto.
  sin_compra     BOOLEAN NOT NULL DEFAULT false,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sorteo_jugada (
  id            BIGSERIAL PRIMARY KEY,
  telefono_norm TEXT NOT NULL REFERENCES sorteo_participante(telefono_norm),
  comercio      TEXT NOT NULL CHECK (comercio IN ('punilla','tomato','lucy')),
  ticket_nro    TEXT NOT NULL,
  monto         INTEGER NOT NULL,
  -- Las chances se guardan CONGELADAS al momento de la carga. Si el umbral se
  -- mueve a mitad de campaña, al vecino no se le sacan chances ya mostradas.
  chances       INTEGER NOT NULL,
  verificado    BOOLEAN NOT NULL DEFAULT false,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El dedupe de tickets. Es la única defensa contra cargar el mismo ticket diez
-- veces, y tiene que vivir en la base: un chequeo en el código tiene carrera.
CREATE UNIQUE INDEX IF NOT EXISTS sorteo_jugada_comercio_ticket
  ON sorteo_jugada (comercio, ticket_nro);

CREATE INDEX IF NOT EXISTS sorteo_jugada_telefono
  ON sorteo_jugada (telefono_norm);

CREATE TABLE IF NOT EXISTS sorteo_resultado (
  id            BIGSERIAL PRIMARY KEY,
  puesto        INT NOT NULL,
  telefono_norm TEXT NOT NULL,
  -- Semilla y tamaño del padrón: sin esto el sorteo no se puede auditar y
  -- "salió tu primo" no tiene respuesta. Se guardan aunque nadie los mire.
  semilla       TEXT NOT NULL,
  padron_size   INT NOT NULL,
  sorteado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
