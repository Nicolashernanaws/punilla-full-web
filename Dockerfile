# Punilla Full — app Node/Express (sirve landing + /fundador + /admin + API)
FROM node:20-alpine
WORKDIR /app

# deps primero (mejor cache)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# código
COPY . .

ENV NODE_ENV=production
# Railway inyecta PORT; el server lo lee de process.env.PORT
EXPOSE 3000
CMD ["npm", "start"]
