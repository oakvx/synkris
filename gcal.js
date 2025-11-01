import pkg from 'rrule';
const {
    RRule,
    rrulestr
} = pkg;
import {
    google
} from 'googleapis';
import {
    GoogleAuth
} from 'google-auth-library';
import { promises as fs } from 'fs';
import { readJSON, writeJSON, initJSON, DATA_DIR } from './fs-json.js';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export const awaitingService = new Map();
const BOOKINGS_PATH = path.resolve(DATA_DIR, 'bookings.json');
const SETTINGS_PATH = path.resolve(DATA_DIR, 'config.json');
// carica configurazione da config.json
initJSON('config.json', {});
const config = readJSON('config.json', {});

// esporta configurazione
export const services = config.services;
export const BUSINESS_HOURS = config.businessHours;
export const MAX_OVERRUN = config.maxOverrun;
export const unavailability = config.unavailability;
export const holidays = config.holidays || [];

// Google Calendar settings
const CALENDAR_ID = process.env.CALENDAR_ID || config.calendarId;
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
  if (process.env.DATA_DIR) {
    const p = path.join(process.env.DATA_DIR, 'google-credentials.json');
    const raw = await readIfExists(p);
    if (raw) return JSON.parse(raw);
  }
  throw new Error('Service Account non configurato: manca la chiave (ENV o file).');
}

function normalizeKey(k) {
  return k?.includes('\\n') ? k.replace(/\\n/g, '\n') : k;
}

let __jwt;

export function isImpersonating() {
  return !!(process.env.GCAL_IMPERSONATE || process.env.GOOGLE_IMPERSONATE);
}

export function resolveCalendarId() {
  const fromEnv = process.env.CALENDAR_ID?.trim();
  const fromCfg = globalThis?.config?.calendarId;
  const id = fromEnv || fromCfg || 'primary';
  if (id === 'primary' && !isImpersonating()) {
    throw new Error('Uso di "primary" senza impersonation (DWD). Condividi un calendario specifico col Service Account oppure abilita DWD + GCAL_IMPERSONATE.');
  }
  return id;
}

export async function getCalendarClient() {
  if (!__jwt) {
    const key = await loadSAKey();
    __jwt = new google.auth.JWT({
      email: key.client_email,
      key: normalizeKey(key.private_key),
      scopes: SCOPES,
      subject: process.env.GCAL_IMPERSONATE || process.env.GOOGLE_IMPERSONATE || undefined,
    });
  }
  await __jwt.authorize();
  return google.calendar({ version: 'v3', auth: __jwt });
}

export async function ensureCalendarAccess(calendarId = resolveCalendarId()) {
  const calendar = await getCalendarClient();
  try {
    await calendar.calendars.get({ calendarId });
  } catch (err) {
    const reason = err?.errors?.[0]?.reason || err?.code || err?.message || 'unknown';
    throw new Error(`Accesso a "${calendarId}" fallito: ${reason}`);
  }
  return true;
}

// Retry di default (usa il tuo 'retry' globale se esiste)
async function defaultRetry(fn, { retries = 3, baseMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === retries) break;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
const _retry = typeof globalThis.retry === 'function'
  ? (...a) => globalThis.retry(...a)
  : defaultRetry;

// Lascia invariata la tua buildTreatmentEvent(...)
export async function createCalendarEvent({
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  clientName = null,
  startTime,
  durationMin,
  price = null,
  serviceDetails = null,
  allergies = null,       // string | string[] | null
  allergic = null,        // true | false | null
  reminders,
  allergicWarning = null
}) {
  if (!serviceName || !professionalEmail || !clientPhone || !startTime || !durationMin) {
    throw new Error('Parametri obbligatori mancanti (serviceName, professionalEmail, clientPhone, startTime, durationMin).');
  }

  const calendar = await getCalendarClient();
  const CALENDAR_ID = resolveCalendarId();
  await ensureCalendarAccess(CALENDAR_ID);

  const eventPayload = buildTreatmentEvent({
    serviceName,
    professionalEmail,
    professionalName,
    clientPhone,
    clientName,
    startTime,
    durationMin,
    price,
    serviceDetails,
    allergies,
    allergic,
    reminders,
    allergicWarning
  });

  try {
    const res = await _retry(() =>
      calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventPayload,
        supportsAttachments: true,
      })
    );
    return res.data;
  } catch (err) {
    const reason = String(err?.errors?.[0]?.reason || err?.code || err?.message || 'unknown');
    if (reason.toLowerCase().includes('login required')) {
      throw new Error('Login Required — il service account non ha accesso al calendario o manca l’impersonation (DWD). Condividi il calendario con l’email del SA o imposta GCAL_IMPERSONATE.');
    }
    throw new Error(`Creazione evento fallita: ${reason}`);
  }
}


