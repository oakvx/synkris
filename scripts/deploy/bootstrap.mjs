import 'dotenv/config';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyLicenseText } from '../../src/licensing/license-utils.js';
import { assertSalonConfig } from '../../src/services/setup-validation.js';

const dataDir = process.env.APP_DATA_DIR || './runtime/config';
const source = '/app/bootstrap/config.json';
const destination = join(dataDir, 'config.json');
const marker = join(dataDir, '.synkris-bootstrap-ok');

function assertConfiguration() {
  for (const key of ['APP_HWID', 'CALENDAR_ID', 'ADMIN_TOKEN', 'DATABASE_URL', 'LICENSE_FILE', 'LICENSE_PUBLIC_KEY_FILE']) {
    if (!process.env[key]?.trim()) throw new Error(`Configurazione necessaria: ${key}`);
  }
  if (process.env.ADMIN_TOKEN.length < 32) throw new Error('ADMIN_TOKEN troppo corto');
  if (process.env.LICENSE_DISABLE_HWID_CHECK === '1') throw new Error('Disattivazione HWID non consentita in produzione');
  for (const file of [process.env.LICENSE_FILE, process.env.LICENSE_PUBLIC_KEY_FILE, process.env.GOOGLE_APPLICATION_CREDENTIALS]) {
    if (!file || !existsSync(file)) throw new Error(`File richiesto non trovato: ${file || '(non configurato)'}`);
  }
}
function checkConfig(location) {
  return assertSalonConfig(JSON.parse(readFileSync(location, 'utf8').replace(/^\uFEFF/, '')));
}

function run(script) {
  execFileSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
}

async function main() {
  assertConfiguration();
  await verifyLicenseText(readFileSync(process.env.LICENSE_FILE, 'utf8'));
  // Reject invalid initial setup before any schema or data change. An existing
  // deployment keeps its database-managed catalog, not a stale setup template.
  if (!existsSync(marker)) {
    if (!existsSync(source) && !existsSync(destination)) throw new Error('Crea setup/config.json prima del deploy');
    checkConfig(existsSync(destination) ? destination : source);
  }
  // Lo schema viene aggiornato ad OGNI deploy. Il marker limita solo l'import iniziale.
  // Se emergono conflitti esistenti, il deploy fallisce senza cancellare appuntamenti.
  run('scripts/db/init.mjs');
  if (existsSync(marker)) { console.log('[bootstrap] Schema verificato, configurazione gia importata'); return; }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  run('scripts/db/migrate-json-to-pg.mjs');
  writeFileSync(marker, new Date().toISOString() + '\n', { mode: 0o600 });
  console.log('[bootstrap] Schema e configurazione pronti');
}
main().catch(error => { console.error('[bootstrap]', error.message); process.exitCode = 1; });
