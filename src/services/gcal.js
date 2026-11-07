import { createModule as createCalendar0 } from './gcal/auth.js';
import { createModule as createCalendar1 } from './gcal/retry.js';
import { createModule as createCalendar2 } from './gcal/events.js';
import { createModule as createCalendar3 } from './gcal/event-format.js';
import { createModule as createCalendar4 } from './gcal/availability.js';
import pkg from 'rrule';
const {
  rrulestr
} = pkg;
import {
  google
} from 'googleapis';
import { createPgPool } from '../storage/postgres.js';
import {
  promises as fs
} from 'fs';
import path from 'path';
import 'dotenv/config';
import { DATA_DIR } from '../storage/data-paths.js';

// Directory dati (solo per bootstrap da config.json se DB vuoto)

const SCOPES = ['https://www.googleapis.com/auth/calendar'];


// ================= PostgreSQL config loader (no config.json a runtime) =================
// Dipendenza: npm i pg
const __PG_URL = process.env.DATABASE_URL || "";
const __pgPool = __PG_URL ? createPgPool() : null;

async function __pgExec(text, params = []) {
  if (!__pgPool) throw new Error("PostgreSQL non configurato (manca DATABASE_URL o modulo pg)");
  return await __pgPool.query(text, params);
}
async function __pgQuery(text, params = []) {
  const res = await __pgExec(text, params);
  return res?.rows || [];
}

