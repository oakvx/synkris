// util.js — Gestione prenotazioni WhatsApp (ITA) — versione patchata
import os from "node:os";
import * as fsSync from "fs";
import path from "path";

import {
  getFreeSlotsForDay as _getFreeSlotsForDay,
  createCalendarEvent as _createCalendarEvent,
} from "./gcal.js";
import * as GCAL from "./gcal.js";
// --- mini lock per chat ---
const __busyChats = new Set();
const __delay = (ms) => new Promise((r) => setTimeout(r, ms));

// in cima al file, sopra ogni uso di config/bookings/chatdb
import {
  readJSON,
  writeJSON,
  initJSON,
  DATA_DIR,
  debugDataDir,
} from "./fs-json.js";
initJSON("config.json", {});
initJSON("bookings.json", []);
initJSON("chatdb.json", {});
// === SOFT-HOLD ===
initJSON("holds.json", []);
const HOLDS_PATH = path.join(DATA_DIR, "holds.json");
const HOLD_MINUTES = Number(process.env.SOFT_HOLD_MIN || 5);

const config = readJSON("config.json");
console.log("[DATA_DIR]", debugDataDir());

// Verifica file critici
const _cfg = readJSON("config.json", null);
if (!_cfg)
  console.error("ATTENZIONE: config.json non trovato o invalido in", DATA_DIR);
const _bk = readJSON("bookings.json", null);
if (!_bk)
  console.error(
    "ATTENZIONE: bookings.json non trovato o invalido in",
    DATA_DIR
  );

// ================= PATH & ChatDB =================
const CHATDB_PATH = path.join(DATA_DIR, "chatdb.json");

const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");
const CANCEL_POLICY_HOURS = 3;

// ============== Logger ==============
const LV = ["error", "warn", "info", "debug"];
const CUR = (process.env.LOG_LEVEL || "info").toLowerCase();
const okLevel = (l) => LV.indexOf(l) <= LV.indexOf(CUR);
function safeJSON(o) {
  try {
    return JSON.stringify(o);
  } catch {
    return "[circular]";
  }
}
function log(level, msg, payload = null) {
  const lvl = String(level || "").toLowerCase();
  if (!okLevel(lvl)) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${lvl.toUpperCase()}] ${msg}${
    payload ? " " + safeJSON(payload) : ""
  }`;
  (lvl === "error"
    ? console.error
    : lvl === "warn"
    ? console.warn
    : console.log)(line);
}

// === NEW === i18n minimale (IT/EN)
const MESSAGES = {
  it: {
    CHOOSE_SLOT_FOR_DAY: (day, lines, n) =>
      `📅 Disponibilità per il ${day}:\n${lines}\n(1-${n})`,
    INVALID_RANGE: (n) => `Scrivi un numero valido (1-${n}).`,
    CHOOSE_PRO_FOR_TIME: (hhmm, list, n) =>
      `Chi preferisci alle ${hhmm}?\n${list}\n(1-${n})`,
    NO_FUTURE_BOOKINGS: "Non ho trovato prenotazioni future col tuo numero.",
    PICK_BOOKING_TO_EDIT: (lines, n) =>
      `Quale prenotazione vuoi gestire?\n${lines}\n(1-${n})`,
  },
  en: {
    CHOOSE_SLOT_FOR_DAY: (day, lines, n) =>
      `📅 Availability for ${day}:\n${lines}\n(1-${n})`,
    INVALID_RANGE: (n) => `Please send a valid number (1-${n}).`,
    CHOOSE_PRO_FOR_TIME: (hhmm, list, n) =>
      `Who do you prefer at ${hhmm}?\n${list}\n(1-${n})`,
    NO_FUTURE_BOOKINGS:
      "I couldn't find any upcoming bookings for your number.",
    PICK_BOOKING_TO_EDIT: (lines, n) =>
      `Which booking do you want to manage?\n${lines}\n(1-${n})`,
  },
};

function detectLangHeuristic(text) {
  const t = String(text || "").toLowerCase();
  if (
    /(\bhi\b|\bhello\b|please|thanks|thank you|\btomorrow\b|\btoday\b)/.test(t)
  )
    return "en";
  if (/(\bciao\b|grazie|per favore|\bdomani\b|\boggi\b|prenota)/.test(t))
    return "it";
  return process.env.DEFAULT_LANG || "it";
}

function getLang(chatId) {
  const db = loadChatDB();
  return (
    (db && db[chatId] && db[chatId].lang) || process.env.DEFAULT_LANG || "it"
  );
}
function setLang(chatId, lang) {
  const db = loadChatDB();
  db[chatId] = db[chatId] || { msgs: [] };
  db[chatId].lang = lang === "en" ? "en" : "it";
  saveChatDB(db);
}
function ensureLang(chatId, text) {
  const db = loadChatDB();
  const current = db && db[chatId] && db[chatId].lang;
  if (!current) {
    setLang(chatId, detectLangHeuristic(text));
  }
}
function tr(chatId, key, ...args) {
  const lang = getLang(chatId);
  const pack = MESSAGES[lang] || MESSAGES.it;
  const msg = pack[key] || MESSAGES.it[key];
  return typeof msg === "function" ? msg(...args) : msg || key;
}

// ================= Bookings.json helpers =================
function loadBookings() {
  try {
    if (!fsSync.existsSync(BOOKINGS_PATH)) return [];
    const raw = fsSync.readFileSync(BOOKINGS_PATH, "utf8");
    if (!raw.trim()) return [];
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.bookings)) return data.bookings;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  } catch {
    return [];
  }
}
function saveBookings(arr) {
  try {
    const tmpPath = BOOKINGS_PATH + ".tmp";
    fsSync.writeFileSync(tmpPath, JSON.stringify(arr, null, 2), "utf8");
    fsSync.renameSync(tmpPath, BOOKINGS_PATH);
  } catch (e) {
    console.error("[bookings] save error:", e?.message || e);
  }
}
function persistBooking(rec) {
  const arr = loadBookings();
  arr.push(rec);
  saveBookings(arr);
}
function updateBookingByEventId(eventId, patch) {
  if (!eventId) return;
  const arr = loadBookings();
  let changed = false;
  for (const b of arr) {
    if (b.eventId === eventId) {
      Object.assign(b, patch);
      changed = true;
      break;
    }
  }
  if (changed) saveBookings(arr);
}

function updateBookingByComposite(match, patch) {
  try {
    if (!match) return false;
    const arr = loadBookings();
    let changed = false;
    const targetISO = new Date(match.startTime).toISOString();
    for (const b of arr) {
      const bISO = new Date(b.startTime).toISOString();
      const phoneA = String(b.clientPhone || "").trim();
      const phoneB = String(match.clientPhone || "").trim();
      if (bISO === targetISO && phoneA === phoneB) {
        Object.assign(b, patch);
        changed = true;
        break;
      }
    }
    if (changed) saveBookings(arr);
    return changed;
  } catch {
    return false;
  }
}

export function getUpcomingBookingByPhone(phone) {
  // === corpo di getUpcomingBookingByPhone ===
  try {
    const digits = (s) => String(s || "").replace(/\D/g, "");
    const normPhone = (s) => {
      let d = digits(s);
      // normalizza +39 / 0039 / 039
      d = d.replace(/^00?39/, "").replace(/^39/, "");
      return d;
    };
    const phoneMatch = (a, b) => {
      const A = normPhone(a);
      const B = normPhone(b);
      if (!A || !B) return false;
      if (A === B) return true;
      const min = 7;
      return A.endsWith(B.slice(-min)) || B.endsWith(A.slice(-min));
    };

    const rows = loadBookings();
    if (!Array.isArray(rows) || !rows.length) return null;

    const now = Date.now();
    const toTs = (b) =>
      Date.parse(b.startTime || b.start || b.date || b.datetime || "");

    const matches = rows
      .filter((b) => {
        if (!b) return false;
        const ts = toTs(b);
        if (!Number.isFinite(ts) || ts < now) return false; // solo future
        const status = String(b.status || b.state || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(status)) return false;
        const p =
          b.clientPhone ||
          b.phone ||
          b.customerPhone ||
          b.whatsapp ||
          b.contact ||
          "";
        return phoneMatch(p, phone);
      })
      .sort((a, b) => toTs(a) - toTs(b));

    const first = matches[0] || null;
    if (first && !first.service && first.serviceName)
      first.service = first.serviceName;
    return first;
  } catch (e) {
    log("warn", "getUpcomingBookingByPhone failed", e?.message || e);
    return null;
  }
}

export function getUserActiveBookingsAll(phone) {
  try {
    const raw = fsSync.readFileSync(BOOKINGS_PATH, "utf8");
    const data = raw.trim() ? JSON.parse(raw) : [];
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data.bookings)
      ? data.bookings
      : Array.isArray(data.rows)
      ? data.rows
      : [];

    const now = Date.now();
    const norm = (s) =>
      String(s || "")
        .replace(/\D/g, "")
        .replace(/^00?39/, "")
        .replace(/^39/, "");
    const pA = norm(phone);

    const out = rows
      .filter((b) => {
        const ts = Date.parse(b.startTime || b.start || "");
        if (!Number.isFinite(ts) || ts < now) return false;
        const st = String(b.status || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(st)) return false;
        const p = norm(b.clientPhone || b.phone || b.whatsapp || "");
        return p && p === pA;
      })
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

    for (const x of out)
      if (!x.service && x.serviceName) x.service = x.serviceName;
    return out;
  } catch {
    return [];
  }
}

function markBookingCancelled(eventId) {
  updateBookingByEventId(eventId, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  });
}

// ================= Soft-Hold helpers =================
function loadHolds() {
  try {
    if (!fsSync.existsSync(HOLDS_PATH)) return [];
    const raw = fsSync.readFileSync(HOLDS_PATH, "utf8");
    const arr = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveHolds(arr) {
  try {
    const tmp = HOLDS_PATH + ".tmp";
    fsSync.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
    fsSync.renameSync(tmp, HOLDS_PATH);
  } catch (e) {
    console.warn("[holds] save error:", e?.message || e);
  }
}
function cleanupHolds() {
  const now = Date.now();
  const arr = loadHolds();
  const next = arr.filter((h) => Number(h.expiresAt) > now);
  if (next.length !== arr.length) saveHolds(next);
  return next;
}
function getHoldIntervalsForDay(day, email, { ignoreChatId = null } = {}) {
  const D = day instanceof Date ? day : new Date(day);
  const start = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const arr = cleanupHolds();
  const out = [];
  for (const h of arr) {
    if (ignoreChatId && h.chatId === ignoreChatId) continue;
    if (
      email &&
      String(h.professionalEmail || "").toLowerCase() !==
        String(email || "").toLowerCase()
    )
      continue;
    const s = Number(h.startMs),
      e = Number(h.endMs);
    if (Number.isFinite(s) && Number.isFinite(e) && s < end && e > start)
      out.push([s, e]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}
function slotOverlapsExistingBookings(proEmail, s, e) {
  const day = new Date(s);
  const booked = getBusyIntervalsForDay(day, proEmail) || []; // include anche hold altrui (vedi patch sotto)
  for (const [bs, be] of booked) if (s < be && bs < e) return true;
  return false;
}
function acquireSoftHold({
  chatId,
  professionalEmail,
  startTime,
  durationMin,
}) {
  try {
    const s =
      startTime instanceof Date
        ? startTime.getTime()
        : new Date(startTime).getTime();
    const e = s + (Number(durationMin) || 30) * 60_000;
    const now = Date.now();
    let arr = cleanupHolds();

    // già tenuto da questo chat? aggiorna deadline
    for (const h of arr) {
      if (
        h.chatId === chatId &&
        h.professionalEmail === professionalEmail &&
        h.startMs === s
      ) {
        h.expiresAt = now + HOLD_MINUTES * 60_000;
        saveHolds(arr);
        return true;
      }
    }
    // conflitti con altri hold / booking
    for (const h of arr) {
      if (h.professionalEmail === professionalEmail) {
        if (s < h.endMs && h.startMs < e && h.chatId !== chatId) return false;
      }
    }
    if (slotOverlapsExistingBookings(professionalEmail, s, e)) return false;

    // crea hold
    arr.push({
      id: `${professionalEmail}|${s}|${chatId}|${now}`,
      professionalEmail,
      chatId,
      startMs: s,
      endMs: e,
      createdAt: now,
      expiresAt: now + HOLD_MINUTES * 60_000,
    });
    saveHolds(arr);
    return true;
  } catch {
    return false;
  }
}
function releaseSoftHoldByChat(chatId) {
  const arr = loadHolds();
  const next = arr.filter((h) => h.chatId !== chatId);
  if (next.length !== arr.length) saveHolds(next);
}

// ================= Review & Confirm followups =================
export function buildReviewMessage(b) {
  const name = b?.customerName ? ` ${b.customerName}` : "";
  const svc = b?.service || b?.serviceName || "il trattamento";
  const pro = b?.professionalName ? ` con ${b.professionalName}` : "";
  const link =
    (config?.reviews && config.reviews.googleLink) ||
    process.env.REVIEWS_LINK ||
    "";
  const linkLine = link ? `\nLasciaci una recensione qui: ${link}` : "";
  return `Ciao${name}! ✨ Com'è andata la ${svc}${pro}? Il tuo feedback ci aiuta a migliorare.${linkLine}`;
}

export async function reviewFollowupsTick(sendFn, opts = {}) {
  const { windowMinutes = 60, batchLimit = 20 } = opts;
  if (typeof sendFn !== "function")
    throw new Error("reviewFollowupsTick: sendFn mancante");

  const now = Date.now();
  const from = now - windowMinutes * 60_000;
  const arr = loadBookings();
  let sent = 0;

  if (!Array.isArray(arr)) return 0;

  for (const b of arr) {
    if (sent >= batchLimit) break;
    if (!b || b.status === "cancelled") continue;
    if (b.reviewAsked) continue;

    const startMs = Date.parse(b.startTime);
    const endMs = startMs + (Number(b.durationMin) || 0) * 60_000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    if (endMs <= now && endMs >= from) {
      try {
        await sendFn(b.clientPhone, buildReviewMessage(b));
        updateBookingByEventId(b.eventId, {
          reviewAsked: true,
          reviewAskedAt: new Date().toISOString(),
        });
        sent++;
      } catch (e) {
        console.warn("[reviewFollowupsTick] invio fallito:", e?.message || e);
      }
    }
  }
  return sent;
}

export function buildConfirmMessage(b) {
  const name = b?.customerName ? ` ${b.customerName}` : "";
  const svc = b?.service || "il trattamento";
  const pro = b?.professionalName ? ` con ${b.professionalName}` : "";
  const dt = b?.startTime ? new Date(b.startTime) : null;
  const dd = dt
    ? `${String(dt.getDate()).padStart(2, "0")}/${String(
        dt.getMonth() + 1
      ).padStart(2, "0")}`
    : "";
  const tt = dt
    ? `${String(dt.getHours()).padStart(2, "0")}:${String(
        dt.getMinutes()
      ).padStart(2, "0")}`
    : "";
  return `Ciao${name}! Promemoria: ${svc}${pro} il ${dd} alle ${tt}. Non vediamo l'ora di vederti ❤!`;
}

/**
 * Semplice tick di conferma: manda un promemoria qualche ora prima.
 * Evita crash se il file non è un array.
 */
export async function confirmAppointmentsTick(sendFn, opts = {}) {
  const { aheadMinutes = 180, batchLimit = 20 } = opts;
  if (typeof sendFn !== "function")
    throw new Error("confirmAppointmentsTick: sendFn mancante");

  const now = Date.now();
  const to = now + aheadMinutes * 60_000;
  const arr = loadBookings();
  let sent = 0;

  if (!Array.isArray(arr)) return 0;

  for (const b of arr) {
    if (sent >= batchLimit) break;
    if (!b || b.status === "cancelled") continue;

    const startMs = Date.parse(b.startTime);
    if (!Number.isFinite(startMs)) continue;
    if (startMs >= now && startMs <= to && !b.confirmAsked) {
      try {
        await sendFn(b.clientPhone, buildConfirmMessage(b));
        updateBookingByEventId(b.eventId, {
          confirmAsked: true,
          confirmAskedAt: new Date().toISOString(),
        });
        sent++;
      } catch (e) {
        console.warn(
          "[confirmAppointmentsTick] invio fallito:",
          e?.message || e
        );
      }
    }
  }
  return sent;
}

// ================= ChatDB helpers =================
function loadChatDB() {
  try {
    if (!fsSync.existsSync(CHATDB_PATH)) return {};
    const raw = fsSync.readFileSync(CHATDB_PATH, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveChatDB(db) {
  // === corpo di saveChatDB ===
  try {
    const tmp = CHATDB_PATH + ".tmp";
    const json = JSON.stringify(db, null, 2);
    fsSync.writeFileSync(tmp, json, "utf8");
    fsSync.renameSync(tmp, CHATDB_PATH);
  } catch (e) {
    console.warn("[chatdb] save error:", e?.message || e);
  }
}
function appendUserMessage(chatId, text) {
  const db = loadChatDB();
  db[chatId] = db[chatId] || { msgs: [] };
  db[chatId].msgs.push(String(text || "").slice(0, 800));
  if (db[chatId].msgs.length > 5) db[chatId].msgs = db[chatId].msgs.slice(-5);
  saveChatDB(db);
}
function getRecentMessages(chatId) {
  const db = loadChatDB();
  return db?.[chatId]?.msgs || [];
}
function getLastService(chatId) {
  const arr = loadBookings()
    .filter((b) => b.clientPhone === chatId && b.status === "confirmed")
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  return arr[0]?.service || null;
}
function getLastInfoTopic(_) {
  return null;
}
function rememberService(_) {}
function rememberInfoTopic(_) {}

// ============== Safe send & reply (+ booking footer) ==============
export async function safeSend(client, chatId, text, opts = {}) {
  const t = String(text ?? "");
  if (!t.trim()) return "";
  try {
    if (client?.sendText) await client.sendText(chatId, t);
  } catch (e) {
    log("warn", "safeSend", e?.message || e);
  }
  // Footer automatico per il flow di prenotazione (messaggio separato)
  try {
    await postReplyHook(client, chatId, t, opts);
  } catch {}
  return t;
}

// wrapper usato ovunque nel flow
async function reply(client, chatId, text, opts = {}) {
  return safeSend(client, chatId, text, opts);
}
// === Footer automatico per il flow booking ===
async function postReplyHook(client, chatId, sentText, opts = {}) {
  try {
    if (opts?.noFooter) return;

    const st = pending.get(chatId);
    const col = st?.collected || {};
    const active = isBookingFlowActive(st, col) || isBookingLocked(st);
    if (!active) return;

    // evita loop: se il messaggio appena inviato È già il footer, non reinviare
    const FOOTER = '❌ Se non vuoi più prenotare, digita "annulla".';
    if (String(sentText || "").includes('digita "annulla"')) return;

    await safeSend(client, chatId, FOOTER, { noFooter: true });
  } catch (e) {
    log("warn", "postReplyHook", e?.message || e);
  }
}

// ============== LLM Output Sanitization ==============
const CHATML_STOPS = [
  "<|im_start|>system",
  "<|im_start|>user",
  "<|im_start|>assistant",
  "</s>",
  "<think>",
  "</think>",
];

function stripStopsAndTags(raw) {
  if (!raw) return "";
  let s = String(raw);
  // rimuovi codefence esterno (se presente)
  s = s.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "");
  for (const tok of CHATML_STOPS) s = s.split(tok).join("");
  s = s.replace(/<\|im_end\|>/g, "");
  return s.trim();
}

function stripThinkBlocks(s) {
  s = String(s || "");
  // tutte le varianti note di "pensiero"
  s = s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```think[\s\S]*?```/gi, "")
    .replace(/\[think\][\s\S]*?\[\/think\]/gi, "")
    // extra robustness per altri tag usati da alcuni modelli
    .replace(
      /<(analysis|reasoning|scratchpad|chain_of_thought)>[\s\S]*?<\/\1>/gi,
      ""
    );
  return s;
}

function extractJSONObject(text) {
  // >>> fondamentale: ignoriamo QUALSIASI JSON dentro i blocchi di pensiero
  const s = stripStopsAndTags(stripThinkBlocks(text));
  let start = -1,
    depth = 0,
    inStr = false,
    esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) return s.slice(start, i + 1);
    }
  }
  return "";
}

function parseJsonMessage(raw) {
  const json = extractJSONObject(raw);
  if (!json) return "";
  try {
    const o = JSON.parse(json);
    // supporta chiavi comuni
    const msg =
      o?.message ??
      o?.response ??
      o?.answer ??
      o?.content ??
      o?.text ??
      o?.output;
    return (msg || "").toString().trim();
  } catch {
    return "";
  }
}

function sanitizeLLM(raw) {
  const s = stripStopsAndTags(stripThinkBlocks(raw || ""));
  const parsed = parseJsonMessage(s); // se il modello ha messo un JSON con "message"/"response"
  return (parsed || s).trim();
}

// ============== QA Adapter (Ollama/injection) ==============
let QA_ASK = null;
let GREET_COOLDOWN_MS = 180000;
export function configure({ qaAsk, greetCooldownMs } = {}) {
  if (qaAsk) QA_ASK = qaAsk;
  if (greetCooldownMs) GREET_COOLDOWN_MS = greetCooldownMs;
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}
// === MISSING HELPERS (drop-in) ===============================================

// ISO locale senza "Z" (coerente con Google Calendar wrappers)
function toISOStringLocal(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60_000);
  // yyyy-mm-ddThh:mm:ss
  return local.toISOString().slice(0, 19);
}

// Giorni del mese (year = intero, monthIdx = 0..11)
function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

// Etichetta mese in italiano
function monthLabelIT(idx) {
  const m = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ];
  return m[idx] ?? "";
}

// Nome giorno settimana in italiano
function itaWeekdayName(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const names = [
    "Domenica",
    "Lunedì",
    "Martedì",
    "Mercoledì",
    "Giovedì",
    "Venerdì",
    "Sabato",
  ];
  return names[d.getDay()];
}

// Lunedì..Domenica della *prossima* settimana (a mezzogiorno per neutralizzare i fusi)
function listNextWeekDays() {
  const now = new Date();
  const isoToday = now.getDay() === 0 ? 7 : now.getDay(); // 1..7
  const deltaToNextMon = (8 - isoToday) % 7 || 7; // giorni fino al prossimo lunedì
  const mon = new Date(now);
  mon.setDate(now.getDate() + deltaToNextMon);
  mon.setHours(12, 0, 0, 0);
  return Array.from(
    { length: 7 },
    (_, i) =>
      new Date(
        mon.getFullYear(),
        mon.getMonth(),
        mon.getDate() + i,
        12,
        0,
        0,
        0
      )
  );
}

// Prompt testuale quando chiedi “che giorno di <mese>?”
function buildAskDayOfMonthPrompt(year, monthIdx) {
  const max = daysInMonth(year, monthIdx);
  return `Quale giorno di ${monthLabelIT(monthIdx)} ${year}? (1-${max})`;
}

// Vuole aprire il menu “modifica appuntamento”?
function wantsEditMenu(text) {
  const s = norm(text || "");
  return /^\/?modifica\b/.test(s) ||
  (/\b(modifica|gestisci|cambia|sposta|annulla)\b/.test(s) &&
    /\b(appunt|prenot)\w*/.test(s)) ||
  (/\b(appunt|prenot)\w*/.test(s) &&
    /\b(modifica|gestisci|cambia|sposta|annulla)\b/.test(s));
}

// Estrai “topic” informativo minimale dalla frase (per guidare il prompt QA)
function extractInfoTopic(text) {
  const s = norm(text || "");
  if (/\bhenne|henn[eè]\b/.test(s)) return "henné";
  if (/\ballerg\w*/.test(s)) return "allergie";
  if (/\bprezz|costo|tariff\w*/.test(s)) return "prezzo";
  if (/\bdurat|quanto\s+dura\b/.test(s)) return "durata";
  if (/\bcontroindic|effetti\b/.test(s)) return "controindicazioni";
  return null; // “generico”
}

