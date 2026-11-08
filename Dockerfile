FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY package.json package-lock.json ./
# Chromium is installed by apt. No dependency lifecycle/download scripts are needed.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY LICENSE.md deploy/THIRD_PARTY_NOTICES.md ./
COPY src ./src
COPY scripts/db ./scripts/db
COPY scripts/deploy/bootstrap.mjs ./scripts/deploy/bootstrap.mjs
COPY assets ./assets
USER node
CMD ["node", "src/index.js"]