/**
 * Derive a human‑readable display name from an email like "diana.eni@example.com" -> "Diana Eni".
 */
function deriveNameFromEmail(email) {
  try {
    if (!email) return '';
    const local = String(email).split('@')[0];
    const cleaned = local.replace(/[._-]+/g, ' ').replace(/\d+/g, ' ').trim();
    return cleaned
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || String(email);
  } catch {
    return String(email || '');
  }
}
export const RETRY_COUNT = Number(process.env.RETRY_COUNT) || config.retryCount;
export const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS) || config.retryBackoffMs;

// inizializza client Google
const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar']
});

function saveBooking(record) {
  const data = readJSON('bookings.json', []);
  data.push(record);
  try { writeJSON('bookings.json', data); }
  catch (err) { console.error('[saveBooking] Impossibile scrivere bookings.json', err); }
}


// retry helper
async function retry(fn) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.code ?? err?.response?.status;
            if (status >= 400 && status < 500) throw err;
            if (++attempt >= RETRY_COUNT) throw err;
            const wait = RETRY_BACKOFF_MS * 2 ** (attempt - 1);
            await new Promise(res => setTimeout(res, wait));
        }
    }
}

// costruisce payload evento con possibile avviso allergeni
export function buildTreatmentEvent(opts) {
  const {
    serviceName,
    professionalEmail,
    professionalName = null,
    clientPhone,
    clientName = null,
    startTime,
    durationMin,
    price = null,
    serviceDetails = null,
    allergies = null,         // string | string[] | null
    allergic = null,          // true | false | null (non dichiarato)
    reminders = [{ method: 'popup', minutes: 1440 }],
    allergicWarning = null    // legacy string support
  } = opts || {};

  if (!serviceName || !professionalEmail || !clientPhone || !startTime || !durationMin) {
    throw new Error('Parametri obbligatori mancanti per buildTreatmentEvent');
  }

  const start = new Date(startTime);
  const end   = new Date(start.getTime() + Number(durationMin) * 60000);

  // Title: "Servizio - Nome Professionista"
  const proName = professionalName || deriveNameFromEmail(professionalEmail);
  const summary = `${serviceName} - ${proName}`;

  // Format allergy section
  function fmtAllergies(allergies) {
    if (Array.isArray(allergies)) {
      const list = allergies.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
      return list.length ? list.join(', ') : 'sì (non specificate)';
    }
    if (typeof allergies === 'string' && allergies.trim()) return allergies.trim();
    return 'sì (non specificate)';
  }
  let allergyLine;
  if (allergic === true) {
    allergyLine = `Allergie: ${fmtAllergies(allergies)}`;
  } else if (allergic === false) {
    allergyLine = 'Allergie: nessuna riferita';
  } else if (allergicWarning) {
    allergyLine = `Allergie: ${allergicWarning}`;
  } else {
    allergyLine = 'Allergie: non dichiarate';
  }

  const priceLine   = (price !== null && price !== undefined && price !== '') ? `€${price}` : '—';
  const durationLine= `${Number(durationMin)} min`;

  const lines = [
    '— Dettagli cliente —',
    `• Nome: ${clientName || '—'}`,
    `• Telefono: ${clientPhone}`,
    `• ${allergyLine}`,
    '',
    '— Dettagli servizio —',
    `• Servizio: ${serviceName}`,
    `• Professionista: ${proName}`,
    `• Durata: ${durationLine}`,
    `• Prezzo: ${priceLine}`,
    serviceDetails ? `• Note: ${serviceDetails}` : null
  ].filter(Boolean);

  const description = lines.join('\n');

  return {
    summary,
    description,
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    reminders: { useDefault: false, overrides: reminders }
  };
}

