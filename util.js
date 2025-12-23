// util.js — Gestione prenotazioni WhatsApp (ITA) — versione patchata
import os from "node:os";
import * as fsSync from "fs";
import path from "path";

import {
  getFreeSlotsForDay as _getFreeSlotsForDay,
  createCalendarEvent as _createCalendarEvent,
} from "./gcal.js";
import * as GCAL from "./gcal.js";
let inactivityClient = null;
// --- mini lock per chat ---
const __busyChats = new Set();
const __busySince = new Map();
const BUSY_TTL_MS = Number(process.env.BUSY_TTL_MS || 45000);

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
  const line = `[${ts}] [${lvl.toUpperCase()}] ${msg}${payload ? " " + safeJSON(payload) : ""
    }`;
  (lvl === "error"
    ? console.error
    : lvl === "warn"
      ? console.warn
      : console.log)(line);
}
// === NEW: re-entry scheduler to avoid lock recursion ===
function scheduleReenter(client, chatId, text, tools = {}) {
  try {
    setTimeout(() => {
      Promise.resolve(handleMessage(client, chatId, text, tools)).catch(
        (err) => {
          try {
            log("error", "[REENTER] handleMessage failed", {
              chatId,
              error: String(err && err.stack ? err.stack : err),
            });
          } catch { }
        }
      );
    }, 0);
  } catch (e) {
    log("warn", "[REENTER] schedule failed", { chatId, error: String(e) });
  }
}

// === NEW === i18n minimale (IT/EN)
const MESSAGES = {
  it: {
    CHOOSE_SLOT_FOR_DAY: (day, lines, n) =>
      `📅 Disponibilità per ${day}:\n${lines}\n\nScrivi l'orario desiderato (es. "14:30").`,
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


function formatDateWithWeekdayIT(d) {
  try {
    if (d === null || typeof d === "undefined" || d === "") return "";
    const dt = d instanceof Date ? d : new Date(d);
    if (!dt || Number.isNaN(dt.getTime())) return "";
    const wd = typeof itaWeekdayName === "function" ? itaWeekdayName(dt) : "";
    const ds = typeof fmtDate === "function" ? fmtDate(dt) : dt.toLocaleDateString("it-IT");
    return wd ? `${wd} ${ds}` : ds;
  } catch (e) {
    return "";
  }
}



function validateDateInRange(d, maxDays = 30) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    const now = new Date();
    const diff = Math.ceil((dt - atNoon(now)) / (24 * 60 * 60 * 1000));
    return diff >= 0 && diff <= maxDays;
  } catch (e) {
    return false;
  }
}


// Helper robusto per scelte numeriche "1", "1)", "1.", ecc.
// allowZero=true permette "0" (nessuna preferenza).
function parseListIndex(raw, max, allowZero = false) {
  const s = String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u00a0]/g, "")
    .trim();

  const m = s.match(/^(\d+)\s*[\)\.\-]?$/);
  if (!m) return NaN;

  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return NaN;

  if (max == null) return n;

  if (allowZero) {
    return n >= 0 && n <= max ? n : NaN;
  }

  return n >= 1 && n <= max ? n : NaN;
}

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
// === DATE HELPERS ROBUSTI (dd/mm, dd-mm, ISO, timestamp) ===
const isValidDate = (d) => d instanceof Date && !isNaN(d);

const toISODate = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (!isValidDate(x)) return null;
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Guard contro parsing ricorsivo (evita loop infiniti)
const __dateParsingLocks = new Set();


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
  const json = JSON.stringify(arr, null, 2);

  const sleepSync = (ms) => {
    const t = Math.max(0, Number(ms) || 0);
    if (!t) return;
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, t);
  };

  const MAX_TRIES = 4;
  const BASE_DELAY = 40;

  for (let i = 0; i < MAX_TRIES; i++) {
    const tmpPath = `${BOOKINGS_PATH}.tmp.${process.pid}.${Date.now()}.${i}`;

    try {
      fsSync.writeFileSync(tmpPath, json, "utf8");
    } catch (e) {
      sleepSync(BASE_DELAY * (i + 1));
      continue;
    }

    try {
      fsSync.renameSync(tmpPath, BOOKINGS_PATH);
      return true;
    } catch (e) {
      // Windows (EPERM) / file lock: fallback a write diretto
      try {
        fsSync.writeFileSync(BOOKINGS_PATH, json, "utf8");
        try { fsSync.unlinkSync(tmpPath); } catch {}
        return true;
      } catch (e2) {
        try { fsSync.unlinkSync(tmpPath); } catch {}
        sleepSync(BASE_DELAY * (i + 1));
        continue;
      }
    }
  }

  console.error("[bookings] save error: exhausted retries");
  return false;
}

function persistBooking(rec) {
  const arr = loadBookings();
  arr.push(rec);
  return !!saveBookings(arr);
}

