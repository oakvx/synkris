// dist/bootstrap.cjs — SEA bootstrap (Node 22)
// - Forza CWD in baseDir
// - Crea package.json minimale (per libs che lo cercano)
// - Punta APP_DATA_DIR a "configs & dashboard" (esterna)
// - Lock anti doppia istanza

const fs = require('fs');
const path = require('path');
const os = require('os');

process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));
process.on('uncaughtException', e => { console.error('[FATAL]', e?.stack||e); process.exit(1); });

const exeDir = path.dirname(process.execPath);
const PORTABLE = fs.existsSync(path.join(exeDir, 'portable.flag'));
const APP_NAME = 'whatsapp-ai';

// baseDir: dove vivono dati e package.json “minimo”
const baseDir = PORTABLE
  ? exeDir
  : path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'), APP_NAME);

try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
try { process.chdir(baseDir); } catch {} // CWD fissato

// package.json minimo (per @open-wa/wa-automate & co)
const pkgPath = path.join(baseDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fs.writeFileSync(pkgPath, JSON.stringify({ name: APP_NAME, version: "1.0.0", private: true }, null, 2));
}

// cartella JSON esterni
const DATA_DIR = path.join(baseDir, 'configs & dashboard');
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.APP_DATA_DIR = DATA_DIR;

// lock file: evita doppie istanze
const lockPath = path.join(baseDir, 'app.lock');
let lockFd;
try { lockFd = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lockFd, String(process.pid)); }
catch { console.error('[LOCK] Un’altra istanza sembra attiva.'); process.exit(10); }
function cleanup(){ try{ if(lockFd){ fs.closeSync(lockFd); fs.unlinkSync(lockPath); } }catch{} }
process.on('exit', cleanup); process.on('SIGINT',()=>{cleanup();process.exit(0)}); process.on('SIGTERM',()=>{cleanup();process.exit(0)});

// avvia il tuo bundle
require('./app.cjs');
