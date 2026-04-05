import "dotenv/config";

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCurrentHWID, loadAndVerifyLicense, storeLicense } from "../../license-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");

const args = new Set(process.argv.slice(2));
const prepareOnly = args.has("--prepare-only");
const forceLicense = args.has("--force-license");

const keysDir = path.join(rootDir, "keys");
const licensesDir = path.join(rootDir, "licenses");
const privateKeyPath = path.join(keysDir, "private_key.pem");
const publicKeyPath = path.join(keysDir, "public_key.pem");
const rootLicensePath = path.join(rootDir, "license.txt");

function log(message) {
  console.log(`[start] ${message}`);
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^\w.-]+/g, "_").slice(0, 80);
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

function ensureDefaultEnv() {
  if (!hasValue(process.env.SESSION_PATH)) {
    process.env.SESSION_PATH = "./session.json";
  }

  if (!hasValue(process.env.CALENDAR_ID)) {
    process.env.CALENDAR_ID = "local-dev-calendar";
  }

  if (!hasValue(process.env.LICENSE_PASSPHRASE)) {
    process.env.LICENSE_PASSPHRASE = "local-development-passphrase";
  }

  if (!hasValue(process.env.LOG_LEVEL)) {
    process.env.LOG_LEVEL = "info";
  }

  if (!hasValue(process.env.TZ)) {
    process.env.TZ = "Europe/Rome";
  }

  if (!hasValue(process.env.LICENSE_PUBLIC_KEY_PEM)) {
    process.env.LICENSE_PUBLIC_KEY_FILE = hasValue(process.env.LICENSE_PUBLIC_KEY_FILE)
      ? process.env.LICENSE_PUBLIC_KEY_FILE.trim()
      : publicKeyPath;
  }
}

async function ensureKeys() {
  await fsp.mkdir(keysDir, { recursive: true });

  const hasPrivateKey = fs.existsSync(privateKeyPath);
  const hasPublicKey = fs.existsSync(publicKeyPath);
  if (hasPrivateKey && hasPublicKey) {
    return;
  }

  log("Chiavi licenza mancanti: genero una coppia Ed25519 locale.");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  await fsp.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  await fsp.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), "utf8");
}

async function writeDevLicense() {
  await fsp.mkdir(licensesDir, { recursive: true });

  const payload = {
    v: 1,
    client: process.env.LICENSE_AUTO_CLIENT?.trim() || `Local-${os.hostname()}`,
    plan: process.env.LICENSE_AUTO_PLAN?.trim() || "Premium",
    hwid: getCurrentHWID(),
    issueAt: new Date().toISOString(),
    expiryAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    graceDays: 7,
  };

  const orderedPayload = {
    v: payload.v,
    client: payload.client,
    plan: payload.plan,
    hwid: payload.hwid,
    issueAt: payload.issueAt,
    expiryAt: payload.expiryAt,
    graceDays: payload.graceDays,
  };

  const licenseBase64 = base64Url(Buffer.from(JSON.stringify(orderedPayload), "utf8"));
  const privateKey = await fsp.readFile(privateKeyPath, "utf8");
  const signature = crypto.sign(null, Buffer.from(licenseBase64, "utf8"), crypto.createPrivateKey(privateKey));
  const licenseText = `LIC=${licenseBase64}\nSIG=${base64Url(signature)}\n`;

  const fileName = `${sanitizeFilePart(payload.client)}-${sanitizeFilePart(payload.hwid)}-${sanitizeFilePart(payload.plan)}.license.txt`;
  const namedLicensePath = path.join(licensesDir, fileName);

  await fsp.writeFile(namedLicensePath, licenseText, "utf8");
  await fsp.writeFile(rootLicensePath, licenseText, "utf8");
  await storeLicense(licenseText);

  log(`Licenza development generata in ${path.relative(rootDir, namedLicensePath)}.`);
  log("Ho aggiornato anche license.txt in root per rendere l'avvio del bot immediato.");
}

async function ensureLicense() {
  if (forceLicense) {
    log("Rigenerazione forzata della licenza locale richiesta.");
    await writeDevLicense();
    return;
  }

  try {
    const { file, payload } = await loadAndVerifyLicense();
    log(`Licenza valida trovata: ${path.relative(rootDir, file)} (${payload.plan}).`);
    return;
  } catch (error) {
    log(`Licenza non disponibile o non valida: ${error instanceof Error ? error.message : String(error)}`);
  }

  await writeDevLicense();

  const { file, payload } = await loadAndVerifyLicense();
  log(`Licenza verificata dopo la generazione: ${path.relative(rootDir, file)} (${payload.plan}).`);
}

async function main() {
  process.chdir(rootDir);

  ensureDefaultEnv();
  await ensureKeys();
  await ensureLicense();

  if (prepareOnly) {
    log("Preparazione completata. Nessun processo del bot avviato perche' hai usato --prepare-only.");
    return;
  }

  log("Avvio il bot legacy con npm start.");
  const child = spawn(process.execPath, ["index.js"], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error("[start] Avvio fallito:", error);
  process.exit(1);
});