function updateBookingByEventId(eventId, patch) {
  try {
    if (!eventId) return false;
    const arr = loadBookings();
    let changed = false;
    for (const b of arr) {
      if (b && b.eventId === eventId) {
        Object.assign(b, patch);
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    return !!saveBookings(arr);
  } catch {
    return false;
  }
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
    if (!changed) return false;
    return !!saveBookings(arr);
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

function getUserActiveBookingsAll(phoneOrChatId) {
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

    const digits = (s) => String(s || "").replace(/\D/g, "");
    const norm = (s) => digits(s); // supporta anche "...@c.us"

    const a = norm(phoneOrChatId);
    const tail = (s, n = 7) => String(s || "").slice(-n);

    const matchesPhone = (x) => {
      const b = norm(x);
      if (!a || !b) return false;
      if (a === b) return true;
      const ta = tail(a);
      const tb = tail(b);
      return ta && tb && (a.endsWith(tb) || b.endsWith(ta) || ta === tb);
    };

    const out = rows
      .filter((b) => {
        const ts = Date.parse(b.startTime || b.start || "");
        if (!Number.isFinite(ts) || ts < now) return false;

        const st = String(b.status || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(st)) return false;

        const candidates = [
          b.clientPhone,
          b.customerPhone,
          b.phone,
          b.whatsapp,
          b.clientChatId,
          b.chatId,
        ];

        return candidates.some((c) => matchesPhone(c));
      })
      .sort((x, y) => Date.parse(x.startTime || x.start) - Date.parse(y.startTime || y.start));

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
  const link ="https://shorturl.at/es4kd";
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
      const toId = normalizeRecipientId(b);
      if (!toId) continue;

      try {
        await sendFn(toId, buildReviewMessage(b));
        updateBookingByEventId(b.eventId, {
          reviewAsked: true,
          reviewAskedAt: new Date().toISOString(),
        });
        sent++;
      } catch (e) {
        console.warn("[reviewFollowupsTick] invio fallito:", e?.message || e);
      }
    }  }
  return sent;
}

export function buildConfirmMessage(b) {
  const name = b?.customerName ? ` ${b.customerName}` : "";
  const svc = b?.service || "il trattamento";
  const pro = b?.professionalName ? ` con ${b.professionalName}` : "";
  const dt = b?.startTime ? new Date(b.startTime) : null;
  const dd = dt
    ? `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}`
    : "";
  const tt = dt
    ? `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
    : "";
  // PATCH: sostituito messaggio di modifica con nota esplicativa
  return `Ciao${name}! Promemoria: ${svc}${pro} il ${dd} alle ${tt}. Non vediamo l'ora di vederti ❤!\n\nNota: per modificare la prenotazione devi rifarla da capo.`;
}

/*
 * Semplice tick di conferma: manda un promemoria qualche ora prima.
 * Evita crash se il file non è un array.
 */
/**
 * The function `confirmAppointmentsTick` asynchronously confirms appointments within a specified time
 * range by sending confirmation messages to clients.
 * @param sendFn - `sendFn` is a function that will be used to send confirmation messages to clients.
 * It should accept two parameters: the client's phone number and the confirmation message to be sent.
 * @param [opts] - The `opts` parameter in the `confirmAppointmentsTick` function is an object that can
 * contain two optional properties:
 * @returns The function `confirmAppointmentsTick` returns the number of appointments that were
 * successfully confirmed and for which a confirmation message was sent.
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

// ============ PROFESSIONALI: catalogo, prompt, parsing ============

// Normalizza stringhe brevi (riusa la tua simpleNorm/norm)
const _n = (s) => simpleNorm(String(s || "")).trim();
const _tok = (s) => _n(s).split(/\s+/).filter(Boolean);

// Stopword comuni: non aiutano a identificare un nome
const __PRO_STOP = new Set([
  "la","il","lo","i","gli","le","un","uno","una","con","da","dal","dalla","dallo","dall","dall'","dei","degli","delle",
  "di","de","del","dello","della","a","ad","al","allo","alla","ai","agli","alle","per","su","in","nel","nello","nella",
  "nei","negli","nelle","e","ed","o"
]);

function _proNameTokens(name) {
  return _tok(name)
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 3 && !__PRO_STOP.has(t) && (/^[\p{L}]+$/u).test(t));
}

/**
 * Match professionista dentro una frase (es. "con la Diana hai tempo mercoledì?")
 * - accetta anche solo nome (token) se univoco tra i pro
 */
function matchProFromFreeText(raw, list) {
  const s = _n(raw);
  if (!s) return null;

  const words = _tok(s).filter((t) => t && t.length >= 3 && !__PRO_STOP.has(t) && (/^[\p{L}]+$/u).test(t));
  if (!words.length) return null;

  const padded = " " + s + " ";

  // 1) match pieno (nome completo) con boundary
  for (const p of list || []) {
    const full = _n(p?.name);
    if (full && padded.includes(" " + full + " ")) return p;
  }

  // 2) indicizza token->pro per unicità
  const tokenToPros = new Map();
  for (const p of list || []) {
    const toks = _proNameTokens(p?.name);
    for (const tok of toks) {
      const arr = tokenToPros.get(tok) || [];
      arr.push(p);
      tokenToPros.set(tok, arr);
    }
  }

  // 3) token univoco in frase -> pro certo
  for (const w of words) {
    const arr = tokenToPros.get(w);
    if (arr && arr.length === 1) return arr[0];
  }

  // 4) fallback: più token in comune
  let best = null, bestScore = 0;
  const setW = new Set(words);
  for (const p of list || []) {
    const toks = _proNameTokens(p?.name);
    if (!toks.length) continue;
    let hit = 0;
    for (const tok of toks) if (setW.has(tok)) hit++;
    const score = hit / toks.length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best && bestScore >= 0.5) return best;

  return null;
}


// Ritorna l'elenco dei pro validi per il servizio (se configurati), altrimenti tutti
function proCatalog(service) {
  const all = Object.entries(config.professionals || {}).map(([email, p]) => ({
    email,
    name: p.name,
  }));
  const allowed = config.services?.[service]?.professionals || [];
  return allowed.length ? all.filter((p) => allowed.includes(p.email)) : all;
}

// Prompt numerato (0 = nessuna preferenza)
function renderProPrompt(list) {
  if (!list.length) {
    return '⚠️ Non ho professionisti configurati per questo servizio: non posso completare la prenotazione. Scrivi "annulla".';
  }
  const lines = list.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
  return `Preferisci un professionista in particolare?\n0) Non mi interessa\n${lines}\n(0-${list.length})`;
}

// Parsing risposta utente -> { any:true } oppure {email,name} oppure null se invalida
function resolveProReply(reply, list) {
  const txt = (reply || "").trim();
  const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "3" "3)" "3."

  // no-preference textual answers
  if (/\b(no|non\s+mi\s+interessa|chiunque|qualsiasi|indifferente|nessuno|no\s+grazie)\b/i.test(txt)) {
    return { any: true, noPreference: true };
  }

  // input numerico
  if (pureNumber.test(txt)) {
    const n = parseInt(txt, 10);
    if (n === 0) return { any: true };
    if (n >= 1 && n <= list.length) return list[n - 1];
    return null;
  }

  // input testuale: match anche dentro frasi (es. "con la Diana ...")
  const hit = typeof matchProFromFreeText === "function" ? matchProFromFreeText(txt, list) : null;
  if (hit) return hit;

  // fallback: match "contain"
  const q = _n(txt);
  for (const p of list || []) {
    const y = _n(p?.name);
    if (y && (y.includes(q) || q.includes(y))) return p;
  }

  return null;
}


// Mostra la domanda (mai testo libero)
function askProfessional(service) {
  const list = proCatalog(service);
  return renderProPrompt(list);
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
  if (db[chatId].msgs.length > 5) {
    db[chatId].msgs = db[chatId].msgs.slice(-5);
  }
  // Aggiorna il timestamp di ultima attività dell'utente
  db[chatId].lastActive = Date.now();
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
function rememberService(_) { }
function rememberInfoTopic(_) { }

// ============== Safe send & reply (+ booking footer) ==============
// Dedup messaggi identici consecutivi (riduce spam quando due reply uguali finiscono uno dopo l'altro)
const __SEND_DEDUP = new Map(); // chatId -> { text, at }
function __dedupAllow(chatId, text, windowMs = 2000) {
  const now = Date.now();
  const key = String(chatId || "");
  const last = __SEND_DEDUP.get(key);
  if (last && last.text === text && now - last.at < windowMs) return false;
  return true;
}
function __dedupRemember(chatId, text) {
  const key = String(chatId || "");
  __SEND_DEDUP.set(key, { text, at: Date.now() });
}

// Footer cooldown (per non mandare 2 footer identici a raffica)
const __FOOTER_COOLDOWN = new Map(); // chatId -> lastAt
export async function safeSend(client, chatId, text, opts = {}) {
  const t = String(text ?? "");
  if (!t.trim()) return "";

  if (!chatId) {
    log("warn", "safeSend called without chatId", { preview: t.slice(0, 120) });
    return "";
  }

  // Dedup: se inviamo lo stesso testo a distanza ravvicinata, salta
  const __win = Math.max(0, Number(opts?.dedupWindowMs) || 2000);
  if (!__dedupAllow(chatId, t, __win)) return "";

  // ✅ PATCH: Verifica che il client sia pronto
  if (!client || typeof client.sendText !== "function") {
    log("warn", "safeSend: client.sendText not available", { chatId });
    return "";
  }

  // ✅ PATCH: Aggiungi retry con delay
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.sendText(chatId, t);
      __dedupRemember(chatId, t);
      log("info", `[SEND OK] attempt ${attempt}`, { chatId, preview: t.slice(0, 50) });
      break; // Successo, esci dal loop
    } catch (e) {
      log("warn", `[SEND FAIL] attempt ${attempt}/${MAX_RETRIES}`, {
        chatId,
        err: e?.message || String(e)
      });

      if (attempt === MAX_RETRIES) {
        log("error", "safeSend: tutti i tentativi falliti", { chatId });
        return "";
      }

      // Attendi prima di riprovare
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }

  // Footer automatico (solo dopo invio riuscito)
  try {
    if (typeof postReplyHook === "function") {
      await postReplyHook(client, chatId, t, opts);
    }
  } catch (e) {
    log("warn", "safeSend: postReplyHook threw", { chatId, err: e?.stack || e?.message || e });
  }

  return t;
}


// wrapper usato ovunque nel flow
async function reply(client, chatId, text, opts = {}) {
  return safeSend(client, chatId, text, opts);
}
// === Footer automatico per il flow booking ===
async function postReplyHook(client, chatId, sentText, opts = {}) {
  try {
    if (!chatId) return;
    if (opts?.noFooter) return;
    if (!pending || typeof pending.get !== "function") return;

    const st = pending.get(chatId);
    if (!st) return;
    const col = st.collected || {};
    const active = (typeof isBookingFlowActive === "function" && isBookingFlowActive(st, col)) ||
      (typeof isBookingLocked === "function" && isBookingLocked(st));
    if (!active) return;

    // evita loop: se il messaggio appena inviato È già il footer, non reinviare
    const FOOTER = 'ℹ️Se vuoi *ricominciare* da capo, digita “ _annulla_ ”.\nℹ️ Se vuoi *modificare* un appuntamento, digita “ _modifica_ ”!';
    if (String(sentText || "").includes('digita "annulla"') || String(sentText || "").includes('ricominciare')) return;

    // Cooldown footer: evita spam (es. due messaggi identici di fila)
    const __lastFooterAt = __FOOTER_COOLDOWN.get(chatId) || 0;
    if (Date.now() - __lastFooterAt < 15000) return;

    // ATTENZIONE: non chiamare safeSend qui (potenziale ricorsione footer->postReplyHook->safeSend->postReplyHook).
    // Invia il footer direttamente con client.sendText e gestisci gli errori.
    if (!client || typeof client.sendText !== "function") {
      log("warn", "postReplyHook: client.sendText not available", { chatId });
      return;
    }
    try {
      await client.sendText(chatId, FOOTER);
      __FOOTER_COOLDOWN.set(chatId, Date.now());
      __dedupRemember(chatId, FOOTER);
    } catch (e) {
      log("warn", "postReplyHook: client.sendText failed", { chatId, err: e?.stack || e?.message || e });
    }
  } catch (e) {
    log("warn", "postReplyHook", e?.stack || e?.message || e);
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
  const names = ["domenica", "lunedì", "martedì", "mercoledì",
    "giovedì", "venerdì", "sabato"];
  return names[d.getDay()] || "";
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

// Vuole aprire il menu "modifica appuntamento"?
function wantsEditMenu(text) {
  const s = norm(text || "").trim();

  // Comando secco sempre valido
  if (/^\/?modifica\b/i.test(s)) return true;

  // Verbi "forti" (chiaro intento di modificare/spostare/annullare)
  const strongActionRe =
    /\b(?:modific\w*|gestisc\w*|gestir\w*|cambi\w*|spost\w*|rinvi\w*|rimand\w*|posticip\w*|riprogramm\w*|slitt\w*|anticip\w*|annull\w*|cancell\w*|disdic\w*)\b/i;

  // Verbi ambigui richiesti (inoltrare/tramandare): SOLO se scritti da soli
  const weakSoloCmdRe =
    /^\/?(?:inoltra|inoltrare|tramanda|tramandare)\s*$/i;

  // Comandi secchi (anche senza contesto)
  const soloCmdStrongRe =
    /^\/?(?:edit|gestisci|gestire|cambia|sposta|spostare|rinvia|rimanda|rimandare|posticipa|posticipare|riprogramma|riprogrammare|slitta|slittare|anticipa|anticipare|annulla|annullare|cancella|cancellare|disdici|disdire)\s*$/i;

  // Contesto tipico di appuntamento/prenotazione o cosa stai cambiando
  const ctxRe =
    /\b(?:appunt\w*|prenot\w*|booking|data|giorno|ora|orario|slot|professionist\w*|operatric\w*|operatore|nome|intestat\w*)\b/i;

  // Cue data/tempo
  const dateCueRe =
    /\b(?:oggi|domani|dopodomani|tra|fra|settimana|prossim\w*|luned\w*|marted\w*|mercoled\w*|gioved\w*|venerd\w*|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2})\b/i;

  // Indicatori tipici di NUOVA prenotazione (non "prenotazione" ma "prenotare/prenota...")
  const newBookingRe =
    /\b(?:prenota|prenotare|prenoto|prenoti|prenotiamo|prenotate|prenoterei|prenoter\w*|disponibilit\w*|avete\s+(?:posto|un\s+buco)|siete\s+liber\w*|vorrei\s+prenot\w*|voglio\s+prenot\w*)\b/i;

  // Se è una frase da nuova prenotazione e NON c'è un verbo forte di modifica -> NON edit
  if (newBookingRe.test(s) && !strongActionRe.test(s)) return false;

  // Comandi secchi
  if (weakSoloCmdRe.test(s)) return true;
  if (soloCmdStrongRe.test(s)) return true;

  // Frase: serve azione forte + (contesto o cue data)
  return strongActionRe.test(s) && (ctxRe.test(s) || dateCueRe.test(s));
}
// Estrai “topic” informativo minimale dalla frase (per guidare il prompt QA)
function extractInfoTopic(text) {
  const s = norm(text || "");
  if (/\bhenne|henn[eè]\b/.test(s)) return "henné";
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
/**
 * The function `askQA` is an asynchronous function that interacts with an AI model to generate
 * responses based on a given prompt and context.
 * @param prompt - The `prompt` parameter in the `askQA` function represents the question or prompt
 * that you want to ask the AI model. This prompt is used to generate a response from the AI model
 * based on the context provided. You can pass a string containing the question or prompt that you want
 * the AI model
 * @param context - The `context` parameter in the `askQA` function represents the context or
 * background information that you want to provide to the AI model when asking a question. It can
 * include any relevant details, previous conversation history, or additional information that might
 * help the model generate a more accurate response. This context helps
 * @param client - The `client` parameter in the `askQA` function is typically used to interact with a
 * messaging client or service. It allows the function to send messages, receive responses, and perform
 * other actions related to communication with users. The specific implementation of the `client`
 * parameter will depend on the messaging platform
 * @returns The function `askQA` is returning the response from the Ollama AI model after processing
 * the provided prompt and context. The response is obtained by making a POST request to the Ollama API
 * endpoint (`/api/chat` or `/api/generate`) with the necessary parameters such as model, messages,
 * prompt, keep_alive, and options. The function then parses the output JSON response and returns
 */
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
  async function startEditDate(client, chatId) {
    const phone = phoneFromChatId(chatId);
    const bookings = getUserActiveBookingsAll(phone);

    if (!bookings.length) {
      return reply(
        client,
        chatId,
        "Non ho trovato prenotazioni future col tuo numero."
      );
    }

    async function openDateForBooking(booking) {
      const s = pending.get(chatId) || getState(chatId);
      _editSnapshotStateFromBooking(s, booking);
      s.step = "edit_reschedule_date";
      s.edit = { target: booking };
      s.collected = s.collected || {};
      pending.set(chatId, s);

      const line = _fmtBookingLine
        ? _fmtBookingLine(booking)
        : `${fmtDate(booking.startTime || booking.day || new Date())} — ${booking.service || ""}`;

      await reply(
        client,
        chatId,
        `Vuoi cambiare la data di:\n${line}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
      );

    };

    if (bookings.length === 1) {
      return openDateForBooking(bookings[0]);
    }

    // Più prenotazioni: scelgo quale, poi passo a edit_reschedule_date
    return startEditChooseBooking(
      client,
      chatId,
      bookings,
      "edit_reschedule_date"
    );
  }

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
    return `${cc ? cc + "\n\n" : ""
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
    } catch { }

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
    } catch { }
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
- Se chiede info e vuole anche prenotare -> appointment.
- Prezzi/listino/tariffe/sconti -> price.
- Solo saluti/small talk senza richiesta concreta -> greeting.
- Dubbi o fuori tema -> other.`;
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
          } catch { }
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
  if (!state) return;
  ensureContext(state);
  const now = Date.now();
  state.context.lock = {
    active: true,
    ts: now,
    ttl: BOOKING_LOCK_MS,
    type: "appointment"
  };
}
// === Controllo compatibilità tra professionista e servizio ===
function validateProfessionalForService(serviceName, professionalEmail) {
  try {
    if (!serviceName) return { ok: false, reason: "Servizio non specificato." };
    const svc = (config && config.services && config.services[serviceName]) || null;
    if (!svc) return { ok: false, reason: "Servizio non configurato." };

    const allowed = Array.isArray(svc.professionals) ? svc.professionals : [];
    if (!allowed.length) return { ok: true }; // servizio aperto a tutti i pro

    if (!professionalEmail) {
      // se non è stato scelto un pro specifico, permetti la scelta (verifica più tardi)
      return { ok: true };
    }

    if (!allowed.includes(professionalEmail)) {
      const proName =
        (config && config.professionals && config.professionals[professionalEmail] && config.professionals[professionalEmail].name) ||
        professionalEmail ||
        "professionista";
      const allowedNames = allowed
        .map((em) => (config && config.professionals && config.professionals[em] && config.professionals[em].name) || em)
        .filter(Boolean)
        .join(", ");
      return {
        ok: false,
        reason: `❌ ${proName} non esegue “${serviceName}”.\nDisponibili: ${allowedNames || "nessuno"}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    log("error", "validateProfessionalForService failed", e?.stack || e?.message || e);
    return { ok: false, reason: "Errore di validazione. Riprova." };
  }
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

/**
 * Ritorna true se la prenotazione è attualmente lockata e il lock è ancora valido.
 * Se il lock è corrotto o scaduto lo resetta in automatico e ritorna false.
 */
function isBookingLocked(st, nowTs) {
  if (!st || !st.context || !st.context.lock) return false;
  let lock = st.context.lock;
  // Se il lock è nel vecchio formato {type, until}, lo converto
  if (lock.type && typeof lock.until === "number") {
    const nowConv = typeof nowTs === "number" ? nowTs : Date.now();
    if (nowConv < lock.until) {
      // Lock ancora valido: imposto un nuovo lock con campo active/ts/ttl
      const remaining = lock.until - nowConv;
      st.context.lock = { active: true, ts: nowConv, ttl: remaining, type: lock.type };
      lock = st.context.lock;
    } else {
      // Lock scaduto: resetto lo stato
      st.context.lock = { active: false, ts: 0, ttl: 0 };
      return false;
    }
  }
  if (!lock.active) return false;
  const now = typeof nowTs === "number" ? nowTs : Date.now();
  // (resto del codice invariato...)
}

/**
 * Aggiorna/crea il lock sulla prenotazione.
 * Puoi passare opzionalmente un oggetto meta (es. { owner: chatId, reason: 'booking' }).
 */
function bumpBookingLock(st, ttlMs = 2 * 60 * 1000, meta) {
  if (!st) return;
  ensureContext(st);

  const rawTtl = Number(ttlMs);
  const ttl = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 2 * 60 * 1000;
  const now = Date.now();

  const prev = st.context.lock || {};
  // Filtra dal meta eventuali chiavi riservate (active, ts, ttl)
  const { active: _, ts: __, ttl: ___, ...metaFiltered } = meta || {};
  st.context.lock = {
    ...prev,          // mantengo vecchi metadati
    active: true,
    ts: now,
    ttl: ttl,
    ...metaFiltered   // aggiungo nuovi metadati filtrati
  };

}

/**
 * Sblocca esplicitamente la prenotazione.
 * Puoi passare un motivo per debugging (reason).
 */
function unlockBooking(st, reason) {
  if (!st || !st.context) return;

  const now = Date.now();
  const prev = st.context.lock || {};
  const { active: _, ts: __, ttl: ___, ...prevFiltered } = prev;
  st.context.lock = {
    ...prevFiltered,  // mantengo vecchi metadati (owner, reason, ecc.)
    active: false,
    ts: 0,
    ttl: 0,
    releasedAt: now,
    releaseReason: reason || "manual",
  };

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
  if (d === null || typeof d === "undefined" || d === "") return "";
  const D = d instanceof Date ? d : new Date(d);
  if (!D || Number.isNaN(D.getTime())) return "";
  if (D.getFullYear && D.getFullYear() <= 1971) return "";
  return `${String(D.getDate()).padStart(2, "0")}/${String(
    D.getMonth() + 1
  ).padStart(2, "0")}/${D.getFullYear()}`;
}

// "domenica 28/12/2025"
function fmtDateWithWeekdayIT(d) {
  if (d === null || typeof d === "undefined" || d === "") return "";
  const D = d instanceof Date ? d : new Date(d);
  if (!D || Number.isNaN(D.getTime())) return "";
  if (D.getFullYear && D.getFullYear() <= 1971) return "";
  const wd = typeof itaWeekdayName === "function" ? itaWeekdayName(D) : "";
  const ds = fmtDate(D);
  return wd ? `${wd} ${ds}` : ds;
}

function _buildRescheduleConfirmation(prevStartISO, nextStartISO) {
  try {
    const prev = prevStartISO ? new Date(prevStartISO) : null;
    const next = nextStartISO ? new Date(nextStartISO) : null;

    if (!next || Number.isNaN(next.getTime())) return "✅ Prenotazione aggiornata.";

    const hhmm = (D) =>
      `${String(D.getHours()).padStart(2, "0")}:${String(D.getMinutes()).padStart(2, "0")}`;

    const sameDate =
      prev &&
      !Number.isNaN(prev.getTime()) &&
      prev.getFullYear() === next.getFullYear() &&
      prev.getMonth() === next.getMonth() &&
      prev.getDate() === next.getDate();

    const sameTime =
      prev &&
      !Number.isNaN(prev.getTime()) &&
      hhmm(prev) === hhmm(next);

    const nextDayLabel =
      typeof fmtDateWithWeekdayIT === "function"
        ? fmtDateWithWeekdayIT(next)
        : next.toLocaleDateString("it-IT");
    const nextTime = hhmm(next);

    if (sameDate && !sameTime) return `✅ Appuntamento spostato alle ${nextTime}.`;
    if (!sameDate && sameTime) return `✅ Appuntamento spostato a ${nextDayLabel}.`;
    if (!sameDate && !sameTime) return `✅ Appuntamento spostato a ${nextDayLabel} alle ${nextTime}.`;
    return "✅ Prenotazione aggiornata.";
  } catch {
    return "✅ Prenotazione aggiornata.";
  }
}

function timeToMinutes(hhmm) {
  const parts = String(hhmm || "").split(":");
  const h = Number(parts[0] || 0);
  const m = Number(parts[1] || 0);
  return h * 60 + (m || 0);
}
// Ritorna true se il professionista è OFF per tutta la giornata (da config.unavailability)
function isProfessionalOffFullDay({ professionalEmail, day }) {
  if (!professionalEmail || !day) return false;

  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return false;

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  const dayKey = isoWeekday(D);
  const dayStart = new Date(D);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(D);
  dayEnd.setHours(23, 59, 59, 999);

  const unav = config.unavailability || {};
  const rules = Array.isArray(unav[professionalEmail])
    ? unav[professionalEmail]
    : [];
  if (!rules.length) return false;

  const IT2NUM = {
    lun: "1",
    lunedi: "1",
    lunedì: "1",
    mar: "2",
    martedi: "2",
    martedì: "2",
    mer: "3",
    mercoledi: "3",
    mercoledì: "3",
    gio: "4",
    giovedi: "4",
    giovedì: "4",
    ven: "5",
    venerdi: "5",
    venerdì: "5",
    sab: "6",
    sabato: "6",
    dom: "7",
    domenica: "7",
  };
  const EN2NUM = {
    mon: "1",
    monday: "1",
    tue: "2",
    tuesday: "2",
    wed: "3",
    wednesday: "3",
    thu: "4",
    thursday: "4",
    fri: "5",
    friday: "5",
    sat: "6",
    saturday: "6",
    sun: "7",
    sunday: "7",
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

  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const type = String(r.type || "").toLowerCase();

    // Giorno fisso della settimana
    if (type === "day" && Array.isArray(r.days)) {
      if (daysMatch(r.days) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }

    // Data/e specifiche: date / dates
    if (type === "date" || type === "dates") {
      const dates = Array.isArray(r.dates) ? r.dates : r.date ? [r.date] : [];
      if (dates.includes(toYMD(D)) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }

    // Range di date (from/to)
    if (type === "range") {
      if (inRange(r.from, r.to) && daysMatch(r.days)) {
        if (!r.hours || r.fullDay === true) return true;
      }
      continue;
    }

    // Ricorrenze (tipo: tutti i lun, mer, ecc.)
    if (type === "recurrence") {
      if (daysMatch(r.days) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }
  }

  return false;
}

function minutesToHHMM(min) {
  const H = Math.floor(min / 60);
  const M = min % 60;
  const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
  return `${pad2(H)}:${pad2(M)}`;
}

/**
 * Formatta una durata in minuti.
 * - < 60  -> "45 min"
 * - = 60  -> "1h"
 * - > 60  -> "1h 30min"
 */
function formatDurationMin(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  if (!m) return `${h}h`;
  return `${h}h ${m}min`;
}

function compareHHMM(a, b) {
  return timeToMinutes(a) - timeToMinutes(b);
}
function parseNaturalTime(s = "") {
  const t = norm(s);

  // "9 e 30" / "alle 9 e 30"
  {
    const m = t.match(
      /\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*e\s*([0-5]?\d)\b/
    );
    if (m)
      return `${String(+m[1]).padStart(2, "0")}:${String(+m[2]).padStart(
        2,
        "0"
      )}`;
  }

  // "e mezza" / "e un quarto" / "e venti" / "e dieci" / "e cinque"
  {
    const wordMin = {
      mezza: 30,
      mezzo: 30,
      trenta: 30,
      "un quarto": 15,
      quarto: 15,
      quindici: 15,
      venti: 20,
      dieci: 10,
      cinque: 5,
    };
    const m = t.match(
      /\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*e\s+([a-z\s]+)\b/
    );
    if (m) {
      const h = +m[1],
        w = m[2].trim();
      const key = Object.keys(wordMin).find((k) =>
        new RegExp(`\\b${k}\\b`).test(w)
      );
      if (key)
        return `${String(h).padStart(2, "0")}:${String(wordMin[key]).padStart(
          2,
          "0"
        )}`;
    }
  }

  // "10 meno 20" / "10 meno un quarto"
  {
    const wordMin = {
      "un quarto": 15,
      quarto: 15,
      venti: 20,
      dieci: 10,
      cinque: 5,
    };
    const mNum = t.match(
      /\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*meno\s*([0-5]?\d)\b/
    );
    if (mNum) {
      const h = (+mNum[1] - 1 + 24) % 24;
      const min = 60 - +mNum[2];
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    const mWord = t.match(
      /\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\s*meno\s+([a-z\s]+)\b/
    );
    if (mWord) {
      const h = (+mWord[1] - 1 + 24) % 24,
        w = mWord[2].trim();
      const key = Object.keys(wordMin).find((k) =>
        new RegExp(`\\b${k}\\b`).test(w)
      );
      if (key)
        return `${String(h).padStart(2, "0")}:${String(
          60 - wordMin[key]
        ).padStart(2, "0")}`;
    }
  }

  // "ore 9", "h9", "alle 9" -> 09:00
  {
    const m = t.match(/\b(?:alle?\s+|ore\s+|h\s*)?([01]?\d|2[0-3])\b/);
    if (m) return `${String(+m[1]).padStart(2, "0")}:00`;
  }

  // "mezzogiorno" / "mezzanotte"
  if (/\bmezzogiorn/i.test(t)) return "12:00";
  if (/\bmezzanott/i.test(t)) return "00:00";

  // "9.30" / "9,30" / "9 30" / "09 30"
  {
    const m = t.match(/\b([01]?\d|2[0-3])[\.\,\s:]([0-5]\d)\b/);
    if (m)
      return `${String(+m[1]).padStart(2, "0")}:${String(+m[2]).padStart(
        2,
        "0"
      )}`;
  }

  // "930" -> 09:30 (euristico)
  {
    const m = t.match(/\b(\d{3,4})\b/);
    if (m) {
      const n = m[1];
      if (n.length === 3) return `0${n[0]}:${n.slice(1)}`;
      if (n.length === 4) return `${n.slice(0, 2)}:${n.slice(2)}`;
    }
  }

  return null;
}
// ---- NEW: interpreta "11/12", "11-12" come intervallo orario se il contesto sembra tempo ----
function parseTimeRangeFallback(s = "") {
  if (!s) return null;
  // attiva fallback solo se ci sono indizi di tempo (evita di sovrascrivere date reali)
  if (!/\b(verso|intorn(o|a)|circa|intorno|ore|alle|mattin|pomerigg|sera|tarda)\b/i.test(s))
    return null;

  // cerca pattern tipo "11/12" oppure "11-12" oppure "11 / 12"
  const m = String(s).match(/\b([01]?\d|2[0-3])\s*[\/\-\–]\s*([01]?\d|2[0-3])\b/);
  if (!m) return null;

  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // se sono due ore adiacenti (11 e 12) scegli la mezz'ora; altrimenti scegli la minore
  const hh = Math.min(a, b);
  const mm = Math.abs(a - b) === 1 ? 30 : 0;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// modifica parseTimeSmart per provare anche il fallback degli intervalli
function parseTimeSmart(s = "") {
  return parseHHMM(s) || parseNaturalTime(s) || parseTimeRangeFallback(s);
}



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

// ===== Helpers giorno IT estesi (lunedi prossimo, tra X settimane, ecc.) =====
const DOW_IT = {
  domenica: 0,
  dom: 0,
  lunedi: 1,
  lunedì: 1,
  lun: 1,
  martedi: 2,
  martedì: 2,
  mar: 2,
  mercoledi: 3,
  mercoledì: 3,
  mer: 3,
  giovedi: 4,
  giovedì: 4,
  gio: 4,
  venerdi: 5,
  venerdì: 5,
  ven: 5,
  sabato: 6,
  sab: 6,
};

const INT_IT = {
  uno: 1,
  una: 1,
  un: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
};

function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}
function _startOfISOWeek(d) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const day = x.getDay();
  const delta = (day + 6) % 7;
  x.setDate(x.getDate() - delta);
  return x;
}
function _dateForDow(baseDate, dow, weeksOffset = 0) {
  const baseMon = _startOfISOWeek(baseDate);
  const d = new Date(baseMon);
  d.setDate(baseMon.getDate() + weeksOffset * 7 + ((dow + 6) % 7));
  d.setHours(12, 0, 0, 0);
  return d;
}
function _toInt(tok) {
  if (!tok) return null;
  const n = Number(tok);
  if (!Number.isNaN(n) && n >= 0) return n;
  return INT_IT[_norm(tok)] ?? null;
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

  const deriveNameFromEmail = (email) => {
    const s = String(email || "");
    const local = s.includes("@") ? s.split("@")[0] : s;
    const cleaned = local.replace(/[._-]+/g, " ").trim();
    if (!cleaned) return s;
    return cleaned
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  };

  const sanitizeMaybeDomain = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return s;
    // Caso tipico di configurazione errata tipo "Evelin.com" (senza @)
    if (!s.includes("@") && /^[a-z0-9._-]+\.[a-z]{2,}$/i.test(s)) {
      const base = s.split(".")[0];
      return base ? base : s;
    }
    return s;
  };

  return list
    .map((v) => {
      const raw =
        typeof v === "string" ? v.trim() : (v && (v.email || v.name)) || "";
      if (!raw) return null;

      if (raw.includes("@")) {
        const email = raw;
        const name =
          (config &&
            config.professionals &&
            config.professionals[email] &&
            config.professionals[email].name) ||
          (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
          deriveNameFromEmail(email);
        return { name, email };
      }

      const name = sanitizeMaybeDomain(raw);
      const email =
        typeof proEmailByName === "function" ? proEmailByName(name) || null : null;
      return { name, email };
    })
    .filter((x) => x && x.name);
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
    if (service && professional) {
      durMin = getServiceDurationForPro(service, professional);
    } else if (service) {
      const svc0 = config.services?.[service] || null;
      durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
    } else {
      durMin = 30;
    }
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
    if (service && professional) {
      // Usa durata specifica per questo professionista
      durMin = getServiceDurationForPro(service, professional);
    } else if (service) {
      // Fallback: durata generica del servizio
      const svc0 = config.services?.[service] || null;
      durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
    } else {
      durMin = 30; // fallback assoluto
    }
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
  if (filteredPros.length === 0) {
    return wantDetail ? [] : [];
  }

  const pros = filteredPros.length ? filteredPros : candidatePros;

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
          const name = (proNameByEmail(email) || "").trim();
          freePros.push({ email, name: name || "—" });
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
  if (filteredPros.length === 0) {
    return { times: [], map: {} };
  }

  const pros = filteredPros.length ? filteredPros : candidatePros;
  const slotsByPro = new Map();
  const busyByPro = new Map();
  for (const email of pros) {
    // Durata specifica per questo professionista
    const durMin = service
      ? getServiceDurationForPro(service, email)
      : Number(duration) || 30;
    const durMs = durMin * 60_000;
    const stepMs = durMs;

    const busy = busyByPro.get(email) || [];
    const freeTimes = new Set();

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
          if (cursor < be && bs < cursor + durMs) {
            clash = true;
            break;
          }
          if (bs >= cursor + durMs) break;
        }

        if (!clash) {
          const d = new Date(cursor);
          const key = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          freeTimes.add(key);
        }

        cursor += stepMs;
      }
    }

    slotsByPro.set(email, freeTimes);
  }

  // Costruisci mappa finale: time -> lista professionisti liberi
  const map = {};
  const allTimes = new Set();

  for (const [email, times] of slotsByPro) {
    for (const t of times) {
      allTimes.add(t);
      if (!map[t]) map[t] = [];
      map[t].push(email);
    }
  }

  const times = Array.from(allTimes).sort((a, b) => a.localeCompare(b));
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
  } catch (_) { }
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
function extractCustomerName(input, returnFallback = false) {
  const FALLBACK = "Nome non fornito";

  // Validazione input
  if (!input || typeof input !== 'string' && typeof input !== 'number') {
    return returnFallback ? FALLBACK : null;
  }

  let s = String(input).trim();

  // Rimuovi saluti comuni (case insensitive, più completo)
  s = s.replace(/^(ciao|buongiorno|buonasera|buona\s+sera|buon\s+giorno|hey|ehi|salve|salut|ciao\s+a\s+tutti)[,!\s]+/i, '');
  // ✅ PATCH: Rimuovi "per una mia amica/amico/collega/mamma/papà" ecc.
  s = s.replace(/\b(?:per|a\s+nome\s+di)\s+(?:un(?:a)?\s+)?(?:mi(?:a|o)?\s+)?(?:amica?|collega|sorella|fratello|mamma|papà|fidanzat[ao]|partner|moglie|marito|ragazza|ragazzo)\b/gi, '');

  // Rimuovi frasi introduttive per il nome (più pattern) - con word boundary
  s = s.replace(
    /^(mi\s+chiamo|io\s+mi\s+chiamo|io\s+sono|sono\s+|il\s+mio\s+nome\s+è|il\s+mio\s+nome\s+e|mi\s+presento|nome\s*[:=]\s*|nome\s+e\s+cognome\s*[:=]\s*|cognome\s*[:=]\s*|mi\s+chiamano)\s*/i,
    ''
  );

  // Rimuovi emoji e caratteri non validi per nomi
  s = s
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return returnFallback ? FALLBACK : null;

  // Tokenizza e filtra
  const tokens = s.split(/\s+/).filter(Boolean);

  // Validazione lunghezza minima
  const letters = s.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  if (letters.length < 2) return returnFallback ? FALLBACK : null;

  // Valida che non ci siano troppi token (evita frasi intere)
  if (tokens.length > 4) return returnFallback ? FALLBACK : null;

  // Filtra token troppo corti o troppo lunghi
  const validTokens = tokens.filter(t => {
    const letterCount = t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '').length;
    return letterCount >= 1 && letterCount <= 25;
  });

  if (validTokens.length === 0) return returnFallback ? FALLBACK : null;

  // Capitalizza correttamente (gestisce apostrofi e trattini)
  const capitalize = (word) => {
    // Gestisce casi come "D'Angelo" o "O'Brien"
    if (word.includes("'")) {
      return word.split("'").map((part, i) => {
        if (i === 0 && part.length === 1) {
          return part.toUpperCase();
        }
        return part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part;
      }).join("'");
    }
    // Gestisce casi come "Marie-Claire"
    if (word.includes('-')) {
      return word.split('-').map(part =>
        part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part
      ).join('-');
    }
    return word[0].toUpperCase() + word.slice(1).toLowerCase();
  };

  const name = validTokens.map(capitalize).join(' ');

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

/*
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
  reminders = [{ method: "popup", minutes: 1440 }],
}) {
  let allergies = null;
  const payload = {
    serviceName,
    professionalEmail,
    professionalName, // opzionale ma utile per il titolo in gcal
    clientPhone: _digitsPhone(clientPhone),
    clientName: customerName, // <— mapping richiesto da gcal.js
    startTime, // Date o ISO, gcal fa new Date(...)
    durationMin,
    price,
    serviceDetails: notes,
    allergies,
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

    // nuova API "pulita"
    if (typeof GCAL.cancelCalendarEvent === "function") {
      await GCAL.cancelCalendarEvent(eventId); // <— QUI: passa la stringa, NON l’oggetto
      return true;
    }

    // compat vecchie API object-based
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
function _editParseNewDate(raw) {
  const original = String(raw ?? "");
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const stripDiacritics = (s) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalize = (s) => {
    let t = stripDiacritics(String(s ?? "").toLowerCase().trim());
    t = t.replace(/[“”"']/g, "");
    t = t.replace(/\s+/g, " ").trim();
    // toglie punteggiatura ai bordi (così "domani?" funziona)
    t = t.replace(/^[?!.,;:()\[\]{}<>]+/g, "").replace(/[?!.,;:()\[\]{}<>]+$/g, "").trim();
    return t;
  };

  const txt = normalize(original);

  const isValidDate = (d, y, m, day) =>
    d instanceof Date &&
    !Number.isNaN(d.getTime()) &&
    d.getFullYear() === y &&
    d.getMonth() === m &&
    d.getDate() === day;

  const makeDate = (y, m, day) => {
    const d = new Date(y, m, day, 0, 0, 0, 0);
    return isValidDate(d, y, m, day) ? d : null;
  };

  const normalizeYear = (yy) => {
    if (yy == null) return null;
    const n = parseInt(String(yy), 10);
    if (Number.isNaN(n)) return null;
    if (n < 100) return 2000 + n; // 25 -> 2025
    return n;
  };

  const rollFutureIfMissingYear = (d) => {
    if (d && d < base) d.setFullYear(d.getFullYear() + 1);
    return d;
  };

  const addDays = (n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const wordToNumber = (w) => {
    const map = {
      un: 1, uno: 1, una: 1,
      due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
      undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16,
      diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
      ventuno: 21, ventidue: 22, ventitre: 23, ventiquattro: 24, venticinque: 25,
      ventisei: 26, ventisette: 27, ventotto: 28, ventinove: 29, trenta: 30, trentuno: 31
    };
    if (w == null) return null;
    const s = String(w).toLowerCase().trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return map[s] ?? null;
  };

  const monthMap = {
    gennaio: 0, gen: 0,
    febbraio: 1, feb: 1,
    marzo: 2, mar: 2,
    aprile: 3, apr: 3,
    maggio: 4, mag: 4,
    giugno: 5, giu: 5,
    luglio: 6, lug: 6,
    agosto: 7, ago: 7,
    settembre: 8, set: 8, sett: 8,
    ottobre: 9, ott: 9,
    novembre: 10, nov: 10,
    dicembre: 11, dic: 11
  };

  const weekdayMap = {
    lunedi: 1, lun: 1,
    martedi: 2, mar: 2,
    mercoledi: 3, mer: 3,
    giovedi: 4, gio: 4,
    venerdi: 5, ven: 5,
    sabato: 6, sab: 6,
    domenica: 0, dom: 0
  };

  const nextWeekday = (targetDow, addNextWeek) => {
    const d = new Date(base);
    const current = d.getDay();
    let diff = (targetDow - current + 7) % 7;
    if (diff === 0) diff = 7; // prossima occorrenza, non "oggi"
    if (addNextWeek) diff += 7; // "<giorno> prossimo" => settimana successiva
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // --- Relativi (anche dentro frasi tipo "domani?" / "domani pomeriggio") ---
  if (/\boggi\b/.test(txt)) return new Date(base);

  if (/\bdopodomani\b/.test(txt)) return addDays(2);

  if (/\bdomani\b/.test(txt)) return addDays(1);

  // "tra/fra X giorni|settimane|mesi|anni" (X numero o parola)
  {
    const rel = txt.match(/\b(tra|fra)\s+([a-z0-9]+)\s*(giorno|giorni|g|gg|settimana|settimane|sett|mese|mesi|anno|anni)\b/);
    if (rel) {
      const n = wordToNumber(rel[2]);
      const unit = rel[3];
      if (n != null && n >= 0) {
        const d = new Date(base);
        if (unit === "giorno" || unit === "giorni" || unit === "g" || unit === "gg") {
          d.setDate(d.getDate() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "settimana" || unit === "settimane" || unit === "sett") {
          d.setDate(d.getDate() + n * 7);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "mese" || unit === "mesi") {
          d.setMonth(d.getMonth() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
        if (unit === "anno" || unit === "anni") {
          d.setFullYear(d.getFullYear() + n);
          d.setHours(0, 0, 0, 0);
          return d;
        }
      }
    }
  }

  // --- Giorni della settimana: "lunedi", "lunedi prossimo", "venerdi settimana prossima" ---
  {
    const w = txt.match(/\b(lunedi|lun|martedi|mar|mercoledi|mer|giovedi|gio|venerdi|ven|sabato|sab|domenica|dom)\b/);
    if (w) {
      const key = w[1];

      const keyRe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isWeekdayProssimo =
        new RegExp(`\\b${keyRe}\\s+prossim[oa]\\b|\\bprossim[oa]\\s+${keyRe}\\b`).test(txt);

      const hasWeekQualifier = /\b(settimana prossima|della prossima settimana)\b/.test(txt);

      // Regola: calcola il prossimo <giorno> e poi +7 giorni
      return nextWeekday(weekdayMap[key], hasWeekQualifier || isWeekdayProssimo);
    }
  }


  // --- Date numeriche: ISO (YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD) dentro la frase ---
  {
    const iso = txt.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (iso) {
      const y = parseInt(iso[1], 10);
      const m = parseInt(iso[2], 10) - 1;
      const day = parseInt(iso[3], 10);
      const d = makeDate(y, m, day);
      if (d) return d;
    }
  }

  // --- Date numeriche: D/M(/Y) con / - . anche dentro la frase (gestisce swap se mese>12) ---
  {
    const dmy = txt.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
    if (dmy) {
      let a = parseInt(dmy[1], 10);
      let b = parseInt(dmy[2], 10);
      const yOpt = normalizeYear(dmy[3]) ?? base.getFullYear();

      // Italia: preferenza D/M. Se mese invalido ma l'altro senso è valido, swappa.
      let dd = a, mm = b - 1;
      let d = makeDate(yOpt, mm, dd);

      if (!d) {
        // prova swap (M/D) se sembra plausibile
        dd = b; mm = a - 1;
        d = makeDate(yOpt, mm, dd);
      }

      if (d) {
        if (dmy[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- Date con spazi: "15 12 2025" / "15 12" ---
  {
    const spaced = txt.match(/\b(\d{1,2})\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/);
    if (spaced) {
      const a = parseInt(spaced[1], 10);
      const b = parseInt(spaced[2], 10);
      const yOpt = normalizeYear(spaced[3]) ?? base.getFullYear();

      // evita collisioni con orari tipo "alle 15 30" (non perfetto ma riduce falsi positivi)
      if (!/\balle\b|\bdalle\b|\bore\b/.test(txt)) {
        let d = makeDate(yOpt, b - 1, a);
        if (!d) d = makeDate(yOpt, a - 1, b); // swap se necessario
        if (d) {
          if (spaced[3] == null) d = rollFutureIfMissingYear(d);
          return d;
        }
      }
    }
  }

  // --- "15 dicembre" / "15 dic 2025" / "dicembre 15" ---
  {
    const monthKeys = Object.keys(monthMap).sort((a, b) => b.length - a.length).join("|");

    // giorno + mese (+ anno)
    const dm = txt.match(new RegExp(`\\b(\\d{1,2})(?:\\s*(?:°|º))?\\s*(?:di\\s*)?(${monthKeys})\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (dm) {
      const day = parseInt(dm[1], 10);
      const mKey = dm[2].toLowerCase();
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(dm[3]) ?? base.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (dm[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }

    // mese + giorno (+ anno)
    const md = txt.match(new RegExp(`\\b(${monthKeys})\\s+(\\d{1,2})(?:\\s*(?:°|º))?\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (md) {
      const mKey = md[1].toLowerCase();
      const day = parseInt(md[2], 10);
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(md[3]) ?? base.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (md[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- Solo giorno: "15" / "il 15" (mese corrente se futuro, altrimenti mese prossimo) ---
  {
    const onlyDay = txt.match(/^(?:il\s+)?(\d{1,2})(?:\s*(?:°|º))?$/);
    if (onlyDay) {
      const day = parseInt(onlyDay[1], 10);
      let y = base.getFullYear();
      let m = base.getMonth();

      let d = makeDate(y, m, day);
      if (!d) return null;

      if (d < base) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        d = makeDate(y, m, day);
        if (!d) return null;
      }
      return d;
    }
  }

  // --- Fallback: parser esterno se presente ---
  if (typeof parseDaySmart === "function") {
    const d = parseDaySmart(original, { baseDate: base });
    if (d && !Number.isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  return null;
}

async function startEditDate(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);

  if (!bookings.length) {
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  }

  const openDateForBooking = async (booking) => {
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking);
    s.step = "edit_reschedule_date";
    s.edit = { target: booking };
    s.collected = s.collected || {};
    pending.set(chatId, s);

    const line = _fmtBookingLine
      ? _fmtBookingLine(booking)
      : `${fmtDate(booking.startTime || booking.day || new Date())} — ${booking.service || ""
      }`;

    return reply(
      client,
      chatId,
      `Vuoi cambiare la data di:\n${line}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
    );
  };

  if (bookings.length === 1) {
    return openDateForBooking(bookings[0]);
  }

  // Più prenotazioni: scelgo quale, poi passo a edit_reschedule_date
  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_reschedule_date"
  );
}

// Durata del servizio con fallback a 30'
function _editDuration(booking) {
  if (!booking) return 30;

  const svc = booking.service || booking.serviceName;
  const proEmail = booking.professionalEmail;

  // ✅ Se abbiamo servizio e professionista, usa durata specifica
  if (svc && proEmail) {
    return getServiceDurationForPro(svc, proEmail);
  }

  // Fallback: durata dal booking o da config
  return (
    Number(booking.durationMin) ||
    cfgServiceDuration(svc) ||
    30
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

// Copia i dati base della prenotazione dentro state.collected
function _editSnapshotStateFromBooking(state, booking) {
  if (!state || !booking) return;
  const col = state.collected || (state.collected = {});

  // servizio
  if (!col.service) {
    col.service = booking.service || col.service || null;
  }

  // nome cliente
  if (booking.customerName && !col.customerName) {
    col.customerName = booking.customerName;
  }

  // professionista
  const proEmail = booking.professionalEmail || null;
  const proName =
    booking.professionalName ||
    (proEmail && typeof proNameByEmail === "function"
      ? proNameByEmail(proEmail)
      : null);

  if (proEmail) col.professionalEmail = proEmail;
  if (proName) col.professionalName = proName;

  if (!proEmail && !proName) {
    // nessuna preferenza esplicita: se non è già impostato, considero "qualunque"
    if (typeof col.professionalAny !== "boolean") {
      col.professionalAny = true;
    }
  } else {
    col.professionalAny = false;
  }

  // data + orario
  if (booking.startTime && !col.when) {
    const d = new Date(booking.startTime);
    if (!Number.isNaN(d.getTime())) {
      const day = new Date(d);
      day.setHours(12, 0, 0, 0);
      col.when = day;
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      col.time = `${hh}:${mm}`;
    }
  }
}

// Formattare lista orari numerata
function _editFormatTimeList(times) {
  return (times || []).map((t, i) => `${i + 1}) ${t}`).join("\n");
}

// Render slot list numerata (supporta oggetti {time, pros:[{name}]} oppure stringhe 'HH:MM')
function renderSlotsList(slots = []) {
  return (slots || [])
    .map((slot, i) => {
      if (typeof slot === "string") return `${slot}`;
      const time = slot?.time || slot?.hhmm || "";
      const prosNames =
        slot?.pros && slot.pros.length
          ? ` (${slot.pros.map((p) => p.name).join(", ")})`
          : slot?.professionalName
            ? ` (${slot.professionalName})`
            : "";
      return `${time}${prosNames}`.trim();
    })
    .join("\n");
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

/*
 * Applica un aggiornamento all'evento (Calendar) e al bookings.json.
 * - newStartISO: ISO string nuova data/ora (se null -> non cambia)
 * - newProEmail: email nuovo professionista (se null -> non cambia)
 * - newName: nuovo nome cliente (se null -> non cambia)
 */
async function _editApplyUpdate({
  booking,
  newStartISO = null,
  newProEmail = null,
  newName = null,
  forceRecreate = false, // true = cancella vecchio evento e ne crea uno nuovo
}) {
  if (!booking?.eventId) return false;

  const prev = {
    startTime: booking.startTime,
    professionalEmail: booking.professionalEmail || null,
    professionalName: booking.professionalName || null,
    customerName: booking.customerName || null,
  };

  const nextStartISO = newStartISO || booking.startTime;
  const nextProEmail = newProEmail ?? booking.professionalEmail;

  const nextNotes =
    typeof booking.notes !== "undefined" || newName
      ? _editComputeNewNotes(booking.notes, newName)
      : booking.notes;

  const nextDuration = _editDuration(booking);
  const nextProName =
    (nextProEmail &&
      typeof proNameByEmail === "function" &&
      proNameByEmail(nextProEmail)) ||
    booking.professionalName ||
    null;
  const nextClientName = newName || booking.customerName || null;

  const patch = {};
  if (newStartISO) patch.startTime = nextStartISO;
  if (newProEmail) {
    patch.professionalEmail = newProEmail;
    patch.professionalName = nextProName;
  }
  if (newName) patch.customerName = newName;
  if (typeof nextNotes !== "undefined") patch.notes = nextNotes;

  const shouldRecreate = !!(forceRecreate && newStartISO);

  // ——— CASO 1: cambio data/ora con ricreazione evento (no duplicati) ———
  if (shouldRecreate) {
    let newEventId = booking.eventId;

    // Cancella l'evento vecchio (se esiste ancora)
    try {
      await cancelEventSafe(booking.eventId);
    } catch (e) {
      try {
        log("warn", "[EDIT] cancelEventSafe failed", e?.message || e);
      } catch { }
      // anche se fallisce la cancellazione, provo comunque a creare il nuovo evento
    }

    try {
      const ev = await makeEvent({
        serviceName: booking.service,
        professionalEmail: nextProEmail,
        professionalName: nextProName,
        clientPhone: booking.clientPhone,
        customerName: nextClientName,
        startTime: nextStartISO,
        durationMin: nextDuration,
        notes: nextNotes,
        price:
          typeof cfgServicePriceText === "function"
            ? cfgServicePriceText(booking.service)
            : booking.price || null,
        allergic: booking.allergic ?? null,
        reminders: booking.reminders || [{ method: "popup", minutes: 1440 }],
      });

      newEventId = (ev && (ev.id || ev.eventId)) || booking.eventId;
    } catch (e) {
      try {
        log("warn", "[EDIT] makeEvent failed", e?.message || e);
      } catch { }
      return false;
    }

    if (newEventId && newEventId !== booking.eventId) {
      patch.eventId = newEventId;
    }

    updateBookingByEventId(booking.eventId, patch);

    try {
      const after = {
        startTime: patch.startTime || prev.startTime,
        professionalEmail: patch.professionalEmail || prev.professionalEmail,
        professionalName: patch.professionalName || prev.professionalName,
        customerName: patch.customerName || prev.customerName,
      };
      log("info", "[EDIT] booking updated (recreate)", {
        oldEventId: booking.eventId,
        newEventId,
        before: prev,
        after,
      });
    } catch { }

    return true;
  }

  // ——— CASO 2: cambio solo pro/nome -> patch sullo stesso eventId ———
  const ok = await updateEventSafe({
    eventId: booking.eventId,
    serviceName: booking.service,
    professionalEmail: nextProEmail,
    professionalName: nextProName,
    clientPhone: booking.clientPhone,
    clientName: nextClientName,
    startTime: nextStartISO,
    durationMin: nextDuration,
    price: booking.price || null,
    serviceDetails: nextNotes,
    allergic: booking.allergic ?? null,
    reminders: booking.reminders || [{ method: "popup", minutes: 1440 }],
  });

  if (!ok) {
    try {
      log("warn", "[EDIT] updateEventSafe failed", {
        eventId: booking.eventId,
        startTime: nextStartISO,
        professionalEmail: nextProEmail || booking.professionalEmail,
      });
    } catch { }
    return false;
  }

  updateBookingByEventId(booking.eventId, patch);

  try {
    const after = {
      startTime: patch.startTime || prev.startTime,
      professionalEmail: patch.professionalEmail || prev.professionalEmail,
      professionalName: patch.professionalName || prev.professionalName,
      customerName: patch.customerName || prev.customerName,
    };
    log("info", "[EDIT] booking updated", {
      eventId: booking.eventId,
      before: prev,
      after,
    });
  } catch { }

  return true;
}

// Riconosce domande informative (robusto anche senza "?")
function looksLikeInfoQuestion(s) {
  const q = norm(s || ""); // <— prima era toLowerCase(); ora normalizziamo accenti/apostrofi

  // Domande informative (non contiene 'posto/disponibilità' per non rubare i casi slot)
  const infoPat =
    /\b(?:cos[’'` ]?e|cos[’'` ]?è|che\s+cosa|che\s+cos[’'` ]?e|come\s+funzion\w*|info(?:\s+su)?|informazioni?|spieg\w*|dettagl\w*|prezz\w*|costo\w*|tariff\w*|quanto\s+(?:dura|costa)|durata|cosa\s+serve|in\s+cosa\s+consist\w*|controindic\w*|effetti|benefici)\b/u;

  const isQuestionish =
    /[?？]\s*$/.test(q) ||
    /\b(?:perch[eé]|come|cosa|che|quale|quando)\b/.test(q);

  return infoPat.test(q) && isQuestionish;
}

// Ci sono step “critici” in cui NON interrompiamo con l’info (es. l’utente sta selezionando un numero)
function isInCriticalStep(step) {
  return [
    "choose_service",
    "choose_day", // <--- AGGIUNTO
    "pick_time",
    "pick_professional",
    "ask_name",
    "confirm_booking",
    "price_select_service",
    "info_select_service",
  ].includes(step);
}

async function startEditTime(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length) {
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );
  }

  const openTimeForBooking = async (booking) => {
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    const day = _editDayFromBooking(booking);
    const duration = _editDuration(booking);
    const pro = booking.professionalEmail || null;

    try {
      releaseSoftHoldByChat(chatId);
    } catch { }

    const slots = normalizeSlotsDetail(
      await fetchSlots({
        service: booking.service,
        day,
        duration,
        professional: pro,
        wantDetail: true,
      })
    );

    if (!slots.length) {
      const dateStr = typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(day)
        : (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
      return reply(
        client,
        chatId,
        `Non vedo orari liberi per ${dateStr} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
      );
    }


    s.step = "edit_reschedule_time";
    s.edit = { target: booking, day };
    s.collected = s.collected || {};
    s.collected.options = slots;
    pending.set(chatId, s);

    // PATCH: rimosso elenco numerato degli orari, l'utente sceglie l'orario direttamente
    const dateStr = typeof formatDateWithWeekdayIT === "function"
      ? formatDateWithWeekdayIT(day)
      : (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
    const lines = renderSlotsList(slots);
    return reply(
      client,
      chatId,
      `Orari disponibili per ${dateStr} (tengo il professionista attuale):\n${lines}\n\nScrivi l'orario desiderato (es. "14:30") o tocca l'orario mostrato.`
    );
  };

  if (bookings.length === 1) {
    return openTimeForBooking(bookings[0]);
  }

  // Più prenotazioni: scelgo quale, poi passo a edit_reschedule_time con quel booking
  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_reschedule_time"
  );
}

async function startEditProfessional(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );

  if (bookings.length === 1) {
    const booking = bookings[0];
    const pros = (cfgServiceProfessionals(booking.service) || []).filter(
      (x) => x && x.name
    );
    if (!pros.length)
      return reply(
        client,
        chatId,
        "Non ho professionisti associati a questo servizio."
      );
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    s.step = "edit_pick_professional";
    s.edit = { target: booking, proOptions: pros };
    pending.set(chatId, s);

    const list =
      "0) Indietro (tieni quello attuale)\n" +
      pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
    return reply(
      client,
      chatId,
      `Scegli il professionista:\n${list}\n(0-${pros.length})`
    );
  }

  return startEditChooseBooking(
    client,
    chatId,
    bookings,
    "edit_pick_professional"
  );
}

async function startEditName(client, chatId) {
  const phone = phoneFromChatId(chatId);
  const bookings = getUserActiveBookingsAll(phone);
  if (!bookings.length)
    return reply(
      client,
      chatId,
      "Non ho trovato prenotazioni future col tuo numero."
    );

  if (bookings.length === 1) {
    const booking = bookings[0];
    const s = pending.get(chatId) || getState(chatId);
    _editSnapshotStateFromBooking(s, booking); // << mente locale
    s.step = "edit_change_name";
    s.edit = { target: booking };
    pending.set(chatId, s);

    return reply(
      client,
      chatId,
      "Scrivi il nuovo nome e cognome per la prenotazione."
    );
  }

  return startEditChooseBooking(client, chatId, bookings, "edit_change_name");
}

// ========= Heuristics di intent (semplici ma robusti) =========
function hasBookingVerb(s) {
  s = norm(s || "");
  return /\b(prenot|appunt|fiss|riserv|disponibil|spost|cancell|modific|posto|quando\s+(?:avete|hai|c'e))\w*/i.test(s);
  // ✅ Aggiunto: "posto", "quando avete", "quando hai"
}
function hasDateOrTime(s) {
  s = String(s || "");
  return (
    /\b(oggi|domani|dopodomani|settimana\s+prossima)\b/i.test(s) || // parole chiave
    /\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/.test(s) || // 21/10[/2025]
    /\b(?:alle\s*)?([01]?\d|2[0-3])[:\.]([0-5]\d)\b/i.test(s) // 10:30 / alle 9.00
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
  if (safeParseDateWithLock(s)) score += 1;
  return score;
}
function primaryIntent(txt) {
  const si = scoreInfoIntent(txt);
  const sb = scoreBookingIntent(txt);
  if (si >= sb + 1) return "info";
  if (sb >= si + 1) return "appointment";
  if (si === sb && /[?？]/.test(txt)) return "info"; // pareggio: domanda -> info
  return null;
}

// ========= parseAvailabilityRequest (minimale, safe) =========
function parseAvailabilityRequest(text) {
  const t = norm(text || "");
  const out = { kind: null };

  // giorno singolo: oggi/domani/dopodomani
  if (/\boggi\b/.test(t) || /\bdomani\b/.test(t) || /\bdopodomani\b/.test(t)) {
    const d = safeParseDateWithLock(t);
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
        if (idx < now.getMonth()) year++; // se è già passato -> anno prossimo
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
    // Verbi/indizi di nuova prenotazione
    regex:
      /\b(prenota(?:re)?|volevo\s+prenotare|vorrei\s+prenotare|voglio\s+prenotare|mi\s+serve\s+prenotare|fissa(?:re)?\s+(?:un\s+)?appuntamento|metti(?:\s+un)?\s+appuntamento|blocca(?:re)?\s+un\s+posto)\b/iu,
    weight: 6,
  },
  // ... lascia invariati gli altri (ma se vedi "..." rimuovili allo stesso modo)
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
  return hasDateOrTime(text) || !!parseHHMM(text) || !!safeParseDateWithLock(text);
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
  !/\b(modifica|sposta|cambia|posticipa|anticipa|aggiorna|annulla|cancella|disdici|disdire|elimina|togli|rimuovi|annula)\b/iu.test(
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
/**
 * The function proShort takes a name as input, trims any whitespace, splits the name into parts, and
 * returns the first part followed by the first letter of the last part with a period.
 * @param name - The `proShort` function takes a `name` parameter as input. It processes the input name
 * by trimming any leading or trailing whitespace, splitting it into parts based on whitespace, and
 * then returning a shortened version of the name.
 * @returns The function `proShort` takes a name as input, processes it, and returns a shortened
 * version of the name. If the input is empty or only whitespace, an empty string is returned. If the
 * input contains only one word, that word is returned. If the input contains multiple words, the
 * function returns the first word followed by the first letter of the last word, capitalized, and a
 * period
 */
function proShort(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const iniz = last[0] ? last[0].toUpperCase() : "";
  return `${parts[0]} ${iniz}.`;
}

function normalizeSlotsDetail(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.slots)
      ? raw.slots
      : Array.isArray(raw?.times)
        ? raw.times
        : [];

  const toHHMM = (v) => {
    if (!v) return null;

    if (v instanceof Date) {
      const hh = String(v.getHours()).padStart(2, "0");
      const mm = String(v.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    const s = String(v).trim();
    const m = s.match(/(\d{1,2})\s*[:.]\s*(\d{1,2})/);
    if (!m) return null;

    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  const normPro = (p) => {
    if (!p) return null;

    // stringa: può essere email oppure nome
    if (typeof p === "string") {
      const s = String(p).trim();
      if (!s) return null;
      if (s.includes("@")) {
        const nice = (typeof proNameByEmail === "function" ? proNameByEmail(s) : "") || "";
        return { name: nice || "—", email: s };
      }
      return { name: s, email: "" };
    }

    if (typeof p !== "object") return null;

    const email = String(p.email || p.mail || p.id || p.value || "").trim();
    const rawName = String(p.name || p.displayName || p.fullName || p.label || p.title || "").trim();

    // Evita che il nome visualizzato sia un'email
    let name = rawName;
    if (!name || name.includes("@")) {
      const nice = email && (typeof proNameByEmail === "function" ? proNameByEmail(email) : "");
      name = String(nice || "").trim();
    }

    if (!name && !email) return null;
    return { name: name || "—", email: email || null };
  };

  const byTime = new Map(); // "HH:MM" -> {time, pros:[]}

  const add = (time, pros) => {
    if (!time) return;
    const cur = byTime.get(time) || { time, pros: [] };

    if (Array.isArray(pros) && pros.length) {
      const seen = new Set(
        cur.pros.map((x) => String(x.email || x.name || "").toLowerCase())
      );
      for (const p of pros) {
        const key = String(p.email || p.name || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        cur.pros.push(p);
      }
    }

    byTime.set(time, cur);
  };

  for (const item of list) {
    if (typeof item === "string") {
      add(toHHMM(item), []);
      continue;
    }
    if (item && typeof item === "object") {
      const time = toHHMM(
        item.time ?? item.hhmm ?? item.startTime ?? item.start ?? item.slot
      );
      let pros = item.pros ?? item.professionals ?? item.availablePros ?? [];
      if (!Array.isArray(pros)) pros = [];
      pros = pros.map(normPro).filter((p) => p && p.name);
      add(time, pros);
    }
  }

  return Array.from(byTime.values()).sort((a, b) =>
    a.time.localeCompare(b.time)
  );
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
 * The function `labelProsForSlot` takes an item object, extracts an array of pros, shortens their
 * names, and returns a formatted string with a summary of the pros.
 * @param item - It looks like the `labelProsForSlot` function is designed to process an `item` object
 * that contains a property called `pros`, which is expected to be an array of objects. The function
 * checks if `item.pros` is an array, and if so, it extracts the names
 * @returns The `labelProsForSlot` function returns a string that represents the pros of an item. If
 * the item has pros, it will format and return them as a string. If there are more than 2 pros, it
 * will display the first two pros followed by a count of the remaining pros. If there are no pros or
 * an error occurs, an empty string will be returned.
 */


function labelProsForSlot(item) {
  try {
    const pros = Array.isArray(item?.pros) ? item.pros : [];
    if (!pros.length) return "";
    const names = pros.map((p) => {
      const raw = String(p?.name || p?.email || "").trim();
      const nice =
        raw.includes("@")
          ? ((typeof proNameByEmail === "function" ? proNameByEmail(raw) : "") || "").trim()
          : raw;
      return proShort(nice || "—");
    });
    if (names.length <= 2) return names.filter(Boolean).join(", ");
    const head = names.slice(0, 2).filter(Boolean).join(", ");
    return `${head} +${names.length - 2}`;
  } catch {
    return "";
  }
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
} //

/**
 * The function `creaEInviaSticker` asynchronously creates and sends a sticker using a provided image
 * file in a specified chat.
 * @param client - The `client` parameter in the `creaEInviaSticker` function is typically an instance
 * of a WhatsApp client library that allows you to interact with the WhatsApp API programmatically.
 * This client is used to send the sticker to a specific chat identified by `chatId`.
 * @param chatId - The `chatId` parameter in the `creaEInviaSticker` function represents the unique
 * identifier of the chat or conversation where you want to send the sticker. It is typically a string
 * that identifies a specific chat or recipient within the messaging platform or application you are
 * using.
 * @param immagine - The `immagine` parameter in the `creaEInviaSticker` function represents the path
 * to the image file that you want to convert and send as a sticker. It is the file path where the
 * image is located on your filesystem. Make sure to provide the correct path to the image
 */
async function creaEInviaSticker(client, chatId, immagine) {

  const mimeType = 'image/jpeg'; // Adatta il tipo MIME al tuo file (es. image/png)

  // 2. Leggi il file e convertilo in Base64
  const mediaData = fsSync.readFileSync(immagine);

  // 3. Crea la stringa Data URI (fondamentale per wa-automate-nodejs)
  const imageBase64 = `data:${mimeType};base64,${mediaData.toString('base64')}`;

  // 4. (Opzionale) Definisci i metadati dello sticker
  const opzioniSticker = {
    author: 'synkris',      // Nome dell'autore
    pack: 'stickers!!', // Nome del pacchetto
    keepScale: true,           // Mantiene la scala originale (utile per non tagliarla)
    // Se vuoi uno sticker circolare, usa: circle: true
  };

  // 5. Invia lo sticker
  try {
    await client.sendImageAsSticker(
      chatId,
      imageBase64,
      opzioniSticker // Passa le opzioni
    );
    console.log(`Sticker inviato con successo a: ${chatId}`);
  } catch (e) {
    console.error('Errore durante l\'invio dello sticker:', e);
  }
}
function ensureUI(state) {
  if (!state) return;
  state.ui = state.ui || {};
}
// ======================= Gestione messaggi (WhatsApp) =======================ì
/**
 * handleMessage - Gestione completa del flusso di prenotazione
 * 
 * Flusso principale:
 * 1. Scelta professionista
 * 2. Scelta servizio (filtrato per professionista)
 * 3. Scelta giorno
 * 4. Scelta orario
 * 5. Raccolta nome
 * 6. Conferma e creazione evento
 * 
 * @param {Object} client - Client WhatsApp
 * @param {string} chatId - ID della chat
 * @param {string} textRaw - Testo del messaggio utente
 * @param {Object} tools - Tools aggiuntivi (opzionale)
 * @returns {Promise<string>} - Risultato dell'operazione
 */
export async function handleMessage(client, chatId, textRaw, tools = {}) {
  // Inizializzazione stato
  let state = getState(chatId);
  await greetIfReturningUser(chatId, client, state);

    // ============================================================================
  // SEZIONE 1: LISTINO / RICHIESTE INFORMATIVE (non avviare prenotazione)
  // ============================================================================
  try {
    if (typeof textRaw === "string" && textRaw.trim()) {
      const raw = textRaw.trim();

      // Non interrompere step critici o flusso edit
      const inEdit = typeof state.step === "string" && state.step.startsWith("edit_");
      if (!isInCriticalStep(state.step) && !inEdit) {
        // segnali tipici di prenotazione
        const bookingCues =
          /\b(prenot\w*|appunt\w*|disponibilit\w*|posto|buco|slot|orari|avete\s+(?:un\s+)?posto|vorrei\s+prenot\w*|posso\s+prenot\w*|mi\s+prenot\w*)\b/i;

        // segnali informativi (prezzo/durata/prima volta/curiosità)
        const listinoCues =
          /\b(listin(?:o|i)|listino\s+prezzi|prezzi|tariff(?:a|e)|prezzo|costo|quanto\s+(?:costa|costano)|che\s+trattamenti\s+avete|cosa\s+offrite|mostrami\s+i\s+(?:trattamenti|servizi))\b/i;
        const durataCues =
          /\b(durat\w*|quanto\s+dura|quanto\s+tempo|minut\w*|ore?)\b/i;
        const firstTimeCues =
          /\b(prima\s+volta|nuov[ao]\s+client[ea]|sono\s+nuov[ao])\b/i;

        const isInfoLike =
          listinoCues.test(raw) || durataCues.test(raw) || firstTimeCues.test(raw) || looksLikeInfoQuestion(raw);
        const isBookingLike = bookingCues.test(raw);

        if (isInfoLike && !isBookingLike) {
          const svcs = cfgServices() || [];
          if (!svcs.length) {
            await reply(client, chatId, "⚠️ Nessun trattamento configurato. Contatta il salone.");
            return "";
          }

          // Se l’utente cita un trattamento, mostra quello; altrimenti mostra tutto
          const svcHit = typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(raw) : null;
          const pick = svcHit && svcs.includes(svcHit) ? [svcHit] : svcs;

          const lines = pick.map((svc) => {
            const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;
            const emoji = it?.emoji ? it.emoji : "";
            const price = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "prezzo su richiesta";
            const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
            const durTxt = typeof formatDurationMin === "function"
              ? (formatDurationMin(dur) || `${dur} min`)
              : `${dur} min`;
            return `${emoji ? emoji + " " : ""}${svc}: ${price} (durata ${durTxt})`;
          });

          const header = svcHit ? `ℹ️ ${svcHit}:` : "🧖‍♀️ Listino trattamenti:";
          const msg =
            `${header}\n\n${lines.join("\n")}` +
            `\n\nSe vuoi prenotare dimmelo quando preferisci 😊`;

          await reply(client, chatId, msg);
          return "";
        }
      }
    }
  } catch (err) {
    log("warn", "[INFO/LISTINO] Errore rilevamento info", err?.message || err);
  }

  // ============================================================================
  // SEZIONE 2: RISPOSTE RAPIDE (con return obbligatorio)
  // ============================================================================

  // Ringraziamenti
  if (textRaw && /^(grazie|grazie mille|grazie infinite|ti ringrazio|grazie di tutto|thanks?|thank you|thx)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, "Grazie a te per aver usato synkris! 😊");
    return "";
  }

  // Saluti di apertura (solo se step iniziale)
  if (textRaw && /^(ciao|buongiorno|buonasera|buon\s+giorno|buona\s+sera|salve|hey|ehi|hi|hello)[\s!.]*$/i.test(textRaw.trim()) && state.step === "collect") {
    await reply(
      client,
      chatId,
      'Ciao! 👋 Benvenuto da The Beautiful Room, sono _synkris_!\n\n' +
      'Come posso aiutarti oggi?\n' +
      '• Scrivi "_*prenota*_" per un nuovo appuntamento\n' +
      '• Scrivi "_*modifica*_" per gestire una prenotazione esistente'
    );
    return "";
  }

  // Gestione saluto + intent di prenotazione (rimuovi saluto e continua)
  const hasGreeting = /\b(ciao|buongiorno|buonasera|salve|hey|hi|hello)\b/i.test(textRaw);
  const hasBookingIntent = /\b(prenot|appunt|fiss|riserv|disponibil|posto|quando\s+avete)\w*/i.test(textRaw);
  if (hasGreeting && hasBookingIntent) {
    textRaw = textRaw.replace(/^(ciao|buongiorno|buonasera|buon\s+giorno|buona\s+sera|salve|hey|ehi|hi|hello)[,!\s]*/i, '').trim();
  }

  // Scuse
  if (textRaw && /^(scusa|scusami|mi scuso|perdon[ao]|sorry)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Nessun problema! 😊", "Tranquillo/a, tutto ok! 👍", "Non ti preoccupare! 🙂"];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return "";
  }

  // Complimenti
  if (textRaw && /^(bravo|brava|ottimo|perfetto|fantastico|bene|ben fatto|complimenti)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Grazie mille! 😊", "Sono felice di aiutarti! 🌟", "Grazie, è un piacere! ❤️"];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return "";
  }

  // Frustrazione
  if (textRaw && /^(boh|mah|non lo so|che palle|mannaggia)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, 'Capisco che possa essere frustrante 😅\nSe hai dubbi, scrivi "aiuto" e ti guiderò passo passo!');
    return "";
  }

  // Presenza
  if (textRaw && /^(ci sei|ci sei\?|sei là|hello\?)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, "Sì, sono qui! 👋 Come posso aiutarti?");
    return "";
  }

  // Contatto diretto
  if (textRaw && /^(numero|telefono|chiamare|contatto diretto|parlare con qualcuno)[\s!.]*/i.test(textRaw.trim())) {
    await reply(client, chatId, '📞 Puoi chiamarci al numero: +393534043794\n\nOppure continua a chattare con me per prenotare! 😊');
    return "";
  }

  // Conferma generica
  if (textRaw && /^(okay|va bene|d'?accordo|perfetto|ok)[\s!.]*$/i.test(textRaw.trim())) {
    await reply(client, chatId, "Perfetto! Se hai bisogno di altro, sono qui 😊");
    return "";
  }

  // Aiuto
  if (textRaw && /^(aiuto|help|non capisco|cosa posso fare|come funziona)[\s!.]*/i.test(textRaw.trim())) {
    await reply(
      client,
      chatId,
      'Certo! Ecco cosa posso fare per te:\n\n' +
      '📅 Prenotazioni:\n' +
      '• Scrivi "prenota" per fissare un appuntamento\n' +
      '• Scrivi "modifica" per cambiare una prenotazione\n\n' +
      '📍 Informazioni:\n' +
      '• Chiedi l\'indirizzo o gli orari\n' +
      '• Chiedi info sui trattamenti\n\n' +
      'Come posso aiutarti? 😊'
    );
    return "";
  }

  // Saluti di chiusura
  if (textRaw && /^(arrivederci|a presto|ci vediamo|buona giornata|buona serata|addio|bye|goodbye|see you)[\s!.]*$/i.test(textRaw.trim())) {
    const responses = ["Ciao! A presto! 👋", "Arrivederci! 😊", "Buona giornata! 🌟", "A presto! 👋", "Ci vediamo! 😊"];
    await reply(client, chatId, responses[Math.floor(Math.random() * responses.length)]);
    return "";
  }

  // ============================================================================
  // SEZIONE 3: LOCK GESTIONE CONCORRENZA
  // ============================================================================
  while (__busyChats.has(chatId)) {
    const since = __busySince.get(chatId) || 0;
    if (since && Date.now() - since > BUSY_TTL_MS) {
      log("warn", "[BUSY-STALL] Force release", { chatId, since, ttl: BUSY_TTL_MS });
      __busyChats.delete(chatId);
      __busySince.delete(chatId);
      break;
    }
    await __delay(50);
  }

  __busyChats.add(chatId);
  __busySince.set(chatId, Date.now());

  try {
    // Inizializzazione client inactivity
    if (inactivityClient === null) {
      inactivityClient = client;
    }

    const text = String(textRaw ?? "").trim();
    const msg = text;
    const lower = text.toLowerCase();
    const t = norm(text);

    // Recupera e inizializza stato
    state = getState(chatId);
    state.collected ||= {};
    state.context ||= {};
    ensureContext(state);

    // Salva messaggio utente nella cronologia
    try {
      await appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "[APPEND] Failed to save user message", e?.message || e);
    }

    const pureNumber = /^\s*\d+\s*[\).]?\s*$/;
    const phone = typeof phoneFromChatId === "function" ? phoneFromChatId(chatId) : chatId;

    log("info", "[HANDLE] Message received", { chatId, text, step: state.step });

    // ============================================================================
    // SEZIONE 4: ROUTING EDIT FLOW
    // ============================================================================
    if (typeof state.step === "string" && state.step.startsWith("edit_")) {
      const isCancelMsg = /^(annulla|annula|cancel|stop|fine)\b/i.test(text);
      const isTextStep = state.step === "edit_reschedule_date" || state.step === "edit_change_name";

      if (!isCancelMsg && !isTextStep) {
        return await handleNumericReply(client, chatId, text, tools);
      }
    }

    // ============================================================================
    // SEZIONE 5: HELPER FUNCTIONS
    // ============================================================================

    /**
     * Trova il servizio migliore basandosi su sinonimi configurati
     */
    function bestServiceBySynonyms(raw) {
      try {
        const svcs = (typeof cfgServices === "function" ? cfgServices() : []) || [];
        if (!svcs.length) return null;

        const N = (s) =>
          (typeof norm === "function" ? norm(String(s || "")) : String(s || "").toLowerCase())
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();

        const msg = " " + N(raw) + " ";
        let best = null, bestScore = 0;

        for (const svc of svcs) {
          const syns = (
            typeof cfgServiceSynonyms === "function"
              ? cfgServiceSynonyms(svc) || []
              : (config?.services?.[svc]?.synonyms || [])
          ).slice();
          syns.unshift(svc);

          let svcBest = 0;
          for (const s of syns) {
            const cand = N(s);
            if (!cand || cand.length < 3) continue;

            const wrapped = " " + cand + " ";
            let score = 0;

            if (msg.includes(wrapped)) {
              score = 1.0 + Math.min(cand.length / 40, 0.25);
            } else {
              const toks = cand.split(" ").filter(Boolean);
              let hit = 0;
              for (const tk of toks) {
                if (tk.length < 3) continue;
                if (msg.includes(" " + tk + " ")) hit++;
              }
              const cover = hit / Math.max(1, toks.length);
              const twoGram = toks.some((_, i) =>
                i < toks.length - 1 && msg.includes(" " + toks[i] + " " + toks[i + 1] + " ")
              );
              const contBonus = twoGram ? 0.1 : 0;
              const lenBonus = Math.min(cand.length / 50, 0.15);
              score = Math.max(score, 0.65 * cover + contBonus + lenBonus);
            }

            if (/refill/.test(cand)) {
              const longHint = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(raw);
              const shortHint = /\b(cort|corte|corto)\w*\b/i.test(raw);
              if (longHint && /lungh/i.test(N(svc))) score += 0.12;
              if (shortHint && /cort/i.test(N(svc))) score += 0.12;
            }

            svcBest = Math.max(svcBest, score);
          }

          if (svcBest > bestScore) {
            bestScore = svcBest;
            best = svc;
          }
        }

        return bestScore >= 0.45 ? best : null;
      } catch {
        return null;
      }
    }

    /**
     * Parsing intake: estrae servizio, data, orario, professionista da un singolo messaggio
     */
    function parseIntake(raw) {
      if (!raw) return null;
      const out = {};

      // 1) Servizio
      try {
        out.service = bestServiceBySynonyms(raw) ||
          (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(raw) : null) ||
          undefined;
      } catch { }

      // 2) Data
      try {
        let d = (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(raw) : null) || null;
        if (d) {
          const at12 = typeof atNoon === "function" ? atNoon(d) : d;
          if (!(typeof isPast === "function" && isPast(at12))) out.when = at12;
        }
      } catch { }

      // 3) Orario
      try {
        const hhmm = (typeof parseTimeSmart === "function" ? parseTimeSmart(raw) : null) ||
          (typeof parseHHMM === "function" ? parseHHMM(raw) : null);
        if (hhmm) out.time = hhmm;
      } catch { }

      // 4) Professionista
      try {
        const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa)\b/i;
        if (anyRe.test(raw)) {
          out.professionalAny = true;
        } else {
          const list = (out.service && typeof proCatalog === "function" ? proCatalog(out.service) : null) ||
            Object.entries((config?.professionals || {})).map(([email, p]) => ({
              email,
              name: (p?.name) || email,
            }));

          const hit = typeof matchProFromFreeText === "function" ? matchProFromFreeText(raw, list) : null;
          if (hit) {
            out.professionalName = hit.name;
            out.professionalEmail = hit.email || null;
            out.professionalAny = false;
          }
        }
      } catch { }

      return Object.keys(out).length ? out : null;
    }

    /**
     * Fuzzy service matching sicuro (evita falsi positivi)
     */
    const fuzzyServiceSafe = (q) => {
      const hit = typeof fuzzyService === "function" ? fuzzyService(q) : null;
      if (!hit) return null;

      const tokens = (cfgServices() || [])
        .flatMap((s) => s.toLowerCase().split(/\W+/))
        .filter((x) => x && x.length >= 4);
      const nq = norm(q);
      const hasSvcToken = tokens.some((tok) => nq.includes(norm(tok)));

      const first = typeof cfgServices === "function" ? cfgServices()[0] || null : null;
      if (first && norm(hit) === norm(first) && !hasSvcToken) return null;

      return hit;
    };

    /**
     * Ottiene lista completa professionisti
     */
    const getAllProsList = () =>
      Object.entries(config?.professionals || {}).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));

    /**
     * Nome professionista da email
     */
    const proNameByEmailSafe = (email) =>
      (config?.professionals?.[email]?.name) ||
      (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
      email;

    /**
     * Email professionisti per un servizio
     */
    const serviceProsEmails = (svc) => {
      try {
        const item = (typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null) ||
          (config?.services?.[svc] || {});
        const arr = item.professionals || item.pros || [];
        return Array.isArray(arr) ? arr.filter(Boolean) : [];
      } catch {
        return [];
      }
    };

    /**
     * Verifica se un servizio è disponibile per un professionista
     */
    const isServiceAvailableForPro = (svc, proEmail) => {
      if (!proEmail) return true;

      let pros = (typeof cfgServiceProfessionals === "function" ? (cfgServiceProfessionals(svc) || []) : null) || null;
      if (!pros) pros = serviceProsEmails(svc);

      const emails = (Array.isArray(pros) ? pros : [])
        .map((x) => (typeof x === "string" ? x : (x?.email || x?.name || "")))
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());

      return emails.includes(String(proEmail).toLowerCase());
    };

    /**
     * Durata servizio per professionista specifico
     */
    const getDurForPro = (svc, proEmail) => {
      try {
        if (typeof getServiceDurationForPro === "function" && proEmail) {
          const d = getServiceDurationForPro(svc, proEmail);
          if (Number.isFinite(+d) && +d > 0) return +d;
        }
      } catch { }

      try {
        const item = config?.services?.[svc] || {};
        const pd = item.professionalDurations || {};
        const d2 = proEmail && pd[proEmail];
        if (Number.isFinite(+d2) && +d2 > 0) return +d2;
        const d = item.duration;
        if (Number.isFinite(+d) && +d > 0) return +d;
      } catch { }

      return (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(svc) || 30) : 30);
    };

    /**
     * Costruisce messaggio servizi disponibili per un professionista
     */
    const buildServicesMessageForPro = (proEmail) => {
      const allSvcs = (typeof cfgServices === "function" ? (cfgServices() || []) : []) ||
        Object.keys(config?.services || {});

      const available = allSvcs.filter((svc) => isServiceAvailableForPro(svc, proEmail));
      const unavailable = allSvcs.filter((svc) => !isServiceAvailableForPro(svc, proEmail));

      const availableLines = available.map((svc, i) => {
        const item = (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
          (config?.services?.[svc] || {});
        const emoji = item.emoji || item.icon || item.emoticon || "";
        const label = item.label || svc;
        const price = (typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "") ||
          (Number.isFinite(+item.price) ? `${item.price}€` : "");
        const dur = getDurForPro(svc, proEmail);
        const durTxt = formatDurationMin(dur) || `${dur} min`;
        const pricePart = price ? ` (_${price}_, _*${durTxt}*_)` : ` (_*${durTxt}*_)`;
        return `${i + 1}) ${emoji ? emoji + " " : ""}${label}${pricePart}`;
      });

      const unavailableLines = unavailable.map((svc) => {
        const emails = serviceProsEmails(svc);
        const names = emails.map(proNameByEmailSafe).filter(Boolean);
        const who = names.length ? names.join(", ") : "—";
        return `* ${svc} (disponibile con: ${who})`;
      });

      const proName = proEmail ? proNameByEmailSafe(proEmail) : "qualsiasi professionista";
      let msg = `🧖‍♀️ Trattamenti disponibili con *${proName}*:\n` +
        (availableLines.length ? availableLines.join("\n") : "⚠️ Nessun trattamento disponibile con questo professionista.");


      if (availableLines.length) msg += `\n(1-${availableLines.length})`;

      if (unavailableLines.length) {
        msg += `\n\n🚫 Non disponibili con *${proName}*:\n${unavailableLines.join("\n")}\n\n` +
          `ℹ️ Se vuoi uno dei trattamenti non disponibili: digita "annulla" e prenota di nuovo scegliendo un professionista che lo esegue.`;
      }

      return { available, msg };
    };

    // ============================================================================
    // SEZIONE 6: SHORT-CIRCUIT ROUTING
    // ============================================================================

    // Routing per numeri puri (elenchi numerati)
    if (pureNumber.test(msg)) {
      const col = state.collected || (state.collected = {});
      const hasOptions = Array.isArray(col.options) && col.options.length > 0;
      const waitingService = ["info_select_service", "price_select_service"].includes(state.step);
      const isChoosingService = !col.service && state.step === "choose_service";
      const awaitingDay = (state.availFlow && state.availFlow.awaiting === "day") || state.step === "choose_day";
      const isEditFlow = typeof state.step === "string" && state.step.startsWith("edit_");
      const inNumberedStep = ["pick_professional_for_time", "price_select_service"].includes(state.step);
      const isPickProfessional = state.step === "pick_professional";

      const shouldUseNumericHandler =
        !isChoosingService &&
        !isPickProfessional &&
        (awaitingDay || hasOptions || waitingService || inNumberedStep || isEditFlow);

      if (shouldUseNumericHandler) {
        return await handleNumericReply(client, chatId, text, tools);
      }
    }

    // Fast-path intake: parsing diretto da messaggio libero
    if (!pureNumber.test(text)) {
      const col = state.collected || (state.collected = {});
      if (!/^edit_/.test(state.step || "")) {
        const intake = parseIntake(t);
        if (intake) {
          if (intake.service) col.service = col.service || intake.service;
          if (intake.when) col.when = col.when || intake.when;
          if (intake.time) col.time = col.time || intake.time;
          if (intake.professionalAny) col.professionalAny = true;
          if (intake.professionalName) col.professionalName = intake.professionalName;
          if (intake.professionalEmail) col.professionalEmail = intake.professionalEmail;

          if (col.service && !state.step) {
            if (!col.professionalAny && !col.professionalName && !col.professionalEmail) {
              state.step = "pick_professional";
            } else {
              state.step = "choose_day";
            }
            pending.set(chatId, state);
          }
        }
      }
    }

    // ============================================================================
    // SEZIONE 7: CANCELLAZIONE GLOBALE
    // ============================================================================
    if (/^(annulla|annula|cancel|stop|fine|esci)\b/i.test(t)) {
      const st = pending.get(chatId);

      if (st && /^edit_/.test(st.step)) {
        pending.delete(chatId);
        try {
          releaseSoftHoldByChat(chatId);
        } catch { }
        await reply(client, chatId, "✅ Ho chiuso la gestione dell'appuntamento. Nessuna modifica applicata.");
        return "";
      }

      if (st) unlockBooking(st);
      pending.delete(chatId);

      try {
        releaseSoftHoldByChat(chatId);
      } catch { }

      const lang = getLang(chatId);
      if (lang === "en") {
        await reply(client, chatId, '✅ Operation canceled. If you want to start over, type "book" or "appointment".');
      } else {
        await reply(client, chatId, '✅ Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".');
      }
      return "";
    }

    // ============================================================================
    // SEZIONE 8: RISPOSTE INFO RAPIDE (indirizzo, orari)
    // ============================================================================
    if (!isInCriticalStep(state.step)) {
      const RE_ADDR = /(indirizz[oi]|dove\s+(siete|vi\s+trovate)|mappa|google\s*maps|come\s+raggiungerci|ubicazion[ei]|posizion[ei])/i;
      const RE_HOURS = /(orari?|apert[oi]|chius[oi]|quando\s+(siete|siamo)\s+aperti|fino\s+a\s+che\s+ora)/i;

      if (RE_ADDR.test(t)) {
        const addr = (config?.address || config?.addr || "Via Bosco, 44/a, 42019 Reggio Emilia RE").trim();
        await reply(client, chatId, addr ? `Ci trovi qui:\n${addr}\n` : `Siamo in Via Bosco, 44/a, 42019 Reggio Emilia RE.`);
        return "";
      }

      if (RE_HOURS.test(t)) {
        const hours = (config?.openingHours || config?.hours || "").trim();
        await reply(client, chatId, hours ? `Orari di apertura:\n${hours}` : `Orari tipici: Lun–Ven 9–19, Sab 9–13 (chiuso Dom).`);
        return "";
      }
    }

    // Guard: booking bloccato
    if (isBookingLocked(state) && !/^(annula|annulla|cancel|stop|fine|esci)\b/i.test(t)) {
      if (!isInCriticalStep(state.step) && state.step !== "collect") {
        await safeSend(
          client,
          chatId,
          '❌ Se non vuoi più prenotare, digita "annulla"\nHo sbagliato a capire qualche info? Non temere! puoi sempre modificare digitando "_annulla_" per ripartire *da capo!*',
          { noFooter: true }
        );
        return "";
      }
    }

    let col = state.collected || (state.collected = {});

    // ============================================================================
    // SEZIONE 9: PATCH INTERPRETAZIONE "N" COME "N:00"
    // ============================================================================
    if (Array.isArray(col?.options) && col.options.length) {
      const optionsLookLikeTimes = col.options.every(opt => {
        const t = typeof opt === "string" ? opt : opt?.time || "";
        return typeof t === "string" && (/^\s*\d{1,2}[:.]\d{2}\s*$/.test(t.trim()) || /^\s*\d{1,2}\s*$/.test(t.trim()));
      });

      if (optionsLookLikeTimes && pureNumber.test(msg)) {
        const hour = parseInt(String(msg).replace(/\D/g, ""), 10);

        if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
          await safeSend(client, chatId, "Orario non valido. Scrivi un orario nel formato 9 o 9:00 o 09:00.");
          return "";
        }

        const normalized = col.options.map((opt, i) => {
          const raw = typeof opt === "string" ? opt : (opt?.time || "");
          const clean = String(raw).trim().replace(".", ":");
          if (/^\d{1,2}$/.test(clean)) return { time: `${String(clean).padStart(2, "0")}:00`, idx: i };
          if (/^\d{1,2}:\d{2}$/.test(clean)) {
            const parts = clean.split(":");
            return { time: `${String(parts[0]).padStart(2, "0")}:${parts[1]}`, idx: i };
          }
          return { time: null, idx: i };
        }).filter(x => x.time);

        const match = normalized.find(x => {
          const [h, m] = x.time.split(":").map(Number);
          return h === hour && m === 0;
        });

        if (!match) {
          await safeSend(
            client,
            chatId,
            `Non ho trovato disponibilità esatta per ${String(hour).padStart(2, "0")}:00. Scrivi l'orario completo (es. "10:00") o scegli un altro orario disponibile.`
          );
          return "";
        }

        let item = col.options[match.idx];
        let time = match.time;
        col.time = time;
        col.selectedOptionIndex = match.idx;
        pending.set(chatId, state);

        if (typeof scheduleReenter === "function") {
          await scheduleReenter(client, chatId, `ok ${time}`, tools);
          return "";
        }
        return "";
      }
    }

    // ============================================================================
    // SEZIONE 10: COMANDI VELOCI MODIFICA
    // ============================================================================
    if (/^(modifica|cambia|sposta|spostare)\s+(data|giorno)\b/i.test(t) || /^\/data\b/i.test(t)) {
      await startEditDate(client, chatId);
      return "";
    }

    // Reset forzato se utente vuole nuova prenotazione durante edit
    if (state.step && state.step.startsWith("edit_")) {
      const newBookingIndicators = /\b(avresti\s+posto|prenotare|prenota|appuntamento|disponibilità)\b/i;

      if (newBookingIndicators.test(t) && !wantsEditMenu(t)) {
        log("info", "[RESET] Utente esce dal menu edit per nuova prenotazione", { chatId, text });
        pending.delete(chatId);

        try {
          releaseSoftHoldByChat(chatId);
        } catch { }

        state.step = "collect";
        state.collected = {};
        state.edit = null;
        pending.set(chatId, state);
      }
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(ora|orario)\b/i.test(t) || /^\/orario\b/i.test(t)) {
      await startEditTime(client, chatId);
      return "";
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(professionista|operatrice|operatore)\b/i.test(t) || /^\/pro(f)?\b/i.test(t)) {
      await startEditProfessional(client, chatId);
      return "";
    }

    if (/^(modifica|cambia|sposta|spostare)\s+(nome|intestazione)\b/i.test(t) || /^\/nome\b/i.test(t)) {
      await startEditName(client, chatId);
      return "";
    }

    if (/^\/?modifica\b/i.test(t) || wantsEditMenu(t)) {
      const phone = phoneFromChatId(chatId);
      const bookings = getUserActiveBookingsAll(phone);

      if (!bookings.length) {
        if (state) unlockBooking(state);
        pending.delete(chatId);
        await reply(client, chatId, "🤔 Non risulta alcuna prenotazione futura da modificare.");
        return "";
      }

      if (bookings.length === 1) {
        const booking = bookings[0];
        _editSnapshotStateFromBooking(state, booking);
        state.step = "edit_menu";
        state.edit = { target: booking };
        pending.set(chatId, state);
        await reply(client, chatId, showEditMenu(booking));
        return "";
      }

      await startEditChooseBooking(client, chatId, bookings, null);
      return "";
    }

    // ============================================================================
    // SEZIONE 11: EDIT FLOW - MODIFICA DATA
    // ============================================================================
    if (state.step === "edit_reschedule_date") {
      const booking = state.edit?.target;
      if (!booking) {
        pending.delete(chatId);
        await reply(client, chatId, 'Sessione scaduta. Scrivi "modifica" per ripartire.');
        return "";
      }

      let newDay = null;
      try {
        newDay = _editParseNewDate ? _editParseNewDate(msg) : parseUnifiedDate(msg);
      } catch (parseErr) {
        log('error', '[EDIT_DATE] Parsing fallito', { input: msg, err: parseErr?.message });
      }

      if (!newDay) {
        await reply(client, chatId, 'Non ho capito la data. Scrivi "oggi", "domani", "tra 7 giorni" oppure in formato GG/MM.');
        return "";
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dayNormalized = new Date(newDay);
      dayNormalized.setHours(0, 0, 0, 0);

      if (dayNormalized < today) {
        await reply(client, chatId, 'Quella data è già passata. Scrivi una data valida (es. "domani" o "12/12").');
        return "";
      }

      const duration = _editDuration ? _editDuration(booking) : null;
      const pro = booking.professionalEmail || null;

      try {
        releaseSoftHoldByChat(chatId);
      } catch (e) { }

      const rawSlots = await fetchSlots({
        service: booking.service,
        day: typeof atNoon === "function" ? atNoon(dayNormalized) : dayNormalized,
        duration,
        professional: pro,
        wantDetail: true,
      });

      const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawSlots) : rawSlots) || [];

      if (!slots.length) {
        const dateStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(dayNormalized)
          : (typeof fmtDate === "function" ? fmtDate(dayNormalized) : dayNormalized.toLocaleDateString());
        pending.set(chatId, state);
        await reply(client, chatId, `Non ci sono orari liberi per ${dateStr}. Prova un altro giorno.`);
        return "";
      }

      state.step = "edit_reschedule_time";
      state.edit = state.edit || {};
      state.edit.target = booking;
      state.edit.day = dayNormalized;
      state.collected = state.collected || {};
      state.collected.options = slots;
      pending.set(chatId, state);

      const dateStr = typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(dayNormalized)
        : (typeof fmtDate === "function" ? fmtDate(dayNormalized) : dayNormalized.toLocaleDateString());
      const lines = typeof renderSlotsList === "function" ? renderSlotsList(slots) : (slots || []).join("\n");

      await reply(
        client,
        chatId,
        `📅 Disponibilità per ${dateStr}:\n${lines}\n\n💬 Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14").\nSe vuoi cambiare ancora giorno, scrivi la nuova data. Digita "annulla" per uscire.`
      );
      return "";
    }

    // ============================================================================
    // SEZIONE 12: EDIT FLOW - MODIFICA NOME
    // ============================================================================
    if (state.step === "edit_change_name") {
      const booking = state.edit?.target;
      if (!booking) {
        pending.delete(chatId);
        await reply(client, chatId, 'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.');
        return "";
      }

      const newNameRaw = String(msg || "").trim();
      const newName = extractCustomerName(newNameRaw) || newNameRaw;

      if (!newName) {
        await reply(client, chatId, "Scrivi il nuovo nome e cognome per la prenotazione.");
        return "";
      }

      const ok = await _editApplyUpdate({ booking, newName });
      if (!ok) {
        await reply(client, chatId, "❌ Non sono riuscito ad aggiornare il nome. Riprova tra poco.");
        return "";
      }

      state.step = "edit_menu";
      let updated = booking;
      try {
        const all = getUserActiveBookingsAll(booking.clientPhone) || [];
        const match = all.find((b) => b.eventId === booking.eventId);
        if (match) updated = match;
      } catch { }

      state.edit = { target: updated };
      pending.set(chatId, state);

      await reply(client, chatId, `✅ Nome aggiornato.\n\n${showEditMenu(updated)}`);
      return "";
    }

    // ============================================================================
    // SEZIONE 13: STEP 1 - SCELTA PROFESSIONISTA
    // ============================================================================
    const inEditFlowGlobal = state.step && typeof state.step === "string" && state.step.startsWith("edit_");
    const needPro = (!col.professionalEmail && !col.professionalName && !col.professionalAny);
    const alreadyAskingPro = (state.step === "pick_professional");
    const isInitialState = !state.step || state.step === "collect" || state.step === "start";
    const awaitingName = !!(state?.context?.awaitingName);
    const hasService = !!(col?.service);

    if (!inEditFlowGlobal && needPro && !alreadyAskingPro && isInitialState && !awaitingName) {
      if (hasService) {
        ensureContext(state);
        state.context.preferredService = col.service;
        col.service = null;
      }

      state.step = "pick_professional";
      const pros = getAllProsList();

      if (!pros.length) {
        await reply(client, chatId, "⚠️ Nessun professionista configurato. Contatta il salone.");
        return "";
      }

      const list =
        `💅 Prima di tutto scegli *con chi vuoi effettuare il trattamento*:\n` +
        `0) Non mi interessa\n` +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
        `\n(0-${pros.length})`;

      pending.set(chatId, state);
      await reply(client, chatId, list);
      return "";
    }

    // Gestione risposta scelta professionista
    if (!inEditFlowGlobal && state.step === "pick_professional") {
      const pros = getAllProsList();
      const txt = String(text || "").trim();

      if (!pros.length) {
        await reply(client, chatId, "⚠️ Nessun professionista configurato. Contatta il salone.");
        state.step = "collect";
        pending.set(chatId, state);
        return "";
      }

      const preSvc = state?.context?.preferredService;
      const isAny = txt === "0" || /\b(non mi interessa|chiunque|qualsiasi|indifferente)\b/i.test(txt);

      // Opzione 0: Non mi interessa
      if (isAny) {
        col.professionalAny = true;
        col.professionalEmail = null;
        col.professionalName = null;
        col.proOptions = null;

        if (preSvc) {
          // Se l'utente ha scelto "Non mi interessa" e il servizio era già stato capito prima,
          // manteniamo la scelta "qualunque professionista" e lo assegniamo DOPO l'orario scelto.

          
col.service = preSvc;
          state.context.preferredService = null;
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
          return "";
        }

        const { available, msg: svcMsg } = buildServicesMessageForPro(null);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Numero 1..N
      if (pureNumber.test(txt)) {
        const idx = parseListIndex(txt, pros.length);

        // ✅ FIX CRITICO: idx è null se invalido, oppure numero 1..N
        if (idx == null || !Number.isFinite(idx)) {
          pending.set(chatId, state);
          await reply(client, chatId, `❌ Scelta non valida. Scrivi un numero tra 0 e ${pros.length}.`);
          return "";
        }

        // ✅ FIX CRITICO: converti da 1-based a 0-based
        const arrayIndex = idx - 1;

        // ✅ Verifica bounds
        if (arrayIndex < 0 || arrayIndex >= pros.length) {
          pending.set(chatId, state);
          await reply(client, chatId, `❌ Numero fuori range. Scrivi un numero tra 1 e ${pros.length}.`);
          return "";
        }

        const chosen = pros[arrayIndex];

        // ✅ Validazione oggetto
        if (!chosen || !chosen.name) {
          pending.set(chatId, state);
          await reply(client, chatId, `❌ Errore nel recupero del professionista. Riprova.`);
          return "";
        }

        col.professionalAny = false;
        col.professionalEmail = chosen.email || null;
        col.professionalName = chosen.name || chosen.email || null;
        col.proOptions = null;

        if (preSvc) {
          const ok = isServiceAvailableForPro(preSvc, col.professionalEmail);
          if (ok) {
            col.service = preSvc;
            state.context.preferredService = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
            return "";
          } else {
            state.context.preferredService = null;
            col.service = null;
            await reply(client, chatId, `⚠️ *${chosen.name}* non esegue *${preSvc}*.\nSeleziona un altro trattamento:`);
          }
        }

        const { available, msg: svcMsg } = buildServicesMessageForPro(col.professionalEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Match per nome/frase (es. "con la Diana ...")
      const choice = typeof resolveProReply === "function" ? resolveProReply(txt, pros) : null;
      const hit = (choice && choice.any) ? null : choice;

      if (hit) {
        col.professionalAny = false;
        col.professionalEmail = hit.email || null;
        col.professionalName = hit.name || hit.email || null;
        col.proOptions = null;

        if (preSvc) {
          const ok = isServiceAvailableForPro(preSvc, col.professionalEmail);
          if (ok) {
            col.service = preSvc;
            state.context.preferredService = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
            return "";
          } else {
            state.context.preferredService = null;
            col.service = null;
            await reply(client, chatId, `⚠️ *${hit.name}* non esegue *${preSvc}*.\nSeleziona un altro trattamento:`);
          }
        }

        const { available, msg: svcMsg } = buildServicesMessageForPro(col.professionalEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      pending.set(chatId, state);
      await reply(client, chatId, `Scrivi *0* oppure un numero da *1* a *${pros.length}* (oppure il nome del professionista).`);
      return "";
    }
    // ============================================================================
    // SEZIONE 14: STEP 2 - SCELTA SERVIZIO
    // ============================================================================
    const inEditFlow = state.step && typeof state.step === "string" && state.step.startsWith("edit_");

    if (!inEditFlow && !col.service) {
      const hasProfessional = col.professionalAny || col.professionalEmail || col.professionalName;

      if (!hasProfessional) {
        if (state.step !== "pick_professional") {
          state.step = "pick_professional";
          pending.set(chatId, state);
          const pros = getAllProsList();
          const list =
            `0) Non mi interessa \n` +
            pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
            `\n(0-${pros.length})`;
          await reply(client, chatId, `Prima scegli il professionista!\n${list}`);
        }
        return "";
      }

      // Se l'utente ha scelto "Non mi interessa", NON assegnare un pro ora
      let proEmail = null;
      if (!col.professionalAny) {
        proEmail = col.professionalEmail ||
          (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null);
        col.professionalEmail = proEmail;
      }

      const { available, msg: svcMsg } = buildServicesMessageForPro(proEmail);
      col.serviceOptions = Array.isArray(col.serviceOptions) && col.serviceOptions.length
        ? col.serviceOptions
        : available;

      const svcs = col.serviceOptions || [];

      if (!svcs.length) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      // Applica servizio preferito se disponibile
      if (state?.context?.preferredService) {
        const preSvcRaw = String(state.context.preferredService || "").trim();
        const guess =
          (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(preSvcRaw) : null) ||
          (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(preSvcRaw) : null) ||
          preSvcRaw;

        const found =
          svcs.find((s) => norm(s) === norm(guess)) ||
          svcs.find((s) => norm(s) === norm(preSvcRaw));

        if (found) {
          col.service = found;

          const wasAny = !!col.professionalAny;
          // Se l'utente ha scelto "Non mi interessa", NON assegnare qui: il pro verrà scelto DOPO l'orario.

          
   state.context.preferredService = null;
          state.step = "choose_day";
          pending.set(chatId, state);

          await reply(client, chatId, `✅ Trattamento selezionato: *${col.service}*.\nOra dimmi il giorno (es. "domani", "23/10").`);
          return "";
        }

        state.context.preferredService = null;
      }

      // Parsing servizio dall'input
      const pickFromFilteredByText = (raw) => {
        const input = String(raw || "").trim();
        if (!input) return null;

        if (pureNumber.test(input)) {
          const n = parseInt(input, 10);
          if (n >= 1 && n <= svcs.length) return svcs[n - 1];
          return "__INVALID_RANGE__";
        }

        const low = input.toLowerCase();
        let idx = svcs.map(s => String(s).toLowerCase()).indexOf(low);
        if (idx === -1) idx = svcs.findIndex(s => String(s).toLowerCase().startsWith(low));
        if (idx !== -1) return svcs[idx];

        let svcMatch = null;
        try {
          svcMatch = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(input) : null) ||
            (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(input) : null) || null;
        } catch { }

        if (svcMatch && svcs.some(s => norm(s) === norm(svcMatch))) return svcMatch;

        try {
          const all = (typeof cfgServices === "function" ? (cfgServices() || []) : []) || [];
          const exists = all.find(s => norm(s) === norm(svcMatch || input));
          if (exists && !isServiceAvailableForPro(exists, proEmail))
            return { __UNAVAILABLE__: true, svc: exists };
        } catch { }

        return null;
      };

      const picked = pickFromFilteredByText(msg);

      if (!picked) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      if (picked === "__INVALID_RANGE__") {
        await reply(client, chatId, `Numero non valido. Scegli un numero (1-${svcs.length}).`);
        return "";
      }

      if (typeof picked === "object" && picked.__UNAVAILABLE__) {
        const svc = picked.svc;
        const emails = serviceProsEmails(svc);
        const names = emails.map(proNameByEmailSafe).filter(Boolean);
        const who = names.length ? names.join(", ") : "—";
        await reply(
          client,
          chatId,
          `❌ *${svc}* non è disponibile con *${proNameByEmailSafe(proEmail)}*.\n` +
          `✅ Disponibile con: ${who}\n\n` +
          `👉 Scegli un altro trattamento tra quelli disponibili per *${proNameByEmailSafe(proEmail)}* (vedi lista sotto).`
        );
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg);
        return "";
      }

      col.service = picked;

      const wasAny = !!col.professionalAny;
      // Se l'utente ha scelto "Non mi interessa", NON assegnare qui: il pro verrà scelto DOPO l'orario.

      // Validazione compatibilità professionista-servizio solo se ha già un professionista specifico
      if (!wasAny) {
        try {
          if (col.professionalEmail && typeof validateProfessionalForService === "function") {
            const chk = validateProfessionalForService(col.service, col.professionalEmail);
            if (!chk.ok) {
              log('warn', '[SERVICE_PICK] Incompatibile', { service: col.service, pro: col.professionalEmail });
              state.step = "choose_service";
              pending.set(chatId, state);
              await reply(client, chatId, chk.reason + "\n\nScegli un altro trattamento.");
              return "";
            }
          }
        } catch (e) {
          log("error", "validate after service pick failed", e?.stack || e?.message || e);
        }
      }

      state.step = "choose_day";
      pending.set(chatId, state);
       const proLine = wasAny && col.professionalEmail
        ? `🔀 Ho scelto *${proNameByEmailSafe(col.professionalEmail)}* per il tuo appuntamento.\n`
        : "";

      await reply(client, chatId, `${proLine}Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
      return "";
    }

    // ============================================================================
    // SEZIONE 15: STEP 3 - SCELTA GIORNO
    // ============================================================================
    if (state.step !== "choose_service" && (!col.when || state.step === "choose_day")) {
      state.step = "choose_day";
      const userInput = String(msg || "").trim();

      if (__dateParsingLocks.has(chatId)) {
        log('warn', '[CHOOSE_DAY] Parsing già in corso, ignoro', { chatId });
        return "";
      }

      if (!userInput || userInput.length < 2) {
        await reply(client, chatId, `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
        return "";
      }

            // Parsing della data
      __dateParsingLocks.add(chatId);
      let parsedDate = null;

      try {
        parsedDate = safeParseDateWithLock(chatId, userInput);
      } finally {
        __dateParsingLocks.delete(chatId);
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) {
        await reply(client, chatId, `❌ Data non valida. Scrivi "domani", "lunedì", "23/10" o un formato simile.`);
        return "";
      }

      const day = typeof atNoon === "function" ? atNoon(parsedDate) : parsedDate;

      // Blocca date nel passato
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dayCheck = new Date(day);
      dayCheck.setHours(0, 0, 0, 0);

      if (dayCheck < today) {
        await reply(client, chatId, `⚠️ Quella data è già passata. Scegli una data futura (es. "domani" o "12/12").`);
        return "";
      }

      // Verifica giorno chiuso
      if (typeof cfgClosedDay === "function" && cfgClosedDay(day)) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(day)
          : day.toLocaleDateString();
        await reply(client, chatId, `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno.`);
        return "";
      }

      col.when = day;

      // Recupera slot disponibili
      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalAny ? null : col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day: day,
        duration,
        professional,
        wantDetail: true,
      });

      const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(day)
          : day.toLocaleDateString();

        col.when = null;
        state.step = "choose_day";
        await reply(client, chatId, `Nessuno slot disponibile per ${dayStr}. Prova un altro giorno.`);
        return "";
      }

      col.options = slots;
      state.step = "pick_time";

      const lineList = slots
        .map((s) => {
          const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");

      const dayStr = typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(day)
        : day.toLocaleDateString();

      await reply(
        client,
        chatId,
        `📅 Disponibilità per ${dayStr}:\n${lineList}\n\n💬 Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14")`
      );

      pending.set(chatId, state);
      return "";
    }

    const isEditStep = typeof state.step === "string" && state.step.startsWith("edit_");
    const editTextSteps = state.step === "edit_reschedule_date" || state.step === "edit_change_name";

    if (isEditStep && !editTextSteps) {
      return await handleNumericReply(client, chatId, text, tools);
    }

    // ============================================================================
    // SEZIONE 16: STEP 4 - SCELTA ORARIO
    // ============================================================================
    if (
      (!col.time || state.step === "pick_time") &&
      !(typeof state.step === "string" && state.step.startsWith("edit_"))
    ) {
      state.step = "pick_time";

      const renderSlotsList = () => {
        return (col.options || [])
          .map((slot) => {
            const prosNames = slot.pros && slot.pros.length ? ` (${slot.pros.map((p) => p.name).join(", ")})` : "";
            return `• ${slot.time}${prosNames}`;
          })
          .join("\n");
      };

      const hhmmToMin = (s) => {
        const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        return +m[1] * 60 + +m[2];
      };

      const cleanedForTime = String(msg || "").replace(/\b(verso|intorno|circa|per\s+le|alle)\b/gi, " ");
      const tryParseTime = () =>
        (typeof parseTimeSmart === "function" ? parseTimeSmart(cleanedForTime) : null) ||
        (typeof parseHHMM === "function" ? parseHHMM(cleanedForTime) : null);

      const resolveEmailByName = (nm) => {
        const tryMap = typeof proEmailByName === "function" ? proEmailByName(nm) : null;
        if (tryMap) return tryMap;

        const profEntry = Object.entries((config?.professionals || {})).find(([email, p]) => {
          const a = typeof simpleNorm === "function" ? simpleNorm(p?.name || "") : String(p?.name || "").toLowerCase();
          const b = typeof simpleNorm === "function" ? simpleNorm(nm) : String(nm || "").toLowerCase();
          return a === b;
        });
        return profEntry ? profEntry[0] : null;
      };

      const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa)\b/i;

      const extractProFromText = (raw, preferredList) => {
        try {
          const txtN = typeof simpleNorm === "function" ? simpleNorm(raw) : String(raw || "").toLowerCase();

          const scan = (arr) => {
            for (const p of arr) {
              const nm = typeof simpleNorm === "function" ? simpleNorm(p?.name || "") : String(p?.name || "").toLowerCase();
              if (!nm) continue;
              if ((" " + txtN + " ").includes(" " + nm + " ")) return p;
            }
            return null;
          };

          if (preferredList && preferredList.length) {
            const hit = scan(preferredList);
            if (hit) return hit;
          }

          const pros = (
            typeof cfgServiceProfessionals === "function"
              ? cfgServiceProfessionals(col.service) || []
              : []
          )
            .map((p) => (typeof p === "string" ? { name: p, email: p } : p))
            .filter((p) => p && p.name);

          return scan(pros);
        } catch {
          return null;
        }
      };

      // Carica slot se non ci sono
      if ((!col.options || !col.options.length) && col.when && col.service) {
        const professional = col.professionalAny ? null : (col.professionalEmail || null);
        const duration = (typeof getDurForPro === "function")
          ? getDurForPro(col.service, professional)
          : ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

        const list = await fetchSlots({
          service: col.service,
          day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
          duration,
          professional,
          wantDetail: true,
        });

        const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list) || [];
        col.options = Array.isArray(slots) ? slots : [];

        if (!col.options.length) {
          const dayStr = typeof fmtDateWithWeekdayIT === "function"
  ? fmtDateWithWeekdayIT(col.when)
  : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when?.toLocaleDateString?.() || "");
          col.when = null;
          state.step = "choose_day";
          await reply(
            client,
            chatId,
            `Non ci sono orari liberi per ${dayStr}. Dimmi un altro giorno (tipo "domani", "sabato", "5 novembre").`
          );
          pending.set(chatId, state);
          return "";
        }
      }

      // Gestione cambio giorno durante pick_time
      const rawMsg = String(msg || "");
      const daySwitchHint =
        /\b(oggi|domani|dopodomani|tra|fra|settimana|prossim|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2}|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;

      async function tryHandleDaySwitch(text) {
        const _daySwitchText = String(text || "");
        const _hasDayNumberCue = /\b(?:il|giorno|data|per\s+il)\s+\d{1,2}(?:\s*(?:°|º))?\b/i.test(_daySwitchText);
        if (!_hasDayNumberCue && !daySwitchHint.test(_daySwitchText)) return false;

        let parsedSwitch =
          (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, text) : null) ||
          (typeof parseNaturalDate === "function" ? parseNaturalDate(text) : null) ||
          null;

        // Supporto extra: frasi tipo "hai posto il 21" / "per il 22"
        if (!parsedSwitch) {
          const mDay = String(text || "").match(/\b(?:il|giorno|data|per\s+il)\s+(\d{1,2})(?:\s*(?:°|º))?\b/i);
          if (mDay) {
            const probe = `il ${mDay[1]}`;
            parsedSwitch =
              (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, probe) : null) ||
              (typeof parseNaturalDate === "function" ? parseNaturalDate(probe) : null) ||
              null;
          }
        }

        if (!parsedSwitch) return false;

        let newDay = parsedSwitch;
        if (!(newDay instanceof Date)) {
          try {
            newDay = new Date(parsedSwitch);
          } catch {
            newDay = null;
          }
        }
        if (!newDay || isNaN(newDay.getTime())) return false;

        const dayAtNoon =
          typeof atNoon === "function" ? atNoon(newDay) : new Date(newDay.getFullYear(), newDay.getMonth(), newDay.getDate(), 12, 0, 0, 0);

        if (typeof isPast === "function" && isPast(dayAtNoon)) {
          const formatted = typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(dayAtNoon)
            : (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `La data ${formatted} è nel passato. Scrivi un'altra data valida (es. "domani", "12/12").`);
          pending.set(chatId, state);
          return true;
        }

        if (typeof cfgClosedDay === "function" && cfgClosedDay(dayAtNoon)) {
          const dayStrClosed =
            typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(dayAtNoon)
              : (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `Il giorno ${dayStrClosed} siamo chiusi. Dimmi un altro giorno (es. "domani", "sabato", "12/12").`);
          pending.set(chatId, state);
          return true;
        }

        const professional = col.professionalAny ? null : (col.professionalEmail || null);
        const duration = (typeof getDurForPro === "function")
          ? getDurForPro(col.service, professional)
          : ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

        const rawList = await fetchSlots({
          service: col.service,
          day: typeof atNoon === "function" ? atNoon(dayAtNoon) : dayAtNoon,
          duration,
          professional,
          wantDetail: true,
        });

        const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

        if (!slots.length) {
          const dayStr =
            typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(dayAtNoon)
              : (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());
          await reply(client, chatId, `Non ci sono orari liberi per ${dayStr}. Dimmi un altro giorno (es. "domani", "sabato", "12/12").`);
          pending.set(chatId, state);
          return true;
        }

        col.when = dayAtNoon;
        col.options = Array.isArray(slots) ? slots : [];
        col.time = null;
        state.step = "pick_time";
        pending.set(chatId, state);

        const dayStr =
          typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(col.when)
            : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

        const lineList = col.options
          .map((s) => {
            const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
            return `• ${s.time}${prosNames}`;
          })
          .join("\n");

        await reply(
          client,
          chatId,
          `📅 Disponibilità per ${dayStr}:\n${lineList}\n\n💬 Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14")`
        );

        return true;
      }

      const handledDaySwitch = await tryHandleDaySwitch(rawMsg);
      if (handledDaySwitch) return "";

      // Parsing orario
      const tParsed = tryParseTime();

      if (!tParsed || !/^\d{2}:\d{2}$/.test(tParsed)) {
        log('warn', '[PICK_TIME] Orario non valido', { input: msg, parsed: tParsed });
        const dayLabel = typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString();
        const lines = renderSlotsList();

        await reply(
          client,
          chatId,
          `📅 Disponibilità per ${dayLabel}:\n${lines}\n\n💬 Scrivi un orario valido (es. "14:30", "alle 3", "15.00")\n\nSe vuoi cambiare giorno scrivi ad esempio "domani", "giovedì" o "12/12".`
        );
        pending.set(chatId, state);
        return "";
      }

      // Match esatto orario
      let chosenSlot = col.options.find((s) => s.time === tParsed);

      if (!chosenSlot) {
        const target = hhmmToMin(tParsed);
        if (target != null) {
          let best = null;
          let bestDiff = 1e9;
          for (const s of col.options) {
            const m = hhmmToMin(s.time);
            if (m == null) continue;
            const diff = Math.abs(m - target);
            if (diff < bestDiff) {
              best = s;
              bestDiff = diff;
            }
          }
          if (best && bestDiff <= 30) chosenSlot = best;
        }
      }

      if (!chosenSlot) {
        const dayLabel = typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString();
        const lines = renderSlotsList();

        await reply(client, chatId, `📅 Disponibilità per ${dayLabel}:\n${lines}\nScrivi un orario, per esempio "14:30".`);
        pending.set(chatId, state);
        return "";
      }

      col.time = chosenSlot.time;

      // Risoluzione professionista
      const ensureProFromSlot = async () => {
        if (chosenSlot.pros && chosenSlot.pros.length) {
          if (chosenSlot.pros.length === 1) {
            const only = chosenSlot.pros[0];
            col.professionalName = only.name;
            col.professionalEmail = only.email || resolveEmailByName(only.name) || null;
            col.professionalAny = false;
            return "one";
          }

          const pick = extractProFromText(msg, chosenSlot.pros);
          if (pick) {
            col.professionalName = pick.name;
            col.professionalEmail = pick.email || resolveEmailByName(pick.name) || null;
            col.professionalAny = false;
            return "one";
          }

          if (anyRe.test(msg)) {
            col.professionalAny = true;
            return "any";
          }

          col.proOptions = chosenSlot.pros.slice();
          state.step = "pick_professional_for_time";

          const prosList = chosenSlot.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");

          await reply(
            client,
            chatId,
            `Chi preferisci alle ${chosenSlot.time}?\n${prosList}\nRispondi con un numero (1-${chosenSlot.pros.length}).`
          );

          pending.set(chatId, state);
          return "ask";
        }

        const pick = extractProFromText(msg, []);
        if (pick) {
          col.professionalName = pick.name;
          col.professionalEmail = pick.email || resolveEmailByName(pick.name) || null;
          col.professionalAny = false;
          return "one";
        }

        if (anyRe.test(msg)) {
          col.professionalAny = true;
          return "any";
        }

        return "none";
      };

      const pickAutoProFromChosenSlot = async () => {
        const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
        if (!arr.length) return false;

        // Preferisci un pro davvero libero per QUESTO orario, considerando eventuale durata specifica per pro
        const dayForCheck = (typeof atNoon === "function" && col.when) ? atNoon(col.when) : col.when;
        for (const p0 of arr) {
          const email0 = p0?.email || resolveEmailByName(p0?.name) || null;
          if (!email0) continue;
          let dur0 = null;
          try {
            dur0 = (typeof getDurForPro === "function") ? getDurForPro(col.service, email0) : null;
          } catch { dur0 = null; }
          const duration0 = (Number.isFinite(+dur0) && +dur0 > 0)
            ? +dur0
            : ((typeof cfgServiceDuration === "function") ? (cfgServiceDuration(col.service) || 30) : 30);

          try {
            const times0 = await fetchSlots({
              service: col.service,
              day: dayForCheck,
              duration: duration0,
              professional: email0,
              wantDetail: false,
            });
            if (Array.isArray(times0) && times0.includes(chosenSlot.time)) {
              col.professionalName = p0?.name || proNameByEmail(email0) || email0;
              col.professionalEmail = email0;
              col.professionalAny = false;
              return true;
            }
          } catch {}
        }

        // Fallback: primo pro della lista
        const p = arr[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;
        col.professionalName = p?.name || (email ? (proNameByEmail(email) || email) : null) || null;
        col.professionalEmail = email;
        col.professionalAny = false;
        return !!email;
      };

      const pickRandomProFromChosenSlot = () => {
        const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
        if (!arr.length) return false;

        // Deterministico: ordina per email/nome e prende il primo
        const sorted = arr.slice().sort((a, b) => {
          const ka = String(a?.email || a?.name || "").toLowerCase();
          const kb = String(b?.email || b?.name || "").toLowerCase();
          if (ka < kb) return -1;
          if (ka > kb) return 1;
          return 0;
        });

        const p = sorted[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;

        col.professionalEmail = email;
        col.professionalName =
          p?.name ||
          (email ? (typeof proNameByEmail === "function" ? (proNameByEmail(email) || email) : email) : null) ||
          null;

        col.professionalAny = false;
        return !!email;
      };

      // Se l'utente ha già scelto "Non mi interessa", assegna automaticamente un pro tra quelli disponibili per quello slot
      if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
        await pickAutoProFromChosenSlot();
      }

      if (!col.professionalEmail && !col.professionalName) {
        const mode = await ensureProFromSlot();
        if (mode === "ask") return "";
        // Se nel messaggio l'utente ha risposto "chiunque/qualsiasi", ora assegna random
        if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
          await pickRandomProFromChosenSlot();
        }
      }

      // Safety: se è rimasto ANY e lo slot ha pro, assegna random
      if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
        await pickRandomProFromChosenSlot();
      }

      // Prosegui al prossimo step
      state.step = "collect_name";
      ensureContext(state);
      state.context.nameConfirmed = false; // il nome va sempre richiesto esplicitamente
      pending.set(chatId, state);
    }

    // ============================================================================
    // SEZIONE 17: STEP 5 - RACCOLTA NOME
    // ============================================================================
    if (state.step === "collect_name") {
      const col = state.collected || (state.collected = {});
      const raw = String(msg || "").trim();

      const newName = (typeof extractCustomerName === "function" ? extractCustomerName(raw) : raw) || raw;

      if (!newName || String(newName).trim().split(/\s+/).filter(Boolean).length < 2) {
        ensureContext(state);
        state.context.awaitingName = true;
        state.context.nameConfirmed = false;
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.',
          { noFooter: true }
        );
        return "";
      }

      col.customerName = String(newName).trim();
      ensureContext(state);
      if (state.context) {
        state.context.awaitingName = false;
        state.context.nameConfirmed = true;
      }
      pending.set(chatId, state);
    }

    // ============================================================================
    // SEZIONE 18: STEP 6 - CREAZIONE FINALE EVENTO
    // ============================================================================
    col = state.collected || (state.collected = {});

    // ✅ Validazioni finali (fondamentali per il "messaggio unico" / intake)
    // Se l'utente manda già data+ora+servizio (e magari anche professionista), può saltare choose_day/pick_time:
    // qui blocchiamo SEMPRE date chiuse/fuori range/orari non disponibili prima di chiedere il nome o creare l'evento.
    const __isEditFlowNow = typeof state.step === "string" && state.step.startsWith("edit_");
    if (!__isEditFlowNow) {
      // 1) Data valida + non chiusa + in range
      if (col.when) {
        const dayAtNoon = (typeof atNoon === "function"
          ? atNoon(col.when)
          : (col.when instanceof Date ? col.when : new Date(col.when)));

        if (!dayAtNoon || isNaN(dayAtNoon.getTime())) {
          col.when = null;
          col.time = null;
          col.options = null;
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, `❌ Data non valida. Dimmi un altro giorno (es. "domani", "23/10").`);
          return "";
        }

        // Range prenotazioni (default 120 giorni)
        try {
          const maxDays = 120;
          if (typeof validateDateInRange === "function" && !validateDateInRange(dayAtNoon, maxDays)) {
            const dayStr = typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(dayAtNoon)
              : (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `⚠️ La data ${dayStr} è troppo distante. Dimmi un altro giorno più vicino.`);
            return "";
          }
        } catch { }

        // Giorno chiuso (domenica/festivi/chiusure)
        try {
          if (typeof cfgClosedDay === "function" && cfgClosedDay(dayAtNoon)) {
            const dayStr = typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(dayAtNoon)
              : (typeof fmtDate === "function" ? fmtDate(dayAtNoon) : dayAtNoon.toLocaleDateString());

            const next = (typeof nextOpenDay === "function" ? nextOpenDay(dayAtNoon) : null);
            const nextStr = next
              ? (typeof formatDateWithWeekdayIT === "function"
                ? formatDateWithWeekdayIT(next)
                : (typeof fmtDate === "function" ? fmtDate(next) : next.toLocaleDateString()))
              : null;

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);

            await reply(
              client,
              chatId,
              nextStr
                ? `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno (es. "domani").\n👉 Prossimo giorno utile: ${nextStr}.`
                : `Il giorno ${dayStr} siamo chiusi. Dimmi un altro giorno (es. "domani").`
            );
            return "";
          }
        } catch { }

        // Normalizza sempre a mezzogiorno
        col.when = dayAtNoon;
      }

      // 2) Se ho già anche l'orario, verifico che sia effettivamente uno slot valido
      if (col.service && col.when && col.time) {
        const hasOptions = Array.isArray(col.options) && col.options.length > 0;
        const timeAlreadyInOptions = hasOptions && col.options.some((s) => s && s.time === col.time);

        if (!timeAlreadyInOptions) {
          const proEmailTmp = col.professionalAny
            ? null
            : col.professionalEmail ||
              (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) ||
              null;

          const durationTmp =
            (typeof getDurForPro === "function"
              ? getDurForPro(col.service, proEmailTmp)
              : (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

          let rawList = [];
          try {
            rawList = await fetchSlots({
              service: col.service,
              day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
              duration: durationTmp,
              professional: proEmailTmp, // null => qualsiasi pro
              wantDetail: true,
            });
          } catch (e) {
            log("error", "[FINAL_VALIDATE] fetchSlots failed", e?.stack || e?.message || e);
            rawList = [];
          }

          const slots =
            (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

          if (!slots.length) {
            const dayStr = typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(col.when)
              : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

            col.when = null;
            col.time = null;
            col.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(client, chatId, `Non ci sono disponibilità per ${dayStr}. Dimmi un altro giorno.`);
            return "";
          }

          const chosen = slots.find((s) => s && s.time === col.time) || null;

          // Se l'orario richiesto non esiste, proponi lista
          if (!chosen) {
            col.options = slots;
            col.time = null;
            state.step = "pick_time";
            pending.set(chatId, state);

            const dayStr = typeof formatDateWithWeekdayIT === "function"
              ? formatDateWithWeekdayIT(col.when)
              : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

            const lines = slots
              .map((s) => {
                const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
                return `• ${s.time}${prosNames}`;
              })
              .join("\n");

            await reply(
              client,
              chatId,
              `A quell'orario non abbiamo disponibilità per ${dayStr}. Questi sono gli orari liberi:\n${lines}\n\n💬 Scrivi l'orario desiderato (es. "14:30").`
            );
            return "";
          }

          // Se era ANY e lo slot ha 1 pro, assegnalo; se più pro, chiedi
          if (col.professionalAny && !col.professionalEmail && !col.professionalName) {
            if (Array.isArray(chosen.pros) && chosen.pros.length === 1) {
              const only = chosen.pros[0];
              col.professionalName = only.name || null;
              col.professionalEmail =
                only.email ||
                (typeof proEmailByName === "function" ? proEmailByName(only.name) : null) ||
                null;
              col.professionalAny = false;
            } else if (Array.isArray(chosen.pros) && chosen.pros.length > 1) {
              col.proOptions = chosen.pros.slice();
              state.step = "pick_professional_for_time";
              pending.set(chatId, state);
              const list = chosen.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
              await reply(
                client,
                chatId,
                `Chi preferisci alle ${col.time}?\n${list}\nRispondi con un numero (1-${chosen.pros.length}).`
              );
              return "";
            }
          }

          col.options = slots;
        }
      }
    }

    // Validazione finale nome (va sempre richiesto esplicitamente nel flow)
    const nameValid =
      !!state.context?.nameConfirmed &&
      col.customerName &&
      String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

    if (!nameValid) {
      const nameAttemptStart = state.context?.nameAttemptStart || 0;
      if (nameAttemptStart && (Date.now() - nameAttemptStart > 30000)) {
        log('warn', '[NAME] Timeout raccolta nome, uso fallback', { chatId });
        col.customerName = col.customerName || 'Cliente';
      } else {
        state.step = "collect_name";
        ensureContext(state);
        state.context.awaitingName = true;
        state.context.nameConfirmed = false;
        state.context.nameAttemptStart = state.context.nameAttemptStart || Date.now();
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.',
          { noFooter: true }
        );
        return "";
      }
    }

    const attendeeName = String(col.customerName).trim();

    // Se siamo in edit flow, mostra menu
    if (typeof state.step === "string" && state.step.startsWith("edit_")) {
      const booking = state.edit?.target;
      if (booking) {
        await reply(client, chatId, showEditMenu(booking));
      } else {
        await reply(client, chatId, 'Sei nella modifica dell\'appuntamento. Scegli un\'opzione dal menu oppure scrivi \"annulla\".');
      }
      return "";
    }

    // Verifica che abbiamo tutti i dati necessari
    if (!col.service || !col.when || !col.time) {
      if (!col.service) {
        const hasPro = !!(col.professionalAny || col.professionalEmail || col.professionalName);

        if (!hasPro) {
          state.step = "pick_professional";
          const pros = getAllProsList();

          if (!pros.length) {
            await reply(client, chatId, "⚠️ Nessun professionista configurato. Contatta il salone.");
            pending.set(chatId, state);
            return "";
          }

          const list =
            `👩‍🔧 Prima scegli il professionista:\n` +
            `0) Non mi interessa\n` +
            pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
            `\n(0-${pros.length})`;

          await reply(client, chatId, list);
          pending.set(chatId, state);
          return "";
        }

        state.step = "choose_service";
        const proEmail =
          col.professionalAny
            ? null
            : col.professionalEmail || (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null);

        const { msg: svcMsg } = buildServicesMessageForPro(proEmail);
        await reply(client, chatId, svcMsg);
        pending.set(chatId, state);
        return "";
      } else if (!col.when) {
        state.step = "choose_day";
        await reply(client, chatId, `Che giorno preferisci? (es. "domani", "23/10")`);
        pending.set(chatId, state);
        return "";
      } else {
        state.step = "pick_time";
        if (col.options && col.options.length) {
          const lines = col.options
            .map((s) => {
              const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
              return `• ${s.time}${prosNames}`;
            })
            .join("\n");
          const dayStr = typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(col.when)
            : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());
          await reply(client, chatId, `📅 Disponibilità per ${dayStr}:\n${lines}\n\n💬 Scrivi l'orario desiderato`);
        } else {
          state.step = "choose_day";
          await reply(client, chatId, `Che giorno preferisci? (es. "domani", "23/10")`);
        }
        pending.set(chatId, state);
        return "";
      }
    }

    // Crea timestamp finale
    const start = typeof setTime === "function" ? setTime(col.when, col.time) : new Date(+col.when);

    // Verifica che non sia nel passato
    if (typeof isPast === "function" && isPast(start)) {
      const oldDateStr = typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString();
      col.time = null;
      state.step = "pick_time";

      // Verifica professionista per l'orario scelto
      if (!col.professionalAny && !col.professionalEmail && !col.professionalName) {
        const chosenSlot = (col.options || []).find((s) => s && s.time === col.time);
        if (chosenSlot && Array.isArray(chosenSlot.pros) && chosenSlot.pros.length) {
          if (chosenSlot.pros.length === 1) {
            const only = chosenSlot.pros[0];
            col.professionalName =
              only.name || (typeof proNameByEmail === "function" ? proNameByEmail(only.email) : null) || null;
            col.professionalEmail =
              only.email || (typeof proEmailByName === "function" ? proEmailByName(only.name) : null) || null;
            col.professionalAny = false;
          } else {
            col.proOptions = chosenSlot.pros.slice();
            state.step = "pick_professional_for_time";
            const list = chosenSlot.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
            await reply(
              client,
              chatId,
              `Chi preferisci alle ${col.time}?\n${list}\nRispondi con un numero (1-${chosenSlot.pros.length}).`
            );
            pending.set(chatId, state);
            return "";
          }
        }
      }

      const professional = col.professionalAny ? null : (col.professionalEmail || null);
      const duration = (typeof getDurForPro === "function")
        ? getDurForPro(col.service, professional)
        : ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

      const list = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      const slots = typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list;

      if (!slots || !slots.length) {
        col.when = null;
        state.step = "choose_day";
        await reply(
          client,
          chatId,
          `L'orario selezionato è passato e non ci sono altri orari disponibili per ${oldDateStr}. Scegli un altro giorno.`
        );
        pending.set(chatId, state);
        return "";
      }

      col.options = slots;
      const lines = slots
        .map((s) => {
          const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");
      await reply(client, chatId, `L'orario scelto è nel passato. Disponibili invece:\n${lines}`);
      pending.set(chatId, state);
      return "";
    }

        // Assicurati di avere un professionista definitivo (anche se l'utente ha scelto "non mi interessa")
    let proEmail = col.professionalEmail ||
      (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) || null;

    if (!proEmail && col.professionalAny) {
      const chosenSlot = (col.options || []).find((s) => s && s.time === col.time);
      const arr = (chosenSlot && Array.isArray(chosenSlot.pros)) ? chosenSlot.pros.filter(Boolean) : [];
      if (arr.length) {
        const p = arr[0];
        const email = p?.email || resolveEmailByName(p?.name) || null;
        if (email) {
          proEmail = email;
          col.professionalEmail = email;
          col.professionalName = p?.name || (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) || email;
          col.professionalAny = false;
        }
      }
    }

    if (!proEmail) {
      await reply(client, chatId, "❌ Non riesco a determinare un professionista per quell'orario. Scegli un altro orario o un altro giorno.");
      col.time = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return "";
    }

    const durationMin = (proEmail && col.service)
      ? (typeof getServiceDurationForPro === "function" ? (getServiceDurationForPro(col.service, proEmail) || 30) : 30)
      : (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30);



    // Validazione finale professionista-servizio
    if (col.service && !col.professionalAny) {
      try {
        if (typeof validateProfessionalForService === "function") {
          const chkFinal = validateProfessionalForService(col.service, proEmail);
          if (!chkFinal.ok) {
            state.step = "choose_service";
            pending.set(chatId, state);
            await reply(client, chatId, chkFinal.reason + "\n\nScegli un altro trattamento.");
            return "";
          }
        }
      } catch (e) {
        log("error", "validateProfessionalForService(final) failed", e?.stack || e?.message || e);
        await reply(client, chatId, "Errore tecnico durante la validazione del trattamento. Riprova tra poco o contatta il salone.");
        return "";
      }
    }

    // Acquisisci hold con validazione
    let holdOk = false;
    try {
      if (typeof acquireSoftHold === "function") {
        if (!start || isNaN(start.getTime())) {
          throw new Error('Start time non valido per hold');
        }

        holdOk = acquireSoftHold({
          chatId,
          professionalEmail: proEmail || (col.professionalAny ? "" : ""),
          startTime: start,
          durationMin,
        });
      } else {
        holdOk = true;
      }
    } catch (err) {
      log('error', '[HOLD] Acquisizione fallita', { chatId, err: err?.message });
      holdOk = false;
    }

    if (!holdOk) {
      // Slot occupato: aggiorna lista
      const professional = proEmail || null;
      const list = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration: durationMin,
        professional,
        wantDetail: true,
      });

      const slots = typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(list) : list;

      if (!slots || !slots.length) {
        await reply(client, chatId, "Quel posto è appena stato occupato. Non ho più disponibilità per quel giorno.");
        col.when = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        return "";
      }

      col.options = slots;
      state.step = "pick_time";
      const lines = slots
        .map((s) => {
          const prosNames = s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");
      await reply(client, chatId, `Quel posto è appena stato occupato 😕. Disponibili invece:\n${lines}`);
      pending.set(chatId, state);
      return "";
    }

    // Verifica dati obbligatori
    if (!col.service || !start || !durationMin || !phone) {
      await reply(client, chatId, "Errore: alcuni dati obbligatori per la prenotazione non sono disponibili. Riprova dall'inizio digitando 'annulla'.");
      pending.delete(chatId);
      return "";
    }

    // Verifica professionista
    if (!col.professionalEmail && !col.professionalName && !col.professionalAny) {
      const slot = (col.options || []).find((s) => s && s.time === col.time);
      const pros = (slot?.pros) || (state?.proOptions) || (typeof cfgServiceProfessionals === "function" ? cfgServiceProfessionals(col.service) : []) || [];

      if (Array.isArray(pros) && pros.length > 0) {
        state.step = "pick_professional_for_time";
        col.proOptions = pros;
        pending.set(chatId, state);

        let list = "Scegli il professionista desiderato:\n";
        pros.forEach((p, i) => {
          const raw =
            (p && typeof p === "object"
              ? (p.name || p.displayName || p.email || p.mail || "")
              : (typeof p === "string" ? p : "")
            );

          const pName = String(raw || "").includes("@")
            ? ((typeof proNameByEmail === "function" ? proNameByEmail(raw) : "") || "Professionista")
            : (raw || "Professionista");

          list += `${i + 1}) ${pName}\n`;
        });
        list += "\n0) Qualsiasi professionista (assegniamo il primo disponibile)\n\nRispondi con il numero corrispondente.";

        await reply(client, chatId, list);
        return "";
      }
    }

    if (!proEmail && !col.professionalAny) {
      await reply(client, chatId, "⚠️ Nessun professionista selezionato o disponibile per l'orario scelto. Riprova.");
      col.time = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return "";
    }

    // Conferma finale (opzionale)
    if (process.env.REQUIRE_FINAL_CONFIRM === "1" && state.step !== "confirm_final") {
      state.step = "confirm_final";
      pending.set(chatId, state);
      const hh = String(start.getHours()).padStart(2, "0");
      const mi = String(start.getMinutes()).padStart(2, "0");
      const proLine = col.professionalName ? ` con ${col.professionalName}` : "";
      const dateStr = formatDateWithWeekdayIT(start);
      const timeStr = `${hh}:${mi}`;
      await reply(client, chatId, `Confermi ${col.service}${proLine} ${dateStr} alle ${timeStr}?`);
      return "";
    }

    if (state.step === "confirm_final") {
      if (!/\b(si|sì|yes|ok)\b/i.test(msg)) {
        await reply(client, chatId, 'Ok, annullato. Scrivi "prenota" per ricominciare.');
        pending.delete(chatId);
        try {
          releaseSoftHoldByChat?.(chatId);
        } catch { }
        return "";
      }
    }

    // Creazione evento con rollback
    let ev = null;
    let eventCreated = false;

    try {
      ev = await makeEvent({
        serviceName: col.service,
        professionalEmail: proEmail,
        professionalName: col.professionalName || undefined,
        clientPhone: phone,
        customerName: col.customerName || undefined,
        startTime: start,
        durationMin,
        notes: col.notes || undefined,
        price: typeof cfgServicePriceText === "function" ? cfgServicePriceText(col.service) : undefined,
      });

      eventCreated = true;

      const bookingRecord = {
        eventId: ev?.id || ev?.eventId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        service: col.service,
        professionalName: col.professionalName || null,
        professionalEmail: proEmail || null,
        clientPhone: phone,
        clientChatId: chatId,
        customerName: col.customerName || null,
        startTime: start instanceof Date ? start.toISOString() : new Date(start).toISOString(),
        durationMin,
        status: "confirmed",
        createdAt: new Date().toISOString(),
      };

      // Implementare saveBooking se necessario
    await saveBookings(bookingRecord);
      const okSaved = persistBooking(bookingRecord);
      if (!okSaved) {
        throw new Error("Salvataggio su bookings.json fallito");
      }

    } catch (bookingErr) {
      log('error', '[BOOKING] Persistenza fallita', { chatId, err: bookingErr?.message });

      // Rollback: cancella evento se booking non salvato
      if (eventCreated && ev?.id) {
        try {
          await cancelEventSafe(ev.id);
          log('info', '[BOOKING] Evento rollback OK', { eventId: ev.id });
        } catch (rollbackErr) {
          log('error', '[BOOKING] Rollback fallito', { eventId: ev.id, err: rollbackErr?.message });
        }
      }

      await reply(client, chatId, "❌ Errore durante il salvataggio. Riprova o contatta il salone.");
      return "";
    }

    // Cleanup finale
    try {
      releaseSoftHoldByChat?.(chatId);
    } catch (cleanupErr) {
      log('warn', '[CLEANUP] Hold release fallito', { chatId, err: cleanupErr?.message });
    }

    pending.delete(chatId);
    __dateParsingLocks.delete(chatId);

    // Messaggio di conferma
    const hh = String(start.getHours()).padStart(2, "0");
    const mi = String(start.getMinutes()).padStart(2, "0");
    const proLine = col.professionalName ? ` con ${col.professionalName}` : "";

    await reply(client, chatId, `✅ Prenotato: ${col.service}${proLine} ${formatDateWithWeekdayIT(start)} alle ${hh}:${mi}.`);
    await reply(client, chatId, '💡 Puoi scrivere "modifica" o "cambiare" per modificare un appuntamento.');

    return "";

  } catch (e) {
    log("error", "handleMessage critical error", e?.stack || e?.message || String(e));

    // Cleanup forzato su errore critico
    try {
      pending.delete(chatId);
      __dateParsingLocks.delete(chatId);
      releaseSoftHoldByChat?.(chatId);
    } catch (cleanupErr) {
      log('warn', '[CLEANUP] Errore durante cleanup critico', { err: cleanupErr?.message });
    }

    try {
      await reply(client, chatId, "😵‍💫 Errore tecnico. Scrivi 'annulla' e riprova, o contatta il salone.");
    } catch (sendErr) {
      log("warn", "Invio messaggio errore fallito", sendErr?.message);
    }

    return "";

  } finally {
    __busyChats.delete(chatId);
    __busySince.delete(chatId);
  }
}
// Helper robusto per scelte numeriche "1", "1)", "1.", con invisibili ecc.
// allowZero=true permette "0" (es. nessuna preferenza pro).

