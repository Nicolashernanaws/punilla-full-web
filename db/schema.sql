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
