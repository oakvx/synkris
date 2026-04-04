FROM node:20-alpine AS base

WORKDIR /workspace

COPY package.json tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/bot-worker/package.json ./apps/bot-worker/package.json

RUN npm install

COPY packages/shared ./packages/shared
COPY apps/bot-worker ./apps/bot-worker

RUN npx prisma generate
RUN npm run build -w @whatsapp-ai/shared
RUN npm run build -w @whatsapp-ai/bot-worker

EXPOSE 4001

CMD ["node", "apps/bot-worker/dist/server.js"]
