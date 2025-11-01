// wa-from-disk.js — carica @open-wa/wa-automate dal filesystem (compatibile con Node SEA)
import { createRequire } from 'node:module';
const requireFromDisk = createRequire(process.execPath + (process.platform === 'win32' ? '\\noop.js' : '/noop.js'));
const mod = requireFromDisk('@open-wa/wa-automate');
const create = mod?.create || mod?.default?.create || mod?.default || mod;
if (typeof create !== 'function') {
  throw new Error('wa-from-disk: non trovo create() in @open-wa/wa-automate');
}
export { create };
export default { create };
