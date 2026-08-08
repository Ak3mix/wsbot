FROM node:20-bookworm-slim

# dumb-init para manejo de señales
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Instalar dependencias (caché del lockfile)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Código + sesión (Baileys)
COPY . .

# Puerto del mini servidor web (health + QR)
EXPOSE 7860

CMD ["/bin/sh", "start.sh"]
