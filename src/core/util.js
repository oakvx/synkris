import { createModule as createDomain0 } from './modules/conversation/helpers.js';
import { createModule as createDomain1 } from './modules/conversation/intent.js';
import { createModule as createDomain2 } from './modules/booking/persistence.js';
import { createModule as createDomain3 } from './modules/booking/holds.js';
import { createModule as createDomain4 } from './modules/booking/notifications.js';
import { createModule as createDomain5 } from './modules/catalog/services.js';
import { createModule as createDomain6 } from './modules/conversation/privacy.js';
import { createModule as createDomain7 } from './modules/conversation/transport.js';
import { createModule as createDomain8 } from './modules/conversation/state.js';
import { createModule as createDomain9 } from './modules/booking/availability.js';
import { createModule as createDomain10 } from './modules/booking/calendar.js';
import { createModule as createDomain11 } from './modules/booking/edit.js';
import { createModule as createDomain12 } from './modules/conversation/handle-message.js';
import { createModule as createDomain13 } from './modules/conversation/handle-numeric-reply.js';
/**
 * Booking conversation orchestrator.
 *
 * This module contains the existing stateful booking flow and remains intentionally
 * compatible with the WhatsApp and IVR entry points. New pure helpers and message
 * templates belong in ./util/ instead of extending this file.
 * See docs/SOURCE_ARCHITECTURE.md for the module map and migration constraints.
 */
import * as fsSync from "fs";
import path from "path";
import { createPgPool } from '../storage/postgres.js';
import { isRetryableBookingDbError } from '../storage/pg-errors.js';
import {
  getFreeSlotsForDay as _getFreeSlotsForDay,
  createCalendarEvent as _createCalendarEvent,
} from "../services/gcal.js";
import * as GCAL from "../services/gcal.js";
import {
  initBookingsNormDbPg,
  listBookingsNormPg,
  bulkUpsertBookingsNormPg
} from "../storage/bookings-norm-pg.js";
import { log } from "./util/logger.js";
import { MESSAGES } from "./util/conversation-messages.js";
import { isReactionOnly } from "./util/feedback-reactions.js";
import { buildReviewMessage, buildConfirmMessage } from "./util/appointment-messages.js";
import { dueForReview, dueForConfirmation } from './util/reminder-windows.js';

export { buildReviewMessage, buildConfirmMessage };
import {
  AVAIL_PAGE_SIZE,
  buildAvailabilityCompactMessage,
  filterSlotsByDaypart,
  fmtDateLongIT,
  fmtWeekdayDateLongIT,
  fmtWeekdayDateShortIT,
  parseListIndex,
  uniqueTimesFromSlots,
  validateDateInRange,
} from "./util/availability-format.js";
import { isClosedDay, filterOutPastTimesForToday as filterPastTimes, normalizeDaypart } from './util/runtime-rules.js';
import { pickIntent } from "../ai/intent-classifier.js";
import { postOllama, isAIEnabled } from "../ai/ollama-client.js";
import { answerServiceQuestion } from "../ai/information-assistant.js";
import { parseUnifiedDate, safeParseDateWithLock } from "./util/date-parser.js";
import { escapeReg, norm, simpleNorm, _norm, _normIncomingForDedup } from "./util/text-utils.js";
import {
  atNoon,
  compareHHMM,
  daysInMonth,
  fmtDate,
  fmtDateWithWeekdayIT,
  formatDurationMin,
  isPast,
  isoWeekday,
  itaWeekdayName,
  parseHHMM,
  parseNaturalTime,
  parseTimeSmart,
  setTime,
  timeToMinutes,
  toISOStringLocal,
} from "./util/date-time.js";

import {
  levenshtein,
  isTypoClose,
  dlDist,
  typoMaxDist,
  fuzzyCmd,
} from "./util/fuzzy-matching.js";
import {
  matchProFromFreeText,
  pickBookingIndexFromFreeText,
  pickBookingMatchFromFreeText,
} from "./util/professional-matching.js";
import {
  _svcNormText,
  _svcTokensFromText,
  scoreService,
  bestServiceScored as scoreServiceCatalog,
} from "./util/service-matching.js";

let inactivityClient = null;

// ================= PostgreSQL (chat/holds/state) =================
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

function __tsMs(v) {
  if (!v) return 0;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

function __toIsoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Mappe ID utili (service_name -> id, professional/email -> id)
let __svcNameToId = new Map();
let __proEmailToId = new Map();
let __proNameToId = new Map();

//  FIX (concurrent __loadIdMaps): un solo caricamento alla volta; caller concorrenti
// attendono la stessa promise invece di lanciare query parallele che azzererebbero
// le mappe mentre un altro caricamento è ancora in volo.
let __loadIdMapsInFlight = null;

async function __loadIdMaps() {
  if (!__pgPool) return;
  if (__loadIdMapsInFlight) return __loadIdMapsInFlight;

  __loadIdMapsInFlight = (async () => {
    try {
      // FIX (map wipe): costruisci in variabili temporanee, sostituisci solo
      // dopo aver ricevuto tutti i dati — se la query fallisce la mappa precedente
      // rimane intatta.
      const svcs = await __pgQuery(`SELECT service_id, service_name FROM public.services`);
      const newSvcMap = new Map();
      for (const r of svcs) newSvcMap.set(String(r.service_name || ""), Number(r.service_id));
      __svcNameToId = newSvcMap;

      const pros = await __pgQuery(`
      SELECT p.professional_id, p.full_name,
             (SELECT (pe.email)::text FROM public.professional_emails pe
              WHERE pe.professional_id = p.professional_id
              ORDER BY (pe.email)::text ASC
              LIMIT 1) AS email
      FROM public.professionals p
    `);
      const newEmailMap = new Map();
      const newNameMap = new Map();
      for (const r of pros) {
        const id = Number(r.professional_id);
        const email = String(r.email || "").toLowerCase();
        const name = String(r.full_name || "");
        if (email) newEmailMap.set(email, id);
        // Anche il synth key "pro:N" -> id, così __proEmailToId trova
        // sempre un match per professionisti senza email reale
        newEmailMap.set(`pro:${id}`, id);
        if (name) newNameMap.set(name.toLowerCase(), id);
      }
      __proEmailToId = newEmailMap;
      __proNameToId = newNameMap;

      log("debug", "[pg] loadIdMaps OK", {
        services: __svcNameToId.size,
        professionals: __proEmailToId.size,
      });
    } catch (e) {
      log("warn", "[pg] loadIdMaps failed", {
        error: String(e?.message || e)
      });
    } finally {
      __loadIdMapsInFlight = null;
    }
  })();

  return __loadIdMapsInFlight;
}

//  FIX (maps never refresh): ricarica le mappe ogni 5 minuti in background così nuovi
// servizi/professionisti aggiunti al DB sono disponibili senza riavviare il processo.
// Configurabile via env ID_MAPS_REFRESH_MS.
const __ID_MAPS_REFRESH_MS = Number(process.env.ID_MAPS_REFRESH_MS || 5 * 60 * 1000);
if (__pgPool) {
  setInterval(() => {
    __loadIdMaps().catch((e) =>
      log("warn", "[pg] loadIdMaps periodic refresh failed", {
        error: String(e?.message || e)
      })
    );
  }, __ID_MAPS_REFRESH_MS);
}

// ================= Services catalog cache (PostgreSQL) =================
// Fonte di verità: tabelle public.services + public.service_synonyms + public.professional_services.
// Niente fallback a config.services: se la tabella è vuota, il listino risulta vuoto.
let __servicesListCache = [];
let __servicesItemCache = new Map(); // service_name -> item (label, durationMin, price, professionals...)
let __servicesSynCache = new Map(); // service_name -> [synonyms]
let __servicesProsCache = new Map(); // service_name -> [{name,email}]
let __servicesDBOk = false;
let __servicesDBInitErr = null;

// chiave normalizzata per match case/diacritici
const __svcKey = (s) => String(s || "")
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .trim();

let __svcKeyToName = new Map(); // norm(name) -> canonical service_name

function __fmtEurMaybe(v) {
  if (v === null || typeof v === "undefined") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  const pretty = fixed.replace(/\.00$/, "").replace(/(\.[0-9])0$/, "$1");
  return `${pretty}€`;
}

async function __initServicesCacheFromPg() {
  if (!__pgPool) {
    __servicesListCache = [];
    __servicesItemCache = new Map();
    __servicesSynCache = new Map();
    __servicesProsCache = new Map();
    __svcKeyToName = new Map();
    __servicesDBOk = false;
    __servicesDBInitErr = new Error("pg non configurato");
    return;
  }

  try {
    await __loadIdMaps();

    // 1) servizi
    const rows = await __pgQuery(`
      SELECT
        s.service_id,
        s.service_name,
        s.default_duration_min,
        s.base_price,
        COALESCE(c.category_name, NULLIF(btrim(s.category), ''), 'Altro') AS category_name,
        c.category_id,
        c.display_order AS category_display_order,
        s.emoji,
        s.display_order
      FROM public.services s
      LEFT JOIN public.service_categories c ON c.category_id = s.category_id
      WHERE s.is_active = true
        AND (c.is_active IS DISTINCT FROM false)
      ORDER BY
        COALESCE(c.display_order, 9999) ASC,
        COALESCE(c.category_name, 'Altro') ASC,
        COALESCE(s.display_order, 1000) ASC,
        s.service_name ASC
    `);

    __servicesListCache = [];
    __servicesItemCache = new Map();
    __svcKeyToName = new Map();

    for (const r of (rows || [])) {
      const name = String(r.service_name || "").trim();
      if (!name) continue;

      __servicesListCache.push(name);
      __svcKeyToName.set(__svcKey(name), name);

      const durationMin = Number(r.default_duration_min || 0) || 30;
      const basePrice = (r.base_price === null || typeof r.base_price === "undefined") ? null : Number(r.base_price);

      const category = String(r.category_name || "").trim() || null;
      const categoryId = (r.category_id === null || typeof r.category_id === "undefined") ? null : Number(r.category_id);
      const categoryOrder = Number(r.category_display_order ?? 9999);

      const emoji = String(r.emoji || "").trim() || null;
      const displayOrder = Number(r.display_order ?? 1000);

      __servicesItemCache.set(name, {
        name,
        label: name,
        category,
        categoryId,
        categoryOrder: (Number.isFinite(categoryOrder) ? categoryOrder : 9999),
        emoji,
        displayOrder: (Number.isFinite(displayOrder) ? displayOrder : 1000),
        durationMin,
        price: (Number.isFinite(basePrice) ? basePrice : null),
        professionals: [], // riempito sotto
        professionalsDetailed: [],
      });
    }

    // 2) sinonimi
    const synRows = await __pgQuery(`
      SELECT s.service_name, ss.synonym
      FROM public.service_synonyms ss
      JOIN public.services s ON s.service_id = ss.service_id
    `);

    __servicesSynCache = new Map();
    for (const r of (synRows || [])) {
      const svcName = String(r.service_name || "").trim();
      const syn = String(r.synonym || "").trim();
      if (!svcName || !syn) continue;
      const canon = __svcKeyToName.get(__svcKey(svcName)) || svcName;

      const arr = __servicesSynCache.get(canon) || [];
      arr.push(syn);
      __servicesSynCache.set(canon, arr);
    }

    // 3) mapping professionisti per servizio
    const proRows = await __pgQuery(`
      SELECT s.service_name,
             p.professional_id,
             p.full_name,
             COALESCE(
               (SELECT (pe.email)::text FROM public.professional_emails pe
                WHERE pe.professional_id = p.professional_id
                ORDER BY (pe.email)::text ASC
                LIMIT 1),
               (p.email)::text
             ) AS email
      FROM public.professional_services ps
      JOIN public.services s ON s.service_id = ps.service_id
      JOIN public.professionals p ON p.professional_id = ps.professional_id
      WHERE p.is_active = true
    `);

    __servicesProsCache = new Map();
    for (const r of (proRows || [])) {
      const svcName = String(r.service_name || "").trim();
      const fullName = String(r.full_name || "").trim();
      if (!svcName) continue;

      // FIX (professionals with NULL email): usa "pro:<id>" come identificatore
      // interno quando l'email non è configurata, invece di saltare il professionista.
      // Questo evita il fallback a config.professionals che leakava "evelin.com".
      const rawEmail = String(r.email || "").trim().toLowerCase();
      const proIdNum = Number(r.professional_id);
      const email = rawEmail || (Number.isFinite(proIdNum) ? `pro:${proIdNum}` : null);
      if (!email) continue;

      const canon = __svcKeyToName.get(__svcKey(svcName)) || svcName;

      const list = __servicesProsCache.get(canon) || [];
      list.push({
        name: fullName || email,
        email,
        professional_id: Number.isFinite(proIdNum) ? proIdNum : null,
        hasRealEmail: !!rawEmail,
      });
      __servicesProsCache.set(canon, list);
    }

    // 4) copia rapida nei service item (per compatibilità con codepath esistenti)
    for (const name of __servicesListCache) {
      const it = __servicesItemCache.get(name);
      if (!it) continue;

      const pros = __servicesProsCache.get(name) || [];
      it.professionalsDetailed = pros.slice();
      it.professionals = pros.map((p) => p.email).filter(Boolean);
    }

    __servicesDBOk = true;
    __servicesDBInitErr = null;

    try {
      log("info", "[services] PostgreSQL cache loaded", {
        count: __servicesListCache.length
      });
    } catch { }
  } catch (e) {
    __servicesListCache = [];
    __servicesItemCache = new Map();
    __servicesSynCache = new Map();
    __servicesProsCache = new Map();
    __svcKeyToName = new Map();
    __servicesDBOk = false;
    __servicesDBInitErr = e;

    try {
      log("error", "[services] PostgreSQL init/load failed", {
        error: String(e?.message || e),
      });
    } catch { }
  }
}

let __chatCache = {};
let __chatDBOk = false;
let __chatDBInitErr = null;
let __chatFlushTimer = null;
let __chatFlushInFlight = false;
const __CHAT_FLUSH_MS = Number(process.env.CHAT_FLUSH_MS || 750);

// ── LRU / TTL per __chatCache ──────────────────────────────────────────────
// Ogni chatId viene "toccato" ogni volta che loadChatDB/saveChatDB lo usa.
// Quando la cache supera MAX_CHAT_ENTRIES, si espellono le entry più vecchie.
// Le entry non toccate da più di CHAT_TTL_DAYS vengono rimosse dal cleanup periodico.
const __CHAT_MAX_ENTRIES = Number(process.env.CHAT_MAX_ENTRIES || 2000);
const __CHAT_TTL_MS = Number(process.env.CHAT_TTL_DAYS || 30) * 86_400_000;
const __CHAT_CLEANUP_MS = Number(process.env.CHAT_CLEANUP_MS || 3_600_000); // ogni ora
const __chatAccessTime = new Map(); // chatId → timestamp ultimo accesso

/** Registra un accesso per chatId (aggiorna LRU timestamp). */
function __touchChat(chatId) {
  if (chatId) __chatAccessTime.set(String(chatId), Date.now());
}

/**
 * Espelle le entry meno recentemente usate quando la cache supera il limite.
 * Rimuove anche le entry scadute (TTL).
 */
function __evictChatCache() {
  const now = Date.now();

  // 1) rimuovi entry scadute (TTL)
  for (const [id, ts] of __chatAccessTime) {
    if (now - ts > __CHAT_TTL_MS) {
      delete __chatCache[id];
      __chatAccessTime.delete(id);
    }
  }

  // 2) se ancora sopra il limite, espelli le più vecchie (LRU)
  const ids = Object.keys(__chatCache);
  if (ids.length <= __CHAT_MAX_ENTRIES) return;

  // ordina per ultimo accesso (dal più vecchio al più recente)
  ids.sort((a, b) => (__chatAccessTime.get(a) || 0) - (__chatAccessTime.get(b) || 0));

  const toRemove = ids.length - __CHAT_MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    delete __chatCache[ids[i]];
    __chatAccessTime.delete(ids[i]);
  }

  log("info", "[chat] LRU evict", {
    removed: toRemove,
    remaining: Object.keys(__chatCache).length
  });
}

