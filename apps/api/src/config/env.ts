function parsePort(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOrigins(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.API_PORT ?? process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  botWorkerBaseUrl: (process.env.BOT_WORKER_BASE_URL ?? "http://127.0.0.1:4001").replace(/\/$/, ""),
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? "change-me-internal-token",
  appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:5173/#/login").replace(/\/$/, ""),
};
