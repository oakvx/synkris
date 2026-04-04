// license-generator.cjs (CommonJS, Windows-friendly)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [customer, plan, hwid, expiry = '2026-12-31T23:59:59Z', out = 'license.txt'] = process.argv.slice(2);
if (!customer || !plan || !hwid) {
  console.error('Uso: node license-generator.cjs "Cliente" Piano HWID [YYYY-MM-DDTHH:MM:SSZ] [out=license.txt]');
  process.exit(1);
}

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIV_PEM = path.join(KEYS_DIR, 'ed25519-private.pem');
const PUB_PEM  = path.join(KEYS_DIR, 'ed25519-public.pem');

if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });
if (!fs.existsSync(PRIV_PEM) || !fs.existsSync(PUB_PEM)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIV_PEM, privateKey.export({ type:'pkcs8', format:'pem' }));
  fs.writeFileSync(PUB_PEM,  publicKey.export({ type:'spki',  format:'pem'  }));
  console.log('[keys] generated:', PRIV_PEM, PUB_PEM);
}

const lic = { version:1, customer, plan, hwid, expiry, issuedAt:new Date().toISOString() };
const licBytes = Buffer.from(JSON.stringify(lic));
const priv = crypto.createPrivateKey(fs.readFileSync(PRIV_PEM, 'utf8'));
const sig  = crypto.sign(null, licBytes, priv);

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
fs.writeFileSync(out, `LIC=${b64u(licBytes)}\nSIG=${b64u(sig)}\n`, 'utf8');

console.log('[ok] scritto', out);
console.log('\n[PubKey]\n' + fs.readFileSync(PUB_PEM,'utf8'));
