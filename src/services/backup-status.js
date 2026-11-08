import fs from 'node:fs';
import path from 'node:path';

// Cheap metadata only, not a restore/integrity certification. Temporary files
// are excluded; the backup producer publishes the final .dump atomically.
export function readBackupStatus({directory = process.env.BACKUP_DIR || '/app/runtime/backups', now = Date.now(), staleAfterMs = 36 * 3600000} = {}) {
  const result = {status:'missing',lastAt:null,integrityVerified:false,restoreVerified:false};
  try {
    const folder = fs.lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return {...result,status:'unavailable'};
    const files = fs.readdirSync(directory).filter(name => /^synk-\d{8}-\d{6}\.dump$/.test(name)).slice(0,500)
      .map(name => ({name,info:fs.lstatSync(path.join(directory,name))}))
      .filter(file => file.info.isFile() && !file.info.isSymbolicLink()).sort((a,b) => b.info.mtimeMs - a.info.mtimeMs);
    if (!files.length) return result;
    const latest = files[0];
    if (!Number.isFinite(latest.info.mtimeMs) || latest.info.mtimeMs > now || latest.info.size < 16) return {...result,status:'invalid'};
    const handle = fs.openSync(path.join(directory,latest.name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const header = Buffer.alloc(5);
    try { fs.readSync(handle,header,0,5,0); } finally { fs.closeSync(handle); }
    if (header.toString('ascii') !== 'PGDMP') return {...result,status:'invalid'};
    return {...result,status:now - latest.info.mtimeMs > staleAfterMs ? 'stale' : 'recent',lastAt:new Date(latest.info.mtimeMs).toISOString()};
  } catch (error) { return {...result,status:error.code === 'ENOENT' ? 'missing' : 'unavailable'}; }
}
