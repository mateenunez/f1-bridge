FROM node:20-slim

# 1. Instalamos solo lo mínimo indispensable (Casi instantáneo)
RUN npm install -g pnpm && \
    apt-get update && apt-get install -y curl gnupg && \
    curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && \
    echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
      | tee /etc/apt/sources.list.d/ngrok.list && \
    apt-get update && apt-get install -y ngrok && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Instalamos dependencias de producción
# Docker cacheará este paso y no lo repetirá a menos que cambies el package.json
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 3. Copiamos el JS que ya compilaste en Windows (Super rápido)
COPY dist ./dist

# 4. El Entrypoint ahora es directo, sin scripts de WARP internos
CMD ["node", "dist/app.js"]