// ============== Gestione risposte numeriche (liste) ==============
/**
 * The `handleNumericReply` function handles various scenarios related to selecting services, choosing
 * professionals, and scheduling appointments, with added patches for specific flows like picking
 * professionals for a specific time slot.
 * @param client - The `client` parameter is the client object that represents the connection to the
 * messaging platform or API. It is used to send messages or perform actions related to the messaging
 * platform, such as sending replies to the user.
 * @param chatId - The `handleNumericReply` function is quite extensive and handles various scenarios
 * related to processing numeric replies in a chat conversation. Here is a breakdown of the main
 * functionalities it provides:
 * @param textRaw - The `handleNumericReply` function is quite extensive and seems to handle various
 * scenarios related to processing numeric replies in a chat application. It includes logic for
 * selecting services, choosing professionals, managing availability, and handling different steps in
 * the conversation flow.
 * @param [tools] - The `tools` parameter in the `handleNumericReply` function is an object that
 * contains various tools or utilities that can be used within the function. These tools are typically
 * helper functions or services that can assist in performing specific tasks or operations within the
 * function.
 * @returns The function `handleNumericReply` returns a message or an empty string based on the logic
 * and conditions within the function. The return value could be a message to be sent to the user, such
 * as availability information, error messages, prompts for user input, or confirmation messages. If
 * certain conditions are met, the function may also trigger other actions or functions in the chat
 * flow.
 */
