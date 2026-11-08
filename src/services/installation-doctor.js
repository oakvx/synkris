import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parse} from 'dotenv';
import {validateSalonConfig} from './setup-validation.js';

function smallFile(file, maximum = 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new Error('file_invalid');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
// Read-only and deliberately offline: no DB, browser, HTTP, SMTP or cloud calls.
// Submitted configuration values are never copied into the returned report.
export function inspectInstallation({root = process.cwd(), container = false, env:providedEnv, now = Date.now()} = {}) {
  const checks = [];
  const add = (id, status, label, help) => checks.push({id, status, label, help});
  const files = container ? {
    config:'/app/bootstrap/config.json', marker:path.join(providedEnv?.APP_DATA_DIR || process.env.APP_DATA_DIR || '/app/runtime/config', '.synkris-bootstrap-ok'),
    google:providedEnv?.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || '/run/secrets/google-service-account.json',
  } : {config:path.join(root,'setup/config.json'), marker:path.join(root,'runtime/config/.synkris-bootstrap-ok'),
    google:path.join(root,'secrets/google-service-account.json')};
  let env = providedEnv;
  if (!env) {
    if (container) env = process.env;
    else try { env = parse(smallFile(path.join(root,'.env'), 65536)); }
    catch { add('environment','fail','Configurazione privata','Esegui la configurazione guidata per creare un file .env valido.'); env = {}; }
  }
  for (const [key, minimum, label] of [['POSTGRES_PASSWORD',32,'Password database'],['ADMIN_TOKEN',32,'Token amministrativo'],['DASHBOARD_PASSWORD',12,'Password dashboard']]) {
    const value = env[key];
    const valid = typeof value === 'string' && value.length >= minimum && value.length <= 512 && !/^SOSTITUISCI/i.test(value) && !/[\x00-\x20\x7f]/.test(value) && (key !== 'POSTGRES_PASSWORD' || /^[A-Za-z0-9_-]+$/.test(value));
    add(key.toLowerCase(), valid ? 'pass' : 'fail', label, valid ? 'Valore configurato; non viene mostrato.' : 'Completa il configuratore. Non sostituire credenziali di un database gia inizializzato.');
  }
  const calendar = env.CALENDAR_ID;
  const calendarOk = typeof calendar === 'string' && calendar.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(calendar) && !/^calendario-del-salone@|@example\.(?:com|org|net)$/i.test(calendar);
  add('calendar_id', calendarOk ? 'pass' : 'fail', 'Calendario Google', calendarOk ? 'Identificativo presente. La condivisione va verificata online.' : 'Inserisci l\'ID del calendario reale, non il titolo o l\'URL della pagina.');
  try {
    const credentials = JSON.parse(smallFile(files.google,65536));
    if (credentials.type !== 'service_account' || typeof credentials.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(credentials.client_email) || typeof credentials.private_key !== 'string') throw new Error('credentials_invalid');
    if (credentials.token_uri !== undefined && credentials.token_uri !== 'https://oauth2.googleapis.com/token' && credentials.token_uri !== 'https://accounts.google.com/o/oauth2/token') throw new Error('credentials_invalid');
    const key = crypto.createPrivateKey(credentials.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('credentials_invalid');
    add('google_credentials','pass','Credenziali Google','Service account leggibile. Non sono stati richiesti token o contattati i server Google.');
  } catch { add('google_credentials','fail','Credenziali Google','Importa il JSON originale del service account con chiave RSA valida. Non incollarlo nei log.'); }
  try {
    const source = smallFile(files.config);
    if (fs.existsSync(files.marker)) add('salon_config','pass','Configurazione salone','Gia importata: team, trattamenti e orari si modificano dalla dashboard, non dal file iniziale.');
    else {
      const issues = validateSalonConfig(JSON.parse(source));
      add('salon_config', issues.length ? 'fail' : 'pass','Configurazione salone',issues.length ? issues.slice(0,6).map(issue => issue.field + ': ' + issue.message).join(' ') : 'Team, trattamenti, abilitazioni e orari iniziali validi.');
    }
  } catch { add('salon_config','fail','Configurazione salone','Completa la configurazione guidata: serve setup/config.json leggibile e valido.'); }
  add('live_acceptance','warn','Collaudo reale ancora necessario','Questi controlli offline non provano WhatsApp, condivisione Calendar, SMTP, installazione Windows o ripristino dei backup.');
  return {schema:1,scope:'offline',checkedAt:new Date(now).toISOString(),readyForBootstrap:checks.every(check => check.status !== 'fail'),productionReady:false,checks};
}
