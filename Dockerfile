# Hasta el 20/8 esto era `nginx:alpine` sirviendo un index.html estático.
# El sorteo necesita persistencia, así que ahora corre Node y sirve los mismos
# estáticos con Express. La landing tiene que seguir saliendo por `GET /`.
FROM node:22-alpine

WORKDIR /app

# Primero las dependencias, para que un cambio en el HTML no reinstale todo.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# La migración corre en el arranque: es idempotente y la campaña dura 4 días,
# no hay tiempo para un paso manual que alguien se puede olvidar de hacer.
CMD ["sh", "-c", "node scripts/migrar.js && node server.js"]
