import path from "node:path";

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

function parseHeadless(input: string | undefined): boolean | "new" {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "new") {
    return "new";
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return true;
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

  return ["change-me-internal-token"].includes(normalized);
}

const nodeEnv = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
const isProductionLike = !["development", "test"].includes(nodeEnv);
const internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "change-me-internal-token";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.BOT_WORKER_PORT ?? process.env.PORT, 4001),
  internalToken,
  provider: (process.env.BOT_PROVIDER ?? "open-wa").trim().toLowerCase(),
  databaseUrl: process.env.DATABASE_URL ?? "",
  sessionDir: path.resolve(process.env.BOT_SESSION_DIR ?? "./bot-sessions"),
  chromePath: parseOptionalString(process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH),
  headless: parseHeadless(process.env.BOT_HEADLESS),
  qrTimeoutMs: parsePort(process.env.QR_TIMEOUT_MS, 0),
  authTimeoutMs: parsePort(process.env.AUTH_TIMEOUT_MS, 0),
  qrLogSkip: parseBoolean(process.env.BOT_QR_LOG_SKIP, false),
};

const envProblems: string[] = [];
if (!env.databaseUrl.trim()) {
  envProblems.push("DATABASE_URL mancante.");
}

if (isPlaceholderSecret(env.internalToken) || env.internalToken.trim().length < 24) {
  const message = "INTERNAL_SERVICE_TOKEN debole o placeholder.";
  if (isProductionLike) {
    envProblems.push(message);
  } else {
    console.warn(`[bot-worker] ${message}`);
  }
}

if (envProblems.length > 0) {
  throw new Error(`[bot-worker] Configurazione non sicura: ${envProblems.join(" ")}`);
}