// Costruisci un prompt pulito per askQA (Ollama)
function composeInfoPrompt(service = null, topic = null) {
  const head = `Sei l'assistente di un salone. Rispondi in italiano, chiaro e utile per i clienti.`;
  const ctxS = service ? `Servizio: ${service}.` : "";
  const ctxT = topic ? `Topic: ${topic}.` : "";
  const rules = [
    "Max 5 frasi, niente gergo tecnico inutile.",
    "Se ci sono precauzioni o allergeni tipici, menzionali.",
    "Niente link, niente “pensa ad alta voce”.",
  ].join(" ");
  return `${head}\n${ctxS} ${ctxT}\n${rules}`;
}

function baseCandidates() {
  const url = (process.env.OLLAMA_URL || "").trim();
  return url ? [url] : ["http://127.0.0.1:11434", "http://localhost:11434"];
}

// ============== QA Adapter (Ollama/injection) ==============
export async function askQA(prompt, context, client) {
  log(
    "info",
    "[AI MODEL IN USE]",
    (process.env.OLLAMA_MODEL || "llama3whatsapp").trim()
  );
  // ---- helpers locali (snelli) ----
  const _log = (lvl, msg, payload) => {
    if (typeof log === "function") return log(lvl, msg, payload);
    (lvl === "error"
      ? console.error
      : lvl === "warn"
      ? console.warn
      : console.log)(msg, payload || "");
  };

  const parseKeepAlive = () => {
    const raw = String(
      process.env.OLLAMA_KEEP_ALIVE ?? process.env.OLLAMA_KEEP_ALIVE_MS ?? ""
    ).trim();
    if (!raw) return "10m";
    if (/^\d+$/.test(raw)) return `${raw}ms`; // numeri nudi -> ms
    if (/^\d+\s*(ns|us|µs|ms|s|m|h)$/i.test(raw)) return raw; // già con unità
    _log("warn", "[OLLAMA] keep_alive non valido, uso 10m", { raw });
    return "10m";
  };

  const chooseBase = () => {
    const url = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").trim();
    if (
      !process.env.OLLAMA_ALLOW_REMOTE &&
      !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)
    ) {
      _log(
        "warn",
        "[OLLAMA] host non-loopback bloccato senza OLLAMA_ALLOW_REMOTE, fallback 127.0.0.1",
        { url }
      );
      return "http://127.0.0.1:11434";
    }
    return url;
  };

  const normalizePrompt = (built) => {
    if (Array.isArray(built)) return { type: "chat", messages: built };
    if (built && typeof built === "object" && Array.isArray(built.messages))
      return { type: "chat", messages: built.messages };
    if (built && typeof built === "object" && (built.text || built.prompt))
      return { type: "text", text: String(built.text || built.prompt) };
    if (typeof built === "string") return { type: "text", text: built };
    return { type: "text", text: JSON.stringify(built ?? "") };
  };

  const makeStringPrompt = (q, ctx) => {
    const qq = String(q ?? "").trim();
    const cc = String(ctx ?? "").trim();
    return `${
      cc ? cc + "\n\n" : ""
    }DOMANDA: ${qq}\n\nRISPOSTA breve, chiara, amichevole:`;
  };

  // sostituisci la tua postJSON con questa (retry + timeout più lunghi)
  const postJSON = async (
    url,
    body,
    timeouts = [
      Number(process.env.OLLAMA_HTTP_TIMEOUT_MS || 15000), // 1° tentativo (normale)
      Number(process.env.OLLAMA_HTTP_TIMEOUT_COLD_MS || 60000), // 2° tentativo (cold start)
    ]
  ) => {
    for (let i = 0; i < timeouts.length; i++) {
      const timeoutMs = timeouts[i] > 0 ? timeouts[i] : 15000;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const txt = await res.text();
        if (!res.ok) {
          log?.("warn", "ollama qa not ok", {
            base: url.replace(/\/api\/.+$/, ""),
            status: res.status,
            body: txt,
          });
          // su 5xx, 408, 429 riprovo se ho ancora tentativi
          if (
            i < timeouts.length - 1 &&
            /^(5|408|429)/.test(String(res.status))
          )
            continue;
          return null;
        }
        return txt ? JSON.parse(txt) : {};
      } catch (e) {
        // aborted / ECONNRESET / ecc.: riprova se ho ancora un tentativo
        log?.("warn", "ollama qa not ok", {
          base: url.replace(/\/api\/.+$/, ""),
          status: "fetch_error",
          body: String(e?.message || e),
        });
        if (i < timeouts.length - 1) continue;
        return null;
      } finally {
        clearTimeout(to);
      }
    }
    return null;
  };

  // ---- setup modello ----
  const base = chooseBase();
  const keep_alive = parseKeepAlive();
  const model = (process.env.OLLAMA_MODEL || "llama3whatsapp").trim();
  const options = {
    num_ctx: Number(process.env.OLLAMA_NUM_CTX || 4096),
    num_thread: Number(process.env.OLLAMA_NUM_THREAD || 0) || undefined,
    temperature: Number(process.env.OLLAMA_TEMP || 0.2),
  };

  const built = makeStringPrompt(prompt, context);
  const norm = normalizePrompt(built);

  // ---- chiamata Ollama ----
  if (norm.type === "chat") {
    // /api/chat con messages[]
    const body = {
      model,
      messages: norm.messages,
      stream: false,
      keep_alive,
      options,
    };
    const out = await postJSON(`${base}/api/chat`, body);
    return (
      out &&
      (out.message?.content || out.content || out.response || "")
    ).trim();
  } else {
    // /api/generate con prompt stringa
    const body = {
      model,
      prompt: norm.text || makeStringPrompt(prompt, context),
      stream: false,
      keep_alive,
      options,
    };
    const out = await postJSON(`${base}/api/generate`, body);
    return (out && (out.response || out.content || "")).trim();
  }
}

export async function warmOllama() {
  const bases =
    typeof baseCandidates === "function"
      ? baseCandidates()
      : [(process.env.OLLAMA_URL || "http://127.0.0.1:11434").trim()];

  const model = (process.env.OLLAMA_MODEL || "llama3whatsapp").trim();
  const keepAlive =
    typeof parseDurationEnv === "function"
      ? parseDurationEnv({ def: "72h" })
      : "72h";

  const options = {
    num_ctx: Number(process.env.OLLAMA_NUM_CTX || 4096),
    num_thread: Number(process.env.OLLAMA_NUM_THREAD || 0) || undefined,
    temperature: Number(process.env.OLLAMA_TEMP || 0.2),
  };

  // payload corretti per i due endpoint
  const bodyGenerate = {
    model,
    prompt: "ok", // <<< stringa, NON oggetto
    stream: false,
    keep_alive: keepAlive,
    options,
  };
  const bodyChat = {
    model,
    messages: [{ role: "user", content: "ok" }],
    stream: false,
    keep_alive: keepAlive,
    options,
  };

  for (const base of bases) {
    // 1) prova /api/generate (carica modello e lo tiene vivo)
    try {
      const res = await fetchWithTimeout?.(
        `${base}/api/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify(bodyGenerate),
        },
        Number(process.env.OLLAMA_WARM_TIMEOUT_MS || 15000)
      );
      if (res?.ok || typeof res === "object") {
        log?.("info", `Ollama warm (generate) @ ${base}`, { model });
        return;
      }
    } catch {}

    // 2) fallback /api/chat (scalda anche il percorso chat)
    try {
      const res = await fetchWithTimeout?.(
        `${base}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify(bodyChat),
        },
        Number(process.env.OLLAMA_WARM_TIMEOUT_COLD_MS || 60000) // più lungo per cold start
      );
      if (res?.ok || typeof res === "object") {
        log?.("info", `Ollama warm (chat) @ ${base}`, { model });
        return;
      }
    } catch {}
  }

  // se nessuna base è andata, logga ma non bloccare l’avvio
  log?.("warn", "Ollama warm fallito su tutte le basi", { model, bases });
}