// Cleanup periodico (TTL) — si avvia dopo il primo init
let __chatCleanupTimer = null;

function __startChatCleanup() {
  if (__chatCleanupTimer) return;
  __chatCleanupTimer = setInterval(() => {
    try {
      __evictChatCache();
    } catch {
      /* best-effort */
    }
  }, __CHAT_CLEANUP_MS);
  if (__chatCleanupTimer?.unref) __chatCleanupTimer.unref(); // non blocca il processo
}
// ─────────────────────────────────────────────────────────────────────────────

async function __initChatCacheFromPg() {

  if (!__pgPool) {
    __chatCache = {};
    __chatDBOk = false;
    __chatDBInitErr = new Error("pg non configurato");
    return;
  }

  try {
    await __loadIdMaps();

    const rows = await __pgQuery(`
      SELECT cs.*,
             s.service_name AS last_service_name,
             p.full_name AS last_pro_name
      FROM public.chat_sessions cs
      LEFT JOIN public.services s ON s.service_id = cs.last_review_prompt_service_id
      LEFT JOIN public.professionals p ON p.professional_id = cs.last_review_prompt_professional_id
    `);

    const cache = {};
    for (const r of (rows || [])) {
      const chatId = String(r.chat_id || "");
      if (!chatId) continue;
      cache[chatId] = {
        msgs: [],
        phone: r.phone_e164 || chatIdToE164(chatId) || chatId,
        lang: r.lang || "it",
        firstSeenAt: __tsMs(r.first_seen_at) || 0,
        lastActive: __tsMs(r.last_active_at) || 0,
        lastGreet: __tsMs(r.last_greet_at) || 0,
        privacy: (r.privacy_sent_at || r.privacy_version) ? {
          sentAt: __tsMs(r.privacy_sent_at),
          version: Number(r.privacy_version || 1),
        } : undefined,
        lastReviewPromptAt: __tsMs(r.last_review_prompt_at) || 0,
        lastReviewPromptEventId: r.last_review_prompt_event_id || null,
        lastReviewPromptService: r.last_service_name || null,
        lastReviewPromptPro: r.last_pro_name || null,
        lastReviewReplyAt: __tsMs(r.last_review_reply_at) || 0,
        reminderChoice: (r.reminder_choice === null || typeof r.reminder_choice === "undefined") ?
          null : Number(r.reminder_choice),
      };
    }

    // ultimi N messaggi IN per chat (per contesto)
    const maxN = Math.max(1, Number(process.env.MAX_HISTORY || 5));
    const msgs = await __pgQuery(`
      SELECT chat_id, body
      FROM (
        SELECT chat_id, body,
               row_number() OVER (PARTITION BY chat_id ORDER BY created_at DESC) AS rn
        FROM public.chat_messages
        WHERE direction = 'in'
      ) t
      WHERE rn <= $1
      ORDER BY chat_id, rn DESC
    `, [maxN]);

    for (const m of (msgs || [])) {
      const chatId = String(m.chat_id || "");
      if (!chatId) continue;
      cache[chatId] = cache[chatId] || {
        msgs: []
      };
      cache[chatId].msgs = cache[chatId].msgs || [];
      cache[chatId].msgs.push(String(m.body || "").slice(0, 800));
      if (cache[chatId].msgs.length > maxN) cache[chatId].msgs = cache[chatId].msgs.slice(-maxN);
    }

    __chatCache = cache;
    __chatDBOk = true;
    __chatDBInitErr = null;

    // Inizializza i timestamp LRU per le entry caricate dal DB.
    // Usiamo lastActive se disponibile, altrimenti "now" (così le sessioni
    // inattive da > TTL vengono espulse già al primo cleanup).
    const loadedNow = Date.now();
    for (const [id, entry] of Object.entries(cache)) {
      __chatAccessTime.set(id, entry.lastActive || loadedNow);
    }
    __startChatCleanup();

    try {
      log("info", "[chat] PostgreSQL cache loaded", {
        count: Object.keys(__chatCache).length
      });
    } catch { }
  } catch (e) {
    __chatDBOk = false;
    __chatDBInitErr = e;
    __chatCache = __chatCache || {};
    try {
      log("error", "[chat] PostgreSQL init/load failed", {
        error: String(e?.message || e)
      });
    } catch { }
  }
}

function loadChatDB() {
  return (__chatCache && typeof __chatCache === "object") ? __chatCache : {};
}

/** Aggiorna il timestamp LRU per un chatId specifico (chiamare dopo aver letto/scritto un'entry). */
function touchChatEntry(chatId) {
  __touchChat(chatId);
}

function __scheduleChatFlush() {
  if (!__pgPool) return;
  if (__chatFlushTimer) return;
  __chatFlushTimer = setTimeout(() => {
    __chatFlushTimer = null;
    void __flushChatToPg();
  }, __CHAT_FLUSH_MS);
}

function saveChatDB(db) {
  if (db && typeof db === "object") {
    // Aggiorna i timestamp LRU per tutte le entry presenti nel db salvato.
    // In pratica il chiamante ha già toccato solo poche entry, ma questo
    // garantisce che entry nuove vengano registrate anche se il chiamante
    // non ha chiamato touchChatEntry esplicitamente.
    const now = Date.now();
    for (const id of Object.keys(db)) {
      if (!__chatAccessTime.has(id)) {
        __chatAccessTime.set(id, now);
      }
    }
    __chatCache = db;
  } else {
    __chatCache = {};
  }

  // Evict se sopra soglia (evita accumulo a ogni salvataggio)
  if (Object.keys(__chatCache).length > __CHAT_MAX_ENTRIES) {
    __evictChatCache();
  }

  __scheduleChatFlush();
}

