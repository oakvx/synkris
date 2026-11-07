import fs from 'node:fs';
import crypto from 'node:crypto';

// ---- base64url <-> Buffer
function b64uToBuf(s) {
  const t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Buffer.from(t + pad, 'base64');
}

// ---- normalizza PEM (converte \\n in \n reali)
function normalizeKeyPem(pem) {
  if (!pem) return pem;
  const s = String(pem).trim();
  // Se contiene \\n letterali, sostituiscili con newline reali
  return s.includes('\\n') ? s.replace(/\\n/g, '\n') : s;
}

// ---- sorgente chiave pubblica (preferisci PEM inline da .env)
export function getPublicKeyPem() {
  const pem = (process.env.LICENSE_PUBLIC_KEY_PEM || '').trim();
  const file = (process.env.LICENSE_PUBLIC_KEY_FILE || '').trim();

  if (pem && file && fs.existsSync(file)) {
    console.warn('[license] LICENSE_PUBLIC_KEY_PEM e FILE sono entrambi settati: uso PEM inline.');
  }

  if (pem) return normalizeKeyPem(pem);
  if (file && fs.existsSync(file)) return normalizeKeyPem(fs.readFileSync(file, 'utf8'));

  throw new Error('Chiave pubblica non configurata');
}

// ---- parsing testo licenza (2 righe: LIC=..., SIG=...)
export function parseLicenseText(txt) {
  const clean = String(txt).replace(/^\uFEFF/, '').trim();
  const out = {};
  for (const line of clean.split(/\r?\n/)) {
    const m = /^(LIC|SIG)\s*[:=]\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  if (!out.LIC || !out.SIG) throw new Error('Formato licenza invalido: attese righe LIC= e SIG=');
  return { licB64: out.LIC, sigB64: out.SIG };
}

// ---- ordinamento deterministico per canonical JSON
function sortObj(o) {
  if (Array.isArray(o)) return o.map(sortObj);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map(k => [k, sortObj(o[k])]));
  return o;
}

// ---- verifica sui byte del JSON (consigliato)
export function verifyLicenseBytes(licBytes, sigBytes, { now = Date.now(), currentHwid = null, graceDays = 7 } = {}) {
  const pub = crypto.createPublicKey(getPublicKeyPem());

  // Firma Ed25519 sui BYTE del JSON
  const ok = crypto.verify(null, licBytes, pub, sigBytes);
  if (!ok) throw new Error('Firma Ed25519 non valida');

  // Parse payload
  let payload;
  try { payload = JSON.parse(licBytes.toString('utf8')); }
  catch { throw new Error('Payload LIC non è JSON valido'); }

  // Campi accettati (flessibili)
  const version = payload.version ?? payload.v ?? 1;
  const customer = payload.customer ?? payload.client;
  const plan = payload.plan;
  const hwid = payload.hwid;

  const expiryRaw = payload.expiry ?? payload.expiryAt ?? payload.exp;
  const issuedRaw = payload.issuedAt ?? payload.issueAt ?? payload.iat;
  const gDays = Number.isFinite(+payload.graceDays) ? +payload.graceDays : graceDays;

  if (version !== 1) throw new Error('Versione licenza non supportata');
  if (!customer || !plan || !hwid || !expiryRaw) throw new Error('Campi licenza mancanti');

  const expMs = Number.isFinite(+expiryRaw) ? +expiryRaw : Date.parse(expiryRaw);
  if (!Number.isFinite(expMs)) throw new Error('Campo expiry non valido');

  const hardDeadline = expMs + Math.max(0, gDays) * 24 * 60 * 60 * 1000;
  if (now > hardDeadline) throw new Error('Licenza scaduta');

  if (issuedRaw != null) {
    const issMs = Number.isFinite(+issuedRaw) ? +issuedRaw : Date.parse(issuedRaw);
    if (Number.isFinite(issMs) && issMs > now + 5 * 60 * 1000) {
      throw new Error('IssueAt nel futuro (clock di sistema errato?)');
    }
  }

  const skipHwid = process.env.NODE_ENV !== 'production' && process.env.LICENSE_DISABLE_HWID_CHECK === '1';
  const hostHwid = currentHwid || process.env.HWID || process.env.APP_HWID || null;
  if (!skipHwid && payload.hwid && (!hostHwid || payload.hwid !== hostHwid)) {
    throw new Error('HWID mismatch: licenza non valida per questo host');
  }

  return { ok: true, payload };
}