export async function handleNumericReply(client, chatId, textRaw, tools = {}) {
  // === corpo di handleNumericReply (versione patchata) ===
  const msg = (textRaw || "").trim();
  const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "2", "2)", "2."
  const t = typeof norm === "function" ? norm(msg) : msg.toLowerCase();
  let n = NaN;
  const sRaw = String(msg || "");
  const sNorm = typeof norm === "function" ? norm(sRaw) : sRaw.toLowerCase().trim();
  const s = pending.get(chatId);
  if (!s) return safeSend(client, chatId, "Nessuna scelta in corso.");

  const state = s;
  const col = state.collected || (state.collected = {});
  const setAndPersist = () => pending.set(chatId, state);
  // --- INIZIO PATCH: gestione pick_professional_for_time ---
  if (state.step === "pick_professional_for_time") {
    const pros =
      Array.isArray(col.proOptions) && col.proOptions.length
        ? col.proOptions.slice()
        : Array.isArray(state.proOptions) && state.proOptions.length
          ? state.proOptions.slice()
          : [];

    if (!pros.length) {
      state.step = "collect";
      pending.set(chatId, state);
      return safeSend(client, chatId, "Ops, non riesco a trovare i professionisti disponibili. Riprova.");
    }

    // Parsing numero
    if (pureNumber.test(msg)) {
      const idx = parseListIndex(msg, pros.length);
      if (!Number.isFinite(idx) || idx < 1 || idx > pros.length) {
        return safeSend(client, chatId, `Scegli un numero valido (1-${pros.length}).`);
      }
      const chosen = pros[idx - 1];
      col.professionalName = chosen && chosen.name ? chosen.name : null;
      col.professionalEmail = chosen && chosen.email ? chosen.email : null;
      col.professionalAny = false;
      col.proOptions = null;

      // ✅ FIX: Passa a "collect" e re-entra
      state.step = "collect";
      pending.set(chatId, state);

      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok professionista", tools);
        return "";
      }
      return ""; // evita recursion in-handleMessage

    }

    // Parsing testo (nome professionista)
    const choice =
      typeof resolveProReply === "function" ? resolveProReply(msg, pros) : null;
    if (choice) {
      if (choice.any) {
        col.professionalAny = true;
        col.professionalName = null;
        col.professionalEmail = null;
      } else {
        col.professionalName = choice.name || null;
        col.professionalEmail = choice.email || null;
        col.professionalAny = false;
      }
      col.proOptions = null;

      // ✅ FIX: Passa a "collect" per permettere al flusso normale di gestire il prossimo step
      state.step = "collect";
      pending.set(chatId, state);

      // ✅ Re-entra nel flusso per processare il giorno (se già presente) o chiederlo
      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok professionista", tools);
        return "";
      }
      return ""; // evita recursion in-handleMessage
    }

    // Risposta non valida
    return safeSend(
      client,
      chatId,
      `Risposta non valida. Rispondi con il numero (1-${pros.length}) oppure scrivi il nome del professionista.`
    );
  }
  // --- FINE PATCH ---

  // ==== AVAILABILITY FLOW: scelta giorno con numero secco ====
  if (state.availFlow && state.availFlow.awaiting === "day") {
    const totalDays =
      (state.availFlow.mode === "week" &&
        (state.availFlow.days || []).length) ||
      (state.availFlow.mode === "month"
        ? daysInMonth(state.availFlow.year, state.availFlow.monthIdx)
        : 31);
    const dayNum = parseListIndex(msg, totalDays);
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
  if (state.step === "choose_service" && pureNumber.test(String(msg || "").trim())) {
    const n = parseListIndex(
      msg,
      Array.isArray(state.ui && state.ui.lastServiceList)
        ? state.ui.lastServiceList.length
        : Array.isArray(col.svcOptions)
          ? col.svcOptions.length
          : Array.isArray(col.serviceOptions)
            ? col.serviceOptions.length
            : state.options && Array.isArray(state.options.services)
              ? state.options.services.length
              : Array.isArray(config?.services)
                ? config.services.length
                : 0
    );

    const candidates = [
      state.ui && Array.isArray(state.ui.lastServiceList)
        ? state.ui.lastServiceList
        : null,
      Array.isArray(col.svcOptions) ? col.svcOptions : null, // <— aggiunto (tuo nome)
      Array.isArray(col.serviceOptions) ? col.serviceOptions : null, // <— legacy
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

    // ✅ Controllo compatibilità professionista ↔ servizio
    const check = validateProfessionalForService(col.service, col.professionalEmail);
    if (!check.ok) {
      await reply(client, chatId, check.reason);
      state.step = "choose_service";
      pending.set(chatId, state);
      return "";
    }

    state.step = "choose_day";
    pending.set(chatId, state);

    await reply(
      client,
      chatId,
      `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`
    );
    return "";
  }
  // ==== MENU DI MODIFICA (prenotazione esistente) ====
  // ==== Scelta prenotazione da modificare (quando ce ne sono più di una) ====
  if (state.step === "edit_pick_booking") {
    const list = (state.edit && state.edit.list) || [];
    if (!list.length) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.'
      );
    }

    const n = parseListIndex(msg, list.length);
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      return reply(
        client,
        chatId,
        `Scegli un numero valido (1-${list.length}).`
      );
    }

    const chosen = list[n - 1];
    _editSnapshotStateFromBooking(state, chosen);
    const nextStep = state.edit && state.edit.nextStep;

    // Se il comando rapido voleva una modifica specifica (data)
    if (nextStep === "edit_reschedule_date") {
      state.step = "edit_reschedule_date";
      state.edit = { target: chosen };
      state.collected = state.collected || {};
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Vuoi cambiare la data di:\n${_fmtBookingLine(
          chosen
        )}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
      );
    }

    // Se il comando rapido voleva cambiare solo l'orario
    if (nextStep === "edit_reschedule_time") {
      const day = _editDayFromBooking(chosen);
      const duration = _editDuration(chosen);
      const pro = chosen.professionalEmail || null;

      try {
        releaseSoftHoldByChat(chatId);
      } catch { }

      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: chosen.service,
          day,
          duration,
          professional: pro,
          wantDetail: true,
        })
      );

      if (!slots.length) {
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDateWithWeekdayIT(
            day
          )} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
        );
      }

      const col = state.collected || (state.collected = {});
      col.options = slots;

      state.step = "edit_reschedule_time";
      state.edit = { target: chosen, day };
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(
          day
        )} (tengo il professionista attuale):\n${renderSlotsList(slots)}\n(1-${slots.length
        })`
      );
    }

    // Se il comando rapido voleva cambiare solo il professionista
    if (nextStep === "edit_pick_professional") {
      const pros = (cfgServiceProfessionals(chosen.service) || []).filter(
        (x) => x && x.name
      );

      if (!pros.length) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "Non ho professionisti associati a questo servizio."
        );
      }

      state.step = "edit_pick_professional";
      state.edit = { target: chosen, proOptions: pros };
      pending.set(chatId, state);

      const listPros =
        "0) Indietro (tieni quello attuale)\n" +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli il professionista:\n${listPros}\n(0-${pros.length})`
      );
    }

    // Se il comando rapido voleva cambiare il nome
    if (nextStep === "edit_change_name") {
      state.step = "edit_change_name";
      state.edit = { target: chosen };
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Scrivi il nuovo nome e cognome per la prenotazione."
      );
    }

    // Default: apre il menu generico di modifica
    state.step = "edit_menu";
    state.edit = { target: chosen };
    pending.set(chatId, state);
    return reply(client, chatId, showEditMenu(chosen));
  }

  // ==== Gestione del MENU DI MODIFICA vero e proprio ====
  if (state.step === "edit_menu") {
    // Accetta sia numeri che testo (es. "nome", "orario", "data", "professionista", "annulla")
    const sRaw = String(msg || "");
    const sNorm =
      typeof norm === "function" ? norm(sRaw) : sRaw.toLowerCase().trim();
    let n = parseInt(sNorm, 10);

    // Mappa testo -> opzione
    // 0 = annulla prenotazione
    // 1 = cambia data
    // 2 = cambia orario
    // 3 = cambia professionista
    // 4 = cambia nome
    const map = [
      [0, /\b(annull|cancell|disd)(a|o|i|e)?\w*\b/],
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
    if (!booking) {
      return reply(
        client,
        chatId,
        "Ops, non trovo la prenotazione da gestire."
      );
    }

    // Range valido 0..4
    if (Number.isNaN(n) || n < 0 || n > 4) {
      return reply(
        client,
        chatId,
        "Scegli un numero valido (0-4) oppure scrivi: nome / orario / data / professionista / annulla."
      );
    }

    // 0) Cancella prenotazione
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
        `Sei sicuro di voler cancellare questa prenotazione?\n${line}\n\nRispondi sì/no.`
      );
    }

    // 1) Cambia data -> passo a edit_reschedule_date
    if (n === 1) {
      state.step = "edit_reschedule_date";
      state.edit = { target: booking };
      state.collected = state.collected || {};
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        `Vuoi cambiare la data di:\n${_fmtBookingLine(
          booking
        )}\n\nDimmi la nuova data (GG/MM, "oggi" o "domani").`
      );
    }

    // 2) Cambia orario -> passo a edit_reschedule_time (con professionista attuale)
    if (n === 2) {
      const day = _editDayFromBooking(booking);
      const duration = _editDuration(booking);
      const pro = booking.professionalEmail || null;

      try {
        releaseSoftHoldByChat(chatId);
      } catch { }

      const slots = normalizeSlotsDetail(
        await fetchSlots({
          service: booking.service,
          day,
          duration,
          professional: pro,
          wantDetail: true,
        })
      );

      if (!slots.length) {
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          `Non vedo orari liberi per ${fmtDateWithWeekdayIT(
            day
          )} con il professionista attuale. Puoi cambiare data o professionista dal menu di modifica.`
        );
      }

      const col = state.collected || (state.collected = {});
      col.options = slots;

      state.step = "edit_reschedule_time";
      state.edit = { target: booking, day };
      pending.set(chatId, state);

      return reply(
        client,
        chatId,
        `Orari disponibili per ${fmtDate(
          day
        )} (tengo il professionista attuale):\n${renderSlotsList(slots)}\n(1-${slots.length
        })`
      );
    }

    // 3) Cambia professionista -> passo a edit_pick_professional
    if (n === 3) {
      const pros = (cfgServiceProfessionals(booking.service) || []).filter(
        (x) => x && x.name
      );

      if (!pros.length) {
        return reply(
          client,
          chatId,
          "Non ho professionisti associati a questo servizio."
        );
      }
      state.step = "edit_pick_professional";
      state.edit = { target: booking, proOptions: pros };
      pending.set(chatId, state);

      const listPros =
        "0) Indietro (tieni quello attuale)\n" +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
      return reply(
        client,
        chatId,
        `Scegli il professionista:\n${listPros}\n(0-${pros.length})`
      );
    }

    // 4) Cambia nome -> passo a edit_change_name
    if (n === 4) {
      state.step = "edit_change_name";
      state.edit = { target: booking };
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Scrivi il nuovo nome e cognome per la prenotazione."
      );
    }
  }

  // ==== EDIT FLOW: scelta orario (dopo cambio data/orario) ====
  if (state.step === "edit_reschedule_time") {
    const booking = state.edit?.target;
    const dayRaw = state.edit?.day || (booking ? _editDayFromBooking(booking) : null);
    const day = (dayRaw && (dayRaw instanceof Date ? dayRaw : new Date(dayRaw))) || null;

    const col = (state.collected = state.collected || {});
    const options = Array.isArray(col.options) ? col.options : [];

    // session validation
    if (!booking || !day || !options.length) {
      pending.delete(chatId);
      return reply(client, chatId, 'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.');
    }

    const raw = String(msg || "").trim();
    if (/^annulla|annula$/i.test(raw)) {
      pending.delete(chatId);
      return reply(client, chatId, "Operazione annullata.");
    }

    // 1) se l'utente ha scritto una nuova DATA -> cambia giorno e ricarica slot
    const maybeNewDay = _editParseNewDate ? _editParseNewDate(raw) : null;
    if (maybeNewDay && maybeNewDay instanceof Date && !Number.isNaN(maybeNewDay.getTime())) {
      const newDay = new Date(maybeNewDay);
      newDay.setHours(0, 0, 0, 0);

      // check chiusure/validità (se esiste cfgClosedDay)
      if (typeof cfgClosedDay === "function" && cfgClosedDay(newDay)) {
        const dayStrClosed = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(newDay)
          : (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
        pending.set(chatId, state);
        return reply(client, chatId, `Il giorno ${dayStrClosed} è chiuso. Prova un altro giorno.`);
      }

      // fetch nuovi slot per il nuovo giorno
      const duration = _editDuration ? _editDuration(booking) : null;
      const pro = booking.professionalEmail || null;

      try { releaseSoftHoldByChat(chatId); } catch (e) { }

      const rawSlots = await fetchSlots({
        service: booking.service,
        day: typeof atNoon === "function" ? atNoon(newDay) : newDay,
        duration,
        professional: pro,
        wantDetail: true,
      });

      const slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawSlots) : rawSlots) || [];

      if (!slots.length) {
        pending.set(chatId, state);
        const dateStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(newDay)
          : (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
        return reply(client, chatId, `Non ci sono orari liberi per ${dateStr}. Prova un altro giorno.`);
      }

      // aggiorna stato e mostra nuovo elenco
      state.edit.day = newDay;
      state.collected.options = slots;
      pending.set(chatId, state);

      const dateStr = typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(newDay)
        : (typeof fmtDate === "function" ? fmtDate(newDay) : newDay.toLocaleDateString());
      const lines = typeof renderSlotsList === "function" ? renderSlotsList(slots) : slots.join("\n");

      return reply(
        client,
        chatId,
        `📅 Orari disponibili per ${dateStr}:\n${lines}\n\n💬 Scrivi l'orario desiderato (es. "14:30" oppure "alle 14").`
      );
    }

    // helper: normalizza stringa orario a "HH:MM"
    const parseUserTime = (text) => {
      const s = String(text || "").toLowerCase().trim();
      // supporta: "10", "10:00", "10.30", "alle 10", "9 e 30", "9:30"
      const m = s.match(/(?:alle\s*)?(\d{1,2})(?:\s*[:.\h,\s]\s*(\d{2}))?/i);
      if (!m) return null;
      const hh = parseInt(m[1], 10);
      const mm = m[2] == null ? 0 : parseInt(m[2], 10);
      if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
      if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };

    // 2) se è un numero puro: permette selezione per indice (1-based) o 0 = mostra tutti
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n === 0) {
        // mostra tutti gli slot (richiesta esplicita)
        const allRaw = await fetchSlots({
          service: booking.service,
          day: typeof atNoon === "function" ? atNoon(state.edit.day || day) : (state.edit.day || day),
          duration: _editDuration ? _editDuration(booking) : null,
          professional: booking.professionalEmail || null,
          wantDetail: true,
        });
        const allSlots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(allRaw) : allRaw) || [];
        if (!allSlots.length) return reply(client, chatId, "Nessuno slot disponibile per quel giorno.");
        state.collected.options = allSlots;
        pending.set(chatId, state);
        const dateStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(state.edit.day || day)
          : (typeof fmtDate === "function" ? fmtDate(state.edit.day || day) : (state.edit.day || day).toLocaleDateString());
        const lines = typeof renderSlotsList === "function" ? renderSlotsList(allSlots) : allSlots.join("\n");
        return reply(client, chatId, `📅 Disponibilità per ${dateStr}:\n${lines}\n\nScrivi l'orario desiderato.`);
      }

      // se è un indice, lo interpreto rispetto a col.options attuali (1-based)
      const idx = n - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        const item = options[idx];
        const time = (typeof item === "object" ? item.time : item) || null;
        if (!time) {
          pending.set(chatId, state);
          return reply(client, chatId, "Impossibile leggere l'orario selezionato. Riprova scrivendo l'orario (es. 14:30).");
        }
        // costruisco la nuova start ISO e applico l'edit
        const [hh, mm] = time.split(":").map(Number);
        const d = new Date(state.edit.day || day);
        d.setHours(hh, mm || 0, 0, 0);
        const newStartISO = d.toISOString();
        const prevStartISO = booking.startTime || booking.start || null;