async function __flushChatToPg() {
  if (!__pgPool) return;
  if (__chatFlushInFlight) return;
  __chatFlushInFlight = true;
  try {
    const db = loadChatDB();
    const chatIds = Object.keys(db || {});
    if (chatIds.length === 0) return;

    // upsert per chat (dimensioni piccole -> loop OK)
    for (const chatId of chatIds) {
      const e = db[chatId] || {};
      const phone = e.phone || chatIdToE164(chatId) || chatId;
      const lang = e.lang || "it";

      const firstSeenAt = __toIsoFromMs(e.firstSeenAt) || null;
      const lastActiveAt = __toIsoFromMs(e.lastActive) || null;
      const lastGreetAt = __toIsoFromMs(e.lastGreet) || null;

      const privacyVer = Number(e?.privacy?.version || 0) || null;
      const privacySent = __toIsoFromMs(e?.privacy?.sentAt || 0) || null;

      const lastReviewPromptAt = __toIsoFromMs(e.lastReviewPromptAt || 0) || null;
      const lastReviewPromptEventId = e.lastReviewPromptEventId ? String(e.lastReviewPromptEventId) : null;

      const svcId = e.lastReviewPromptService ?
        (__svcNameToId.get(String(e.lastReviewPromptService)) || null) :
        null;
      const proId = e.lastReviewPromptPro ?
        (__proNameToId.get(String(e.lastReviewPromptPro).toLowerCase()) || null) :
        null;

      const lastReviewReplyAt = __toIsoFromMs(e.lastReviewReplyAt || 0) || null;

      const reminderChoice = (e.reminderChoice === null || typeof e.reminderChoice === "undefined") ?
        null :
        Number(e.reminderChoice);

      await __pgExec(`
        INSERT INTO public.chat_sessions (
          chat_id, phone_e164, lang,
          first_seen_at, last_active_at, last_greet_at,
          privacy_version, privacy_sent_at,
          last_review_prompt_at, last_review_prompt_event_id,
          last_review_prompt_service_id, last_review_prompt_professional_id,
          last_review_reply_at, reminder_choice
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (chat_id) DO UPDATE SET
          phone_e164 = EXCLUDED.phone_e164,
          lang = EXCLUDED.lang,
          first_seen_at = COALESCE(public.chat_sessions.first_seen_at, EXCLUDED.first_seen_at),
          last_active_at = GREATEST(COALESCE(public.chat_sessions.last_active_at, EXCLUDED.last_active_at), EXCLUDED.last_active_at),
          last_greet_at  = GREATEST(COALESCE(public.chat_sessions.last_greet_at, EXCLUDED.last_greet_at), EXCLUDED.last_greet_at),
          privacy_version = COALESCE(EXCLUDED.privacy_version, public.chat_sessions.privacy_version),
          privacy_sent_at = COALESCE(EXCLUDED.privacy_sent_at, public.chat_sessions.privacy_sent_at),
          last_review_prompt_at = COALESCE(EXCLUDED.last_review_prompt_at, public.chat_sessions.last_review_prompt_at),
          last_review_prompt_event_id = COALESCE(EXCLUDED.last_review_prompt_event_id, public.chat_sessions.last_review_prompt_event_id),
          last_review_prompt_service_id = COALESCE(EXCLUDED.last_review_prompt_service_id, public.chat_sessions.last_review_prompt_service_id),
          last_review_prompt_professional_id = COALESCE(EXCLUDED.last_review_prompt_professional_id, public.chat_sessions.last_review_prompt_professional_id),
          last_review_reply_at = COALESCE(EXCLUDED.last_review_reply_at, public.chat_sessions.last_review_reply_at),
          reminder_choice = COALESCE(EXCLUDED.reminder_choice, public.chat_sessions.reminder_choice)
      `, [
        chatId, phone, lang,
        firstSeenAt, lastActiveAt, lastGreetAt,
        privacyVer, privacySent,
        lastReviewPromptAt, lastReviewPromptEventId,
        svcId, proId,
        lastReviewReplyAt, reminderChoice
      ]);
    }
  } catch (e) {
    __chatDBOk = false;
    __chatDBInitErr = e;
    log("warn", "[chat] flush failed", {
      error: String(e?.message || e)
    });
  } finally {
    __chatFlushInFlight = false;
  }
}

async function __dbInsertChatMessage(chatId, direction, body) {
  try {
    if (!__pgPool) return;
    const cid = String(chatId || "");
    if (!cid) return;
    const dir = (direction === "out") ? "out" : "in";
    const txt = String(body ?? "").slice(0, 4000);
    if (!txt.trim()) return;

    // assicura sessione
    await __pgExec(`INSERT INTO public.chat_sessions (chat_id, lang) VALUES ($1, 'it')
                  ON CONFLICT (chat_id) DO NOTHING`, [cid]);

    await __pgExec(
      `INSERT INTO public.chat_messages (chat_id, direction, body) VALUES ($1,$2,$3)`,
      [cid, dir, txt]
    );
  } catch (e) {
    // best-effort
  }
}

let __holdsCache = [];
let __holdsDBOk = false;
let __holdsDBInitErr = null;
let __holdsFlushTimer = null;
let __holdsFlushInFlight = false;
const __HOLDS_FLUSH_MS = Number(process.env.HOLDS_FLUSH_MS || 750);

async function __initHoldsCacheFromPg() {

  if (!__pgPool) {
    __holdsCache = [];
    __holdsDBOk = false;
    __holdsDBInitErr = new Error("pg non configurato");
    return;
  }

  try {
    await __loadIdMaps();

    // scadenze automatiche
    await __pgExec(`
      UPDATE public.appointment_holds
      SET status = 'expired'
      WHERE status='active' AND expires_at <= now()
    `);

    const rows = await __pgQuery(`
      SELECT h.hold_id, h.chat_id,
             (SELECT (pe.email)::text FROM public.professional_emails pe
              WHERE pe.professional_id = h.professional_id
              ORDER BY (pe.email)::text ASC
              LIMIT 1) AS professional_email,
             s.service_name,
             EXTRACT(EPOCH FROM h.start_time) * 1000 AS start_ms,
             EXTRACT(EPOCH FROM h.end_time) * 1000 AS end_ms,
             EXTRACT(EPOCH FROM h.expires_at) * 1000 AS expires_ms
      FROM public.appointment_holds h
      LEFT JOIN public.services s ON s.service_id = h.service_id
      WHERE h.status = 'active' AND h.expires_at > now()
    `);

    __holdsCache = (rows || []).map((r) => ({
      holdId: Number(r.hold_id),
      chatId: String(r.chat_id || ""),
      professionalEmail: String(r.professional_email || ""),
      service: r.service_name ? String(r.service_name) : null,
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      expiresAt: Number(r.expires_ms),
    })).filter((h) => h.chatId && h.professionalEmail && Number.isFinite(h.startMs) && Number.isFinite(h.endMs));

    __holdsDBOk = true;
    __holdsDBInitErr = null;
    try {
      log("info", "[holds] PostgreSQL cache loaded", {
        count: __holdsCache.length
      });
    } catch { }
  } catch (e) {
    __holdsCache = [];
    __holdsDBOk = false;
    __holdsDBInitErr = e;
    try {
      log("error", "[holds] PostgreSQL init/load failed", {
        error: String(e?.message || e)
      });
    } catch { }
  }
}

function loadHolds() {
  return Array.isArray(__holdsCache) ? __holdsCache : [];
}

function __scheduleHoldsFlush() {
  if (!__pgPool) return;
  if (__holdsFlushTimer) return;
  __holdsFlushTimer = setTimeout(() => {
    __holdsFlushTimer = null;
    void __flushHoldsToPg();
  }, __HOLDS_FLUSH_MS);
}

function saveHolds(arr) {
  __holdsCache = Array.isArray(arr) ? arr : [];
  __scheduleHoldsFlush();
}

async function __flushHoldsToPg() {
  if (!__pgPool) return;
  if (__holdsFlushInFlight) return;
  __holdsFlushInFlight = true;
  try {
    await __loadIdMaps();

    // release di tutte le active e reinserimento (bot single-instance)
    await __pgExec(`UPDATE public.appointment_holds
                    SET status='released'
                    WHERE status='active'`);

    const arr = loadHolds().filter((h) => Number(h.expiresAt) > Date.now());
    if (arr.length === 0) return;

    // assicura sessione per i chatId (FK)
    const uniqChats = Array.from(new Set(arr.map((h) => String(h.chatId || "")).filter(Boolean)));
    for (const cid of uniqChats) {
      await __pgExec(`INSERT INTO public.chat_sessions (chat_id, lang) VALUES ($1, 'it')
                      ON CONFLICT (chat_id) DO NOTHING`, [cid]);
    }

    for (const h of arr) {
      const email = String(h.professionalEmail || "").toLowerCase();
      let proId = __proEmailToId.get(email);

      // FIX: fallback per professionist senza email in DB (es. Valentina con email=NULL).
      // Prova a trovare l'ID tramite il nome, oppure usa il primo professionista attivo.
      if (!proId) {
        if (h.professionalName) {
          proId = __proNameToId.get(String(h.professionalName || "").toLowerCase()) || null;
        }
        if (!proId && __pgPool) {
          try {
            // Ultima istanza: primo professionista attivo nel DB
            const rows = await __pgQuery(
              `SELECT professional_id FROM public.professionals WHERE is_active = true ORDER BY professional_id ASC LIMIT 1`
            );
            if (rows && rows[0]) proId = Number(rows[0].professional_id) || null;
          } catch { }
        }
        if (proId) {
          log("debug", "[holds] flush: proId risolto via fallback", {
            email: email || "(vuoto)",
            proId,
            chatId: h.chatId || null
          });
        } else {
          log("warn", "[holds] flush: proId non trovato — nessun professionista nel DB? Hold ignorato", {
            email: email || "(vuoto)",
            chatId: h.chatId || null,
            startMs: h.startMs || null,
            hint: "Aggiungere almeno un professionista in public.professionals",
          });
          continue;
        }
      }

      const svcId = h.service ? (__svcNameToId.get(String(h.service)) || null) : null;

      const sIso = new Date(Number(h.startMs)).toISOString();
      const eIso = new Date(Number(h.endMs)).toISOString();
      const xIso = new Date(Number(h.expiresAt)).toISOString();

      // FIX (holds ON CONFLICT): rimosse le clausole ON CONFLICT che richiedevano
      // un indice btree univoco su (professional_id, start_time), mentre lo schema ha
      // solo un indice GIST di esclusione — incompatibile con ON CONFLICT.
      // Questo INSERT è sicuro senza ON CONFLICT perché l'UPDATE di release qui sopra
      // ha già impostato status='released' su tutti i hold attivi prima del loop.
      await __pgExec(`
        INSERT INTO public.appointment_holds
          (chat_id, professional_id, service_id, start_time, end_time, expires_at, status)
        VALUES ($1,$2,$3,$4,$5,$6,'active')
      `, [String(h.chatId), proId, svcId, sIso, eIso, xIso]);
    }
  } catch (e) {
    __holdsDBOk = false;
    __holdsDBInitErr = e;
    log("warn", "[holds] flush failed", {
      error: String(e?.message || e)
    });
  } finally {
    __holdsFlushInFlight = false;
  }
}

// --- mini lock per chat ---
const __busyChats = new Set();
const __busySince = new Map();
const BUSY_TTL_MS = Number(process.env.BUSY_TTL_MS || 45000);
const __delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ==== Dedupe INGRESSO (anti doppio invio WhatsApp / doppia esecuzione) ====
// Memorizza l’ultimo testo normalizzato per chat e scarta duplicati entro una finestra breve.
const __inputDedup = new Map(); // chatId -> { key, at }
const INPUT_DEDUP_MS = Number(process.env.INPUT_DEDUP_MS || 1500);

function shouldDropIncoming(chatId, text) {
  try {
    const key = _normIncomingForDedup(text);
    if (!key) return false;
    const now = Date.now();
    const prev = __inputDedup.get(chatId);
    if (prev && prev.key === key && now - prev.at <= INPUT_DEDUP_MS) return true;
    __inputDedup.set(chatId, {
      key,
      at: now
    });
    return false;
  } catch {
    return false;
  }
}

const HOLD_MINUTES = Number(process.env.SOFT_HOLD_MIN || 5);

const config = await (typeof GCAL.getRuntimeConfig === "function" ? GCAL.getRuntimeConfig() : (GCAL.config || {}));

