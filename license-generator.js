
// license-generator.js (ESM, Node 18+)
// Uso veloce (non interattivo):
//   node license-generator.js "Cliente XYZ" Premium HW-ABC123 2026-12-31T23:59:59Z --install-env="C:\path\dist" --out="C:\path\license.txt"
//
// Uso guidato (interattivo):
//   node license-generator.js
//
// Cosa fa:
// - Genera chiavi Ed25519 in ./keys/ se mancano (private_key.pem, public_key.pem)
// - Mostra/accetta il piano (default: Trial) e durata (mesi/giorni) se non passi una data di scadenza
// - Autodetect HWID se non lo passi (stabile per macchina/utente)
// - Crea licenza firmata: due righe in chiaro: LIC=<base64url(JSON)> e SIG=<base64url(signature)>
// - Scrive la licenza in ./licenses/ <cliente>-<HWID>-<piano>.license.txt
// - Se passi --install-env=DIR, copia anche license.txt + public_key.pem in DIR
//
// NOTE:
// - E' un modulo ESM puro. Se il tuo progetto è "type": "module" va bene così. Altrimenti rinomina in .mjs o aggiungi "type": "module" nel package.json.

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// ---- Costanti CLI/percorsi ----
const ENV_DIR_ARG = '--install-env';   // <-- FIX: definita per evitare ReferenceError
const OUT_FILE_ARG = '--out';
const HELP_ARG = '--help';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;

const KEYS_DIR = path.join(ROOT, 'keys');
const LICENSES_DIR = path.join(ROOT, 'licenses');
const PUB_KEY_PATH = path.join(KEYS_DIR, 'public_key.pem');
const PRIV_KEY_PATH = path.join(KEYS_DIR, 'private_key.pem');

// ---- Piani disponibili ----
const PLANS = [
  { id: 'Trial',    desc: 'Prova 14-30-60gg, feature limitate', defaultMonths: 1 },
  { id: 'Basic',    desc: 'Core booking + FAQ',                  defaultMonths: 6 },
  { id: 'Medium',   desc: '+ Promo dinamiche + Reminder',        defaultMonths: 12 },
  { id: 'Premium',  desc: 'Tutto incluso + avanzate',            defaultMonths: 12 },
];

// ---- Utils ----
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sanitizeForFilename(s) {
  return String(s).trim().replace(/[^a-z0-9\-\._]+/gi, '_').slice(0, 80);
}

function nowIso() {
  return new Date().toISOString();
}

function detectHWID() {
  const user = (() => {
    try { return os.userInfo().username; } catch { return 'nouser'; }
  })();
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    user
  ].join('|');
  const h = crypto.createHash('sha256').update(raw).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return 'HW-' + h.slice(0, 32);
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function ensureKeys() {
  await ensureDir(KEYS_DIR);
  await ensureDir(LICENSES_DIR);

  const hasPriv = await fsp.access(PRIV_KEY_PATH).then(() => true).catch(() => false);
  const hasPub  = await fsp.access(PUB_KEY_PATH).then(() => true).catch(() => false);

  if (hasPriv && hasPub) return;

  console.log('[keys] Genero chiavi Ed25519 in', KEYS_DIR);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem  = publicKey.export({ type: 'spki', format: 'pem' });

  await fsp.writeFile(PRIV_KEY_PATH, privPem);
  await fsp.writeFile(PUB_KEY_PATH, pubPem);
  console.log('[keys] OK');
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--')) {
      const [k, ...rest] = raw.split('=');
      const key = k;
      const val = rest.length ? rest.join('=') : true;
      flags[key] = val;
      const short = key.replace(/^--/, '');
      flags[short] = val;
    } else {
      positionals.push(raw);
    }
  }
  return { flags, positionals };
}

function printHelp() {
  console.log(`
Uso:
  node license-generator.js [Cliente] [Piano] [HWID] [ISO_expiry] [--install-env="C:\\dest"] [--out="C:\\file.txt"]

Esempi:
  node license-generator.js
  node license-generator.js "Perla Line Group" Premium HW-1234 2026-12-31T23:59:59Z --install-env="C:\\Users\\me\\Desktop\\whatsapp-ai\\dist"
`);
}

function planById(id) {
  return PLANS.find(p => p.id.toLowerCase() === String(id||'').toLowerCase());
}

function computeExpiryFromDuration(kind, amount, baseDate = new Date()) {
  const d = new Date(baseDate);
  if (kind === 'm') {
    d.setMonth(d.getMonth() + amount);
  } else {
    d.setDate(d.getDate() + amount);
  }
  return d.toISOString();
}

async function ask(rl, q, def = '') {
  const a = (await rl.question(q + (def ? ` [${def}]` : '') + ' ')).trim();
  return a || def;
}