// ============== Intent Classifier (Ollama) ==============
const INTENT_LABELS = new Set([
  "appointment",
  "info",
  "price",
  "greeting",
  "other",
]);
async function classifyIntent(userText) {
  const bases = baseCandidates();
  const model = (process.env.OLLAMA_INTENT_MODEL || "intent-it:latest").trim();
  const keepAlive = parseDurationEnv({ def: "72h" });
  const tFirst = Math.max(+process.env.OLLAMA_INTENT_TIMEOUT_MS || 8000, 4000);
  const timeouts = [tFirst, Math.max(tFirst * 2, 12000)];
  const sysIT = `Sei un classificatore di intent per un assistente WhatsApp di un salone.
Rispondi con UNA sola etichetta (minuscola): appointment | info | price | greeting | other
Regole:
- Solo la label, senza spiegazioni, niente <think>, niente punteggiatura.
- Se chiede info e vuole anche prenotare → appointment.
- Prezzi/listino/tariffe/sconti → price.
- Solo saluti/small talk senza richiesta concreta → greeting.
- Dubbi o fuori tema → other.`;
  const promptIT = `Messaggio: """${String(userText || "").trim()}"""
Rispondi solo con una delle etichette: appointment | info | price | greeting | other`;
  const build = (msg) => ({
    model,
    prompt: `<|system|>\n${sysIT}\n<|end|>\n<|user|>\n${msg}\n<|end|>\n<|assistant|>\n`,
    stream: false,
    options: {
      temperature: 0,
      num_ctx: 1024,
      repeat_penalty: 1.1,
      keep_alive: keepAlive,
      stop: ["\n"],
    },
  });
  for (const base of bases) {
    for (const to of timeouts) {
      try {
        const res = await fetchWithTimeout(
          `${base}/api/generate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(build(promptIT)),
          },
          to
        );
        if (!res.ok) {
          let body = "";
          try {
            body = await res.text();
          } catch {}
          log("warn", "ollama qa not ok", { base, status: res.status, body });
          continue;
        }
        const data = await res.json();
        let out = sanitizeLLM(data?.response || "").toLowerCase();
        out = out.split(/[^\p{L}]+/u).find((w) => INTENT_LABELS.has(w)) || out;
        if (!INTENT_LABELS.has(out)) out = "other";
        return out;
      } catch (e) {
        log("warn", "intent classify error", e?.message || e);
      }
    }
  }
  return "other";
}

// ============== Stato conversazione ==============
const pending = new Map();
const greetMemory = new Map(); // chatId -> ts ultimo saluto

const BOOKING_LOCK_MS = 10 * 60 * 1000; // 10 minuti
function now() {
  return Date.now();
}

function lockBooking(state) {
  state.context.lock = { type: "appointment", until: now() + BOOKING_LOCK_MS };
}

function ensureContext(st) {
  if (!st) return;
  st.context = st.context || {};
  st.context.lock = st.context.lock || { active: false, ts: 0, ttl: null };
  if (!st.context.lock.ttl) {
    const envTtl = Number(process.env.BOOKING_LOCK_TTL_MS || 300000); // 5 min
    st.context.lock.ttl = Number.isFinite(envTtl) ? envTtl : 300000;
  }
}

function isBookingLocked(st) {
  if (!st?.context?.lock) return false;
  const { active, ts, ttl } = st.context.lock;
  if (!active) return false;
  if (!ts || Date.now() - ts > (ttl || 300000)) {
    st.context.lock.active = false; // scaduto → sblocca
    return false;
  }
  return true;
}

function bumpBookingLock(st) {
  if (!st) return;
  ensureContext(st);
  st.context.lock.active = true;
  st.context.lock.ts = Date.now();
}

function unlockBooking(st) {
  try {
    if (st?.context?.lock) {
      st.context.lock.active = false;
      st.context.lock.ts = 0;
    }
  } catch {}
}

function isBookingFlowActive(state, col) {
  return !!(state && state.step && state.step !== "collect");
}

// ============== Utility: parsing e vari ==============
function escapeReg(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function listToOptions(arr) {
  return arr.map((v, i) => `${i + 1}) ${v}`).join("\n");
}
function fmtDate(d) {
  const D = new Date(d);
  return `${String(D.getDate()).padStart(2, "0")}/${String(
    D.getMonth() + 1
  ).padStart(2, "0")}/${D.getFullYear()}`;
}

function timeToMinutes(hhmm) {
  const parts = String(hhmm || "").split(":");
  const h = Number(parts[0] || 0);
  const m = Number(parts[1] || 0);
  return h * 60 + (m || 0);
}

function minutesToHHMM(min) {
  const H = Math.floor(min / 60);
  const M = min % 60;
  const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
  return `${pad2(H)}:${pad2(M)}`;
}
function compareHHMM(a, b) {
  return timeToMinutes(a) - timeToMinutes(b);
}
function parseNaturalTime(s = "") {
  const t = norm(s);

  // "9 e 30" / "alle 9 e 30"
  { const m = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*e\s*([0-5]?\d)\b/);
    if (m) return `${String(+m[1]).padStart(2,"0")}:${String(+m[2]).padStart(2,"0")}`; }

  // "e mezza" / "e un quarto" / "e venti" / "e dieci" / "e cinque"
  { const wordMin = { mezza:30, mezzo:30, trenta:30, "un quarto":15, quarto:15, quindici:15, venti:20, dieci:10, cinque:5 };
    const m = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*e\s+([a-z\s]+)\b/);
    if (m) { const h = +m[1], w = m[2].trim();
      const k = Object.keys(wordMin).find(k => new RegExp(`\\b${k}\\b`).test(w));
      if (k) return `${String(h).padStart(2,"0")}:${String(wordMin[k]).padStart(2,"0")}`; } }

  // "10 meno 20" / "10 meno un quarto"
  { const wordMin = { "un quarto":15, quarto:15, venti:20, dieci:10, cinque:5 };
    const mNum = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*meno\s*([0-5]?\d)\b/);
    if (mNum) { const h = (+mNum[1] - 1 + 24) % 24, min = 60 - (+mNum[2]);
      return `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`; }
    const mWord = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*meno\s+([a-z\s]+)\b/);
    if (mWord) { const h = (+mWord[1] - 1 + 24) % 24, w = mWord[2].trim();
      const k = Object.keys(wordMin).find(k => new RegExp(`\\b${k}\\b`).test(w));
      if (k) return `${String(h).padStart(2,"0")}:${String(60 - wordMin[k]).padStart(2,"0")}`; } }

  // "ore 9" / "h9" / "alle 9" -> 09:00
  { const m = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\b/);
    if (m) return `${String(+m[1]).padStart(2,"0")}:00`; }

  // "9.30" / "9,30" / "9 30" / "09 30"
  { const m = t.match(/\b([01]?\d|2[0-3])[\.\,\s:]([0-5]\d)\b/);
    if (m) return `${String(+m[1]).padStart(2,"0")}:${String(+m[2]).padStart(2,"0")}`; }

  // "930" -> 09:30
  { const m = t.match(/\b(\d{3,4})\b/);
    if (m) { const n = m[1]; if (n.length===3) return `0${n[0]}:${n.slice(1)}`; if (n.length===4) return `${n.slice(0,2)}:${n.slice(2)}`; } }

  // "mezzogiorno" / "mezzanotte"
  if (/\bmezzogiorn/i.test(t)) return "12:00";
  if (/\bmezzanott/i.test(t)) return "00:00";

  return null;
}
function parseTimeSmart(s = "") { return parseHHMM(s) || parseNaturalTime(s); }


function parseHHMM(s) {
  const t = (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ");
  let m = t.match(/\b([01]?\d|2[0-3])[:.,]?\s?([0-5]\d)\b/);
  if (m)
    return `${String(+m[1]).padStart(2, "0")}:${String(+m[2]).padStart(
      2,
      "0"
    )}`;
  m = t.match(/\b([01]?\d|2[0-3])\b/);
  if (m) return `${String(+m[1]).padStart(2, "0")}:00`;
  return null;
}
function atNoon(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  return d;
}
function isoWeekday(d) {
  const D = d instanceof Date ? d : new Date(d);
  const day = D.getDay();
  return String(day === 0 ? 7 : day);
}
function nextWeekday(dayIndex) {
  const d = new Date();
  const today = d.getDay();
  const delta = (dayIndex + 7 - (today === 0 ? 7 : today)) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}
function itaMonthToIndex(m) {
  const months = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ];
  const short = [
    "gen",
    "feb",
    "mar",
    "apr",
    "mag",
    "giu",
    "lug",
    "ago",
    "set",
    "ott",
    "nov",
    "dic",
  ];
  const s = String(m || "").toLowerCase();
  let idx = short.indexOf(s);
  if (idx >= 0) return idx;
  idx = months.indexOf(s);
  return idx >= 0 ? idx : null;
}
function nextOpenDay(fromDate) {
  const d = new Date(fromDate);
  for (let i = 0; i < 14; i++) {
    if (!cfgClosedDay(d)) return atNoon(d);
    d.setDate(d.getDate() + 1);
  }
  return atNoon(fromDate);
}
function simpleNorm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setTime(date, hhmm) {
  const parts = String(hhmm || "00:00").split(":");
  const H = Number(parts[0] || 0);
  const M = Number(parts[1] || 0);
  const d = new Date(date);
  d.setHours(H, M || 0, 0, 0);
  return d;
}
function isPast(date) {
  return date.getTime() < Date.now();
}

function parseRelativeDay(s) {
  const t = norm(s);
  const base = new Date();

  if (/\boggi\b/.test(t)) return atNoon(base);
  if (/\bdomani\b/.test(t)) { const d = new Date(base); d.setDate(d.getDate() + 1); return atNoon(d); }
  if (/\bdopodomani\b/.test(t)) { const d = new Date(base); d.setDate(d.getDate() + 2); return atNoon(d); }

  // "tra 2 giorni" / "fra 3 giorni"
  {
    const m = t.match(/\b(fr|tr)a\s+(\d+)\s+giorn/i);
    if (m) { const add = parseInt(m[2], 10); if (!isNaN(add)) { const d = new Date(base); d.setDate(d.getDate() + add); return atNoon(d); } }
  }

  // "prossimo lunedi" / "lunedì prossimo"
  {
    const m = t.match(/\b(prossim[oa])\s+(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/i)
           || t.match(/\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\s+prossim[oa]\b/i);
    if (m) {
      const word = (m[2] || m[1]).toLowerCase();
      const map = { lunedi:1, martedi:2, mercoledi:3, giovedi:4, venerdi:5, sabato:6, domenica:0 };
      const target = map[word] ?? null;
      if (target !== null) {
        const cand = atNoon(base);
        const nowDow = cand.getDay();
        let diff = (target + 7 - nowDow) % 7;
        if (diff === 0) diff = 7;
        cand.setDate(cand.getDate() + diff);
        return cand;
      }
    }
  }

  // "weekend" -> sabato
  if (/\bweekend\b/.test(t)) {
    const d = new Date(base);
    const dow = d.getDay();
    const diff = (6 + 7 - dow) % 7;
    d.setDate(d.getDate() + diff);
    return atNoon(d);
  }

  // GG/MM, GG-MM, GG.MM (anno opzionale)
  const m1 = t.match(/\b(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?\b/);
  if (m1) {
    const dd = +m1[1], mm = +m1[2], yy = m1[3] ? +m1[3] : new Date().getFullYear();
    return new Date(yy, mm - 1, dd, 12, 0, 0, 0);
  }

  // Giorni della settimana (accenti inclusi)
  const map = { lunedì:1,lunedi:1, martedì:2,martedi:2, mercoledì:3,mercoledi:3, giovedì:4,giovedi:4, venerdì:5,venerdi:5, sabato:6, domenica:0 };
  for (const [k, v] of Object.entries(map)) {
    if (new RegExp(`\\b${k}\\b`, 'i').test(t)) {
      const now = new Date(base);
      const cand = atNoon(now);
      const nowDow = now.getDay();
      let diff = (v + 7 - nowDow) % 7;
      if (diff === 0) diff = 7;
      cand.setDate(cand.getDate() + diff);
      return cand;
    }
  }
  return null;
}


function norm(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// ============== Riconoscimento servizio ==============
function cfgServices() {
  return Object.keys(config.services || {});
}
function cfgServiceItem(name) {
  return config.services?.[name] || null;
}
function cfgServiceSynonyms(service) {
  const it = cfgServiceItem(service) || {};
  const syns = Array.isArray(it.synonyms) ? it.synonyms : [];
  return syns;
}
function cfgServiceDuration(name) {
  const it = cfgServiceItem(name) || {};
  return Number(it.durationMin || it.duration || 0) || 30;
}
function cfgServiceProfessionals(service) {
  const it = cfgServiceItem(service) || {};
  const list = Array.isArray(it.professionals) ? it.professionals : [];
  return list
    .map((v) =>
      v.includes("@")
        ? { name: config.professionals?.[v]?.name || v, email: v }
        : { name: v, email: proEmailByName(v) || null }
    )
    .filter((x) => x.name);
}
function cfgServicePriceText(name) {
  const it = cfgServiceItem(name) || {};
  return typeof it.price === "number"
    ? `${it.price}€`
    : it.price || "prezzo su richiesta";
}
function cfgAllergensForService(service) {
  const it = cfgServiceItem(service) || {};
  let arr = it.allergens || it.allergenes || [];
  if (typeof arr === "string") {
    arr = arr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return Array.isArray(arr) ? arr : [];
}
function getAllergens(service) {
  const set = new Set(
    cfgAllergensForService(service).map((a) => a.toLowerCase())
  );
  return Array.from(set);
}
function fuzzyService(text) {
  const input = norm(text);
  let best = { service: null, dist: Infinity };
  for (const service of cfgServices()) {
    const dist = levenshtein(norm(service), input);
    if (dist < best.dist) best = { service, dist };
    for (const syn of cfgServiceSynonyms(service)) {
      const dsyn = levenshtein(norm(syn), input);
      if (dsyn < best.dist) best = { service, dist: dsyn };
    }
  }
  return best.dist <= 2 ? best.service : null;
}
function levenshtein(a, b) {
  const al = a.length,
    bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const dp = Array.from({ length: al + 1 }, (_, i) => Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[al][bl];
}
function resolveServiceFromText(t) {
  const q = norm(t);
  const svcs = cfgServices();
  const cands = [];

  for (const service of svcs) {
    const sName = norm(service);
    if (q.includes(sName)) {
      cands.push({
        service,
        kind: "name",
        len: sName.length,
        allergens: getAllergens(service).length,
        idx: svcs.indexOf(service),
      });
    }
    for (const syn of cfgServiceSynonyms(service)) {
      const sSyn = norm(syn);
      if (q.includes(sSyn)) {
        cands.push({
          service,
          kind: "syn",
          len: sSyn.length,
          allergens: getAllergens(service).length,
          idx: svcs.indexOf(service),
        });
      }
    }
  }
  if (!cands.length) return null;

  // Ordina per: sinonimo>nome, match più lungo, più allergeni, poi ordine stabile
  cands.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "syn" ? -1 : 1;
    if (a.len !== b.len) return b.len - a.len;
    if (a.allergens !== b.allergens) return b.allergens - a.allergens;
    return a.idx - b.idx;
  });
  return cands[0].service;
}

// ===== Booking intent detectors =====

function looksLikeBooking(t) {
  return hasBookingVerb(t) || hasDateOrTime(t) || !!fuzzyService(t);
}

// ============== Orari: calcolo slot con pro per slot ==============
function intervalsFromSpec(spec, day) {
  if (!spec) return [];
  const D = day instanceof Date ? day : new Date(day);
  const toMs = (hhmm) => {
    const [H, M] = String(hhmm || "")
      .split(":")
      .map(Number);
    return new Date(
      D.getFullYear(),
      D.getMonth(),
      D.getDate(),
      H || 0,
      M || 0,
      0,
      0
    ).getTime();
  };
  const out = [];
  if (Array.isArray(spec) && spec.every((x) => typeof x === "string")) {
    const arr = spec;
    if (arr.length === 2) {
      const s = toMs(arr[0]),
        e = toMs(arr[1]);
      if (e > s) out.push([s, e]);
      return out;
    }
    if (arr.length >= 4 && arr.length % 2 === 0) {
      for (let i = 0; i < arr.length; i += 2) {
        const s = toMs(arr[i]),
          e = toMs(arr[i + 1]);
        if (e > s) out.push([s, e]);
      }
      return out;
    }
  }
  const arr = Array.isArray(spec) ? spec : [spec];
  for (const item of arr) {
    if (!item) continue;
    if (Array.isArray(item) && item.length === 2) {
      const s = toMs(item[0]);
      const e = toMs(item[1]);
      if (e > s) out.push([s, e]);
    } else if (typeof item === "string" && item.includes("-")) {
      const [a, b] = item.split("-");
      const s = toMs(a);
      const e = toMs(b);
      if (e > s) out.push([s, e]);
    } else if (typeof item === "object" && item.start && item.end) {
      const s = toMs(item.start);
      const e = toMs(item.end);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}
function getBusyIntervalsForDay(day, email) {
  const D = day instanceof Date ? day : new Date(day);
  const start = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const arr = loadBookings();
  const out = [];
  for (const b of arr) {
    if (!b || b.status === "cancelled") continue;
    if (email && b.professionalEmail && b.professionalEmail !== email) continue;
    const s = Date.parse(b.startTime);
    const e = s + (Number(b.durationMin) || 0) * 60_000;
    if (Number.isFinite(s) && Number.isFinite(e) && s < end && e > start)
      out.push([s, e]);
  }
  // ⬇️ aggiungi gli hold attivi per il giorno/pro
  const held = getHoldIntervalsForDay(D, email) || [];
  out.push(...held);

  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// === NEW === Slot SOLO per un professionista (rispetta orari, pause, indisponibilità e booking del pro)
export async function fetchSlotsForProfessional({
  service = null,
  day,
  duration = null,
  professional,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return [];

  // Risolvi email dal nome, se serve
  const email =
    professional && professional.includes("@")
      ? professional
      : proEmailByName(professional);
  if (!email) return [];

  // Durata (servizio -> durataMin) o fallback 30'
  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    const svc0 = service && (config.services?.[service] || null);
    durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
  }
  const durMs = durMin * 60_000;
  const stepMs = durMs;

  const toYMD = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  // Giorno chiuso?
  const closedDates = Array.isArray(config.holidays)
    ? config.holidays
    : Array.isArray(config.closedDates)
    ? config.closedDates
    : [];
  if (closedDates.includes(toYMD(D))) return [];
  const hours =
    config.businessHours && config.businessHours[dayKey]
      ? config.businessHours[dayKey]
      : null;
  if (!hours) return [];
  let openIntervals = intervalsFromSpec(hours, D);

  // Pause (es. pranzo)
  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey]
      ? config.lunchBreaks[dayKey]
      : null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [[s, e]];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  // Indisponibilità del professionista
  const unav = config.unavailability || {};
  const rules = Array.isArray(unav[email]) ? unav[email] : [];

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const daysMatch = (ruleDays) => {
    if (!Array.isArray(ruleDays) || !ruleDays.length) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };
  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  let partialBusy = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const type = String(r.type || "").toLowerCase();
    const applies =
      (type === "day" && daysMatch(r.days)) ||
      (type === "recurrence" && daysMatch(r.days)) ||
      (type === "date" &&
        (Array.isArray(r.dates) ? r.dates : [r.date]).includes(toYMD(D))) ||
      (type === "range" && inRange(r.from, r.to) && daysMatch(r.days));
    if (!applies) continue;
    if (!r.hours || r.fullDay === true) return []; // giorno off intero per il pro
    partialBusy.push(...intervalsFromSpec(r.hours, D));
  }
  partialBusy = mergeIntervals(partialBusy);

  // Busy = booking esistenti del pro + indisponibilità parziale
  const booked = getBusyIntervalsForDay(D, email) || [];
  const busy = mergeIntervals([...booked, ...partialBusy]);

  // Genera slot
  const nowTs = Date.now();
  const times = [];
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

  for (const [winS, winE] of openIntervals) {
    let cursor = winS;
    const mod = (cursor - dayStart) % stepMs;
    if (mod !== 0) cursor += stepMs - mod;

    while (cursor + durMs <= winE) {
      if (cursor < nowTs) {
        cursor += stepMs;
        continue;
      }
      let clash = false;
      for (const [bs, be] of busy) {
        if (overlaps(cursor, cursor + durMs, bs, be)) {
          clash = true;
          break;
        }
        if (bs >= cursor + durMs) break;
      }
      if (!clash) {
        const d = new Date(cursor);
        times.push(
          `${String(d.getHours()).padStart(2, "0")}:${String(
            d.getMinutes()
          ).padStart(2, "0")}`
        );
      }
      cursor += stepMs;
    }
  }

  return Array.from(new Set(times)).sort();
}

async function fetchSlots({
  service = null,
  day,
  duration = null,
  professional = null,
  wantDetail = false,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return wantDetail ? [] : [];

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate()
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const daysMatch = (ruleDays) => {
    if (!Array.isArray(ruleDays) || ruleDays.length === 0) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };
  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    const svc0 = service && (config.services?.[service] || null);
    durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
  }
  const durMs = durMin * 60_000;
  const stepMs = durMs;

  // Giorno chiuso?
  const closedDates = Array.isArray(config.holidays)
    ? config.holidays
    : Array.isArray(config.closedDates)
    ? config.closedDates
    : [];
  const isClosedDate = closedDates.includes(toYMD(D));
  const closedDays = config.closedDays || config.daysOff || {};
  const closedDayKeys = Array.isArray(closedDays)
    ? closedDays.map(String)
    : Object.keys(closedDays);
  const isClosedWeekday = closedDayKeys.includes(String(dayKey));
  if (isClosedDate || isClosedWeekday) return wantDetail ? [] : [];

  // Intervalli di apertura
  const hours =
    config.businessHours && config.businessHours[dayKey]
      ? config.businessHours[dayKey]
      : null;
  if (!hours) return wantDetail ? [] : [];
  let openIntervals = intervalsFromSpec(hours, D);

  // Pausa pranzo o altre chiusure temporanee
  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey]
      ? config.lunchBreaks[dayKey]
      : null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [[s, e]];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  // Seleziona professionisti
  const svc = service && (config.services?.[service] || null);
  const proCfg = Array.isArray(svc?.professionals) ? svc.professionals : null;
  const prosBase =
    proCfg && proCfg.length ? proCfg : Object.keys(config.professionals || {});
  const proEmail =
    professional && professional.includes("@")
      ? professional
      : professional
      ? proEmailByName(professional)
      : null;
  const candidatePros = proEmail ? [proEmail] : prosBase;

  // ===== UNAVAILABILITY =====
  const unav = config.unavailability || {};
  const filteredPros = [];
  const partialBusyByPro = new Map();

  const toEmail = (key) =>
    key.includes("@") ? key : proEmailByName(key) || key;

  for (let key of candidatePros) {
    const email = toEmail(key);
    const rules = Array.isArray(unav[email]) ? unav[email] : [];
    let skip = false;
    let partialBusy = [];

    for (const r of rules) {
      if (!r || typeof r !== "object") continue;
      const type = String(r.type || "").toLowerCase();
      if (type === "day" && Array.isArray(r.days)) {
        const days = r.days;
        const hasHours = !!r.hours;
        if (daysMatch(days)) {
          if (!hasHours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "date" || type === "dates") {
        const dates = Array.isArray(r.dates) ? r.dates : r.date ? [r.date] : [];
        if (dates.includes(toYMD(D))) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "range") {
        if (inRange(r.from, r.to) && daysMatch(r.days)) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "recurrence") {
        if (daysMatch(r.days)) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
    }

    if (!skip) {
      filteredPros.push(email);
      if (partialBusy.length)
        partialBusyByPro.set(email, mergeIntervals(partialBusy));
    }
  }

  const pros = filteredPros.length ? filteredPros : candidatePros.map(toEmail);

  // Calcola intervalli occupati per ciascun pro
  const busyByPro = new Map();
  for (const email of pros) {
    const booked = getBusyIntervalsForDay(D, email) || [];
    const extra = partialBusyByPro.get(email) || [];
    busyByPro.set(email, mergeIntervals([...booked, ...extra]));
  }

  // Genera slot con lista pro liberi
  const nowTs = Date.now();
  const detailed = new Map(); // time -> [{email,name}]
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

  for (const [winS, winE] of openIntervals) {
    let cursor = winS;
    const mod = (cursor - dayStart) % stepMs;
    if (mod !== 0) cursor += stepMs - mod;

    while (cursor + durMs <= winE) {
      if (cursor < nowTs) {
        cursor += stepMs;
        continue;
      }

      const freePros = [];
      for (const email of pros) {
        const busy = busyByPro.get(email) || [];
        let clash = false;
        for (const [bs, be] of busy) {
          if (overlaps(cursor, cursor + durMs, bs, be)) {
            clash = true;
            break;
          }
          if (bs >= cursor + durMs) break;
        }
        if (!clash) {
          const name = proNameByEmail(email) || email;
          freePros.push({ email, name });
        }
      }

      if (freePros.length) {
        const d = new Date(cursor);
        const key = `${String(d.getHours()).padStart(2, "0")}:${String(
          d.getMinutes()
        ).padStart(2, "0")}`;
        detailed.set(key, freePros);
      }
      cursor += stepMs;
    }
  }

  if (wantDetail)
    return Array.from(detailed.entries())
      .map(([time, pros]) => ({ time, pros }))
      .sort((a, b) => compareHHMM(a.time, b.time));
  return Array.from(detailed.keys()).sort(compareHHMM);
}

export async function fetchSlotsWithPros({
  service = null,
  day,
  duration = null,
  professional = null,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return { times: [], map: {} };

  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    const svc0 = service && (config.services?.[service] || null);
    durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
  }
  const durMs = durMin * 60_000;
  const stepMs = durMs;

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const closedDates = Array.isArray(config.holidays)
    ? config.holidays
    : Array.isArray(config.closedDates)
    ? config.closedDates
    : [];
  if (closedDates.includes(toYMD(D))) return { times: [], map: {} };

  const closedDays = config.closedDays || config.daysOff || {};
  const closedDayKeys = Array.isArray(closedDays)
    ? closedDays.map(String)
    : Object.keys(closedDays);
  if (closedDayKeys.includes(String(dayKey))) return { times: [], map: {} };

  const hours =
    config.businessHours && config.businessHours[dayKey]
      ? config.businessHours[dayKey]
      : null;
  if (!hours) return { times: [], map: {} };
  let openIntervals = intervalsFromSpec(hours, D);

  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey]
      ? config.lunchBreaks[dayKey]
      : null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [[s, e]];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  const svc = service && (config.services?.[service] || null);
  const proCfg = Array.isArray(svc?.professionals) ? svc.professionals : null;
  const prosBase =
    proCfg && proCfg.length ? proCfg : Object.keys(config.professionals || {});
  const proEmail =
    professional && professional.includes("@")
      ? professional
      : professional
      ? proEmailByName(professional)
      : null;
  const candidatePros = proEmail ? [proEmail] : prosBase;

  const unav = config.unavailability || {};
  const partialBusyByPro = new Map();
  const filteredPros = [];

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const dayKeySetHas = (ruleDays) => {
    if (!Array.isArray(ruleDays) || ruleDays.length === 0) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };

  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  for (const email of candidatePros) {
    const rules = Array.isArray(unav[email]) ? unav[email] : [];
    let skip = false;
    let partialBusy = [];

    for (const r of rules) {
      if (!r || typeof r !== "object") continue;
      const type = String(r.type || "").toLowerCase();

      const applies =
        (type === "day" && Array.isArray(r.days) && dayKeySetHas(r.days)) ||
        (type === "recurrence" && dayKeySetHas(r.days)) ||
        (type === "date" &&
          (Array.isArray(r.dates) ? r.dates : [r.date]).includes(toYMD(D))) ||
        (type === "range" && inRange(r.from, r.to) && dayKeySetHas(r.days));

      if (applies) {
        if (!r.hours || r.fullDay === true) {
          skip = true;
          break;
        }
        partialBusy.push(...intervalsFromSpec(r.hours, D));
      }
    }

    if (!skip) {
      filteredPros.push(email);
      if (partialBusy.length)
        partialBusyByPro.set(email, mergeIntervals(partialBusy));
    }
  }

  const pros = filteredPros.length ? filteredPros : candidatePros;
  const busyByPro = new Map();
  for (const email of pros) {
    const booked = getBusyIntervalsForDay(D, email) || [];
    const extra = partialBusyByPro.get(email) || [];
    const merged = [...booked, ...extra].sort((a, b) => a[0] - b[0]);
    const merged2 = [];
    for (const iv of merged) {
      if (!merged2.length || iv[0] > merged2[merged2.length - 1][1])
        merged2.push(iv);
      else if (iv[1] > merged2[merged2.length - 1][1])
        merged2[merged2.length - 1][1] = iv[1];
    }
    busyByPro.set(email, merged2);
  }

  const nowTs = Date.now();
  const map = {};
  const times = [];
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

  for (const [winS, winE] of openIntervals) {
    let cursor = winS;
    const mod = (cursor - dayStart) % stepMs;
    if (mod !== 0) cursor += stepMs - mod;

    while (cursor + durMs <= winE) {
      if (cursor < nowTs) {
        cursor += stepMs;
        continue;
      }
      const freeNow = [];
      for (const email of pros) {
        const busy = busyByPro.get(email) || [];
        let clash = false;
        for (const [bs, be] of busy) {
          if (overlaps(cursor, cursor + durMs, bs, be)) {
            clash = true;
            break;
          }
          if (bs >= cursor + durMs) break;
        }
        if (!clash) freeNow.push(email);
      }
      if (freeNow.length) {
        const d = new Date(cursor);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const key = `${hh}:${mm}`;
        times.push(key);
        map[key] = freeNow;
      }
      cursor += stepMs;
    }
  }

  times.sort((a, b) => a.localeCompare(b));
  return { times, map };
}

// ============== Allergie ==============
function extractAllergensFromText(text, list) {
  const hits = new Set();
  for (const a of list)
    if (new RegExp(`\\b${escapeReg(a)}\\b`, "i").test(text))
      hits.add(a.toLowerCase());
  return Array.from(hits);
}
function parseAllergyInfo(text, service) {
  const list = getAllergens(service);
  if (!list.length) return null;
  const raw = String(text || "").trim();

  if (/^\s*0\s*$/.test(raw) || /\b(nessun[aeo]?|no)\b/i.test(raw))
    return { has: false, list: [] };
  if (/^\s*s[iì]\s*$/i.test(raw)) return { has: true, list: [] };

  const nums = raw
    .split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter(Number.isInteger);
  if (nums.length) {
    const hits = nums
      .filter((n) => n >= 1 && n <= list.length)
      .map((n) => list[n - 1]);
    return { has: hits.length > 0, list: hits };
  }

  const hits = new Set();
  for (const a of list)
    if (new RegExp(`\\b${escapeReg(a)}\\b`, "i").test(raw)) hits.add(a);
  return hits.size ? { has: true, list: Array.from(hits) } : null;
}

function askAllergies(service) {
  const list = getAllergens(service);
  if (!list.length) return null;
  const opts = ["0) Nessuna allergia"].concat(
    list.map((a, i) => `${i + 1}) ${a}`)
  );
  return `Hai allergie per "${service}"?\n${opts.join("\n")}\n(0-${
    list.length
  })\nSe ne hai più di una, invia i numeri separati da virgola.`;
}

// ============== Saluti & affini ==============
function wantsAffectionReply(t) {
  return /\b(amore|tesoro|tesorino|tesorina|cara|carissima|caro|carissimo)\b/i.test(
    norm(t)
  );
}
function greetCTA() {
  const exampleSvc = cfgServices()[0] || "manicure";
  return `Ciao tesoro! 😊 Puoi prenotare un trattamento o farmi domande sui nostri servizi.\nPer prenotare, ad esempio: scrivi "${exampleSvc} domani alle 10:30".`;
}

// ============== Helpers vari ==============
function filterSlotsByWindow(slots, windowPair) {
  const list = Array.isArray(slots) ? slots : [];
  const w =
    Array.isArray(windowPair) && windowPair.length === 2 ? windowPair : null;
  if (!w) return list.slice();
  const from = timeToMinutes(w[0]);
  const to = timeToMinutes(w[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return list.slice();
  return list
    .filter((h) => {
      const m = timeToMinutes(h);
      return Number.isFinite(m) && m >= from && m <= to;
    })
    .sort(compareHHMM);
}
function getDaypartBoundaries() {
  const def = {
    mattina: ["09:00", "12:30"],
    pomeriggio: ["14:00", "17:30"],
    sera: ["17:30", "20:30"],
  };
  try {
    if (config && config.dayparts) {
      const d = config.dayparts;
      const pick2 = (keys, fb) => {
        for (const k of keys) {
          if (Array.isArray(d[k]) && d[k].length === 2) return d[k];
        }
        return fb;
      };
      return {
        mattina: pick2(["mattina", "morning"], def.mattina),
        pomeriggio: pick2(["pomeriggio", "afternoon"], def.pomeriggio),
        sera: pick2(["sera", "evening"], def.sera),
      };
    }
  } catch (_) {}
  return def;
}
function groupSlotsByDaypart(slots) {
  const list = Array.isArray(slots) ? slots.slice().sort(compareHHMM) : [];
  const dp = getDaypartBoundaries();
  return {
    mattina: filterSlotsByWindow(list, dp.mattina),
    pomeriggio: filterSlotsByWindow(list, dp.pomeriggio),
    sera: filterSlotsByWindow(list, dp.sera),
  };
}

function phoneFromChatId(chatId) {
  const s = String(chatId || "");
  const num = s.split("@")[0];
  return num.replace(/\D/g, "");
}
export function proNameByEmail(email, professionalsOrConfig) {
  if (!email) return "";
  let pros;
  if (professionalsOrConfig)
    pros = Array.isArray(professionalsOrConfig)
      ? professionalsOrConfig
      : professionalsOrConfig?.professionals;
  else if (typeof config !== "undefined") pros = config?.professionals;
  const key = String(email).toLowerCase();
  if (pros && !Array.isArray(pros) && typeof pros === "object") {
    const o = pros[email] || pros[key] || pros[key?.trim?.()];
    if (o && typeof o === "object") return o.name || o.displayName || email;
  }
  if (Array.isArray(pros)) {
    const found = pros.find(
      (p) => String(p?.email || "").toLowerCase() === key
    );
    if (found) return found.name || found.displayName || email;
  }
  return email;
}
function findProfessionalCandidatesByText(inputText, serviceCtx = null) {
  const normTxt = simpleNorm(inputText);
  const specific = ((serviceCtx && cfgServiceProfessionals(serviceCtx)) || [])
    .map((p) => p.name)
    .filter(Boolean);
  const candidates = specific.length
    ? specific
    : Object.values(config.professionals || {}).map((p) => p.name);
  const hits = [];
  for (const name of candidates) {
    const nname = simpleNorm(name);
    let score = 0;
    if (nname && normTxt.includes(nname)) score += 3;
    for (const tok of nname.split(" ").filter(Boolean)) {
      if (tok.length >= 3 && normTxt.includes(tok)) score += 1;
    }
    if (score > 0) hits.push({ name, score });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const topScore = hits[0].score;
  const bestCandidates = hits
    .filter((h) => h.score === topScore)
    .map((h) => h.name);
  if (bestCandidates.length === 1) return { resolved: bestCandidates[0] };
  return { ambiguous: bestCandidates.slice(0, 6) };
}
function proEmailByName(name) {
  const pros = config.professionals || {};
  for (const [email, o] of Object.entries(pros)) {
    const n = o?.name || email;
    if (norm(n) === norm(name)) return email;
  }
  return null;
}
function extractCustomerName(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^(ciao|buongiorno|buonasera|hey|ehi|salve)[,!\s]*/i, "");
  s = s.replace(
    /^(mi\s+chiamo|io\s+mi\s+chiamo|io\s+sono|sono|il\s+mio\s+nome\s+è|nome\s*[:=]?|nome\s+e\s+cognome\s*[:=]?|cognome\s*[:=]?)[\s,]*/i,
    ""
  );
  s = s
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const tokens = s.split(" ").filter(Boolean);
  const letters = s.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length < 2) return null;
  const name = tokens
    .map((t) => (t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t))
    .join(" ");
  return name || null;
}

// ============== Build QA prompt (placeholder) ==============
function buildQAPromptWithMemory(chatId, basePrompt) {
  const recent = getRecentMessages(chatId).slice(-5).join("\n");
  return `${basePrompt}\n\n[Contesto chat]\n L'utente ha scritto questi 5 messaggi:${recent} usali come contesto per la tua risposta!`;
}

// ============== Google Calendar wrappers ==============
function _digitsPhone(s) {
  return String(s || "").replace(/\D+/g, "");
}

/**
 * Wrapper compatibile con gcal.js:createCalendarEvent
 * - Normalizza telefono
 * - Mappa notes -> serviceDetails
 * - Passa professionalName, clientName, allergies/allergic
 */
async function makeEvent({
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  customerName = null, // <— arriva dal flow come "customerName"
  startTime,
  durationMin,
  notes = null, // <— verrà rimappato a serviceDetails
  price = null,
  allergies = null, // array o stringa
  allergic = null, // boolean
  reminders = [{ method: "popup", minutes: 1440 }],
}) {
  const payload = {
    serviceName,
    professionalEmail,
    professionalName, // opzionale ma utile per il titolo in gcal
    clientPhone: _digitsPhone(clientPhone),
    clientName: customerName, // <— mapping richiesto da gcal.js
    startTime, // Date o ISO, gcal fa new Date(...)
    durationMin,
    price,
    serviceDetails: notes, // <— mapping
    allergies,
    allergic,
    reminders,
  };
  try {
    return await _createCalendarEvent(payload);
  } catch (e) {
    log("error", "createCalendarEvent", e?.message || e);
    throw e;
  }
}

// === definizione di updateEventSafe (nuova) ===
async function updateEventSafe(args) {
  try {
    if (typeof GCAL.updateCalendarEvent === "function") {
      await GCAL.updateCalendarEvent(args);
      return true;
    }
    if (typeof GCAL.updateEvent === "function") {
      await GCAL.updateEvent(args);
      return true;
    }
  } catch (e) {
    log("warn", "updateEventSafe", e?.message || e);
  }
  return false;
}

async function cancelEventSafe(eventId) {
  try {
    if (!eventId) return false;
    if (typeof GCAL.cancelCalendarEvent === "function") {
      await GCAL.cancelCalendarEvent({ eventId });
      return true;
    }
    if (typeof GCAL.deleteEvent === "function") {
      await GCAL.deleteEvent({ eventId });
      return true;
    }
    if (typeof GCAL.cancelEvent === "function") {
      await GCAL.cancelEvent({ eventId });
      return true;
    }
  } catch (e) {
    log("warn", "cancelEventSafe", e?.message || e);
  }
  return false;
}

// ========================= EDIT HELPERS (incolla SOPRA a handleMessage) =========================

// Durata del servizio con fallback a 30'
function _editDuration(booking) {
  return (
    Number(booking?.durationMin) || cfgServiceDuration(booking?.service) || 30
  );
}

// Elenco nomi professionisti per un servizio (prima quelli del servizio, poi fallback a tutti)
function _editListProNamesForService(serviceName) {
  const prosSpec = cfgServiceProfessionals(serviceName) || [];
  const names = prosSpec.map((p) => p.name).filter(Boolean);
  if (names.length) return names;
  return Object.values(config.professionals || {})
    .map((p) => p.name)
    .filter(Boolean);
}

// Estrarre il "giorno" dall'appuntamento (ora a mezzogiorno per neutralizzare i fusi)
function _editDayFromBooking(booking) {
  const d = new Date(booking.startTime);
  d.setHours(12, 0, 0, 0);
  return d;
}

// Formattare lista orari numerata
function _editFormatTimeList(times) {
  return (times || []).map((t, i) => `${i + 1}) ${t}`).join("\n");
}

// ISO helper: usa toISOStringLocal se presente, altrimenti ISO standard
function _toISO(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return typeof toISOStringLocal === "function"
    ? toISOStringLocal(d)
    : d.toISOString();
}

// Slot disponibili per (servizio, giorno, durata, professionista)
// Ritorna array di stringhe 'HH:MM' ordinate
async function _editFetchTimes({ service, day, duration, professionalEmail }) {
  const list = await fetchSlots({
    service,
    day,
    duration,
    professional: professionalEmail || null,
  });
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.sort(compareHHMM);
}

// Aggiorna "Nome: ..." nelle note dell'evento (sostituisce o aggiunge la riga)
function _editComputeNewNotes(oldNotes, newName) {
  const base = String(oldNotes || "").trim();
  if (!newName) return base || "";
  const line = `Nome: ${newName}`;
  if (!base) return line;
  if (/^Nome:\s*.*$/im.test(base)) {
    return base.replace(/^Nome:\s*.*$/im, line).trim();
  }
  return (base + "\n" + line).trim();
}

/**
 * Applica un aggiornamento all'evento (Calendar) e al bookings.json.
 * - newStartISO: ISO string nuova data/ora (se null → non cambia)
 * - newProEmail: email nuovo professionista (se null → non cambia)
 * - newName: nuovo nome cliente (se null → non cambia)
 */
async function _editApplyUpdate({
  booking,
  newStartISO = null,
  newProEmail = null,
  newName = null,
}) {
  if (!booking?.eventId) return false;

  // Prepara campi da inviare a Calendar
  const nextStart = newStartISO || booking.startTime;
  const nextPro = newProEmail ?? booking.professionalEmail;

  // Note (aggiorna il Nome se necessario)
  const nextNotes =
    typeof booking.notes !== "undefined" || newName
      ? _editComputeNewNotes(booking.notes, newName)
      : booking.notes;

  const ok = await updateEventSafe({
    eventId: booking.eventId,
    serviceName: booking.service, // il servizio non si cambia in edit
    professionalEmail: nextPro || booking.professionalEmail,
    clientPhone: booking.clientPhone,
    startTime: nextStart,
    durationMin: booking.durationMin || cfgServiceDuration(booking.service),
    notes: nextNotes,
  });

  if (!ok) return false;

  // Aggiorna il record locale bookings.json
  const patch = {};
  if (newStartISO) patch.startTime = newStartISO;
  if (newProEmail) {
    patch.professionalEmail = newProEmail;
    patch.professionalName = proNameByEmail(newProEmail);
  }
  if (newName) patch.customerName = newName;
  if (typeof nextNotes !== "undefined") patch.notes = nextNotes;

  updateBookingByEventId(booking.eventId, patch);
  return true;
}

// Riconosce domande informative (robusto anche senza "?")
function looksLikeInfoQuestion(s) {
  const q = norm(s || ""); // <— prima era toLowerCase(); ora normalizziamo accenti/apostrofi

  // Domande informative (non contiene 'posto/disponibilità' per non rubare i casi slot)
 const infoPat =
  /\b(?:cos[’'` ]?e|cos[’'` ]?è|che\s+cosa|che\s+cos[’'` ]?è|come\s+funzion\w*|info|informazioni|piu?\s+info|vorrei\s+(?:sapere|info|informazioni)|dimmi|spiegami|quanto\s+dura|durata|prezz\w*|costo\w*|tariff\w*|quanto\s+(?:dura|costa)|cosa\s+serve|in\s+cosa\s+consist\w*|controindic\w*|effetti|benefici)\b/u;

  const isQuestionish =
    /[?？]\s*$/.test(q) ||
    /\b(?:perch[eé]|come|cosa|che|quale|quando)\b/.test(q);

  return infoPat.test(q) && isQuestionish;
}

// Ci sono step “critici” in cui NON interrompiamo con l’info (es. l’utente sta selezionando un numero)
function isInCriticalStep(step) {
  return [
    "collect",               // <— aggiunto
    "choose_service",
    "pick_time",
    "pick_professional",
    "ask_allergies",
    "ask_name",
    "confirm_booking",
    "price_select_service",
    "info_select_service",
  ].includes(step);
}


async function startEditDate(client, chatId) {
  const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
  if (!booking)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_reschedule_date";
  s.edit = { target: booking };
  pending.set(chatId, s);
  return reply(
    client,
    chatId,
    `Hai un appuntamento per **${fmtDate(
      booking.startTime
    )} ${booking.startTime.slice(
      11,
      16
    )}**.\n📅 Per quando vuoi spostarlo? (GG/MM o “domani”)`
  );
}

async function startEditTime(client, chatId) {
  const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
  if (!booking)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_reschedule_time";
  s.edit = { target: booking, day: new Date(booking.startTime) };
  const duration =
    Number(booking.durationMin) || cfgServiceDuration(booking.service);
  const slots = (
    await fetchSlots({
      service: booking.service,
      day: s.edit.day,
      duration,
      professional: booking.professionalEmail || booking.professionalName,
      wantDetail: true,
    })
  ).map((x) => (x.time ? x : { time: x, pros: [] }));
  if (!slots.length)
    return reply(
      client,
      chatId,
      "Non vedo orari liberi in quel giorno. Vuoi cambiare data? Scrivi “modifica data”."
    );
  s.collected = s.collected || {};
  s.collected.options = slots;
  pending.set(chatId, s);
  const lines = slots
    .map(
      (it, i) =>
        `${i + 1}) ${it.time}${
          it.pros?.length ? ` (${it.pros.map((p) => p.name).join(", ")})` : ""
        }`
    )
    .join("\n");
  return reply(
    client,
    chatId,
    `Orari disponibili per ${fmtDate(s.edit.day)}:\n${lines}\n(1-${
      slots.length
    })`
  );
}

async function startEditProfessional(client, chatId) {
  const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
  if (!booking)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  const pros = cfgServiceProfessionals(booking.service)
    .map((x) => x.name)
    .filter(Boolean);
  if (!pros.length)
    return reply(
      client,
      chatId,
      "Non ho professionisti associati a questo servizio."
    );
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_pick_professional";
  s.edit = { target: booking, proOptions: pros };
  pending.set(chatId, s);
  const list = pros.map((p, i) => `${i + 1}) ${p}`).join("\n");
  return reply(
    client,
    chatId,
    `Scegli il professionista:\n${list}\n(1-${pros.length})`
  );
}

async function startEditName(client, chatId) {
  const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
  if (!booking)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_change_name";
  s.edit = { target: booking };
  pending.set(chatId, s);
  return reply(
    client,
    chatId,
    "Scrivi il nuovo nome e cognome per la prenotazione."
  );
}

// ========= Heuristics di intent (semplici ma robusti) =========
function hasBookingVerb(s) {
  s = norm(s || "");
  return /\b(prenot|appunt|fiss|riserv|disponibil|spost|cancell|modific)\w*/i.test(
    s
  );
}
function hasDateOrTime(s) {
  s = String(s || "");
  return (
      // 10:30 / alle 9.00
      /\b(oggi|domani|dopodomani|settimana\s+prossima)\b/i.test(s) || // parole chiave
      /\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/.test(s) || // 21/10[/2025]
      /\b(?:alle\s*)?([01]?\d|2[0-3])[:\.]([0-5]\d)\b/i.test(s)
  );
}
function scoreInfoIntent(txt) {
  const s = norm(txt || "");
  let score = 0;
  if (/[?？]\s*$/.test(txt)) score += 1;
  if (
    /\b(?:cos[’'` ]?e|cos[’'` ]?è|che\s+cosa|come\s+funzion\w*|informazioni?|info|spieg\w*|dettagl\w*|controindic\w*|fa\s+male|benefici|effetti)\b/.test(
      s
    )
  )
    score += 2;
  if (/\b(prezz|costo|listino|tariff|quanto\s+cost)\w*/.test(s)) score += 2; // prezzi = info
  return score;
}
function scoreBookingIntent(txt) {
  let score = 0;
  const s = norm(txt || "");
  if (hasBookingVerb(s)) score += 2;
  if (hasDateOrTime(s)) score += 1;
  if (parseHHMM(s)) score += 1;
  if (parseRelativeDay(s)) score += 1;
  return score;
}
function primaryIntent(txt) {
  const si = scoreInfoIntent(txt);
  const sb = scoreBookingIntent(txt);
  if (si >= sb + 1) return "info";
  if (sb >= si + 1) return "appointment";
  if (si === sb && /[?？]/.test(txt)) return "info"; // pareggio: domanda → info
  return null;
}

// ========= parseAvailabilityRequest (minimale, safe) =========
function parseAvailabilityRequest(text) {
  const t = norm(text || "");
  const out = { kind: null };

  // giorno singolo: oggi/domani/dopodomani
  if (/\boggi\b/.test(t) || /\bdomani\b/.test(t) || /\bdopodomani\b/.test(t)) {
    const d = parseRelativeDay(t);
    if (d) {
      out.kind = "day";
      out.date = d;
    }
  }

  // GG/MM(/YYYY) o "il 21"
  if (!out.kind) {
    const m1 = t.match(/\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/);
    if (m1) {
      const dd = +m1[1],
        mm = +m1[2],
        yy = m1[3] ? +m1[3] : new Date().getFullYear();
      out.kind = "day";
      out.date = new Date(yy, mm - 1, dd, 12, 0, 0, 0);
    } else {
      const m2 = t.match(/\bil\s+([1-9]|[12]\d|3[01])\b/);
      if (m2) {
        const dd = +m2[1];
        const now = new Date();
        out.kind = "day";
        out.date = new Date(now.getFullYear(), now.getMonth(), dd, 12, 0, 0, 0);
      }
    }
  }

  // settimana prossima
  if (!out.kind && /\bsettimana\s+prossima\b/.test(t)) {
    out.kind = "next_week";
  }

  // mese: "a dicembre", "dic", ecc. (anno auto-forward se mese già passato)
  if (!out.kind) {
    const m = t.match(
      /\b(gen(?:naio)?|feb(?:braio)?|mar(?:zo)?|apr(?:ile)?|mag(?:gio)?|giu(?:gno)?|lug(?:lio)?|ago(?:sto)?|set(?:tembre)?|ott(?:obre)?|nov(?:embre)?|dic(?:embre)?)\b/i
    );
    if (m) {
      const map = {
        gen: 0,
        gennaio: 0,
        feb: 1,
        febbraio: 1,
        mar: 2,
        marzo: 2,
        apr: 3,
        aprile: 3,
        mag: 4,
        maggio: 4,
        giu: 5,
        giugno: 5,
        lug: 6,
        luglio: 6,
        ago: 7,
        agosto: 7,
        set: 8,
        settembre: 8,
        ott: 9,
        ottobre: 9,
        nov: 10,
        novembre: 10,
        dic: 11,
        dicembre: 11,
      };
      const key = m[1].toLowerCase();
      const idx = map[key];
      if (idx != null) {
        const now = new Date();
        let year = now.getFullYear();
        if (idx < now.getMonth()) year++; // se è già passato → anno prossimo
        out.kind = "month";
        out.year = year;
        out.monthIdx = idx;
      }
    }
  }

  if (out.kind) {
    // finestra "mattina/pomeriggio/sera"
    const win = parseDaypartWindow(text);
    if (win) out.window = win;

    // vincoli "dopo/prima"
    const afterM = t.match(/\b(?:dopo|dalle)\s+([0-2]?\d(?::[0-5]\d)?)\b/);
    if (afterM)
      out.after =
        afterM[1].length === 1
          ? `0${afterM[1]}:00`
          : afterM[1].includes(":")
          ? afterM[1]
          : `${afterM[1]}:00`;
    const beforeM = t.match(
      /\b(?:prima|entro)\s+(?:le\s*)?([0-2]?\d(?::[0-5]\d)?)\b/
    );
    if (beforeM)
      out.before =
        beforeM[1].length === 1
          ? `0${beforeM[1]}:00`
          : beforeM[1].includes(":")
          ? beforeM[1]
          : `${beforeM[1]}:00`;
  }

  return out.kind ? out : null;
}

// ===================== HYBRID INTENT (regex + fuzzy) =====================
// === INTENT HYBRID PATTERNS — versione corretta ===
const HYBRID_PATTERNS = {
  booking: {
    // Triggher di nuova prenotazione
    regex: /\b(?:prenota(?:re)?|fissa(?:re)?|prendi(?:re)?\s+appuntamento|vorrei\s+prenotare|voglio\s+prenotare|mettimi\s+(?:un\s+)?appuntamento|mi\s+(?:prenoti|fissi|metti)\s+(?:un\s+)?appuntamento|blocca(?:re)?\s+(?:un\s+)?posto)\b/iu,
    weight: 6,
  },
  edit: {
    // Verbo d'azione + riferimento ad appuntamento/data/orario
    regex: /(?=.*\b(?:modifica(?:re)?|sposta(?:re)?|cambia(?:re)?|anticipa(?:re)?|posticipa(?:re)?)\b)(?=.*\b(?:appunt|prenot|orario|data|oggi|domani|lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sabato|domenica|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2})\b)/iu,
    weight: 7,
  },
  cancel: {
    // Verbo di annullamento + riferimento a appunt./prenot.
    regex: /(?=.*\b(?:annulla(?:re)?|cancella(?:re)?|disdici(?:re)?|disdire|elimina(?:re)?|togli(?:ere)?)\b)(?=.*\b(?:appunt|prenot)\w*\b)/iu,
    weight: 8,
  },
  price: {
    regex: /\b(?:prezz|costo|listino|tariff|quanto\s+costa)\w*/iu,
    weight: 5,
  },
  info: {
    regex: /\b(?:info|informazioni|cos[’'` ]?e|cos[’'` ]?è|che\s+cosa|che\s+cos[’'` ]?è|come\s+funzion\w*|quanto\s+dura|durata|in\s+cosa\s+consist\w*)\b/iu,
    weight: 4,
  },
  greeting: {
    regex: /\b(?:ciao|buongiorno|buonasera|hey|salve)\b/iu,
    weight: 1,
  },
};



// tokenizzazione “semplice” coerente con il resto
function tokens(s) {
  return simpleNorm(String(s || ""))
    .split(" ")
    .filter(Boolean);
}

// similarità Levenshtein normalizzata (0..1)
function simRatio(a, b) {
  a = simpleNorm(a);
  b = simpleNorm(b);
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  const m = Math.max(a.length, b.length);
  return m ? 1 - d / m : 0;
}

// fuzzy “contains”: verifica copertura token + finestra scorrevole
function fuzzyContains(
  text,
  phrase,
  { minRatio = 0.82, minCoverage = 0.66 } = {}
) {
  const T = simpleNorm(text);
  const P = simpleNorm(phrase);
  if (!T || !P) return false;
  if (T.includes(P)) return true;

  const tt = tokens(T),
    pp = tokens(P);
  if (!pp.length) return false;

  // 1) copertura token: quanti token della frase compaiono nel testo
  const setT = new Set(tt);
  const covered = pp.filter((tok) => setT.has(tok)).length / pp.length;
  if (covered >= minCoverage) return true;

  // 2) finestra scorrevole: confronta stringhe di pari lunghezza (±1) con Levenshtein ratio
  const lens = [pp.length, Math.max(1, pp.length - 1), pp.length + 1];
  for (const L of lens) {
    if (L > tt.length) continue;
    for (let i = 0; i + L <= tt.length; i++) {
      const win = tt.slice(i, i + L).join(" ");
      if (simRatio(win, P) >= minRatio) return true;
    }
  }
  return false;
}

function hasAnyRegex(s, arr) {
  return arr.some((re) => re.test(s));
}
function fuzzyAny(text, phrases, opts) {
  return phrases.some((p) => fuzzyContains(text, p, opts));
}

// Segnali extra già presenti nel file
function hasAnyDateOrTime(text) {
  return hasDateOrTime(text) || !!parseHHMM(text) || !!parseRelativeDay(text);
}

// -------------- INTENT PRINCIPALE (ibrido) ----------------
function intentByHybrid(t) {
  const text = (t || "").toLowerCase();

  const scores = { booking: 0, edit: 0, cancel: 0, info: 0 };

  for (const key of Object.keys(HYBRID_PATTERNS)) {
    const { regex, weight } = HYBRID_PATTERNS[key];
    if (regex.test(text)) scores[key] += weight;
  }

  // Penalizza conflitti: se c'è forte booking, riduci edit/cancel "deboli"
  if (scores.booking >= 6) {
    scores.edit = Math.max(0, scores.edit - 4);
    scores.cancel = Math.max(0, scores.cancel - 5);
  }

  // Evita che la sola parola "prenotazione/appuntamento" (senza verbi) faccia scattare edit/cancel
  // Nota: i regex di edit/cancel già richiedono verbi d'azione, ma teniamo una rete di sicurezza.
  const onlyGenericAppWord =
    /\b(appuntamento|prenotazione|appunt|prenot)\w*\b/iu.test(text) &&
    !/\b(modifica|sposta|cambia|posticipa|anticipa|aggiorna|annulla|cancella|disdici|disdire|elimina|togli|rimuovi)\b/iu.test(
      text
    ) &&
    !/\b(prenota|fissa|metti|blocca|mi\s+prenoti|vorrei\s+prenotare|voglio\s+prenotare)\b/iu.test(
      text
    );

  if (onlyGenericAppWord) {
    // Non permettere che l’heuristica vada su edit/cancel senza verbi chiari
    scores.edit = 0;
    scores.cancel = 0;
  }

  // Scegli il max
  let label = "other";
  let max = -1;
  for (const [k, v] of Object.entries(scores)) {
    if (v > max) {
      max = v;
      label = k;
    }
  }

  // Soglia minima: se tutto è debole, prova booking quando compaiono service/date/ora
  if (max < 3) {
    if (
      /\b(prenota|fissa|metti|mi\s+prenoti|vorrei\s+prenotare|voglio\s+prenotare)\b/iu.test(
        text
      )
    ) {
      label = "booking";
    }
  }

  return { label, scores };
}
function hasFutureBookingsForPhone(phone) {
  try {
    const all = readJSON("bookings.json", []);
    const now = Date.now();
    return all.some((b) => {
      const p = (b.phone || b.clientPhone || b.client_phone || "").replace(
        /\D+/g,
        ""
      );
      const when = new Date(
        b.start || b.startTime || b.start_date || b.when || 0
      ).getTime();
      return p.endsWith(phone.replace(/\D+/g, "")) && when && when >= now;
    });
  } catch {
    return false;
  }
}

// === Drop-in helpers per etichette professionisti negli slot ===

// "Melissa Granati" -> "Melissa G." / "Melissa" -> "Melissa"
function proShort(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const iniz = last[0] ? last[0].toUpperCase() : "";
  return `${parts[0]} ${iniz}.`;
}

// Normalizza oggetto professionista accettando stringhe o oggetti vari
function normalizePro(p) {
  if (!p) return { name: "", email: "" };
  if (typeof p === "string") {
    if (p.includes("@")) {
      // prova a risolvere il nome leggibile se disponibile
      const nice =
        (typeof proNameByEmail === "function" ? proNameByEmail(p) : "") || p;
      return { name: nice, email: p };
    }
    return { name: p, email: "" };
  }
  const email = String(p.email || "").trim();
  const name =
    String(p.name || "").trim() ||
    (email && typeof proNameByEmail === "function"
      ? proNameByEmail(email)
      : "") ||
    email;
  return { name, email };
}

/**
 * Etichetta i professionisti liberi per uno slot.
 * - Se tutti i pro del servizio sono liberi in quello slot, ritorna "tutti".
 * - Altrimenti, ritorna una lista breve tipo "Melissa G., Sara B."
 *
 * @param {object} slot - Oggetto slot; accetta { time, pros } o { pros }.
 * @param {object} [opts]
 * @param {string|null} [opts.serviceName] - Nome del servizio per confrontare "tutti".
 * @param {object|array|null} [opts.professionalsOrConfig] - Config completa o lista di pro (fallback).
 * @returns {string}
 */
function labelProsForSlot(
  slot,
  { serviceName = null, professionalsOrConfig = null } = {}
) {
  const pros = Array.isArray(slot?.pros) ? slot.pros : [];
  if (!pros.length) return "";

  // Costruisci il set dei pro "attesi" (quelli del servizio) per poter dire "tutti"
  const serviceProsKeys = (() => {
    // 1) Se ho il servizio e la funzione cfgServiceProfessionals, uso quella
    if (serviceName && typeof cfgServiceProfessionals === "function") {
      const arr = (cfgServiceProfessionals(serviceName) || [])
        .map((p) => (p.email || p.name || "").toString().toLowerCase())
        .filter(Boolean);
      return new Set(arr);
    }
    // 2) Se ho una lista/oggetto passato esplicitamente
    if (professionalsOrConfig) {
      if (Array.isArray(professionalsOrConfig)) {
        return new Set(
          professionalsOrConfig
            .map((p) => (p.email || p.name || "").toString().toLowerCase())
            .filter(Boolean)
        );
      }
      if (professionalsOrConfig.professionals) {
        const prosCfg = professionalsOrConfig.professionals;
        if (Array.isArray(prosCfg)) {
          return new Set(
            prosCfg
              .map((p) => (p.email || p.name || "").toString().toLowerCase())
              .filter(Boolean)
          );
        } else if (prosCfg && typeof prosCfg === "object") {
          return new Set(Object.keys(prosCfg).map((k) => k.toLowerCase()));
        }
      }
    }
    // 3) Fallback: usa tutti i pro da config globale, se presente
    try {
      if (typeof config !== "undefined" && config?.professionals) {
        const prosCfg = config.professionals;
        if (Array.isArray(prosCfg)) {
          return new Set(
            prosCfg
              .map((p) => (p.email || p.name || "").toString().toLowerCase())
              .filter(Boolean)
          );
        } else if (prosCfg && typeof prosCfg === "object") {
          return new Set(Object.keys(prosCfg).map((k) => k.toLowerCase()));
        }
      }
    } catch {}
    return new Set(); // nessun riferimento → niente "tutti"
  })();

  // Set dei pro realmente liberi nello slot (per confronto)
  const slotSet = new Set(
    pros
      .map((p) => {
        const n = normalizePro(p);
        return (n.email || n.name || "").toLowerCase();
      })
      .filter(Boolean)
  );

  // Se conosciamo l'elenco "atteso", verifica copertura completa
  if (serviceProsKeys.size > 0) {
    const hasAll = [...serviceProsKeys].every((k) => slotSet.has(k));
    if (hasAll) return "tutti";
  }

  // Altrimenti lista abbreviata
  return pros
    .map((p) => {
      const n = normalizePro(p);
      return proShort(n.name || n.email);
    })
    .join(", ");
}

async function askInfoWhichService(client, chatId, state, col) {
  const svcs = cfgServices();
  col.infoOptions = svcs;
  state.step = "info_select_service";
  pending.set(chatId, state); // aggiorna lo stato

  await reply(
    client,
    chatId,
    `Su quale trattamento vuoi informazioni?\n${svcs
      .map((s, i) => `${i + 1}) ${s}`)
      .join("\n")}\n(1-${svcs.length})`
  );
  return ""; // per coerenza con handleMessage
}
function parseDurationEnv({
  msVar = "OLLAMA_KEEP_ALIVE_MS",
  anyVar = "OLLAMA_KEEP_ALIVE",
  def = "5m",
} = {}) {
  const raw = (process.env[anyVar] ?? process.env[msVar] ?? "")
    .toString()
    .trim();
  if (!raw) return def; // default
  if (/^\d+$/.test(raw)) return `${raw}ms`; // numero nudo -> millisecondi
  if (/^\d+\s*(ns|us|µs|ms|s|m|h)$/i.test(raw)) return raw; // già con unità
  console.warn(`[OLLAMA] durata non valida "${raw}", uso default ${def}`);
  return def;
}
async function maybeHandleAvailability(client, chatId, state, col, text, t) {
  if (!state) state = getState(chatId);
  ensureContext(state);
  if (isInCriticalStep(state.step)) return false;

  const wantAvail =
    /\b(posto|disponibil|liber[oi])\b/i.test(t || "") ||
    !!parseTimeSmart(text || "");

  if (!wantAvail) return false;

  const day =
    parseRelativeDay(text || "") ||
    (col && col.when ? atNoon(col.when) : nextOpenDay(new Date()));

  const svcCtx = (col && col.service) || fuzzyServiceSafe(text || "") || null;
  const proCtx = (col && (col.professionalEmail || col.professionalName)) || null;

  await reply(client, chatId, '🔎 Modalità disponibilità attiva. Per uscire scrivi **annulla**.');
  await showDayAvailability(client, chatId, state, col, client, chatId, state, col, day, svcexport async function handleMessage(client, chatId, textRaw, tools = {}) {
  while (__busyChats.has(chatId)) await __delay(35);
  __busyChats.add(chatId);
  try {
    const text = (textRaw ?? "").toString().trim();
    const t = norm(text);
    const state = getState(chatId);
    state.collected ||= {};
    state.context ||= {};
    ensureContext(state);
    const col = state.collected;
andleAvailability(client, chatId, state, col, text, t)) return "";

  state.collected ||= {};
  state.context  ||= {};
  ensureContext(state);

  // --- Normalizzazione SUBITO ---
  const text = (textRaw ?? "").toString().trim();
  const lower = text.toLowerCase();
  const isCancel = lower === "annulla" || lower === "/annulla";

  try {
    // --- Log in cronologia utente (una sola volta) ---
    try {
      await appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "appendUserMessage failed", e?.message || e);
    }

// ============ INLINE HELPERS (solo per questa funzione) =====================
    const pureNumber = /^\s*\d+\s*$/;
    const t = norm(text);



// === HELPERS locali usati in alto ===
function hasDateOrTime(s) {
  try { return !!(parseRelativeDay(s) || parseTimeSmart(s)); } catch { return false; }
}
const NO_FUTURE = "Non ho trovato prenotazioni future col tuo numero.";

// --- FAST PATH FLAG (prenotazione) ---
let __wantFastBooking__ = false;
if (!isInCriticalStep(state.step)) {
  const trigger =
    /\b(prenot|appunt|fiss|riserv|disponibil)\w*/i.test(t) ||
    hasDateOrTime(text) ||
    !!fuzzyServiceSafe(text);
  if (trigger) __wantFastBooking__ = true;
}

async function maybeHandleAvailability(client, chatId, state, col, text, t) {
  if (isInCriticalStep(state.step)) return false;

  const wantAvail =
    /\b(posto|disponibil|liber[oi])\b/i.test(t) ||
    !!parseTimeSmart(text); // scatta anche se l’utente scrive solo un orario

  if (!wantAvail) return false;

  const day =
    parseRelativeDay(text) ||
    ((col && col.when) ? atNoon(col.when) : nextOpenDay(new Date()));

  const svcCtx = (col && col.service) || fuzzyServiceSafe(text) || null;
  const proCtx = (col && (col.professionalEmail || col.professionalName)) || null;

  await reply(
    client,
    chatId,
    '🔎 Modalità disponibilità attiva. Per uscire scrivi **annulla**.'
  );
  await showDayAvailability(client, chatId, state, col, day, svcCtx, proCtx);
  return true;
}
    // --- PATCH: fuzzy "safe" per evitare default al primo servizio quando il match è debole ---
    function hasSvcToken(q) {
  try {
    const tokens = (cfgServices() || [])
      .flatMap((s) => String(s).toLowerCase().split(/\W+/))
      .filter((x) => x && x.length >= 4);
    const nq = norm(q);
    return tokens.some((tok) => nq.includes(norm(tok)));
  } catch { return false; }
}

function fuzzyServiceSafe(q) {
  const hit = fuzzyService(q);
  if (!hit) return null;
  const first = (typeof cfgServices === "function" && (cfgServices()[0] || null)) || null;
  if (first && norm(hit) === norm(first) && !hasSvcToken(q)) return null;
  return hit;
}


    const phone = phoneFromChatId(chatId);
    log("info", "[HANDLE]", { chatId, text });

    // --- CANCELLAZIONE GLOBALE RAPIDA ---
    if (/^(annulla|cancel|stop|fine)\b/i.test(t)) {
      const st = pending.get(chatId);
      if (st && /^edit_/.test(st.step)) {
        pending.delete(chatId);
        releaseSoftHoldByChat(chatId);
        await reply(client, chatId, "✅ Ho chiuso la gestione dell’appuntamento. Nessuna modifica applicata.");
        return "";
      }
      if (st) unlockBooking(st);
      pending.delete(chatId);
      releaseSoftHoldByChat(chatId);
      await reply(client, chatId, '✅ Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".');
      return "";
    }

    // === PATCH: INFO RAPIDE (short-circuit) ===
    if (await maybeHandleAvailability(client, chatId, state, col, text, t)) return "";
    if (!isInCriticalStep(state.step)) {
      const RE_ADDR =
        /(indirizz[oi]|dove\s+(siete|vi\s+trovate)|mappa|google\s*maps|come\s+raggiungerci|ubicazion[ei]|posizion[ei])/i;
      const RE_HOURS =
        /(orari?|apert[oi]|chius[oi]|quando\s+(siete|siamo)\s+aperti|fino\s+a\s+che\s+ora)/i;

      if (RE_ADDR.test(t)) {
        const addr = "Via Bosco, 44/a, 42019 Reggio Emilia RE".trim();
        return reply(
          client,
          chatId,
          addr
            ? `Ci trovi qui:\n${addr}\n`
            : `Siamo in Via Bosco, 44/a, 42019 Reggio Emilia RE.`
        );
      }

      if (RE_HOURS.test(t)) {
        const hours = (config?.openingHours || config?.hours || "").trim();
        return reply(
          client,
          chatId,
          hours
            ? `Orari di apertura:\n${hours}`
            : `Orari tipici: Lun–Ven 9–19, Sab 9–13 (chiuso Dom).`
        );
      }
    }
    ensureContext(state);
// --- Guard lock: blocca solo NUOVI intenti, non gli step del flusso ---
if (isBookingLocked(state) && !isCancel) {
  if (!isInCriticalStep(state.step) && state.step !== "collect") {
    if (!/^(\/?modifica|prezzo|info)\b/i.test(t)) {
      await safeSend(client, chatId, '❌ Se non vuoi più prenotare, digita "annulla".', { noFooter: true });
      return { ok: true, ignored: true };
    }
  }
}


const col = state.collected || (state.collected = {});

    const setAndPersist = () => pending.set(chatId, state);
if (await maybeHandleAvailability(client, chatId, state, col, text, t)) return "";

    // --- COMANDI VELOCI DI MODIFICA ---
    if (
      /^(modifica|cambia)\s+(data|giorno)\b/i.test(t) ||
      /^\/data\b/i.test(t)
    ) {
      await startEditDate(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(ora|orario)\b/i.test(t) ||
      /^\/orario\b/i.test(t)
    ) {
      await startEditTime(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(professionista|operatrice|operatore)\b/i.test(t) ||
      /^\/pro(f)?\b/i.test(t)
    ) {
      await startEditProfessional(client, chatId);
      return "";
    }
    if (
      /^(modifica|cambia)\s+(nome|intestazione)\b/i.test(t) ||
      /^\/nome\b/i.test(t)
    ) {
      await startEditName(client, chatId);
      return "";
    }

    // --- MENU GENERICO /modifica ---
    if (/^\/?modifica\b/i.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (booking) {
        state.step = "edit_menu";
        state.edit = { target: booking };
        setAndPersist();
        await reply(client, chatId, showEditMenu(booking));
      } else {
        await reply(
          client,
          chatId,
          "Non ho trovato prenotazioni future col tuo numero."
        );
      }
      return "";
    }

    function renderSlotsList(slots) {
      if (!Array.isArray(slots) || !slots.length) return "";
      const isObj = typeof slots[0] === "object" && slots[0] && slots[0].time;
      if (!isObj) {
        return slots.map((h, i) => `${i + 1}) ${h}`).join("\n");
      }
      return slots
        .map((it, i) => {
          const prosLbl = labelProsForSlot(it);
          return `${i + 1}) ${it.time}${prosLbl ? ` (${prosLbl})` : ""}`;
        })
        .join("\n");
    }

    // ——— PRO LABELING ———
    function proShort(name) {
      const s = String(name || "").trim();
      if (!s) return "";
      const parts = s.split(/\s+/);
      if (parts.length === 1) return parts[0]; // es. "Melissa"
      const cognome = parts[parts.length - 1];
      const iniz = cognome[0] ? cognome[0].toUpperCase() : "";
      return `${parts[0]} ${iniz}.`; // "Melissa G."
    }

    function proKey(p) {
      const email = (p?.email || "").toLowerCase().trim();
      if (email) return email;
      const nm = (p?.name || p || "").toString();
      return norm(nm);
    }

    function labelProsForSlot(slot) {
      const pros = Array.isArray(slot?.pros) ? slot.pros : [];
      if (!pros.length) return "";

      // elenco pros “ufficiali” per il servizio corrente (se noto)
      const svcPros = (
        col?.service ? cfgServiceProfessionals(col.service) || [] : []
      ).filter((x) => x && (x.email || x.name));

      const totalSet = new Set(svcPros.map(proKey));
      const slotSet = new Set(pros.map(proKey));

      // ✅ vero subset check (non solo dimensione)
      const hasAll =
        totalSet.size > 0 && [...totalSet].every((k) => slotSet.has(k));
      if (hasAll) return "tutti";

      // abbreviato "Nome C."
      return pros.map((p) => proShort(p.name || p)).join(", ");
    }

    // Esito fetchSlots: sempre array di oggetti {time, pros[]} (adatta anche se fetchSlots restituisce stringhe)
    function normalizeSlotsDetail(slots) {
      if (!Array.isArray(slots)) return [];
      if (slots.length && typeof slots[0] === "object" && slots[0].time)
        return slots;
      return slots.map((h) => ({ time: h, pros: [] }));
    }

    // ===================== Debounce duplicati =====================
    if (!global.__lastMessages) global.__lastMessages = new Map();
    const lastMsg = global.__lastMessages.get(phone);
    if (lastMsg && lastMsg.text === text && Date.now() - lastMsg.ts < 800)
      return "";
    global.__lastMessages.set(phone, { text, ts: Date.now() });

    // ===================== Log messaggi (NO lock ancora) =====================
    try {
      appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "appendUserMessage failed", e?.message || e);
    }
    {
      // ===== VIEW-ONLY AVAILABILITY — MINI-FLOW =====
      // Usa: state.availFlow = { mode:'month'|'week', year, monthIdx, days:[Date], awaiting:'day' }

      // 1) Se sto aspettando il giorno (dopo "dicembre?" o "settimana prossima?")
      if (state.availFlow && state.availFlow.awaiting === "day") {
        if (/\b(annulla|indietro|esci|stop)\b/i.test(t)) {
          state.availFlow = null;
          setAndPersist();
          return reply(
            client,
            chatId,
            "Ok, annullato. Dimmi pure un’altra data."
          );
        }

        // prendi un numero 1..31 o "il 21"
        const m = String(text).match(/\b([1-9]|[12]\d|3[01])\b/);
        if (!m)
          return reply(
            client,
            chatId,
            'Dimmi il **giorno** in numero (es. "21").'
          );
        const dayNum = parseInt(m[1], 10);

        let targetDay = null;

        if (state.availFlow.mode === "month") {
          const { year, monthIdx } = state.availFlow;
          const max = daysInMonth(year, monthIdx);
          if (dayNum < 1 || dayNum > max) {
            return reply(
              client,
              chatId,
              `Giorno non valido per ${monthLabelIT(
                monthIdx
              )} (${max} giorni). Riprova con 1-${max}.`
            );
          }
          targetDay = new Date(year, monthIdx, dayNum, 12, 0, 0, 0);
        } else if (state.availFlow.mode === "week") {
          const arr = state.availFlow.days || [];
          // Se l’utente ha scritto 1..7 senza "il/di", prendilo come indice; altrimenti prova match sul giorno del mese
          if (
            dayNum >= 1 &&
            dayNum <= arr.length &&
            !/\b(il|del|di)\b/i.test(t)
          ) {
            targetDay = arr[dayNum - 1];
          } else {
            targetDay = arr.find((d) => d.getDate() === dayNum) || null;
            if (!targetDay) {
              const lines = arr
                .map(
                  (d, i) =>
                    `${i + 1}) ${String(d.getDate()).padStart(
                      2,
                      "0"
                    )} ${itaWeekdayName(d)}`
                )
                .join("\n");
              return reply(
                client,
                chatId,
                `Scegli un numero (1-${arr.length}) o un giorno del mese presente nella lista:\n${lines}`
              );
            }
          }
        }

        state.availFlow = null;
        setAndPersist();
        const msgOut = await buildAvailabilityMessage({
          day: atNoon(targetDay),
          service: col.service || null,
          duration: col.service ? cfgServiceDuration(col.service) : null,
          professional: col.professionalEmail || col.professionalName || null,
        });
        return reply(client, chatId, msgOut);
      }

      // 2) Nuova richiesta di disponibilità (giorno / settimana / mese)
      {
        const req = parseAvailabilityRequest(text);
        if (req) {
          const svcCtx = col.service || fuzzyServiceSafe(text) || null;
          const durCtx = svcCtx ? cfgServiceDuration(svcCtx) : null;

          if (req.kind === "day") {
            const msg = await buildAvailabilityMessage({
              day: atNoon(req.date),
              service: svcCtx,
              duration: durCtx,
              professional:
                col.professionalEmail || col.professionalName || null,
              window: req.window || null,
              after: req.after || null,
              before: req.before || null,
            });
            return reply(client, chatId, msg);
          }

          if (req.kind === "next_week") {
            const days = listNextWeekDays();
            state.availFlow = { mode: "week", days, awaiting: "day" };
            setAndPersist();
            const lines = days
              .map(
                (d, i) =>
                  `${i + 1}) ${String(d.getDate()).padStart(
                    2,
                    "0"
                  )} ${itaWeekdayName(d)}`
              )
              .join("\n");
            return reply(
              client,
              chatId,
              `Settimana prossima è troppo ampia: scegli un giorno.\n${lines}\nRispondi con **1-${
                days.length
              }** oppure con il **giorno** (es. "${String(
                days[0].getDate()
              ).padStart(2, "0")}").`
            );
          }

          if (req.kind === "month") {
            const { year, monthIdx } = req;
            state.availFlow = {
              mode: "month",
              year,
              monthIdx,
              awaiting: "day",
            };
            setAndPersist();
            return reply(
              client,
              chatId,
              buildAskDayOfMonthPrompt(year, monthIdx)
            );
          }
        }
      }
    }
