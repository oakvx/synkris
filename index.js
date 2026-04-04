// index.js – bootstrap minimale + router messaggi (ESM) con hardening
import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import express from 'express';
import {
  handleMessage,
  handleNumericReply,
  remind24hTick,
  getState,
  resetState,
  safeSend,
  startReviewFollowupsLoop,
  confirmAppointmentsTick,
} from './util.js';
import { debugDataDir } from './fs-json.js';
console.log('[DATA_DIR]', debugDataDir());
import { loadAndVerifyLicense, storeLicense } from './license-utils.js';
import { verifyLicenseText } from './license-utils.js';
import { createRequire } from 'node:module';
import net from 'node:net';
import { warmOllama } from './util.js';



function normalizeLicenseText(s) {
  return String(s).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() + '\n';
}

const __req =
  (typeof module !== 'undefined' && module.require)
    ? module.require
    : createRequire(process.cwd() + '/noop.js');

// ====== RUNTIME PACKAGING DETECTION (SEA / PKG) ======
try {
  let IS_SEA = false;
  try {
    const sea = __req('node:sea');
    IS_SEA = !!(sea && typeof sea.isSea === 'function' ? sea.isSea() : false);
  } catch { /* non SEA */ }
  const IS_PKG = !!(process.versions && process.versions.pkg);
  if ((IS_SEA || IS_PKG) && !process.env.APP_DATA_DIR) {
    process.env.APP_DATA_DIR = path.join(path.dirname(process.execPath), 'configs & dashboard');
  }
} catch { /* best-effort */ }

// --- loader @open-wa/wa-automate dal filesystem (compatibile SEA) ---
const IS_PKG = !!(process.versions && process.versions.pkg);
let IS_SEA = false;
try { const sea = __req('node:sea'); IS_SEA = !!(sea?.isSea?.()); } catch {}

const __requireCJS = (IS_SEA || IS_PKG)
  ? createRequire(process.execPath + (process.platform === 'win32' ? '\\noop.js' : '/noop.js'))
  : __req;

const __waModule = __requireCJS('@open-wa/wa-automate');
const __waCreate = __waModule?.create || __waModule?.default?.create || __waModule?.default || __waModule;

if (typeof __waCreate !== 'function') {
  throw new Error('wa-automate create() non trovato');
}

// --- wrapper create() SAFE (no loop/console) ---
function __arrayUnion(a = [], b = []) {
  const A = Array.isArray(a) ? a : (a ? [a] : []);
  const B = Array.isArray(b) ? b : (b ? [b] : []);
  const set = new Set([...A, ...B].filter(Boolean));
  return Array.from(set);
}

const create = async (opts = {}) => {
  const safeArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--disable-popup-blocking',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--password-store=basic',
    '--force-color-profile=srgb',
    '--log-level=3',
    '--enable-logging=stderr'
  ];

  const merged = { ...opts };
  merged.restartOnCrash = false;
  merged.autoRefresh = false;
  merged.killProcessOnBrowserClose = true;
  merged.disableSpins = true;
  merged.logConsole = false;
  if (merged.headless === undefined) merged.headless = 'new';
  merged.useChrome = true;
  if (!merged.executablePath) merged.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;

  if (!merged.sessionDataPath) {
    merged.sessionDataPath = path.join(path.dirname(process.execPath), 'configs & dashboard', 'session');
  }

  merged.args = __arrayUnion(safeArgs, merged.args || []);
  return __waCreate(merged);
};

// --- single-instance lock (evita doppie esecuzioni / spam console) ---
try {
  const LOCK_PORT = 39771;
  const __lock = net.createServer().unref();
  __lock.on('error', () => process.exit(0));
  __lock.listen(LOCK_PORT, '127.0.0.1');
} catch {}

// ====== tiny logger ======
const log = (l, m, extra) =>
  (l === 'error' ? console.error : l === 'warn' ? console.warn : console.log)(
    `[${new Date().toISOString()}] [${l.toUpperCase()}] ${m}`,
    extra ?? ''
  );

// ====== HARDENING: directory dati e safe I/O JSON ======
const DEFAULT_DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'whatsapp-ai',
  'configs & dashboard'
);

export const DATA_DIR = process.env.APP_DATA_DIR
  ? path.normalize(process.env.APP_DATA_DIR)
  : DEFAULT_DATA_DIR;
  
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Whitelist file JSON ammessi
const ALLOWED = new Set([
  'config.json',
  'bookings.json',
]);

// Risoluzione anti path-traversal
function resolveSafe(name) {
  if (!ALLOWED.has(name)) throw new Error(`Accesso non permesso a ${name}`);
  const p = path.join(DATA_DIR, name);
  const norm = path.normalize(p);
  if (!norm.startsWith(path.normalize(DATA_DIR + path.sep))) throw new Error('Path traversal');
  return norm;
}

