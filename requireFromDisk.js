// utils/requireFromDisk.js (ESM o CJS, vale per entrambi)
async function requireFromDisk(id) {
  try {
    // CJS
    // eslint-disable-next-line no-undef
    const { createRequire } = require('module');
    return createRequire(process.execPath + '/noop.js')(id);
  } catch {
    // ESM
    const m = await import('module');
    return m.createRequire(process.execPath + '/noop.js')(id);
  }
}
module.exports = { requireFromDisk };
