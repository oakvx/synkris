function parsePort(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined) {
    return fallback;
  }

  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseOrigins(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseOptionalString(input: string | undefined): string | null {
  const value = input?.trim();
  return value ? value : null;
}

function isPlaceholderSecret(input: string | undefined): boolean {
  const normalized = (input ?? "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    "change-me",
    "change-me-internal-token",
    "change-me-with-a-long-random-secret",
  ].includes(normalized);
}

const nodeEnv = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
const isProductionLike = !["development", "test"].includes(nodeEnv);
const jwtSecret = process.env.JWT_SECRET ?? "change-me";
const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN ?? "change-me-internal-token";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.API_PORT ?? process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret,
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  botWorkerBaseUrl: (process.env.BOT_WORKER_BASE_URL ?? "http://127.0.0.1:4001").replace(/\/$/, ""),
  internalServiceToken,
  appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:5173/#/login").replace(/\/$/, ""),
  clientBotRootDir: parseOptionalString(process.env.CLIENT_BOT_ROOT_DIR),
  allowSelfRegistration: parseBoolean(process.env.ALLOW_SELF_REGISTRATION, !isProductionLike),
  enableBotSqlConsole: parseBoolean(process.env.ENABLE_BOT_SQL_CONSOLE, !isProductionLike),
  allowClientBotStart: parseBoolean(process.env.ALLOW_CLIENT_BOT_START, !isProductionLike),
  authCookieName: parseOptionalString(process.env.AUTH_COOKIE_NAME) ?? "whatsapp_ai_session",
  authSessionTtlSeconds: parsePort(process.env.AUTH_SESSION_TTL_SECONDS, 60 * 60 * 8),
  cookieSecure: parseBoolean(process.env.AUTH_COOKIE_SECURE, isProductionLike),
  pushVapidPublicKey: parseOptionalString(process.env.PUSH_VAPID_PUBLIC_KEY),
  pushVapidPrivateKey: parseOptionalString(process.env.PUSH_VAPID_PRIVATE_KEY),
  pushVapidSubject: parseOptionalString(process.env.PUSH_VAPID_SUBJECT) ?? "mailto:dev@example.com",
};

const envProblems: string[] = [];
if (!env.databaseUrl.trim()) {
  envProblems.push("DATABASE_URL mancante.");
}

if (isPlaceholderSecret(env.jwtSecret) || env.jwtSecret.trim().length < 32) {
  const message = "JWT_SECRET debole o placeholder.";
  if (isProductionLike) {
    envProblems.push(message);
  } else {
    console.warn(`[api] ${message}`);
  }
}

if (isPlaceholderSecret(env.internalServiceToken) || env.internalServiceToken.trim().length < 24) {
  const message = "INTERNAL_SERVICE_TOKEN debole o placeholder.";
  if (isProductionLike) {
    envProblems.push(message);
  } else {
    console.warn(`[api] ${message}`);
  }
}

if (isProductionLike && env.allowedOrigins.length === 0) {
  envProblems.push("ALLOWED_ORIGINS deve essere valorizzato in produzione.");
}

if (Boolean(env.pushVapidPublicKey) !== Boolean(env.pushVapidPrivateKey)) {
  const message = "Configurazione push incompleta: servono sia PUSH_VAPID_PUBLIC_KEY che PUSH_VAPID_PRIVATE_KEY.";
  if (isProductionLike) {
    envProblems.push(message);
  } else {
    console.warn(`[api] ${message}`);
  }
}

if (envProblems.length > 0) {
  throw new Error(`[api] Configurazione non sicura: ${envProblems.join(" ")}`);
}
