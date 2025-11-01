// fs-json.js — ESM + ncc + Windows-safe
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = 'configs & dashboard';
const isPkg = !!process.pkg;

function resolveDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    process.env.CONFIG_DIR,
    path.resolve(process.cwd(), DEFAULT_DIR),
    isPkg ? path.join(path.dirname(process.execPath), DEFAULT_DIR) : null,
  ].filter(Boolean);

  for (const c of candidates) {
    try { fs.mkdirSync(c, { recursive: true }); return c; } catch {}
  }
  return process.cwd();
}

export const dataDir = resolveDataDir();
export const DATA_DIR = dataDir;              // alias richiesto
export function debugDataDir() { return DATA_DIR; }

function safeName(name) {
  const s = String(name)
    .replace(/[\0<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s.toLowerCase().endsWith('.json') ? s : `${s}.json`;
}

function fpath(name) {
  const file = path.join(DATA_DIR, safeName(name));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export function readJSON(name, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(fpath(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[readJSON] ${name}: ${e.message}`);
    return fallback;
  }
}

export function writeJSON(name, obj) {
  const file = fpath(name);
  const tmp  = `${file}.tmp`;
  const txt  = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, txt, 'utf8');
    fs.renameSync(tmp, file); // atomico
  } catch (e) {
    try { fs.writeFileSync(file, txt, 'utf8'); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function initJSON(name, def = {}) {
  const file = fpath(name);
  if (!fs.existsSync(file)) writeJSON(name, def);
  return file;
}

export function ensureFile(name, def = {}) { return initJSON(name, def); }

export default { DATA_DIR, dataDir: DATA_DIR, debugDataDir, readJSON, writeJSON, initJSON, ensureFile };
