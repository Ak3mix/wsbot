FROM node:20-bookworm-slim

# Google Chrome estable (versión actual ~151; arregla el re-escaneo del QR)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg \
    curl \
    ca-certificates \
    fonts-liberation \
    dumb-init \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/googlechrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# No descargar Chromium de puppeteer (usamos el Chrome del sistema)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production \
    CHROME_PATH=/usr/bin/google-chrome-stable

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