const ok = await _editApplyUpdate({ booking, newStartISO });
        if (!ok) {
          state.step = "edit_menu";
          pending.set(chatId, state);
          return reply(client, chatId, "Quel posto sembra occupato. Puoi cambiare orario oppure scegliere un altro professionista.");
        }
        pending.delete(chatId);
return reply(client, chatId, _buildRescheduleConfirmation(prevStartISO, newStartISO));
      }

      // se numero fuori range -> errore
      pending.set(chatId, state);
      return reply(client, chatId, "Numero non valido. Scrivi l'orario (es. 14:30) oppure il numero corrispondente all'orario mostrato.");
    }

    // 3) altrimenti provo a interpretare l'input come orario testuale
    const requestedHHMM = parseUserTime(raw);
    if (!requestedHHMM) {
      pending.set(chatId, state);
      return reply(client, chatId, `💬 Scrivi l'orario in formato orario (es. "14:30", "14.30" oppure "alle 14").`);
    }

    // cerco lo slot corrispondente
    const found = options.find((o) => {
      const t = (typeof o === "string" ? o : (o && (o.time || o.hhmm))) || "";
      return String(t).replace(".", ":") === requestedHHMM;
    });

    if (!found) {
      pending.set(chatId, state);
      return reply(client, chatId, `⚠️ Non ho trovato disponibilità alle ${requestedHHMM}. Scegli un orario dall'elenco mostrato.`);
    }

    // applico la modifica
    const hh = Number(requestedHHMM.split(":")[0]);
    const mm = Number(requestedHHMM.split(":")[1] || 0);
    const newDate = new Date(state.edit.day || day);
    newDate.setHours(hh, mm, 0, 0);
    const newStartISO = newDate.toISOString();

    const ok = await _editApplyUpdate({ booking, newStartISO });
    if (!ok) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, "Quel posto sembra occupato. Puoi cambiare orario oppure scegliere un altro professionista.");
    }

    pending.delete(chatId);
    const dateStr = typeof formatDateWithWeekdayIT === "function" ? formatDateWithWeekdayIT(newDate) : (typeof fmtDate === "function" ? fmtDate(newDate) : newDate.toLocaleString());
    return reply(client, chatId, `✅ Prenotazione spostata a ${dateStr}.`);
  }

  // ==== EDIT FLOW: scelta professionista ====
  if (state.step === "edit_pick_professional") {
    const editState = state.edit || {};
    const booking = editState.target;
    const prosRaw = Array.isArray(editState.proOptions) ? editState.proOptions : [];
    const pros = prosRaw
      .map((p) => {
        if (!p) return null;
        if (typeof p === "string") {
          const name = String(p).trim();
          const email =
            typeof proEmailByName === "function" ? proEmailByName(name) || null : null;
          return name ? { name, email } : null;
        }
        const email =
          p.email ||
          (p.name && typeof proEmailByName === "function"
            ? proEmailByName(p.name) || null
            : null) ||
          null;
        const name =
          p.name ||
          (email && typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
          email ||
          null;
        return name ? { name, email } : null;
      })
      .filter(Boolean);

    if (!booking || !pros.length) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Sessione scaduta. Scrivi "modifica appuntamento" per ripartire.'
      );
    }

    const txt = String(msg || "").trim();

    // Accetta sia numero (1..N) sia nome ("Evelin", "con Evelin", ecc.)
    const choice =
      typeof resolveProReply === "function" ? resolveProReply(txt, pros) : null;

    // 0 / "non mi interessa" = indietro (tieni quello attuale)
    if (choice && choice.any) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(client, chatId, showEditMenu(booking));
    }

    if (!choice) {
      return reply(
        client,
        chatId,
        `Risposta non valida. Rispondi con un numero (0-${pros.length}) oppure scrivi il nome del professionista.`
      );
    }

    const chosenName = choice.name || choice.email || "professionista";
    const newProEmail =
      choice.email ||
      (typeof proEmailByName === "function" ? proEmailByName(chosenName) : null);

    if (!newProEmail) {
      return reply(
        client,
        chatId,
        "Non riesco a collegare quel nome a un professionista valido. Riprova scegliendo dall’elenco."
      );
    }

    // Se ha scelto lo stesso professionista non faccio lavoro inutile
    if (booking.professionalEmail && booking.professionalEmail === newProEmail) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        `Hai già ${chosenName} assegnata/o a questo appuntamento.\n\n${showEditMenu(
          booking
        )}`
      );
    }

    // Controllo extra: il professionista deve essere abilitato per questo servizio
    const svcCfg =
      (config.services && config.services[booking.service]) || {};
    const svcPros = Array.isArray(svcCfg.professionals)
      ? svcCfg.professionals
      : [];

    const serviceLabel =
      booking.serviceName ||
      booking.serviceLabel ||
      booking.service ||
      "questo trattamento";

    const svcProsNorm = svcPros
      .map((x) => (typeof x === "string" ? x : (x && (x.email || x.name)) || ""))
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());

    const okForSvc =
      !svcProsNorm.length ||
      svcProsNorm.includes(String(newProEmail).toLowerCase()) ||
      svcProsNorm.includes(String(chosenName).toLowerCase());

    if (!okForSvc) {
      // Non applico l’update, torno semplicemente al menu di modifica
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "⚠️ " +
        chosenName +
        " non è configurata per eseguire " +
        serviceLabel +
        " nel gestionale. " +
        "Scegli un altro professionista (3) oppure lascia quello attuale."
      );
    }

    // Ok, applico il cambio professionista
    const ok = await _editApplyUpdate({ booking, newProEmail });
    if (!ok) {
      state.step = "edit_menu";
      pending.set(chatId, state);
      return reply(
        client,
        chatId,
        "Quel professionista sembra occupato in quell’orario 😕. " +
        "Puoi cambiare orario (2) oppure scegliere un altro professionista (3)."
      );
    }

    // ricarico dal file booking per essere sicuro di avere la versione aggiornata
    let updated = booking;
    try {
      const all = getUserActiveBookingsAll(booking.clientPhone) || [];
      const match = all.find((b) => b.eventId === booking.eventId);
      if (match) updated = match;
    } catch { }

    state.step = "edit_menu";
    state.edit = { target: updated };
    pending.set(chatId, state);

    return reply(
      client,
      chatId,
      `✅ Prenotazione aggiornata:\n${_fmtBookingLine(
        updated
      )}\n\n${showEditMenu(updated)}`
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
    const no = /\b(no|annula|annulla|indietro|stop)\b/i.test(sMsg);
    if (yes) {
      // Idempotenza: se è già cancellata, non rifaccio la procedura
      const curStatus = String(booking.status || "").toLowerCase();
      if (/(cancel|annull)/.test(curStatus)) {
        pending.delete(chatId);
        return reply(
          client,
          chatId,
          "ℹ️ Questa prenotazione risulta già cancellata nel sistema."
        );
      }

      let gcalOk = false;
      try {
        gcalOk = await cancelEventSafe(booking.eventId);
      } catch { }
      const patched = {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      };
      let updated = false;
      if (booking.eventId) {
        updated = updateBookingByEventId(booking.eventId, patched);
      } else {
        updated = updateBookingByComposite(
          { clientPhone: booking.clientPhone, startTime: booking.startTime },
          patched
        );
      }
      pending.delete(chatId);
      if (gcalOk && updated)
        return reply(client, chatId, "✅ Prenotazione cancellata.");
      if (!gcalOk && updated)
        return reply(
          client,
          chatId,
          "⚠️ Ho aggiornato il sistema interno, ma non sono riuscito a cancellare l’evento in calendario. Avvisa il salone se vedi ancora l’appuntamento."
        );
      return reply(
        client,
        chatId,
        "❌ Errore interno durante la cancellazione. Riprova tra poco."
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
      a = `• ${svc}: ${cfgServicePriceText(svc)} (durata ${formatDurationMin(cfgServiceDuration(svc)) || (cfgServiceDuration(svc) + " min")})`;
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
      `• ${svc}: ${cfgServicePriceText(svc)} (durata ${formatDurationMin(cfgServiceDuration(svc)) || (cfgServiceDuration(svc) + " min")})`
    );
  }



  // ==== Orari (prenotazione standard) ====
  if (state.step !== "pick_time") {
    scheduleReenter(client, chatId, "ok professionista", tools);
    return "";
  }

  // assicurati che ci sia la data in contesto
  if (!(col && col.when)) {
    return safeSend(client, chatId, 'Mi manca il giorno: dimmi la data (es. domani / 12 dic / 12/12).');
  }

  // ✅ NEW: durante pick_time permetti cambio giorno (es. "giovedì", "martedì prossimo", "12/12", "28 ottobre")
  const daySwitchHint =
    /\b(oggi|domani|dopodomani|tra|fra|settimana|prossim|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2}|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i;

  const _daySwitchText = String(msg || "");
  const _hasDayNumberCue = /\b(?:il|giorno|data|per\s+il)\s+\d{1,2}(?:\s*(?:°|º))?\b/i.test(_daySwitchText);

  if (_hasDayNumberCue || daySwitchHint.test(_daySwitchText)) {
    let parsedSwitch =
      (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, _daySwitchText) : null) ||
      null;

    if (!parsedSwitch) {
      const mDay = _daySwitchText.match(/\b(?:il|giorno|data|per\s+il)\s+(\d{1,2})(?:\s*(?:°|º))?\b/i);
      if (mDay) {
        const probe = `il ${mDay[1]}`;
        parsedSwitch =
          (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, probe) : null) ||
          null;
      }
    }

    if (parsedSwitch && !isNaN(parsedSwitch)) {
      const day =
        typeof atNoon === "function"
          ? atNoon(parsedSwitch)
          : new Date(parsedSwitch.getFullYear(), parsedSwitch.getMonth(), parsedSwitch.getDate(), 12, 0, 0, 0);

      if (typeof cfgClosedDay === "function" && cfgClosedDay(day)) {
        const dayStrClosed =
          typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(day)
            : (typeof fmtDate === "function" ? fmtDate(day) : day.toLocaleDateString());
        pending.set(chatId, state);
        return safeSend(client, chatId, `Il giorno ${dayStrClosed} siamo chiusi. Dimmi un altro giorno (es. "domani", "sabato", "12/12").`);
      }

      col.when = day;
      col.time = null;

      const duration = getDurForPro(col.service, col.professionalEmail);


      const professional = col.professionalAny
        ? null
        : col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      const slots =
        (typeof normalizeSlotsDetail === "function"
          ? normalizeSlotsDetail(rawList)
          : rawList) || [];

      if (!slots.length) {
        const dayStr =
          typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(col.when)
            : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());
        col.when = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        return safeSend(client, chatId, `Non ci sono orari liberi per ${dayStr}. Dimmi un altro giorno (es. "domani", "sabato", "12/12").`);
      }

      col.options = slots;
      state.step = "pick_time";
      pending.set(chatId, state);

      const lines = slots
        .map((s) => {
          const prosNames =
            s.pros && s.pros.length ? ` (${s.pros.map((p) => p.name).join(", ")})` : "";
          return `• ${s.time}${prosNames}`;
        })
        .join("\n");

      const dayStr =
        typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(col.when)
          : (typeof fmtDate === "function" ? fmtDate(col.when) : col.when.toLocaleDateString());

      return safeSend(
        client,
        chatId,
        `📅 Disponibilità per ${dayStr}:\n${lines}\n\n💬 Scrivi l'orario desiderato (es. "14:30", "14.30" oppure "alle 14")`
      );
    }
  }

  // ✅ PATCH: accetta SOLO orari testuali (HH:MM), NON numeri di lista
  const parsedTime = (typeof parseTimeSmart === "function" ? parseTimeSmart(msg) : null)
    || (typeof parseHHMM === "function" ? parseHHMM(msg) : null);

  if (!parsedTime) {
    return safeSend(
      client,
      chatId,
      `Scrivi l'orario nel formato "14:30" o "14.30". Non usare numeri dell'elenco.`
    );
  }


  // Trova lo slot corrispondente all'orario scritto
  const matchedSlot = (col.options || []).find(s => s.time === parsedTime);

  if (!matchedSlot) {
    // Orario non disponibile: suggerisci alternative
    const nearest = typeof nearestTimes === "function"
      ? nearestTimes(col.options.map(s => s.time), parsedTime, 3)
      : [];

    if (nearest.length) {
      return safeSend(
        client,
        chatId,
        `L'orario ${parsedTime} non è disponibile. Orari vicini:\n${nearest.map(t => `• ${t}`).join('\n')}\n\nScrivi uno di questi orari.`
      );
    }

    return safeSend(client, chatId, `L'orario ${parsedTime} non è disponibile. Scegli tra quelli mostrati sopra.`);
  }
  // dichiarazioni preliminari per evitare ReferenceError
  let item = null;
  let time = null;


  // ✅ Orario valido: continua con matchedSlot
  item = matchedSlot;
  time = item && item.time ? item.time : null;
  col.time = time;


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
      `Tutti gli slot disponibili (${fmtDate(col.when)}):\n${linesAll}\n(1-${allSlots.length
      })`
    );
  }

  // n è l'input dell'utente (es. "3"), col/options è un array di opzioni
  const idx = Number(n) - 1;
  const hasOptions = Array.isArray(col.options);
  const len = hasOptions ? col.options.length : 0;

  if (!Number.isInteger(idx) || idx < 0 || !hasOptions || idx >= len) {
    return safeSend(client, chatId, `Scrivi l'orario in formato _HH:MM_! Ad esempio _14:00_ *oppure* semplicemente "_alle 14_"!`);
  }

  // riusa le variabili già dichiarate
  item = col.options[idx];
  time = item && typeof item === "object" ? item.time : item;


  if (!time) {
    return safeSend(
      client,
      chatId,
      tr(chatId, "GENERIC_ERROR") || "Errore: orario non valido."
    );
  }

  col.time = time;

  // Gestione professionisti
  const needPro =
    !col.professionalEmail && !col.professionalName && !col.professionalAny;

  const hasPros = item && Array.isArray(item.pros);

  if (needPro && hasPros && item.pros.length > 1) {
    // più professionisti disponibili a quell'orario: chiedi quale
    col.proOptions = item.pros.slice(); // OGGETTI {name,email}
    state.step = "pick_professional_for_time";
    pending.set(chatId, state);

    const list = item.pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
    await reply(
      client,
      chatId,
      tr(chatId, "CHOOSE_PRO_FOR_TIME", time, list, item.pros.length)
    );
    return "";
  }

  if (
    hasPros &&
    item.pros.length === 1 &&
    !col.professionalEmail &&
    !col.professionalName
  ) {
    // un solo professionista: assegnalo automaticamente
    const only = item.pros[0];
    col.professionalName = only.name;
    col.professionalEmail =
      only.email ||
      (typeof proEmailByName === "function" ? proEmailByName(only.name) : null);
    col.professionalAny = false;
  }

  // Se vuoi bloccare il caso "nessun pro e non è ANY", scommenta:
  // if (needPro && (!hasPros || item.pros.length === 0)) {
  //   return safeSend(client, chatId, tr(chatId, "NO_PRO_AVAILABLE_FOR_TIME", time));
  // }

  state.step = "collect";
  pending.set(chatId, state);

  if (typeof scheduleReenter === "function") {
    await scheduleReenter(client, chatId, `ok ${time}`, tools);
    return "";
  }
  // fallback (non dovrebbe servire, ma è sicuro):
  return ""; // evita recursion in-handleMessage

  // ============== Parsing e altre funzioni ==============
  function parseIntake(raw) {
    if (!raw) return null;
    const out = {};
    const text = String(raw);

    // 0) Nome (anche dentro frasi lunghe)
    try {
      if (typeof extractCustomerName === "function") {
        let nm = extractCustomerName(text);
        if (!nm) {
          const m = text.match(/\b(?:mi\s+chiamo|io\s+sono|sono|mi\s+chiamano)\s+([^\n,;.]+)/i);
          if (m && m[0]) nm = extractCustomerName(m[0]);
          if (!nm && m && m[1]) nm = extractCustomerName(m[1]);
        }
        if (nm && nm !== "Nome non fornito") out.customerName = nm;
      }
    } catch { }

    // 1) Servizio
    let svc = null;
    try {
      svc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;
    } catch { }

    if (!svc) {
      try {
        svc = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(text) : null) || null;
      } catch { }
    }

    if (!svc) {
      try {
        const hit =
          (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(text) : null) ||
          (typeof fuzzyService === "function" ? fuzzyService(text) : null);

        // evita falsi positivi: se il fuzzy match = primo servizio ma nel testo non ci sono token del servizio, scarta
        const first =
          (typeof cfgServices === "function" && (cfgServices()[0] || null)) ||
          null;

        const hasSvcToken = (() => {
          try {
            const tokens = (typeof cfgServices === "function" ? (cfgServices() || []) : [])
              .flatMap((s) => String(s || "").toLowerCase().split(/\W+/))
              .filter((x) => x && x.length >= 4);
            const nq = norm(text);
            return tokens.some((tok) => nq.includes(norm(tok)));
          } catch {
            return false;
          }
        })();

        if (hit && !(first && norm(hit) === norm(first) && !hasSvcToken)) svc = hit;
      } catch { }
    }

    if (svc) out.service = svc;

    // 2) Data
    try {
      const d = (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, text) : null) || null;
      if (d) {
        const at12 = typeof atNoon === "function" ? atNoon(d) : d;
        if (!(typeof isPast === "function" && isPast(at12))) out.when = at12;
      }
    } catch { }

    // 3) Orario
    try {
      let hhmm =
        (typeof parseTimeSmart === "function" ? parseTimeSmart(text) : null) ||
        (typeof parseHHMM === "function" ? parseHHMM(text) : null);

      if (!hhmm && typeof parseNaturalTime === "function") hhmm = parseNaturalTime(text);
      if (hhmm) out.time = hhmm;
    } catch { }

    // 4) Professionista
    try {
      const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa)\b/i;
      if (anyRe.test(text)) {
        out.professionalAny = true;
      } else {
        const list =
          (out.service && typeof proCatalog === "function" ? proCatalog(out.service) : null) ||
          Object.entries((config?.professionals || {})).map(([email, p]) => ({
            email,
            name: (p?.name) || email,
          }));

        const hit = typeof matchProFromFreeText === "function" ? matchProFromFreeText(text, list) : null;
        if (hit) {
          out.professionalName = hit.name;
          out.professionalEmail = hit.email || null;
          out.professionalAny = false;
        }
      }
    } catch { }

    return Object.keys(out).length ? out : null;
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
      `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(dd.getDate()).padStart(2, "0")}`;
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

    const st = stateIn || getState(chatId);
    st.ui = st.ui || {};
    st.ui.lastServiceList = svcs; // già c’è
    st.collected ||= {};
    st.collected.svcOptions = svcs; // <-- AGGIUNGI QUESTA RIGA
    pending.set(chatId, st);

    return `💆‍♀️ Quale trattamento desideri prenotare?\n${svcs
      .map((s, i) => `${i + 1}) ${s}`)
      .join("\n")}\n(1-${svcs.length})`;
  }

  // === Filtra times con vincoli after/before tipo "dopo 15:00" / "prima 18:00"
  function filterTimesByAfterBefore(
    times,
    { after = null, before = null } = {}
  ) {
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
      return `Il giorno ${fmtDate(D)} siamo chiusi. Ti va bene ${fmtDate(
        next
      )}?`;
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
      return `Per ${fmtDateWithWeekdayIT(D)} non vedo orari liberi${service ? ` per ${service}` : ""
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
    const proLabel = proEmail ? (proNameByEmail(proEmail) || "").trim() : "";
    const headPro = proLabel ? ` • ${proLabel}` : "";
    const blocks = [
      renderGroup("🌅 Mattina", grouped.mattina),
      renderGroup("🌤️ Pomeriggio", grouped.pomeriggio),
      renderGroup("🌙 Sera", grouped.sera),
    ]
      .filter(Boolean)
      .join("\n");

    return `📅 Disponibilità ${fmtDate(D)}${headSvc}${headPro}\n${blocks}`;
  }
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
function _fmtBookingLine(booking) {
  if (!booking) return "";
  const when = new Date(booking.startTime || booking.day || new Date());
  const dd = String(when.getDate()).padStart(2, "0");
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const hh = String(when.getHours()).padStart(2, "0");
  const mi = String(when.getMinutes()).padStart(2, "0");
  const pro =
    booking.professionalName ||
    proNameByEmail(booking.professionalEmail) ||
    "—";
  const service = booking.service || booking.serviceName || "";
  return `${dd}/${mm} ${hh}:${mi} — ${service}${pro ? " con " + pro : ""}`;
}
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
• *${line}*
0) Cancella
1) Modifica data
2) Modifica orario
3) Modifica professionista
4) Modifica nome
Per scegliere un'altro appuntamento, scrivi "_annulla_".
(0-4)`;
}
function renderEditBookingList(bookings) {
  return bookings
    .map((b, i) => {
      const whenRaw = b.startTime || b.start || null;
      const when = whenRaw ? new Date(whenRaw) : null;

      const dayLabel =
        when && Number.isFinite(when.getTime())
          ? (typeof fmtDateWithWeekdayIT === "function"
            ? fmtDateWithWeekdayIT(when)
            : when.toLocaleDateString("it-IT"))
          : "data da definire";

      const hh = when && Number.isFinite(when.getTime()) ? String(when.getHours()).padStart(2, "0") : "--";
      const mi = when && Number.isFinite(when.getTime()) ? String(when.getMinutes()).padStart(2, "0") : "--";
      const timeLabel = `${hh}:${mi}`;

      const pro = b.professionalName || proNameByEmail(b.professionalEmail) || "—";
      const svc = b.service || b.serviceName || "Trattamento";

      return `${i + 1}) ${svc} — ${dayLabel} alle ${timeLabel} — ${pro}`;
    })
    .join("\n");
}