function __timeToHHMM(v) {
  if (v === null || typeof v === "undefined") return null;
  const s = String(v);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function __isoDow(d) {
  const D = d instanceof Date ? d : new Date(d);
  const js = D.getDay(); // 0..6, 0=Sun
  return js === 0 ? 7 : js; // 1..7, 7=Sun
}

function __jsDowFromIso(iso) {
  const n = Number(iso);
  if (!Number.isFinite(n)) return null;
  return n === 7 ? 0 : n; // 0..6
}

export let services = {};
export let BUSINESS_HOURS = {};
export let MAX_OVERRUN = 0;
export let unavailability = {};
export let holidays = [];

let __runtimeConfig = null;

async function __loadConfigFromDb() {
  // servizi
  const svcRows = await __pgQuery(`
    SELECT service_id, service_name, default_duration_min, buffer_after_min, price, materials_cost
    FROM public.services
  `);
  const synRows = await __pgQuery(`SELECT service_id, synonym FROM public.service_synonyms`);
  const allRows = await __pgQuery(`SELECT service_id, allergen FROM public.service_allergens`);

  // professionals + email "primaria"
  const proRows = await __pgQuery(`
    SELECT p.professional_id, p.full_name,
           (SELECT (pe.email)::text FROM public.professional_emails pe
            WHERE pe.professional_id = p.professional_id
            ORDER BY (pe.email)::text ASC
            LIMIT 1) AS email
    FROM public.professionals p
  `);

  const proSvcRows = await __pgQuery(`SELECT professional_id, service_id FROM public.professional_services`);
  const proDurRows = await __pgQuery(`SELECT professional_id, service_id, duration_min FROM public.professional_service_durations`);

  // orari
  const bhRows = await __pgQuery(`SELECT weekday, open_time, close_time, is_closed FROM public.salon_business_hours`);
  const lunchRows = await __pgQuery(`SELECT weekday, start_time, end_time FROM public.salon_lunch_breaks ORDER BY weekday, start_time`);
  const closedDateRows = await __pgQuery(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM public.salon_closed_dates`);
  const unavWRows = await __pgQuery(`SELECT professional_id, weekday FROM public.professional_unavailable_weekdays`);
  const unavDates = await __pgQuery(`SELECT professional_id,to_char(start_day,'YYYY-MM-DD') AS start_day,
      to_char(end_day,'YYYY-MM-DD') AS end_day FROM public.professional_time_off
    WHERE end_day >= current_date - interval '1 day'`);

  // maps
  const proIdToEmail = new Map();
  const professionals = {};
  for (const r of proRows) {
    const email = String(r.email || "").trim();
    if (!email) continue;
    proIdToEmail.set(Number(r.professional_id), email);
    professionals[email] = {
      name: String(r.full_name || email)
    };
  }

  // service_id -> service_name
  const svcIdToName = new Map();
  for (const r of svcRows) svcIdToName.set(Number(r.service_id), String(r.service_name || ""));

  // servizi config
  const svcCfg = {};
  for (const r of svcRows) {
    const name = String(r.service_name || "");
    if (!name) continue;
    svcCfg[name] = {
      duration: Number(r.default_duration_min || 0) || 0,
      bufferAfterMin: Number(r.buffer_after_min || 0) || 0,
      price: (r.price === null || typeof r.price === "undefined") ? null : Number(r.price),
      materialsCost: (r.materials_cost === null || typeof r.materials_cost === "undefined") ? null : Number(r.materials_cost),
      synonyms: [],
      allergens: [],
      professionals: [],
      professionalDurations: {},
    };
  }
  for (const r of synRows) {
    const svcName = svcIdToName.get(Number(r.service_id));
    if (!svcName || !svcCfg[svcName]) continue;
    const syn = String(r.synonym || "").trim();
    if (syn) svcCfg[svcName].synonyms.push(syn);
  }
  for (const r of allRows) {
    const svcName = svcIdToName.get(Number(r.service_id));
    if (!svcName || !svcCfg[svcName]) continue;
    const al = String(r.allergen || "").trim();
    if (al) svcCfg[svcName].allergens.push(al);
  }

  // professional_services
  for (const r of proSvcRows) {
    const proEmail = proIdToEmail.get(Number(r.professional_id));
    const svcName = svcIdToName.get(Number(r.service_id));
    if (!proEmail || !svcName || !svcCfg[svcName]) continue;
    if (!svcCfg[svcName].professionals.includes(proEmail)) svcCfg[svcName].professionals.push(proEmail);
  }

  // professional_service_durations
  for (const r of proDurRows) {
    const proEmail = proIdToEmail.get(Number(r.professional_id));
    const svcName = svcIdToName.get(Number(r.service_id));
    if (!proEmail || !svcName || !svcCfg[svcName]) continue;
    const d = Number(r.duration_min || 0) || 0;
    if (d > 0) svcCfg[svcName].professionalDurations[proEmail] = d;
  }

  // business hours: jsDow -> flat [open,close,(open2,close2)...]
  const businessHours = {};
  const closedDays = {};
  const lunchByIso = new Map();
  for (const r of lunchRows) {
    const iso = Number(r.weekday);
    if (!lunchByIso.has(iso)) lunchByIso.set(iso, []);
    lunchByIso.get(iso).push([__timeToHHMM(r.start_time), __timeToHHMM(r.end_time)]);
  }

  for (const r of bhRows) {
    const iso = Number(r.weekday);
    const js = __jsDowFromIso(iso);
    if (js === null) continue;

    const isClosed = !!r.is_closed;
    if (isClosed) {
      businessHours[js] = [];
      closedDays[String(iso)] = true;
      continue;
    }

    const open = __timeToHHMM(r.open_time);
    const close = __timeToHHMM(r.close_time);
    if (!open || !close) {
      businessHours[js] = [];
      continue;
    }

    // split con lunch breaks (se presenti)
    const breaks = (lunchByIso.get(iso) || []).filter(b => b[0] && b[1]).sort((a, b) => a[0].localeCompare(b[0]));
    if (breaks.length === 0) {
      businessHours[js] = [open, close];
    } else {
      const out = [];
      let cursor = open;
      for (const [bs, be] of breaks) {
        if (cursor < bs) {
          out.push(cursor, bs);
        }
        cursor = be;
      }
      if (cursor < close) out.push(cursor, close);
      businessHours[js] = out;
    }
  }

  // holidays (chiusure a data)
  const holidayList = [];
  for (const r of closedDateRows) {
    const d = r.day ? String(r.day) : null; // YYYY-MM-DD
    if (d) holidayList.push(d);
  }

  // unavailability: weekday ISO 1..7 per professional
  const unav = {};
  for (const r of unavWRows) {
    const email = proIdToEmail.get(Number(r.professional_id));
    const iso = String(r.weekday || "");
    if (!email || !iso) continue;
    unav[email] = unav[email] || [];
    // tipo 'weekday': days=[ '1'..'7' ]
    unav[email].push({
      type: "weekday",
      days: [iso]
    });
  }

  for (const r of unavDates) {
    const email=proIdToEmail.get(Number(r.professional_id));
    if (!email)continue;
    const formatDay=d=>d instanceof Date?d.toLocaleDateString('en-CA',{timeZone:'Europe/Rome'}):String(d).slice(0,10);
    const start=formatDay(r.start_day),end=formatDay(r.end_day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    unav[email]=unav[email]||[];
    unav[email].push({type:'range',start:start+'T00:00:00',end:end+'T23:59:59'});
  }
  const config = {
    services: svcCfg,
    professionals,
    unavailability: unav,
    businessHours,
    lunchBreaks: {}, // già incorporati in businessHours
    closedDays,
    daysOff: {}, // legacy
    holidays: holidayList,
    calendarId: process.env.CALENDAR_ID || null,
    maxOverrun: Number(process.env.MAX_OVERRUN || 0) || 0,
  };

  return config;
}

async function __loadConfigFromFileFallback() {
  try {
    const p = path.resolve(DATA_DIR, "config.json");
    const raw = await fs.readFile(p, "utf8");
    const cfg = JSON.parse(raw);
    return (cfg && typeof cfg === "object") ? cfg : {};
  } catch {
    return {};
  }
}

export async function ensureRuntimeConfig(force = false) {
  if (__runtimeConfig && !force) return __runtimeConfig;
  try {
    if (__pgPool) {
      const cfg = await __loadConfigFromDb();
      // Preserve the configuration object referenced by the active bot flow.
      // Dashboard updates are picked up on refresh without resetting conversations.
      if (__runtimeConfig && typeof __runtimeConfig === 'object') {
        for (const key of Object.keys(__runtimeConfig)) delete __runtimeConfig[key];
        Object.assign(__runtimeConfig, cfg);
      } else __runtimeConfig = cfg;
    } else {
      __runtimeConfig = await __loadConfigFromFileFallback();
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Configurazione database non disponibile: verificare connessione e migrazioni', { cause: error });
    }
    __runtimeConfig = await __loadConfigFromFileFallback();
  }

  // aggiorna exports live (ESM live bindings)
  services = __runtimeConfig?.services || {};
  BUSINESS_HOURS = __runtimeConfig?.businessHours || {};
  MAX_OVERRUN = __runtimeConfig?.maxOverrun || 0;
  unavailability = __runtimeConfig?.unavailability || {};
  holidays = __runtimeConfig?.holidays || [];

  return __runtimeConfig;
}

export async function getRuntimeConfig() {
  return await ensureRuntimeConfig(false);
}

// inizializza subito (best-effort)
await ensureRuntimeConfig(false);


// Google Calendar settings
async function loadSAKey(...args) {
  return __gcalModules.auth.loadSAKey(...args);
}

function normalizeKey(...args) {
  return __gcalModules.auth.normalizeKey(...args);
}

let __jwt;

export function isImpersonating(...args) {
  return __gcalModules.auth.isImpersonating(...args);
}

export function resolveCalendarId(...args) {
  return __gcalModules.auth.resolveCalendarId(...args);
}

export async function getCalendarClient(...args) {
  return __gcalModules.auth.getCalendarClient(...args);
}

export async function ensureCalendarAccess(...args) {
  return __gcalModules.auth.ensureCalendarAccess(...args);
}

// Retry di default (usa il tuo 'retry' globale se esiste)
async function defaultRetry(...args) {
  return __gcalModules.retry.defaultRetry(...args);
}
const _retry = typeof globalThis.retry === 'function' ?
  (...a) => globalThis.retry(...a) :
  defaultRetry;

// Lascia invariata la tua buildTreatmentEvent(...)
export async function createCalendarEvent(...args) {
  return __gcalModules.events.createCalendarEvent(...args);
}


/**
 * Derive a human‑readable display name from an email like "diana.eni@example.com" -> "Diana Eni".
 */
function deriveNameFromEmail(...args) {
  return __gcalModules.event_format.deriveNameFromEmail(...args);
}
export const RETRY_COUNT = Number(process.env.RETRY_COUNT) || 10;
export const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS) || 1000;

// retry helper
async function retry(...args) {
  return __gcalModules.retry.retry(...args);
}

// costruisce payload evento con possibile avviso allergeni
export function buildTreatmentEvent(...args) {
  return __gcalModules.event_format.buildTreatmentEvent(...args);
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
export function extractResponse(...args) {
  return __gcalModules.event_format.extractResponse(...args);
}

export async function updateCalendarEvent(...args) {
  return __gcalModules.events.updateCalendarEvent(...args);
}


// verifica unavailability
function matchesUnavailability(...args) {
  return __gcalModules.availability.matchesUnavailability(...args);
}
export function isAvailable(...args) {
  return __gcalModules.availability.isAvailable(...args);
}

// calcola slot liberi
function computeSlots(...args) {
  return __gcalModules.availability.computeSlots(...args);
}

export async function getFreeSlotsForProfessional(...args) {
  return __gcalModules.availability.getFreeSlotsForProfessional(...args);
}

// ottiene slot per tutti i pro per un giorno
export async function getFreeSlotsForDay(...args) {
  return __gcalModules.availability.getFreeSlotsForDay(...args);
}

// --------- Utilities for fuzzy matching ---------
/**
 * Cancella un evento da Google Calendar gestendo errori specifici.
 * @param {string} eventId - ID dell'evento da cancellare.
 * @param {string} calendarId - ID del calendario (default 'primary').
 * @throws {Error} con codice 'EVENT_NOT_FOUND', 'PERMISSION_DENIED', 'QUOTA_EXCEEDED' o 'CANCEL_FAILED'
 */
export async function cancelCalendarEvent(...args) {
  return __gcalModules.events.cancelCalendarEvent(...args);
}

// --- COMPAT alias per chiamate vecchie ---
export const updateEvent = updateCalendarEvent;


// --- Compat per util.js: deleteEvent / cancelEvent ---
export async function deleteEvent(...args) {
  return __gcalModules.events.deleteEvent(...args);
}

export async function cancelEvent(...args) {
  return __gcalModules.events.cancelEvent(...args);
}


// Compatibility bridge. Module factories run after runtime config initialization.
const __gcalDependencies = {
  DATA_DIR,
  RETRY_BACKOFF_MS,
  RETRY_COUNT,
  SCOPES,
  __isoDow,
  _retry,
  buildTreatmentEvent,
  ensureCalendarAccess,
  fs,
  getCalendarClient,
  google,
  path,
  resolveCalendarId,
  retry,
  rrulestr,
};
const __gcalShared = {
  get services() { return services; },
  set services(value) { services = value; },
  get BUSINESS_HOURS() { return BUSINESS_HOURS; },
  set BUSINESS_HOURS(value) { BUSINESS_HOURS = value; },
  get MAX_OVERRUN() { return MAX_OVERRUN; },
  set MAX_OVERRUN(value) { MAX_OVERRUN = value; },
  get unavailability() { return unavailability; },
  set unavailability(value) { unavailability = value; },
  get holidays() { return holidays; },
  set holidays(value) { holidays = value; },
  get __runtimeConfig() { return __runtimeConfig; },
  set __runtimeConfig(value) { __runtimeConfig = value; },
  get __jwt() { return __jwt; },
  set __jwt(value) { __jwt = value; },
};
const __gcalModules = Object.create(null);
__gcalModules.auth = createCalendar0(__gcalDependencies, __gcalShared);
__gcalModules.retry = createCalendar1(__gcalDependencies, __gcalShared);
__gcalModules.events = createCalendar2(__gcalDependencies, __gcalShared);
__gcalModules.event_format = createCalendar3(__gcalDependencies, __gcalShared);
__gcalModules.availability = createCalendar4(__gcalDependencies, __gcalShared);

/** Change only event dates, never regenerate summary, attendees or client data. */
export async function patchCalendarSchedule({eventId, start, end, calendarId=process.env.CALENDAR_ID}) {
  if (!eventId || !calendarId || !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
    throw new TypeError('Invalid Calendar reschedule request');
  }
  const calendar = await getCalendarClient();
  return (await calendar.events.patch({ calendarId, eventId,
    requestBody: { start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() } },
    sendUpdates: 'all',
  })).data;
}