// === MODALITÀ DISPONIBILITÀ (explorer) ===
async async function showDayAvailability(client, chatId, state, col, day, svcCtx, proCtx) {
  const duration = svcCtx ? cfgServiceDuration(svcCtx) : null;
  const slotsDetail = normalizeSlotsDetail(await fetchSlots({
    service: svcCtx || null,
    day: atNoon(day),
    duration,
    professional: proCtx || null,
    wantDetail: true,
  }));

  state.availFlow = {
    active: true,
    day: atNoon(day),
    service: svcCtx || null,
    professional: proCtx || null,
    slots: slotsDetail
  };

  const headSvc = svcCtx ? ` • ${svcCtx}` : "";
  const headPro = proCtx ? ` • ${proNameByEmail(proCtx) || proCtx}` : "";

  if (!slotsDetail || slotsDetail.length === 0) {
    return reply(
      client,
      chatId,
      `😕 Nessuna disponibilità per ${fmtDate(day)}${headSvc}${headPro}.\n` +
      `• Scrivi **domani**, **lunedì**, o una **data** per cambiare giorno\n` +
      `• Scrivi **annulla** per uscire.`
    );
  }

  const list = slotsDetail.map((it, i) => {
    const prosLbl = labelProsForSlot(it);
    return `${i + 1}) ${it.time}${prosLbl ? ` (${prosLbl})` : ""}`;
  }).join("\n");

  return reply(
    client,
    chatId,
    `📅 Disponibilità ${fmtDate(day)}${headSvc}${headPro}\n` +
    list +
    `\n\n• Scrivi un **numero** per scegliere un orario\n` +
    `• Scrivi **HH:MM** per prenotare direttamente\n` +
    `• Scrivi **domani** o una **data** per cambiare giorno\n` +
    `• Scrivi **annulla** per uscire`
  );
}