async function startEditChooseBooking(
  client,
  chatId,
  bookings,
  nextStep = null
) {
  const s = pending.get(chatId) || getState(chatId);
  s.step = "edit_pick_booking";
  s.edit = { list: bookings, nextStep: nextStep || null };
  pending.set(chatId, s);

  const list = renderEditBookingList(bookings);
  const msg =
    getLang(chatId) === "en"
      ? `Which booking do you want to manage?\n${list}\n(1-${bookings.length})`
      : `Quale prenotazione vuoi gestire?\n${list}\n(1-${bookings.length})`;

  return reply(client, chatId, msg);
}

// ===== [PATCH helpers intent & sanitize] =====

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

/* Risolve il servizio dal testo con priorità alle menzioni esplicite. */
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
let __lastReminderSlotKey = ""; // evita doppio invio nello stesso slot (runtime)

function normalizeRecipientId(b) {
  const raw = (b?.clientChatId || b?.chatId || b?.clientPhone || "").toString().trim();
  if (!raw) return "";
  if (raw.includes("@c.us") || raw.includes("@g.us")) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : raw;
}

function floorToHalfHour(d) {
  const x = new Date(d);
  x.setSeconds(0, 0);
  x.setMinutes(x.getMinutes() < 30 ? 0 : 30);
  return x;
}

function slotKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Tick “a slot”: se ora è 09:30 -> target = domani 09:30..10:00
export async function remind24hTick(sendFn, opts = {}) {
  const { batchLimit = 120, graceMinutes = 10 } = opts;
  if (typeof sendFn !== "function") throw new Error("remind24hTick: sendFn mancante");

  const now = new Date();
  const slot = floorToHalfHour(now);

  // Se il processo parte “in ritardo” (es. sono le 09:25 e slot=09:00), non inviare quello vecchio
  const lateMs = now.getTime() - slot.getTime();
  if (lateMs < 0 || lateMs > graceMinutes * 60_000) return 0;

  const sk = slotKey(slot);
  if (sk === __lastReminderSlotKey) return 0;
  __lastReminderSlotKey = sk;

  // domani stessa ora/minuti dello slot
  const targetStart = new Date(slot);
  targetStart.setDate(targetStart.getDate() + 1);

  // finestra: 30 minuti (09:30..10:00)
  const targetEnd = new Date(targetStart);
  targetEnd.setMinutes(targetEnd.getMinutes() + 30);

  const arr = (typeof loadBookings === "function" ? loadBookings() : null) || [];
  if (!Array.isArray(arr)) return 0;

  const fromMs = targetStart.getTime();
  const toMs = targetEnd.getTime();

  let sent = 0;

  for (const b of arr) {
    if (sent >= batchLimit) break;
    if (!b || b.status === "cancelled") continue;

    // idempotenza anche dopo riavvio: se già inviato per questo slot, skippa
    if (b.reminder24hSent || b.reminder24hSlotKey === sk) continue;

    const startMs = Date.parse(b.startTime);
    if (!Number.isFinite(startMs)) continue;

    // ✅ qui la tua richiesta: tutti gli appuntamenti tra targetStart e targetEnd
    if (startMs < fromMs || startMs >= toMs) continue;

    const toId = normalizeRecipientId(b);
    if (!toId) continue;

    const svc = b.service || b.serviceName || "il trattamento";

    const pro =
      b.professionalName ||
      (typeof proNameByEmail === "function" ? proNameByEmail(b.professionalEmail) : null) ||
      "il professionista";

    const dt = new Date(startMs);
    const timeStr = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    const dayStr =
      (typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(dt)
        : dt.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })
      );

    const msg =
      `Ciao! Ti ricordiamo che domani hai *${svc}* alle *${timeStr}* (${dayStr}) con *${pro}*.\n\n` +
      `Se vuoi modificare qualche dettaglio, scrivi *modifica*.\nNon vediamo l'ora di accoglierti 🌸`;

    try {
      await sendFn(toId, msg);

      if (typeof updateBookingByEventId === "function" && b.eventId) {
        updateBookingByEventId(b.eventId, {
          reminder24hSent: true,
          reminder24hSentAt: new Date().toISOString(),
          reminder24hSlotKey: sk,
        });
      } else {
        b.reminder24hSent = true;
        b.reminder24hSentAt = new Date().toISOString();
        b.reminder24hSlotKey = sk;
      }

      sent++;
    } catch (e) {
      console.warn("[remind24hTick] invio fallito:", e?.message || e);
    }
  }

  console.log(`[remind24hTick] slot=${sk} target=[${slotKey(targetStart)}..${slotKey(targetEnd)}] sent=${sent}`);
  return sent;
}