// Lettura con limite dimensione e JSON robusto
export async function readJsonSafe(name, maxBytes = 1_000_000) {
  const p = resolveSafe(name);
  const fh = await fsp.open(p, 'r');
  try {
    const st = await fh.stat();
    if (st.size > maxBytes) throw new Error(`File troppo grande: ${st.size} > ${maxBytes}`);
    const buf = Buffer.allocUnsafe(st.size);
    await fh.read(buf, 0, st.size, 0);
    const txt = buf.toString('utf8');
    const obj = JSON.parse(txt);
    if (obj === null || typeof obj !== 'object') throw new Error('JSON non-obj');
    return obj;
  } finally {
    await fh.close();
  }
}

// Scrittura atomica + backup rotazione (max 3)
export async function writeJsonSafe(name, obj) {
  const p = resolveSafe(name);
  const txt = JSON.stringify(obj, null, 2);
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });

  // backup precedente (se esiste)
  if (fs.existsSync(p)) {
    for (let i = 2; i >= 0; i--) {
      const src = i === 0 ? p : `${p}.bak${i}`;
      const dst = `${p}.bak${i + 1}`;
      if (fs.existsSync(src)) {
        try { await fsp.copyFile(src, dst); } catch {}
      }
    }
  }

  // scrittura atomica
  const tmp = `${p}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, txt, 'utf8');
  await fsp.rename(tmp, p);
  return p;
}

// ====== HARDENING: env sanity + NODE_OPTIONS neutro in SEA/pkg ======
if (process.env.NODE_OPTIONS) {
  log('warn', 'NODE_OPTIONS presente: sarà ignorato per sicurezza');
  delete process.env.NODE_OPTIONS;
}

const required = ['SESSION_PATH', 'CALENDAR_ID', 'LICENSE_PASSPHRASE'];
const missing = required.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  missing.forEach((k) => console.error(`❌ Manca env ${k}`));
  process.exit(1);
}

// ====== licenza ======
async function ensureLicense() {
  if (process.env.LICENSE_PUBLIC_KEY_PEM && process.env.LICENSE_PUBLIC_KEY_FILE) {
    console.warn('[license] LICENSE_PUBLIC_KEY_PEM e FILE sono entrambi settati: userò PEM inline.');
  }

  const normalizeLicenseText = (s) =>
    String(s).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() + '\n';

  // 1) Prova store interno (se già salvata)
  try {
    await loadAndVerifyLicense();
    log('info', 'Licenza valida (stored)');
    return;
  } catch (e) {
    log('warn', 'Licenza assente/invalida', e?.message || e);
  }

  // 2) Env: LICENSE_TEXT (preferito) oppure LICENSE_FILE
  const envTxt  = (process.env.LICENSE_TEXT || process.env.LICENSE_CODE || '').trim();
  const envFile = (process.env.LICENSE_FILE || '').trim();

  if (envTxt && envFile) {
    console.warn('[license] LICENSE_TEXT e LICENSE_FILE sono entrambi settati: userò LICENSE_TEXT e ignorerò il file.');
  }

  if (envTxt) {
    try {
      const txt = normalizeLicenseText(envTxt);
      await verifyLicenseText(txt);
      await storeLicense(txt);
      log('info', 'Licenza salvata (da LICENSE_TEXT/CODE)');
      return;
    } catch (e) {
      log('error', 'LICENSE_TEXT/CODE non valida', e?.message || e);
    }
  }

  if (envFile && fs.existsSync(envFile)) {
    try {
      const txt = normalizeLicenseText(fs.readFileSync(envFile, 'utf8'));
      await verifyLicenseText(txt);
      await storeLicense(txt);
      log('info', `Licenza importata da file (${envFile})`);
      return;
    } catch (e) {
      log('error', 'LICENSE_FILE non valida', e?.message || e);
    }
  }

  // 3) Ricerca automatica vicino all'eseguibile / progetto
  try {
    const execDir = path.dirname(process.execPath);
    const cand = [];

    const pushIf = (p) => { try { if (fs.existsSync(p)) cand.push(p); } catch {} };
    const collectPattern = (dir) => {
      try {
        const names = fs.readdirSync(dir);
        for (const n of names) {
          if (n.toLowerCase().endsWith('.license.txt')) cand.push(path.join(dir, n));
        }
      } catch {}
    };

    pushIf(path.join(execDir, 'license.txt'));
    collectPattern(execDir);
    collectPattern(path.join(execDir, 'licenses'));
    collectPattern(path.join(process.cwd(), 'licenses'));

    if (cand.length) {
      cand.sort((a, b) => {
        const sa = (fs.statSync(a).mtimeMs || 0);
        const sb = (fs.statSync(b).mtimeMs || 0);
        return sb - sa;
      });

      for (const file of cand) {
        try {
          const txt = normalizeLicenseText(fs.readFileSync(file, 'utf8'));
          await verifyLicenseText(txt);
          await storeLicense(txt);
          log('info', `Licenza importata da file vicino all'exe (${file})`);
          return;
        } catch (e) {
          log('warn', `File licenza scartato: ${file}`, e?.message || e);
        }
      }
    }
  } catch (e) {
    log('warn', 'Ricerca licenza vicino all\'exe fallita', e?.message || e);
  }

  // 4) Prompt TTY (fallback)
  if (process.stdin.isTTY) {
    try {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      log('info', 'Incolla le due righe della licenza (nuovo formato).');
      const lic = (await rl.question('Riga LIC=: ')).trim();
      const sig = (await rl.question('Riga SIG=: ')).trim();
      rl.close();

      const txt = normalizeLicenseText(`LIC=${lic}\nSIG=${sig}\n`);
      await verifyLicenseText(txt);
      await storeLicense(txt);
      log('info', 'Licenza salvata (da TTY)');
      return;
    } catch (e) {
      log('error', 'Licenza incollata non valida', e?.message || e);
    }
  }

  log('error', 'Licenza mancante: genera LIC/SIG col license-generator allineato alla tua public key.');
  process.exit(1);
}