/**
 * Unified extractor that returns the textual value stored in a "response"‑like field
 * from JSON objects or loosely‑formatted JSON‑like strings.
 *
 * Features incorporated:
 *  • Alternative key support (default: "response", "StringResponse")
 *  • Automatic repair of malformed JSON (smart quotes, single quotes, trailing commas)
 *  • Works with single value or arrays of messages
 *  • Optionally returns **all** matches when opts.all=true
 *
 * @param {string|object|Array<string|object>} input         Single message or array of messages
 * @param {Object}   [opts]
 * @param {string[]} [opts.keys]   Keys to search (priority order). Default ["response","StringResponse"]
 * @param {boolean}  [opts.all]    If true, returns an array with every match; otherwise first match or null
 * @returns {string|null|string[]} Extracted value(s)
 */
export function extractResponse(input, opts = {}) {
  const options = { keys: ['response', 'StringResponse'], all: false, ...opts };
  const items   = Array.isArray(input) ? input : [input];
  const results = [];

  /**
   * Best‑effort JSON normalisation so JSON.parse succeeds more often.
   * @param {string} str
   * @returns {string}
   */
  const fixJson = (str) => str
    // smart quotes → regular quotes
    .replace(/[“”‘’]/g, '"')
    // single‑quoted keys/values → double quotes (shallow heuristic)
    .replace(/([{,]\s*)'(\w+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'((?:[^'\\]|\\.)*)'/g, ': "$1"')
    // trailing commas → removed
    .replace(/,(\s*[}\]])/g, '$1');

  /**
   * Extract from a raw string (may include noise around the JSON block).
   * @param {string} txt
   * @returns {string|null}
   */
  const fromString = (txt) => {
    // isolate first {...} if surrounded by text
    const candidate = (txt.match(/({[\s\S]*?})/) || [])[1] || txt;

    // Try strict parse first
    try {
      const obj = JSON.parse(fixJson(candidate));
      for (const k of options.keys) if (typeof obj[k] === 'string') return obj[k];
    } catch {/* fall through */}

    // Fallback regex (handles escapes + single/double quotes)
    const keyGroup = options.keys.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const re = new RegExp(
  `["'](?:${keyGroup})["']\\s*:\\s*(["'])(?<val>(?:\\\\.|(?!\\1).)*?)\\1`
);

    const m  = candidate.match(re);
    return m?.groups?.val ?? null;
  };

  for (const itm of items) {
    // 1. Direct object access
    if (typeof itm === 'object' && itm !== null && !Array.isArray(itm)) {
      for (const k of options.keys) {
        if (typeof itm[k] === 'string') {
          if (options.all) { results.push(itm[k]); continue; }
          return itm[k];
        }
      }
      // Serialise object for fallback parsing
      try {
        const val = fromString(JSON.stringify(itm));
        if (val !== null) {
          if (options.all) results.push(val); else return val;
        }
      } catch {}
    }
    // 2. Raw string input
    else if (typeof itm === 'string') {
      const val = fromString(itm);
      if (val !== null) {
        if (options.all) results.push(val); else return val;
      }
    }
  }

  return options.all ? results : null;
}

export async function updateCalendarEvent({
  eventId,
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  clientName = null,
  startTime,
  durationMin,
  price = null,
  serviceDetails = null,
  allergies = null,      // string | string[] | null
  allergic = null,       // true | false | null
  reminders = [{ method: 'popup', minutes: 1440 }],
  allergicWarning = null,
  calendarId = (process.env.CALENDAR_ID || config.calendarId)
}) {
  if (!eventId) throw new Error('eventId mancante per updateCalendarEvent');
  const calendar = await getCalendarClient();

  // Ricostruisci il payload evento (summary/description/orari)
  const body = buildTreatmentEvent({
    serviceName,
    professionalEmail,
    professionalName,
    clientPhone,
    clientName,
    startTime,
    durationMin,
    price,
    serviceDetails,
    allergies,
    allergic,
    reminders,
    allergicWarning
  });

  // UPDATE (mantiene lo stesso eventId); manda update a tutti
  const res = await retry(() => calendar.events.update({
    calendarId,
    eventId,
    sendUpdates: 'all',
    requestBody: body
  }));
  return res.data;
}


// verifica unavailability
function matchesUnavailability(date, entry) {
    switch (entry.type) {
        case 'day':
            return entry.days?.includes(date.getDate()) || false;
        case 'range': {
            const start = new Date(entry.start);
            start.setHours(0, 0, 0, 0);
            const end = new Date(entry.end);
            end.setHours(23, 59, 59, 999);
            return date >= start && date <= end;
        }
        case 'recurrence': {
            if (!entry.rule || !rrulestr) return false;
            const rule = rrulestr(`RRULE:${entry.rule}`);
            const sd = new Date(date);
            sd.setHours(0, 0, 0, 0);
            const ed = new Date(date);
            ed.setHours(23, 59, 59, 999);
            return rule.between(sd, ed, true).length > 0;
        }
        default:
            return false;
    }
}
export function isAvailable(email, date) {
    const rules = unavailability[email] || [];
    return !rules.some(entry => matchesUnavailability(new Date(date), entry));
}

// calcola slot liberi
function computeSlots(busyIntervals, windowStart, windowEnd, durationMin) {
    const busy = busyIntervals.map(iv => ({
            start: new Date(iv.start),
            end: new Date(iv.end)
        }))
        .sort((a, b) => a.start - b.start);
    const free = [];
    let cursor = new Date(windowStart);
    for (const iv of busy) {
        if (iv.start > cursor) free.push({
            start: new Date(cursor),
            end: new Date(iv.start)
        });
        if (iv.end > cursor) cursor = new Date(iv.end);
    }
    if (cursor < windowEnd) free.push({
        start: new Date(cursor),
        end: new Date(windowEnd)
    });
    return free.filter(slot => {
        const endWith = new Date(slot.start.getTime() + durationMin * 60000);
        const overrun = (endWith - windowEnd) / 60000;
        return (slot.end - slot.start) >= durationMin * 60000 || (overrun > 0 && overrun <= MAX_OVERRUN);
    });
}

export async function getFreeSlotsForProfessional(email, duration, date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);
    const wd = dayStart.getDay();
    const hours = BUSINESS_HOURS[wd] || [];
    if (!isAvailable(email, dayStart) || hours.length === 0) return [];
    let busy = [];
    try {
        const cal = google.calendar({
            version: 'v3',
            auth: await auth.getClient()
        });
        const fb = await cal.freebusy.query({
          requestBody: {
            timeMin: dayStart.toISOString(),
            timeMax: dayEnd.toISOString(),   // se è già così va bene
            items: [{ id: email }]
          }
        });

        busy = fb.data.calendars[email]?.busy || [];
    } catch {
        busy = [];
    }
    const slots = [];
    for (let i = 0; i < hours.length; i += 2) {
        const [sh, sm] = hours[i].split(':').map(Number);
        const [eh, em] = hours[i + 1].split(':').map(Number);
        const ws = new Date(dayStart);
        ws.setHours(sh, sm, 0, 0);
        const we = new Date(dayStart);
        we.setHours(eh, em, 0, 0);
        computeSlots(busy, ws, we, duration).forEach(s => slots.push(`${s.start.getHours().toString().padStart(2,'0')}:${s.start.getMinutes().toString().padStart(2,'0')}`));
    }
    return slots.sort();
}

// ottiene slot per tutti i pro per un giorno
export async function getFreeSlotsForDay(serviceName, date) {
  const svc = services[serviceName];
  if (!svc) throw new Error(`Servizio sconosciuto: ${serviceName}`);

  // 1) giorno, apertura e chiusura
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const wd = dayStart.getDay();
  const hours = BUSINESS_HOURS[wd] || [];
  if (hours.length === 0) return {}; // chiuso

  // 2) chiusura della giornata
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  // 3) filtra professionisti disponibili giornalmente
  const pros = svc.professionals.filter(e => isAvailable(e, dayStart));
  if (pros.length === 0) return {};

  // 4) freebusy per tutti i pro
  const cal = await getCalendarClient();
  const fb = await retry(() => cal.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: pros.map(id => ({ id }))
    }
  }));
  const busyMap = fb.data.calendars || {};

  // 5) per ciascun pro, genero slot a step = duration
  const available = {};
  for (const email of pros) {
    const busy = (busyMap[email]?.busy || []).map(iv => ({
      start: new Date(iv.start),
      end:   new Date(iv.end)
    }));
    const slots = [];

    // per ogni intervallo di BUSINESS_HOURS (coppie [apertura, chiusura])
    for (let i = 0; i < hours.length; i += 2) {
      const [hOpen, mOpen] = hours[i].split(':').map(Number);
      const [hClose, mClose] = hours[i+1].split(':').map(Number);

      // punto di partenza e fine blocco orario
      const windowStart = new Date(dayStart);
      windowStart.setHours(hOpen, mOpen, 0, 0);
      const windowEnd = new Date(dayStart);
      windowEnd.setHours(hClose, mClose, 0, 0);

      // scorro con step = durata servizio
      const stepMs = svc.duration * 60000;
      for (let cursor = windowStart.getTime();
           cursor + stepMs <= windowEnd.getTime();
           cursor += stepMs) {
        const slotStart = new Date(cursor);
        const slotEnd   = new Date(cursor + stepMs);

        // controllo sovrapposizioni col busy
        const overlaps = busy.some(iv =>
          iv.start < slotEnd && iv.end > slotStart
        );
        if (!overlaps) {
          const hh = slotStart.getHours().toString().padStart(2,'0');
          const mm = slotStart.getMinutes().toString().padStart(2,'0');
          slots.push(`${hh}:${mm}`);
        }
      }
    }

    if (slots.length) available[email] = { slots };
  }

  return available;
}

