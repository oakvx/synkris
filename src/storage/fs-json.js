// fs-json.js — ESM + ncc + Windows-safe
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR as resolvedDataDir } from './data-paths.js';

export const dataDir = resolvedDataDir;
export const DATA_DIR = dataDir;              // alias richiesto
export function debugDataDir() { return DATA_DIR; }

function safeName(name) {
  const s = String(name).trim();
  if (!s || /[\\/\0<>:"|?*]/.test(s) || s === '.' || s === '..') {
    throw new Error('Invalid JSON filename');
  }
  return s.toLowerCase().endsWith('.json') ? s : `${s}.json`;
}

function fpath(name) {
  const file = path.join(DATA_DIR, safeName(name));
  return file;
}

export function readJSON(name, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(fpath(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return fallback;
  }
}

export function writeJSON(name, obj) {
  const file = fpath(name);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const txt = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, txt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file); // atomico
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
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