// — gestione interazioni in modalità disponibilità —
if (state.availFlow && state.availFlow.active) {
  if (/\b(annulla|esci|stop|indietro)\b/i.test(t)) {
    state.availFlow = null;
    pending.set(chatId, state);
    await reply(client, chatId, "Ok, uscita dalla ricerca di disponibilità.");
return "";

  } else {
    // 1) Numero da lista -> prenota
    if (/^\s*\d+\s*$/.test(text)) {
      const n = parseInt(text, 10);
      const opts = state.availFlow.slots || [];
      if (n >= 1 && n <= opts.length) {
        const picked = opts[n - 1];
        col.when = new Date(state.availFlow.day);
        col.time = picked.time;
        // auto-pro se un solo pro nello slot
        if (!col.professionalAny && !col.professionalEmail && !col.professionalName && picked?.pros?.length === 1) {
          col.professionalEmail = picked.pros[0].email;
          col.professionalName = picked.pros[0].name;
        }
        if (!col.service && state.availFlow.service) col.service = state.availFlow.service;
        state.step = "collect";
        bumpBookingLock(state);
        pending.set(chatId, state);
        return await advanceAppointment(false);
      }
    }

    // 2) Orario HH:MM -> prenota
    {
      const hhmm = parseTimeSmart(text);
      if (hhmm) {
        col.when = new Date(state.availFlow.day);
        col.time = hhmm;
        if (!col.service && state.availFlow.service) col.service = state.availFlow.service;
        state.step = "collect";
        bumpBookingLock(state);
        pending.set(chatId, state);
        return await advanceAppointment(false);
      }
    }

    // 3) Altra data -> ricarica disponibilità
    {
      const newDay = parseRelativeDay(text);
      if (newDay) {
        const svcCtx = state.availFlow.service || col.service || fuzzyServiceSafe(text) || null;
        const proCtx = col.professionalEmail || col.professionalName || null;
        return await showDayAvailability(client, chatId, state, col, newDay, svcCtx, proCtx);
      }
    }
    // se non riconosco niente, spiego come fare
    return reply(client, chatId, 'Scrivi **un numero**, un orario **HH:MM** o un’altra **data**. Per uscire scrivi **annulla**.');
  }
}

