import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir} from '../storage/data-paths.js';

function requireSettings(env) {
  const missing = ['DATABASE_URL','CALENDAR_ID','ADMIN_TOKEN'].filter(key => !env[key]?.trim());
  if (missing.length) throw new Error('Configurazione mancante: ' + missing.join(', '));
  if (env.ADMIN_TOKEN.trim().length < 32) throw new Error('ADMIN_TOKEN deve contenere almeno 32 caratteri');
}

export function validateRuntimeEnvironment({env = process.env, exists = fs.existsSync} = {}) {
  requireSettings(env);
  if (!env.GOOGLE_CREDENTIALS_JSON && !env.GOOGLE_CREDENTIALS_B64 && !env.GOOGLE_APPLICATION_CREDENTIALS &&
      !exists(path.join(resolveDataDir(env),'google-credentials.json'))) {
    throw new Error('Configurazione mancante: credenziali Google Service Account');
  }
}

export function validateBootstrapEnvironment({env = process.env, exists = fs.existsSync} = {}) {
  requireSettings(env);
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file || !exists(file)) throw new Error('File credenziali Google richiesto non trovato');
}