// ====== Helper per IP locale ======
function getLocalIP() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {}
  return '192.168.1.X';
}

// ====== admin server (health/logs/status) con rate-limit + header di sicurezza ======
function startAdminServer(stateRef, actionsRef) {
  const app = express();

  // Body parser
  app.use(express.json({ limit: '50kb' }));

  // ✅ UNICO blocco CORS + Security Headers
  app.use((req, res, next) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // CORS (dashboard può girare da file://)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Rate limit (60 req/min per IP)
  const bucket = new Map();
  app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    const now = Date.now();
    const rec = bucket.get(ip) || { count: 0, ts: now };
    if (now - rec.ts > 60_000) { rec.count = 0; rec.ts = now; }
    rec.count++;
    bucket.set(ip, rec);
    if (rec.count > 60) return res.status(429).send('Too Many Requests');
    next();
  });

  // ✅ Logging per debug (puoi commentare dopo il test)
  app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} da ${ip}`);
    next();
  });

  // Endpoints
  app.get('/health', (_req, res) => {
    console.log('✅ /health chiamato');
    res.send('OK');
  });

  app.get('/status', (_req, res) => {
    console.log('✅ /status chiamato:', { online: stateRef.online });
    res.json({ online: stateRef.online, lastError: stateRef.lastError });
  });

  app.get('/logs', (_req, res) => {
    res.type('text').send('logs not persisted in this minimal build');
  });

  // POST /api/send (invio WhatsApp)
  app.post('/api/send', async (req, res) => {
    try {
      const requiredToken = String(process.env.ADMIN_TOKEN || '');
      const gotToken = String(req.headers['x-admin-token'] || '');
      
      if (requiredToken && gotToken !== requiredToken) {
        console.warn('❌ /api/send: unauthorized (token mismatch)');
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      const to = String(req.body?.to || '').trim();
      const message = String(req.body?.message || req.body?.msg || '').trim();

      if (!to || !message) {
        console.warn('❌ /api/send: missing to or message');
        return res.status(400).json({ ok: false, error: 'missing_to_or_message' });
      }
      
      if (!/^\d{5,20}@c\.us$/i.test(to)) {
        console.warn(`❌ /api/send: invalid to format: ${to}`);
        return res.status(400).json({ ok: false, error: 'invalid_to_format' });
      }
      
      if (!actionsRef?.sendText) {
        console.warn('❌ /api/send: client not ready');
        return res.status(503).json({ ok: false, error: 'client_not_ready' });
      }
      
      if (message.length > 4000) {
        console.warn('❌ /api/send: message too long');
        return res.status(413).json({ ok: false, error: 'message_too_long' });
      }

      console.log(`📤 Invio a ${to}: ${message.slice(0, 50)}${message.length > 50 ? '...' : ''}`);
      await actionsRef.sendText(to, message);
      console.log(`✅ Messaggio inviato a ${to}`);
      return res.json({ ok: true });
      
    } catch (e) {
      console.error('❌ /api/send error:', e);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  const port = (() => {
    const v = Number(process.env.ADMIN_PORT || 3000);
    return Number.isFinite(v) && v >= 1024 && v <= 65535 ? v : 3000;
  })();

  // ✅ Ascolta su 0.0.0.0 (tutte le interfacce)
  app.listen(port, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Admin HTTP Server ATTIVO`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📍 Porta: ${port}`);
    console.log(`🌐 Da questo PC:    http://127.0.0.1:${port}/health`);
    console.log(`📱 Da telefono:     http://${getLocalIP()}:${port}/health`);
    console.log(`${'='.repeat(60)}\n`);
  });
}

