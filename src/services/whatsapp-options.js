import path from 'node:path';
import { resolveDataDir } from '../storage/data-paths.js';

function timeoutSeconds(value, name) {
  const ms = value ? Number(value) : 0;
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} non valido`);
  return ms / 1000;
}

export function whatsappOptions(env = process.env) {
  const executablePath = (env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || '').trim();
  const chromiumArgs = ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];
  const noSandbox = env.CHROME_NO_SANDBOX === '1';
  if (noSandbox) chromiumArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  return {
    sessionId: env.WHATSAPP_SESSION_ID || 'whatsapp-ai',
    sessionDataPath: path.resolve(env.SESSION_PATH || path.join(resolveDataDir(env), 'session-v5')),
    ...(executablePath ? { executablePath } : {}),
    headless: env.CHROME_HEADLESS !== '0',
    qrTimeout: timeoutSeconds(env.QR_TIMEOUT_MS, 'QR_TIMEOUT_MS'),
    authTimeout: timeoutSeconds(env.AUTH_TIMEOUT_MS, 'AUTH_TIMEOUT_MS'),
    chromiumArgs,
    // OpenWA v4 merges unsafe historical defaults (including TLS/sandbox bypasses)
    // into chromiumArgs. Puppeteer's explicit args override that merged list.
    args: [...chromiumArgs],
    multiDevice: true,
    qrLogSkip: true,
    popup: false,
    disableSpins: true,
    logFile: false,
    logConsoleErrors: false,
    killProcessOnBrowserClose: false,
    killProcessOnTimeout: false,
    allowDangerousBrowserArgs: noSandbox,
    logConsole: false,
  };
}

/** OpenWA v4's healthy state is CONNECTED, not the v5 READY sentinel. */
export function isWhatsAppConnectedState(state) { return state === 'CONNECTED'; }

export async function stopWhatsAppClient(client) {
  if (typeof client?.stop === 'function') return await client.stop();
  if (typeof client?.kill === 'function') return await client.kill('SYNK_SHUTDOWN');
}