// --- TRIGGER DISPONIBILITÀ: helper hoistato e safe ---




    // ===================== PRIORITÀ INFO (prima di qualsiasi lock) =====================
    if (looksLikeInfoQuestion(text) && !isInCriticalStep(state.step)) {
      const svcCtx =
        resolveServiceFromText(text) ||
        fuzzyServiceSafe(text) ||
        col.service ||
        getLastService(chatId);

      const topic = extractInfoTopic(text); // <<--- MANCAVA

      if (svcCtx) rememberService(chatId, svcCtx);
      if (topic) rememberInfoTopic(chatId, topic);

      const prompt = buildQAPromptWithMemory(
        chatId,
        composeInfoPrompt(svcCtx, topic)
      );
      let answer = (await askQA(prompt, tools, client)).trim();

      if (!answer) {
        if (svcCtx) {
          answer = `• ${svcCtx}: ${cfgServicePriceText(
            svcCtx
          )} (durata ${cfgServiceDuration(svcCtx)} min)`;
        } else {
          return await askInfoWhichService(client, chatId, state, col);
        }
      }
      return reply(client, chatId, answer);
    }

    // ===================== Booking lock SOLO ora (se flusso attivo o messaggio sembra prenotazione) =====================
    if (isBookingFlowActive(state, col) || looksLikeBooking(text))
      bumpBookingLock(state);

    // ===================== Menu gestione prenotazione =====================
    if (
      (typeof wantsEditMenu === "function" && wantsEditMenu(t)) ||
      /\b(modifica|cancella|annulla)\b.*\b(appunt|prenot)\b/i.test(t) ||
      /\b(appunt|prenot)\b.*\b(modifica|cancella|annulla)\b/i.test(t)
    ) {
      const booking = getUpcomingBookingByPhone(phone);
      if (booking) {
        state.step = "edit_menu";
        state.edit = { target: booking };
        setAndPersist();
        return reply(client, chatId, showEditMenu(booking));
      }
      return reply(
        client,
        chatId,
        "Non ho trovato prenotazioni future col tuo numero."
      );
    }

    // === Gestione scelte del menu di editing ===
    if (state.step === "edit_menu") {
      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }

      if (!/^\s*[0-4]\s*$/.test(t)) {
        return reply(client, chatId, "Scegli un numero valido (0-4).");
      }
      const n = parseInt(t, 10);

      // 0) Cancella → chiedi conferma
      if (n === 0) {
        state.step = "edit_cancel_confirm";
        setAndPersist();
        const d = new Date(booking.startTime);
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        return reply(
          client,
          chatId,
          `Confermi di annullare l’appuntamento del ${dd}/${mm} alle ${hh}:${mi}? (sì/no)`
        );
      }

      // 1) Modifica data → chiedi nuova data
      if (n === 1) {
        state.step = "edit_reschedule_date";
        setAndPersist();
        return reply(
          client,
          chatId,
          "📅 Scrivi la **nuova data** (GG/MM o “domani”)."
        );
      }

      // 2) Modifica orario → mostra slot del giorno attuale della prenotazione
      if (n === 2) {
        const day = new Date(booking.startTime);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);
        const slots = normalizeSlotsDetail(
          await fetchSlots({
            service: booking.service,
            day,
            duration,
            professional:
              booking.professionalEmail || booking.professionalName || null,
            wantDetail: true,
          })
        );
        if (!slots.length)
          return reply(
            client,
            chatId,
            `Nessun orario libero per ${fmtDate(day)}.`
          );
        col.options = slots;
        state.edit.day = day;
        state.step = "edit_reschedule_time";
        setAndPersist();
        return reply(
          client,
          chatId,
          `Orari disponibili per ${fmtDate(day)}:\n${renderSlotsList(
            slots
          )}\n(1-${slots.length})`
        );
      }

      // 3) Modifica professionista
      if (n === 3) {
        const pros = (cfgServiceProfessionals(booking.service) || []).map(
          (p) => p.name
        );
        if (!pros.length)
          return reply(
            client,
            chatId,
            "Non ho professionisti configurati per questo servizio."
          );
        col.proOptions = pros;
        state.step = "edit_pick_professional";
        setAndPersist();
        return reply(
          client,
          chatId,
          `Preferisci un professionista in particolare?\n0) Non mi interessa\n${pros
            .map((p, i) => `${i + 1}) ${p}`)
            .join("\n")}\n(0-${pros.length})`
        );
      }

      // 4) Modifica nome
      if (n === 4) {
        state.step = "edit_change_name";
        setAndPersist();
        return reply(
          client,
          chatId,
          "Scrivi **nome e cognome** corretti (es. “Giulia Bianchi”)."
        );
      }
      return "";
    }
    if (state.step === "edit_cancel_confirm") {
      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(client, chatId, "Sessione scaduta.");
      }

      const yes = /\b(s[iì]|yes|y|ok|va bene|confermo|1)\b/i.test(t);
      const no = /\b(no|n|annulla|indietro|2)\b/i.test(t);

      if (yes) {
        await cancelEventSafe(booking.eventId);
        updateBookingByEventId(booking.eventId, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        });
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          `✅ Prenotazione del ${fmtDate(booking.startTime)} annullata.`
        );
      }
      if (no) {
        state.step = "edit_menu";
        setAndPersist();
        return reply(client, chatId, showEditMenu(booking));
      }
      return reply(client, chatId, "Rispondi **sì** o **no**.");
    }
    if (state.step === "edit_reschedule_time") {
      const booking = state.edit && state.edit.target;
      const options = col.options || [];
      if (!booking || !options.length) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }

      // Numero da lista
      if (pureNumber.test(text)) {
        const n = parseInt(text, 10);
        if (n < 1 || n > options.length) {
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${options.length}).`
          );
        }
        const item = options[n - 1];
        const chosen = typeof item === "string" ? item : item.time;

        const day = state.edit?.day
          ? new Date(state.edit.day)
          : new Date(booking.startTime);
        const newStart = setTime(day, chosen);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);

        // Mantieni lo stesso pro se possibile, altrimenti il primo libero nello slot
        let newProEmail = booking.professionalEmail;
        let newProName = booking.professionalName;
        const pros = typeof item === "object" && item?.pros ? item.pros : [];
        if (pros.length) {
          const same = pros.find(
            (p) => p.email && p.email === booking.professionalEmail
          );
          const pick = same || pros[0];
          newProEmail = pick.email || newProEmail;
          newProName = pick.name || newProName;
        }

        const ok = await updateEventSafe({
          eventId: booking.eventId,
          serviceName: booking.service,
          professionalEmail: newProEmail,
          clientPhone: booking.clientPhone,
          startTime: toISOStringLocal(newStart),
          durationMin: duration,
        });

        if (ok) {
          updateBookingByEventId(booking.eventId, {
            startTime: toISOStringLocal(newStart),
            professionalEmail: newProEmail,
            professionalName: newProName || proNameByEmail(newProEmail),
          });
          pending.delete(chatId);
          return reply(
            client,
            chatId,
            `✅ Appuntamento spostato a ${fmtDate(newStart)} alle ${chosen}.`
          );
        }
        return reply(
          client,
          chatId,
          "❌ Non sono riuscito a spostare l’appuntamento. Riprova tra poco."
        );
      }

      // Orario libero HH:MM
      const hhmm = parseTimeSmart(text);
if (hhmm) {


        const day = state.edit?.day
          ? new Date(state.edit.day)
          : new Date(booking.startTime);
        const newStart = setTime(day, hhmm);
        const duration =
          Number(booking.durationMin) || cfgServiceDuration(booking.service);

        const ok = await updateEventSafe({
          eventId: booking.eventId,
          serviceName: booking.service,
          professionalEmail: booking.professionalEmail,
          clientPhone: booking.clientPhone,
          startTime: toISOStringLocal(newStart),
          durationMin: duration,
        });
        if (ok) {
          updateBookingByEventId(booking.eventId, {
            startTime: toISOStringLocal(newStart),
          });
          pending.delete(chatId);
          return reply(
            client,
            chatId,
            `✅ Appuntamento spostato a ${fmtDate(newStart)} alle ${hhmm}.`
          );
        }
        return reply(
          client,
          chatId,
          "❌ Non sono riuscito a spostare l’appuntamento. Riprova."
        );
      }

      return reply(
        client,
        chatId,
        `Scegli un numero (1-${options.length}) o scrivi un orario **HH:MM**.`
      );
    }

    // ===================== Shortcut “edit_*” (data / pro / nome) =====================
    // Cambio data → chiedi nuova data e poi proponi orari (con pros)
    if (state.step === "edit_reschedule_date") {
      const booking = state.edit && state.edit.target;
      if (!booking) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
        );
      }
      const day = parseRelativeDay(t);
      if (!day)
        return reply(
          client,
          chatId,
          "Formato data non riconosciuto. Scrivi GG/MM o “domani”."
        );

      state.step = "edit_reschedule_time";
      state.edit.day = day;
      setAndPersist();

      const duration =
        Number(booking.durationMin) || cfgServiceDuration(booking.service);
      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: booking.service,
          day,
          duration,
          professional:
            booking.professionalEmail || booking.professionalName || null,
          wantDetail: true,
        })
      );
      if (!slots.length) {
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDate(day)}. Prova un altro giorno.`
        );
      }
      col.options = slots;
      setAndPersist();
      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(day)}:\n${renderSlotsList(
          slots
        )}\n(1-${slots.length})`
      );
    }

    // Cambio professionista
    if (state.step === "edit_pick_professional") {
      const booking = state.edit && state.edit.target;
      const pros = col.proOptions || [];
      const n = parseInt(t, 10);
      if (isNaN(n) || n < 1 || n > pros.length) {
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${pros.length}).`
        );
      }
      const newProName = pros[n - 1];
      const newProEmail = proEmailByName(newProName);

      const currentDate = new Date(booking.startTime);
      const duration =
        Number(booking.durationMin) || cfgServiceDuration(booking.service);
      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: booking.service,
          day: currentDate,
          duration,
          professional: newProEmail || newProName,
          wantDetail: true,
        })
      );
      const hhmm = booking.startTime.slice(11, 16);
      const times = slots.map((x) => x.time);
      if (!times.includes(hhmm)) {
        state.step = "edit_reschedule_time";
        state.edit.day = currentDate;
        col.options = slots;
        setAndPersist();
        return reply(
          client,
          chatId,
          `A quell'ora ${newProName} non è libero. Ecco gli orari disponibili per ${fmtDate(
            currentDate
          )}:\n${renderSlotsList(slots)}\n(1-${slots.length})`
        );
      }
      const startISO = toISOStringLocal(currentDate);
      const ok = await updateEventSafe({
        eventId: booking.eventId,
        serviceName: booking.service,
        professionalEmail: newProEmail || booking.professionalEmail,
        clientPhone: booking.clientPhone,
        startTime: startISO,
        durationMin: booking.durationMin,
      });
      if (ok) {
        updateBookingByEventId(booking.eventId, {
          professionalEmail: newProEmail,
          professionalName: newProName,
        });
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          `✅ Professionista aggiornato: ${newProName}.`
        );
      }
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a modificare il professionista."
      );
    }

    // Cambio nome
    if (state.step === "edit_change_name") {
      const booking = state.edit && state.edit.target;
      const name = extractCustomerName(text) || t;
      if (!booking || !name || name.split(" ").length < 2) {
        return reply(
          client,
          chatId,
          "Scrivi nome e cognome (es. “Giulia Bianchi”)."
        );
      }
      const ok = await updateEventSafe({
        eventId: booking.eventId,
        serviceName: booking.service,
        professionalEmail: booking.professionalEmail,
        clientPhone: booking.clientPhone,
        startTime: booking.startTime,
        durationMin: booking.durationMin,
        notes:
          (booking.notes || "").replace(/Nome:\s*.*$/im, "").trim() +
          `\nNome: ${name}`,
      });
      if (ok) {
        updateBookingByEventId(booking.eventId, { customerName: name });
        pending.delete(chatId);
        return reply(client, chatId, `✅ Nome aggiornato: ${name}.`);
      }
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a modificare il nome."
      );
    }

    // ===================== Reset conversazione =====================
    if (/^\s*(annulla|reset|stop|cancella|ricomincia)\s*$/i.test(t)) {
      if (state) unlockBooking(state);
      pending.delete(chatId);
      releaseSoftHoldByChat(chatId);

      return reply(
        client,
        chatId,
        "👍 Ok, procedura annullata. Dimmi pure come posso aiutarti."
      );
    }

    // ===================== Anti-loop: se "qualsiasi professionista" già scelto =====================
    if (state.step === "pick_professional" && col.professionalAny === true) {
      state.step = "collect";
      setAndPersist();
    }

    // ===================== Shortcut gestione cancellazione/spostamento =====================
    const manageCancelPattern =
      /\b(?:annull|cancell|disd)\w*.*\b(?:appunt|prenot)\w*/i;
    const manageModifyPattern =
      /\b(?:modif|spost|camb)\w*.*\b(?:appunt|prenot)\w*/i;

    if (manageCancelPattern.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (!booking)
        return reply(
          client,
          chatId,
          "🤔 Non risulta alcuna prenotazione da annullare."
        );
      const startTs = new Date(booking.startTime).getTime();
      if (startTs - Date.now() < CANCEL_POLICY_HOURS * 3600 * 1000) {
        return reply(
          client,
          chatId,
          `Mancano meno di ${CANCEL_POLICY_HOURS} ore: non posso annullare automaticamente. Contatta il salone.`
        );
      }
      await cancelEventSafe(booking.eventId);
      updateBookingByEventId(booking.eventId, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      });
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        `✅ Prenotazione del ${fmtDate(
          booking.startTime
        )} alle ${booking.startTime.slice(11, 16)} annullata.`
      );
    }

    if (manageModifyPattern.test(t)) {
      const booking = getUpcomingBookingByPhone(phone);
      if (!booking)
        return reply(
          client,
          chatId,
          "🤔 Non risulta alcuna prenotazione da modificare."
        );
      if (state) unlockBooking(state);
      pending.delete(chatId);
      state = {
        step: "collect",
        collected: {
          service: booking.service,
          when: null,
          time: null,
          professionalAny: false,
          professionalName:
            booking.professionalName ||
            proNameByEmail(booking.professionalEmail),
          professionalEmail: booking.professionalEmail,
          customerName: booking.customerName,
          allergies: booking.allergies || null,
          options: [],
          proOptions: null,
          daypartWindow: null,
          infoOptions: null,
          pendingTime: null,
          allSlotsMode: false,
          eventId: booking.eventId,
        },
        context: { lastService: null, lastInfoTopic: null, lock: null },
      };
      ensureContext(state);
      pending.set(chatId, state);
      await reply(
        client,
        chatId,
        `Hai un appuntamento per **${booking.service}** il **${fmtDate(
          booking.startTime
        )}** alle **${booking.startTime.slice(
          11,
          16
        )}**.\n📅 Per quando vuoi spostarlo? (Indica una nuova data)`
      );
      return "";
    }

    // ===================== Helpers inline per avanzamento =====================
    const gotoPickTime = async (day) => {
      const duration = cfgServiceDuration(col.service);
      const proEmail = col.professionalAny
        ? null
        : col.professionalEmail ||
          (col.professionalName ? proEmailByName(col.professionalName) : null);

      const slotsRaw = await fetchSlots({
        service: col.service,
        day,
        duration,
        professional: proEmail || null,
        wantDetail: true, // chiedi dettaglio pros per slot
      });
      const slotsDetail = normalizeSlotsDetail(slotsRaw);
      let filtered = filterSlotsByWindow(
        slotsDetail.map((s) => s.time),
        col.daypartWindow || null
      )
        .map((h) => slotsDetail.find((s) => s.time === h))
        .filter(Boolean);

      if (!filtered.length) return null;

      col.options = filtered;
      state.step = "pick_time";
      bumpBookingLock(state);
      setAndPersist();

      // Raggruppo per daypart renderizzando pros
      const grouped = groupSlotsByDaypart(filtered.map((s) => s.time));
      const mk = (title, arr) => {
        if (!arr.length) return "";
        const lines = arr
          .map((h) => {
            const item = filtered.find((x) => x.time === h) || { pros: [] };
            const prosLbl = labelProsForSlot(item);
            return `• ${h}${prosLbl ? ` (${prosLbl})` : ""}`;
          })
          .join("\n");
        return `${title}\n${lines}`;
      };
      const listText = [
        mk("Mattina:", grouped.mattina),
        mk("Pomeriggio:", grouped.pomeriggio),
        mk("Sera:", grouped.sera),
      ]
        .filter(Boolean)
        .join("\n");

      const allergBanner = getAllergens(col.service).length
        ? `\nAllergeni monitorati: ${getAllergens(col.service).join(", ")}`
        : "";

      const header = proEmail
        ? `📅 Disponibilità per il ${fmtDate(day)} (solo ${
            col.professionalName || proNameByEmail(proEmail)
          }):`
        : `📅 Disponibilità per il ${fmtDate(day)} (tutti i professionisti):`;

      const extra = proEmail ? `\n0) Vedi tutti gli slot disponibili` : ``;
      const range = proEmail
        ? `(0-${col.options.length})`
        : `(1-${col.options.length})`;
      return reply(
        client,
        chatId,
        `${header}${allergBanner}\n${listText}${extra}\n${range}`
      );
    };

    const askNameIfMissing = () => {
      if (!col.customerName) {
        state.step = "ask_name";
        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, "Per favore, il tuo nome e cognome? 😊");
      }
      return null;
    };

    const askProfessionalIfNeeded = () => {
      if (
        !col.professionalAny &&
        !col.professionalName &&
        !col.professionalEmail
      ) {
        const prosSpec = cfgServiceProfessionals(col.service);
        const names = prosSpec.length
          ? prosSpec.map((p) => p.name)
          : Object.values(config.professionals || {}).map((p) => p.name);

        // Se ci sono professionisti, chiedi SEMPRE; niente auto-assegnazione
        if (names.length >= 1) {
          col.proOptions = names; // SOLO nomi
          state.step = "pick_professional";
          bumpBookingLock(state);
          setAndPersist();
          const list = names.map((n, i) => `${i + 1}) ${n}`).join("\n");
          return reply(
            client,
            chatId,
            `Preferisci un professionista in particolare?\n0) Non mi interessa\n${list}\n(0-${names.length})`
          );
        }

        // Nessun pro noto -> chiedi testo libero
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "Preferisci un professionista in particolare? (scrivi il nome)"
        );
      }
      return null;
    };

    const gateAllergiesIfNeeded = () => {
      const allergyPrompt = askAllergies(col.service);
      if (
        col.service &&
        allergyPrompt &&
        (!col.allergies || typeof col.allergies.has !== "boolean")
      ) {
        state.step = "ask_allergies";
        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, allergyPrompt);
      }
      return null;
    };

    const advanceAppointment = async (useIntakeFromText) => {
      if (useIntakeFromText) {
        const intake = parseIntake(text);
        if (pureNumber.test(text)) delete intake.time; // evita 2 -> 02:00
        Object.assign(col, intake);

        // Scelta servizio numerica
        if (!col.service && pureNumber.test(text)) {
          const svcs = cfgServices();
          const idx = parseInt(text, 10);
          if (!isNaN(idx) && svcs[idx - 1]) {
            col.service = svcs[idx - 1];
            col.time = null;
          }
        }

        if (col.service) {
          rememberService(chatId, col.service);
          const allergens = getAllergens(col.service);
          if (allergens.length && !col._allergenAlertShown) {
            await reply(
              client,
              chatId,
              `⚠️ Attenzione allergeni per "${col.service}": ${allergens.join(
                ", "
              )}`
            );
            col._allergenAlertShown = true; // evita ripetizioni
            pending.set(chatId, state);
            setAndPersist();
          }
        }
      }
      // === Esegui fast booking se richiesto ===
if (__wantFastBooking__) {
  state.step = "collect";
  bumpBookingLock(state);
  pending.set(chatId, state);
  const r = await advanceAppointment(true);
  if (r) return r;
}


      // 1) Servizio
      if (!col.service) {
        // 🔹 salva che stiamo aspettando una scelta numerica 1..N
        col.svcOptions = cfgServices();
        state.step = "choose_service";
        pending.set(chatId, state);

        bumpBookingLock(state);
        setAndPersist();
        return reply(client, chatId, askService(state, chatId));

      }

      // 2) Allergie
      {
        const r = gateAllergiesIfNeeded();
        if (r) return r;
      }

      // 3) Professionista (se necessario)
      {
        const r = askProfessionalIfNeeded();
        if (r) return r;
      }

      // 4) Data
      if (!col.when) {
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          '📅 Per quale data vuoi prenotare? (giorno/mese o "domani")'
        );
      }
      if (col.when && isPast(setTime(col.when, col.time || "23:59"))) {
        col.when = nextOpenDay(new Date());
      }

      // 5) Orario
      if (!col.time) {
        const day = atNoon(col.when);
        const resp = await gotoPickTime(day);
        if (resp) return resp;
        const altDay = nextOpenDay(day);
        const altResp = await gotoPickTime(altDay);
        if (altResp) {
          col.when = altDay;
          return altResp;
        }
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "😕 Non ho trovato disponibilità. Prova con un’altra data o un orario diverso."
        );
      }

      // 6) Nome
      {
        const r = askNameIfMissing();
        if (r) return r;
      }

      // 7) Verifica slot e conferma
      const duration = cfgServiceDuration(col.service);
      const start = setTime(col.when, col.time);

      if (cfgClosedDay(start)) {
        const altDay = nextOpenDay(start);
        const altSlots = normalizeSlotsDetail(
          await fetchSlots({
            service: col.service,
            day: altDay,
            duration,
            professional: col.professionalAny
              ? null
              : col.professionalEmail || col.professionalName || null,
            wantDetail: true,
          })
        );
        if (altSlots.length) {
          col.when = altDay;
          col.options = altSlots;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `Il giorno dopo (${fmtDate(
              altDay
            )}) ho questi orari disponibili:\n${renderSlotsList(
              altSlots
            )}\n(1-${altSlots.length})`
          );
        }
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "🤔 Non ho trovato slot vicini. Vuoi cambiare data o fascia oraria?"
        );
      }

      const daySlots = normalizeSlotsDetail(
        await fetchSlots({
          service: col.service,
          day: atNoon(start),
          duration,
          professional: col.professionalAny
            ? null
            : col.professionalEmail || col.professionalName || null,
          wantDetail: true,
        })
      );
      const dayTimes = daySlots.map((x) => x.time);

      if (dayTimes.includes(col.time)) {
        // Se NON hai un pro e l’API GCAL lo richiede, scegli automaticamente il primo libero per quell’orario
        if (
          !col.professionalAny &&
          !col.professionalEmail &&
          !col.professionalName
        ) {
          const slotItem = daySlots.find((x) => x.time === col.time);
          if (slotItem && slotItem.pros && slotItem.pros.length) {
            col.professionalEmail = slotItem.pros[0].email;
            col.professionalName = slotItem.pros[0].name;
          }
        }
        try {
          // === Risolvi pro per lo slot scelto (robusto) ===
          const slot = daySlots.find((s) => s.time === col.time);

          const pe = col.professionalAny
            ? slot && slot.pros && slot.pros[0]
              ? slot.pros[0].email
              : null
            : col.professionalEmail ||
              (col.professionalName
                ? proEmailByName(col.professionalName)
                : null);

          const pn = col.professionalAny
            ? slot && slot.pros && slot.pros[0]
              ? slot.pros[0].name
              : null
            : col.professionalName ||
              proNameByEmail(col.professionalEmail) ||
              null;

          // Se manca l'email del pro, non chiamare GCal: chiedi di scegliere altro orario
          if (!pe) {
            state.step = "pick_time";
            col.options = daySlots; // ripropone gli slot del giorno
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              "⚠️ Nessun professionista libero per quell’orario. Scegli un altro orario o invia 0 per vedere tutti gli slot."
            );
          }

          // === Titolo + note con marcatura allergie ===
          const allergFlag =
            col.allergies && col.allergies.has ? "⚠️ ALLERGENI " : "";
          const baseTitle = `${allergFlag}${col.service}`;

          const listed =
            col.allergies && Array.isArray(col.allergies.list)
              ? col.allergies.list.filter(Boolean)
              : [];

          const monitored = getAllergens(col.service);
          const monitoredStr = monitored.length ? monitored.join(", ") : "—";

          const notes =
            col.allergies && col.allergies.has
              ? `Cliente: ${col.customerName}. Allergie dichiarate${
                  listed.length ? `: ${listed.join(", ")}` : ""
                }. Allergeni (config): ${monitoredStr}. Contattare prima del trattamento.`
              : `Cliente: ${col.customerName}. Allergeni (config): ${monitoredStr}.`;

          // === Anti-doppio invio ===
          const fingerprint = `${col.service}|${pe}|${new Date(
            start
          ).toISOString()}`;
          if (state.txId && state.eventFingerprint === fingerprint) return "";
          state.txId = Date.now();
          state.eventFingerprint = fingerprint;

          // === Soft-hold (5') per evitare race tra più utenti su stesso slot/pro
          const holdOk = acquireSoftHold({
            chatId,
            professionalEmail: pe,
            startTime: start,
            durationMin: duration,
          });
          if (!holdOk) {
            // lo slot è stato appena preso: proponi alternative
            const freshSlots = normalizeSlotsDetail(
              await fetchSlots({
                service: col.service,
                day: atNoon(start),
                duration,
                professional: col.professionalAny
                  ? null
                  : col.professionalEmail || col.professionalName || null,
                wantDetail: true,
              })
            );
            if (!freshSlots.length) {
              return reply(
                client,
                chatId,
                "Quel posto è appena stato occupato 😕. Non ho più disponibilità per quel giorno."
              );
            }
            col.options = freshSlots;
            state.step = "pick_time";
            setAndPersist();
            return reply(
              client,
              chatId,
              `Quel posto è appena stato occupato 😕. Disponibili invece:\n${renderSlotsList(
                freshSlots
              )}\n(1-${freshSlots.length})`
            );
          }

          // === Crea evento (passando anche i campi “umani”) ===
          let eventData;
          try {
            eventData = await makeEvent({
              serviceName: baseTitle,
              professionalEmail: pe,
              professionalName: pn,
              customerName: col.customerName,
              clientPhone: chatId,
              startTime: start,
              durationMin: duration,
              notes,
              allergic: !!(col.allergies && col.allergies.has),
              allergies: listed.length
                ? listed
                : col.allergies && col.allergies.has
                ? "sì (non specificate)"
                : null,
            });
          } finally {
            // rilascia sempre l'hold (successo o errore)
            releaseSoftHoldByChat(chatId);
          }

          // === Persist booking con i dati risolti ===
          persistBooking({
            eventId: eventData.id || null,
            service: col.service,
            professionalEmail: pe,
            professionalName: pn,
            clientPhone: chatId,
            customerName: col.customerName,
            startTime: new Date(start).toISOString(),
            durationMin: duration,
            allergies: col.allergies || null,
            status: "confirmed",
            createdAt: new Date().toISOString(),
          });

          // === Chiudi flow ===
          unlockBooking(state);
          pending.delete(chatId);

          const promos = (
            Array.isArray(config.promotions) ? config.promotions : []
          )
            .filter((p) => norm(p.service || "") === norm(col.service))
            .map((p) => p.text)
            .filter(Boolean);

          const allergyNote = (() => {
            if (!askAllergies(col.service)) return "";
            const allMonitored = getAllergens(col.service);
            const monitoredText = allMonitored.length
              ? `\nAllergeni (attenzione): ${allMonitored.join(", ")}`
              : "";
            if (col.allergies?.has) {
              const listed2 =
                col.allergies.list && col.allergies.list.length
                  ? ` (${col.allergies.list.join(", ")})`
                  : "";
              return `\n⚠️ Allergie dichiarate${listed2}.${monitoredText}\nTi consigliamo di contattare il salone prima del trattamento.`;
            }
            return `\nAllergie: nessuna dichiarata.${monitoredText}`;
          })();

          const proLabel = pn || "operatore";

          return reply(
            client,
            chatId,
            `✅ Prenotazione confermata: ${
              col.service
            } con ${proLabel} il ${fmtDate(start)} alle ${col.time} a nome ${
              col.customerName
            }. Prezzo: ${cfgServicePriceText(col.service)}${
              promos.length ? `\nPromo attive: ${promos.join(" • ")}` : ""
            }${allergyNote}\nGrazie e a presto! 🎉
    \n
    Nota bene: per annullare o modificare l'appuntamento basta scrivere "modifica" o "annulla"!`
          );
        } catch (e) {
          log("error", "createCalendarEvent", e?.message || e);
          state.txId = null;
          state.eventFingerprint = null;
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            "❌ Errore durante la conferma. Riproviamo tra poco, per favore."
          );
        }
      } else {
        const nearTimes = nearestTimes(dayTimes, col.time, 3);
        if (nearTimes.length) {
          const nearDetail = daySlots.filter((x) => nearTimes.includes(x.time));
          col.options = nearDetail;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `A quell'ora non c'è posto. Ti posso proporre questi orari vicini:\n${renderSlotsList(
              nearDetail
            )}\n(1-${nearDetail.length})`
          );
        }
        const altDay = nextOpenDay(new Date(col.when.getTime() + 86400000));
        const altSlots = normalizeSlotsDetail(
          await fetchSlots({
            service: col.service,
            day: altDay,
            duration,
            professional: col.professionalAny
              ? null
              : col.professionalEmail || col.professionalName || null,
            wantDetail: true,
          })
        );
        if (altSlots.length) {
          col.when = altDay;
          col.options = altSlots;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `Il giorno dopo (${fmtDate(
              altDay
            )}) ho questi orari disponibili:\n${renderSlotsList(
              altSlots
            )}\n(1-${altSlots.length})`
          );
        }
        bumpBookingLock(state);
        setAndPersist();
        return reply(
          client,
          chatId,
          "🤔 Non ho trovato slot vicini. Cambiamo data o orario?"
        );
      }
    };
