// license-utils.js — ESM, utilità per nuovo formato licenze (Node >= 18)
// - Trova la licenza in posti sensati (cwd + data dir)
// - Calcola lo stesso HWID locale usato dalle installazioni esistenti
// - Verifica col file license-verifier.js
// - Salva in nome: "Cliente-HWID-Piano.txt" se possibile

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as verifier from './license-verifier.js';
import { resolveLicenseDir } from '../storage/data-paths.js';

export async function verifyLicenseText(txt, opts = {}) {
  const clean = String(txt).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() + '\n';
  const currentHwid = getEnvDisableHwid() ? null : getCurrentHWID();
  return verifier.verifyLicenseText(clean, { currentHwid, ...opts });
}
export const parseLicenseText = verifier.parseLicenseText;
export const getPublicKeyPem = verifier.getPublicKeyPem;


// === Data dir (stessa logica che usi in app) ===
export const DATA_DIR = resolveLicenseDir();

// === HWID come nel generator ===
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function getCurrentHWID() {
  const configured = process.env.HWID || process.env.APP_HWID;
  if (configured) return configured;
  const user = (() => { try { return os.userInfo().username; } catch { return 'nouser'; } })();
  const raw = [os.hostname(), os.platform(), os.arch(), user].join('|');
  const h = b64u(awaitSha256(raw));
  return 'HW-' + h.slice(0, 32);
}

function awaitSha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}


// === Ricerca file licenza ===
const CANDIDATE_NAMES = [
  'license.txt',                             // legacy
  // pattern nuovi: Cliente-HWID-Piano.txt — cerchiamo *.txt e filtriamo dopo
];

function looksLikeLicenseText(txt) {
  return /(^|\n)\s*LIC=/.test(txt) && /(^|\n)\s*SIG=/.test(txt);
}

async function findLicensePaths() {
  const out = new Set();

  // 1) file noti in CWD
  for (const n of CANDIDATE_NAMES) {
    const p = path.join(process.cwd(), n);
    if (fs.existsSync(p)) out.add(p);
  }

  // 2) file noti in DATA_DIR
  for (const n of CANDIDATE_NAMES) {
    const p = path.join(DATA_DIR, n);
    if (fs.existsSync(p)) out.add(p);
  }

  // 3) tutti i .txt in CWD e DATA_DIR: prendi quelli che contengono LIC=/SIG=
  for (const dir of [process.cwd(), DATA_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (!/\.txt$/i.test(f)) continue;
        const p = path.join(dir, f);
        try {
          const txt = fs.readFileSync(p, 'utf8');
          if (looksLikeLicenseText(txt)) out.add(p);
        } catch { }
      }
    } catch { }
  }

  return Array.from(out);
}

export async function loadAndVerifyLicense() {
  const paths = await findLicensePaths();
  if (!paths.length) throw new Error(`Nessuna licenza trovata in ${process.cwd()} o ${DATA_DIR}`);

  // Preferisci license.txt, poi file più recente
  paths.sort((a, b) => {
    if (path.basename(a).toLowerCase() === 'license.txt') return -1;
    if (path.basename(b).toLowerCase() === 'license.txt') return 1;
    try {
      const sa = fs.statSync(a).mtimeMs || 0;
      const sb = fs.statSync(b).mtimeMs || 0;
      return sb - sa;
    } catch { return 0; }
  });
  let lastError;
  for (const file of paths) {
    try {
      const txt = await fsp.readFile(file, 'utf8');
      const { payload } = await verifyLicenseText(txt);
      return { payload, file };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function getEnvDisableHwid() {
  return process.env.NODE_ENV !== 'production' && process.env.LICENSE_DISABLE_HWID_CHECK === '1';
}

// === Salvataggio licenza ===
// Accetta: contenuto testuale a due righe (LIC= / SIG=) oppure oggetto { LIC, SIG } o singola riga
export async function storeLicense(input) {
  let txt;
  if (typeof input === 'string') {
    if (!looksLikeLicenseText(input)) {
      // se è una riga singola, provo a capire… (non supportiamo vecchi formati)
      throw new Error('Contenuto licenza non riconosciuto (attese righe LIC= e SIG=)');
    }
    txt = input.trim() + '\n';
  } else if (input && typeof input === 'object') {
    const lic = input.LIC || input.lic || '';
    const sig = input.SIG || input.sig || '';
    if (!lic || !sig) throw new Error('Oggetto licenza mancante di LIC/SIG');
    txt = `LIC=${lic}\nSIG=${sig}\n`;
  } else {
    throw new Error('Input licenza non valido');
  }
  await verifyLicenseText(txt);

  // Prova a decodificare LIC per ricavare customer/hwid/plan e creare il nome file corretto
  let outFile = path.join(DATA_DIR, 'license.txt'); // fallback
  try {
    const { licB64 } = (function parse(txt) {
      const lines = String(txt).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const map = new Map();
      for (const line of lines) {
        const m = /^([A-Z]{3})=(.+)$/.exec(line);
        if (m) map.set(m[1], m[2]);
      }
      return { licB64: map.get('LIC'), sigB64: map.get('SIG') };
    })(txt);
    const licJson = Buffer.from(licB64.replace(/-/g, '+').replace(/_/g, '/') + (licB64.length % 4 === 2 ? '==' : licB64.length % 4 === 3 ? '=' : ''), 'base64').toString('utf8');
    const obj = JSON.parse(licJson);
    const customer = sanitize(obj.customer || 'Cliente');
    const hwid = sanitize(obj.hwid || 'HW');
    const plan = sanitize(obj.plan || 'Plan');
    outFile = path.join(DATA_DIR, `${customer}-${hwid}-${plan}.txt`);
  } catch {
    // ignora, usa fallback
  }

  await fsp.mkdir(path.dirname(outFile), { recursive: true, mode: 0o700 });
  await fsp.writeFile(outFile, txt, { encoding: 'utf8', mode: 0o600 });
  return outFile;
}

function sanitize(s) { return String(s).replace(/[^\w.-]+/g, '_'); }