async function createLicense({ client, plan, hwid, expiryIso, installDir, outFile }) {
  await ensureKeys();

  if (!client) throw new Error('Client mancante');
  if (!planById(plan)) throw new Error(`Piano non valido: ${plan}`);
  if (!hwid) throw new Error('HWID mancante');
  if (!expiryIso || isNaN(Date.parse(expiryIso))) throw new Error('Data di scadenza ISO non valida');

  const payload = {
    v: 1,
    client,
    plan,
    hwid,
    issueAt: nowIso(),
    expiryAt: new Date(expiryIso).toISOString(),
    graceDays: 7
  };

  // Canonical JSON (inseriamo le chiavi in ordine voluto)
  const ordered = {
    v: payload.v,
    client: payload.client,
    plan: payload.plan,
    hwid: payload.hwid,
    issueAt: payload.issueAt,
    expiryAt: payload.expiryAt,
    graceDays: payload.graceDays
  };
  const licJson = JSON.stringify(ordered);
  const licB64 = base64url(Buffer.from(licJson));

  const privPem = await fsp.readFile(PRIV_KEY_PATH, 'utf8');
  const signature = crypto.sign(null, Buffer.from(licB64), crypto.createPrivateKey(privPem));
  const sigB64 = base64url(signature);

  const suggestedName = `${sanitizeForFilename(client)}-${sanitizeForFilename(hwid)}-${sanitizeForFilename(plan)}.license.txt`;
  const defaultOut = path.join(LICENSES_DIR, suggestedName);
  const finalOut = outFile ? outFile : defaultOut;
  await ensureDir(path.dirname(finalOut));
  await fsp.writeFile(finalOut, `LIC=${licB64}\nSIG=${sigB64}\n`, 'utf8');

  console.log('[ok] Licenza creata:', finalOut);

  if (installDir) {
    await ensureDir(installDir);
    const destLic = path.join(installDir, 'license.txt');
    const destPub = path.join(installDir, 'public_key.pem');
    await fsp.copyFile(finalOut, destLic);
    await fsp.copyFile(PUB_KEY_PATH, destPub);
    console.log('[install] Copiati license.txt e public_key.pem in', installDir);
  }

  return { finalOut, licB64, sigB64 };
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv);
  if (flags[HELP_ARG] || flags.help === true) {
    printHelp();
    return;
  }

  let [client, plan, hwid, expiryIso] = positionals;
  let installDir = typeof flags[ENV_DIR_ARG] === 'string' ? flags[ENV_DIR_ARG] : (typeof flags['install-env'] === 'string' ? flags['install-env'] : null);
  let outFile = typeof flags[OUT_FILE_ARG] === 'string' ? flags[OUT_FILE_ARG] : (typeof flags['out'] === 'string' ? flags['out'] : null);

  // Modalità interattiva se mancano parametri chiave
  if (!client || !plan || !hwid || !expiryIso) {
    const rl = readline.createInterface({ input, output });

    if (!client) {
      client = await ask(rl, 'Nome cliente (es. Perla Line Group)');
    }

    // Piano
    if (!plan) {
      console.log('\nPiani disponibili:');
      PLANS.forEach((p, i) => console.log(`  ${i + 1}. ${p.id} — ${p.desc}`));
      const pick = await ask(rl, 'Scegli piano (numero o nome)', 'Trial');
      const chosen = PLANS.find((p, i) =>
        String(i + 1) === pick.trim() ||
        p.id.toLowerCase() === pick.trim().toLowerCase()
      );
      plan = chosen ? chosen.id : 'Trial';
    }

    // HWID
    if (!hwid) {
      hwid = detectHWID();
      console.log('[hwid] auto-detected:', hwid);
      const confirm = (await ask(rl, 'Usare questo HWID? (s/n)', 's')).toLowerCase();
      if (confirm !== 's') {
        hwid = await ask(rl, 'Inserisci HWID (formato HW-*)');
      }
    }

    // Scadenza
    if (!expiryIso) {
      console.log('\nDurata licenza:');
      const kind = (await ask(rl, 'm = mesi, g = giorni', 'm')).toLowerCase() === 'g' ? 'g' : 'm';
      const defMonths = planById(plan)?.defaultMonths ?? 1;
      const amountStr = await ask(rl, kind === 'm' ? 'Quanti mesi?' : 'Quanti giorni?', String(defMonths));
      const amount = Math.max(1, parseInt(amountStr, 10) || defMonths);
      expiryIso = computeExpiryFromDuration(kind, amount);
      console.log('[expiry] userà:', expiryIso);
    }

    // Destinazione install
    if (!installDir) {
      const maybe = await ask(rl, `Copia anche in una cartella di installazione? (${ENV_DIR_ARG}=...)`, '');
      if (maybe) installDir = maybe;
    }

    // File out opzionale
    if (!outFile) {
      const maybeOut = await ask(rl, 'Percorso file licenza personalizzato (--out=...)', '');
      if (maybeOut) outFile = maybeOut;
    }

    await rl.close();
  }

  await createLicense({ client, plan, hwid, expiryIso, installDir, outFile });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === __filename) {
  main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
