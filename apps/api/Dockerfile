FROM node:20-alpine AS base

WORKDIR /workspace

COPY package.json tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json ./apps/api/package.json

RUN npm install

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN npx prisma generate
RUN npm run build -w @whatsapp-ai/shared
RUN npm run build -w @whatsapp-ai/api

EXPOSE 4000

CMD ["node", "apps/api/dist/server.js"]