// === FASTLANE: frase unica con servizio+data+ora ===
{
  const intake = parseIntake(text);
  const hasBookingWords = /\b(prenot|appunt|riserv|posto|liber[oi])\w*/i.test(t);
  if (hasBookingWords && (intake.service || intake.when || intake.time)) {
    Object.assign(col, intake);
    state.step = "collect";
    bumpBookingLock(state);
    pending.set(chatId, state);
    const r = await advanceAppointment(false);
    if (r) return r;
  }
}

    // ===================== FASTLANE: professionista dal testo =====================
    if (
      col.service &&
      !col.professionalAny &&
      !col.professionalName &&
      !col.professionalEmail
    ) {
      const proHit = findProfessionalCandidatesByText(text, col.service);
      if (proHit?.resolved) {
        col.professionalAny = false;
        col.professionalName = proHit.resolved;
        col.professionalEmail = proEmailByName(proHit.resolved);
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(true);
      }
      if (proHit?.ambiguous?.length) {
        col.proOptions = proHit.ambiguous; // SOLO nomi
        state.step = "pick_professional";
        bumpBookingLock(state);
        setAndPersist();
        const list = proHit.ambiguous
          .map((n, i) => `${i + 1}) ${n}`)
          .join("\n");
        return reply(
          client,
          chatId,
          `Preferisci un professionista in particolare?\n0) Non mi interessa\n${list}\n(0-${proHit.ambiguous.length})`
        );
      }
    }

    // ===================== Step aperti =====================
    if (state.step === "ask_name") {
      const name = extractCustomerName(text);
      if (name) {
        col.customerName = name;
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }
      return reply(
        client,
        chatId,
        "Scrivi nome e cognome completi (es. “Giulia Bianchi”)."
      );
    }

    if (state.step === "price_select_service") {
      if (pureNumber.test(text)) {
        const list = col.infoOptions || [];
        const idx = parseInt(text, 10) - 1;
        const svc = list[idx];
        if (!svc)
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${list.length}).`
          );
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svc);
        setAndPersist();
        return reply(
          client,
          chatId,
          `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
            svc
          )} min)`
        );
      }
      const svcByText = fuzzyServiceSafe(text);

      if (svcByText) {
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svcByText);
        setAndPersist();
        return reply(
          client,
          chatId,
          `• ${svcByText}: ${cfgServicePriceText(
            svcByText
          )} (durata ${cfgServiceDuration(svcByText)} min)`
        );
      }
    }

    if (state.step === "info_select_service") {
      if (pureNumber.test(text)) {
        const list = col.infoOptions || [];
        const idx = parseInt(text, 10) - 1;
        const svc = list[idx];
        if (!svc)
          return reply(
            client,
            chatId,
            `Scegli un numero valido (1-${list.length}).`
          );
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svc);
        setAndPersist();
        const topic = getLastInfoTopic(chatId);
        let a = (
          await askQA(
            buildQAPromptWithMemory(chatId, composeInfoPrompt(svc, topic)),
            tools,
            client
          )
        ).trim();
        if (!a)
          a = `• ${svc}: ${cfgServicePriceText(
            svc
          )} (durata ${cfgServiceDuration(svc)} min)`;
        return reply(client, chatId, a);
      }
      const svcByText = fuzzyServiceSafe(text);

      if (svcByText) {
        state.step = "collect";
        col.infoOptions = null;
        rememberService(chatId, svcByText);
        setAndPersist();
        const topic = getLastInfoTopic(chatId);
        let a = (
          await askQA(
            buildQAPromptWithMemory(
              chatId,
              composeInfoPrompt(svcByText, topic)
            ),
            tools,
            client
          )
        ).trim();
        if (!a)
          a = `• ${svcByText}: ${cfgServicePriceText(
            svcByText
          )} (durata ${cfgServiceDuration(svcByText)} min)`;
        return reply(client, chatId, a);
      }
    }
    if (state.step === "choose_service") {
      // numero 1..N?
      if (pureNumber.test(text)) {
        const list = state.collected.svcOptions || cfgServices();
        const idx = parseInt(text, 10) - 1;
        const svc = list[idx];
        if (!svc) {
          return reply(
            client,
            chatId,
            `Scegli un numero tra 1 e ${list.length}.`
          );
        }
        state.step = "collect";
        state.collected.service = svc;
        rememberService(chatId, svc);
        bumpBookingLock(state);
        pending.set(chatId, state);
        setAndPersist();
        return advanceAppointment(false);
      }

      // oppure hanno scritto il nome del servizio
      const svcByText = fuzzyServiceSafe(text);
      if (svcByText) {
        state.step = "collect";
        state.collected.service = svcByText;
        rememberService(chatId, svcByText);
        bumpBookingLock(state);
        pending.set(chatId, state);
        setAndPersist();
        return advanceAppointment(false);
      }

      const list = state.collected.svcOptions || cfgServices();
      return reply(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    }

    if (state.step === "pick_time") {
      const win = parseDaypartWindow(text);
      if (win) {
        col.daypartWindow = win;
        col.time = null;
        bumpBookingLock(state);
        setAndPersist();
        const day = atNoon(col.when);
        const r = await gotoPickTime(day);
        if (r) return r;
        const altDay = nextOpenDay(day);
        const alt = await gotoPickTime(altDay);
        if (alt) {
          col.when = altDay;
          return alt;
        }
        return reply(
          client,
          chatId,
          "In quella fascia non ho disponibilità. Prova un’altra fascia (mattina/pomeriggio/sera) o un orario preciso (es. 10:30)."
        );
      }

      if (pureNumber.test(text) && col.options) {
        const n = parseInt(text, 10);
        if (n === 0) {
          const duration = cfgServiceDuration(col.service);
          const allSlots = normalizeSlotsDetail(
            await fetchSlots({
              service: col.service,
              day: atNoon(col.when),
              duration,
              professional: null,
              wantDetail: true,
            })
          );
          if (!allSlots.length)
            return reply(
              client,
              chatId,
              "Nessuno slot disponibile in quel giorno."
            );
          col.options = allSlots;
          col.allSlotsMode = true;
          state.step = "pick_time";
          bumpBookingLock(state);
          setAndPersist();
          return reply(
            client,
            chatId,
            `Tutti gli slot disponibili (${fmtDate(
              col.when
            )}):\n${renderSlotsList(allSlots)}\n(1-${allSlots.length})`
          );
        }
        const item = col.options[n - 1];
        if (item) {
          const chosenTime = typeof item === "string" ? item : item.time;
          col.time = chosenTime;

          // Se un solo pro disponibile per quello slot e l’utente non ha espresso preferenze → auto-assegna
          if (
            !col.professionalAny &&
            !col.professionalEmail &&
            !col.professionalName &&
            item?.pros?.length === 1
          ) {
            col.professionalEmail = item.pros[0].email;
            col.professionalName = item.pros[0].name;
          } else if (
            !col.professionalAny &&
            !col.professionalEmail &&
            !col.professionalName &&
            item?.pros?.length > 1
          ) {
            col.proOptions = item.pros.map((p) => p.name);
            col.pendingTime = chosenTime;
            state.step = "pick_professional_for_slot";
            bumpBookingLock(state);
            setAndPersist();
            return reply(
              client,
              chatId,
              `Per ${chosenTime} chi preferisci?\n${col.proOptions
                .map((n, i) => `${i + 1}) ${n}`)
                .join("\n")}\n(1-${col.proOptions.length})`
            );
          }
          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return advanceAppointment(false);
        }
        return reply(
          client,
          chatId,
          `Scrivi un numero valido (0-${col.options.length}).`
        );
      }

      const hhmm = parseTimeSmart(text);
if (hhmm) {

        col.time = hhmm;
        col.daypartWindow = null;
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }
    }

    if (state.step === "pick_professional") {
      // Sanifica: rimuovi eventuali residui di "Non mi interessa" salvati in vecchie sessioni
      let names = (col.proOptions || []).filter(
        (x) => typeof x === "string" && norm(x) !== norm("Non mi interessa")
      );

      if (pureNumber.test(text)) {
        const n = parseInt(text, 10);

        // 0 = Non mi interessa
        if (n === 0) {
          col.professionalAny = true;
          col.professionalName = null;
          col.professionalEmail = null;
          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return advanceAppointment(false);
        }

        // 1..names.length = scelta valida
        if (n >= 1 && n <= names.length) {
          const pickedName = names[n - 1];
          col.professionalAny = false;
          col.professionalName = pickedName;
          col.professionalEmail = proEmailByName(pickedName);
          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return advanceAppointment(false);
        }

        // Fuori range → errore
        return reply(
          client,
          chatId,
          `Scegli un numero valido (0-${names.length}).`
        );
      }

      // Parsing testo libero
      const proHit = findProfessionalCandidatesByText(text, col.service);
      if (proHit?.resolved) {
        col.professionalAny = false;
        col.professionalName = proHit.resolved;
        col.professionalEmail = proEmailByName(col.professionalName);
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }
      if (proHit?.ambiguous?.length) {
        col.proOptions = proHit.ambiguous; // SOLO nomi
        state.step = "pick_professional";
        setAndPersist();
        return reply(client, chatId, askProfessional(col.service));
      }

      bumpBookingLock(state);
      setAndPersist();
      return reply(client, chatId, askProfessional(col.service));
    }

    if (state.step === "pick_professional_for_slot") {
      const names = col.proOptions || [];
      if (pureNumber.test(text)) {
        const n = parseInt(text, 10);
        if (names[n - 1]) {
          col.professionalAny = false;
          col.professionalName = names[n - 1];
          col.professionalEmail = proEmailByName(col.professionalName);
          const chosenTime = col.pendingTime;
          col.time = chosenTime;
          col.pendingTime = null;
          state.step = "collect";
          bumpBookingLock(state);
          setAndPersist();
          return advanceAppointment(false);
        }
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${names.length}).`
        );
      }
      const proHit = findProfessionalCandidatesByText(text, col.service);
      if (proHit?.resolved && names.includes(proHit.resolved)) {
        col.professionalAny = false;
        col.professionalName = proHit.resolved;
        col.professionalEmail = proEmailByName(col.professionalName);
        const chosenTime = col.pendingTime;
        col.time = chosenTime;
        col.pendingTime = null;
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        return advanceAppointment(false);
      }
      const list = names.map((p, i) => `${i + 1}) ${p}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli tra questi professionisti per le ${col.pendingTime}:\n${list}\n(1-${names.length})`
      );
    }

    if (state.step === "ask_allergies") {
      const info = parseAllergyInfo(text, col.service);
      if (info) {
        col.allergies = {
          has: !!info.has,
          list: Array.isArray(info.list) ? info.list : [],
        };
        state.step = "collect";
        bumpBookingLock(state);
        setAndPersist();
        if (col.allergies.has) {
          await reply(
            client,
            chatId,
            "⚠️ Ho segnato le allergie. Procedo a fissare la prenotazione, ma chiama il negozio per avvisare e concordare meglio il tuo appuntamento."
          );
        }
        return advanceAppointment(false);
      }
      return reply(
        client,
        chatId,
        askAllergies(col.service) || "Sei allergico a qualcosa? (sì/no)"
      );
    }

    // ===================== ROUTER IBRIDO (regex + fuzzy) =====================
    if (!isInCriticalStep(state.step)) {
      const quick = intentByHybrid(text);
      function hasFutureBookingsForPhone(phone) {
        try {
          const all = readJSON("bookings.json", []);
          const now = Date.now();
          return all.some((b) => {
            const p = (
              b.phone ||
              b.clientPhone ||
              b.client_phone ||
              ""
            ).replace(/\D+/g, "");
            const when = new Date(
              b.start || b.startTime || b.start_date || b.when || 0
            ).getTime();
            return p.endsWith(phone.replace(/\D+/g, "")) && when && when >= now;
          });
        } catch {
          return false;
        }
      }

      // --- CANCEL ---
      if (quick.label === "cancel") {
        const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
        if (!booking) {
          await reply(client, chatId, NO_FUTURE);
          return "";
        }
        const startTs = new Date(booking.startTime).getTime();
        if (startTs - Date.now() < CANCEL_POLICY_HOURS * 3600 * 1000) {
          await reply(
            client,
            chatId,
            `Mancano meno di ${CANCEL_POLICY_HOURS} ore: non posso annullare automaticamente. Contatta il salone.`
          );
          return "";
        }
        await cancelEventSafe(booking.eventId);
        updateBookingByEventId(booking.eventId, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        });
        await reply(
          client,
          chatId,
          `✅ Prenotazione del ${fmtDate(booking.startTime)} annullata.`
        );
        return "";
      }

      // --- EDIT ---
      if (quick.label === "edit") {
        const booking = getUpcomingBookingByPhone(phoneFromChatId(chatId));
        if (!booking) {
          await reply(client, chatId, NO_FUTURE);
          return "";
        }
        state.step = "edit_menu";
        state.edit = { target: booking };
        pending.set(chatId, state);
        await reply(client, chatId, showEditMenu(booking));
        return "";
      }

      // --- BOOKING (prenota/disponibilità) ---
      if (quick.label === "booking" || looksLikeBooking(text)) {
        bumpBookingLock(state);
        pending.set(chatId, state);
        return advanceAppointment(true); // riusa il tuo intake + flow
      }

      // --- PRICE ---
      if (quick.label === "price") {
        const svc =
          fuzzyServiceSafe(text) || col.service || getLastService(chatId);
        if (svc) {
          await reply(
            client,
            chatId,
            `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
              svc
            )} min)`
          );
          return "";
        }
        const svcs = cfgServices();
        col.infoOptions = svcs;
        state.step = "price_select_service";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          `Di quale trattamento vuoi conoscere il prezzo?\n${svcs
            .map((s, i) => `${i + 1}) ${s}`)
            .join("\n")}\n(1-${svcs.length})`
        );
        return "";
      }

      // --- INFO (manda a askQA con contesto se possibile) ---
      if (quick.label === "info") {
        const svcCtx =
          fuzzyServiceSafe(text) || col.service || getLastService(chatId);
        const topic = extractInfoTopic(text) || getLastInfoTopic(chatId);
        if (svcCtx) rememberService(chatId, svcCtx);
        if (topic) rememberInfoTopic(chatId, topic);
        const prompt = buildQAPromptWithMemory(
          chatId,
          composeInfoPrompt(svcCtx, topic)
        );
        let answer = (await askQA(prompt, tools, client)).trim();
        if (!answer && svcCtx)
          answer = `• ${svcCtx}: ${cfgServicePriceText(
            svcCtx
          )} (durata ${cfgServiceDuration(svcCtx)} min)`;
        await reply(client, chatId, answer || "Dimmi pure cosa vuoi sapere 😉");
        return "";
      }

      // --- GREETING / OTHER → fallback askQA ---
      if (quick.label === "greeting" || quick.label === "other") {
        const answer =
          (
            await askQA(buildQAPromptWithMemory(chatId, text), tools, client)
          ).trim() ||
          "Posso aiutarti a prenotare un trattamento o rispondere a domande sui nostri servizi. 😊";
        await reply(client, chatId, answer);
        return "";
      }
    }
    // (se siamo in step critico, mantiene il tuo flusso esistente)
if (!isInCriticalStep(state.step)) {
    const wantAvail = /\b(posto|disponibil|liber[oi])\b/i.test(t) || !!parseTimeSmart(text);
    if (wantAvail) {
      const day = parseRelativeDay(text) || (col.when ? atNoon(col.when) : nextOpenDay(new Date()));
      const svcCtx = col.service || fuzzyServiceSafe(text) || null;
      const proCtx = col.professionalEmail || col.professionalName || null;
      await reply(client, chatId, '🔎 Modalità disponibilità attiva. Per uscire scrivi **annulla**.');
      return await showDayAvailability(client, chatId, state, col, day, svcCtx, proCtx);}
}
    // ===================== Fallback generativo =====================
    if (await maybeHandleAvailability(client, chatId, state, col, text, t)) return "";
    const answer =
      (
        await askQA(buildQAPromptWithMemory(chatId, text), tools, client)
      ).trim() ||
      "Posso aiutarti a prenotare un trattamento o rispondere a domande sui nostri servizi. 😊 Fammi sapere come posso aiutarti.";
    return reply(client, chatId, answer);
  } finally {
    __busyChats.delete(chatId);
  }

}

