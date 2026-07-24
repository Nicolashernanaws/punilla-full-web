# Punilla Full — Landing + Motor de Fundadores

Landing de apertura + campaña "Tarjeta Fundador" con motor **server-side** (contador
atómico de Fundadores, dedupe por teléfono, stock como tope duro, código firmado y
panel de canje). Node + Express + Postgres.

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Landing actual (estática) |
| `/fundador` | Flujo Fundador (form → contador 5s → premio). QR de la tarjeta apunta acá. Soporta `?c=tarjeta` para medir origen |
| `/admin` | Panel de canje del cajero (protegido por `ADMIN_KEY`) |
| `/bases` | Bases y condiciones (BORRADOR — revisar con contador) |
| `POST /api/fundador` | Alta + asignación de premio (motor) |
| `GET /api/config` | `{ waNumber, quedan, total }` para la landing |
| `GET /api/stock` | `{ quedan, total }` |
| `GET /api/admin/fundadores?q=` · `POST /api/admin/canje` · `GET /api/admin/export.csv` | Admin |

## Variables de entorno (Railway → servicio → Variables)

- `DATABASE_URL` — la inyecta el plugin Postgres de Railway.
- `CODE_SECRET` — secreto largo y aleatorio para firmar códigos. **Setear.**
- `ADMIN_KEY` — clave del panel `/admin`. **Setear.**
- `WA_NUMBER` — WhatsApp Business del negocio, formato `549XXXXXXXXXX` (sin +). **Setear.**

## Deploy en Railway

1. En el servicio `production`, agregar el plugin **PostgreSQL** (`+ Create → Database → Add PostgreSQL`).
   Railway inyecta `DATABASE_URL` automáticamente.
2. Setear `CODE_SECRET`, `ADMIN_KEY` y `WA_NUMBER` en Variables.
3. Push a la branch conectada → Railway corre `npm install` y `npm start`.
   Al arrancar, el server aplica el esquema y siembra los premios solos (idempotente,
   **no pisa stock** en redeploys).

## Premios / stock

Se editan en `config/premios.json` (sólo aplica en la primera siembra). Para cambiar
stock/probabilidad de un premio ya vivo, hacerlo con un UPDATE en la DB o desde una
migración — el seed nunca sobrescribe stock consumido.

`stock: null` = ilimitado. `es_consuelo: true` = premio que garantiza que **todos ganan**
cuando se agota el stock premium. El chip "Quedan X premios hoy" cuenta sólo el stock
premium finito.

## Correr local

```bash
npm install
# Postgres local con DB punilla_dev (o setear DATABASE_URL)
npm start           # aplica esquema + seed y levanta en :3000
npm test            # tests de motor + normalización de teléfono
```

## Garantías del motor (verificadas con tests)

- **Contador atómico**: N jugadas concurrentes → N° de Fundador únicos y contiguos (row lock).
- **Dedupe**: mismo teléfono con/sin `+54/9/0/15` → un solo registro; repetir devuelve el premio ya asignado (idempotente), incluso bajo carrera.
- **Stock como tope duro**: nunca negativo; agotado el premium, cae al consuelo.
- **Código firmado** (HMAC) + único; canje irreversible y atómico en `/admin`.
