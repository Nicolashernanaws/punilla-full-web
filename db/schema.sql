-- Esquema Punilla Full — Fundadores. Idempotente (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  val  BIGINT NOT NULL DEFAULT 0
);

-- Contador de Fundadores: fila única bloqueada por transacción -> secuencial y atómico.
INSERT INTO counters (name, val)
VALUES ('fundador', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS premios (
  id             SERIAL PRIMARY KEY,
  nombre         TEXT NOT NULL UNIQUE,
  prob           INTEGER NOT NULL DEFAULT 1,      -- peso relativo
  stock_inicial  INTEGER,                         -- NULL = ilimitado
  stock_restante INTEGER,                         -- NULL = ilimitado
  vigencia_dias  INTEGER NOT NULL DEFAULT 15,
  vigencia_texto TEXT NOT NULL DEFAULT '15 días',
  nivel          TEXT NOT NULL DEFAULT 'comun',   -- 'comun' | 'golden'
  es_consuelo    BOOLEAN NOT NULL DEFAULT FALSE,  -- se usa cuando no queda stock premium
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  orden          INTEGER NOT NULL DEFAULT 0,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fundadores (
  id             SERIAL PRIMARY KEY,
  numero         INTEGER UNIQUE,                  -- "Fundador #N" secuencial
  telefono_norm  TEXT NOT NULL UNIQUE,            -- canónico para dedupe
  telefono_raw   TEXT,
  nombre         TEXT,
  barrio         TEXT,
  consent        BOOLEAN NOT NULL DEFAULT FALSE,
  premio_id      INTEGER REFERENCES premios(id),
  premio_nombre  TEXT,
  nivel          TEXT NOT NULL DEFAULT 'comun',
  codigo         TEXT NOT NULL UNIQUE,
  token          TEXT,                            -- firma HMAC del código
  vigencia_texto TEXT,
  vence_el       DATE,
  canal          TEXT,                            -- ?c= de la URL (tarjeta / qr-local / etc)
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  canjeado_at    TIMESTAMPTZ,
  canjeado_por   TEXT
);

CREATE INDEX IF NOT EXISTS idx_fundadores_created ON fundadores (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fundadores_codigo  ON fundadores (codigo);
CREATE INDEX IF NOT EXISTS idx_fundadores_canje   ON fundadores (canjeado_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- PUNILLA FULL SORTEO — carga del 24/8 al jueves 27/8 20:00, se sortea a las 21.
--
-- Convive con Fundadores en la MISMA base: todo IF NOT EXISTS y nada de esto
-- toca `fundadores`, `premios` ni `counters`, que están vivos y con datos.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sorteo_participante (
  telefono_norm TEXT PRIMARY KEY,              -- canónico, mismo criterio que fundadores
  telefono_raw  TEXT,
  nombre        TEXT NOT NULL,
  consent       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Compartir la historia etiquetando a las tres cuentas es REQUISITO, y lo
  -- marca el ADMIN después de verla, nunca el que se anota: si lo pudiera
  -- marcar el usuario, el requisito no existe.
  compartio     BOOLEAN NOT NULL DEFAULT FALSE,
  compartio_via TEXT,                          -- 'historia' | 'caja' (el que no usa Instagram)
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sorteo_registro (
  id            BIGSERIAL PRIMARY KEY,
  telefono_norm TEXT NOT NULL REFERENCES sorteo_participante(telefono_norm),
  comercio      TEXT NOT NULL CHECK (comercio IN ('punilla','tomato','lucy')),
  -- Día calendario argentino. Lo calcula el código (lib/sorteo.diaArg) y lo
  -- manda como parámetro, para que el tope diario sea testeable sin esperar
  -- a que cambie el día de verdad.
  dia           DATE NOT NULL,
  -- false = se pasó del tope antifraude. El registro SE GUARDA igual (sirve
  -- para auditar si alguien intentó inflar) pero no suma chances.
  cuenta        BOOLEAN NOT NULL DEFAULT TRUE,
  ip            TEXT,
  user_agent    TEXT,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sorteo_registro_tel  ON sorteo_registro (telefono_norm);
-- El índice del tope: la consulta de "cuántos lleva hoy" corre en CADA carga.
CREATE INDEX IF NOT EXISTS idx_sorteo_registro_tope ON sorteo_registro (telefono_norm, comercio, dia);

CREATE TABLE IF NOT EXISTS sorteo_resultado (
  puesto        INT PRIMARY KEY,               -- 1 a 4, uno por premio
  telefono_norm TEXT NOT NULL,
  nombre        TEXT,
  premio        TEXT NOT NULL,
  -- Semilla y tamaño del padrón: sin esto el sorteo no se puede auditar y
  -- "salió tu primo" no tiene respuesta. Se guardan aunque nadie los mire.
  semilla       TEXT NOT NULL,
  padron_size   INT NOT NULL,
  sorteado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un teléfono no puede ganar dos premios: son 4 ganadores DISTINTOS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sorteo_resultado_tel ON sorteo_resultado (telefono_norm);
