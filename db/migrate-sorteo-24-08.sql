-- Alinea el esquema del sorteo con `lib/sorteo-engine.js`.
--
-- POR QUÉ HACE FALTA. En producción las tablas del sorteo las creó una
-- implementación ANTERIOR (la de `feat/sorteo-backend`, mecánica de tickets,
-- 20-23/8) con otras columnas: `barrio`, `ok_novedades`, `sin_compra`. El código
-- que se deployó el 24/8 escribe `nombre`, `consent` y `compartio_via`, que no
-- existían — por eso `POST /api/sorteo/registro` devolvía 500 con la página
-- respondiendo 200. Un 200 en la ruta sólo prueba que el HTML se sirve.
--
-- ES ADITIVO A PROPÓSITO. Las columnas viejas quedan: son nullables o tienen
-- default, así que no estorban, y borrarlas rompería la otra implementación por
-- si alguien todavía la necesita. Verificado antes de correr: 0 filas en
-- `sorteo_participante` y en `sorteo_jugada`, así que no hay datos en juego.

ALTER TABLE sorteo_participante ADD COLUMN IF NOT EXISTS nombre TEXT NOT NULL DEFAULT '';
ALTER TABLE sorteo_participante ALTER COLUMN nombre DROP DEFAULT;
ALTER TABLE sorteo_participante ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sorteo_participante ADD COLUMN IF NOT EXISTS compartio_via TEXT;

ALTER TABLE sorteo_resultado ADD COLUMN IF NOT EXISTS nombre TEXT;
ALTER TABLE sorteo_resultado ADD COLUMN IF NOT EXISTS premio TEXT;