// ====== main ======
async function main() {
  await ensureLicense();
  await warmOllama();

  const status = { online: false, lastError: null };
  const actions = { sendText: null };
  startAdminServer(status, actions);

  // Hardening: Chrome path e argomenti safe
  const defaultChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  let chromePath = (process.env.CHROME_PATH || defaultChrome).trim();
  if (!fs.existsSync(chromePath)) {
    log('warn', 'CHROME_PATH non trovato, fallback a default');
    chromePath = defaultChrome;
  }

  async function launchClient(headlessFlag = true) {
    return create({
      sessionId: 'whatsapp-ai',
      sessionDataPath: process.env.SESSION_PATH,
      multiDevice: true,
      useChrome: true,
      executablePath: chromePath,
      headless: headlessFlag,
      cacheEnabled: false,
      autoRefresh: true,
      qrTimeout: Number(process.env.QR_TIMEOUT_MS) || 0,
      authTimeout: Number(process.env.AUTH_TIMEOUT_MS) || 0,
      killClientOnLogout: true,
      chromiumArgs: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,AutomationControlled,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });
  }

  let client;
  try {
    client = await launchClient(false);
  } catch (e1) {
    log('warn', 'Launch headful fallito, riprovo headless=new', e1?.message || e1);
    try {
      client = await launchClient('new');
    } catch (e2) {
      log('error', 'Launch headless fallito', e2?.message || e2);
      throw e2;
    }
  }

  // Tick reminder 24h (ogni minuto)
  setInterval(() => {
    remind24hTick((to, msg) => client.sendText(to, msg), { graceMinutes: 10, batchLimit: 200 })
      .catch(err => console.warn("remind24hTick error:", err));
  }, 60_000);

  // Uncaught exception handler
  process.on('uncaughtException', (err) => {
    console.error('💥 CRASH:', err);
    process.exit(1);
  });

  actions.sendText = (to, msg) => client.sendText(to, msg);
  status.online = true;
  
  debugDataDir();
  log('info', 'WhatsApp pronto per ricevere e rispondere a messaggi!');

  client.onStateChanged((s) => {
    log('warn', `WA state: ${s}`);
    if (s === 'CONFLICT' || s === 'UNLAUNCHED' || s === 'UNPAIRED') {
      try { client.forceRefocus?.(); } catch {}
    }
  });

  // === REVIEW LOOP (ogni 30 min) ===
  startReviewFollowupsLoop(client, {
    intervalMinutes: 30,
    lookbackDays: 3,
    minAfterEndMinutes: 15,
    batchLimit: 20,
    alignToHalfHour: true,
  });

  // === CONFIRM CRON (promemoria conferma pre-appuntamento) ===
  const confirmOpts = {
    leadMinutes: (process.env.CONFIRM_LEAD_MINUTES ? Number(process.env.CONFIRM_LEAD_MINUTES) : 180),
    windowMinutes: 15,
    batchLimit: 50
  };
  
  try { 
    await confirmAppointmentsTick(safeSend, confirmOpts); 
  } catch (err) { 
    log('warn', '[confirmAppointmentsTick] primo giro fallito', err?.message || err); 
  }
  
  setInterval(() => {
    confirmAppointmentsTick(safeSend, confirmOpts)
      .catch(err => log('warn', '[confirmAppointmentsTick] errore', err?.message || err));
  }, 15 * 60 * 1000);

  // ====== ROUTER MESSAGGI MINIMALE ======
  client.onMessage(async (msg) => {
    try {
      if (!msg || msg.isGroupMsg || msg.fromMe) return;
      const chatId = msg.from;
      const text = (msg.body || msg.caption || '').trim();
      if (!text) return;

      if (/^\s*(annulla|reset|stop|ricomincia)\s*$/i.test(text)) {
        resetState(chatId);
        await safeSend(client, chatId, 'Ho annullato tutto, aspetto i tuoi ordini! 🌺');
        return;
      }

      await handleMessage(client, chatId, text);
    } catch (e) {
      status.lastError = e?.message || String(e);
      log('error', 'onMessage error', status.lastError);
      try { await safeSend(client, msg.from, 'Errore temporaneo. Riprova.'); } catch {}
    }
  });

  const bye = async () => {
    log('info', 'Chiusura…');
    try { await client?.kill?.(); } catch {}
    process.exit(0);
  };
  
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error('❌ Avvio fallito', e?.message || e);
  process.exit(1);
});