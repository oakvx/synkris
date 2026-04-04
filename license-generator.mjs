// license-generator.js (ESM)
// Uso:
//   node license-generator.js "Cliente XYZ" Premium HWID-DEL-CLIENTE 2026-12-31T23:59:59Z [out=license.txt]
// - Genera (se mancano) chiavi Ed25519 in ./keys/
// - Scrive license.txt con due righe: LIC=<base64url(JSON)> e SIG=<base64url(signature)>

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const KEYS_DIR   = path.join(__dirname, 'keys');
const PRIV_PEM   = path.join(KEYS_DIR, 'ed25519-private.pem');
const PUB_PEM    = path.join(KEYS_DIR, 'ed25519-public.pem');

function b64u(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

async function ensureKeys(){
  await fsp.mkdir(KEYS_DIR, { recursive: true });
  const hasPriv = await fsp.access(PRIV_PEM).then(()=>true).catch(()=>false);
  const hasPub  = await fsp.access(PUB_PEM ).then(()=>true).catch(()=>false);
  if (hasPriv && hasPub) return;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  await fsp.writeFile(PRIV_PEM, privateKey.export({ type:'pkcs8', format:'pem' }));
  await fsp.writeFile(PUB_PEM,  publicKey.export({ type:'spki',  format:'pem'  }));
  console.log('[keys] generated:', PRIV_PEM, PUB_PEM);
}

async function main(){
  const [customer, plan, hwid, expiry = '2026-12-31T23:59:59Z', out = 'license.txt'] = process.argv.slice(2);
  if (!customer || !plan || !hwid){
    console.error('Uso: node license-generator.js "Cliente" Piano HWID [YYYY-MM-DDTHH:MM:SSZ] [out=license.txt]');
    process.exit(1);
  }
  await ensureKeys();
  const priv = crypto.createPrivateKey(await fsp.readFile(PRIV_PEM, 'utf8'));
  const lic = {
    version: 1,
    customer, plan, hwid, expiry,
    issuedAt: new Date().toISOString()
  };
  const bytes = Buffer.from(JSON.stringify(lic));
  const sig   = crypto.sign(null, bytes, priv);
  const content = `LIC=${b64u(bytes)}\nSIG=${b64u(sig)}\n`;
  await fsp.writeFile(out, content, 'utf8');
  console.log('[ok] scritto', out);
  console.log('\n[PubKey da incollare nel loader/pkg e/o nel tuo codice]:\n');
  console.log(await fsp.readFile(PUB_PEM,'utf8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {main().catch(e => { console.error(e); process.exit(1); });

}