//  Numero salone (override con env SALON_PHONE)
const SALON_PHONE = String(process.env.SALON_PHONE || config?.salonPhone || config?.phone || "numero non configurato");

// Verifica file critici
if (!config || typeof config !== "object" || !config.services) {
  log("error", "ATTENZIONE: configurazione non caricata (services mancanti). Controlla Postgres.", {});
}
// ================= PATH & ChatDB =================

// ================= BOOKINGS STORE: PostgreSQL =================
// Cache in RAM: loadBookings() resta SINCRONA per non stravolgere il resto del file.
let __bookingsCache = [];
let __bookingsDBOk = false;
let __bookingsDBInitErr = null;

async function __initBookingsCacheFromPg() {
  try {
    await initBookingsNormDbPg();
    const rows = await listBookingsNormPg();

    // aggiorna IN PLACE (evita reference stale)
    __bookingsCache.length = 0;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (r && typeof r === "object") __bookingsCache.push(r);
      }
    }

    __bookingsDBOk = true;
    __bookingsDBInitErr = null;

    try {
      log("info", "[bookings] PostgreSQL cache loaded", {
        count: __bookingsCache.length
      });
    } catch { }
  } catch (e) {
    __bookingsCache.length = 0;
    __bookingsDBOk = false;
    __bookingsDBInitErr = e;

    try {
      log("error", "[bookings] PostgreSQL init/load failed", {
        error: String(e?.message || e),
      });
    } catch { }
  }
}

// Refresh after an out-of-band Calendar reconciliation. Do not mutate the
// cache if the reload fails without notifying the caller.
export async function refreshBookingsCache() {
  await __initBookingsCacheFromPg();
  if (!__bookingsDBOk) throw __bookingsDBInitErr || new Error('Booking cache refresh failed');
  return __bookingsCache.length;
}

export async function refreshServicesCache(){
  await __initServicesCacheFromPg();
  if(!__servicesDBOk) throw __servicesDBInitErr || new Error('Service cache unavailable');
  return __servicesListCache.length;
}

// init (best-effort). Se Postgres è giù, il bot NON deve creare prenotazioni (persistBooking fallirà e farà rollback).
await __initBookingsCacheFromPg();
await __initServicesCacheFromPg();
await __initChatCacheFromPg();
await __initHoldsCacheFromPg();
if (process.env.NODE_ENV === 'production' &&
  (!__bookingsDBOk || !__servicesDBOk || !__chatDBOk || !__holdsDBOk)) {
  throw new Error('Database runtime non pronto: verificare connessione e migrazioni prima del deploy');
}

// === Warm-up Ollama (QA + intent) ===
// Best-effort: non blocca il boot se Ollama non è disponibile.
try {
  // Non usare await: avvio immediato e warming in background.
  warmModels?.().catch?.(() => { });
} catch { }

const CANCEL_POLICY_HOURS = 3;

// === NEW: re-entry scheduler to avoid lock recursion ===
function scheduleReenter(...args) {
  return __modules["conversation/helpers"].scheduleReenter(...args);
}

// Lingua della conversazione e traduzione dei messaggi (IT/EN)


function formatDateWithWeekdayIT(...args) {
  return __modules["conversation/helpers"].formatDateWithWeekdayIT(...args);
}

function isUrgencyMessage(...args) {
  return __modules["conversation/intent"].isUrgencyMessage(...args);
}

function detectLangHeuristic(...args) {
  return __modules["conversation/intent"].detectLangHeuristic(...args);
}

function getLang(...args) {
  return __modules["conversation/intent"].getLang(...args);
}

function setLang(...args) {
  return __modules["conversation/intent"].setLang(...args);
}

function ensureLang(...args) {
  return __modules["conversation/intent"].ensureLang(...args);
}

