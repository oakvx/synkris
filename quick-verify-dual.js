import fs from 'node:fs';
import crypto from 'node:crypto';

const b64u = s => Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/').padEnd((4 - s.length % 4) % 4 + s.length,'='), 'base64');
const pem = (process.env.LICENSE_PUBLIC_KEY_PEM?.trim())
  || (process.env.LICENSE_PUBLIC_KEY_FILE && fs.readFileSync(process.env.LICENSE_PUBLIC_KEY_FILE, 'utf8'));
if (!pem) { console.error('Manca LICENSE_PUBLIC_KEY_PEM/FILE'); process.exit(2); }
const pub = crypto.createPublicKey(pem);

const [,, LIC, SIG] = process.argv;
if (!LIC || !SIG) { console.error('Uso: node quick-verify-dual.js <LIC> <SIG>'); process.exit(2); }

const licBytes = b64u(LIC);
const sigBytes = b64u(SIG);

// percorso A: firma sui byte del JSON (consigliato)
const okJsonBytes = crypto.verify(null, licBytes, pub, sigBytes);

// percorso B: canonical JSON (chiavi ordinate)
let okCanon = false;
try {
  const obj = JSON.parse(licBytes.toString('utf8'));
  const canon = JSON.stringify(sort(obj));
  okCanon = crypto.verify(null, Buffer.from(canon,'utf8'), pub, sigBytes);
} catch {}

function sort(o){ if(Array.isArray(o)) return o.map(sort); if(o&&typeof o==='object') return Object.fromEntries(Object.keys(o).sort().map(k=>[k,sort(o[k])])); return o; }

// percorso C: (tolleranza) firma sulla stringa base64url letterale
const okRawBase64 = crypto.verify(null, Buffer.from(LIC,'utf8'), pub, sigBytes);

console.log({ okJsonBytes, okCanon, okRawBase64 });
process.exit((okJsonBytes || okCanon || okRawBase64) ? 0 : 1);
