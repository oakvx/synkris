/** Google Calendar auth domain. */
export function createModule(dependencies, shared) {
  const { DATA_DIR, SCOPES, fs, google, path } = dependencies;

async function loadSAKey() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  if (process.env.GOOGLE_CREDENTIALS_B64) {
    const s = Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8');
    return JSON.parse(s);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const raw = await fs.readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    return JSON.parse(raw);
  }
  // fallback opzionale su DATA_DIR/google-credentials.json (se usi fs-json.js/EXE)
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'google-credentials.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error('Service Account non configurato: manca la chiave (ENV o file).');
}

function normalizeKey(k) {
  return k?.includes('\\n') ? k.replace(/\\n/g, '\n') : k;
}

function isImpersonating() {
  return !!(process.env.GCAL_IMPERSONATE || process.env.GOOGLE_IMPERSONATE);
}

function resolveCalendarId() {
  const fromEnv = process.env.CALENDAR_ID?.trim();
  const fromCfg = shared.__runtimeConfig?.calendarId;
  const id = fromEnv || fromCfg || 'primary';
  if (id === 'primary' && !isImpersonating()) {
    throw new Error('Uso di "primary" senza impersonation (DWD). Condividi un calendario specifico col Service Account oppure abilita DWD + GCAL_IMPERSONATE.');
  }
  return id;
}

async function getCalendarClient() {
  if (!shared.__jwt) {
    const key = await loadSAKey();
    shared.__jwt = new google.auth.JWT({
      email: key.client_email,
      key: normalizeKey(key.private_key),
      scopes: SCOPES,
      subject: process.env.GCAL_IMPERSONATE || process.env.GOOGLE_IMPERSONATE || undefined,
    });
  }
  await shared.__jwt.authorize();
  return google.calendar({
    version: 'v3',
    auth: shared.__jwt
  });
}

async function ensureCalendarAccess(calendarId = resolveCalendarId()) {
  const calendar = await getCalendarClient();
  try {
    await calendar.calendars.get({
      calendarId
    });
  } catch (err) {
    const reason = err?.errors?.[0]?.reason || err?.code || err?.message || 'unknown';
    throw new Error(`Accesso a "${calendarId}" fallito: ${reason}`);
  }
  return true;
}

  return { loadSAKey, normalizeKey, isImpersonating, resolveCalendarId, getCalendarClient, ensureCalendarAccess };
}
