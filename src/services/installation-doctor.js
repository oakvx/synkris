import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
import {validateSalonConfig} from './setup-validation.js';

function smallFile(file, maximum = 1024 * 1024) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new Error('file_invalid');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
function productionLicense(env, files) {
  const worker = fileURLToPath(new URL('../../scripts/deploy/verify-installation-license.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [worker], {encoding:'utf8', timeout:5000, maxBuffer:8192,
    env:{...process.env, NODE_ENV:'production', NODE_OPTIONS:'', LICENSE_DEBUG:'0', LICENSE_DISABLE_HWID_CHECK:'0',
      LICENSE_PUBLIC_KEY_PEM:'', HWID:'', APP_HWID:env.APP_HWID || '',
      LICENSE_PUBLIC_KEY_FILE:files.key, LICENSE_FILE:files.license}});
  try {
    const value = JSON.parse(result.stdout);
    return result.status === 0 && value.valid === true ? value : {valid:false};
  } catch { return {valid:false}; }
}

// Read-only and deliberately offline: no DB, browser, HTTP, SMTP or cloud calls.
// Submitted configuration values are never copied into the returned report.
export function inspectInstallation({root = process.cwd(), container = false, env:providedEnv, now = Date.now()} = {}) {
  const checks = [];
  const add = (id, status, label, help) => checks.push({id, status, label, help});
  const files = container ? {
    config:'/app/bootstrap/config.json', marker:path.join(providedEnv?.APP_DATA_DIR || process.env.APP_DATA_DIR || '/app/runtime/config', '.synkris-bootstrap-ok'),
    license:providedEnv?.LICENSE_FILE || process.env.LICENSE_FILE || '/run/secrets/license.txt',
    key:providedEnv?.LICENSE_PUBLIC_KEY_FILE || process.env.LICENSE_PUBLIC_KEY_FILE || '/run/secrets/license-public.pem',
    google:providedEnv?.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || '/run/secrets/google-service-account.json',
  } : {config:path.join(root,'setup/config.json'), marker:path.join(root,'runtime/config/.synkris-bootstrap-ok'),
    license:path.join(root,'secrets/license.txt'), key:path.join(root,'secrets/license-public.pem'), google:path.join(root,'secrets/google-service-account.json')};
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
  const hwidOk = typeof env.APP_HWID === 'string' && /^[A-Za-z0-9_-]{3,160}$/.test(env.APP_HWID) && !/^HWID_ASSOCIATO/i.test(env.APP_HWID);
  add('hwid', hwidOk ? 'pass' : 'fail', 'Attivazione installazione', hwidOk ? 'Identificativo presente; deve corrispondere alla licenza firmata.' : 'Inserisci l\'identificativo fornito con la tua attivazione. Non viene generata una licenza.');
  const bypass = env.LICENSE_DISABLE_HWID_CHECK === '1' || Boolean(env.HWID && env.HWID !== env.APP_HWID) || Boolean(env.LICENSE_PUBLIC_KEY_PEM);
  add('activation_policy', bypass ? 'fail' : 'pass', 'Protezioni attivazione', bypass ? 'Rimuovi bypass, HWID alternativi o chiavi inline dal deploy guidato.' : 'Nessuna scorciatoia di attivazione configurata.');
  let publicKeyOk = false;
  try {
    const pem = smallFile(files.key,8192).trim();
    publicKeyOk = pem.startsWith('-----BEGIN PUBLIC KEY-----') && crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch { /* redacted below */ }
  add('license_key', publicKeyOk ? 'pass' : 'fail', 'Chiave pubblica licenza', publicKeyOk ? 'Chiave pubblica Ed25519 leggibile.' : 'Importa la chiave pubblica fornita dal titolare. Non importare una chiave privata.');
  let license = {valid:false};
  if (hwidOk && publicKeyOk && !bypass) license = productionLicense(env, files);
  add('license', license.valid ? (license.inGrace || license.expiresSoon ? 'warn' : 'pass') : 'fail', 'Licenza firmata',
    !license.valid ? 'Verifica file, firma, scadenza e corrispondenza HWID con il titolare.' : license.inGrace ? 'Licenza nel periodo di tolleranza: richiedi il rinnovo prima di proseguire con l\'uso operativo.' : license.expiresSoon ? 'Verifica completata; organizza il rinnovo della licenza in scadenza.' : 'Firma, scadenza e HWID verificati dal verificatore di produzione.');
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