function tr(...args) {
  return __modules["conversation/intent"].tr(...args);
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

function _asBookingsArray(...args) {
  return __modules["booking/persistence"]._asBookingsArray(...args);
}

function loadBookings(...args) {
  return __modules["booking/persistence"].loadBookings(...args);
}


// Tutte le scritture sulle prenotazioni transitano dal medesimo upsert
// transazionale in storage/bookings-norm-pg.js. Nessun percorso alternativo.
async function saveBookings(...args) {
  return __modules["booking/persistence"].saveBookings(...args);
}

// Retry solo per problemi di connessione / transazioni transienti.
// La coda in memoria e' limitata; per garanzie di durabilita' serve un outbox.
const __pgWriteQueue = [];
const __PG_RETRY_MS = Number(process.env.PG_RETRY_MS || 30_000);
const __MAX_RETRY_ITEMS = 500;
let __retryBusy = false;

function enqueueBookingsForRetry(...args) {
  return __modules["booking/persistence"].enqueueBookingsForRetry(...args);
}

async function __drainPgWriteQueue(...args) {
  return __modules["booking/persistence"].__drainPgWriteQueue(...args);
}

if (__pgPool) {
  const retryTimer = setInterval(() => {
    __drainPgWriteQueue().catch(e => log('error', '[bookings] Retry fallito', { code: e?.code || 'unknown' }));
  }, __PG_RETRY_MS);
  retryTimer.unref();
}

function _bkDigits(...args) {
  return __modules["booking/persistence"]._bkDigits(...args);
}

function _bkPhoneKey(...args) {
  return __modules["booking/persistence"]._bkPhoneKey(...args);
}

function _bkToISO(...args) {
  return __modules["booking/persistence"]._bkToISO(...args);
}

function _bkEnsureTimes(...args) {
  return __modules["booking/persistence"]._bkEnsureTimes(...args);
}

async function persistBooking(...args) {
  return __modules["booking/persistence"].persistBooking(...args);
}

async function updateBookingByEventId(...args) {
  return __modules["booking/persistence"].updateBookingByEventId(...args);
}

async function updateBookingByComposite(...args) {
  return __modules["booking/persistence"].updateBookingByComposite(...args);
}

export function getUpcomingBookingByPhone(...args) {
  return __modules["booking/persistence"].getUpcomingBookingByPhone(...args);
}

function getUserActiveBookingsAll(...args) {
  return __modules["booking/persistence"].getUserActiveBookingsAll(...args);
}

async function markBookingCancelled(...args) {
  return __modules["booking/persistence"].markBookingCancelled(...args);
}

function cleanupHolds(...args) {
  return __modules["booking/holds"].cleanupHolds(...args);
}

function getHoldIntervalsForDay(...args) {
  return __modules["booking/holds"].getHoldIntervalsForDay(...args);
}

function slotOverlapsExistingBookings(...args) {
  return __modules["booking/persistence"].slotOverlapsExistingBookings(...args);
}
//  FIX Bug #3: Lock atomico per prevenire race condition
const __holdLock = new Map(); // chatId => Promise
const HOLD_LOCK_TIMEOUT = 5000;

async function __withHoldLock(...args) {
  return __modules["booking/holds"].__withHoldLock(...args);
}

function acquireSoftHold(...args) {
  return __modules["booking/holds"].acquireSoftHold(...args);
}

function releaseSoftHoldByChat(...args) {
  return __modules["booking/holds"].releaseSoftHoldByChat(...args);
}

//  FIX Bug #7: Wrapper per garantire rilascio hold
async function __withAutoReleaseHold(...args) {
  return __modules["booking/holds"].__withAutoReleaseHold(...args);
}

// ================= Review & Confirm followups =================

// Memorizza su chatdb che abbiamo appena chiesto il feedback (serve per non avviare flow di prenotazione se l'utente risponde "grazie", "tutto ok", ecc.)
function __rememberReviewPrompt(...args) {
  return __modules["booking/notifications"].__rememberReviewPrompt(...args);
}

function __markReviewReplied(...args) {
  return __modules["booking/notifications"].__markReviewReplied(...args);
}

function __isBookingIntentText(...args) {
  return __modules["conversation/intent"].__isBookingIntentText(...args);
}

function __looksLikeReviewAnswer(...args) {
  return __modules["conversation/intent"].__looksLikeReviewAnswer(...args);
}
// Se l'utente sta rispondendo a "Com'è andata ...", rispondi e STOP (senza avviare prenotazione)
async function maybeHandleReviewReply(...args) {
  return __modules["booking/notifications"].maybeHandleReviewReply(...args);
}



export async function reviewFollowupsTick(...args) {
  return __modules["booking/notifications"].reviewFollowupsTick(...args);
}



/**
 * Invia i promemoria quando l'inizio dell'appuntamento cade nella finestra
 * [ora + leadMinutes - windowMinutes, ora + leadMinutes + windowMinutes].
 * La finestra tollera ritardi del ciclo; il flag persistente evita reinvii ordinari.
 */
export async function confirmAppointmentsTick(...args) {
  return __modules["booking/notifications"].confirmAppointmentsTick(...args);
}

// ============ PROFESSIONALI: catalogo, prompt, parsing ============

// Normalizza stringhe brevi (riusa la tua simpleNorm/norm)
const _n = (s) => simpleNorm(String(s || "")).trim();
const _tok = (s) => _n(s).split(/\s+/).filter(Boolean);

//  Tutti i professionisti attivi dal DB (fonte di verità).
// Restituisce [{name, email, professional_id, hasRealEmail}].
// Usato ovunque al posto di config.professionals per evitare dati stale da gcal config.
function __dbAllPros(...args) {
  return __modules["catalog/services"].__dbAllPros(...args);
}

// Ritorna l'elenco dei pro validi per il servizio (se configurati), altrimenti tutti
function proCatalog(...args) {
  return __modules["catalog/services"].proCatalog(...args);
}

// Prompt numerato (0 = nessuna preferenza)
function renderProPrompt(...args) {
  return __modules["catalog/services"].renderProPrompt(...args);
}

// Parsing risposta utente -> { any:true } oppure {email,name} oppure null se invalida
function resolveProReply(...args) {
  return __modules["catalog/services"].resolveProReply(...args);
}

// Mostra la domanda (mai testo libero)
function askProfessional(...args) {
  return __modules["catalog/services"].askProfessional(...args);
}

// ======================= PRIVACY (onboarding) =======================
// Invia una breve informativa privacy al primo messaggio (una sola volta per numero).
// Nota: testo generico - personalizzalo con i dati del tuo salone/contatti se vuoi.
const PRIVACY_NOTICE_VERSION = 1;

function chatIdToE164(...args) {
  return __modules["conversation/privacy"].chatIdToE164(...args);
}

function privacyNoticeTextIT(...args) {
  return __modules["conversation/privacy"].privacyNoticeTextIT(...args);
}

function privacyNoticeTextEN(...args) {
  return __modules["conversation/privacy"].privacyNoticeTextEN(...args);
}

function getPrivacyText(...args) {
  return __modules["conversation/privacy"].getPrivacyText(...args);
}

function isGroupChatId(...args) {
  return __modules["conversation/privacy"].isGroupChatId(...args);
}

function chatdbDeleteEntry(...args) {
  return __modules["conversation/privacy"].chatdbDeleteEntry(...args);
}

function markPrivacySent(...args) {
  return __modules["conversation/privacy"].markPrivacySent(...args);
}

async function maybeSendPrivacyNotice(...args) {
  return __modules["conversation/privacy"].maybeSendPrivacyNotice(...args);
}

function privacyCommandKind(...args) {
  return __modules["conversation/privacy"].privacyCommandKind(...args);
}
// ===================== END PRIVACY =====================

function appendUserMessage(...args) {
  return __modules["conversation/privacy"].appendUserMessage(...args);
}

function getRecentMessages(...args) {
  return __modules["conversation/privacy"].getRecentMessages(...args);
}

function getLastService(...args) {
  return __modules["conversation/privacy"].getLastService(...args);
}

function getLastInfoTopic(...args) {
  return __modules["conversation/privacy"].getLastInfoTopic(...args);
}

function rememberService(...args) {
  return __modules["conversation/privacy"].rememberService(...args);
}

function rememberInfoTopic(...args) {
  return __modules["conversation/privacy"].rememberInfoTopic(...args);
}

// ============== Safe send & reply (+ booking footer) ==============
// Dedup messaggi identici consecutivi (riduce spam quando due reply uguali finiscono uno dopo l'altro)
const __SEND_DEDUP = new Map(); // chatId -> { text, at }
function __dedupAllow(...args) {
  return __modules["conversation/transport"].__dedupAllow(...args);
}

function __dedupRemember(...args) {
  return __modules["conversation/transport"].__dedupRemember(...args);
}

// Footer cooldown (per non mandare 2 footer identici a raffica)
const __FOOTER_COOLDOWN = new Map(); // chatId -> lastAt
export async function safeSend(...args) {
  return __modules["conversation/transport"].safeSend(...args);
}

// wrapper usato ovunque nel flow
async function reply(...args) {
  return __modules["conversation/transport"].reply(...args);
}
// === Footer automatico per il flow booking ===
async function postReplyHook(...args) {
  return __modules["conversation/transport"].postReplyHook(...args);
}

// ============== QA Adapter (Ollama/injection) ==============
let QA_ASK = null;
let GREET_COOLDOWN_MS = 180000;
export function configure({
  qaAsk,
  greetCooldownMs
} = {}) {
  if (qaAsk) QA_ASK = qaAsk;
  if (greetCooldownMs) GREET_COOLDOWN_MS = greetCooldownMs;
}
// === MISSING HELPERS (drop-in) ===============================================

// ISO locale senza "Z" (coerente con Google Calendar wrappers)

// Giorni del mese (year = intero, monthIdx = 0..11)

// Etichetta mese in italiano

// Nome giorno settimana in italiano

// Lunedì..Domenica della *prossima* settimana (a mezzogiorno per neutralizzare i fusi)

// Prompt testuale quando chiedi “che giorno di <mese>?”

// Vuole aprire il menu "modifica appuntamento"?
function wantsEditMenu(...args) {
  return __modules["conversation/intent"].wantsEditMenu(...args);
}
// Estrai “topic” informativo minimale dalla frase (per guidare il prompt QA)
function extractInfoTopic(...args) {
  return __modules["conversation/intent"].extractInfoTopic(...args);
}

// Costruisci un prompt pulito per askQA (Ollama)
function composeInfoPrompt(...args) {
  return __modules["conversation/intent"].composeInfoPrompt(...args);
}

function baseCandidates(...args) {
  return __modules["conversation/intent"].baseCandidates(...args);
}

// ============== QA Adapter (Ollama/injection) ==============
/** Compatibility adapter for older information flows. Never forward raw chat tools.
 * Prefer answerServiceQuestion with a configured catalog entry in new callers.
 */
export async function askQA(prompt, context, client) {
  if (typeof QA_ASK === 'function') return String(await QA_ASK(prompt, context, client) || '');
  if (!context?.facts) return '';
  return (await answerServiceQuestion({ question: String(prompt || ''), facts: context.facts })) || '';
}

/** Optional, bounded Ollama preload. A missing model must not block startup. */
export async function warmOllama() {
  if (!isAIEnabled() || process.env.AI_INFO_ENABLED !== '1') return false;
  const model = String(process.env.OLLAMA_INFO_MODEL || process.env.OLLAMA_MODEL || '').trim();
  if (!model) return false;
  try {
    await postOllama('/api/generate', {
      model, prompt: 'ok', stream: false, keep_alive: '10m',
      options: { num_predict: 2, temperature: 0 },
    }, { timeoutMs: Number(process.env.OLLAMA_WARM_TIMEOUT_MS || 15000) });
    return true;
  } catch (error) {
    log('warn', 'ollama_info_warmup_unavailable', { code: error.code || 'unavailable' });
    return false;
  }
}

function __intentHeuristicOverride(...args) {
  return __modules['conversation/intent'].__intentHeuristicOverride(...args);
}

export async function warmOllamaIntent() {
  if (!isAIEnabled() || process.env.AI_INTENT_ENABLED !== '1') return false;
  const model = String(process.env.OLLAMA_INTENT_MODEL || process.env.OLLAMA_MODEL || '').trim();
  if (!model) return false;
  try {
    await postOllama('/api/generate', {
      model, prompt: 'ok', stream: false, keep_alive: '10m',
      options: { num_predict: 2, temperature: 0 },
    }, { timeoutMs: Number(process.env.OLLAMA_WARM_INTENT_TIMEOUT_MS || 15000) });
    return true;
  } catch (error) {
    log('warn', 'ollama_intent_warmup_unavailable', { code: error.code || 'unavailable' });
    return false;
  }
}

export async function warmModels() {
  const results = await Promise.allSettled([warmOllama(), warmOllamaIntent()]);
  return results.map(result => result.status === 'fulfilled' && result.value === true);
}

async function classifyIntent(userText) {
  return pickIntent(userText, { heuristic: __intentHeuristicOverride });
}

// ============== Stato conversazione ==============

const pending = new Map();
const greetMemory = new Map(); // chatId -> ts ultimo saluto

const BOOKING_LOCK_MS = 10 * 60 * 1000; // 10 minuti
function now(...args) {
  return __modules["conversation/state"].now(...args);
}

function lockBooking(...args) {
  return __modules["conversation/state"].lockBooking(...args);
}
// === Controllo compatibilità tra professionista e servizio ===
async function validateProfessionalForService(...args) {
  return __modules["conversation/state"].validateProfessionalForService(...args);
}

function ensureContext(...args) {
  return __modules["conversation/state"].ensureContext(...args);
}

/**
 * Ritorna true se la prenotazione è attualmente lockata e il lock è ancora valido.
 * Se il lock è corrotto o scaduto lo resetta in automatico e ritorna false.
 */
function isBookingLocked(...args) {
  return __modules["conversation/state"].isBookingLocked(...args);
}

/**
 * Aggiorna/crea il lock sulla prenotazione.
 * Puoi passare opzionalmente un oggetto meta (es. { owner: chatId, reason: 'booking' }).
 */
function bumpBookingLock(...args) {
  return __modules["conversation/state"].bumpBookingLock(...args);
}

/**
 * Sblocca esplicitamente la prenotazione.
 * Puoi passare un motivo per debugging (reason).
 */
function unlockBooking(...args) {
  return __modules["conversation/state"].unlockBooking(...args);
}

function isBookingFlowActive(...args) {
  return __modules["conversation/state"].isBookingFlowActive(...args);
}

// ============== Utility: parsing e vari ==============

// "domenica 28 dicembre 2025"
// Ritorna true se il professionista è OFF per tutta la giornata (da config.unavailability)
function isProfessionalOffFullDay(...args) {
  return __modules["booking/availability"].isProfessionalOffFullDay(...args);
}

/**
 * Formatta una durata in minuti.
 * - < 60  -> "45 min"
 * - = 60  -> "1h"
 * - > 60  -> "1h 30min"
 */

// ---- NEW: interpreta "11 dicembre", "11-12" come intervallo orario se il contesto sembra tempo ----

// modifica parseTimeSmart per provare anche il fallback degli intervalli

function nextOpenDay(...args) {
  return __modules["booking/availability"].nextOpenDay(...args);
}

// ============== Riconoscimento servizio ==============
// Catalogo servizi: fonte di verità = PostgreSQL (public.services, service_synonyms, professional_services).
// Se la tabella è vuota, il listino risulta vuoto (niente fallback a config.services).
function cfgServices(...args) {
  return __modules["catalog/services"].cfgServices(...args);
}

function cfgServiceItem(...args) {
  return __modules["catalog/services"].cfgServiceItem(...args);
}

function cfgServiceSynonyms(...args) {
  return __modules["catalog/services"].cfgServiceSynonyms(...args);
}

function cfgServiceDuration(...args) {
  return __modules["catalog/services"].cfgServiceDuration(...args);
}

function cfgServiceProfessionals(...args) {
  return __modules["catalog/services"].cfgServiceProfessionals(...args);
}

function cfgServicePriceText(...args) {
  return __modules["catalog/services"].cfgServicePriceText(...args);
}

// ============================================================================
// GLOBAL HELPERS: servizi per professionista + intent/entity per REVIEW INTAKE
// (serve per evitare ReferenceError in handleNumericReply/review_intake)
// ============================================================================

function proNameByEmailSafe(...args) {
  return __modules["catalog/services"].proNameByEmailSafe(...args);
}

function serviceProsEmails(...args) {
  return __modules["catalog/services"].serviceProsEmails(...args);
}

function isServiceAvailableForPro(...args) {
  return __modules["catalog/services"].isServiceAvailableForPro(...args);
}

function getDurForPro(...args) {
  return __modules["catalog/services"].getDurForPro(...args);
}

// ==== LISTINO: raggruppa trattamenti per "tipo" usando Levenshtein (typo-safe) ====
// Nota: la "chiave" di gruppo viene stimata da token del nome (es: ricostruzione, refill, pedicure, semipermanente...).
// Levenshtein serve per unire refusi tipo refill/reffil/refil.
const __SVC_GROUP_STOPWORDS = new Set([
  "di", "da", "del", "della", "dei", "delle",
  "a", "al", "allo", "alla", "alle", "all",
  "in", "nel", "nello", "nella", "nei", "negli", "nelle",
  "per", "con", "su", "sul", "sulla", "sui", "sugli", "sulle",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
  "e", "ed", "o"
]);

// Niente lista fissa: i gruppi vengono derivati per similarita' (Levenshtein) dai nomi reali.
const __SVC_GROUP_PREFERRED = null;

function __svcCleanLabelForGrouping(...args) {
  return __modules["catalog/services"].__svcCleanLabelForGrouping(...args);
}

function __svcMaxDistToken(...args) {
  return __modules["catalog/services"].__svcMaxDistToken(...args);
}

function __svcKeysClose(...args) {
  return __modules["catalog/services"].__svcKeysClose(...args);
}

function __svcGroupKeyFromLabel(...args) {
  return __modules["catalog/services"].__svcGroupKeyFromLabel(...args);
}

function __svcTokensFromLabel(...args) {
  return __modules["catalog/services"].__svcTokensFromLabel(...args);
}

// Sceglie un "anchor token" data-driven: evita token troppo comuni e troppo rari
function __svcAnchorFromTokens(...args) {
  return __modules["catalog/services"].__svcAnchorFromTokens(...args);
}

// Raggruppa SOLO per similarita' (Levenshtein) su anchor token derivati dai label reali
function groupServicesByType(...args) {
  return __modules["catalog/services"].groupServicesByType(...args);
}

// Raggruppa per categoria (fonte: service_categories -> services.category_id).
// Ordine: category_display_order (DB) poi titolo; servizi: displayOrder poi label.
function groupServicesByCategory(...args) {
  return __modules["catalog/services"].groupServicesByCategory(...args);
}
// ==== LISTINO numerato (serve per scelta via 1-N) ====
function buildServicesMessageForPro(...args) {
  return __modules["catalog/services"].buildServicesMessageForPro(...args);
}

// ---------------- REVIEW INTAKE: intent (sinonimi menu) ----------------
const __REVIEW_MENU_INTENTS = [{
  action: "cancel",
  re: /\b(annulla|annula|cancel|stop|fine|esci)\b/i
},
{
  action: "continue",
  re: /\b(continua|procedi|avanti|ok|okay|va\s*bene|conferma|confermo|confermato|perfetto|si|sì|yes)\b/i
},
{
  action: "edit_service",
  re: /\b(trattament\w*|servizi?\b|cambia\s+(?:trattament\w*|servizi?)|modifica\s+(?:trattament\w*|servizi?))\b/i
},
{
  action: "edit_professional",
  re: /\b(professionist\w*|operatric\w*|tecnic\w*|cambia\s+professionist\w*|modifica\s+professionist\w*)\b/i
},
{
  action: "edit_when",
  re: /\b(giorno\b|data\b|quando\b|cambia\s+(?:giorno|data)|modifica\s+(?:giorno|data))\b/i
},
{
  action: "edit_time",
  re: /\b(orario\b|ora\b|cambia\s+orar\w*|modifica\s+orar\w*)\b/i
},
];

function resolveReviewMenuIntent(...args) {
  return __modules["booking/notifications"].resolveReviewMenuIntent(...args);
}

// ---------------- REVIEW INTAKE: entity extractor (slot filling) ----------------
function extractReviewEntities(...args) {
  return __modules["booking/notifications"].extractReviewEntities(...args);
}

function cfgAllergensForService(...args) {
  return __modules["catalog/services"].cfgAllergensForService(...args);
}

function getAllergens(...args) {
  return __modules["catalog/services"].getAllergens(...args);
}

function fuzzyService(...args) {
  return __modules["catalog/services"].fuzzyService(...args);
}

function resolveServiceFromText(...args) {
  return __modules["catalog/services"].resolveServiceFromText(...args);
}

// ===== Booking intent detectors =====

function looksLikeBooking(...args) {
  return __modules["conversation/intent"].looksLikeBooking(...args);
}

// ============== Orari: calcolo slot con pro per slot ==============
function intervalsFromSpec(...args) {
  return __modules["booking/availability"].intervalsFromSpec(...args);
}

function getBusyIntervalsForDay(...args) {
  return __modules["booking/availability"].getBusyIntervalsForDay(...args);
}

// === NEW === Slot SOLO per un professionista (rispetta orari, pause, indisponibilità e booking del pro)
export async function fetchSlotsForProfessional(...args) {
  return __modules["booking/availability"].fetchSlotsForProfessional(...args);
}

async function fetchSlots(...args) {
  return __modules["booking/availability"].fetchSlots(...args);
}

export async function fetchSlotsWithPros(...args) {
  return __modules["booking/availability"].fetchSlotsWithPros(...args);
}
// ============== Allergie ==============
function extractAllergensFromText(...args) {
  return __modules["conversation/helpers"].extractAllergensFromText(...args);
}

function parseAllergyInfo(...args) {
  return __modules["conversation/helpers"].parseAllergyInfo(...args);
}

// ============== Saluti & affini ==============
function wantsAffectionReply(...args) {
  return __modules["conversation/helpers"].wantsAffectionReply(...args);
}

function greetCTA(...args) {
  return __modules["conversation/helpers"].greetCTA(...args);
}

// ============== Helpers vari ==============
function filterSlotsByWindow(...args) {
  return __modules["booking/availability"].filterSlotsByWindow(...args);
}

function getDaypartBoundaries(...args) {
  return __modules["booking/availability"].getDaypartBoundaries(...args);
}

function groupSlotsByDaypart(...args) {
  return __modules["booking/availability"].groupSlotsByDaypart(...args);
}

function phoneFromChatId(...args) {
  return __modules["conversation/helpers"].phoneFromChatId(...args);
}
export function proNameByEmail(...args) {
  return __modules["catalog/services"].proNameByEmail(...args);
}

function findProfessionalCandidatesByText(...args) {
  return __modules["catalog/services"].findProfessionalCandidatesByText(...args);
}

function proEmailByName(...args) {
  return __modules["catalog/services"].proEmailByName(...args);
}

function extractCustomerName(...args) {
  return __modules["conversation/helpers"].extractCustomerName(...args);
}

// ============== Build QA prompt (placeholder) ==============
function buildQAPromptWithMemory(...args) {
  return __modules["conversation/helpers"].buildQAPromptWithMemory(...args);
}

// ============== Google Calendar wrappers ==============
function _digitsPhone(...args) {
  return __modules["conversation/helpers"]._digitsPhone(...args);
}

/*
 * Wrapper compatibile con gcal.js:createCalendarEvent
 * - Normalizza telefono
 * - Mappa notes -> serviceDetails
 * - Passa professionalName, clientName, allergies/allergic
 */
async function makeEvent(...args) {
  return __modules["booking/calendar"].makeEvent(...args);
}

// === definizione di updateEventSafe (nuova) ===
async function updateEventSafe(...args) {
  return __modules["booking/calendar"].updateEventSafe(...args);
}

async function cancelEventSafe(...args) {
  return __modules["booking/calendar"].cancelEventSafe(...args);
}

// ========================= EDIT HELPERS (incolla SOPRA a handleMessage) =========================
function _editParseNewDate(...args) {
  return __modules["booking/edit"]._editParseNewDate(...args);
}

async function startEditDate(...args) {
  return __modules["booking/edit"].startEditDate(...args);
}

// Durata del servizio con fallback a 30'
function _editDuration(...args) {
  return __modules["booking/edit"]._editDuration(...args);
}

// Elenco nomi professionisti per un servizio (prima quelli del servizio, poi fallback a tutti)
function _editListProNamesForService(...args) {
  return __modules["booking/edit"]._editListProNamesForService(...args);
}

// Estrarre il "giorno" dall'appuntamento (ora a mezzogiorno per neutralizzare i fusi)
function _editDayFromBooking(...args) {
  return __modules["booking/edit"]._editDayFromBooking(...args);
}

// Copia i dati base della prenotazione dentro state.collected
function _editSnapshotStateFromBooking(...args) {
  return __modules["booking/edit"]._editSnapshotStateFromBooking(...args);
}

// Formattare lista orari (mai numerata)
function _editFormatTimeList(...args) {
  return __modules["booking/edit"]._editFormatTimeList(...args);
}

// Render slot list (supporta oggetti {time, pros:[{name}]} oppure stringhe 'HH:MM')
function renderSlotsList(...args) {
  return __modules["booking/edit"].renderSlotsList(...args);
}

// ISO helper: usa toISOStringLocal se presente, altrimenti ISO standard
function _toISO(...args) {
  return __modules["booking/edit"]._toISO(...args);
}

// Slot disponibili per (servizio, giorno, durata, professionista)
// Ritorna array di stringhe 'HH:MM' ordinate
async function _editFetchTimes(...args) {
  return __modules["booking/edit"]._editFetchTimes(...args);
}

// Aggiorna "Nome: ..." nelle note dell'evento (sostituisce o aggiunge la riga)
function _editComputeNewNotes(...args) {
  return __modules["booking/edit"]._editComputeNewNotes(...args);
}

/*
 * - newStartISO: ISO string nuova data/ora (se null -> non cambia)
 * - newProEmail: email nuovo professionista (se null -> non cambia)
 * - newName: nuovo nome cliente (se null -> non cambia)
 */
async function _editApplyUpdate(...args) {
  return __modules["booking/edit"]._editApplyUpdate(...args);
}

// Riconosce domande informative (robusto anche senza "?")
function looksLikeInfoQuestion(...args) {
  return __modules["conversation/helpers"].looksLikeInfoQuestion(...args);
}

// Ci sono step “critici” in cui NON interrompiamo con l’info (es. l’utente sta selezionando un numero)
function isInCriticalStep(...args) {
  return __modules["conversation/state"].isInCriticalStep(...args);
}

// ==== Watchdog: coerenza stato (auto-recupero senza far scrivere "annulla") ====
function ensureValidState(...args) {
  return __modules["conversation/state"].ensureValidState(...args);
}

// ==== Chiede SOLO quello che manca (helper usabile anche per "stato") ====
function firstMissingField(...args) {
  return __modules["conversation/state"].firstMissingField(...args);
}

async function promptResumeStep(...args) {
  return __modules["conversation/state"].promptResumeStep(...args);
}

async function startEditTime(...args) {
  return __modules["booking/edit"].startEditTime(...args);
}

async function startEditProfessional(...args) {
  return __modules["booking/edit"].startEditProfessional(...args);
}

async function startEditName(...args) {
  return __modules["booking/edit"].startEditName(...args);
}

// ========= Heuristics di intent (semplici ma robusti) =========
function hasBookingVerb(...args) {
  return __modules["conversation/intent"].hasBookingVerb(...args);
}

function hasDateOrTime(...args) {
  return __modules["conversation/intent"].hasDateOrTime(...args);
}

function scoreInfoIntent(...args) {
  return __modules["conversation/intent"].scoreInfoIntent(...args);
}

function scoreBookingIntent(...args) {
  return __modules["conversation/intent"].scoreBookingIntent(...args);
}

function primaryIntent(...args) {
  return __modules["conversation/intent"].primaryIntent(...args);
}

// ========= parseAvailabilityRequest (minimale, safe) =========
function parseAvailabilityRequest(...args) {
  return __modules["conversation/intent"].parseAvailabilityRequest(...args);
}

// ===================== HYBRID INTENT (regex + fuzzy) =====================
// === INTENT HYBRID PATTERNS - versione corretta ===
const HYBRID_PATTERNS = {
  booking: {
    // Verbi/indizi di nuova prenotazione
    regex: /\b(prenota(?:re)?|volevo\s+prenotare|vorrei\s+prenotare|voglio\s+prenotare|mi\s+serve\s+prenotare|voglio\s+(?:un\s+)?appuntamento|vorrei\s+(?:un\s+)?appuntamento|mi\s+serve\s+(?:un\s+)?appuntamento|fissa(?:re)?\s+(?:un\s+)?appuntamento|metti(?:\s+un)?\s+appuntamento|blocca(?:re)?\s+un\s+posto)\b/iu,
    weight: 6,
  },
  // ... lascia invariati gli altri (ma se vedi "..." rimuovili allo stesso modo)
};

// tokenizzazione “semplice” coerente con il resto
function tokens(...args) {
  return __modules["conversation/intent"].tokens(...args);
}

// similarità Levenshtein normalizzata (0..1)
function simRatio(...args) {
  return __modules["conversation/intent"].simRatio(...args);
}

// fuzzy “contains”: verifica copertura token + finestra scorrevole
function fuzzyContains(...args) {
  return __modules["conversation/intent"].fuzzyContains(...args);
}

function hasAnyRegex(...args) {
  return __modules["conversation/intent"].hasAnyRegex(...args);
}

function fuzzyAny(...args) {
  return __modules["conversation/intent"].fuzzyAny(...args);
}

// Segnali extra già presenti nel file
function hasAnyDateOrTime(...args) {
  return __modules["conversation/intent"].hasAnyDateOrTime(...args);
}

// -------------- INTENT PRINCIPALE (ibrido) ----------------
function intentByHybrid(...args) {
  return __modules["conversation/intent"].intentByHybrid(...args);
}

function hasFutureBookingsForPhone(...args) {
  return __modules["booking/persistence"].hasFutureBookingsForPhone(...args);
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
function proShort(...args) {
  return __modules["conversation/helpers"].proShort(...args);
}

function normalizeSlotsDetail(...args) {
  return __modules["booking/availability"].normalizeSlotsDetail(...args);
}

// Normalizza oggetto professionista accettando stringhe o oggetti vari
function normalizePro(...args) {
  return __modules["booking/availability"].normalizePro(...args);
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

function labelProsForSlot(...args) {
  return __modules["booking/availability"].labelProsForSlot(...args);
}

async function askInfoWhichService(...args) {
  return __modules["conversation/helpers"].askInfoWhichService(...args);
}

function parseDurationEnv(...args) {
  return __modules["booking/availability"].parseDurationEnv(...args);
} //

function ensureUI(...args) {
  return __modules["conversation/state"].ensureUI(...args);
}

function formatBusinessHours(...args) {
  return __modules["booking/availability"].formatBusinessHours(...args);
}
// Pattern espansi per ringraziamenti e chiusura cortese
const COURTESY_PATTERNS = [
  /^(grazie|grazie mille|grazie infinite|ti ringrazio|grazie di tutto|grazie tanto)[\s!.]*/i,
  /^(thanks?|thank you|thx|ty)[\s!.]*/i,
  /^(ok|okay|va bene|perfetto|ottimo)[\s!.]*/i,
  /^(tutto ok|tutto bene|tutto chiaro|tutto a posto)[\s!.]*/i,
  /^(buone feste|buon natale|felice anno nuovo|buon\s+\w+)[\s!.]*/i,
];

// Risposte randomizzate
const COURTESY_RESPONSES = [
  "Grazie a te! ",
  "Prego, sempre a disposizione! ",
  "Figurati! A presto ",
  "Con piacere! ",
  "È stato un piacere aiutarti! ",
  "A presto! "
];

function buildReviewIntakePrompt(...args) {
  return __modules["booking/notifications"].buildReviewIntakePrompt(...args);
}

// ======================= Day/month confirm (evita errori tipo "giovedì 18" senza mese) =======================
function __cap(...args) {
  return __modules["booking/notifications"].__cap(...args);
}

function __weekdayIdxFromIT(...args) {
  return __modules["conversation/intent"].__weekdayIdxFromIT(...args);
}

function __findNextValidMonthDay(...args) {
  return __modules["conversation/intent"].__findNextValidMonthDay(...args);
}

function __nextWeekdayDate(...args) {
  return __modules["conversation/intent"].__nextWeekdayDate(...args);
}

function __buildDayMonthConfirmFromText(...args) {
  return __modules["conversation/intent"].__buildDayMonthConfirmFromText(...args);
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
export async function handleMessage(...args) {
  return __modules["conversation/handle-message"].handleMessage(...args);
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
export async function handleNumericReply(...args) {
  return __modules["conversation/handle-numeric-reply"].handleNumericReply(...args);
}

// ==== Stato conversazione (export compat) ====
export function getState(...args) {
  return __modules["conversation/state"].getState(...args);
}

export function resetState(...args) {
  return __modules["conversation/state"].resetState(...args);
}

function setState(...args) {
  return __modules["conversation/state"].setState(...args);
}
// === MENU EDIT HELPERS ===
function _fmtBookingLine(...args) {
  return __modules["booking/edit"]._fmtBookingLine(...args);
}

function showEditMenu(...args) {
  return __modules["booking/edit"].showEditMenu(...args);
}

function renderEditBookingList(...args) {
  return __modules["booking/edit"].renderEditBookingList(...args);
}

async function startEditChooseBooking(...args) {
  return __modules["booking/edit"].startEditChooseBooking(...args);
}

function parseExplicitMention(...args) {
  return __modules["conversation/helpers"].parseExplicitMention(...args);
}

function _servicesForIntent(...args) {
  return __modules["catalog/services"]._servicesForIntent(...args);
}

function bestServiceScored(...args) {
  return __modules["catalog/services"].bestServiceScored(...args);
}

const REFILL_PAT =
  /\b(re[\s-]?fill|refil{1,2}|ritocco|ribilanciamento|manutenzione)\b.*\b(gel|ricostruzione)?\b/i;

/* Risolve il servizio dal testo con priorità alle menzioni esplicite. */
export function resolveServiceIntent(...args) {
  return __modules["catalog/services"].resolveServiceIntent(...args);
}
let __lastReminderSlotKey = ""; // evita doppio invio nello stesso slot (runtime)

function normalizeRecipientId(...args) {
  return __modules["conversation/helpers"].normalizeRecipientId(...args);
}

function floorToHalfHour(...args) {
  return __modules["conversation/helpers"].floorToHalfHour(...args);
}

function slotKey(...args) {
  return __modules["conversation/helpers"].slotKey(...args);
}

// Tick “a slot”: se ora è 09:30 -> target = domani 09:30..10:00
export async function remind24hTick(sendFn, opts = {}) {
  const {
    batchLimit = 120, graceMinutes = 10
  } = opts;
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

    // qui la tua richiesta: tutti gli appuntamenti tra targetStart e targetEnd
    if (startMs < fromMs || startMs >= toMs) continue;

    const toId = normalizeRecipientId(b);
    if (!toId) continue;

    const svcKey = b.service || b.serviceName || null;
    const svc = svcKey || "il trattamento";

    const pro =
      b.professionalName ||
      (typeof proNameByEmail === "function" ? proNameByEmail(b.professionalEmail) : null) ||
      "il professionista";

    // Durata (minuti): booking -> config (anche pro-specific) -> fallback
    let durMin = Number(b.durationMin ?? b.duration ?? b.minutes ?? 0);
    if (!Number.isFinite(durMin) || durMin <= 0) {
      try {
        const item = (svcKey && (config?.services?.[svcKey] || config?.services?.[svc])) || {};
        const pd = item?.professionalDurations || {};
        const d2 = b.professionalEmail && pd[b.professionalEmail];
        durMin = Number(d2 || item?.duration || 0);
      } catch { }

      if (!Number.isFinite(durMin) || durMin <= 0) {
        try {
          if (typeof cfgServiceDuration === "function" && svcKey) durMin = Number(cfgServiceDuration(svcKey) || 30);
        } catch { }
      }
    }
    durMin = Math.max(1, Math.round(Number(durMin) || 30));

    const dt = new Date(startMs);
    const timeStr = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    const dayStr =
      (typeof formatDateWithWeekdayIT === "function" ?
        formatDateWithWeekdayIT(dt) :
        dt.toLocaleDateString("it-IT", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric"
        })
      );

    const msg =
      `Ciao! Ti ricordiamo che domani hai *${svc}* (${durMin} min) alle *${timeStr}* (${dayStr}) con *${pro}*.\n\n` +
      `Se vuoi modificare qualche dettaglio, scrivi *modifica*.\nNon vediamo l'ora di accoglierti `;

    try {
      await sendFn(toId, msg);

      if (b.eventId) {
        await updateBookingByEventId(b.eventId, {
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
      log("warn", "[remind24hTick] invio fallito:", e?.message || e);
    }
  }

  log("info", `[remind24hTick] slot=${sk} target=[${slotKey(targetStart)}..${slotKey(targetEnd)}] sent=${sent}`);
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
      state.step = "collect";
      const hour = new Date().getHours();
      let greeting = "";
      if (hour >= 6 && hour < 13) {
        greeting += "Buongiorno , che bello rivederti!";
      } else if (hour >= 13 && hour < 18) {
        greeting += "Buon pomeriggio , mi fa piacere rivederti qui!";
      } else if (hour >= 18 && hour < 22) {
        greeting += "Buonasera , che bello rivederti!";
      } else {
        greeting += "Buonanotte , che bello rivederti!";
      }

      try {
        // usa il client passato (normalmente il client che gestisce la chat)
        await safeSend(client || inactivityClient, chatId, greeting);
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
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, {
        recursive: true
      });
      const tmp = targetPath + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fsSync.renameSync(tmp, targetPath);
    } catch (e) {
      throw new Error(`writeAtomic failed: ${e?.message || e}`);
    }
  };

  const resolvePath = (p) =>
    path.isAbsolute(String(p || "")) ?
      p :
      path.join(process.cwd(), String(p || ""));

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
      const filePath = d ?
        resolvePath(d) :
        stateObj.__file ?
          resolvePath(stateObj.__file) :
          null;
      // aggiorna in-place
      stateObj[key] = value;
      if (filePath) writeAtomic(filePath, stateObj);
      return stateObj;
    }

    throw new Error("setAndPersist: argomenti non riconosciuti");
  } catch (err) {
    // usa la funzione di logging già definita in util.js
    try {
      if (log && typeof log === "function") {
        log("error", "[setAndPersist] errore", err?.message || err);
      } else {
        console.error("[setAndPersist] errore", err?.message || err);
      }
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", {
        error: String(err)
      }); //  FIX Bug #17
    }
    throw err;
  }
}

