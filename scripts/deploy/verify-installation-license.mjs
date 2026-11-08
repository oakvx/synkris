// Isolated process: the doctor must use the production verifier without
// mutating its own environment or inheriting development HWID bypass flags.
import fs from 'node:fs';
import {verifyLicenseText} from '../../src/licensing/license-verifier.js';
try {
  if (process.env.NODE_ENV !== 'production' || process.env.LICENSE_DISABLE_HWID_CHECK !== '0' || !process.env.APP_HWID) throw new Error('production_verification_required');
  for (const [file, max] of [[process.env.LICENSE_FILE, 65536], [process.env.LICENSE_PUBLIC_KEY_FILE, 8192]]) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max || info.size === 0) throw new Error('license_file_invalid');
  }
  const {payload} = verifyLicenseText(fs.readFileSync(process.env.LICENSE_FILE, 'utf8'), {currentHwid:process.env.APP_HWID});
  const raw = payload.expiry ?? payload.expiryAt ?? payload.exp;
  const expires = Number.isFinite(+raw) ? +raw : Date.parse(raw);
  process.stdout.write(JSON.stringify({valid:true, inGrace:Date.now() > expires, expiresSoon:expires - Date.now() < 30 * 86400000}));
} catch {
  process.stdout.write(JSON.stringify({valid:false}));
  process.exitCode = 1;
}