// --- CONFIG ---
const INACTIVITY_MS = 60 * 60 * 1000; // 1 ora (modifica se vuoi)

// --- FUNZIONE: invia saluto se l'utente torna dopo inattività ---
/**
 * The function `greetIfReturningUser` checks if a user is returning based on their last activity and
 * sends a greeting message with an image based on the time of day.
 * @param chatId - The `chatId` parameter in the `greetIfReturningUser` function represents the unique
 * identifier for the chat or conversation where the user interaction is taking place. It is used to
 * track and manage the state and activity of the user within that specific chat context.
 * @param client - The `client` parameter in the `greetIfReturningUser` function is typically the
 * client object that manages the chat communication. It is used to send messages and stickers to the
 * user in the chat identified by `chatId`. If the `client` object is not provided, the function falls
 * back
 * @param state - The `state` parameter in the `greetIfReturningUser` function is used to keep track of
 * the current state of the conversation with the user. In this case, if a returning user is detected
 * and greeted, the state is set to "collect". This state can be used to manage the
 */
async function greetIfReturningUser(chatId, client, state) {
  try {
    const db = loadChatDB();
    const now = Date.now();
    const data = db[chatId] = db[chatId] || {};
    const lastActive = Number(data.lastActive || 0);
    const lastGreet = Number(data.lastGreet || 0);

    // Solo se c'era una precedente attività e l'inattività supera la soglia
    // e non abbiamo già salutato dopo l'ultima attività.
    if (lastActive && now - lastActive >= INACTIVITY_MS && lastGreet < lastActive) {
      state = "collect";
      let image;
      const hour = new Date().getHours();
      let greeting = "";
      if (hour >= 6 && hour < 13) {
        greeting += "Buongiorno 🌞, che bello rivederti!";
        image = "./buongiorno.jpg";
      } else if (hour >= 13 && hour < 18) {
        greeting += "Buon pomeriggio 🍹, mi fa piacere rivederti qui!";
        image = "./buonpomeriggio.jpg";
      } else if (hour >= 18 && hour < 22) {
        greeting += "Buonasera 🌇, che bello rivederti!";
        image = "./buonasera.jpg";
      } else {
        greeting += "Buonanotte 🌙, che bello rivederti!";
        image = "./buonanotte.jpg";
      }

      try {
        // usa il client passato (normalmente il client che gestisce la chat)
        await safeSend(client || inactivityClient, chatId, greeting);
        creaEInviaSticker(client, chatId, image);
        __delay(1000);
        data.lastGreet = now; // marca il saluto inviato
      } catch (err) {
        log("warn", `Errore invio saluto bentornato a ${chatId}`, err?.message || err);
      }
    }

    // registra comunque l'attività (l'utente ha scritto ora)
    data.lastActive = now;
    saveChatDB(db);
  } catch (err) {
    log("error", "greetIfReturningUser failed", err?.message || err);
  }
}

// --------------------------- util.js: append this block (setAndPersist) ---------------------------

/**
 * The `setAndPersist` function in JavaScript is designed to set and persist data to a file system in
 * an atomic manner, handling different argument combinations for various use cases.
 * @param a - a can be a string, an object, or a string representing a key.
 * @param b - The parameter `b` in the `setAndPersist` function represents the data object that you
 * want to write to a file. It should be an object containing the data that you want to persist.
 * @param c - The parameter `c` in the `setAndPersist` function represents the third argument that can
 * be passed to the function. It is used in the third scenario where the function is called with the
 * following format: `(key, value, stateObj, [filePath])`.
 * @param d - The parameter `d` in the `setAndPersist` function represents an optional file path where
 * the data will be written. If provided, the function will use this file path to persist the data. If
 * not provided, the function will default to using the file path specified in the `stateObj.__
 * @returns The `setAndPersist` function returns different values based on the input arguments:
 */
export function setAndPersist(a, b, c, d) {
  const writeAtomic = (targetPath, data) => {
    try {
      const dir = path.dirname(targetPath);
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
      const tmp = targetPath + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fsSync.renameSync(tmp, targetPath);
    } catch (e) {
      throw new Error(`writeAtomic failed: ${e?.message || e}`);
    }
  };

  const resolvePath = (p) =>
    path.isAbsolute(String(p || ""))
      ? p
      : path.join(DATA_DIR || ".", String(p || ""));

  try {
    // caso: (filePath, obj)
    if (typeof a === "string" && typeof b === "object" && b !== null && c === undefined) {
      const filePath = resolvePath(a);
      writeAtomic(filePath, b);
      return b;
    }

    // caso: (stateObj, filePath)
    if (typeof a === "object" && a !== null && typeof b === "string" && c === undefined) {
      const stateObj = a;
      const filePath = resolvePath(b);
      writeAtomic(filePath, stateObj);
      return stateObj;
    }

    // caso: (key, value, stateObj, [filePath])
    if (typeof a === "string" && arguments.length >= 3 && typeof c === "object" && c !== null) {
      const key = a;
      const value = b;
      const stateObj = c;
      const filePath = d
        ? resolvePath(d)
        : stateObj.__file
          ? resolvePath(stateObj.__file)
          : path.join(DATA_DIR || ".", "state.json");
      // aggiorna in-place
      stateObj[key] = value;
      writeAtomic(filePath, stateObj);
      return stateObj;
    }

    throw new Error("setAndPersist: argomenti non riconosciuti");
  } catch (err) {
    // usa la funzione di logging già definita in util.js
    try {
      log && typeof log === "function"
        ? log("error", "[setAndPersist] errore", err?.message || err)
        : console.error("[setAndPersist] errore", err);
    } catch { }
    throw err;
  }
}


/* The above code defines a JavaScript function called `getServiceDurationForPro` that takes two
parameters: `serviceName` and `proId`. The function is intended to calculate the service duration
for a specific professional identified by `proId` for a given `serviceName`. However, the actual
implementation of the function is represented by placeholder characters (` */
function getServiceDurationForPro(serviceName, proId) {
  try {
    // fallback rapido
    const DEFAULT = 30;
    if (!serviceName) {
      if (typeof cfgServiceDuration === "function") {
        const d = cfgServiceDuration();
        return Number.isFinite(+d) && +d > 0 ? +d : DEFAULT;
      }
      return DEFAULT;
    }

    // Ottieni item servizio (supporta helper esistenti)
    const svcItem =
      (typeof cfgServiceItem === "function" ? cfgServiceItem(serviceName) : null) ||
      (config && config.services && config.services[serviceName]) ||
      {};

    // mappa professionalDurations (se esiste)
    const pd = svcItem.professionalDurations || svcItem.professionalDuration || {};

    // Normalizza proId: se è un nome cerca email con proEmailByName se disponibile
    let proEmail = proId || null;
    if (proEmail && typeof proEmailByName === "function" && !/@/.test(String(proEmail))) {
      try {
        const mapped = proEmailByName(proEmail);
        if (mapped) proEmail = mapped;
      } catch { }
    }

    // 1) Cerca corrispondenza chiave diretta (case-insensitive) su professionalDurations
    if (proEmail && pd && typeof pd === "object") {
      const lookup = String(proEmail).toLowerCase();
      for (const k of Object.keys(pd)) {
        if (!k) continue;
        if (k.toLowerCase() === lookup) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return val;
        }
      }
    }

    // 2) Potrebbe esserci una chiave in pd usata come "nome" invece che email — confronto fuzzy semplice
    if (proId && pd && typeof pd === "object") {
      const tryNorm = (v) =>
        typeof simpleNorm === "function" ? simpleNorm(String(v || "")) : String(v || "").toLowerCase().trim();
      const tgt = tryNorm(proId);
      for (const k of Object.keys(pd)) {
        if (!k) continue;
        // confronto sulla chiave (nome) o, se la chiave è un'email presente in config.professionals, confronto il nome associato
        if (tryNorm(k) === tgt) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return val;
        }
        const maybeName = config?.professionals?.[k]?.name;
        if (maybeName && tryNorm(maybeName) === tgt) {
          const val = +pd[k];
          if (Number.isFinite(val) && val > 0) return val;
        }
      }
    }

    // 3) Fallback al campo generico duration del servizio (config.services[svc].duration)
    if (Number.isFinite(+svcItem.duration) && +svcItem.duration > 0) return +svcItem.duration;

    // 4) Fallback all'helper cfgServiceDuration se presente
    if (typeof cfgServiceDuration === "function") {
      try {
        const d = cfgServiceDuration(serviceName);
        if (Number.isFinite(+d) && +d > 0) return +d;
      } catch { }
    }

    // default ultimo
    return DEFAULT;
  } catch (err) {
    // sicurezza: non rompere il flusso di prenotazione
    try { log && typeof log === "function" && log("warn", "getServiceDurationForPro error", err?.message || err); } catch { }
    return 30;
  }
}


const __dateParsingInProgress = new Set();

/**
 * The function `parseUnifiedDate` in JavaScript parses various date formats and relative date
 * expressions to return a valid Date object, with the option to provide a base date for context.
 * @param text - The `parseUnifiedDate` function you provided is quite comprehensive and handles
 * various date formats and relative date expressions. It parses the input `text` to determine a date
 * based on the provided `baseDate` or the current date if no base date is specified.
 * @param [baseDate] - The `baseDate` parameter in the `parseUnifiedDate` function is used to provide a
 * reference date for parsing relative dates or dates without a specified year. If no `baseDate` is
 * provided, the current date and time will be used as the default reference point. This allows for
 * more accurate
 * @returns The `parseUnifiedDate` function parses a given text input to determine a date relative to a
 * base date. It handles various formats and expressions such as relative dates (e.g., "today",
 * "tomorrow"), weekdays, numeric dates, month names, and more. The function returns a `Date` object
 * representing the parsed date or `null` if the input text does not contain a recognizable date
 */
function parseUnifiedDate(text, baseDate = new Date()) {
  if (text == null) return null;

  const stripDiacritics = (s) =>
    String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalize = (s) => {
    let t = stripDiacritics(String(s ?? "").toLowerCase().trim());
    t = t.replace(/[“”"']/g, "");
    t = t.replace(/\s+/g, " ").trim();
    // rimuove punteggiatura ai bordi (così "domani?" / "15/12," ecc)
    t = t.replace(/^[?!.,;:()\[\]{}<>]+/g, "").replace(/[?!.,;:()\[\]{}<>]+$/g, "").trim();
    return t;
  };

  const s = normalize(text);

  const base = baseDate instanceof Date ? new Date(baseDate) : new Date();
  const baseDay = new Date(base);
  baseDay.setHours(0, 0, 0, 0);

  const setNoon = (d) => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    d.setHours(12, 0, 0, 0);
    return d;
  };

  const isValidDate = (d, y, m, day) =>
    d instanceof Date &&
    !Number.isNaN(d.getTime()) &&
    d.getFullYear() === y &&
    d.getMonth() === m &&
    d.getDate() === day;

  const makeDate = (y, m, day) => {
    const d = new Date(y, m, day, 12, 0, 0, 0);
    return isValidDate(d, y, m, day) ? d : null;
  };

  const normalizeYear = (yy) => {
    if (yy == null) return null;
    const n = parseInt(String(yy), 10);
    if (Number.isNaN(n)) return null;
    if (n < 100) return 2000 + n; // 25 -> 2025
    return n;
  };

  const rollFutureIfMissingYear = (d) => {
    if (d && d < baseDay) d.setFullYear(d.getFullYear() + 1);
    return d;
  };

  const addDays = (n) => {
    const d = new Date(baseDay);
    d.setDate(d.getDate() + n);
    return setNoon(d);
  };

  const addMonths = (n) => {
    const d = new Date(baseDay);
    d.setMonth(d.getMonth() + n);
    return setNoon(d);
  };

  const addYears = (n) => {
    const d = new Date(baseDay);
    d.setFullYear(d.getFullYear() + n);
    return setNoon(d);
  };

  const wordToNumber = (w) => {
    const map = {
      un: 1, uno: 1, una: 1,
      due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
      undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16,
      diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
      ventuno: 21, ventidue: 22, ventitre: 23, ventiquattro: 24, venticinque: 25,
      ventisei: 26, ventisette: 27, ventotto: 28, ventinove: 29, trenta: 30, trentuno: 31
    };
    if (w == null) return null;
    const t = normalize(w);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return map[t] ?? null;
  };

  // --- 1) Relativi (anche dentro frasi) ---
  // "oggi" / "domani?" / "dopodomani" / "dopo domani"
  if (/\boggi\b/.test(s)) return addDays(0);
  if (/\b(dopodomani|dopo domani)\b/.test(s)) return addDays(2);
  if (/\bdomani\b/.test(s)) return addDays(1);

  // "settimana prossima", "mese prossimo", "anno prossimo"
  if (/\bsettimana\s+prossima\b/.test(s)) return addDays(7);
  if (/\bmese\s+prossim[oa]\b/.test(s)) return addMonths(1);
  if (/\banno\s+prossim[oa]\b/.test(s)) return addYears(1);

  // "tra/fra X giorni|settimane|mesi|anni" (X cifra o parola)
  {
    const rel = s.match(/\b(tra|fra)\s+([a-z0-9]+)\s*(giorno|giorni|g|gg|settimana|settimane|sett|mese|mesi|anno|anni)\b/);
    if (rel) {
      const n = wordToNumber(rel[2]);
      const unit = rel[3];
      if (n != null && n >= 0) {
        if (unit === "giorno" || unit === "giorni" || unit === "g" || unit === "gg") return addDays(n);
        if (unit === "settimana" || unit === "settimane" || unit === "sett") return addDays(n * 7);
        if (unit === "mese" || unit === "mesi") return addMonths(n);
        if (unit === "anno" || unit === "anni") return addYears(n);
      }
    }
  }

  // --- 2) Giorni della settimana ---
  {
    const weekdayMap = {
      lunedi: 1, lun: 1,
      martedi: 2, mar: 2,
      mercoledi: 3, mer: 3,
      giovedi: 4, gio: 4,
      venerdi: 5, ven: 5,
      sabato: 6, sab: 6,
      domenica: 0, dom: 0
    };

    const w = s.match(/\b(lunedi|lun|martedi|mar|mercoledi|mer|giovedi|gio|venerdi|ven|sabato|sab|domenica|dom)\b/);
    if (w) {
      const key = w[1];
      const targetDow = weekdayMap[key];
      const currentDow = baseDay.getDay();
      let diff = (targetDow - currentDow + 7) % 7;
      if (diff === 0) diff = 7; // prossima occorrenza, non "oggi"

      // "<giorno> prossimo" / "prossimo <giorno>" => calcola il prossimo <giorno> e poi +7 giorni
      const keyRe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isWeekdayProssimo =
        new RegExp(`\\b${keyRe}\\s+prossim[oa]\\b|\\bprossim[oa]\\s+${keyRe}\\b`).test(s);

      const hasWeekQualifier = /\b(settimana prossima|della prossima settimana)\b/.test(s);

      if (hasWeekQualifier || isWeekdayProssimo) diff += 7;

      const d = new Date(baseDay);
      d.setDate(d.getDate() + diff);
      return setNoon(d);
    }
  }

  // --- 3) Date numeriche (anche dentro frasi) ---
  // ISO: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  {
    const iso = s.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (iso) {
      const y = parseInt(iso[1], 10);
      const m = parseInt(iso[2], 10) - 1;
      const day = parseInt(iso[3], 10);
      const d = makeDate(y, m, day);
      if (d) return d;
    }
  }

  // D/M(/Y) con / - . (prova anche M/D se necessario)
  {
    const dmy = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
    if (dmy) {
      const a = parseInt(dmy[1], 10);
      const b = parseInt(dmy[2], 10);
      const yOpt = normalizeYear(dmy[3]) ?? baseDay.getFullYear();

      // preferenza IT: D/M
      let d = makeDate(yOpt, b - 1, a);

      // se non valida, prova swap (M/D)
      if (!d) d = makeDate(yOpt, a - 1, b);

      if (d) {
        if (dmy[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // Spazi: "15 12 2025" / "15 12" (solo se è praticamente tutto il testo)
  {
    const spaced = s.match(/^(?:il\s+|data\s+)?(\d{1,2})\s+(\d{1,2})(?:\s+(\d{2,4}))?$/);
    if (spaced) {
      const a = parseInt(spaced[1], 10);
      const b = parseInt(spaced[2], 10);
      const yOpt = normalizeYear(spaced[3]) ?? baseDay.getFullYear();

      let d = makeDate(yOpt, b - 1, a); // D M
      if (!d) d = makeDate(yOpt, a - 1, b); // swap

      if (d) {
        if (spaced[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- 4) Mese scritto: "15 dicembre", "15 dic 2025", "dicembre 15" ---
  {
    const monthMap = {
      gennaio: 0, gen: 0,
      febbraio: 1, feb: 1,
      marzo: 2, mar: 2,
      aprile: 3, apr: 3,
      maggio: 4, mag: 4,
      giugno: 5, giu: 5,
      luglio: 6, lug: 6,
      agosto: 7, ago: 7,
      settembre: 8, set: 8, sett: 8,
      ottobre: 9, ott: 9,
      novembre: 10, nov: 10,
      dicembre: 11, dic: 11
    };

    const monthKeys = Object.keys(monthMap).sort((a, b) => b.length - a.length).join("|");

    // giorno + mese (+ anno)
    const dm = s.match(new RegExp(`\\b(\\d{1,2})(?:\\s*(?:°|º))?\\s*(?:di\\s*)?(${monthKeys})\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (dm) {
      const day = parseInt(dm[1], 10);
      const mKey = normalize(dm[2]);
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(dm[3]) ?? baseDay.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (dm[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }

    // mese + giorno (+ anno)
    const md = s.match(new RegExp(`\\b(${monthKeys})\\s+(\\d{1,2})(?:\\s*(?:°|º))?\\b(?:\\s+(\\d{2,4}))?`, "i"));
    if (md) {
      const mKey = normalize(md[1]);
      const day = parseInt(md[2], 10);
      const mm = monthMap[mKey];
      const yOpt = normalizeYear(md[3]) ?? baseDay.getFullYear();
      let d = makeDate(yOpt, mm, day);
      if (d) {
        if (md[3] == null) d = rollFutureIfMissingYear(d);
        return d;
      }
    }
  }

  // --- 5) Solo giorno: "9", "il 9", "giorno 9" ---
  {
    const onlyDay = s.match(/^(?:il\s+|giorno\s+)?(\d{1,2})(?:\s*(?:°|º))?$/);
    if (onlyDay) {
      const day = parseInt(onlyDay[1], 10);
      if (day >= 1 && day <= 31) {
        let y = baseDay.getFullYear();
        let m = baseDay.getMonth();

        let d = makeDate(y, m, day);
        if (!d) return null;

        if (d < baseDay) {
          m += 1;
          if (m > 11) {
            m = 0;
            y += 1;
          }
          d = makeDate(y, m, day);
          if (!d) return null;
        }
        return d;
      }
    }
  }

  // --- 6) Fallback: parser esterno se presente ---
  if (typeof parseDaySmart === "function") {
    const d = parseDaySmart(String(text), { baseDate: baseDay });
    if (d && !Number.isNaN(d.getTime())) return setNoon(new Date(d));
  }

  return null;
}

/**
 * Wrapper sicuro per prevenire loop
 */
function safeParseDateWithLock(chatIdOrText, maybeText) {
  // Supporta sia safeParseDateWithLock(chatId, text) che safeParseDateWithLock(text)
  const hasTwoArgs = typeof maybeText !== "undefined";
  const chatKey = hasTwoArgs ? String(chatIdOrText || "GLOBAL") : "GLOBAL";
  const text = hasTwoArgs ? maybeText : chatIdOrText;

  // Previeni parsing ricorsivo per la stessa chat
  if (__dateParsingInProgress.has(chatKey)) {
    log("warn", "[DATE] Parsing già in corso, ignoro", { chatId: chatKey });
    return null;
  }

  try {
    __dateParsingInProgress.add(chatKey);
    return parseUnifiedDate(text);
  } finally {
    __dateParsingInProgress.delete(chatKey);
  }
}

/**
 * Start the review followups loop - calls reviewFollowupsTick at regular intervals
 * @param {Object} client - WhatsApp client instance
 * @param {Object} opts - Options object
 * @param {number} opts.intervalMinutes - How often to run (in minutes)
 * @param {number} opts.lookbackDays - How many days back to check
 * @param {number} opts.minAfterEndMinutes - Minimum minutes after appointment end
 * @param {number} opts.batchLimit - Maximum messages to send per batch
 * @param {boolean} opts.alignToHalfHour - Whether to align runs to :00 and :30
 */
export function startReviewFollowupsLoop(client, opts = {}) {
  const {
    intervalMinutes = 30,
    lookbackDays = 3,
    minAfterEndMinutes = 15,
    batchLimit = 20,
    alignToHalfHour = true
  } = opts;

  const sendFn = (to, msg) => safeSend(client, to, msg, { noFooter: true });

  // Calculate delay to align to next :00 or :30 if requested
  const getAlignmentDelay = () => {
    if (!alignToHalfHour) return 0;
    
    const now = new Date();
    const minutes = now.getMinutes();
    const targetMinute = minutes < 30 ? 30 : 60;
    const delay = (targetMinute - minutes) * 60 * 1000 - now.getSeconds() * 1000;
    return delay > 0 ? delay : 0;
  };

  // Run immediately on startup
  log('info', '[REVIEW_LOOP] Starting review followups loop', {
    intervalMinutes,
    lookbackDays,
    minAfterEndMinutes,
    batchLimit,
    alignToHalfHour
  });

  // First run with alignment if requested
  const initialDelay = getAlignmentDelay();
  
  setTimeout(() => {
    // First run
    reviewFollowupsTick(sendFn, {
      lookbackDays,
      minAfterEndMinutes,
      batchLimit
    }).catch(err => {
      log('error', '[REVIEW_LOOP] Error in reviewFollowupsTick', err?.message || err);
    });

    // Then set up recurring interval
    setInterval(() => {
      reviewFollowupsTick(sendFn, {
        lookbackDays,
        minAfterEndMinutes,
        batchLimit
      }).catch(err => {
        log('error', '[REVIEW_LOOP] Error in reviewFollowupsTick', err?.message || err);
      });
    }, intervalMinutes * 60 * 1000);
  }, initialDelay);

  log('info', `[REVIEW_LOOP] Will check every ${intervalMinutes} minutes (first run in ${Math.round(initialDelay / 1000)}s)`);
}