// --------- Utilities for fuzzy matching ---------
function lev(a, b) {
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

function matchFuzzy(input, options) {
  input = input.toLowerCase().trim();
  let best = { value: null, dist: Infinity };
  options.forEach(opt => {
    const norm = opt.toLowerCase();
    const d = lev(input, norm);
    if (d < best.dist) best = { value: opt, dist: d };
  });
  const thresh = Math.max(2, Math.round(best.value.length * 0.2));
  return best.dist <= thresh ? best.value : null;
}

export async function createCalendarEventFlow(client, chatId) {
  console.log(`[createCalendarEventFlow] Inizio flow per chatId: ${chatId}`);

  // Pre-check: evita flussi paralleli
  if (awaitingService.has(chatId)) {
    await safeSend(client, chatId,
      '❌ Prenotazione già in corso. Rispondi “annulla” per uscire o attendi il completamento.'
    );
    return;
  }
  awaitingService.set(chatId);

  // Funzione helper per prompt + raccolta risposta
  const ask = async (prompt) => {
    await safeSend(client, chatId, prompt);
    const filter = msg => msg.from === chatId;
    try {
      const collected = await client.awaitMessages(chatId, filter, {
        max: 1,
        time: 5 * 60 * 1000,
        errors: ['time']
      });
      return collected.first().body.trim();
    } catch {
      throw new Error('Timeout risposta utente');
    }
  };

  try {
    // 1) Selezione del servizio
    const serviceNames = Object.keys(services);
    let serviceName = null;
    while (!serviceName) {
      const list = serviceNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
      const reply = (await ask(`💆‍♀️ Quale trattamento desideri?\n${list}`)).trim();
      const lower = reply.toLowerCase();
      if (/\b(annulla|cancel|esci)\b/.test(lower)) throw new Error('USER_CANCEL');

      // scelta numerica
      const idx = parseInt(reply, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= serviceNames.length) {
        serviceName = serviceNames[idx - 1];
      } else {
        // exact match senza accenti
        const norm = reply.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        serviceName = serviceNames.find(n =>
          n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === norm
        );
      }

      // fuzzy matching se necessario
      if (!serviceName) {
        const fuzzy = matchFuzzy(reply, serviceNames);
        if (fuzzy) {
          const confirm = (await ask(`Intendevi **${fuzzy}**? (sì/no)`)).toLowerCase();
          if (confirm.startsWith('s')) serviceName = fuzzy;
        }
      }

      // fallback LLM
      if (!serviceName) {
        const llmsg = await askOllama(
          `Utente: "${reply}". Non ho capito quale trattamento. Listino: ${serviceNames.join(', ')}.`
        );
        await safeSend(client, chatId, llmsg);
      }

      if (!serviceName) {
        await safeSend(client, chatId, '❌ Scelta non valida (digita “annulla” per uscire)');
      }
    }
    console.info(`[createCalendarEventFlow] Servizio selezionato: ${serviceName}`);
    const svc = services[serviceName];

    // 2) Selezione del professionista
    let professionalEmail = null;
    while (!professionalEmail) {
      const profList = svc.professionals.map((e, i) => `${i + 1}. ${e}`).join('\n');
      const reply = (await ask(`👩‍🔬 Con quale specialista?\n${profList}`)).trim();
      const lower = reply.toLowerCase();
      if (/\b(annulla|cancel|esci)\b/.test(lower)) throw new Error('USER_CANCEL');

      const idx = parseInt(reply, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= svc.professionals.length) {
        professionalEmail = svc.professionals[idx - 1];
      } else {
        const exact = svc.professionals.find(e =>
          e.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() ===
          reply.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        );
        professionalEmail = exact || matchFuzzy(reply, svc.professionals);
        if (professionalEmail) {
          await safeSend(client, chatId, `Selezioniamo **${professionalEmail}**`);
        }
      }
      if (!professionalEmail) {
        await safeSend(client, chatId, '❌ Selezione non valida (digita “annulla” per uscire)');
      }
    }
    console.info(`[createCalendarEventFlow] Professionista selezionato: ${professionalEmail}`);

    // 3) Gestione allergie
    let allergicWarning = null;
    if (svc.allergens?.length) {
      const reply = (await ask(
        `⚠️ Questo trattamento usa: ${svc.allergens.join(', ')}. Hai allergie? (sì/no)`
      )).toLowerCase();
      if (reply.startsWith('s')) {
        allergicWarning = `Cliente allergico a: ${svc.allergens.join(', ')}`;
      }
    }

    // 4) Mesi da cercare (1-6)
    let monthsAhead = parseInt(await ask(
      '📅 Quanti mesi avanti vuoi cercare disponibilità? (1-6, default 1)'
    ), 10);
    if (isNaN(monthsAhead) || monthsAhead < 1 || monthsAhead > 6) monthsAhead = 1;

    // 5) Filtri giorni settimana
    const daysReply = (await ask(
      '👤 Vuoi filtrare giorni? Scrivi numeri 1‑7 separati da virgola o “no”'
    )).toLowerCase();
    const weekdays = daysReply.includes('no')
      ? []
      : daysReply.split(',').map(s => parseInt(s.trim(), 10)%7).filter(n => !isNaN(n));

    // 6) Raccolta date disponibili
    const freeDates = [];
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setMonth(maxDate.getMonth() + monthsAhead);
    for (let d = new Date(today); d <= maxDate; d.setDate(d.getDate() + 1)) {
      if (weekdays.length && !weekdays.includes(d.getDay())) continue;
      try {
        const slots = await getFreeSlotsForProfessional(
          professionalEmail, svc.duration, new Date(d)
        );
        if (slots.length) {
          freeDates.push(new Date(d));
          if (freeDates.length >= 30) break;
        }
      } catch {
        // ignora errori di fetch
      }
    }
    if (!freeDates.length) {
      await safeSend(client, chatId, '🚫 Nessuna disponibilità nel range selezionato');
      return;
    }

    // 7) Scelta della data
    let appointmentDate = null;
    while (!appointmentDate) {
      const list = freeDates.map((dt, i) =>
        `${i + 1}. ${dt.toLocaleDateString('it-IT')}`
      ).join('\n');
      const reply = (await ask(`📅 Seleziona il giorno:\n${list}`)).trim();
      const idx = parseInt(reply, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= freeDates.length) {
        appointmentDate = freeDates[idx - 1];
      } else {
        await safeSend(client, chatId, '❌ Scelta non valida (digita “annulla” per uscire)');
      }
    }

    // 8) Scelta dell’orario
    const slots = await getFreeSlotsForProfessional(
      professionalEmail, svc.duration, appointmentDate
    );
    let chosenTime = null;
    while (!chosenTime) {
      const list = slots.map((t, i) => `${i + 1}. ${t}`).join('\n');
      const reply = (await ask(`🕒 Seleziona orario:\n${list}`)).trim();
      const idx = parseInt(reply, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= slots.length) {
        chosenTime = slots[idx - 1];
      } else {
        await safeSend(client, chatId, '❌ Scelta non valida (digita “annulla” per uscire)');
      }
    }

    // 9) Configurazione promemoria
    const [hh, mm] = chosenTime.split(':').map(Number);
    const startTime = new Date(appointmentDate);
    startTime.setHours(hh, mm);
    let userSettings = {};
    try {
      userSettings = JSON.parse(await fs.promises.readFile('userSettings.json', 'utf8'));
    } catch {}
    const defaultReminder = userSettings[chatId]?.reminderChoice || 1;
    const options = ['0. Nessuno','1. 24h','2. 2h','3. 30min'];
    let choice = parseInt(await ask(
      `⏰ Quando vuoi il promemoria? (default ${options[defaultReminder]})\n${options.join('\n')}`
    ), 10);
    if (isNaN(choice) || choice < 0 || choice > 3) choice = defaultReminder;
    userSettings[chatId] = { reminderChoice: choice };
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(userSettings, null, 2));
    const minutesMap = [0, 1440, 120, 30];
    const reminders = minutesMap[choice] ? [{ method: 'popup', minutes: minutesMap[choice] }] : [];

    // 10) Creazione dell'evento calendario
    let event;
    try {
      event = await createCalendarEvent({
        serviceName,
        professionalEmail,
        clientPhone: chatId.replace(/\D/g,''),
        startTime,
        durationMin: svc.duration,
        reminders,
        allergicWarning
      });
    } catch (err) {
      const errors = {
        EVENT_CONFLICT: '❌ Orario non più disponibile.',
        QUOTA_EXCEEDED: '❌ Limite calendario raggiunto.'
      };
      await safeSend(client, chatId, errors[err.code] || '❌ Errore creazione evento.');
      return;
    }

    // 11) Conferma finale e salvataggio
    saveBooking({ chatId, serviceName, professionalEmail, start: startTime.toISOString(), eventId: event.id });
    const confirmMsg = `✅ Appuntamento confermato!\n` +
      `Servizio: ${serviceName}\n` +
      `Professionista: ${professionalEmail}\n` +
      `Quando: ${startTime.toLocaleString('it-IT')}\n` +
      `${event.htmlLink ? `📅 Link: ${event.htmlLink}` : ''}`;
    await safeSend(client, chatId, confirmMsg);

  } catch (err) {
    if (err.message === 'USER_CANCEL' || err.message === 'Timeout risposta utente') {
      await safeSend(client, chatId, '❌ Prenotazione annullata.');
    } else {
      console.error('[createCalendarEventFlow] Errore inatteso', err);
      await safeSend(client, chatId, '❌ Errore inatteso');
    }
  } finally {
    awaitingService.delete(chatId);
  }
}