/* The above code defines a JavaScript function called `getServiceDurationForPro` that takes two
parameters: `serviceName` and `proId`. The function is intended to calculate the service duration
for a specific professional identified by `proId` for a given `serviceName`. However, the actual
implementation of the function is represented by placeholder characters (` */
function getServiceDurationForPro(...args) {
  return __modules["booking/calendar"].getServiceDurationForPro(...args);
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
export function startReviewFollowupsLoop(...args) {
  return __modules["booking/notifications"].startReviewFollowupsLoop(...args);
}

// === Exports extra per IVR Twilio (DTMF + Speech) ===
export {
  // gcal wrappers
  cancelEventSafe,
  updateEventSafe,

  // create event wrapper
  makeEvent,

  // bookings persistence
  persistBooking,

  // overlap check (utile per evitare doppie prenotazioni)
  slotOverlapsExistingBookings,
};


// Shared rules formerly declared only inside an individual conversation handler.
// Keeping them at module scope allows all entry points to use consistent behavior.
function cfgClosedDay(day) { return isClosedDay(day, config); }
function nearestTimes(times, target, count = 3) {
  const targetMinutes = timeToMinutes(target);
  return (times || []).map((time) => ({ time, distance: Math.abs(timeToMinutes(time) - targetMinutes) }))
    .sort((a, b) => a.distance - b.distance).slice(0, count).map((item) => item.time);
}
function filterOutPastTimesForToday(day, times) { return filterPastTimes(day, times); }
function parseDaypartWindow(value) { return normalizeDaypart(value, norm, getDaypartBoundaries); }
function parseNaturalDate(value) { return parseUnifiedDate(value); }
function parseDaySmart(value, options = {}) { return parseUnifiedDate(value, options.baseDate); }
function getAllProsList() {
  return Object.entries(config?.professionals || {}).map(([email, details]) => ({
    email,
    name: details?.name || email,
  }));
}
function resolveEmailByName(value) { return proEmailByName(value); }
function bestServiceBySynonyms(value) { return resolveServiceFromText(value); }
function fuzzyServiceSafe(value) {
  const service = fuzzyService(value);
  if (!service) return null;
  const list = cfgServices();
  const tokens = list.flatMap((item) => String(item).toLowerCase().split(/\W+/)).filter((word) => word.length >= 4);
  const normalized = norm(value);
  if (list.length && norm(service) === norm(list[0]) && !tokens.some((word) => normalized.includes(norm(word)))) return null;
  return service;
}

// Compatibility facade: legacy entry points remain stable while implementation
// lives in independently scoped domain modules. Initialize only after runtime
// configuration and initial persistence caches have completed startup.
const __moduleDeps = {
  nearestTimes,
  AVAIL_PAGE_SIZE,
  cfgClosedDay,
  filterOutPastTimesForToday,
  parseDaypartWindow,
  parseNaturalDate,
  parseDaySmart,
  getAllProsList,
  resolveEmailByName,
  bestServiceBySynonyms,
  fuzzyServiceSafe,
  BOOKING_LOCK_MS,
  BUSY_TTL_MS,
  COURTESY_PATTERNS,
  COURTESY_RESPONSES,
  GCAL,
  HOLD_LOCK_TIMEOUT,
  HOLD_MINUTES,
  HYBRID_PATTERNS,
  MESSAGES,
  PRIVACY_NOTICE_VERSION,
  REFILL_PAT,
  SALON_PHONE,
  __FOOTER_COOLDOWN,
  __MAX_RETRY_ITEMS,
  __REVIEW_MENU_INTENTS,
  __SEND_DEDUP,
  __SVC_GROUP_PREFERRED,
  __SVC_GROUP_STOPWORDS,
  __bookingsCache,
  __bookingsDBInitErr,
  __bookingsDBOk,
  __buildDayMonthConfirmFromText,
  __busyChats,
  __busySince,
  __cap,
  __dateParsingLocks,
  __dbAllPros,
  __dbInsertChatMessage,
  __delay,
  __fmtEurMaybe,
  __holdLock,
  __initBookingsCacheFromPg,
  __isBookingIntentText,
  __loadIdMaps,
  __looksLikeReviewAnswer,
  __pgPool,
  __pgQuery,
  __pgWriteQueue,
  __proEmailToId,
  __proNameToId,
  __retryBusy,
  __servicesItemCache,
  __servicesListCache,
  __servicesProsCache,
  __servicesSynCache,
  __svcKey,
  __svcKeyToName,
  __svcNameToId,
  _createCalendarEvent,
  _digitsPhone,
  _editApplyUpdate,
  _editDayFromBooking,
  _editDuration,
  _editParseNewDate,
  _editSnapshotStateFromBooking,
  _fmtBookingLine,
  _n,
  _norm,
  _svcNormText,
  _svcTokensFromText,
  acquireSoftHold,
  appendUserMessage,
  askQA,
  atNoon,
  buildAvailabilityCompactMessage,
  buildConfirmMessage,
  buildQAPromptWithMemory,
  buildReviewIntakePrompt,
  buildReviewMessage,
  buildServicesMessageForPro,
  bulkUpsertBookingsNormPg,
  cancelEventSafe,
  cfgServiceDuration,
  cfgServiceItem,
  cfgServicePriceText,
  cfgServiceProfessionals,
  cfgServiceSynonyms,
  cfgServices,
  chatdbDeleteEntry,
  classifyIntent,
  compareHHMM,
  composeInfoPrompt,
  config,
  daysInMonth,
  dlDist,
  dueForConfirmation,
  dueForReview,
  ensureContext,
  ensureUI,
  ensureValidState,
  escapeReg,
  extractCustomerName,
  extractReviewEntities,
  fetchSlots,
  filterSlotsByDaypart,
  filterSlotsByWindow,
  firstMissingField,
  fmtDate,
  fmtDateWithWeekdayIT,
  fmtWeekdayDateLongIT,
  fmtWeekdayDateShortIT,
  formatBusinessHours,
  formatDateWithWeekdayIT,
  formatDurationMin,
  fuzzyCmd,
  fuzzyService,
  getAllergens,
  getBusyIntervalsForDay,
  getDaypartBoundaries,
  getDurForPro,
  getHoldIntervalsForDay,
  getLang,
  getLastInfoTopic,
  getPrivacyText,
  getRecentMessages,
  getServiceDurationForPro,
  getState,
  getUserActiveBookingsAll,
  greetIfReturningUser,
  groupServicesByCategory,
  groupServicesByType,
  groupSlotsByDaypart,
  handleMessage,
  handleNumericReply,
  hasBookingVerb,
  hasDateOrTime,
  isBookingFlowActive,
  isBookingLocked,
  isInCriticalStep,
  isPast,
  isReactionOnly,
  isRetryableBookingDbError,
  isServiceAvailableForPro,
  isTypoClose,
  isUrgencyMessage,
  isValidDate,
  isoWeekday,
  itaWeekdayName,
  labelProsForSlot,
  levenshtein,
  loadBookings,
  loadChatDB,
  loadHolds,
  log,
  looksLikeBooking,
  makeEvent,
  markPrivacySent,
  matchProFromFreeText,
  maybeHandleReviewReply,
  maybeSendPrivacyNotice,
  nextOpenDay,
  norm,
  normalizeRecipientId,
  normalizeSlotsDetail,
  now,
  parseExplicitMention,
  parseHHMM,
  parseListIndex,
  parseNaturalTime,
  parseTimeSmart,
  parseUnifiedDate,
  pending,
  persistBooking,
  phoneFromChatId,
  pickBookingMatchFromFreeText,
  primaryIntent,
  privacyCommandKind,
  proCatalog,
  proEmailByName,
  proNameByEmail,
  proNameByEmailSafe,
  proShort,
  promptResumeStep,
  releaseSoftHoldByChat,
  rememberService,
  renderEditBookingList,
  renderSlotsList,
  reply,
  resolveProReply,
  resolveReviewMenuIntent,
  resolveServiceFromText,
  safeParseDateWithLock,
  safeSend,
  saveChatDB,
  saveHolds,
  scheduleReenter,
  scoreService,
  scoreServiceCatalog,
  serviceProsEmails,
  setAndPersist,
  setTime,
  shouldDropIncoming,
  showEditMenu,
  simpleNorm,
  slotOverlapsExistingBookings,
  startEditChooseBooking,
  startEditDate,
  startEditName,
  startEditProfessional,
  startEditTime,
  timeToMinutes,
  toISOStringLocal,
  tokens,
  tr,
  typoMaxDist,
  uniqueTimesFromSlots,
  unlockBooking,
  updateBookingByComposite,
  updateBookingByEventId,
  updateEventSafe,
  validateDateInRange,
  validateProfessionalForService,
  wantsEditMenu,
};
const __moduleShared = {
  get inactivityClient() { return inactivityClient; },
  set inactivityClient(value) { inactivityClient = value; },
  get __svcNameToId() { return __svcNameToId; },
  set __svcNameToId(value) { __svcNameToId = value; },
  get __proEmailToId() { return __proEmailToId; },
  set __proEmailToId(value) { __proEmailToId = value; },
  get __proNameToId() { return __proNameToId; },
  set __proNameToId(value) { __proNameToId = value; },
  get __loadIdMapsInFlight() { return __loadIdMapsInFlight; },
  set __loadIdMapsInFlight(value) { __loadIdMapsInFlight = value; },
  get __servicesListCache() { return __servicesListCache; },
  set __servicesListCache(value) { __servicesListCache = value; },
  get __servicesItemCache() { return __servicesItemCache; },
  set __servicesItemCache(value) { __servicesItemCache = value; },
  get __servicesSynCache() { return __servicesSynCache; },
  set __servicesSynCache(value) { __servicesSynCache = value; },
  get __servicesProsCache() { return __servicesProsCache; },
  set __servicesProsCache(value) { __servicesProsCache = value; },
  get __servicesDBOk() { return __servicesDBOk; },
  set __servicesDBOk(value) { __servicesDBOk = value; },
  get __servicesDBInitErr() { return __servicesDBInitErr; },
  set __servicesDBInitErr(value) { __servicesDBInitErr = value; },
  get __svcKeyToName() { return __svcKeyToName; },
  set __svcKeyToName(value) { __svcKeyToName = value; },
  get __chatCache() { return __chatCache; },
  set __chatCache(value) { __chatCache = value; },
  get __chatDBOk() { return __chatDBOk; },
  set __chatDBOk(value) { __chatDBOk = value; },
  get __chatDBInitErr() { return __chatDBInitErr; },
  set __chatDBInitErr(value) { __chatDBInitErr = value; },
  get __chatFlushTimer() { return __chatFlushTimer; },
  set __chatFlushTimer(value) { __chatFlushTimer = value; },
  get __chatFlushInFlight() { return __chatFlushInFlight; },
  set __chatFlushInFlight(value) { __chatFlushInFlight = value; },
  get __chatCleanupTimer() { return __chatCleanupTimer; },
  set __chatCleanupTimer(value) { __chatCleanupTimer = value; },
  get __holdsCache() { return __holdsCache; },
  set __holdsCache(value) { __holdsCache = value; },
  get __holdsDBOk() { return __holdsDBOk; },
  set __holdsDBOk(value) { __holdsDBOk = value; },
  get __holdsDBInitErr() { return __holdsDBInitErr; },
  set __holdsDBInitErr(value) { __holdsDBInitErr = value; },
  get __holdsFlushTimer() { return __holdsFlushTimer; },
  set __holdsFlushTimer(value) { __holdsFlushTimer = value; },
  get __holdsFlushInFlight() { return __holdsFlushInFlight; },
  set __holdsFlushInFlight(value) { __holdsFlushInFlight = value; },
  get __bookingsCache() { return __bookingsCache; },
  set __bookingsCache(value) { __bookingsCache = value; },
  get __bookingsDBOk() { return __bookingsDBOk; },
  set __bookingsDBOk(value) { __bookingsDBOk = value; },
  get __bookingsDBInitErr() { return __bookingsDBInitErr; },
  set __bookingsDBInitErr(value) { __bookingsDBInitErr = value; },
  get __retryBusy() { return __retryBusy; },
  set __retryBusy(value) { __retryBusy = value; },
  get QA_ASK() { return QA_ASK; },
  set QA_ASK(value) { QA_ASK = value; },
  get GREET_COOLDOWN_MS() { return GREET_COOLDOWN_MS; },
  set GREET_COOLDOWN_MS(value) { GREET_COOLDOWN_MS = value; },
  get __lastReminderSlotKey() { return __lastReminderSlotKey; },
  set __lastReminderSlotKey(value) { __lastReminderSlotKey = value; },
};
const __modules = Object.create(null);
__modules["conversation/helpers"] = createDomain0(__moduleDeps, __moduleShared);
__modules["conversation/intent"] = createDomain1(__moduleDeps, __moduleShared);
__modules["booking/persistence"] = createDomain2(__moduleDeps, __moduleShared);
__modules["booking/holds"] = createDomain3(__moduleDeps, __moduleShared);
__modules["booking/notifications"] = createDomain4(__moduleDeps, __moduleShared);
__modules["catalog/services"] = createDomain5(__moduleDeps, __moduleShared);
__modules["conversation/privacy"] = createDomain6(__moduleDeps, __moduleShared);
__modules["conversation/transport"] = createDomain7(__moduleDeps, __moduleShared);
__modules["conversation/state"] = createDomain8(__moduleDeps, __moduleShared);
__modules["booking/availability"] = createDomain9(__moduleDeps, __moduleShared);
__modules["booking/calendar"] = createDomain10(__moduleDeps, __moduleShared);
__modules["booking/edit"] = createDomain11(__moduleDeps, __moduleShared);
__modules["conversation/handle-message"] = createDomain12(__moduleDeps, __moduleShared);
__modules["conversation/handle-numeric-reply"] = createDomain13(__moduleDeps, __moduleShared);
