import path from 'node:path';
import { resolveDataDir } from '../storage/data-paths.js';

function milliseconds(value, name, fallback = 0) {
  const ms = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647) throw new Error(`${name} non valido`);
  return ms;
}

/** Configuration only: no browser, credentials or network access at import time. */
export function whatsappOptions(env = process.env) {
  const executablePath = (env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || '').trim();
  const args = ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];
  if (env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const clientId = env.WHATSAPP_SESSION_ID || 'whatsapp-ai';
  if (!/^[-_a-z0-9]{1,64}$/i.test(clientId)) throw new Error('WHATSAPP_SESSION_ID non valido');
  // Never reuse/convert OpenWA session files. LocalAuth owns only this child directory.
  const dataPath = path.join(path.resolve(env.SESSION_PATH || path.join(resolveDataDir(env), 'session')), 'whatsapp-web.js');
  return {
    clientId,
    dataPath,
    qrTimeoutMs: milliseconds(env.QR_TIMEOUT_MS, 'QR_TIMEOUT_MS'),
    authTimeoutMs: milliseconds(env.AUTH_TIMEOUT_MS, 'AUTH_TIMEOUT_MS', 30_000),
    puppeteer: {
      ...(executablePath ? { executablePath } : {}),
      headless: env.CHROME_HEADLESS !== '0',
      args,
      // The application drains booking work before closing Chromium.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    },
    webVersionCache: { type: 'local', path: path.join(dataPath, 'web-cache'), strict: false },
    takeoverOnConflict: false,
    bypassCSP: false,
  };
}

/** whatsapp-web.js WAState.CONNECTED, gated separately on its native ready event. */
export function isWhatsAppConnectedState(state) { return state === 'CONNECTED'; }

/** destroy closes Chromium; logout would erase LocalAuth and require another QR. */
export async function stopWhatsAppClient(client) {
  if (typeof client?.destroy === 'function') return await client.destroy();
}