export async function listCalendars(client, chatId) {
    try {
        const cal = await getCalendarClient();
        const res = await retry(() => cal.calendarList.list());
        const items = res.data.items || [];
        if (!items.length) return await client.sendText(chatId, '📂 Nessun calendario');
        const msg = '📂 Tuoi calendari:\n' + items.map(c => `• ${c.summary}\n  ID: ${c.id}`).join('\n');
        await client.sendText(chatId, msg);
    } catch (err) {
        console.error(err);
        await client.sendText(chatId, '⚠️ Impossibile recuperare');
    }
}

export async function safeSendGcal(client, chatId, message) {
    try {
        return await safeSend(client, chatId, message);
    } catch (err) {
        console.error('safeSend err:', err);
        try {
            await client.sendText(chatId, '⚠️ Errore invio');
        } catch {}
        return undefined;
    }
}
/**
 * Cancella un evento da Google Calendar gestendo errori specifici.
 * @param {string} eventId - ID dell'evento da cancellare.
 * @param {string} calendarId - ID del calendario (default 'primary').
 * @throws {Error} con codice 'EVENT_NOT_FOUND', 'PERMISSION_DENIED', 'QUOTA_EXCEEDED' o 'CANCEL_FAILED'
 */
export async function cancelCalendarEvent(
  eventId,
  calendarId = (process.env.CALENDAR_ID || config.calendarId)
) {
  const calendar = await getCalendarClient();
  try {
    await calendar.events.delete({ calendarId, eventId, sendUpdates: 'all' });
    return true;
  } catch (err) {
    const code = err?.code || err?.response?.status;
    if (code === 404) { const e = new Error('Evento non trovato.'); e.code = 'EVENT_NOT_FOUND'; throw e; }
    if (code === 403) { const e = new Error('Permesso negato.');   e.code = 'PERMISSION_DENIED'; throw e; }
    if (code === 429) { const e = new Error('Quota superata.');    e.code = 'QUOTA_EXCEEDED';    throw e; }
    const e = new Error('CANCEL_FAILED'); e.cause = err; throw e;
  }
}

// --- COMPAT alias per chiamate vecchie ---
export const updateEvent = updateCalendarEvent;


// --- Compat per util.js: deleteEvent / cancelEvent ---
export async function deleteEvent({ eventId, calendarId } = {}) {
  if (!eventId) throw new Error('deleteEvent: eventId required');
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId: calendarId || resolveCalendarId(),
    eventId,
    sendUpdates: 'none', // nessuna notifica agli invitati
  });
  return true;
}

export async function cancelEvent({ eventId, calendarId } = {}) {
  if (!eventId) throw new Error('cancelEvent: eventId required');
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId: calendarId || resolveCalendarId(),
    eventId,
    sendUpdates: 'all', // invia email di annullamento agli invitati
  });
  return true;
}
