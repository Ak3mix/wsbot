FROM node:20-bookworm-slim

# Dependencias de sistema para Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# No descargar Chromium de puppeteer (usamos el del sistema)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production

WORKDIR /app

# Instalar dependencias (caché del lockfile)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Código + sesión LocalAuth
COPY . .

# Limpiar locks que rompen Chrome al reutilizar el perfil
RUN rm -f .wwebjs_auth/session/Singleton* .wwebjs_auth/session/DevToolsActivePort

# Puerto del mini servidor web (health + QR)
EXPOSE 7860

CMD ["/bin/sh", "start.sh"]
