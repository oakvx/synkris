import fs from 'node:fs';
import path from 'node:path';

export const releaseDirectories = ['src','dashboard','deploy','assets','strumenti','scripts'];
export const releaseFiles = [
  'package.json','package-lock.json','dashboard.php','bridge.php','Dockerfile','Dockerfile.dashboard','compose.yaml','.dockerignore','.env.example',
  'LEGGIMI.txt','LICENSE.md','deploy/THIRD_PARTY_NOTICES.md','SECURITY.md','COLLAUDO.md','RELEASE.md','CHANGELOG.md','REPORT_BUGFIX_RC4.md','REPORT_BUGFIX_RC5.md','REPORT_RICOSTRUZIONE_RC6.md',
  'AGGIORNA_SYNK_TECNICO.bat','APRI_SYNK.bat','ATTIVA_AI_LOCALE.bat','AVVIA_SYNK.bat','ESPORTA_BACKUP_CIFRATO_TECNICO.bat','INSTALLA_UNA_VOLTA.bat','RIATTIVA_CALENDAR_TECNICO.bat','RIPRISTINA_BACKUP.bat',
  'setup/config.example.json',
];
export const requiredFiles = [
  ...releaseFiles,'src/index.js','src/licensing/license-verifier.js','scripts/db/schema.sql','scripts/deploy/bootstrap.mjs',
  'dashboard.php','bridge.php','dashboard/view.html','dashboard/assets/app.js','dashboard/assets/app.css',
  ...['bootstrap','datetime','queries','mutations','router','calendar-outbox'].map(name=>'dashboard/api/'+name+'.php'),
  ...['apache.conf','session.php','license-guard.php'].map(name=>'deploy/'+name),
  ...['common','installa','configurazione','credenziali','ambiente','preflight','diagnostica','aggiorna','ripristina','riattiva-calendar','attiva-ai','esporta-backup'].map(name=>'strumenti/'+name+'.ps1'),
];
const sensitiveBasenames = new Set(['.env','config.json','bookings.json','chatdb.json','session.data.json','license.txt','google-service-account.json']);
export function isReleasePath(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(name)) return false;
  const segments = name.split('/');
  if (segments.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s))) return false;
  if (sensitiveBasenames.has(segments.at(-1).toLowerCase()) || /\.(pem|key|dump|zip|log)$/i.test(name)) return false;
  if (segments.some(s=>['node_modules','.git','runtime','secrets','.cache','artifacts','.wwebjs_auth','.wwebjs_cache'].includes(s.toLowerCase()))) return false;
  if (name.includes('/.env') || (segments.at(-1).startsWith('.') && name!=='.env.example' && name!=='.dockerignore')) return false;
  if (releaseFiles.includes(name)) return true;
  const extensions = {src:/\.(js|mjs|cjs)$/,dashboard:/\.(js|css|html|php)$/,deploy:/\.(conf|php)$/,assets:/\.(svg|png|jpg|jpeg|webp|woff2?)$/,strumenti:/\.ps1$/,scripts:/\.(js|mjs|cjs|sql)$/};
  return Boolean(extensions[segments[0]]?.test(name));
}
export function collectReleaseFiles(root) {
  const names = new Set(releaseFiles);
  function walk(relative) {
    const absolute = path.join(root,relative);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error('Symlink forbidden in release: '+relative);
    if (info.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) walk(relative+'/'+entry);
    } else {
      if (!info.isFile() || !isReleasePath(relative)) throw new Error('Forbidden release file: '+relative);
      if (info.size>20*1024*1024) throw new Error('Unexpected large release file: '+relative);
      names.add(relative);
    }
  }
  for (const dir of releaseDirectories) walk(dir);
  for (const name of names) {
    if (!isReleasePath(name)) throw new Error('Unsafe release path: '+name);
    const info=fs.lstatSync(path.join(root,name));
    if (!info.isFile()||info.isSymbolicLink()) throw new Error('Missing or unsafe file: '+name);
  }
  if (new Set([...names].map(name=>name.toLowerCase())).size !== names.size) throw new Error('Case-insensitive duplicate paths are not supported on Windows.');
  return [...names].sort();
}