export function verifyLicenseText(txt, { now = Date.now(), currentHwid = null, graceDays = 7 } = {}) {
  const { licB64, sigB64 } = parseLicenseText(txt);
  const pub = crypto.createPublicKey(getPublicKeyPem());
  const licBytes = b64uToBuf(licB64);
  const sigBytes = b64uToBuf(sigB64);

  let ok = false, pathUsed = 'none', payload = null;

  // C) **TUO CASO**: firma sulla stringa base64url LIC
  ok = crypto.verify(null, Buffer.from(licB64, 'utf8'), pub, sigBytes);
  if (ok) pathUsed = 'RAW_BASE64_STRING';

  // A) byte JSON
  if (!ok) {
    ok = crypto.verify(null, licBytes, pub, sigBytes);
    if (ok) {
      pathUsed = 'JSON_BYTES';
      try { payload = JSON.parse(licBytes.toString('utf8')); } catch { }
    }
  }

  // B) JSON canonico
  if (!ok) {
    try {
      const obj = JSON.parse(licBytes.toString('utf8'));
      const canon = JSON.stringify(sortObj(obj));
      ok = crypto.verify(null, Buffer.from(canon, 'utf8'), pub, sigBytes);
      if (ok) { pathUsed = 'CANON_JSON'; payload = obj; }
    } catch { }
  }

  if (!ok) throw new Error('Firma Ed25519 non valida');
  if (!payload) {
    try { payload = JSON.parse(licBytes.toString('utf8')); }
    catch { throw new Error('Payload LIC non è JSON valido'); }
  }

  const version = payload.version ?? payload.v ?? 1;
  const customer = payload.customer ?? payload.client;
  const plan = payload.plan;
  const hwid = payload.hwid;
  const expiryRaw = payload.expiry ?? payload.expiryAt ?? payload.exp;
  const issuedRaw = payload.issuedAt ?? payload.issueAt ?? payload.iat;
  const gDays = Number.isFinite(+payload.graceDays) ? +payload.graceDays : graceDays;

  if (version !== 1) throw new Error('Versione licenza non supportata');
  if (!customer || !plan || !hwid || !expiryRaw) throw new Error('Campi licenza mancanti');

  const expMs = Number.isFinite(+expiryRaw) ? +expiryRaw : Date.parse(expiryRaw);
  if (!Number.isFinite(expMs)) throw new Error('Campo expiry non valido');

  const hardDeadline = expMs + Math.max(0, gDays) * 86400000;
  if (now > hardDeadline) throw new Error('Licenza scaduta');

  if (issuedRaw != null) {
    const issMs = Number.isFinite(+issuedRaw) ? +issuedRaw : Date.parse(issuedRaw);
    if (Number.isFinite(issMs) && issMs > now + 300000) throw new Error('IssueAt nel futuro (clock errato?)');
  }

  const skipHwid = process.env.NODE_ENV !== 'production' && process.env.LICENSE_DISABLE_HWID_CHECK === '1';
  const hostHwid = currentHwid || process.env.HWID || process.env.APP_HWID || null;
  if (!skipHwid && payload.hwid && (!hostHwid || payload.hwid !== hostHwid)) {
    throw new Error('HWID mismatch: licenza non valida per questo host');
  }

  if (process.env.LICENSE_DEBUG === '1') console.log('[license] verify path:', pathUsed);
  return { ok: true, payload };
}

// ---- verifica da file
export function verifyLicenseFile(filePath, opts = {}) {
  const txt = fs.readFileSync(filePath, 'utf8');
  return verifyLicenseText(txt, opts);
}

// ---- helper debug
export function decodeLicensePayloadText(txt) {
  const { licB64 } = parseLicenseText(txt);
  return JSON.parse(b64uToBuf(licB64).toString('utf8'));
}
