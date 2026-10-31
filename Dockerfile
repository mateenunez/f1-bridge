FROM node:20-slim

RUN npm install -g pnpm && \
    apt-get update && apt-get install -y curl gnupg && \
    curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
      | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && \
    echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
      | tee /etc/apt/sources.list.d/ngrok.list && \
    apt-get update && apt-get install -y ngrok && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

RUN pnpm exec playwright install --with-deps chromium

EXPOSE 5631 3005
CMD ["node", "dist/app.js"]