-- Parte Diario — checklists de turno con rastro auditable.
--
-- POR QUÉ ACÁ Y NO EN EL POS. El POS es hoy el bloqueante de ARCA: no se le mete
-- trabajo que no sea fiscal. Y por qué no como artifact de Claude: los artifacts
-- que guardan estado sólo los abren cuentas de la organización, y Julián, Vanesa
-- y las chicas de fiambrería no tienen cuenta de Claude ni la van a tener.

CREATE TABLE IF NOT EXISTS parte_persona (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL,
  -- enc_m | enc_t | fiam_m | fiam_t | prod
  puesto    TEXT NOT NULL,
  -- 🔴 NUNCA el PIN en claro. scrypt con salt por persona.
  pin_hash  TEXT NOT NULL,
  activo    BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parte_persona_puesto_idx ON parte_persona (puesto) WHERE activo;

-- Un parte por FECHA OPERATIVA y puesto. Ojo: la fecha operativa no es la del
-- reloj — corta a las 05:00 de Córdoba. Ver lib/parte-fecha.js.
CREATE TABLE IF NOT EXISTS parte_dia (
  id             SERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  puesto         TEXT NOT NULL,
  -- {taskId: {n:"Julián", at:"08:12"}}
  items          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {campoId: "4.2"}
  campos         JSONB NOT NULL DEFAULT '{}'::jsonb,
  nota           TEXT NOT NULL DEFAULT '',
  -- {estado:'ok'|'pend', by, at, detalle}
  cierre         JSONB,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fecha, puesto)
);

-- 🔴 APPEND-ONLY. Nunca UPDATE ni DELETE: es el historial, y es lo que el
-- administrador realmente necesita ver. Destildar una tarea escribe un evento
-- `destilde`, no borra el `tilde`. Si se pudiera borrar, la línea de tiempo
-- dejaría de servir justo para lo que se hizo: ver quién tildó doce cosas a las
-- 15:58, que es la señal de que la lista se completa de memoria al final.
CREATE TABLE IF NOT EXISTS parte_evento (
  id         BIGSERIAL PRIMARY KEY,
  fecha      DATE NOT NULL,
  puesto     TEXT NOT NULL,
  persona_id INT REFERENCES parte_persona(id),
  -- tilde | destilde | campo | nota | cierre | reapertura | login
  tipo       TEXT NOT NULL,
  item_id    TEXT,
  valor      TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parte_evento_dia_idx ON parte_evento (fecha, puesto, ts);
