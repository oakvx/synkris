import path from "node:path";

function parsePort(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.BOT_WORKER_PORT ?? process.env.PORT, 4001),
  internalToken: process.env.INTERNAL_SERVICE_TOKEN ?? "change-me-internal-token",
  provider: (process.env.BOT_PROVIDER ?? "mock").trim().toLowerCase(),
  databaseUrl: process.env.DATABASE_URL ?? "",
  sessionDir: path.resolve(process.env.BOT_SESSION_DIR ?? "./bot-sessions"),
};