// ============== Gestione risposte numeriche (liste) ==============
export async function handleNumericReply(client, chatId, textRaw, tools = {}) {
  // === corpo di handleNumericReply (versione patchata) ===
  const msg = (textRaw || "").trim();
  const pureNumber = /^\s*\d+\s*$/;
  const s = pending.get(chatId);
  if (!s) return safeSend(client, chatId, "Nessuna scelta in corso.");

  const state = s;
  const col = state.collected || (state.collected = {});

  // ==== AVAILABILITY FLOW: scelta giorno con numero secco ====
  if (state.availFlow && state.availFlow.awaiting === "day") {
    const dayNum = parseInt((msg || "").trim(), 10);
    if (!Number.isFinite(dayNum))
      return safeSend(client, chatId, 'Dimmi il giorno in numero (es. "21").');

    if (state.availFlow.mode === "month") {
      const { year, monthIdx } = state.availFlow;
      const max = daysInMonth(year, monthIdx);
      if (dayNum < 1 || dayNum > max)
        return safeSend(client, chatId, `Giorno non valido (1-${max}).`);
      const d = new Date(year, monthIdx, dayNum, 12, 0, 0, 0);
      state.availFlow = null;
      pending.set(chatId, state);
      const msgOut = await buildAvailabilityMessage({
        day: atNoon(d),
        service: (state.collected || {}).service || null,
        duration: null,
        professional:
          (state.collected || {}).professionalEmail ||
          (state.collected || {}).professionalName ||
          null,
      });
      return safeSend(client, chatId, msgOut);
    }

    if (state.availFlow.mode === "week") {
      const arr = state.availFlow.days || [];
      let d = null;
      if (dayNum >= 1 && dayNum <= arr.length) d = arr[dayNum - 1];
      else d = arr.find((x) => x.getDate() === dayNum) || null;
      if (!d) {
        const lines = arr
          .map(
            (D, i) =>
              `${i + 1}) ${String(D.getDate()).padStart(
                2,
                "0"
              )} ${itaWeekdayName(D)}`
          )
          .join("\n");
        return safeSend(
          client,
          chatId,
          `Scegli 1-${arr.length} o un giorno del mese presente nella lista:\n${lines}`
        );
      }
      state.availFlow = null;
      pending.set(chatId, state);
      const msgOut = await buildAvailabilityMessage({
        day: atNoon(d),
        service: (state.collected || {}).service || null,
        duration: null,
        professional:
          (state.collected || {}).professionalEmail ||
          (state.collected || {}).professionalName ||
          null,
      });
      return safeSend(client, chatId, msgOut);
    }
  }

  // ==== SCELTA SERVIZIO DA ELENCO NUMERATO ====
  if (state.step === "choose_service") {
    const n = parseInt(msg, 10);

    const candidates = [
      state.ui && Array.isArray(state.ui.lastServiceList)
        ? state.ui.lastServiceList
        : null,
      Array.isArray(col.serviceOptions) ? col.serviceOptions : null,
      state.options && Array.isArray(state.options.services)
        ? state.options.services
        : null,
      Array.isArray(config?.services) ? config.services : null,
    ].filter(Boolean);

    const opts = candidates[0] || [];
    if (!Number.isFinite(n) || n < 1 || n > opts.length) {
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${opts.length}).`
      );
    }

    const chosen = opts[n - 1];
    const svc =
      typeof chosen === "string"
        ? chosen
        : chosen?.name || chosen?.id || chosen?.title || String(chosen);

    col.service = svc;
    state.step = "collect";
    pending.set(chatId, state);

    // Avanza il flusso di prenotazione come nel resto del codice
    return handleMessage(client, chatId, `ok servizio ${svc}`, tools);
  }

  // ==== MENU DI MODIFICA (prenotazione esistente) ====
  if (state.step === "edit_menu") {
    // Accetta sia numeri che testo (es. "nome", "orario", "data", "professionista", "annulla")
    const sRaw = String(msg || "");
    const sNorm = norm(sRaw); // usa la tua normalizzazione (accenti, maiuscole, ecc.)
    let n = parseInt(sNorm, 10);

    // Mappa testo → opzione
    // 0 = annulla prenotazione
    // 1 = cambia data
    // 2 = cambia orario
    // 3 = cambia professionista
    // 4 = cambia nome
    const map = [
      [0, /\b(annull|cancell|disd)(a|o|i|e)?\w*\b/], // annulla/cancella/disdici
      [1, /\b(data|giorno|gg|sposta\s+data|cambia\s+data|nuova\s+data)\b/],
      [2, /\b(ora|orario|time|slot|fascia|fascia\s+orar)\w*\b/],
      [
        3,
        /\b(professionista|operatric(e|i)?|operatore|pro\b|tecnic[oa]|nail|master)\b/,
      ],
      [4, /\b(nome|intestaz|intestat|cliente|intestatario)\w*\b/],
    ];

    if (Number.isNaN(n)) {
      for (const [num, re] of map) {
        if (re.test(sNorm)) {
          n = num;
          break;
        }
      }
    }

    const booking = state.edit && state.edit.target;
    if (!booking)
      return reply(
        client,
        chatId,
        "Ops, non trovo la prenotazione da gestire."
      );

    // Range valido 0..4
    if (Number.isNaN(n) || n < 0 || n > 4) {
      return reply(
        client,
        chatId,
        "Scegli un numero valido (0-4) oppure scrivi: nome / orario / data / professionista / annulla."
      );
    }

    if (n === 0) {
      state.step = "edit_cancel_confirm";
      pending.set(chatId, state);
      const when = new Date(booking.startTime);
      const dd = String(when.getDate()).padStart(2, "0");
      const mm = String(when.getMonth() + 1).padStart(2, "0");
      const hh = String(when.getHours()).padStart(2, "0");
      const mi = String(when.getMinutes()).padStart(2, "0");
      const pro =
        booking.professionalName ||
        proNameByEmail(booking.professionalEmail) ||
        "—";
      const line = `${dd}/${mm} ${hh}:${mi} — ${booking.service} con ${pro}`;
      return reply(
        client,
        chatId,
        `⚠️ Confermi la cancellazione?\n• ${line}\n\nScrivi "sì" per confermare o "annulla" per tornare indietro.`
      );
    }

    if (n === 1) {
      state.step = "edit_reschedule_date";
      pending.set(chatId, state);
      const oldD = fmtDate(booking.startTime);
      const oldT = booking.startTime.slice(11, 16);
      return reply(
        client,
        chatId,
        `Hai un appuntamento fissato per **${oldD} ${oldT}**.\n📅 Per quando vuoi spostarlo? (GG/MM o “domani”)`
      );
    }

    if (n === 2) {
      // da menu: utente sceglie "orario" → vai prima alla data, poi al tempo
      state.step = "edit_reschedule_date";
      pending.set(chatId, state);
      const day = fmtDate(booking.startTime);
      return reply(
        client,
        chatId,
        `Ok, cambiamo orario. 📅 Confermi il giorno **${day}** o vuoi un’altra data? (scrivi GG/MM o “oggi/domani”)`
      );
    }

    if (n === 3) {
      const pros = cfgServiceProfessionals(booking.service)
        .map((x) => x.name)
        .filter(Boolean);
      if (!pros.length)
        return reply(
          client,
          chatId,
          "Non ho professionisti associati a questo servizio."
        );
      state.step = "edit_pick_professional";
      state.edit.proOptions = pros;
      pending.set(chatId, state);
      const list = pros.map((p, i) => `${i + 1}) ${p}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli il professionista:\n${list}\n(1-${pros.length})`
      );
    }

    if (n === 4) {
      state.step = "edit_change_name";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Scrivi il nuovo nome e cognome per la prenotazione."
      );
    }
  }

  // ==== Spostamento: scelta NUOVO ORARIO (fuori dal blocco edit_menu!) ====
  if (state.step === "edit_reschedule_time") {
    const booking = state.edit && state.edit.target;
    const options = Array.isArray(col.options) ? col.options : [];
    if (!booking) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
      );
    }

    const day = state.edit?.day
      ? new Date(state.edit.day)
      : new Date(booking.startTime);
    const duration =
      Number(booking.durationMin) || cfgServiceDuration(booking.service);

    const applyUpdate = async (hhmm, prosForSlot) => {
      const newStart = setTime(day, hhmm);

      let newProEmail = booking.professionalEmail;
      let newProName = booking.professionalName;

      if (Array.isArray(prosForSlot) && prosForSlot.length) {
        const same = prosForSlot.find(
          (p) => p.email && p.email === booking.professionalEmail
        );
        const pick = same || prosForSlot[0];
        newProEmail = pick.email || newProEmail;
        newProName = pick.name || newProName;
      }

      const ok = await updateEventSafe({
        eventId: booking.eventId,
        serviceName: booking.service,
        professionalEmail: newProEmail,
        clientPhone: booking.clientPhone,
        startTime: toISOStringLocal(newStart),
        durationMin: duration,
      });

      if (ok) {
        updateBookingByEventId(booking.eventId, {
          startTime: toISOStringLocal(newStart),
          professionalEmail: newProEmail,
          professionalName: newProName || proNameByEmail(newProEmail),
        });
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          `✅ Appuntamento spostato a ${fmtDate(newStart)} alle ${hhmm}.`
        );
      }
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a spostare l’appuntamento. Riprova tra poco."
      );
    };

    const freshSlots = normalizeSlotsDetail(
      await fetchSlots({
        service: booking.service,
        day,
        duration,
        professional: null,
        wantDetail: true,
      })
    );
    const freshTimes = freshSlots.map((s) => s.time);

    // --- Scelta da lista numerata ---
    if (pureNumber.test(msg)) {
      const n = parseInt(msg, 10);
      if (n < 1 || n > options.length) {
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${options.length}).`
        );
      }

      const item = options[n - 1];
      const hhmm = typeof item === "string" ? item : item.time;
      const pros =
        typeof item === "object" && Array.isArray(item.pros) ? item.pros : [];

      if (!freshTimes.includes(hhmm)) {
        if (!freshSlots.length)
          return reply(
            client,
            chatId,
            `Nessun orario più disponibile per ${fmtDate(day)}.`
          );
        col.options = freshSlots;
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          `Quell’orario non è più disponibile. Ecco cosa resta per ${fmtDate(
            day
          )}:\n${renderSlotsList(freshSlots)}\n(1-${freshSlots.length})`
        );
      }

      return applyUpdate(hhmm, pros);
    }

    const hhmm = parseHHMM(msg);
    if (hhmm) {
      if (!freshTimes.includes(hhmm)) {
        const near = nearestTimes(freshTimes, hhmm, 3);
        if (near.length) {
          const nearDetail = freshSlots.filter((x) => near.includes(x.time));
          col.options = nearDetail;
          pending.set(chatId, state);
          return reply(
            client,
            chatId,
            `A ${hhmm} non c’è posto. Posso proporti:\n${renderSlotsList(
              nearDetail
            )}\n(1-${nearDetail.length})`
          );
        }
        if (freshSlots.length) {
          col.options = freshSlots;
          pending.set(chatId, state);
          return reply(
            client,
            chatId,
            `A ${hhmm} non c’è posto. Disponibili per ${fmtDate(
              day
            )}:\n${renderSlotsList(freshSlots)}\n(1-${freshSlots.length})`
          );
        }
        return reply(
          client,
          chatId,
          `Nessun orario libero per ${fmtDate(day)}. Prova una data diversa.`
        );
      }

      const slot = freshSlots.find((s) => s.time === hhmm);
      return applyUpdate(hhmm, (slot && slot.pros) || []);
    }

    return reply(
      client,
      chatId,
      `Scegli un numero (1-${options.length}) o scrivi un orario **HH:MM**.`
    );
  }

  // ==== Conferma cancellazione edit ====
  if (state.step === "edit_cancel_confirm") {
    const booking = state.edit && state.edit.target;
    if (!booking) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        "Sessione scaduta. Scrivi “modifica appuntamento” per ripartire."
      );
    }
    const sMsg = norm(String(msg || ""));
    const yes =
      /\b(si|sì|ok|va bene|confermo|confermare|procedi|procedere|certo|affermativo)\b/i.test(
        sMsg
      );
    const no = /\b(no|annulla|indietro|stop)\b/i.test(sMsg);
    if (yes) {
      let gcalOk = false;
      try {
        gcalOk = await cancelEventSafe(booking.eventId);
      } catch {}
      const patched = {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      };
      let updated = false;
      if (booking.eventId) {
        updateBookingByEventId(booking.eventId, patched);
        updated = true;
      } else {
        updated = updateBookingByComposite(
          { clientPhone: booking.clientPhone, startTime: booking.startTime },
          patched
        );
      }
      pending.delete(chatId);
      if (gcalOk && updated)
        return reply(client, chatId, "✅ Prenotazione cancellata.");
      if (gcalOk && !updated)
        return reply(
          client,
          chatId,
          "⚠️ Cancellata su calendario; non ho trovato la riga nel file interno."
        );
      if (!gcalOk && updated)
        return reply(
          client,
          chatId,
          "✅ Prenotazione cancellata (solo interno)."
        );
      return reply(
        client,
        chatId,
        "❌ Non sono riuscito a cancellare. Riprova."
      );
    }
    if (no) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, showEditMenu(booking));
    }
    return reply(
      client,
      chatId,
      'Scrivi "sì" per confermare la cancellazione oppure "annulla" per tornare indietro.'
    );
  }

  // ==== Selezioni info/prezzi ====
  if (state.step === "info_select_service") {
    const n = parseInt(msg, 10);
    const list = col.infoOptions || [];
    const svc = list[n - 1];
    if (!svc)
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    state.step = "collect";
    col.infoOptions = null;
    rememberService(chatId, svc);
    pending.set(chatId, state);
    const topic = getLastInfoTopic(chatId);
    const base = composeInfoPrompt(svc, topic);
    let a = (
      await askQA(buildQAPromptWithMemory(chatId, base), tools, client)
    ).trim();
    if (!a)
      a = `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
        svc
      )} min)`;
    return safeSend(client, chatId, a);
  }

  if (state.step === "price_select_service") {
    const n = parseInt(msg, 10);
    const list = col.infoOptions || [];
    const svc = list[n - 1];
    if (!svc)
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    state.step = "collect";
    col.infoOptions = null;
    rememberService(chatId, svc);
    pending.set(chatId, state);
    return safeSend(
      client,
      chatId,
      `• ${svc}: ${cfgServicePriceText(svc)} (durata ${cfgServiceDuration(
        svc
      )} min)`
    );
  }

  // ==== Scelta professionista (generico o da pick_time multipro) ====
  if (state.step === "pick_professional") {
    const names = col.proOptions || [];
    const n = parseInt(msg, 10);
    if (isNaN(n) || !names[n - 1])
      return safeSend(
        client,
        chatId,
        `Scegli un numero valido (1-${names.length}).`
      );
    col.professionalName = names[n - 1];
    col.professionalEmail = proEmailByName(col.professionalName);
    col.proOptions = null;
    state.step = "collect";
    pending.set(chatId, state);
    return handleMessage(
      client,
      chatId,
      `ok pro ${col.professionalName}`,
      tools
    );
  }

  // ==== Orari (prenotazione standard) ====
  if (state.step !== "pick_time")
    return handleMessage(client, chatId, msg, tools);

  const n = parseInt(msg, 10);
  if (isNaN(n))
    return safeSend(
      client,
      chatId,
      `Scrivi un numero valido (0-${col.options ? col.options.length : 0}).`
    );

  if (n === 0) {
    const duration = cfgServiceDuration(col.service);
    const allSlots = await fetchSlots({
      service: col.service,
      day: atNoon(col.when),
      duration,
      professional: null,
      wantDetail: true,
    });
    if (!allSlots.length)
      return safeSend(
        client,
        chatId,
        "Nessuno slot disponibile in quel giorno."
      );
    col.options = allSlots;
    col.allSlotsMode = true;
    pending.set(chatId, state);
    const linesAll = allSlots
      .map(
        (it, i) =>
          `${i + 1}) ${it.time} (${(it.pros || [])
            .map((p) => p.name)
            .join(", ")})`
      )
      .join("\n");
    return safeSend(
      client,
      chatId,
      `Tutti gli slot disponibili (${fmtDate(col.when)}):\n${linesAll}\n(1-${
        allSlots.length
      })`
    );
  }

  const item = col.options && col.options[n - 1];
  if (!item)
    return safeSend(
      client,
      chatId,
      `Scrivi un numero valido (0-${col.options ? col.options.length : 0}).`
    );

  col.time = item.time || item;

  if (
    !col.professionalEmail &&
    !col.professionalName &&
    item.pros &&
    item.pros.length > 1
  ) {
    col.proOptions = item.pros.map((p) => p.name);
    state.step = "pick_professional";
    pending.set(chatId, state);
    const list = item.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
    return reply(
      client,
      chatId,
      `Chi preferisci alle ${col.time}?\n${list}\n(1-${item.pros.length})`
    );
  }

  if (
    !col.professionalEmail &&
    !col.professionalName &&
    item.pros &&
    item.pros.length === 1
  ) {
    col.professionalEmail = item.pros[0].email;
    col.professionalName = item.pros[0].name;
  }

  state.step = "collect";
  pending.set(chatId, state);
  return handleMessage(client, chatId, `ok ${col.time}`, tools);
}

// ============== Parsing e altre funzioni ==============
function parseIntake(text) {
  // Funzione P-U-R-A: estrae possibili {service, when, time} dal testo
  // Non legge né scrive 'state' o 'col'
  const out = {};
  const t = norm(text);

  // --- servizio
  let svc = resolveServiceFromText(text);
  if (!svc) {
    const hit = fuzzyService(text);
    const first = (typeof cfgServices === "function" && (cfgServices()[0] || null)) || null;
    const hasSvcToken = (() => {
      try {
        const tokens = (cfgServices() || [])
          .flatMap((s) => s.toLowerCase().split(/\W+/))
          .filter((x) => x && x.length >= 4);
        const nq = norm(text);
        return tokens.some((tok) => nq.includes(norm(tok)));
      } catch { return false; }
    })();
    if (hit && !(first && norm(hit) === norm(first) && !hasSvcToken)) svc = hit;
  }
  if (svc) out.service = svc;

  // --- giorno/data
  const relDay = parseRelativeDay(text);
  if (relDay) out.when = relDay;

  // --- orario
  let time = parseTimeSmart(text);
  if (!time) time = parseNaturalTime(text);
  if (time) out.time = time;

  return out;
}



function parseDaypartWindow(text) {
  const t = norm(text);
  const dp = getDaypartBoundaries();
  if (/\bmattin/.test(t)) return dp.mattina;
  if (/\bpomeriggio\b/.test(t)) return dp.pomeriggio;
  if (/\bsera\b/.test(t)) return dp.sera;
  return null;
}

// === Giorno chiuso? (settimana + date specifiche)
function cfgClosedDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dayKey = isoWeekday(d); // '1'..'7'

  // chiusure settimanali
  const closed = config.closedDays ?? config.daysOff ?? {};
  if (Array.isArray(closed)) {
    if (closed.map(String).includes(dayKey)) return true;
  } else if (closed && typeof closed === "object") {
    // se esiste la chiave ed è truthy (o non esplicitamente false) consideriamo chiuso
    if (
      Object.prototype.hasOwnProperty.call(closed, dayKey) &&
      closed[dayKey] !== false
    )
      return true;
  }

  // date specifiche (ferie/festivi)
  const toYMD = (dd) =>
    `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(
      dd.getDate()
    ).padStart(2, "0")}`;
  const ymd = toYMD(d);
  const closedDates = Array.isArray(config.holidays)
    ? config.holidays
    : Array.isArray(config.closedDates)
    ? config.closedDates
    : [];
  if (closedDates.includes(ymd)) return true;

  return false;
}

// === Orari vicini a un target (es. se 10:30 non c'è, proponi 10:00/11:00…)
function nearestTimes(slots, target, count = 3) {
  const tm = timeToMinutes(target);
  return (slots || [])
    .map((s) => ({ s, d: Math.abs(timeToMinutes(s) - tm) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((x) => x.s);
}


// === Prompt “scegli servizio” (lista da config)
function askService(stateIn, chatId) {
  const svcs = cfgServices();
  if (!svcs.length) return "Quale trattamento desideri prenotare?";

  // robusto anche se non passo lo state
  const st = stateIn || getState(chatId);
  st.ui = st.ui || {};
  st.ui.lastServiceList = svcs; // la stessa array mostrata all’utente
  pending.set(chatId, st);

  return `💆‍♀️ Quale trattamento desideri prenotare?\n${svcs
    .map((s, i) => `${i + 1}) ${s}`)
    .join("\n")}\n(1-${svcs.length})`;
}


// === Filtra times con vincoli after/before tipo "dopo 15:00" / "prima 18:00"
function filterTimesByAfterBefore(times, { after = null, before = null } = {}) {
  let out = Array.isArray(times) ? times.slice() : [];
  if (after) {
    const a = timeToMinutes(after);
    out = out.filter((t) => timeToMinutes(t) >= a);
  }
  if (before) {
    const b = timeToMinutes(before);
    out = out.filter((t) => timeToMinutes(t) <= b);
  }
  return out.sort(compareHHMM);
}

// === Se il giorno è oggi, elimina gli orari già passati
function filterOutPastTimesForToday(day, times) {
  const D = day instanceof Date ? day : new Date(day);
  const now = new Date();
  const isSameDate =
    D.getFullYear() === now.getFullYear() &&
    D.getMonth() === now.getMonth() &&
    D.getDate() === now.getDate();
  if (!isSameDate) return times;

  const curMin = now.getHours() * 60 + now.getMinutes();
  return (times || [])
    .filter((t) => timeToMinutes(t) >= curMin)
    .sort(compareHHMM);
}

// === Messaggio di disponibilità (giorno singolo) con raggruppamento per fasce e lista pro nello slot
async function buildAvailabilityMessage({
  day,
  service = null, // nome servizio (opzionale)
  duration = null, // in minuti (se assente, prende da config servizio o 30)
  professional = null, // email o nome pro (opzionale)
  window = null, // es. ['09:00','12:30']
  after = null, // 'HH:MM'
  before = null, // 'HH:MM'
} = {}) {
  const D = atNoon(day);
  if (cfgClosedDay(D)) {
    const next = nextOpenDay(D);
    return `Il giorno ${fmtDate(D)} siamo chiusi. Ti va bene ${fmtDate(next)}?`;
  }

  // Risoluzione pro
  const proEmail = professional
    ? professional.includes("@")
      ? professional
      : proEmailByName(professional) || null
    : null;

  // Durata
  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    durMin = service ? cfgServiceDuration(service) : 30;
  }

  // Prendi slots dettagliati (time + pros)
  const detail = await fetchSlots({
    service,
    day: D,
    duration: durMin,
    professional: proEmail || professional || null,
    wantDetail: true,
  });
  const list = Array.isArray(detail) ? detail : [];
  let times = list.map((x) => x.time);

  // Finestra “mattina/pomeriggio/sera”
  if (window && Array.isArray(window) && window.length === 2) {
    times = filterSlotsByWindow(times, window);
  }

  // Vincoli after/before
  times = filterTimesByAfterBefore(times, { after, before });

  // Se oggi, elimina orari passati
  times = filterOutPastTimesForToday(D, times);

  if (!times.length) {
    const fascia = window ? " nella fascia richiesta" : "";
    return `Per ${fmtDate(D)} non vedo orari liberi${
      service ? ` per ${service}` : ""
    }${fascia}.`;
  }

  // Mappa time -> dettaglio (per label dei pro)
  const byTime = new Map(list.map((x) => [x.time, x]));

  // Raggruppamento in blocchi
  const grouped = groupSlotsByDaypart(times);
  const renderGroup = (title, arr) => {
    if (!arr || !arr.length) return null;
    const lines = arr
      .map((h) => {
        const item = byTime.get(h) || { pros: [] };
        const lbl = labelProsForSlot(item); // usa la tua versione già presente
        return `• ${h}${lbl ? ` (${lbl})` : ""}`;
      })
      .join("\n");
    return `${title}\n${lines}`;
  };

  const headSvc = service ? ` • ${service}` : "";
  const headPro = proEmail ? ` • ${proNameByEmail(proEmail) || proEmail}` : "";
  const blocks = [
    renderGroup("🌅 Mattina", grouped.mattina),
    renderGroup("🌤️ Pomeriggio", grouped.pomeriggio),
    renderGroup("🌙 Sera", grouped.sera),
  ]
    .filter(Boolean)
    .join("\n");

  return `📅 Disponibilità ${fmtDate(D)}${headSvc}${headPro}\n${blocks}`;
}

// ==== Stato conversazione (export compat) ====
export function getState(chatId) {
  if (!pending.has(chatId)) {
    pending.set(chatId, {
      step: "collect",
      collected: {
        service: null,
        when: null,
        time: null,
        professionalAny: false, // <— NEW
        professionalName: null,
        professionalEmail: null,
        customerName: null,
        allergies: null,
        options: [],
        proOptions: null,
        daypartWindow: null,
        infoOptions: null,
      },
      context: { lastService: null, lastInfoTopic: null, lock: null },
    });
  }
  return pending.get(chatId);
}


export function resetState(chatId) {
  pending.delete(chatId);
}
function setState(chatId, st) {
  if (!st || typeof st !== "object") return;
  pending.set(chatId, st);
}
// === MENU EDIT HELPERS ===
function showEditMenu(booking) {
  const when = new Date(booking.startTime);
  const dd = String(when.getDate()).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const hh = String(when.getHours()).padStart(2, "0");
  const mi = String(when.getMinutes()).padStart(2, "0");
  const pro =
    booking.professionalName ||
    proNameByEmail(booking.professionalEmail) ||
    "—";
  const line = `${dd}/${mm} ${hh}:${mi} — ${booking.service} con ${pro}`;
  return `Vuoi gestire questa prenotazione?
• ${line}

0) Cancella
1) Modifica data
2) Modifica orario
3) Modifica professionista
4) Modifica nome
(0-4)`;
}

// === PATCH: add missing export handleAllergyReply ===
export async function handleAllergyReply(client, chatId, textRaw, tools = {}) {
  const msg = (textRaw || "").trim();
  const state = pending.get(chatId);
  if (!state) return handleMessage(client, chatId, msg, tools);
  const col = state.collected || (state.collected = {});
  if (state.step === "ask_allergies") {
    const info = parseAllergyInfo(msg, col.service);
    if (info) {
      col.allergies = {
        has: !!info.has,
        list: Array.isArray(info.list) ? info.list : [],
      };
      state.step = "collect";
      pending.set(chatId, state);
      if (col.allergies.has) {
        await reply(
          client,
          chatId,
          "✅ Ho segnato le allergie indicate. Ti consigliamo di contattare il negozio per i dettagli sul trattamento."
        );
      }
      return handleMessage(client, chatId, "ok allergie", tools);
    }
    return reply(
      client,
      chatId,
      askAllergies(col.service) || "Sei allergico a qualcosa? (sì/no)"
    );
  }
  return handleMessage(client, chatId, msg, tools);
}

// ===== [PATCH helpers intent & sanitize] =====
function _norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function _wb(re) {
  return new RegExp(`(?:^|\\b)${re}(?:\\b|$)`, "i");
}
// Typo-tolerance: Damerau–Levenshtein distance (micro)
function dlDist(a = "", b = "") {
  a = String(a);
  b = String(b);
  const n = a.length,
    m = b.length;
  if (!n) return m;
  if (!m) return n;
  const INF = n + m;
  const da = new Map();
  const d = Array(n + 2);
  for (let i = 0; i < n + 2; i++) d[i] = Array(m + 2).fill(0);
  d[0][0] = INF;
  for (let i = 0; i <= n; i++) {
    d[i + 1][1] = i;
    d[i + 1][0] = INF;
  }
  for (let j = 0; j <= m; j++) {
    d[1][j + 1] = j;
    d[0][j + 1] = INF;
  }
  for (let i = 1; i <= n; i++) {
    let db = 0;
    for (let j = 1; j <= m; j++) {
      const i1 = da.get(b[j - 1]) || 0;
      const j1 = db;
      const cost = a[i - 1] === b[j - 1] ? ((db = j), 0) : 1;
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost, // sost
        d[i + 1][j] + 1, // ins
        d[i][j + 1] + 1, // canc
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1) // trasposizione
      );
    }
    da.set(a[i - 1], i);
  }
  return d[n + 1][m + 1];
}
function typoSim(a = "", b = "") {
  const L = Math.max(a.length, b.length) || 1;
  return 1 - dlDist(a, b) / L; // 0..1
}

function parseExplicitMention(text = "") {
  const s = text.toLowerCase();
  const m = s.match(
    /(?:info|informazioni|dettagli|spiegami|dimmi).{0,20}\b(?:su|sul|sulla|sui|sulle)\s+([^\?\!\.\n]+)/i
  );
  return m ? m[1].trim() : null;
}
function _servicesForIntent() {
  return cfgServices().map((n) => ({
    name: n,
    synonyms: cfgServiceSynonyms(n),
  }));
}

function scoreService(text, svc) {
  const t = _norm(text);
  const name = _norm(svc.name || "");
  const syns = (svc.synonyms || []).map(_norm);

  let score = 0;

  // 1) match “forte” a parola intera
  if (_wb(name).test(t)) score = Math.max(score, 0.92);
  for (const sy of syns) if (_wb(sy).test(t)) score = Math.max(score, 0.92);

  // 2) overlap token parziale (già presente)
  const tokens = new Set(t.split(" "));
  for (const sy of [name, ...syns]) {
    const parts = sy.split(" ").filter(Boolean);
    if (!parts.length) continue;
    const hit = parts.filter((p) => tokens.has(p)).length / parts.length;
    score = Math.max(score, hit * 0.72);
  }

  // 3) typo-tolerance (Damerau-Levenshtein) su token singoli
  //    Applica solo quando non abbiamo già match forte.
  if (score < 0.85) {
    const cand = [name, ...syns].filter(Boolean);
    const inputTokens = t.split(" ").filter(Boolean);

    let bestTypo = 0;
    for (const itok of inputTokens) {
      // ignora token troppo corti/comuni
      if (itok.length < 3) continue;
      for (const label of cand) {
        const parts = label.split(" ").filter(Boolean);
        for (const p of parts) {
          if (p.length < 3) continue;
          const sim = typoSim(itok, p); // 0..1
          // soglia morbida: >=0.72 è un buon “quasi match” (1-2 errori)
          if (sim >= 0.72) bestTypo = Math.max(bestTypo, sim);
        }
      }
    }
    // pesa moderatamente: non superare match esatti
    if (bestTypo > 0) score = Math.max(score, Math.min(0.82, bestTypo * 0.82));
  }

  return score;
}

const REFILL_PAT =
  /\b(re[\s-]?fill|refil{1,2}|ritocco|ribilanciamento|manutenzione)\b.*\b(gel|ricostruzione)?\b/i;

/** Risolve il servizio dal testo con priorità alle menzioni esplicite. */
export function resolveServiceIntent(text, state = {}, services = []) {
  const explicit = parseExplicitMention(text);
  if (REFILL_PAT.test(text)) return "Refill Gel";

  if (explicit) {
    const e = _norm(explicit);
    let best = { name: null, score: 0 };
    for (const s of services) {
      const sc = scoreService(e, s);
      if (sc > best.score) best = { name: s.name, score: sc };
    }
    if (best.score >= 0.6) return best.name;
  }

  const t = _norm(text);
  let best = { name: null, score: 0 };
  for (const s of services) {
    const sc = scoreService(t, s);
    if (sc > best.score) best = { name: s.name, score: sc };
  }
  if (best.score >= 0.6) return best.name;

  return state.lastService || null;
}
