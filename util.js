import os from "node:os";
import * as fsSync from "fs";
import path from "path";
import dotenv from "dotenv";
import pgPkg from "pg";
dotenv.config();
import { DATA_DIR, debugDataDir } from "./fs-json.js";
import {
  getFreeSlotsForDay as _getFreeSlotsForDay,
  createCalendarEvent as _createCalendarEvent,
} from "./gcal.js";
import * as GCAL from "./gcal.js";
// ============== Logger ==============
const LEVEL_PRIORITY = {
  error: 0,
  warn: 1,
  info: 2,
  analytics: 2,
  debug: 3,
};
const CUR = (process.env.LOG_LEVEL || "info").toLowerCase();
const CUR_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, CUR) ? CUR : "info";
const okLevel = (l) => {
  const lvl = String(l || "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, lvl)) return false;
  return LEVEL_PRIORITY[lvl] <= LEVEL_PRIORITY[CUR_LEVEL];
};
function safeJSON(o) {
  try {
    return JSON.stringify(o);
  } catch {
    return "[circular]";
  }
}
function toErrorMeta(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }
  return { message: String(error) };
}
function logIgnoredError(scope, error, context = null) {
  log("warn", `[IGNORED] ${scope}`, {
    error: toErrorMeta(error),
    ...(context ? { context } : {}),
  });
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
let inactivityClient = null;
class SafeSendError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SafeSendError";
    this.details = details;
  }
}
// --- mini lock per chat ---
const __busyChats = new Set();
const __busySince = new Map();
const BUSY_TTL_MS = Number(process.env.BUSY_TTL_MS || 45000);
const __delay = (ms) => new Promise((r) => setTimeout(r, ms));

function __normalizeText(value, { stripPunctuation = false, collapseWhitespace = false } = {}) {
  let out = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  if (stripPunctuation) out = out.replace(/[^a-z0-9 ]+/g, " ");
  if (collapseWhitespace) out = out.replace(/\s+/g, " ").trim();
  return out;
}

function __toValidDate(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date;
}

const __pad2 = (n) => String(n).padStart(2, "0");

function __toHHMM(h, m) {
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${__pad2(h)}:${__pad2(m)}`;
}

function __writeJsonAtomic(targetPath, data, { ensureDir = true, label = "json" } = {}) {
  const dir = path.dirname(targetPath);
  if (ensureDir && !fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });

  const tmp = `${targetPath}.tmp`;
  try {
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fsSync.renameSync(tmp, targetPath);
  } catch (error) {
    try {
      if (fsSync.existsSync(tmp)) fsSync.unlinkSync(tmp);
    } catch (cleanupError) {
      logIgnoredError(`${label}.cleanupTmp`, cleanupError, { targetPath });
    }
    throw error;
  }
}

// ==== Dedupe INGRESSO (anti doppio invio WhatsApp / doppia esecuzione) ====
// Memorizza l’ultimo testo normalizzato per chat e scarta duplicati entro una finestra breve.
const __inputDedup = new Map(); // chatId -> { key, at }
const INPUT_DEDUP_MS = Number(process.env.INPUT_DEDUP_MS || 1500);

function _normIncomingForDedup(s) {
  const raw = String(s || "");
  const cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  const base = typeof norm === "function" ? norm(cleaned) : cleaned.toLowerCase();
  return String(base).replace(/\s+/g, " ").trim();
}

function shouldDropIncoming(chatId, text) {
  try {
    const key = _normIncomingForDedup(text);
    if (!key) return false;
    const now = Date.now();
    const prev = __inputDedup.get(chatId);
    if (prev && prev.key === key && now - prev.at <= INPUT_DEDUP_MS) return true;
    __inputDedup.set(chatId, { key, at: now });
    return false;
  } catch {
    return false;
  }
}

// ================= PostgreSQL runtime state =================
const { Pool } = pgPkg || {};
const __PG_URL = String(process.env.DATABASE_URL || "").trim();
const __pgNeedsSSL =
  process.env.PG_SSL === "1" ||
  process.env.PGSSLMODE === "require" ||
  __PG_URL.includes("sslmode=require");

if (!__PG_URL || !Pool) {
  throw new Error(
    "DATABASE_URL is required: util.js no longer supports JSON persistence for runtime state."
  );
}

const __pgPool = new Pool({
  connectionString: __PG_URL,
  ssl: __pgNeedsSSL ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
});

async function __pgExec(text, params = []) {
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

let config = {};
const HOLD_MINUTES = Number(process.env.SOFT_HOLD_MIN || 5);

let __svcNameToId = new Map();
let __proEmailToId = new Map();
let __proNameToId = new Map();
let __loadIdMapsInFlight = null;

async function __loadIdMaps() {
  if (__loadIdMapsInFlight) return __loadIdMapsInFlight;

  __loadIdMapsInFlight = (async () => {
    const svcs = await __pgQuery(`SELECT service_id, service_name FROM public.services`);
    const nextSvcMap = new Map();
    for (const row of svcs) {
      const name = String(row.service_name || "").trim();
      if (!name) continue;
      nextSvcMap.set(name, Number(row.service_id));
    }

    const pros = await __pgQuery(`
      SELECT p.professional_id, p.full_name,
             (SELECT (pe.email)::text
              FROM public.professional_emails pe
              WHERE pe.professional_id = p.professional_id
              ORDER BY (pe.email)::text ASC
              LIMIT 1) AS email
      FROM public.professionals p
      WHERE p.is_active = true
    `);

    const nextEmailMap = new Map();
    const nextNameMap = new Map();
    for (const row of pros) {
      const id = Number(row.professional_id);
      const email = String(row.email || "").trim().toLowerCase();
      const name = String(row.full_name || "").trim();
      if (email) nextEmailMap.set(email, id);
      if (Number.isFinite(id)) nextEmailMap.set(`pro:${id}`, id);
      if (name) nextNameMap.set(name.toLowerCase(), id);
    }

    __svcNameToId = nextSvcMap;
    __proEmailToId = nextEmailMap;
    __proNameToId = nextNameMap;

    log("debug", "[pg] loadIdMaps OK", {
      services: __svcNameToId.size,
      professionals: __proEmailToId.size,
    });
  })()
    .catch((error) => {
      log("error", "[pg] loadIdMaps failed", { error: String(error?.message || error) });
      throw error;
    })
    .finally(() => {
      __loadIdMapsInFlight = null;
    });

  return __loadIdMapsInFlight;
}

const __ID_MAPS_REFRESH_MS = Number(process.env.ID_MAPS_REFRESH_MS || 5 * 60 * 1000);
const __idMapsRefreshTimer = setInterval(() => {
  void __loadIdMaps().catch((error) => {
    log("warn", "[pg] loadIdMaps periodic refresh failed", {
      error: String(error?.message || error),
    });
  });
}, __ID_MAPS_REFRESH_MS);
if (__idMapsRefreshTimer?.unref) __idMapsRefreshTimer.unref();

let __servicesListCache = [];
let __servicesItemCache = new Map();
let __servicesSynCache = new Map();
let __servicesProsCache = new Map();
let __servicesDBOk = false;
let __servicesDBInitErr = null;
const __svcKey = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
let __svcKeyToName = new Map();

function __fmtEurMaybe(v) {
  if (v === null || typeof v === "undefined") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  return `${fixed.replace(/\.00$/, "").replace(/(\.[0-9])0$/, "$1")}€`;
}

async function __initServicesCacheFromPg() {
  try {
    await __loadIdMaps();

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

    const nextList = [];
    const nextItems = new Map();
    const nextSvcKeyToName = new Map();
    for (const row of rows || []) {
      const name = String(row.service_name || "").trim();
      if (!name) continue;
      nextList.push(name);
      nextSvcKeyToName.set(__svcKey(name), name);
      nextItems.set(name, {
        name,
        label: name,
        category: String(row.category_name || "").trim() || null,
        categoryId:
          row.category_id === null || typeof row.category_id === "undefined"
            ? null
            : Number(row.category_id),
        categoryOrder: Number(row.category_display_order ?? 9999) || 9999,
        emoji: String(row.emoji || "").trim() || null,
        displayOrder: Number(row.display_order ?? 1000) || 1000,
        durationMin: Number(row.default_duration_min || 0) || 30,
        price:
          row.base_price === null || typeof row.base_price === "undefined"
            ? null
            : Number(row.base_price),
        professionals: [],
        professionalsDetailed: [],
      });
    }

    const synRows = await __pgQuery(`
      SELECT s.service_name, ss.synonym
      FROM public.service_synonyms ss
      JOIN public.services s ON s.service_id = ss.service_id
    `);
    const nextSyn = new Map();
    for (const row of synRows || []) {
      const svcName = String(row.service_name || "").trim();
      const syn = String(row.synonym || "").trim();
      if (!svcName || !syn) continue;
      const canon = nextSvcKeyToName.get(__svcKey(svcName)) || svcName;
      const arr = nextSyn.get(canon) || [];
      arr.push(syn);
      nextSyn.set(canon, arr);
    }

    const proRows = await __pgQuery(`
      SELECT s.service_name,
             p.professional_id,
             p.full_name,
             (SELECT (pe.email)::text
              FROM public.professional_emails pe
              WHERE pe.professional_id = p.professional_id
              ORDER BY (pe.email)::text ASC
              LIMIT 1) AS email
      FROM public.professional_services ps
      JOIN public.services s ON s.service_id = ps.service_id
      JOIN public.professionals p ON p.professional_id = ps.professional_id
      WHERE p.is_active = true
    `);
    const nextPros = new Map();
    for (const row of proRows || []) {
      const svcName = String(row.service_name || "").trim();
      if (!svcName) continue;
      const rawEmail = String(row.email || "").trim().toLowerCase();
      const proIdNum = Number(row.professional_id);
      const email = rawEmail || (Number.isFinite(proIdNum) ? `pro:${proIdNum}` : null);
      if (!email) continue;
      const canon = nextSvcKeyToName.get(__svcKey(svcName)) || svcName;
      const list = nextPros.get(canon) || [];
      list.push({
        name: String(row.full_name || email).trim() || email,
        email,
        professional_id: Number.isFinite(proIdNum) ? proIdNum : null,
        hasRealEmail: !!rawEmail,
      });
      nextPros.set(canon, list);
    }

    for (const name of nextList) {
      const item = nextItems.get(name);
      if (!item) continue;
      const pros = nextPros.get(name) || [];
      item.professionalsDetailed = pros.slice();
      item.professionals = pros.map((p) => p.email).filter(Boolean);
    }

    __servicesListCache = nextList;
    __servicesItemCache = nextItems;
    __servicesSynCache = nextSyn;
    __servicesProsCache = nextPros;
    __svcKeyToName = nextSvcKeyToName;
    __servicesDBOk = true;
    __servicesDBInitErr = null;
    log("info", "[services] PostgreSQL cache loaded", {
      count: __servicesListCache.length,
    });
  } catch (error) {
    __servicesDBOk = false;
    __servicesDBInitErr = error;
    log("error", "[services] PostgreSQL init/load failed", {
      error: String(error?.message || error),
    });
    throw error;
  }
}

function __dbAllPros() {
  const out = [];
  const seen = new Set();

  for (const list of __servicesProsCache.values()) {
    for (const p of list || []) {
      const email = String(p?.email || "").toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({
        name: String(p?.name || email),
        email,
        professional_id:
          p?.professional_id === null || typeof p?.professional_id === "undefined"
            ? null
            : Number(p.professional_id),
        hasRealEmail: !!p?.hasRealEmail,
      });
    }
  }

  if (!out.length) {
    for (const [name, id] of __proNameToId.entries()) {
      const email = `pro:${id}`;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ name, email, professional_id: id, hasRealEmail: false });
    }
  }

  return out;
}

async function __ensureRuntimeStateTables() {
  await __pgExec(`
    CREATE TABLE IF NOT EXISTS public.chat_session_runtime_state (
      chat_id TEXT PRIMARY KEY REFERENCES public.chat_sessions(chat_id) ON DELETE CASCADE,
      memory_json JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

let __chatCache = {};
let __chatDBOk = false;
let __chatDBInitErr = null;
let __chatFlushTimer = null;
let __chatFlushInFlight = false;
const __CHAT_FLUSH_MS = Number(process.env.CHAT_FLUSH_MS || 750);
const __CHAT_MAX_ENTRIES = Number(process.env.CHAT_MAX_ENTRIES || 2000);
const __CHAT_TTL_MS = Number(process.env.CHAT_TTL_DAYS || 30) * 86_400_000;
const __CHAT_CLEANUP_MS = Number(process.env.CHAT_CLEANUP_MS || 3_600_000);
const __chatAccessTime = new Map();
let __chatCleanupTimer = null;

function __touchChat(chatId) {
  if (chatId) __chatAccessTime.set(String(chatId), Date.now());
}

function __evictChatCache() {
  const now = Date.now();
  for (const [id, ts] of __chatAccessTime.entries()) {
    if (now - ts > __CHAT_TTL_MS) {
      delete __chatCache[id];
      __chatAccessTime.delete(id);
    }
  }

  const ids = Object.keys(__chatCache || {});
  if (ids.length <= __CHAT_MAX_ENTRIES) return;
  ids.sort((a, b) => (__chatAccessTime.get(a) || 0) - (__chatAccessTime.get(b) || 0));
  const toRemove = ids.length - __CHAT_MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    delete __chatCache[ids[i]];
    __chatAccessTime.delete(ids[i]);
  }
}

function __startChatCleanup() {
  if (__chatCleanupTimer) return;
  __chatCleanupTimer = setInterval(() => {
    try {
      __evictChatCache();
    } catch (error) {
      logIgnoredError("chat.cleanup", error);
    }
  }, __CHAT_CLEANUP_MS);
  if (__chatCleanupTimer?.unref) __chatCleanupTimer.unref();
}

async function __initChatCacheFromPg() {
  try {
    await __ensureRuntimeStateTables();
    await __loadIdMaps();

    const rows = await __pgQuery(`
      SELECT cs.*,
             crs.memory_json,
             s.service_name AS last_service_name,
             p.full_name AS last_pro_name
      FROM public.chat_sessions cs
      LEFT JOIN public.chat_session_runtime_state crs ON crs.chat_id = cs.chat_id
      LEFT JOIN public.services s ON s.service_id = cs.last_review_prompt_service_id
      LEFT JOIN public.professionals p ON p.professional_id = cs.last_review_prompt_professional_id
    `);

    const cache = {};
    for (const row of rows || []) {
      const chatId = String(row.chat_id || "");
      if (!chatId) continue;
      cache[chatId] = {
        msgs: [],
        phone: row.phone_e164 || chatIdToE164(chatId) || chatId,
        lang: row.lang || "it",
        firstSeenAt: __tsMs(row.first_seen_at) || 0,
        lastActive: __tsMs(row.last_active_at) || 0,
        lastGreet: __tsMs(row.last_greet_at) || 0,
        memory: row.memory_json && typeof row.memory_json === "object" ? row.memory_json : undefined,
        privacy:
          row.privacy_sent_at || row.privacy_version
            ? {
              sentAt: __tsMs(row.privacy_sent_at),
              version: Number(row.privacy_version || 1),
            }
            : undefined,
        lastReviewPromptAt: __tsMs(row.last_review_prompt_at) || 0,
        lastReviewPromptEventId: row.last_review_prompt_event_id || null,
        lastReviewPromptService: row.last_service_name || null,
        lastReviewPromptPro: row.last_pro_name || null,
        lastReviewReplyAt: __tsMs(row.last_review_reply_at) || 0,
        reminderChoice:
          row.reminder_choice === null || typeof row.reminder_choice === "undefined"
            ? null
            : Number(row.reminder_choice),
      };
    }

    const maxN = Math.max(1, Number(process.env.MAX_HISTORY || 5));
    const msgs = await __pgQuery(
      `
        SELECT chat_id, body
        FROM (
          SELECT chat_id, body,
                 row_number() OVER (PARTITION BY chat_id ORDER BY created_at DESC) AS rn
          FROM public.chat_messages
          WHERE direction = 'in'
        ) t
        WHERE rn <= $1
        ORDER BY chat_id, rn DESC
      `,
      [maxN]
    );

    for (const row of msgs || []) {
      const chatId = String(row.chat_id || "");
      if (!chatId) continue;
      cache[chatId] = cache[chatId] || { msgs: [] };
      cache[chatId].msgs = cache[chatId].msgs || [];
      cache[chatId].msgs.push(String(row.body || "").slice(0, 800));
      if (cache[chatId].msgs.length > maxN) {
        cache[chatId].msgs = cache[chatId].msgs.slice(-maxN);
      }
    }

    __chatCache = cache;
    __chatDBOk = true;
    __chatDBInitErr = null;

    const loadedNow = Date.now();
    for (const [id, entry] of Object.entries(cache)) {
      __chatAccessTime.set(id, entry.lastActive || loadedNow);
    }
    __startChatCleanup();

    log("info", "[chat] PostgreSQL cache loaded", {
      count: Object.keys(__chatCache).length,
    });
  } catch (error) {
    __chatDBOk = false;
    __chatDBInitErr = error;
    __chatCache = {};
    log("error", "[chat] PostgreSQL init/load failed", {
      error: String(error?.message || error),
    });
    throw error;
  }
}

function __scheduleChatFlush() {
  if (__chatFlushTimer) return;
  __chatFlushTimer = setTimeout(() => {
    __chatFlushTimer = null;
    void __flushChatToPg();
  }, __CHAT_FLUSH_MS);
}

async function __flushChatToPg() {
  if (__chatFlushInFlight) return;
  __chatFlushInFlight = true;
  try {
    const db = (__chatCache && typeof __chatCache === "object") ? __chatCache : {};
    const chatIds = Object.keys(db);
    if (!chatIds.length) return;

    for (const chatId of chatIds) {
      const entry = db[chatId] || {};
      const phone = entry.phone || chatIdToE164(chatId) || chatId;
      const lang = entry.lang || "it";
      const firstSeenAt = __toIsoFromMs(entry.firstSeenAt) || null;
      const lastActiveAt = __toIsoFromMs(entry.lastActive) || null;
      const lastGreetAt = __toIsoFromMs(entry.lastGreet) || null;
      const privacyVer = Number(entry?.privacy?.version || 0) || null;
      const privacySent = __toIsoFromMs(entry?.privacy?.sentAt || 0) || null;
      const lastReviewPromptAt = __toIsoFromMs(entry.lastReviewPromptAt || 0) || null;
      const lastReviewPromptEventId = entry.lastReviewPromptEventId
        ? String(entry.lastReviewPromptEventId)
        : null;
      const svcId = entry.lastReviewPromptService
        ? __svcNameToId.get(String(entry.lastReviewPromptService)) || null
        : null;
      const proId = entry.lastReviewPromptPro
        ? __proNameToId.get(String(entry.lastReviewPromptPro).toLowerCase()) || null
        : null;
      const lastReviewReplyAt = __toIsoFromMs(entry.lastReviewReplyAt || 0) || null;
      const reminderChoice =
        entry.reminderChoice === null || typeof entry.reminderChoice === "undefined"
          ? null
          : Number(entry.reminderChoice);

      await __pgExec(
        `
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
            last_greet_at = GREATEST(COALESCE(public.chat_sessions.last_greet_at, EXCLUDED.last_greet_at), EXCLUDED.last_greet_at),
            privacy_version = COALESCE(EXCLUDED.privacy_version, public.chat_sessions.privacy_version),
            privacy_sent_at = COALESCE(EXCLUDED.privacy_sent_at, public.chat_sessions.privacy_sent_at),
            last_review_prompt_at = COALESCE(EXCLUDED.last_review_prompt_at, public.chat_sessions.last_review_prompt_at),
            last_review_prompt_event_id = COALESCE(EXCLUDED.last_review_prompt_event_id, public.chat_sessions.last_review_prompt_event_id),
            last_review_prompt_service_id = COALESCE(EXCLUDED.last_review_prompt_service_id, public.chat_sessions.last_review_prompt_service_id),
            last_review_prompt_professional_id = COALESCE(EXCLUDED.last_review_prompt_professional_id, public.chat_sessions.last_review_prompt_professional_id),
            last_review_reply_at = COALESCE(EXCLUDED.last_review_reply_at, public.chat_sessions.last_review_reply_at),
            reminder_choice = COALESCE(EXCLUDED.reminder_choice, public.chat_sessions.reminder_choice)
        `,
        [
          chatId,
          phone,
          lang,
          firstSeenAt,
          lastActiveAt,
          lastGreetAt,
          privacyVer,
          privacySent,
          lastReviewPromptAt,
          lastReviewPromptEventId,
          svcId,
          proId,
          lastReviewReplyAt,
          reminderChoice,
        ]
      );

      await __pgExec(
        `
          INSERT INTO public.chat_session_runtime_state (chat_id, memory_json, updated_at)
          VALUES ($1, $2::jsonb, now())
          ON CONFLICT (chat_id) DO UPDATE SET
            memory_json = EXCLUDED.memory_json,
            updated_at = now()
        `,
        [chatId, JSON.stringify(entry?.memory || null)]
      );
    }

    __chatDBOk = true;
    __chatDBInitErr = null;
  } catch (error) {
    __chatDBOk = false;
    __chatDBInitErr = error;
    log("error", "[chat] flush failed", {
      error: String(error?.message || error),
    });
  } finally {
    __chatFlushInFlight = false;
  }
}

async function __deleteChatSessionFromPg(chatId) {
  const cid = String(chatId || "").trim();
  if (!cid) return false;
  await __pgExec(`DELETE FROM public.chat_sessions WHERE chat_id = $1`, [cid]);
  return true;
}

async function __dbInsertChatMessage(chatId, direction, body) {
  try {
    const cid = String(chatId || "").trim();
    if (!cid) return;
    const dir = direction === "out" ? "out" : "in";
    const txt = String(body ?? "").slice(0, 4000);
    if (!txt.trim()) return;
    await __pgExec(
      `INSERT INTO public.chat_sessions (chat_id, lang) VALUES ($1, 'it') ON CONFLICT (chat_id) DO NOTHING`,
      [cid]
    );
    await __pgExec(
      `INSERT INTO public.chat_messages (chat_id, direction, body) VALUES ($1, $2, $3)`,
      [cid, dir, txt]
    );
  } catch (error) {
    logIgnoredError("chat.insertMessage", error, { chatId, direction });
  }
}

let __holdsCache = [];
let __holdsDBOk = false;
let __holdsDBInitErr = null;
let __holdsFlushTimer = null;
let __holdsFlushInFlight = false;
const __HOLDS_FLUSH_MS = Number(process.env.HOLDS_FLUSH_MS || 750);

async function __initHoldsCacheFromPg() {
  try {
    await __loadIdMaps();
    await __pgExec(`
      UPDATE public.appointment_holds
      SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now()
    `);

    const rows = await __pgQuery(`
      SELECT h.hold_id,
             h.chat_id,
             (SELECT (pe.email)::text
              FROM public.professional_emails pe
              WHERE pe.professional_id = h.professional_id
              ORDER BY (pe.email)::text ASC
              LIMIT 1) AS professional_email,
             p.full_name AS professional_name,
             s.service_name,
             EXTRACT(EPOCH FROM h.start_time) * 1000 AS start_ms,
             EXTRACT(EPOCH FROM h.end_time) * 1000 AS end_ms,
             EXTRACT(EPOCH FROM h.expires_at) * 1000 AS expires_ms
      FROM public.appointment_holds h
      JOIN public.professionals p ON p.professional_id = h.professional_id
      LEFT JOIN public.services s ON s.service_id = h.service_id
      WHERE h.status = 'active'
      ORDER BY h.start_time ASC
    `);

    __holdsCache = (rows || []).map((row) => ({
      holdId: Number(row.hold_id),
      chatId: String(row.chat_id || ""),
      professionalEmail: String(row.professional_email || "").trim().toLowerCase(),
      professionalName: String(row.professional_name || "").trim() || null,
      service: String(row.service_name || "").trim() || null,
      startMs: Number(row.start_ms || 0),
      endMs: Number(row.end_ms || 0),
      expiresAt: Number(row.expires_ms || 0),
    }));

    __holdsDBOk = true;
    __holdsDBInitErr = null;
    log("info", "[holds] PostgreSQL cache loaded", { count: __holdsCache.length });
  } catch (error) {
    __holdsCache = [];
    __holdsDBOk = false;
    __holdsDBInitErr = error;
    log("error", "[holds] PostgreSQL init/load failed", {
      error: String(error?.message || error),
    });
    throw error;
  }
}

function __scheduleHoldsFlush() {
  if (__holdsFlushTimer) return;
  __holdsFlushTimer = setTimeout(() => {
    __holdsFlushTimer = null;
    void __flushHoldsToPg();
  }, __HOLDS_FLUSH_MS);
}

async function __flushHoldsToPg() {
  if (__holdsFlushInFlight) return;
  __holdsFlushInFlight = true;
  try {
    await __loadIdMaps();

    await __pgExec(`
      UPDATE public.appointment_holds
      SET status = 'released'
      WHERE status = 'active'
    `);

    const arr = (__holdsCache || []).filter((h) => Number(h?.expiresAt) > Date.now());
    if (!arr.length) {
      __holdsDBOk = true;
      __holdsDBInitErr = null;
      return;
    }

    const uniqChats = Array.from(new Set(arr.map((h) => String(h.chatId || "")).filter(Boolean)));
    for (const cid of uniqChats) {
      await __pgExec(
        `INSERT INTO public.chat_sessions (chat_id, lang) VALUES ($1, 'it') ON CONFLICT (chat_id) DO NOTHING`,
        [cid]
      );
    }

    for (const hold of arr) {
      const email = String(hold.professionalEmail || "").trim().toLowerCase();
      let proId = __proEmailToId.get(email) || null;
      if (!proId && hold.professionalName) {
        proId = __proNameToId.get(String(hold.professionalName || "").toLowerCase()) || null;
      }
      if (!proId) {
        const fallbackRows = await __pgQuery(
          `SELECT professional_id FROM public.professionals WHERE is_active = true ORDER BY professional_id ASC LIMIT 1`
        );
        proId = fallbackRows?.[0] ? Number(fallbackRows[0].professional_id) || null : null;
      }
      if (!proId) {
        log("warn", "[holds] flush skipped: professional not found", {
          chatId: hold.chatId || null,
          professionalEmail: email || null,
          professionalName: hold.professionalName || null,
        });
        continue;
      }

      const svcId = hold.service ? __svcNameToId.get(String(hold.service)) || null : null;
      const startIso = new Date(Number(hold.startMs)).toISOString();
      const endIso = new Date(Number(hold.endMs)).toISOString();
      const expiresIso = new Date(Number(hold.expiresAt)).toISOString();

      await __pgExec(
        `
          INSERT INTO public.appointment_holds
            (chat_id, professional_id, service_id, start_time, end_time, expires_at, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'active')
        `,
        [String(hold.chatId), proId, svcId, startIso, endIso, expiresIso]
      );
    }

    __holdsDBOk = true;
    __holdsDBInitErr = null;
  } catch (error) {
    __holdsDBOk = false;
    __holdsDBInitErr = error;
    log("error", "[holds] flush failed", {
      error: String(error?.message || error),
    });
  } finally {
    __holdsFlushInFlight = false;
  }
}

let __bookingsCache = [];
let __bookingsStoreReady = false;
let __bookingsStoreError = null;
let __bookingsInitPromise = null;
let __bookingsPgModPromise = null;

async function __getBookingsPgMod() {
  if (!__bookingsPgModPromise) {
    __bookingsPgModPromise = import("./bookings-norm-pg.js");
  }
  return await __bookingsPgModPromise;
}

async function __initBookingsStore() {
  if (__bookingsStoreReady) return true;
  if (__bookingsInitPromise) return __bookingsInitPromise;

  __bookingsInitPromise = (async () => {
    try {
      const { initBookingsNormDbPg, listBookingsNormPg } = await __getBookingsPgMod();
      await initBookingsNormDbPg();
      const rows = await listBookingsNormPg();
      __bookingsCache = Array.isArray(rows) ? rows.filter((x) => x && typeof x === "object") : [];
      __bookingsStoreReady = true;
      __bookingsStoreError = null;
      log("info", "[bookings] PostgreSQL cache loaded", { count: __bookingsCache.length });
      return true;
    } catch (error) {
      __bookingsStoreReady = false;
      __bookingsStoreError = error;
      log("error", "[bookings] PostgreSQL init/load failed", {
        error: String(error?.message || error),
      });
      return false;
    } finally {
      __bookingsInitPromise = null;
    }
  })();

  return __bookingsInitPromise;
}

async function __initUtilRuntime() {
  log("info", "[DATA_DIR]", debugDataDir());
  await __ensureRuntimeStateTables();
  await __loadIdMaps();
  await __initServicesCacheFromPg();
  config = await GCAL.getRuntimeConfig();
  if (!config || typeof config !== "object" || !config.services) {
    throw new Error("Runtime config could not be loaded from PostgreSQL.");
  }
  await __initChatCacheFromPg();
  await __initHoldsCacheFromPg();
  const bookingsOk = await __initBookingsStore();

  if (!__servicesDBOk || !__chatDBOk || !__holdsDBOk || !bookingsOk) {
    throw new Error("PostgreSQL runtime initialization failed.");
  }
}

await __initUtilRuntime();

const CANCEL_POLICY_HOURS = 3;

function __updateChatDB(chatId, updater) {
  const key = String(chatId || "");
  if (!key || typeof updater !== "function") return null;

  const db = loadChatDB();
  const now = Date.now();
  const current = db[key] || { msgs: [] };
  const next = updater(current, now) || current;

  next.firstSeenAt = next.firstSeenAt || now;
  next.lastActive = now;
  next.phone = next.phone || chatIdToE164(key) || key;

  db[key] = next;
  __touchChat(key);
  saveChatDB(db);
  return next;
}

function __getChatMemory(chatId) {
  const db = loadChatDB();
  return db?.[chatId]?.memory || null;
}


// === NEW: re-entry scheduler to avoid lock recursion ===
function scheduleReenter(client, chatId, text, tools = {}) {
  try {
    const reTools = { ...(tools || {}), __reenter: true };
    setTimeout(() => {
      Promise.resolve(handleMessage(client, chatId, text, reTools)).catch((err) => {
        try {
          log("error", "[REENTER] handleMessage failed", {
            chatId,
            error: String(err && err.stack ? err.stack : err),
          });
        } catch (err) {
          logIgnoredError("scheduleReenter.handleMessage", err, { chatId });
        }
      });
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
      `📅 Availability for ${day}:\n${lines}\n\nType the time you want (e.g. "14:30").`,
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
    const dt = __toValidDate(d);
    if (!dt) return "";
    const wd = typeof itaWeekdayName === "function" ? itaWeekdayName(dt) : "";
    const ds = typeof fmtDate === "function" ? fmtDate(dt) : dt.toLocaleDateString("it-IT");
    return wd ? `${wd} ${ds}` : ds;
  } catch (e) {
    return "";
  }
}


// ==== UX: Messaggi disponibilità compatti (max 5 orari) ====
const AVAIL_PAGE_SIZE = 5;

function __hhmmToMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  return h * 60 + mm;
}

function __compactHHMM(hhmm) {
  const m = String(hhmm || "").match(/^0?(\d{1,2}):([0-5]\d)$/);
  if (!m) return String(hhmm || "");
  return `${Number(m[1])}:${m[2]}`;
}

function __fmtDateShortIT(d) {
  try {
    const D = d instanceof Date ? d : new Date(d);
    const dd = String(D.getDate()).padStart(2, "0");
    const mm = String(D.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  } catch {
    return "";
  }
}

function fmtWeekdayDateShortIT(d) {
  try {
    const D = d instanceof Date ? d : new Date(d);
    const wd = new Intl.DateTimeFormat("it-IT", { weekday: "long" }).format(D);
    const cap = wd ? (wd[0].toUpperCase() + wd.slice(1)) : "";
    return `${cap} ${__fmtDateShortIT(D)}`.trim();
  } catch {
    return __fmtDateShortIT(d);
  }
}

function uniqueTimesFromSlots(slots) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(slots) ? slots : []) {
    const t = typeof s === "string" ? s : (s?.time || "");
    if (!/^\d{2}:\d{2}$/.test(String(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => (__hhmmToMinutes(a) ?? 0) - (__hhmmToMinutes(b) ?? 0));
  return out;
}

function filterSlotsByDaypart(slots, part) {
  const p = String(part || "").toLowerCase().trim();
  if (!p) return Array.isArray(slots) ? slots : [];
  const list = Array.isArray(slots) ? slots : [];
  const inRange = (tMin) => {
    if (tMin == null) return false;
    if (p === "mattina") return tMin < 13 * 60;
    if (p === "pomeriggio") return tMin >= 13 * 60 && tMin < 18 * 60;
    if (p === "sera") return tMin >= 18 * 60;
    return true;
  };
  return list.filter((s) => inRange(__hhmmToMinutes(typeof s === "string" ? s : s?.time)));
}

function __inferAvailStepMin(times) {
  try {
    const mins = (Array.isArray(times) ? times : [])
      .map(__hhmmToMinutes)
      .filter((x) => x != null)
      .sort((a, b) => a - b);

    if (mins.length < 3) return 15;

    const freq = new Map();
    for (let i = 1; i < mins.length; i++) {
      const d = mins[i] - mins[i - 1];
      if (!Number.isFinite(d) || d <= 0) continue;
      if (d < 5 || d > 120) continue;
      freq.set(d, (freq.get(d) || 0) + 1);
    }

    // step più frequente (fallback 15)
    let best = 15;
    let bestCnt = -1;
    for (const [d, c] of freq.entries()) {
      if (c > bestCnt) {
        best = d;
        bestCnt = c;
      }
    }

    return best;
  } catch {
    return 15;
  }
}

// Converte lista di orari (HH:MM) in "items" compatti: orari singoli + range (es. "10:00–12:30")
function __availItemsFromSlots(slots, { minRun = 4, stepMin } = {}) {
  const times = uniqueTimesFromSlots(slots);
  if (!times.length) return [];

  const step = Number.isFinite(stepMin) ? Number(stepMin) : __inferAvailStepMin(times);
  const runMin = Math.max(3, Number(minRun || 4) || 4);

  const items = [];
  let i = 0;

  while (i < times.length) {
    let j = i;

    while (j + 1 < times.length) {
      const a = __hhmmToMinutes(times[j]);
      const b = __hhmmToMinutes(times[j + 1]);
      if (a == null || b == null) break;
      if (b - a !== step) break;
      j++;
    }

    const runLen = j - i + 1;

    if (runLen >= runMin) {
      items.push(`dalle ${__compactHHMM(times[i])} alle ${__compactHHMM(times[j])}`);
    } else {
      for (let k = i; k <= j; k++) items.push(__compactHHMM(times[k]));
    }

    i = j + 1;
  }

  return items;
}

/**
 * Messaggio disponibilità super-chiaro per WhatsApp (senza paginazione, senza scelte numerate)
 * - Mostra TUTTI gli orari del giorno
 * - Etichette esplicite (Mattina/Pomeriggio/Sera)
 * - Spiega che sono orari di INIZIO appuntamento
 */
function buildAvailabilityCompactMessage(day, slots, opts = {}) {
  // ==================== CONFIGURAZIONE ====================
  const DEFAULT_STEP_MIN = 30;
  const MAX_STEP_DIFF = 240;

  const RANGE_MIN_COUNT = Math.max(2, Number(opts.rangeMinCount ?? 3) || 3); // min 3 slot consecutivi per fare un range
  const USE_RANGES = opts.useRanges === true; // default true

  // per WhatsApp: righe non infinite
  const MAX_LINE_CHARS = Math.max(30, Number(opts.maxLineChars ?? 46) || 46);

  const TIME_GROUPS = {
    mattina: { label: 'Mattina', emoji: '🌅', start: 0, end: 13 },
    pomeriggio: { label: 'Pomeriggio', emoji: '☀️', start: 13, end: 18 },
    sera: { label: 'Sera', emoji: '🌙', start: 18, end: 24 }
  };

  // ==================== HELPER ORARI ====================
  const toMinutes = (time) => {
    const str = String(time ?? '').trim();
    const match = str.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!match) return NaN;

    let h = Number(match[1]);
    let m = Number(match[2] ?? 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;

    h = Math.max(0, Math.min(24, h));
    m = Math.max(0, Math.min(59, m));
    if (h === 24 && m !== 0) return NaN; // consenti solo 24:00

    return h * 60 + m;
  };

  const formatTime = (time) => {
    const minutes = toMinutes(time);
    if (!Number.isFinite(minutes)) return String(time ?? '').trim();

    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    if (hh === 24 && mm === 0) return '24:00';

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const addMinutes = (hhmm, add) => {
    const base = toMinutes(hhmm);
    if (!Number.isFinite(base)) return hhmm;

    let t = base + add;
    t = Math.max(0, Math.min(24 * 60, t));

    const hh = Math.floor(t / 60);
    const mm = t % 60;
    if (hh === 24 && mm === 0) return '24:00';

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const extractUniqueTimes = (slots) => {
    const set = new Set();
    for (const slot of slots || []) {
      const raw =
        typeof slot === 'string'
          ? slot
          : slot?.time || slot?.start || slot?.hour || slot?.from || slot?.at || '';

      const t = formatTime(raw);
      if (Number.isFinite(toMinutes(t))) set.add(t);
    }
    return Array.from(set).sort((a, b) => toMinutes(a) - toMinutes(b));
  };

  // ==================== INFERENZA STEP ====================
  const inferStepMinutes = (times) => {
    const minutes = times.map(toMinutes).filter(Number.isFinite).sort((a, b) => a - b);
    if (minutes.length < 2) return DEFAULT_STEP_MIN;

    const diffs = [];
    for (let i = 1; i < minutes.length; i++) {
      const d = minutes[i] - minutes[i - 1];
      if (d > 0 && d <= MAX_STEP_DIFF) diffs.push(d);
    }
    if (!diffs.length) return DEFAULT_STEP_MIN;

    const freq = new Map();
    for (const d of diffs) freq.set(d, (freq.get(d) || 0) + 1);

    let best = diffs[0];
    let bestCount = 0;
    for (const [step, count] of freq.entries()) {
      if (count > bestCount || (count === bestCount && step < best)) {
        best = step;
        bestCount = count;
      }
    }
    return best;
  };

  // ==================== WRAP & FORMAT “UMANO” ====================
  const wrapTokens = (tokens, sep = ' • ', maxChars = 46) => {
    const lines = [];
    let current = '';

    for (const tok of tokens) {
      if (!current) {
        current = tok;
        continue;
      }
      const candidate = current + sep + tok;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        lines.push(current);
        current = tok;
      }
    }
    if (current) lines.push(current);
    return lines.join('\n');
  };

  const getTimeGroup = (time) => {
    const mins = toMinutes(time);
    if (!Number.isFinite(mins)) return null;
    const hour = Math.floor(mins / 60);

    for (const [name, cfg] of Object.entries(TIME_GROUPS)) {
      if (hour >= cfg.start && hour < cfg.end) return name;
    }
    return null;
  };

  /**
   * - Range SOLO su consecutivi veri (diff === step)
   * - Range con fine “vera” = ultimo slot + step
   * - Se pochi orari, lascia lista semplice
   */
  const formatTimesSmart = (times, stepMinutes) => {
    if (!times?.length) return '';

    const sorted = [...times].sort((a, b) => toMinutes(a) - toMinutes(b));
    const chunks = [];

    let run = [sorted[0]];

    const flush = () => {
      if (!run.length) return;

      if (USE_RANGES && run.length >= RANGE_MIN_COUNT) {
        const start = run[0];
        const end = addMinutes(run[run.length - 1], stepMinutes);
        chunks.push(`${start}–${end}`);
      } else {
        for (const t of run) chunks.push(t);
      }
      run = [];
    };

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const diff = toMinutes(cur) - toMinutes(prev);

      if (diff === stepMinutes) {
        run.push(cur);
      } else {
        flush();
        run = [cur];
      }
    }
    flush();

    return wrapTokens(chunks, ' • ', MAX_LINE_CHARS);
  };

  // ==================== LOGICA PRINCIPALE ====================
  const dayLabel = fmtWeekdayDateShortIT(day);
  const allTimes = extractUniqueTimes(slots);

  if (!allTimes.length) {
    return [
      `📅 *${dayLabel}*`,
      `❌ Nessun orario libero.`,
      `Scrivi un altro giorno (es. "domani").`
    ].join('\n');
  }

  const inferredStep = inferStepMinutes(allTimes);
  const stepMinutes = Math.max(1, Number(opts.stepMin ?? inferredStep) || inferredStep);

  // raggruppa tutti gli orari
  const timesByGroup = { mattina: [], pomeriggio: [], sera: [] };
  for (const time of allTimes) {
    const g = getTimeGroup(time) || 'mattina';
    (timesByGroup[g] ||= []).push(time);
  }


  // costruisci righe leggibili: "🌅 Mattina: ..."
  const groupLines = [];
  for (const [groupName, times] of Object.entries(timesByGroup)) {
    if (!times.length) continue;

    const cfg = TIME_GROUPS[groupName] || { label: 'Orari', emoji: '🕒' };
    const formatted = formatTimesSmart(times, stepMinutes);

    // Se va su più righe, indenta bene (più leggibile per tutti)
    const formattedLines = String(formatted).split('\n');
    groupLines.push(
      `${cfg.emoji} *${cfg.label}:* ${formattedLines[0]}` +
      (formattedLines.length > 1 ? `\n   ${formattedLines.slice(1).join('\n   ')}` : '')
    );
  }

  const serviceName = String(opts.serviceName ?? '').trim();
  const durMin = Number(opts.serviceDurationMin);
  const durLine = Number.isFinite(durMin) && durMin > 0 ? `⏱️ Durata indicativa: *${durMin} min*` : '';

  const headerExplain = [
    `✅ Orari disponibili ${serviceName ? ` per *${serviceName}*` : ''}.`,
    durLine
  ].filter(Boolean).join('\n');

  return [
    `📅 *${dayLabel}*`,
    headerExplain,
    '',
    ...groupLines,
    '',
    `✍️ Rispondi scrivendo l’orario che preferisci (es. *10:30*).`,
    `📌 Per cambiare giorno: scrivi "domani" oppure "venerdì".`,
    `❎ Per annullare: scrivi "_annulla_".`
  ].join('\n');
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
  const current = db[chatId];
  const entry =
    current && typeof current === "object" && !Array.isArray(current)
      ? current
      : {};

  if (!Array.isArray(entry.msgs)) entry.msgs = [];
  db[chatId] = entry;
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


// ================= Bookings store =================

function loadBookings() {
  if (!Array.isArray(__bookingsCache)) __bookingsCache = [];
  return __bookingsCache;
}

async function saveBookings(arr) {
  if (!Array.isArray(arr)) {
    log("error", "[bookings] saveBookings expected an array", { type: typeof arr });
    return false;
  }

  const clean = arr.filter((x) => x && typeof x === "object");

  const ready = await __initBookingsStore();
  if (!ready) {
    log("error", "[bookings] PostgreSQL non disponibile: impossibile salvare", {
      error: String(__bookingsStoreError?.message || __bookingsStoreError || "unknown"),
    });
    return false;
  }

  try {
    const { bulkUpsertBookingsNormPg } = await __getBookingsPgMod();
    await bulkUpsertBookingsNormPg(clean);
    __bookingsCache = clean;
    __bookingsStoreReady = true;
    __bookingsStoreError = null;
    return true;
  } catch (error) {
    __bookingsStoreReady = false;
    __bookingsStoreError = error;
    log("error", "[bookings] PostgreSQL write failed", {
      error: String(error?.message || error),
    });
    return false;
  }
}

function _bkDigits(v) {
  return String(v || "").replace(/\D/g, "");
}
function _bkPhoneKey(v) {
  let d = _bkDigits(v);
  // normalizza Italia: +39 / 0039 / 39
  d = d.replace(/^00?39/, "").replace(/^39/, "");
  return d;
}
function _bkToISO(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? v.toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function _bkEnsureTimes(b) {
  if (!b || typeof b !== "object") return b;

  // duration
  const durMin = Number(b.durationMin ?? b.duration ?? b.minutes ?? 0) || 0;
  if (durMin > 0) b.durationMin = durMin;

  // start
  const startISO = _bkToISO(
    b.startTime ?? b.start ?? b.datetime ?? b.date ?? b.when ?? b.day ?? null
  );
  if (startISO) b.startTime = startISO;

  const startMs = Number(b.startMs);
  const sMs = Number.isFinite(startMs) ? startMs : startISO ? Date.parse(startISO) : NaN;
  if (Number.isFinite(sMs)) b.startMs = sMs;

  // end (se manca o è incoerente, ricostruiscilo da duration)
  const endISO = _bkToISO(b.endTime ?? b.end ?? null);
  let eMs = Number(b.endMs);
  if (!Number.isFinite(eMs)) {
    if (endISO) eMs = Date.parse(endISO);
    else if (Number.isFinite(sMs) && durMin > 0) eMs = sMs + durMin * 60_000;
  }
  if (Number.isFinite(eMs) && Number.isFinite(sMs) && eMs > sMs) {
    b.endMs = eMs;
    b.endTime = new Date(eMs).toISOString();
  }

  // phone
  if (b.clientPhone) b.clientPhone = _bkDigits(b.clientPhone);
  if (!b.clientPhone && b.phone) b.clientPhone = _bkDigits(b.phone);

  // service
  if (!b.service && b.serviceName) b.service = b.serviceName;

  return b;
}

async function persistBooking(rec) {
  try {
    if (!rec || typeof rec !== "object") return false;

    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    const incoming = _bkEnsureTimes({
      ...rec,
      updatedAt: nowIso,
      createdAt: rec.createdAt || nowIso,
    });

    const inPhoneKey = _bkPhoneKey(incoming.clientPhone || incoming.phone || "");
    const inStartISO = _bkToISO(
      incoming.startTime ||
      incoming.startMs ||
      incoming.start ||
      incoming.datetime ||
      incoming.date ||
      incoming.day
    );

    const mergeAt = async (idx) => {
      if (idx < 0) return false;
      arr[idx] = _bkEnsureTimes({
        ...arr[idx],
        ...incoming,
        createdAt: arr[idx]?.createdAt || incoming.createdAt || nowIso,
        updatedAt: nowIso,
      });
      return !!(await saveBookings(arr));
    };

    // 1) Dedup: eventId vince
    if (incoming.eventId) {
      const idx = arr.findIndex((b) => b && b.eventId === incoming.eventId);
      if (idx >= 0) return mergeAt(idx);
    }

    // 2) Dedup: composite (phone + startTime) - utile anche se eventId manca/è cambiato
    if (inPhoneKey && inStartISO) {
      const idx = arr.findIndex((b) => {
        const pKey = _bkPhoneKey(b?.clientPhone || b?.phone || "");
        const sISO = _bkToISO(
          b?.startTime || b?.startMs || b?.start || b?.datetime || b?.date || b?.day || null
        );
        return !!pKey && !!sISO && pKey === inPhoneKey && sISO === inStartISO;
      });
      if (idx >= 0) return mergeAt(idx);
    }

    arr.push(incoming);
    return !!(await saveBookings(arr));
  } catch {
    return false;
  }
}

async function updateBookingByEventId(eventId, patch) {
  try {
    if (!eventId) return false;
    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    let changed = false;
    for (const b of arr) {
      if (b && b.eventId === eventId) {
        Object.assign(b, patch || {});
        b.updatedAt = nowIso;
        _bkEnsureTimes(b);
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    return !!(await saveBookings(arr));
  } catch {
    return false;
  }
}

async function updateBookingByComposite(match, patch) {
  try {
    if (!match) return false;
    const arr = loadBookings();
    const nowIso = new Date().toISOString();

    const targetISO = _bkToISO(
      match.startTime ?? match.startMs ?? match.start ?? match.datetime ?? match.date ?? match.day ?? null
    );
    const phoneKey = _bkPhoneKey(match.clientPhone || match.phone || "");
    if (!targetISO || !phoneKey) return false;

    let changed = false;
    for (const b of arr) {
      const bISO = _bkToISO(
        b?.startTime ?? b?.startMs ?? b?.start ?? b?.datetime ?? b?.date ?? b?.day ?? null
      );
      const bPhoneKey = _bkPhoneKey(b?.clientPhone || b?.phone || "");
      if (bISO === targetISO && bPhoneKey === phoneKey) {
        Object.assign(b, patch || {});
        b.updatedAt = nowIso;
        _bkEnsureTimes(b);
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    return !!(await saveBookings(arr));
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
    const rows = loadBookings();
    if (!Array.isArray(rows) || !rows.length) return [];

    const now = Date.now();
    const want = _bkPhoneKey(phoneOrChatId);

    const phoneMatch = (x) => {
      const got = _bkPhoneKey(x);
      if (!want || !got) return false;
      if (want === got) return true;
      const min = 7;
      return want.endsWith(got.slice(-min)) || got.endsWith(want.slice(-min));
    };

    const toTs = (b) => {
      const ms = Number(b?.startMs);
      if (Number.isFinite(ms)) return ms;
      const iso = _bkToISO(b?.startTime || b?.start || b?.datetime || b?.date || b?.day || null);
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? t : NaN;
    };

    const out = rows
      .filter((b) => {
        const ts = toTs(b);
        if (!Number.isFinite(ts) || ts < now) return false;

        const st = String(b.status || b.state || "").toLowerCase();
        if (/(cancel|annull|deleted)/.test(st)) return false;

        const candidates = [
          b.clientPhone,
          b.customerPhone,
          b.phone,
          b.whatsapp,
          b.clientChatId,
          b.chatId,
        ];
        return candidates.some((c) => phoneMatch(c));
      })
      .sort((x, y) => toTs(x) - toTs(y));

    for (const x of out) _bkEnsureTimes(x);
    return out;
  } catch {
    return [];
  }
}

async function markBookingCancelled(eventId) {
  const ok = await updateBookingByEventId(eventId, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  });
  if (!ok) {
    try {
      log("warn", "[bookings] markBookingCancelled: eventId non trovato", { eventId });
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
  }
}

// ================= Soft-Hold helpers =================
function loadHolds() {
  return Array.isArray(__holdsCache) ? __holdsCache : [];
}


function saveHolds(arr) {
  __holdsCache = Array.isArray(arr) ? arr : [];
  __scheduleHoldsFlush();
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
function slotOverlapsExistingBookings(proEmail, s, e, opts = {}) {
  const day = new Date(s);
  const ignoreChatId = opts && opts.ignoreChatId ? String(opts.ignoreChatId) : null;

  // include anche hold altrui (ma possiamo ignorare il nostro hold quando serve)
  const booked = getBusyIntervalsForDay(day, proEmail, { ignoreChatId }) || [];
  for (const [bs, be] of booked) if (s < be && bs < e) return true;
  return false;
}
// ✅ FIX Bug #3: Lock atomico per prevenire race condition
const __holdLock = new Map(); // chatId => Promise
const HOLD_LOCK_TIMEOUT = 5000;

async function __withHoldLock(chatId, fn) {
  const key = String(chatId || 'global');

  // Attendi lock precedente con timeout
  if (__holdLock.has(key)) {
    const lockPromise = __holdLock.get(key);
    try {
      await Promise.race([
        lockPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Hold lock timeout')), HOLD_LOCK_TIMEOUT)
        )
      ]);
    } catch (err) {
      log('warn', '[HOLD_LOCK] Timeout o errore in lock precedente', { chatId: key, error: String(err) });
    }
  }

  // Crea nuovo lock
  let resolve, reject;
  const lockPromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  __holdLock.set(key, lockPromise);

  try {
    const result = await fn();
    resolve();
    return result;
  } catch (err) {
    reject(err);
    throw err;
  } finally {
    // Rimuovi lock solo se è ancora il nostro
    if (__holdLock.get(key) === lockPromise) {
      __holdLock.delete(key);
    }
  }
}

function acquireSoftHold({
  chatId,
  professionalEmail,
  startTime,
  durationMin,
}) {
  // ✅ FIX Bug #3: Operazione atomica con lock
  return __withHoldLock(chatId, () => {
    try {
      const s =
        startTime instanceof Date
          ? startTime.getTime()
          : new Date(startTime).getTime();
      const e = s + (Number(durationMin) || 30) * 60_000;
      const now = Date.now();
      const proEmail = String(professionalEmail || "").trim().toLowerCase();

      // ATOMICO: carica, valida, salva in una singola operazione
      let arr = cleanupHolds();

      // già tenuto da questo chat? aggiorna deadline (MA non bypassare conflitti con booking)
      for (const h of arr) {
        if (
          h.chatId === chatId &&
          String(h.professionalEmail || "").trim().toLowerCase() === proEmail &&
          h.startMs === s
        ) {
          // Se nel frattempo lo slot è diventato "booking", non rinnovare (evita doppie prenotazioni)
          if (slotOverlapsExistingBookings(proEmail, s, e, { ignoreChatId: chatId })) {
            log('warn', '[HOLD] Slot già prenotato (renew bloccato)', { chatId, time: new Date(s).toISOString() });
            return false;
          }

          h.expiresAt = now + HOLD_MINUTES * 60_000;
          saveHolds(arr);
          log('debug', '[HOLD] Rinnovato hold esistente', { chatId, time: new Date(s).toISOString() });
          return true;
        }
      }

      // ✅ FIX: Check conflitti PRIMA di modificare array
      // conflitti con altri hold
      for (const h of arr) {
        if (String(h.professionalEmail || "").trim().toLowerCase() === proEmail) {
          if (s < h.endMs && h.startMs < e && h.chatId !== chatId) {
            log('warn', '[HOLD] Slot già in hold da altro utente', {
              chatId,
              conflictWith: h.chatId,
              time: new Date(s).toISOString()
            });
            return false;
          }
        }
      }

      // conflitti con booking esistenti
      if (slotOverlapsExistingBookings(proEmail, s, e, { ignoreChatId: chatId })) {
        log('warn', '[HOLD] Slot già prenotato', { chatId, time: new Date(s).toISOString() });
        return false;
      }

      // crea hold
      arr.push({
        id: `${proEmail}|${s}|${chatId}|${now}`,
        professionalEmail: proEmail,
        chatId,
        startMs: s,
        endMs: e,
        createdAt: now,
        expiresAt: now + HOLD_MINUTES * 60_000,
      });

      saveHolds(arr);
      log('info', '[HOLD] Acquisito nuovo hold', { chatId, time: new Date(s).toISOString() });
      return true;
    } catch (err) {
      log('error', '[HOLD] Errore in acquireSoftHold', { chatId, error: String(err) });
      return false;
    }
  });
}
function releaseSoftHoldByChat(chatId) {
  const arr = loadHolds();
  const next = arr.filter((h) => h.chatId !== chatId);
  if (next.length !== arr.length) saveHolds(next);
}

// ✅ FIX Bug #7: Wrapper per garantire rilascio hold
async function __withAutoReleaseHold(chatId, holdFn, workFn) {
  let holdAcquired = false;
  try {
    holdAcquired = await holdFn();
    if (!holdAcquired) {
      log('warn', '[HOLD] Impossibile acquisire hold', { chatId });
      return { success: false, reason: 'hold_failed' };
    }

    const result = await workFn();
    return { success: true, result };
  } catch (err) {
    log('error', '[HOLD] Errore durante operazione con hold', { chatId, error: String(err) });
    return { success: false, reason: 'error', error: err };
  } finally {
    // ✅ SEMPRE rilascia hold, anche in caso di errore
    if (holdAcquired) {
      releaseSoftHoldByChat(chatId);
      log('debug', '[HOLD] Hold rilasciato', { chatId });
    }
  }
}



// ================= Review & Confirm followups =================

// Memorizza su chatdb che abbiamo appena chiesto il feedback (serve per non avviare flow di prenotazione se l'utente risponde "grazie", "tutto ok", ecc.)
function __rememberReviewPrompt(chatId, booking) {
  try {
    const db = loadChatDB();
    db[chatId] = db[chatId] || {};
    db[chatId].lastReviewPromptAt = Date.now();
    if (booking && booking.eventId) db[chatId].lastReviewPromptEventId = booking.eventId;
    if (booking && (booking.service || booking.serviceName)) db[chatId].lastReviewPromptService = booking.service || booking.serviceName;
    if (booking && booking.professionalName) db[chatId].lastReviewPromptPro = booking.professionalName;
    saveChatDB(db);
  } catch (e) {
    log("warn", "[review] remember prompt failed:", e?.message || e);
  }
}

function __markReviewReplied(chatId) {
  try {
    const db = loadChatDB();
    db[chatId] = db[chatId] || {};
    db[chatId].lastReviewReplyAt = Date.now();
    saveChatDB(db);
  } catch (e) {
    log("warn", "[review] mark reply failed:", e?.message || e);
  }
}

function __isBookingIntentText(s = "") {
  const t = String(s || "");
  // Se ci sono segnali di prenotazione, NON trattarlo come risposta al feedback
  if (/\b(prenot|appunt|disponibil|orari|slot|fiss|riserv|sposta|modifica|cambia|annulla)\w*/i.test(t)) return true;

  // segnali "data/ora" tipici della prenotazione (es. "domani alle 15", "lunedi 10:30", "23/10")
  if (/\b(oggi|domani|dopodomani|stasera|stamattina|pomeriggio|sera)\b/i.test(t)) return true;
  if (/\b(luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)\b/i.test(t)) return true;
  if (/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/.test(t)) return true;
  if (/\balle?\s*\d{1,2}(?:[\.:]\d{2})?\b/i.test(t)) return true;
  if (/\b\d{1,2}[\.:]\d{2}\b/.test(t)) return true;

  return false;
}

function __looksLikeReviewAnswer(s = "") {
  const raw = String(s || "").trim();
  if (!raw) return false;

  // Reazioni emoji tipiche (👍🙏❤️ ecc.) usate spesso come risposta al feedback
  if (/^(?:👍|👌|🙏|❤️|❤|💙|💚|💛|💜|🧡|💖|💗|💓|💕|💞|💝|😊|🙂|😀|😁|😄|😃|😆|😅|🤣|😂|😍|🥰|😘|😗|😙|😚|🤗|🤩|😇|🥳|🌟|⭐|✨|💫|🔥|💯|✅|✔️|☑️|👏|🙌|👐|🤝|💪|🎉|🎊|🎈|🎁|😔|😞|😟|😢|😭|😤|😠|😡|🤔|😐|😑|😶|🙄|😬|😰|😨|😓|🤷|🤦|👎|💔|😕|🫤)+$/u.test(raw.replace(/\s+/g, ""))) return true;

  // Normalizza e rimuovi eventuali saluti iniziali ("ciao", "buongiorno", ecc.)
  const lower = raw.toLowerCase();
  const core = lower
    .replace(/^(?:ciao|salve|buongiorno|buonasera|buon\s*pomeriggio|buonanotte|hey|ehi|ehilà|salut|oh|ah|uh|eh|bella|bello|we|weilà|ciaone|salutone)\b[\s,!.:-]*/i, "")
    .trim();

  // Keyword feedback (positivo/negativo) - ampliato
  if (/\b(andat[oa]|tutto\s+(?:bene|ok|a\s+posto|perfetto|apposto)|ben(?:e|issim[oa]|one)|ottim[oa]|perfett[oa]|eccellente|fantastico|meraviglios[oa]|splendid[oa]|favolos[oa]|strepitos[oa]|grandios[oa]|magnifico|stupend[oa]|super|top|mitico|grande|fortissim[oa]|genial[ei]|alla\s+grande|di\s+lusso|bomba|spettacol(?:o|are)|pazzesc[oa]|straordinari[oa]|eccelso|impeccabile|ineccepibile|formidabile|mal[ei]|pessim[oa]|cos[iì]\s*cos[iì]|non\s+(?:bene|ok|male)|non\s+mi\s+(?:è\s+)?piaciut[oa]|non\s+mi\s+sono\s+trovat[oa]|non\s+sono\s+soddisfatt[oa]|delus[oa]|deludente|delusione|problem[ai]|difficolt[àa]|disastros[oa]|terribile|orribile|orr[eo]nd[oa]|spaventos[oa]|schifos[oa]|insufficiente|insoddisfacente|scadente|mediocre|scarso|inaccettabile|inadeguato|deprimente|frustrante|irritante|sfortunat[oa]|peccato)\b/i.test(core)) {
    return true;
  }

  // Risposte brevi tipiche ("bene grazie", "ok", "grazie mille", ecc.) - ampliato
  if (/^(?:ok(?:ay)?|va\s+bene|bene|benissimo|d'accord[oa]|perfetto|certo|certamente|assolutamente|esatto|esattamente|s[iì]|ovvio|chiaro|capito|ricevuto|inteso|affermat(?:ivo|ivamente)|male|no|niente|nulla|negativo|cos[iì]\s*cos[iì]|mah|boh|beh|ehm|uhm|mmm|forse|non\s+so|vedr(?:emo|ò)|grazie(?:\s+(?:mille|infinite|tanto|di\s+cuore|molte))?|graziee+|grazieee+|mille\s+grazie|ti\s+ringrazio|la\s+ringrazio|vi\s+ringrazio|ringrazio|apprezzat[oa]|gentile|gentilissim[oa]|scusa|scusami|scusate|mi\s+scuso|mi\s+dispiace|peccato|spiacente|cia[ou]|a\s+presto|alla\s+prossima|ci\s+vediamo|a\s+dopo|a\s+domani|buona\s+giornata|buona\s+serata)\b/i.test(core)) {
    return true;
  }

  // Espressioni colloquiali complete
  if (/^(?:(?:tutto|va|è\s+andato)\s+(?:bene|ok|benissimo|perfetto|alla\s+grande)|nessun\s+problema|non\s+c'è\s+(?:problema|di\s+che)|di\s+niente|figurati|ci\s+mancherebbe|ma\s+figurati|ma\s+quando\s+mai|non\s+preoccuparti|non\s+ti\s+preoccupare|tranquill[oa]|stai\s+tranquill[oa]|grazie\s+(?:a\s+te|a\s+voi|per\s+tutto)|prego|di\s+nulla|è\s+stato\s+un\s+piacere|piacer(?:e|issimo)|lieto|con\s+piacere|volentieri|certamente|assolutamente|ovviamente|naturalmente|chiaramente|sicuramente|senza\s+dubbio|certo\s+che\s+s[iì]|ma\s+certo|eccome|come\s+no|e\s+come|senz'altro)\b/i.test(core)) {
    return true;
  }

  // Cattura "bene" / "ok" / "grazie" in frasi brevi (limite aumentato a 80 caratteri)
  if (core.length <= 80 && /\b(?:bene|benissimo|benone|ok(?:ay)?|grazie|tutto\s+(?:bene|ok|apposto|a\s+posto)|va\s+bene|va\s+tutto\s+bene|alla\s+grande|perfetto|ottimo|fantastico|eccellente|super|top|male|pessimo|cos[iì]\s*cos[iì]|non\s+male|niente\s+male|male\s+male|non\s+c'è\s+male|maluccio|malino|problema|nessun\s+problema|senza\s+problemi|tutto\s+risolto|risolto|capito|compreso|chiaro|perfettamente|d'accordo|sono\s+d'accordo)\b/i.test(core)) {
    return true;
  }

  return false;
}
// Se l'utente sta rispondendo a "Com'è andata ...", rispondi e STOP (senza avviare prenotazione)
async function maybeHandleReviewReply(client, chatId, text, state) {
  const msg = String(text || "").trim();
  if (!msg) return false;
  if (__isBookingIntentText(msg)) return false;

  const step = String(state?.step || "");
  const inFlow = !!(step && step !== "collect" && !(step.startsWith && step.startsWith("edit_")));

  // Leggi contesto dal chatdb (se abbiamo appena inviato la richiesta feedback)
  const now = Date.now();
  let withinWindow = false;
  let alreadyReplied = false;
  let svc = null;
  let pro = null;

  try {
    const db = loadChatDB();
    const row = db && db[chatId] ? db[chatId] : null;
    const lastPrompt = Number(row?.lastReviewPromptAt || 0) || 0;
    const lastReply = Number(row?.lastReviewReplyAt || 0) || 0;
    svc = row?.lastReviewPromptService || null;
    pro = row?.lastReviewPromptPro || null;

    const WINDOW_MS = 72 * 60 * 60 * 1000; // 72 ore
    withinWindow = !!(lastPrompt && (now - lastPrompt) < WINDOW_MS);
    alreadyReplied = !!(lastPrompt && lastReply && lastReply > lastPrompt);
  } catch (e) { }

  const looksLike = __looksLikeReviewAnswer(msg);

  // ✅ Anti-falso-positivo: "ok/grazie/perfetto" NON sono feedback
  if (/^\s*(?:ok(?:ay)?|va\s+bene|perfetto|grazie(?:\s+mille)?|capito|ricevuto)\s*[!.]*\s*$/i.test(msg)) {
    return false;
  }

  // ✅ Rispondi come "feedback" SOLO se abbiamo chiesto davvero una recensione di recente
  if (!withinWindow) return false;

  // Se siamo in mezzo a un flow, intercetta SOLO se il testo è chiaramente feedback
  if (inFlow && !/\b(andat[oa]|tutto\s+(?:bene|ok)|male|pessim|cos[iì]\s*cos[iì])\b/i.test(msg)) {
    return false;
  }

  if (alreadyReplied) return false;
  if (!looksLike) return false;

  // Risposta in base al tono
  const negative = /\b(male|pessim|non\s+(?:bene|ok)|brutt|delus|problema|fastid|dolor|scontent)\b/i.test(msg);
  const positive = /\b(bene|benissim|ottim|perfett|stupend|top|favolos|bellissim|tutto\s+(?:bene|ok)|a\s+posto)\b/i.test(msg);

  let resp = "Grazie per il feedback! 😊";
  if (positive) {
    const svcTxt = svc ? ` per la ${svc}` : "";
    const proTxt = pro ? ` con ${pro}` : "";
    resp = `Grazie! Ci fa davvero piacere${svcTxt}${proTxt} 😊`;
  } else if (negative) {
    resp = "Mi dispiace 😕 Vuoi dirmi cosa non è andato? Così possiamo migliorare.";
  }

  await reply(client, chatId, resp, { noFooter: true });

  // marca come risposta al feedback (evita che i prossimi "ok" vengano catturati)
  __markReviewReplied(chatId);
  return true;
}

export function buildReviewMessage(b) {
  const name = b?.customerName ? ` ${b.customerName}` : "";
  const svc = b?.service || b?.serviceName || "il trattamento";
  const pro = b?.professionalName ? ` con ${b.professionalName}` : "";
  const link = "https://shorturl.at/es4kd";
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
        try { __rememberReviewPrompt(toId, b); } catch (e) { }
        await updateBookingByEventId(b.eventId, {
          reviewAsked: true,
          reviewAskedAt: new Date().toISOString(),
        });
        sent++;
      } catch (e) {
        log("warn", "[reviewFollowupsTick] invio fallito:", e?.message || e);
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
        await updateBookingByEventId(b.eventId, {
          confirmAsked: true,
          confirmAskedAt: new Date().toISOString(),
        });
        sent++;
      } catch (e) {
        log("warn",
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
  "la", "il", "lo", "i", "gli", "le", "un", "uno", "una", "con", "da", "dal", "dalla", "dallo", "dall", "dall'", "dei", "degli", "delle",
  "di", "de", "del", "dello", "della", "a", "ad", "al", "allo", "alla", "ai", "agli", "alle", "per", "su", "in", "nel", "nello", "nella",
  "nei", "negli", "nelle", "e", "ed", "o"
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

  // 3) token univoco in frase -> pro certo (anche con piccoli refusi)
  for (const w of words) {
    const arr = tokenToPros.get(w);
    if (arr && arr.length === 1) return arr[0];

    // fuzzy: cerca token “simile” univoco tra i pro
    if (typeof isTypoClose === "function") {
      let foundPro = null;
      let foundCount = 0;

      for (const [tok, pros] of tokenToPros.entries()) {
        if (!pros || pros.length !== 1) continue;

        const md = Math.min(
          2,
          (typeof typoMaxDist === "function") ? typoMaxDist(Math.max(w.length, tok.length)) : 1
        );
        if (md <= 0) continue;

        if (isTypoClose(w, tok, md)) {
          foundCount++;
          foundPro = pros[0];
          if (foundCount > 1) break; // non è più “univoco”
        }
      }

      if (foundCount === 1 && foundPro) return foundPro;
    }
  }

  // 4) fallback: più token in comune (anche fuzzy)
  let best = null, bestScore = 0;
  const setW = new Set(words);

  for (const p of list || []) {
    const toks = _proNameTokens(p?.name);
    if (!toks.length) continue;

    let hit = 0;
    for (const tok of toks) {
      if (setW.has(tok)) {
        hit++;
        continue;
      }

      if (typeof isTypoClose === "function") {
        const ok = words.some((w) => {
          const md = Math.min(
            2,
            (typeof typoMaxDist === "function") ? typoMaxDist(Math.max(w.length, tok.length)) : 1
          );
          return md > 0 && isTypoClose(w, tok, md);
        });
        if (ok) hit++;
      }
    }

    const score = hit / toks.length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (best && bestScore >= 0.5) return best;

  return null;
}

/**
 * Permette di selezionare una prenotazione scrivendo testo libero
 * Esempi:
 * - "ceretta"
 * - "ceretta sopracciglia alle 09:00"
 * - "semipermanente 12.30"
 */
function pickBookingIndexFromFreeText(raw, list) {
  const s = _n(raw);
  if (!s) return NaN;

  // time -> minutes (se presente)
  let wantMin = null;
  const tm = s.match(/\b([01]?\d|2[0-3])(?:[:\. ]([0-5]\d))\b/);
  if (tm) {
    wantMin = Number(tm[1]) * 60 + Number(tm[2] || "0");
  } else {
    const hm = s.match(/\b(?:alle|ore)\s*([01]?\d|2[0-3])\b/);
    if (hm) wantMin = Number(hm[1]) * 60;
  }

  // query "servizio" (ripulisci numeri/orari)
  const q = _n(
    s
      .replace(/\b([01]?\d|2[0-3])(?:[:\.][0-5]\d)?\b/g, " ")
      .replace(/\b(alle|ore)\b/g, " ")
  ).trim();

  const qToks = _tok(q).filter((t) => t && t.length >= 3);
  if (!qToks.length) return NaN;

  const getSvc = (b) => _n(b?.service || b?.serviceName || b?.title || "");
  const getStart = (b) => {
    const raw = (b && (b.startTime ?? b.start ?? b.datetime ?? b.date ?? b.when)) ?? null;
    if (!raw) return null;
    if (raw instanceof Date) return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw);
    const dt = new Date(String(raw));
    return Number.isFinite(dt.getTime()) ? dt : null;
  };

  let best = { idx: -1, score: 0 };
  let second = { idx: -1, score: 0 };

  for (let i = 0; i < (list || []).length; i++) {
    const b = list[i];
    const svc = getSvc(b);
    if (!svc) continue;

    let score = 0;

    // 1) match diretto contains
    if (svc.includes(q) || q.includes(svc)) {
      score += 0.75;
    } else {
      // 2) overlap token
      const svcSet = new Set(_tok(svc));
      let hit = 0;
      for (const t of qToks) if (svcSet.has(t)) hit++;
      score += 0.65 * (hit / qToks.length);
    }

    // 3) bonus time
    if (wantMin != null) {
      const dt = getStart(b);
      if (dt) {
        const gotMin = dt.getHours() * 60 + dt.getMinutes();
        const diff = Math.abs(gotMin - wantMin);
        if (diff <= 10) score += 0.30;
        else if (diff <= 20) score += 0.22;
        else if (diff <= 30) score += 0.15;
        else if (diff <= 60) score += 0.08;
      }
    }

    // keep top2
    if (score > best.score) {
      second = best;
      best = { idx: i, score };
    } else if (score > second.score) {
      second = { idx: i, score };
    }
  }

  // soglie: deve essere abbastanza sicuro, e non troppo ambiguo
  if (best.idx >= 0 && best.score >= 0.55) {
    if (second.idx >= 0 && second.score >= 0.55 && Math.abs(best.score - second.score) < 0.10) {
      return NaN; // ambiguo: fai scegliere il numero
    }
    return best.idx;
  }
  return NaN;
}

function pickBookingMatchFromFreeText(raw, list) {
  const idx = pickBookingIndexFromFreeText(raw, list);
  if (Number.isFinite(idx)) return { kind: "hit", idx };

  // Se non è un hit, proviamo a capire se è un caso "ambiguo" (es. più cerette nello stesso periodo)
  const s = _n(raw);
  if (!s) return null;

  const STOP = new Set([
    "alle",
    "ore",
    "il",
    "lo",
    "la",
    "i",
    "gli",
    "le",
    "un",
    "una",
    "uno",
    "di",
    "del",
    "della",
    "da",
    "con",
    "per",
    "a",
    "in",
    "su",
    "nel",
    "nella",
    "oggi",
    "domani",
    "ieri",
  ]);

  // query "servizio" (ripulisci numeri/orari)
  const q = _n(
    s
      .replace(/\b([01]?\d|2[0-3])(?:[:\.][0-5]\d)?\b/g, " ")
      .replace(/\b(alle|ore)\b/g, " ")
  ).trim();

  const qToks = _tok(q).filter(
    (t) => t && t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)
  );
  if (!qToks.length) return null;

  const getSvc = (b) => _n(b?.service || b?.serviceName || b?.title || "");
  const getStart = (b) => {
    const raw =
      (b && (b.startTime ?? b.start ?? b.datetime ?? b.date ?? b.when)) ?? null;
    if (!raw) return null;
    if (raw instanceof Date) return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw);
    const dt = new Date(String(raw));
    return Number.isFinite(dt.getTime()) ? dt : null;
  };

  // time hint: "18:30" / "alle 18" / "18h"
  const pickTimeHint = () => {
    let m = s.match(/\b([01]?\d|2[0-3])\s*[:\.]\s*([0-5]\d)\b/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = s.match(/\b(?:alle|ore)\s*([01]?\d|2[0-3])\b/);
    if (m) return Number(m[1]) * 60;
    m = s.match(/\b([01]?\d|2[0-3])\s*h\b/);
    if (m) return Number(m[1]) * 60;
    return null;
  };
  const wantMin = pickTimeHint();

  const scored = [];
  for (let i = 0; i < (list || []).length; i++) {
    const b = list[i];
    const svc = getSvc(b);
    if (!svc) continue;

    let score = 0;

    // 1) match diretto contains
    if (svc.includes(q) || q.includes(svc)) {
      score += 0.75;
    } else {
      // 2) overlap token
      const svcSet = new Set(_tok(svc));
      let hit = 0;
      for (const t of qToks) if (svcSet.has(t)) hit++;
      score += 0.65 * (hit / qToks.length);
    }

    // 3) bonus time
    if (wantMin != null) {
      const dt = getStart(b);
      if (dt) {
        const gotMin = dt.getHours() * 60 + dt.getMinutes();
        const diff = Math.abs(gotMin - wantMin);
        if (diff <= 10) score += 0.30;
        else if (diff <= 20) score += 0.22;
        else if (diff <= 30) score += 0.15;
        else if (diff <= 60) score += 0.08;
      }
    }

    if (score > 0) scored.push({ idx: i, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];

  // se i due migliori sono molto vicini, è ambiguo: mostriamo le candidate
  if (
    best &&
    best.score >= 0.55 &&
    second &&
    second.score >= 0.55 &&
    Math.abs(best.score - second.score) < 0.10
  ) {
    const top = scored
      .filter((x) => x.score >= 0.55 && Math.abs(x.score - best.score) < 0.10)
      .slice(0, 4);
    return { kind: "ambiguous", candidates: top.map((x) => x.idx) };
  }

  return null;
}



// Ritorna l'elenco dei pro validi per il servizio (se configurati), altrimenti tutti
function proCatalog(service) {
  const dbPros = cfgServiceProfessionals(service);
  if (dbPros.length) return dbPros;
  return __dbAllPros();
}

// Prompt numerato (0 = nessuna preferenza)
function renderProPrompt(list) {
  if (!list.length) {
    return '⚠️ Non ho professionisti configurati per questo servizio: non posso completare la prenotazione. Scrivi "annulla".';
  }
  const lines = list.map((p, i) => `${i + 1}) ${p.name}`).join("\n");

  return `🌸 Preferisci una professionista in particolare?
0) Nessuna preferenza
${lines}

Rispondi con *0*, con un numero (1-${list.length}) oppure scrivi il *nome*.
(0-${list.length})`;
}

// Parsing risposta utente -> { any:true } oppure {email,name} oppure null se invalida
function resolveProReply(reply, list) {
  const txt = (reply || "").trim();
  const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "3" "3)" "3."

  // no-preference textual answers
  if (/\b(no|non\s+mi\s+interessa|chiunque|qualsiasi|indifferente|nessuno|no\s+grazie)\b/i.test(txt)) {
    return { any: true, noPreference: true };
  }


  // 🆕 "Sì/ok" quando c'è una sola scelta: interpreta come "scegli l'unico professionista"
  // (evita che l'utente resti bloccato quando l'elenco è: 0) Indietro, 1) Diana)
  if (/\b(si|sì|ok|okay|va\s*bene|certo|perfetto|yes|yep)\b/i.test(txt)) {
    if (Array.isArray(list) && list.length === 1) return list[0];
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
  return (__chatCache && typeof __chatCache === "object") ? __chatCache : {};
}
function saveChatDB(db) {
  if (db && typeof db === "object") {
    const now = Date.now();
    for (const id of Object.keys(db)) {
      if (!__chatAccessTime.has(id)) __chatAccessTime.set(id, now);
    }
    __chatCache = db;
  } else {
    __chatCache = {};
  }
  __evictChatCache();
  __scheduleChatFlush();
}

// ======================= PRIVACY (onboarding) =======================
// Invia una breve informativa privacy al primo messaggio (una sola volta per numero).
// Nota: testo generico - personalizzalo con i dati del tuo salone/contatti se vuoi.
const PRIVACY_NOTICE_VERSION = 1;

function chatIdToE164(chatId) {
  const digits = String(chatId || "")
    .replace(/@.*$/, "")
    .replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  if (digits.startsWith("+")) return digits;
  return "+" + digits;
}

function privacyNoticeTextIT() {
  return (
    "🔒 *Informativa Privacy (WhatsApp)*\n\n" +
    "Usiamo il tuo numero *solo* per gestire prenotazioni e comunicazioni legate agli appuntamenti.\n" +
    "I dati vengono salvati nel nostro sistema e non vengono condivisi con terzi.\n\n" +
    "✅ Puoi chiedere in qualsiasi momento: *\"privacy\"* per rileggere, oppure *\"cancella dati\"* per eliminare la cronologia chat.\n\n" +
    "Continuando la chat accetti questo utilizzo."
  );
}

function privacyNoticeTextEN() {
  return (
    "🔒 *Privacy notice (WhatsApp)*\n\n" +
    "We use your phone number *only* to manage bookings and appointment-related messages.\n" +
    "Data is stored in our system and not shared with third parties.\n\n" +
    "✅ At any time you can write: *\"privacy\"* to read this again, or *\"delete my data\"* to remove chat history.\n\n" +
    "By continuing you agree to this use."
  );
}

function getPrivacyText(chatId) {
  // Se in futuro userai davvero la lingua, qui puoi leggere getLang(chatId)
  return privacyNoticeTextIT();
}

function isGroupChatId(chatId) {
  return String(chatId || "").endsWith("@g.us");
}

function isNewsletterChatId(chatId) {
  return /@newsletter$/i.test(String(chatId || "").trim());
}

function isBroadcastChatId(chatId) {
  const value = String(chatId || "").trim().toLowerCase();
  return value === "status@broadcast" || value.endsWith("@broadcast");
}

function isUnsupportedAutomationChatId(chatId) {
  return isNewsletterChatId(chatId) || isBroadcastChatId(chatId);
}

function chatdbDeleteEntry(chatId) {
  const db = loadChatDB();
  if (db && db[chatId]) {
    delete db[chatId];
    __chatAccessTime.delete(String(chatId || ""));
    saveChatDB(db);
    void __deleteChatSessionFromPg(chatId).catch((error) => {
      log("error", "[chat] delete failed", {
        chatId,
        error: String(error?.message || error),
      });
    });
    return true;
  }
  return false;
}

function markPrivacySent(chatId) {
  __updateChatDB(chatId, (entry, now) => ({
    ...entry,
    privacy: {
      ...(entry?.privacy || {}),
      version: PRIVACY_NOTICE_VERSION,
      sentAt: entry?.privacy?.sentAt || now,
    },
  }));
}

async function maybeSendPrivacyNotice(client, chatId) {
  try {
    if (!client) return false;
    if (!chatId || isGroupChatId(chatId) || isUnsupportedAutomationChatId(chatId)) return false;

    const db = loadChatDB();
    const entry = db[chatId] || null;

    const sentAt = entry?.privacy?.sentAt || 0;
    const ver = entry?.privacy?.version || 0;

    // invia se mai inviata oppure se aggiorni versione
    if (sentAt && ver >= PRIVACY_NOTICE_VERSION) return false;

    const text = getPrivacyText(chatId);

    // 1) invia prima; se fallisce non segnare come "sent"
    const __sent = await safeSend(client, chatId, text, { noFooter: true });
    if (!__sent) return false;

    // 2) persisti dopo invio
    __updateChatDB(chatId, (current, now) => ({
      ...(current || entry || { msgs: [] }),
      privacy: {
        ...((current || entry)?.privacy || {}),
        version: PRIVACY_NOTICE_VERSION,
        sentAt: now,
      },
    }));

    log("info", "[privacy] sent", { chatId });
    return true;
  } catch (e) {
    log("warn", "[privacy] send failed", { chatId, error: e?.message || String(e) });
    return false;
  }
}

function privacyCommandKind(txt = "") {
  const s = String(txt || "").trim().toLowerCase();
  if (!s) return null;
  if (/\bprivacy\b|\binformativa\b|\bdati\s+personali\b/i.test(s)) return "show";
  if (/\bcancella\s+dati\b|\belimina\s+dati\b|\bdelete\s+my\s+data\b/i.test(s)) return "delete";
  return null;
}
// ===================== END PRIVACY =====================

function appendUserMessage(chatId, text) {
  if (!chatId || isUnsupportedAutomationChatId(chatId)) return;

  const db = loadChatDB();
  const now = Date.now();

  const current = db[chatId];
  const entry =
    current && typeof current === "object" && !Array.isArray(current)
      ? current
      : {};

  if (!Array.isArray(entry.msgs)) entry.msgs = [];
  db[chatId] = entry;

  // Identità minima (utile anche per privacy check)
  entry.firstSeenAt = entry.firstSeenAt || now;
  entry.phone = entry.phone || chatIdToE164(chatId) || String(chatId || "");

  entry.msgs.push(String(text || "").slice(0, 800));
  if (entry.msgs.length > 5) {
    entry.msgs = entry.msgs.slice(-5);
  }

  // Aggiorna il timestamp di ultima attività dell'utente
  entry.lastActive = now;
  __touchChat(chatId);
  saveChatDB(db);
  void __dbInsertChatMessage(chatId, "in", text);
}
function getRecentMessages(chatId) {
  const db = loadChatDB();
  return Array.isArray(db?.[chatId]?.msgs) ? db[chatId].msgs : [];
}
function getLastService(chatId) {
  const memoryService = __getChatMemory(chatId)?.lastService || null;
  if (memoryService) return memoryService;

  const arr = loadBookings()
    .filter((b) => b.clientPhone === chatId && b.status === "confirmed")
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  return arr[0]?.service || null;
}
function getLastInfoTopic(chatId) {
  return __getChatMemory(chatId)?.lastInfoTopic || null;
}
function rememberService(chatId, service) {
  if (!chatId || !service) return null;
  return __updateChatDB(chatId, (entry, now) => ({
    ...entry,
    memory: {
      ...(entry?.memory || {}),
      lastService: String(service),
      lastServiceAt: now,
    },
  }));
}
function rememberInfoTopic(chatId, topic) {
  if (!chatId || !topic) return null;
  return __updateChatDB(chatId, (entry, now) => ({
    ...entry,
    memory: {
      ...(entry?.memory || {}),
      lastInfoTopic: String(topic),
      lastInfoTopicAt: now,
    },
  }));
}

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

  if (isUnsupportedAutomationChatId(chatId)) {
    log("info", "safeSend: skipping unsupported chatId", {
      chatId,
      kind: isNewsletterChatId(chatId) ? "newsletter" : "broadcast",
    });
    return "";
  }

  // Dedup: se inviamo lo stesso testo a distanza ravvicinata, salta
  const __win = Math.max(0, Number(opts?.dedupWindowMs) || 2000);
  if (!__dedupAllow(chatId, t, __win)) return "";

  // ✅ PATCH: Verifica che il client sia pronto
  if (!client || typeof client.sendText !== "function") {
    log("warn", "safeSend: client.sendText not available", { chatId });
    if (opts?.throwOnError) {
      throw new SafeSendError("client.sendText not available", { chatId });
    }
    return "";
  }

  const MAX_RETRIES = Math.max(1, Number(opts?.maxRetries) || 3);
  const RETRY_DELAY = Math.max(100, Number(opts?.retryDelayMs) || 1000);
  let lastError = null;
  let delivered = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.sendText(chatId, t);
      __dedupRemember(chatId, t);
      log("info", `[SEND OK] attempt ${attempt}`, { chatId, preview: t.slice(0, 50) });
      delivered = true;
      break;
    } catch (e) {
      lastError = e;
      log("warn", `[SEND FAIL] attempt ${attempt}/${MAX_RETRIES}`, {
        chatId,
        err: e?.message || String(e)
      });

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
      }
    }
  }

  if (!delivered) {
    const sendError = new SafeSendError("safeSend: tutti i tentativi falliti", {
      chatId,
      preview: t.slice(0, 120),
      attempts: MAX_RETRIES,
      cause: toErrorMeta(lastError),
    });
    log("error", sendError.message, sendError.details);
    if (opts?.throwOnError) throw sendError;
    return "";
  }

  void __dbInsertChatMessage(chatId, "out", t);

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

    // Solo durante un flow di prenotazione (non in edit/listini)
    const col = st.collected || {};
    const inEdit = typeof st.step === "string" && st.step.startsWith("edit_");
    const inInfo = ["info_select_service", "price_select_service"].includes(st.step);
    if (inEdit || inInfo) return;

    const active =
      (typeof isBookingFlowActive === "function" && isBookingFlowActive(st, col)) ||
      (typeof isBookingLocked === "function" && isBookingLocked(st));
    if (!active) return;

    // Mostra il suggerimento solo se l'utente sembra bloccato nello stesso step
    ensureContext(st);
    const confusion = Number(st.context.sameStepCount || 0) || 0;
    if (confusion < 2) return;

    const HINT = '💡 Suggerimento: scrivi *annulla* per ricominciare o *modifica* per gestire una prenotazione.';

    // evita loop: se il messaggio appena inviato contiene già il suggerimento, non reinviare
    if (String(sentText || "").includes("Suggerimento:")) return;

    // Cooldown: evita spam
    const __last = __FOOTER_COOLDOWN.get(chatId) || 0;
    if (Date.now() - __last < 60000) return;

    if (!client || typeof client.sendText !== "function") {
      log("warn", "postReplyHook: client.sendText not available", { chatId });
      return;
    }

    try {
      await client.sendText(chatId, HINT);
      __FOOTER_COOLDOWN.set(chatId, Date.now());
      __dedupRemember(chatId, HINT);
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
  const d = __toValidDate(dateLike);
  if (!d) return "";
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

  // refusi su comandi (es. "modifca", "modifia", ecc.)
  if (
    typeof fuzzyCmd === "function" &&
    (
      fuzzyCmd((s.split(/\s+/)[0] || ""), ["modifica", "modificare", "cambia", "cambiare"], { maxDist: 2 }) ||
      fuzzyCmd((s.split(/\s+/)[0] || ""), ["sposta", "spostare"], { maxDist: 1 })
    )
  )
    return true;

  // Verbi "forti" (chiaro intento di modificare/spostare/annullare)
  const strongActionRe =
    /\b(?:modific\w*|gestisc\w*|gestir\w*|cambi\w*|spost\w*|rinvi\w*|rimand\w*|posticip\w*|riprogramm\w*|slitt\w*|anticip\w*|annull\w*|cancell\w*|disdic\w*|inoltr\w*|tramand\w*|aggiorn\w*|corregg\w*|rettific\w*|ripianific\w*|rischedul\w*|reschedul\w*|rived\w*|risistem\w*)\b/i;

  // Verbi ambigui richiesti (inoltrare/tramandare): SOLO se scritti da soli
  const weakSoloCmdRe =
    /^\/?(?:inoltr[a-z]*|tramand[a-z]*)[\s!.?]*$/i;

  // Comandi secchi (anche senza contesto)
  const soloCmdStrongRe =
    /^\/?(?:edit|gestisci|gestire|cambia|sposta|spostare|rinvia|rimanda|rimandare|posticipa|posticipare|riprogramma|riprogrammare|slitta|slittare|anticipa|anticipare|annulla|annullare|cancella|cancellare|disdici|disdire)[\s!.?]*$/i;

  // Contesto tipico di appuntamento/prenotazione o cosa stai cambiando
  const ctxRe =
    /\b(?:appunt\w*|prenot\w*|booking|data|giorno|ora|orario|slot|professionist\w*|operatric\w*|operatore|nome|intestat\w*)\b/i;

  // Cue data/tempo
  const dateCueRe =
    /\b(?:oggi|domani|dopodomani|tra|fra|settimana|prossim\w*|luned\w*|marted\w*|mercoled\w*|gioved\w*|venerd\w*|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2})\b/i;

  // Indicatori tipici di NUOVA prenotazione (non "prenotazione" ma "prenotare/prenota...")
  const newBookingRe =
    /\b(?:prenota|prenotare|prenoto|prenoti|prenotiamo|prenotate|prenoterei|prenoter\w*|disponibilit\w*|avete\s+(?:posto|un\s+buco)|avresti\s+(?:posto|un\s+buco)|c\s*e\s+(?:posto|un\s+buco)|ce\s+(?:posto|un\s+buco)|siete\s+liber\w*|vorrei\s+prenot\w*|voglio\s+prenot\w*)\b/i;

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
        : `${fmtDate(booking.startTime || booking.day || new Date())} - ${booking.service || ""}`;

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
    } catch (err) {
      logIgnoredError("warmOllama.generate", err, { base, model });
    }

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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
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
          } catch (err) {
            log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
          }
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
  const D = __toValidDate(d);
  if (!D) return "";
  if (D.getFullYear && D.getFullYear() <= 1971) return "";
  return `${__pad2(D.getDate())}/${__pad2(D.getMonth() + 1)}/${D.getFullYear()}`;
}

// "domenica 28/12/2025"
function fmtDateWithWeekdayIT(d) {
  return formatDateWithWeekdayIT(d);
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
  return __hhmmToMinutes(hhmm) ?? 0;
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
  return __toHHMM(H, M) || "00:00";
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
  if (!t) return null;

  const txt = String(t).trim();

  const normSpaces = (x) => String(x || "").trim().replace(/\s+/g, " ");

  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---- Meridiem / contesto (soft) ----
  const ctxAM = /\b(?:mattina|stamattina|domattina)\b/.test(txt);
  const ctxPM = /\b(?:pomeriggio|sera|stasera)\b/.test(txt);

  const applyMeridiem = (h, localMer) => {
    let hh = h;
    const mer = localMer ? localMer.toLowerCase().replace(/\./g, "") : null;

    if (mer === "pm") hh = (hh % 12) + 12;
    else if (mer === "am") hh = hh % 12; // 12am => 0
    else if (ctxPM && !ctxAM && hh < 12) hh += 12;

    return hh;
  };

  // ---- Speciali ----
  if (/\bmezzogiorn/.test(txt)) return "12:00";
  if (/\bmezzanott/.test(txt)) return "00:00";

  // ---- Parole -> numeri (ore/minuti) ----
  const HOUR_WORDS = {
    zero: 0,
    una: 1, uno: 1,
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
    tredici: 13,
    quattordici: 14,
    quindici: 15,
    sedici: 16,
    diciassette: 17,
    diciotto: 18,
    diciannove: 19,
    venti: 20,
    ventuno: 21,
    "venti uno": 21,
    ventidue: 22,
    "venti due": 22,
    ventitre: 23,
    "venti tre": 23,
  };

  const MIN_WORDS = [
    ["tre quarti", 45],
    ["trequarti", 45],
    ["un quarto", 15],
    ["unquarto", 15],
    ["quarto", 15],
    ["quindici", 15],
    ["venticinque", 25],
    ["venti cinque", 25],
    ["venti", 20],
    ["dieci", 10],
    ["cinque", 5],
    ["mezza", 30],
    ["mezzo", 30],
    ["trenta", 30],
    ["quaranta", 40],
    ["cinquanta", 50],
    ["cinquantacinque", 55],
  ].sort((a, b) => b[0].length - a[0].length);

  const parseHourToken = (tok) => {
    const k = normSpaces(tok).toLowerCase();
    if (/^\d{1,2}$/.test(k)) return +k;
    if (HOUR_WORDS[k] != null) return HOUR_WORDS[k];
    return null;
  };

  const parseMinToken = (tok) => {
    const k = normSpaces(tok).toLowerCase();
    if (/^\d{1,2}$/.test(k)) return +k;
    for (const [key, val] of MIN_WORDS) {
      if (new RegExp(`\\b${escapeRegExp(key)}\\b`).test(k)) return val;
    }
    return null;
  };

  // Token ora: numero o parole (es. "nove", "venti due")
  const H_TOKEN = `(?:[01]?\\d|2[0-3]|[a-z]+(?:\\s+[a-z]+)?)`;
  const M_TOKEN = `(?:[0-5]?\\d|[a-z]+(?:\\s+[a-z]+)?)`;

  // 1) "9:30" / "9.30" / "9,30" / "9h30" (+ opzionale am/pm)
  {
    const m = txt.match(
      /\b([01]?\d|2[0-3])\s*(?:[:\.]|,|h)\s*([0-5]?\d)\s*(?:\s*(a\.?m\.?|p\.?m\.?|am|pm))?\b/
    );
    if (m) {
      const h = applyMeridiem(+m[1], m[3]);
      const mm = +m[2];
      const out = __toHHMM(h, mm);
      if (out) return out;
    }
  }

  // 2) "9 e 30" / "alle nove e mezza" / "ore 9 e un quarto"
  {
    const re = new RegExp(
      `\\b(?:alle?\\s+|ore\\s+|h\\s*|dalle\\s+)?(${H_TOKEN})\\s*(?:\\b(?:e|ed)\\b)\\s*(${M_TOKEN})\\b`,
      "i"
    );
    const m = txt.match(re);
    if (m) {
      const h0 = parseHourToken(m[1]);
      const mm0 = parseMinToken(m[2]);
      if (h0 != null && mm0 != null) {
        const h = applyMeridiem(h0, null);
        const out = __toHHMM(h, mm0);
        if (out) return out;
      }
    }
  }

  // 3) "10 meno 20" / "dieci meno un quarto"
  {
    const reNum = new RegExp(
      `\\b(?:alle?\\s+|ore\\s+|h\\s*)?(${H_TOKEN})\\s*meno\\s*(${M_TOKEN})\\b`,
      "i"
    );
    const m = txt.match(reNum);
    if (m) {
      const hRaw = parseHourToken(m[1]);
      const mmRaw = parseMinToken(m[2]);
      if (hRaw != null && mmRaw != null) {
        const hMer = applyMeridiem(hRaw, null);
        const h = (hMer - 1 + 24) % 24;
        const mm = 60 - mmRaw;
        const out = __toHHMM(h, mm);
        if (out) return out;
      }
    }
  }

  // 4) "930" / "0930" (solo se messaggio è “time-like” o c’è keyword)
  {
    const only = /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{3,4}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
      txt
    );
    const hasKw = /\b(?:alle?|ore|h|dalle)\b/.test(txt);

    if (only || hasKw) {
      const m = txt.match(/\b(\d{3,4})\b/);
      if (m) {
        const n = m[1];
        let hh, mm;
        if (n.length === 3) {
          hh = +n.slice(0, 1);
          mm = +n.slice(1);
        } else {
          hh = +n.slice(0, 2);
          mm = +n.slice(2);
        }
        if (hh <= 23 && mm <= 59) {
          const mer = txt.match(/\b(a\.?m\.?|p\.?m\.?|am|pm)\b/i)?.[1] || null;
          const h = applyMeridiem(hh, mer);
          const out = __toHHMM(h, mm);
          if (out) return out;
        }
      }
    }
  }

  // 5) "ore 9", "h9", "alle 9", "nove" (solo se “time-like” o con keyword)
  {
    const only =
      /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?[a-z0-9]+(?:\s+[a-z]+)?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
        txt
      );

    // se è una frase lunga, accetta solo se c’è keyword (evita date tipo "25/12")
    const allow =
      only || /\b(?:alle?|ore|h|dalle)\b/.test(txt);

    if (allow) {
      const re = new RegExp(
        `\\b(?:alle?\\s+|ore\\s+|h\\s*)?(${H_TOKEN})\\s*(?:\\b|$)\\s*(?:\\s*(a\\.?(?:m)\\.?|p\\.?(?:m)\\.?|am|pm))?\\b`,
        "i"
      );
      const m = txt.match(re);
      if (m) {
        const h0 = parseHourToken(m[1]);
        if (h0 != null) {
          const h = applyMeridiem(h0, m[2]);
          const out = __toHHMM(h, 0);
          if (out) return out;
        }
      }
    }
  }

  // 6) "9 30" (spazio) SOLO se è chiaramente un orario (evita "25 12" = data)
  {
    const m = txt.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/);
    if (m) {
      const isSafe =
        /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{1,2}\s+\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
          txt
        ) || /\b(?:alle?|ore|h|dalle)\b/.test(txt);

      if (isSafe) {
        const mer = txt.match(/\b(a\.?m\.?|p\.?m\.?|am|pm)\b/i)?.[1] || null;
        const h = applyMeridiem(+m[1], mer);
        const out = __toHHMM(h, +m[2]);
        if (out) return out;
      }
    }
  }

  return null;
}

// ---- NEW: interpreta "11/12", "11-12" come intervallo orario se il contesto sembra tempo ----
function parseTimeRangeFallback(s = "") {
  if (!s) return null;

  const t = String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return null;

  // Attiva fallback solo se ci sono indizi di "range/approssimazione"
  // (evita di sovrascrivere date reali tipo 11/12 come "orario")
  const hasTimeHint =
    /\b(verso|intorn(?:o|a)|circa|tipo|dalle|tra|fra|entro|ore|alle|h|mattin|pomerigg|sera|tarda|pranzo|cena)\b/i.test(
      t
    );

  // Se la stringa contiene una data "forte" (gg/mm/aaaa o gg-mm-aaaa), non attivare
  const hasStrongDate =
    /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(t) ||
    /\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b/.test(t);

  if (!hasTimeHint || hasStrongDate) return null;

  // Pattern: "11/12" "11-12" "11 – 12" "11 / 12"
  // Nota: SOLO ore (0-23), senza minuti.
  const m = t.match(/\b([01]?\d|2[0-3])\s*[\/\-–-]\s*([01]?\d|2[0-3])\b/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Se sembra un range "orario" vero (a < b) o invertito (b < a), scegli un punto sensato:
  // - se adiacenti: :30 (tra le due ore)
  // - altrimenti: ora più bassa con :00
  // - caso wrap (23-0 o 0-23): scegli 23:30 per 23/0, e 00:30 per 0/1 ecc.
  const diff = Math.abs(a - b);
  const isWrap = (a === 23 && b === 0) || (a === 0 && b === 23);

  let hh;
  let mm;

  if (isWrap) {
    hh = 23;
    mm = 30;
  } else if (diff === 1) {
    hh = Math.min(a, b);
    mm = 30;
  } else {
    hh = Math.min(a, b);
    mm = 0;
  }

  return __toHHMM(hh, mm);
}


// modifica parseTimeSmart per provare anche il fallback degli intervalli
function parseTimeSmart(s = "") {
  const raw = String(s ?? "");

  // Preferisci orari introdotti da keyword ("alle", "ore", "h") per evitare
  // falsi positivi tipo: "il 13 alle 17" -> non prendere 13:00 (giorno), ma 17:00 (orario).
  try {
    const cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, " ");
    const kwRe = /\b(?:alle?|ore|h|dalle)\b/gi;

    const hits = [];
    let m;
    while ((m = kwRe.exec(cleaned)) !== null) hits.push(m.index);

    // Prova dalla keyword PIÙ a destra (tipicamente l'orario è lì vicino)
    for (let i = hits.length - 1; i >= 0; i--) {
      const sub = cleaned.slice(hits[i]);
      const t = parseHHMM(sub) || parseNaturalTime(sub) || parseTimeRangeFallback(sub);
      if (t) return t;
    }
  } catch {
    // no-op
  }

  return parseHHMM(raw) || parseNaturalTime(raw) || parseTimeRangeFallback(raw);
}



function parseHHMM(s) {
  const t = (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (h, m) => {
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${pad2(h)}:${pad2(m)}`;
  };

  // euristica: se la stringa è "time-like" oppure contiene keyword
  const isTimeLike =
    /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{1,4}(?:\s*[:.,h]\s*\d{1,2})?\s*(?:am|pm)?\s*$/i.test(
      t
    ) || /\b(?:alle?|ore|h|dalle)\b/.test(t);

  // 1) 12h: "10pm", "10 pm", "10:30pm", "10.30 pm"
  {
    const m = t.match(
      /\b(1[0-2]|0?[1-9])\s*(?:[:.,h]|\s)\s*([0-5]\d)?\s*(am|pm)\b/
    );
    if (m) {
      let h = +m[1];
      const mm = m[2] != null ? +m[2] : 0;
      const ap = m[3];

      if (ap === "am") {
        if (h === 12) h = 0;
      } else {
        if (h !== 12) h += 12;
      }

      const out = clamp(h, mm);
      if (out) return out;
    }
  }

  // 2) 12h: "930pm" / "0930pm"
  {
    const m = t.match(/\b(\d{3,4})\s*(am|pm)\b/);
    if (m) {
      const n = m[1];
      let h = 0,
        mm = 0;

      if (n.length === 3) {
        h = +n.slice(0, 1);
        mm = +n.slice(1);
      } else {
        h = +n.slice(0, 2);
        mm = +n.slice(2);
      }

      if (h >= 1 && h <= 12 && mm >= 0 && mm <= 59) {
        const ap = m[2];
        if (ap === "am") {
          if (h === 12) h = 0;
        } else {
          if (h !== 12) h += 12;
        }
        const out = clamp(h, mm);
        if (out) return out;
      }
    }
  }

  // 3) 24h: "9:30", "9.30", "9,30", "9h30"
  {
    const m = t.match(/\b([01]?\d|2[0-3])\s*[:.,h]\s*([0-5]?\d)\b/);
    if (m) {
      const out = clamp(+m[1], +m[2]);
      if (out) return out;
    }
  }

  // 4) 24h: "9 30" (solo se time-like, evita "25 12" come data)
  {
    const m = t.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/);
    if (m && isTimeLike) {
      const out = clamp(+m[1], +m[2]);
      if (out) return out;
    }
  }

  // 5) 24h compatto: "930" / "0930" (solo se time-like o keyword)
  {
    const m = t.match(/\b(\d{3,4})\b/);
    if (m && isTimeLike) {
      const n = m[1];
      let h, mm;
      if (n.length === 3) {
        h = +n.slice(0, 1);
        mm = +n.slice(1);
      } else {
        h = +n.slice(0, 2);
        mm = +n.slice(2);
      }
      const out = clamp(h, mm);
      if (out) return out;
    }
  }

  // 6) 24h: hour only "9" (solo se time-like o keyword)
  {
    const m = t.match(/\b([01]?\d|2[0-3])\b/);
    if (m && isTimeLike) {
      const out = clamp(+m[1], 0);
      if (out) return out;
    }
  }

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
  return __normalizeText(s, { stripPunctuation: true, collapseWhitespace: true });
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
  return __normalizeText(s);
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
  return __normalizeText(text);
}

// ============== Riconoscimento servizio ==============
function cfgServices() {
  return Array.isArray(__servicesListCache) ? __servicesListCache.slice() : [];
}
function cfgServiceItem(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const canon = __svcKeyToName.get(__svcKey(raw)) || raw;
  return __servicesItemCache.get(canon) || null;
}
function cfgServiceSynonyms(service) {
  const it = cfgServiceItem(service) || {};
  const base = Array.isArray(it.synonyms) ? it.synonyms : [];

  // 🆕 include anche label/name così l'utente può scrivere quello che vede in chat
  const extra = [];
  if (it.label) extra.push(it.label);
  if (it.name) extra.push(it.name);

  const out = [...extra, ...base].filter(Boolean);

  // 🆕 auto-synonyms refill/ritocco (copre "reffil")
  try {
    const key = norm(service);
    if (/\b(refill|re\s*fill|ritocco|ribilanciamento|manutenzione)\b/i.test(key)) {
      out.push(
        "refill",
        "re-fill",
        "re fill",
        "refil",
        "reffil",
        "ritocco",
        "ribilanciamento",
        "manutenzione",
        "refill gel",
        "gel refill"
      );
    }
  } catch { }

  // unique (normalizzato)
  const seen = new Set();
  const normKey = (s) =>
    (typeof norm === "function" ? norm(String(s || "")) : String(s || "").toLowerCase()).trim();

  return out.filter((x) => {
    const k = normKey(x);
    if (!k) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cfgServiceDuration(name) {
  const it = cfgServiceItem(name) || {};
  return Number(it.durationMin || it.duration || 0) || 30;
}
function cfgServiceProfessionals(service) {
  const it = cfgServiceItem(service) || {};
  const canon = (it && (it.name || it.label)) ? (it.name || it.label) : String(service || "").trim();
  const list = __servicesProsCache.get(canon) || [];
  return Array.isArray(list) ? list.slice() : [];
}

function cfgServicePriceText(name) {
  const it = cfgServiceItem(name) || {};
  const p = (typeof it.price === "number" || typeof it.price === "string") ? it.price : null;
  const eur = __fmtEurMaybe(p);
  return eur || "prezzo su richiesta";
}

// ============================================================================
// GLOBAL HELPERS: servizi per professionista + intent/entity per REVIEW INTAKE
// (serve per evitare ReferenceError in handleNumericReply/review_intake)
// ============================================================================

function proNameByEmailSafe(email) {
  try {
    const key = String(email || "").toLowerCase();
    if (key.startsWith("pro:")) {
      const id = Number(key.slice(4));
      for (const [name, pid] of __proNameToId.entries()) {
        if (pid === id) return name;
      }
    }
    for (const p of __dbAllPros()) {
      if (String(p.email || "").toLowerCase() === key && p.name) return p.name;
    }
    return (
      (config?.professionals?.[email]?.name) ||
      (config?.professionals?.[key]?.name) ||
      (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
      email ||
      ""
    );
  } catch {
    return String(email || "");
  }
}

function serviceProsEmails(svc) {
  try {
    const item =
      (typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null) ||
      (config?.services?.[svc] || {});
    const arr = item.professionals || item.pros || [];
    const list = Array.isArray(arr) ? arr : [];
    return list
      .map((x) => (typeof x === "string" ? x : (x?.email || x?.name || "")))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isServiceAvailableForPro(svc, proEmail) {
  if (!proEmail) return true;

  let pros = null;
  try {
    pros =
      (typeof cfgServiceProfessionals === "function"
        ? (cfgServiceProfessionals(svc) || [])
        : null) || null;
  } catch {
    pros = null;
  }
  if (!pros) pros = serviceProsEmails(svc);

  const emails = (Array.isArray(pros) ? pros : [])
    .map((x) => (typeof x === "string" ? x : (x?.email || x?.name || "")))
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  return emails.includes(String(proEmail).toLowerCase());
}

function getDurForPro(svc, proEmail) {
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

    const d = item.durationMin ?? item.duration;
    if (Number.isFinite(+d) && +d > 0) return +d;
  } catch { }

  try {
    return (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(svc) || 30) : 30);
  } catch {
    return 30;
  }
}

// ==== LISTINO: raggruppa trattamenti per "tipo" usando Levenshtein (typo-safe) ====
// Nota: la "chiave" di gruppo viene stimata da token del nome (es: ricostruzione, refill, pedicure, semipermanente...).
// Levenshtein serve per unire refusi tipo refill/reffil/refil.
const __SVC_GROUP_STOPWORDS = new Set([
  "di","da","del","della","dei","delle",
  "a","al","allo","alla","alle","all",
  "in","nel","nello","nella","nei","negli","nelle",
  "per","con","su","sul","sulla","sui","sugli","sulle",
  "il","lo","la","i","gli","le","un","uno","una",
  "e","ed","o"
]);

// Niente lista fissa: i gruppi vengono derivati per similarita' (Levenshtein) dai nomi reali.
const __SVC_GROUP_PREFERRED = null;

function __svcCleanLabelForGrouping(label) {
  return (typeof norm === "function" ? norm(label) : String(label || "").toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function __svcMaxDistToken(len) {
  const L = Math.max(0, Number(len) || 0);
  if (L <= 4) return 0;
  if (L <= 7) return 1;
  if (L <= 10) return 2;
  return 3;
}

function __svcKeysClose(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return false;
  if (x === y) return true;

  const L = Math.max(x.length, y.length);
  const md = __svcMaxDistToken(L);
  if (md <= 0) return false;
  if (Math.abs(x.length - y.length) > md) return false;

  const d = (typeof levenshtein === "function") ? levenshtein(x, y) : Infinity;
  return Number.isFinite(d) && d <= md;
}

function __svcGroupKeyFromLabel(label) {
  const cleaned = __svcCleanLabelForGrouping(label);
  if (!cleaned) return "altro";

  const toks = cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && !__SVC_GROUP_STOPWORDS.has(t));

  if (!toks.length) return "altro";

  // 1) prova a prendere una keyword "tipo" (match esatto o quasi-esatto via Levenshtein)
  const __prefs = Array.isArray(__SVC_GROUP_PREFERRED) ? __SVC_GROUP_PREFERRED : [];
  for (const pref of __prefs) {
    for (const tk of toks) {
      if (tk === pref) return pref;

      const md = __svcMaxDistToken(Math.max(tk.length, pref.length));
      if (md > 0 && typeof levenshtein === "function" && levenshtein(tk, pref) <= md) {
        return pref; // canonicalizza al pref
      }
    }
  }

  // 2) fallback: primo token "informativo"
  return toks[0] || "altro";
}

function __svcTokensFromLabel(label) {
  const cleaned = __svcCleanLabelForGrouping(label);
  if (!cleaned) return [];
  return cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && !__SVC_GROUP_STOPWORDS.has(t));
}

// Sceglie un "anchor token" data-driven: evita token troppo comuni e troppo rari
function __svcAnchorFromTokens(tokens, dfMap, n) {
  if (!tokens || !tokens.length) return "altro";

  const uniq = Array.from(new Set(tokens));
  let best = null;
  let bestScore = -1;

  for (const t of uniq) {
    const df = dfMap.get(t) || 0;
    const share = n > 0 ? df / n : 0;

    // score massimo vicino a df ~ n/2, penalizza token "onnipresenti"
    const score = df * (1 - share);

    if (
      score > bestScore ||
      (score === bestScore && df > (dfMap.get(best) || 0)) ||
      (score === bestScore && t.length > ((best && best.length) || 0))
    ) {
      best = t;
      bestScore = score;
    }
  }

  return best || uniq[0] || "altro";
}

// Raggruppa SOLO per similarita' (Levenshtein) su anchor token derivati dai label reali
function groupServicesByType(serviceKeys, labelOfSvc) {
  const svcs = Array.isArray(serviceKeys) ? serviceKeys.slice() : [];
  const n = svcs.length;

  // 1) tokens per servizio + DF globale (document frequency)
  const svcTokens = new Map();
  const df = new Map();

  for (const svc of svcs) {
    const label = (typeof labelOfSvc === "function" ? labelOfSvc(svc) : svc) || svc;
    const tokens = __svcTokensFromLabel(label);
    svcTokens.set(svc, tokens);

    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }

  const titleize = (s) =>
    String(s || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");

  // 2) clustering per similarita' (Levenshtein) fra anchor token
  const groups = []; // [{ key, title, services: [] }]

  for (const svc of svcs) {
    const tokens = svcTokens.get(svc) || [];
    const anchor = __svcAnchorFromTokens(tokens, df, n);

    let g = groups.find((x) => __svcKeysClose(x.key, anchor));
    if (!g) {
      g = { key: anchor, title: titleize(anchor), services: [] };
      groups.push(g);
    }
    g.services.push(svc);
  }

  // 3) ordine: gruppi piu' grandi prima (UX migliore)
  groups.sort((a, b) => (b.services.length - a.services.length) || a.title.localeCompare(b.title));

  return groups;
}

// ==== LISTINO numerato (serve per scelta via 1-N) ====
function buildServicesMessageForPro(proEmail) {
  const BUL = "➡️"; // bullet richiesto (stile prenotazione)

  const allSvcs =
    (typeof cfgServices === "function" ? (cfgServices() || []) : []) ||
    Object.keys(config?.services || {});

  const availableRaw = allSvcs.filter((svc) => isServiceAvailableForPro(svc, proEmail));
  const unavailable = allSvcs.filter((svc) => !isServiceAvailableForPro(svc, proEmail));

  const labelOfSvc = (svc) => {
    const item =
      (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
      (config?.services?.[svc] || {});
    return item.label || item.name || svc;
  };

  const groups = (typeof groupServicesByType === "function")
    ? groupServicesByType(availableRaw, labelOfSvc)
    : [{ title: "Trattamenti", services: availableRaw }];

  const lines = [];
  const available = []; // ORDER IMPORTANTE: deve combaciare coi numeri mostrati
  let idx = 0;

  for (const g of groups) {
    if (lines.length) lines.push(""); // separatore visivo tra gruppi
    lines.push(`${BUL} *${g.title || "Trattamenti"}*`);

    for (const svc of (g.services || [])) {
      idx++;
      available.push(svc);

      const item =
        (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
        (config?.services?.[svc] || {});
      const emoji = item.emoji || item.icon || item.emoticon || "";
      const label = item.label || item.name || svc;

      const price =
        (typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "") ||
        (Number.isFinite(+item.price) ? `${item.price}€` : "");

      const dur = getDurForPro(svc, proEmail);
      const durTxt =
        (typeof formatDurationMin === "function"
          ? (formatDurationMin(dur) || `${dur} min`)
          : `${dur} min`);

      const metaParts = [];
      if (price) metaParts.push(price);
      metaParts.push(durTxt);
      const meta = metaParts.join(" • ");

      lines.push(`${BUL} ${idx}) ${emoji ? emoji + " " : ""}*${label}* • ${meta}`);
    }
  }

  const unavailableLines = unavailable.map((svc) => {
    const emails = serviceProsEmails(svc);
    const names = emails.map(proNameByEmailSafe).filter(Boolean);
    const who = names.length ? names.join(", ") : "—";
    const label = labelOfSvc(svc);
    return `${BUL} *${label}* (solo con: ${who})`;
  });

  const proHeader = proEmail ? ` con *${proNameByEmailSafe(proEmail)}*` : "";

  let msg =
    `📋 *Trattamenti disponibili${proHeader}*\n` +
    (lines.length ? lines.join("\n") : `${BUL} ⚠️ Nessun trattamento disponibile.`);

  if (available.length) {
    msg += `\n\n💬 _Per scegliere, scrivi il numero del trattamento (1-${available.length})_`;
  }

  if (unavailableLines.length) {
    msg +=
      `\n\n🚫 *Non disponibili${proHeader}*\n${unavailableLines.join("\n")}\n\n` +
      `ℹ️ Se vuoi uno dei trattamenti non disponibili: digita "annulla" e prenota di nuovo scegliendo un professionista che lo esegue.`;
  }

  return { available, msg };
}


// ---------------- REVIEW INTAKE: intent (sinonimi menu) ----------------
const __REVIEW_MENU_INTENTS = [
  { action: "cancel", re: /\b(annulla|annula|cancel|stop|fine|esci)\b/i },
  { action: "continue", re: /\b(continua|procedi|avanti|ok|okay|va\s*bene|conferma|confermo|confermato|perfetto|si|sì|yes)\b/i },
  { action: "edit_service", re: /\b(trattament\w*|servizi?\b|cambia\s+(?:trattament\w*|servizi?)|modifica\s+(?:trattament\w*|servizi?))\b/i },
  { action: "edit_professional", re: /\b(professionist\w*|operatric\w*|tecnic\w*|cambia\s+professionist\w*|modifica\s+professionist\w*)\b/i },
  { action: "edit_when", re: /\b(giorno\b|data\b|quando\b|cambia\s+(?:giorno|data)|modifica\s+(?:giorno|data))\b/i },
  { action: "edit_time", re: /\b(orario\b|ora\b|cambia\s+orar\w*|modifica\s+orar\w*)\b/i },
];

function resolveReviewMenuIntent(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  for (const it of __REVIEW_MENU_INTENTS) {
    if (it.re.test(s)) return it.action;
  }
  return null;
}

// ---------------- REVIEW INTAKE: entity extractor (slot filling) ----------------
function extractReviewEntities(chatId, raw) {
  if (!raw) return null;
  const text = String(raw);

  const out = {};

  // Servizio
  try {
    const svc =
      (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) ||
      (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(text) : null) ||
      (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(text) : null) ||
      null;
    if (svc) out.service = svc;
  } catch { }

  // Data
  try {
    const d =
      (typeof safeParseDateWithLock === "function" ? safeParseDateWithLock(chatId, text) : null) ||
      (typeof parseUnifiedDate === "function" ? parseUnifiedDate(text) : null) ||
      null;
    if (d && !Number.isNaN(new Date(d).getTime())) {
      const dd = new Date(d);
      const at12 = typeof atNoon === "function" ? atNoon(dd) : dd;
      out.when = at12;
    }
  } catch { }

  // Orario
  try {
    const hhmm =
      (typeof parseTimeSmart === "function" ? parseTimeSmart(text) : null) ||
      (typeof parseHHMM === "function" ? parseHHMM(text) : null) ||
      null;
    if (hhmm) out.time = hhmm;
  } catch { }

  // Professionista
  try {
    const anyRe = /\b(chiunque|qualsiasi|va\s*bene\s*chiunque|non\s*mi\s*interessa|indifferente|nessuna\s+preferenza)\b/i;
    if (anyRe.test(text)) {
      out.professionalAny = true;
    } else {
      const list = Object.entries(config?.professionals || {}).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));

      let hit = null;
      if (typeof matchProFromFreeText === "function") {
        hit = matchProFromFreeText(text, list);
      }

      // fallback semplice: contiene nome
      if (!hit) {
        const q = (typeof norm === "function" ? norm(text) : text.toLowerCase());
        for (const p of list) {
          const nn = (typeof norm === "function" ? norm(p.name) : String(p.name).toLowerCase());
          if (nn && (q.includes(nn) || nn.includes(q))) { hit = p; break; }
        }
      }

      if (hit) {
        out.professionalName = hit.name;
        out.professionalEmail = hit.email || null;
        out.professionalAny = false;
      }
    }
  } catch { }

  return Object.keys(out).length ? out : null;
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
  try {
    return resolveServiceFromText(text);
  } catch (e) {
    return null;
  }
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
  const raw = String(t || "");
  const q0 = norm(raw);
  const svcs = (typeof cfgServices === "function" ? cfgServices() : []) || [];
  if (!svcs.length) return null;

  // ---------------- Cache token stats from config (services + synonyms) ----------------
  try {
    const synLens = svcs
      .map((s) => {
        try {
          const a = (typeof cfgServiceSynonyms === "function" ? cfgServiceSynonyms(s) : []) || [];
          return a.length;
        } catch {
          return 0;
        }
      })
      .join(",");

    const cacheKey = svcs.join("||") + "::" + synLens;

    if (!resolveServiceFromText._cache || resolveServiceFromText._cache.key !== cacheKey) {
      const df = new Map(); // token -> doc frequency
      let docs = 0;

      const N = (s) =>
        (typeof norm === "function" ? norm(String(s || "")) : String(s || "").toLowerCase())
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\s+/g, " ")
          .trim();

      const tokenize = (phrase) =>
        N(phrase)
          .split(" ")
          .map((x) => x.trim())
          .filter((x) => x && x.length >= 3);

      for (const service of svcs) {
        const phrases = [service];

        try {
          const syns = (typeof cfgServiceSynonyms === "function" ? cfgServiceSynonyms(service) : []) || [];
          for (const s of syns) phrases.push(s);
        } catch { }

        // doc per phrase (service-name e ogni sinonimo)
        for (const ph of phrases) {
          const toks = tokenize(ph);
          if (!toks.length) continue;

          docs++;
          const seen = new Set();
          for (const tk of toks) {
            if (seen.has(tk)) continue;
            seen.add(tk);
            df.set(tk, (df.get(tk) || 0) + 1);
          }
        }
      }

      const weight = new Map(); // token -> weight (idf-like)
      const D = Math.max(1, docs);

      for (const [tk, c] of df.entries()) {
        const idf = Math.log((D + 1) / (c + 1)) + 1; // 1..~
        // clamp (evita numeri assurdi)
        weight.set(tk, Math.max(0.6, Math.min(3.0, idf)));
      }

      resolveServiceFromText._cache = { key: cacheKey, df, weight, docs: D, tokenize, N };
    }
  } catch { }

  const cache = resolveServiceFromText._cache || null;
  const N = cache?.N || ((s) => norm(s));
  const tokenize = cache?.tokenize || ((s) => N(s).split(/\s+/).filter(Boolean));

  const msg = " " + q0 + " ";
  const msgWords = q0.split(/\s+/).filter(Boolean);

  const longHint = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(raw);
  const shortHint = /\b(cort|corte|corto)\w*\b/i.test(raw);

  const maxDistFor = (L) => {
    const len = Math.max(0, Number(L) || 0);
    if (len <= 3) return 0;
    if (len <= 6) return 1;
    if (len <= 9) return 2;
    return 3;
  };

  const distFn = (a, b) => {
    const x = String(a || "");
    const y = String(b || "");
    if (typeof dlDist === "function") return dlDist(x, y);
    if (typeof levenshtein === "function") return levenshtein(x, y);
    return Infinity;
  };

  const isClose = (w, tk) => {
    const a = String(w || "").toLowerCase();
    const b = String(tk || "").toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;

    const md = maxDistFor(Math.max(a.length, b.length));
    if (md <= 0) return false;
    if (Math.abs(a.length - b.length) > md) return false;

    const d = distFn(a, b);
    if (!Number.isFinite(d)) return false;

    if (d <= 1) return true;

    // freni anti falsi-positivi per d>=2
    if (d >= 2) {
      if ((a[0] || "") !== (b[0] || "")) return false;
      if (md >= 2) {
        if ((a[1] || "") !== (b[1] || "")) return false;
      }
    }

    return d <= md;
  };

  const tokWeight = (tk) => {
    if (!cache?.weight) return 1;
    return cache.weight.get(tk) || 1;
  };

  const tokCommonRate = (tk) => {
    if (!cache?.df || !cache?.docs) return 0;
    return (cache.df.get(tk) || 0) / cache.docs;
  };

  const isInformative = (tk) => {
    // token “buono” se non è troppo comune tra tutti i servizi/sinonimi
    const r = tokCommonRate(tk);
    return r <= 0.35 || tk.length >= 8;
  };

  const scorePhrase = (phrase) => {
    const toksAll = tokenize(phrase);
    const toks = toksAll.filter(Boolean);

    if (!toks.length) return { score: 0 };

    // unique tokens
    const uniq = [];
    const seen = new Set();
    for (const tk of toks) {
      const k = String(tk || "").trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(k);
    }

    const totalW = uniq.reduce((a, tk) => a + tokWeight(tk), 0) || 1;

    let hit = 0;
    let hitW = 0;
    let infoHit = 0;

    for (const tk of uniq) {
      if (msg.includes(" " + tk + " ")) {
        hit++;
        const w = tokWeight(tk);
        hitW += w;
        if (isInformative(tk)) infoHit++;
        continue;
      }

      if (tk.length >= 4) {
        const ok = msgWords.some((w) => isClose(w, tk));
        if (ok) {
          hit++;
          const w = tokWeight(tk);
          hitW += w;
          if (isInformative(tk)) infoHit++;
        }
      }
    }

    const cover = hitW / totalW; // 0..1

    const toks2 = uniq.filter((x) => x.length >= 3);
    const twoGram = toks2.some((_, i) => i < toks2.length - 1 && msg.includes(" " + toks2[i] + " " + toks2[i + 1] + " "));
    const contBonus = twoGram ? 0.08 : 0;

    const normPhrase = N(phrase);
    const lenBonus = Math.min(normPhrase.length / 90, 0.12);

    const hasLong = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(phrase);
    const hasShort = /\b(cort|corte|corto)\w*\b/i.test(phrase);
    let hintBonus = 0;
    if (longHint && hasLong) hintBonus += 0.06;
    if (longHint && hasShort) hintBonus -= 0.05;
    if (shortHint && hasShort) hintBonus += 0.06;
    if (shortHint && hasLong) hintBonus -= 0.05;

    let score = cover + contBonus + lenBonus + hintBonus;

    // freno: evita match su parole troppo generiche (es. "gel unghie")
    if (infoHit === 0 && hit < 2) score *= 0.35;

    return { score };
  };

  let best = null;
  let bestScore = 0;

  for (const service of svcs) {
    const r1 = scorePhrase(service);
    if (r1.score > bestScore) {
      bestScore = r1.score;
      best = service;
    }

    let syns = [];
    try {
      syns = (typeof cfgServiceSynonyms === "function" ? cfgServiceSynonyms(service) : []) || [];
    } catch { }

    for (const syn of syns) {
      const r2 = scorePhrase(syn);
      if (r2.score > bestScore) {
        bestScore = r2.score;
        best = service;
      }
    }
  }

  if (!best) return null;
  if (bestScore >= 0.62) return best;
  if (bestScore >= 0.56) return best;

  return null;
}

// ===== Booking intent detectors =====

function looksLikeBooking(t) {
  const s = String(t || "").trim();
  if (!s) return false;

  // 1) Intent esplicito: "prenota / fissare / appuntamento"
  if (hasBookingVerb(s)) return true;

  // ✅ Typos su "appuntamento" (es. "apputmamento") + nome professionista -> booking
  // (così eviti falsi positivi su refusi random)
  try {
    const maybeTypoApp = /\bappu\w{0,8}mento\b/i.test(s); // copre apputmamento/appuntamento/appuntameto...
    if (maybeTypoApp) {
      // 1) Se c’è un professionista nel testo -> booking sicuro
      const list = Object.entries((config?.professionals || {})).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));
      const proHit = typeof matchProFromFreeText === "function" ? matchProFromFreeText(s, list) : null;
      if (proHit) return true;

      // 2) Altrimenti: “Nome,” all’inizio (es. "Diana, ...") -> booking
      const hasNamePrefix =
        /^\s*[A-ZÀ-ÖØ-Ý][a-zà-öø-ý]{2,}(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ý]{2,})?\s*,/.test(s);
      if (hasNamePrefix) return true;
    }
  } catch (e) { }

  // 2) Disponibilità/slot/posto
  if (/\b(?:disponibilit[àa]|orari?\s+(?:liber\w*|disponibil\w*)|posti?\s+liber\w*|slot|buco)\b/i.test(s))
    return true;

  // 3) Data/orario: accetta SOLO se c'è almeno un indizio di prenotazione,
  // oppure se il messaggio è praticamente solo data/orario (es. "domani 15:30")
  if (hasDateOrTime(s)) {
    if (/\b(?:prenot\w*|appunt\w*|fiss\w*|posto|slot|disponibil\w*)\b/i.test(s)) return true;

    if (/^(?:\s*(?:oggi|domani|dopodomani|luned\w*|marted\w*|mercoled\w*|gioved\w*|venerd\w*|sabato|domenica|\d{1,2}\s*[\/\-]\s*\d{1,2}(?:\s*[\/\-]\s*\d{2,4})?)(?:\s+(?:alle?|ore)\s*)?(?:[01]?\d|2[0-3])?(?::[0-5]\d)?\s*)$/i.test(s))
      return true;
  }

  // 4) Servizio: accetta solo se il match è "reale" (sinonimi o token condivisi)
  try {
    const hit = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(s) : null);
    if (hit) return true;
  } catch (e) { }

  try {
    const hit = fuzzyService(s);
    if (hit) {
      const q = String(s);
      const toks = norm(hit).split(/\s+/).filter((w) => w.length >= 4);
      if (toks.some((tok) => q.includes(tok))) return true;
    }
  } catch (e) { }

  return false;
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
function getBusyIntervalsForDay(day, email, opts = {}) {
  const D = day instanceof Date ? new Date(day.getTime()) : new Date(day);

  // Giorno locale [00:00 .. 24:00)
  const dayStart = new Date(D.getFullYear(), D.getMonth(), D.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const ignoreChatId = opts && opts.ignoreChatId ? String(opts.ignoreChatId) : null;

  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const raw = String(email ?? "").trim();
  const wantEmail = raw.includes("@") ? norm(raw) : "";

  // Fallback: nome del pro (utile se email non è consistente tra config/booking)
  const wantName = (() => {
    if (!raw) return "";
    if (!raw.includes("@")) return norm(raw);
    try {
      const n = (typeof proNameByEmail === "function" ? proNameByEmail(wantEmail) : "") || "";
      return norm(n);
    } catch {
      return "";
    }
  })();

  const isCancelled = (b) => {
    const s = norm(b?.status);
    return s === "cancelled" || s === "canceled" || s === "annullato" || s === "annullata" || s === "deleted";
  };

  const parseMs = (raw) => {
    if (!raw) return NaN;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;

    const s = String(raw).trim();
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;

    // Supporta "YYYY-MM-DD HH:mm" o "YYYY-MM-DDTHH:mm[:ss]"
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const Y = +m[1], M = +m[2], DD = +m[3], H = +m[4], MI = +m[5], SS = +(m[6] ?? 0);
      const d = new Date(Y, M - 1, DD, H, MI, SS, 0);
      return d.getTime();
    }
    return NaN;
  };

  const bookingEmail = (b) => {
    const e1 = norm(b?.professionalEmail);
    if (e1) return e1;

    const name = String(b?.professionalName ?? "").trim();
    if (!name) return "";

    const resolved =
      (typeof resolveEmailByName === "function" ? resolveEmailByName(name) : null) ||
      (typeof proEmailByName === "function" ? proEmailByName(name) : null) ||
      null;

    return norm(resolved);
  };

  const getStartEnd = (b) => {
    const startRaw =
      (b && (b.startTime ?? b.start ?? b.startMs ?? b.datetime ?? b.date ?? b.when)) ?? null;
    const endRaw =
      (b && (b.endTime ?? b.end ?? b.endMs ?? b.until)) ?? null;

    const s = parseMs(startRaw);
    if (!Number.isFinite(s)) return null;

    // Se c’è un end esplicito, usa quello
    const endParsed = parseMs(endRaw);
    if (Number.isFinite(endParsed) && endParsed > s) return [s, endParsed];

    // Altrimenti durata
    let durMin = Number(b?.durationMin ?? b?.duration ?? b?.minutes ?? 0);
    if (!Number.isFinite(durMin) || durMin < 0) durMin = 0;

    // Se dur=0 ma esiste un servizio con durata in config, prova fallback (opzionale)
    if (durMin === 0 && b?.service && typeof cfgServiceDuration === "function") {
      const d = Number(cfgServiceDuration(b.service) ?? 0);
      if (Number.isFinite(d) && d > 0) durMin = d;
    }

    let e = s + durMin * 60_000;
    if (!Number.isFinite(e) || e <= s) {
      // Fallback ultra-sicuro: non ignorare il booking se durata mancante/0.
      // Blocca almeno 30 minuti così non si possono sovrapporre prenotazioni.
      durMin = 30;
      e = s + durMin * 60_000;
      if (!Number.isFinite(e) || e <= s) return null;
    }

    return [s, e];
  };

  const normalizeIntervals = (intervals) => {
    const cleaned = [];
    for (const it of intervals) {
      if (!it) continue;
      const a = Number(it[0]), b = Number(it[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      // Taglia ai limiti della giornata per evitare rumore
      const s = Math.max(a, dayStart);
      const e = Math.min(b, dayEnd);
      if (e > s) cleaned.push([s, e]);
    }
    cleaned.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    // Merge sovrapposizioni/adiacenze
    const merged = [];
    for (const cur of cleaned) {
      const last = merged[merged.length - 1];
      if (!last) merged.push(cur);
      else if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
      else merged.push(cur);
    }
    return merged;
  };

  const arr = (typeof loadBookings === "function" ? loadBookings() : []) || [];
  const bookings = Array.isArray(arr) ? arr : [];

  const out = [];
  for (const b of bookings) {
    if (!b || isCancelled(b)) continue;

    // Filtra per professionista (robusto)
    if (wantEmail || wantName) {
      const bEmail = bookingEmail(b);
      const bName = norm(b?.professionalName ?? b?.professional ?? b?.proName ?? b?.staffName ?? "");

      const byEmail = wantEmail && bEmail && bEmail === wantEmail;
      const byName =
        wantName &&
        bName &&
        (bName === wantName || bName.startsWith(wantName) || wantName.startsWith(bName));

      if (!byEmail && !byName) continue;
    }

    const se = getStartEnd(b);
    if (!se) continue;

    const [s, e] = se;
    // Interseca il giorno
    if (s < dayEnd && e > dayStart) out.push([s, e]);
  }

  // Holds attivi (di altri chat; ignora il nostro hold se richiesto)
  const holdEmail =
    wantEmail ||
    (wantName
      ? norm(
        (typeof resolveEmailByName === "function" ? resolveEmailByName(raw) : null) ||
        (typeof proEmailByName === "function" ? proEmailByName(raw) : null) ||
        ""
      )
      : "");

  const heldRaw = (typeof getHoldIntervalsForDay === "function")
    ? (getHoldIntervalsForDay(D, holdEmail || wantEmail || raw, { ignoreChatId }) || [])
    : [];
  if (Array.isArray(heldRaw)) out.push(...heldRaw);

  return normalizeIntervals(out);
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
          freePros.push({ email, name: name || "-" });
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

  // ✅ FIX: carica gli intervalli occupati (booking + unavailability) per ogni pro
  for (const email of pros) {
    const booked = getBusyIntervalsForDay(D, email) || [];
    const extra = partialBusyByPro.get(email) || [];
    busyByPro.set(email, mergeIntervals([...booked, ...extra]));
  }

  const nowTs = Date.now();

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
          const key = `${String(d.getHours()).padStart(2, "0")}:${String(
            d.getMinutes()
          ).padStart(2, "0")}`;
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
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
  }
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

  // ✅ Anti-nonsense: se non c'è nessuna vocale è quasi sicuramente testo casuale (es. "cmc ci")
  if (!/[aeiouàèìòù]/i.test(letters)) return returnFallback ? FALLBACK : null;

  // ✅ Heuristic anti-nonsense: se non c'è NESSUNA vocale, probabilmente non è un nome (es. "cmc ci")
  // (riduce falsi positivi senza introdurre uno step extra)
  if (!/[aeiouàèìòù]/i.test(letters)) return returnFallback ? FALLBACK : null;

  // ✅ Heuristic anti-nonsense: se non c'è NESSUNA vocale, probabilmente non è un nome (es. "cmc ci")
  // (riduce falsi positivi senza introdurre uno step extra)
  if (!/[aeiouàèìòù]/i.test(letters)) return returnFallback ? FALLBACK : null;

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
  customerName = null, // <- arriva dal flow come "customerName"
  startTime,
  durationMin,
  notes = null, // <- verrà rimappato a serviceDetails
  price = null,
  reminders = [{ method: "popup", minutes: 1440 }],
}) {
  let allergies = null;
  const payload = {
    serviceName,
    professionalEmail,
    professionalName, // opzionale ma utile per il titolo in gcal
    clientPhone: _digitsPhone(clientPhone),
    clientName: customerName, // <- mapping richiesto da gcal.js
    startTime, // Date o ISO, gcal fa new Date(...)
    durationMin,
    price,
    serviceDetails: notes,
    allergies,
    reminders,
  };
  try {
    // Guard: serve sempre un professionalEmail per creare l'evento
    if (!payload.professionalEmail) {
      throw new Error("professionalEmail mancante (impossibile creare evento)");
    }

    // NOTE: Il blocco FIX Bug #5 è stato commentato perché fa riferimento a 'col' che non è definito
    // in questo contesto. La logica di risoluzione professionalAny dovrebbe essere gestita
    // prima di chiamare makeEvent, passando professionalEmail già risolto.

    /* BLOCCO COMMENTATO - col is not defined
    // ✅ FIX Bug #5: Forzare risoluzione professionalAny prima di creare evento
    if (col.professionalAny && (!col.professionalEmail || !col.professionalName)) {
      // Tentativo di assegnazione automatica da slot o servizio
      if (col.time && Array.isArray(col.options)) {
        const matchingSlot = col.options.find(s => s.time === col.time);
        if (matchingSlot && matchingSlot.pros && matchingSlot.pros.length) {
          const firstPro = matchingSlot.pros[0];
          col.professionalEmail = firstPro.email || null;
          col.professionalName = firstPro.name || firstPro.email || null;
          col.professionalAny = false;
          log('info', '[FIX Bug #5] professionalAny risolto da slot', { 
            email: col.professionalEmail,
            name: col.professionalName 
          });
        }
      }
      
      // Fallback: prendi primo professionista disponibile per il servizio
      if (col.professionalAny && !col.professionalEmail && col.service) {
        try {
          const servicePros = (typeof cfgServiceProfessionals === 'function')
            ? cfgServiceProfessionals(col.service)
            : [];
          
          if (servicePros && servicePros.length) {
            const firstPro = servicePros[0];
            const proEmail = typeof firstPro === 'string' ? firstPro : (firstPro.email || null);
            const proName = typeof firstPro === 'string' 
              ? (typeof proNameByEmail === 'function' ? proNameByEmail(firstPro) : firstPro)
              : (firstPro.name || proEmail);
            
            if (proEmail) {
              col.professionalEmail = proEmail;
              col.professionalName = proName;
              col.professionalAny = false;
              log('info', '[FIX Bug #5] professionalAny risolto da servizio', {
                email: col.professionalEmail,
                name: col.professionalName
              });
            }
          }
        } catch (err) {
          log('error', '[FIX Bug #5] Errore risoluzione professionalAny', { error: String(err) });
        }
      }
      
      // Se ancora non risolto, errore critico
      if (col.professionalAny && !col.professionalEmail) {
        log('error', '[FIX Bug #5] professionalAny non risolto, impossibile creare evento', {
          service: col.service,
          time: col.time,
          when: col.when
        });
        await reply(client, chatId, 
          "⚠️ Errore nella scelta del professionista. Riprova specificando chi preferisci.");
        return "";
      }
    }
    */


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
      await GCAL.cancelCalendarEvent(eventId); // <- QUI: passa la stringa, NON l’oggetto
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

  // Evita falsi positivi: un orario tipo "12.30" non è una data
  const __n0 = normalize(original);
  if (/^(?:alle\s*)?(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d\s*\??\s*$/i.test(__n0)) return null;

  let txt = normalize(original);

  // Evita falsi positivi: un orario tipo "alle 12.30" / "dalle 15:30" non è una data durante le modifiche
  txt = txt.replace(/\b(?:alle|ore|h|dalle)\s*([01]?\d|2[0-3])\s*[.:,]\s*([0-5]\d)\b/gi, " ");

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
      : `${fmtDate(booking.startTime || booking.day || new Date())} - ${booking.service || ""
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
async function _editSnapshotStateFromBooking(state, booking) {
  if (!state || !booking) return;
  const col = state.collected || (state.collected = {});
  // 🆕 Watchdog coerenza anche qui (evita step "incastrati" su risposte a lista)
  const __valid = ensureValidState(state);
  if (!__valid.ok) {
    log("warn", "[STATE-WATCHDOG] NumericReply stato incoerente → reset soft", { chatId, step: __valid.step, missing: __valid.missing });

    try { pending.delete(chatId); } catch { }
    try { __dateParsingLocks.delete(chatId); } catch { }
    try { releaseSoftHoldByChat?.(chatId); } catch { }

    const fresh = getState(chatId);
    ensureContext(fresh);
    fresh.step = "collect";
    pending.set(chatId, fresh);

    await safeSend(
      client,
      chatId,
      "Non riesco a riprendere da dove eravamo rimasti 😅 Ripartiamo: vuoi *prenotare* o *modificare*?"
    );
    return "";
  }


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

// Formattare lista orari (mai numerata)
function _editFormatTimeList(times) {
  return (times || []).map((t) => `- ${t}`).join("\n");
}

// Render slot list (supporta oggetti {time, pros:[{name}]} oppure stringhe 'HH:MM')
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
 * Applica un aggiornamento all'evento (Calendar) e allo store prenotazioni PostgreSQL.
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

  // ✅ Sempre: tracciamo aggiornamento e manteniamo coerenza dei campi orari
  patch.updatedAt = new Date().toISOString();
  if (newStartISO) {
    const sMs = Date.parse(nextStartISO);
    if (Number.isFinite(sMs)) {
      patch.startMs = sMs;
      const eMs = sMs + (Number(nextDuration) || 0) * 60_000;
      if (Number.isFinite(eMs) && eMs > sMs) {
        patch.endMs = eMs;
        patch.endTime = new Date(eMs).toISOString();
      }
    }
  }

  const shouldRecreate = !!(forceRecreate && newStartISO);

  // --- CASO 1: cambio data/ora con ricreazione evento (no duplicati) ---
  if (shouldRecreate) {
    let newEventId = booking.eventId;

    // Cancella l'evento vecchio (se esiste ancora)
    try {
      await cancelEventSafe(booking.eventId);
    } catch (e) {
      try {
        log("warn", "[EDIT] cancelEventSafe failed", e?.message || e);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
      return false;
    }

    if (newEventId && newEventId !== booking.eventId) {
      patch.eventId = newEventId;
    }

    const saved =
      await updateBookingByEventId(booking.eventId, patch) ||
      await updateBookingByComposite(
        { clientPhone: booking.clientPhone, startTime: prev.startTime },
        patch
      );

    if (!saved) {
      try {
        log("warn", "[EDIT] booking store non aggiornato (recreate)", {
          oldEventId: booking.eventId,
          newEventId,
        });
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
    }

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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

    return true;
  }

  // --- CASO 2: cambio pro/nome (e/o start se updateEventSafe lo supporta) -> patch sullo stesso eventId ---
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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    return false;
  }

  const saved =
    await updateBookingByEventId(booking.eventId, patch) ||
    await updateBookingByComposite(
      { clientPhone: booking.clientPhone, startTime: prev.startTime },
      patch
    );

  if (!saved) {
    try {
      log("warn", "[EDIT] booking store non aggiornato", { eventId: booking.eventId });
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
  }

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
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
  }

  return true;
}


// Riconosce domande informative (robusto anche senza "?")
function looksLikeInfoQuestion(s) {
  const q = norm(s || ""); // <- prima era toLowerCase(); ora normalizziamo accenti/apostrofi

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
    // booking
    "choose_service",
    "choose_day",
    "confirm_day_month",
    "pick_time",
    "pick_professional",
    "pick_professional_for_time",
    "collect_name",
    "finalize_booking",
    "confirm_final",

    // legacy (se rimane in giro codice vecchio)
    "ask_name",
    "confirm_booking",

    // info/price flows
    "price_select_service",
    "info_select_service",

    // resume mid-flow
    "resume_confirm",

    // edit flow
    "edit_pick_booking",
    "edit_menu",
    "edit_pick_professional",
    "edit_reschedule_date",
    "edit_reschedule_time",
    "edit_cancel_confirm",
    "edit_change_name",
    "edit_cancel_confirm",
  ].includes(step);
}

// ==== Watchdog: coerenza stato (auto-recupero senza far scrivere "annulla") ====
function ensureValidState(state) {
  try {
    if (!state || typeof state !== "object") return { ok: false, step: "", missing: ["state"] };

    const step = String(state.step || "collect");
    const col = state.collected || {};
    const missing = [];

    const hasValidWhen = () => {
      if (!col.when) return false;
      const d = new Date(col.when);
      return Number.isFinite(d.getTime());
    };

    // Booking flow
    if (step === "choose_day") {
      if (!col.service) missing.push("col.service");
    } else if (step === "pick_time") {
      if (!col.service) missing.push("col.service");
      if (!hasValidWhen()) missing.push("col.when");
      if (!Array.isArray(col.options) || !col.options.length) missing.push("col.options");
    } else if (step === "pick_professional_for_time") {
      if (!col.time) missing.push("col.time");
      if (!Array.isArray(col.proOptions) || !col.proOptions.length) missing.push("col.proOptions");
    } else if (step === "confirm_final" || step === "finalize_booking") {
      if (!col.service) missing.push("col.service");
      if (!hasValidWhen()) missing.push("col.when");
      if (!col.time) missing.push("col.time");
      if (!col.customerName) missing.push("col.customerName");
    } else if (step === "pick_professional") {
      // non troppo aggressivo: si può arrivare qui anche da "prenota" senza servizio
      // ma se manca la lista pros, il flow è rotto.
      // (non aggiungiamo check perché è gestito dal blocco dedicato di pick_professional)
    }

    // Edit flow
    if (step.startsWith("edit_")) {
      const ed = state.edit || {};
      if (step !== "edit_pick_booking" && !ed.target) missing.push("edit.target");
      if (step === "edit_pick_booking" && (!Array.isArray(ed.list) || !ed.list.length)) missing.push("edit.list");
      if (step === "edit_pick_professional" && (!Array.isArray(ed.proOptions) || !ed.proOptions.length)) missing.push("edit.proOptions");
      if (step === "edit_reschedule_time" && (!Array.isArray(col.options) || !col.options.length)) missing.push("col.options");
    }

    return { ok: missing.length === 0, step, missing };
  } catch (e) {
    return { ok: false, step: String(state?.step || ""), missing: ["exception"] };
  }
}

// ==== Chiede SOLO quello che manca (helper usabile anche per "stato") ====
function firstMissingField(col) {
  const c = col || {};
  if (!c.service) return "service";
  if (!c.when) return "when";
  if (!c.time) return "time";
  // professional "se richiesto": gestito solo nei casi dove serve davvero
  if (!c.professionalAny && !c.professionalEmail && Array.isArray(c.proOptions) && c.proOptions.length) return "professional";
  if (!c.customerName) return "customerName";
  return null;
}

async function promptResumeStep(client, chatId, state) {
  try {
    const step = String(state?.step || "collect");
    const col = state?.collected || {};

    if (step === "choose_service") {
      await reply(client, chatId, "Ok 😊 Che trattamento vuoi prenotare?");
      return;
    }

    if (step === "collect_name") {
      await reply(client, chatId, 'Perfetto. Scrivi *nome e cognome* (es. "Maria Rossi").', { noFooter: true });
      return;
    }

    if (step === "choose_day") {
      await reply(client, chatId, `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23/10")`);
      return;
    }

    if (step === "pick_time") {
      if (col.when && Array.isArray(col.options) && col.options.length) {
        const dayStr =
          typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(col.when)
            : (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(col.when) : String(col.when));
        const list = typeof renderSlotsList === "function" ? renderSlotsList(col.options) : "";
        const base = list
          ? `Disponibilità per *${dayStr}*:\n${list}`
          : `Perfetto. Per *${dayStr}* che ora preferisci? (es. 14:30)`;
        await reply(client, chatId, `${base}\n\nScrivi l’orario desiderato (es. "14:30").`);
        return;
      }
      await reply(client, chatId, `Ok 😊 Per che giorno? (es. "domani", "23/10")`);
      return;
    }

    if (step === "pick_professional_for_time") {
      const pros = Array.isArray(col.proOptions) ? col.proOptions : [];
      if (pros.length) {
        const list = pros.map((p, i) => `${i + 1}) ${p?.name || p?.email || String(p)}`).join("\n");
        await reply(client, chatId, `Chi preferisci? Puoi rispondere con il *numero* o il *nome*:\n${list}`);
        return;
      }
      await reply(client, chatId, "Ok 😊 Dimmi il nome del professionista che preferisci.");
      return;
    }
  } catch (e) {
    // no-op
  }
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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

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
      `Orari disponibili per ${dateStr}:\n${lines}\n\nScrivi l'orario desiderato (es. "14:30") o tocca l'orario mostrato.`
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
    const hasTimeSlash =
      /\b(?:alle|ore|verso|intorno|circa)\s+[0-2]?\d\s*\/\s*[0-2]?\d\b/.test(t);

    const m1 = hasTimeSlash
      ? null
      : t.match(/\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/);
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
// === INTENT HYBRID PATTERNS - versione corretta ===
const HYBRID_PATTERNS = {
  booking: {
    // Verbi/indizi di nuova prenotazione
    regex:
      /\b(prenota(?:re)?|volevo\s+prenotare|vorrei\s+prenotare|voglio\s+prenotare|mi\s+serve\s+prenotare|voglio\s+(?:un\s+)?appuntamento|vorrei\s+(?:un\s+)?appuntamento|mi\s+serve\s+(?:un\s+)?appuntamento|fissa(?:re)?\s+(?:un\s+)?appuntamento|metti(?:\s+un)?\s+appuntamento|blocca(?:re)?\s+un\s+posto)\b/iu,
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
    const all = loadBookings();
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
        return { name: nice || "-", email: s };
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
    return { name: name || "-", email: email || null };
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
      return proShort(nice || "-");
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
  log("warn", `[OLLAMA] durata non valida "${raw}", uso default ${def}`);
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
    log("info", `Sticker inviato con successo a: ${chatId}`);
  } catch (e) {
    log("error", 'Errore durante l\'invio dello sticker:', e);
  }
}
function ensureUI(state) {
  if (!state) return;
  state.ui = state.ui || {};
}
function formatBusinessHours(businessHours) {
  if (!businessHours || Object.keys(businessHours).length === 0) {
    return null;
  }

  const dayNames = {
    1: "Lunedì",
    2: "Martedì",
    3: "Mercoledì",
    4: "Giovedì",
    5: "Venerdì",
    6: "Sabato",
    7: "Domenica"
  };

  // Raggruppa giorni con gli stessi orari
  const schedule = [];
  let currentGroup = null;

  for (let day = 1; day <= 7; day++) {
    const hours = businessHours[day];
    const hoursStr = hours ? `${hours[0]} - ${hours[1]}` : "Chiuso";

    if (!currentGroup || currentGroup.hours !== hoursStr) {
      if (currentGroup) {
        schedule.push(currentGroup);
      }
      currentGroup = {
        startDay: day,
        endDay: day,
        hours: hoursStr
      };
    } else {
      currentGroup.endDay = day;
    }
  }

  if (currentGroup) {
    schedule.push(currentGroup);
  }

  // Formatta il testo finale
  return schedule.map(group => {
    const dayRange = group.startDay === group.endDay
      ? dayNames[group.startDay]
      : `- ${dayNames[group.startDay]} - ${dayNames[group.endDay]}`;
    return `${dayRange}: ${group.hours}`;
  }).join('\n');
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
  "Grazie a te! 😊",
  "Prego, sempre a disposizione! ✨",
  "Figurati! A presto 👋",
  "Con piacere! 💅",
  "È stato un piacere aiutarti! 💖",
  "A presto! 🌸"
];
function buildReviewIntakePrompt(col = {}) {
  const map = {
    "1": "edit_service",
    "2": "edit_professional",
    "3": "edit_when",
    "4": "edit_time",
    "5": "continue",
  };

  // Professionista
  let proTxt = "-";
  try {
    if (col.professionalAny === true) {
      proTxt = "Non mi interessa";
    } else if (col.professionalEmail) {
      const n = (typeof proNameByEmailSafe === "function") ? proNameByEmailSafe(col.professionalEmail) : "";
      proTxt = (n && String(n).trim()) ? n : col.professionalEmail;
    } else if (col.professionalName) {
      proTxt = String(col.professionalName);
    }
  } catch { }

  // Servizio
  let svcTxt = "-";
  try {
    if (col.service) {
      const it = (typeof cfgServiceItem === "function") ? cfgServiceItem(col.service) : null;
      const emoji = it?.emoji || "💅";
      const label = (it && (it.label || it.name)) || col.service;
      svcTxt = `${emoji} ${label}`;
    }
  } catch { }

  // Giorno
  let dayTxt = "-";
  try {
    if (col.when) {
      dayTxt = (typeof formatDateWithWeekdayIT === "function")
        ? formatDateWithWeekdayIT(col.when)
        : (col.when?.toLocaleDateString?.("it-IT") || String(col.when));
    }
  } catch { }

  // Orario
  let timeTxt = "—";
  try {
    if (col.time) {
      timeTxt = String(col.time);
    } else if (col._preferredTime) {
      timeTxt = `~${String(col._preferredTime)} (preferenza)`;
    }
  } catch { }


  const header =
    `🔎 Ho capito così:\n` +
    `- Trattamento: ${svcTxt}\n` +
    `- Professionista: ${proTxt}\n` +
    `- Giorno: ${dayTxt}\n` +
    `- Orario: ${timeTxt}\n`;

  const menu =
    `\n📌 Vuoi modificare qualcosa?\n` +
    `1) ${col.service ? "Cambia trattamento" : "Scegli trattamento"}\n` +
    `2) ${(col.professionalAny || col.professionalName || col.professionalEmail) ? "Cambia professionista" : "Scegli professionista"}\n` +
    `3) ${col.when ? "Cambia giorno" : "Scegli giorno"}\n` +
    `4) ${(col.time || col._preferredTime) ? "Cambia orario" : "Scegli orario"}\n` +
    `5) ✅ Conferma e continua\n` +
    `\n✍️ Puoi rispondere con *5* oppure scrivere: *conferma* / *ok* / *va bene*.\n` +
    `💬 Puoi anche scrivere direttamente un dettaglio (trattamento / giorno / orario), es. "refill gel", "dopodomani", "alle 10", "dopodomani alle 10".\n` +
    `0) ❎ Annulla\n` +
    `(0-5)`;

  return { msg: header + menu, map };
}



// ======================= Day/month confirm (evita errori tipo "giovedì 18" senza mese) =======================
function __cap(s) {
  const t = String(s || "");
  return t ? (t[0].toUpperCase() + t.slice(1)) : "";
}

function __weekdayIdxFromIT(token) {
  const k = (typeof norm === "function" ? norm(token || "") : String(token || "").toLowerCase())
    .replace(/[^a-z]/g, "");
  const map = {
    domenica: 0,
    lunedi: 1,
    martedi: 2,
    mercoledi: 3,
    giovedi: 4,
    venerdi: 5,
    sabato: 6,
  };
  return map[k] ?? null;
}

function __findNextValidMonthDay(baseStart, dayNum, startMonthOffset = 0) {
  const base = baseStart instanceof Date && !Number.isNaN(baseStart.getTime()) ? new Date(baseStart) : new Date();
  base.setHours(0, 0, 0, 0);
  const baseY = base.getFullYear();
  const baseM = base.getMonth();

  for (let off = startMonthOffset; off < startMonthOffset + 24; off++) {
    const mmAbs = baseM + off;
    const y = baseY + Math.floor(mmAbs / 12);
    const m = ((mmAbs % 12) + 12) % 12;
    const d = new Date(y, m, dayNum, 12, 0, 0, 0);
    // valida giorno in quel mese
    if (d.getFullYear() === y && d.getMonth() === m && d.getDate() === dayNum) {
      const d0 = new Date(d);
      d0.setHours(0, 0, 0, 0);
      if (d0 >= base) return d;
    }
  }
  return null;
}

function __nextWeekdayDate(weekdayIdx, baseStart) {
  const base = baseStart instanceof Date && !Number.isNaN(baseStart.getTime()) ? new Date(baseStart) : new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 21; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    d.setHours(12, 0, 0, 0);
    if (d.getDay() === weekdayIdx && d >= base) return d;
  }
  return null;
}

function __buildDayMonthConfirmFromText(input, baseDate = new Date()) {
  const raw = String(input ?? "");
  const tNorm = (typeof norm === "function" ? norm(raw) : raw.toLowerCase());
  if (!tNorm) return null;

  // se mese già esplicito (nome mese o data con / - .) non chiedere conferma
  if (/\b(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\b/i.test(tNorm)) return null;
  if (/\b\d{1,2}\s*[\/\-.]\s*\d{1,2}(?:\s*[\/\-.]\s*\d{2,4})?\b/.test(raw)) return null;

  // relativi: già chiari
  if (/\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(tNorm)) return null;

  // pulizia: rimuovi orari per non confondere numeri (es. "dalle 15 e 30")
  let cleaned = String(tNorm);
  cleaned = cleaned.replace(/\b(?:alle?|ore|h|dalle)\s*([01]?\d|2[0-3])\s*(?:[:.,h]|\s*\b(?:e|ed)\b\s*)\s*([0-5]\d)\b/gi, " ");
  cleaned = cleaned.replace(/\b([01]?\d|2[0-3])\s*[:.,h]\s*([0-5]\d)\b/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // weekday + giorno
  const mW = cleaned.match(/\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b(?:\s+|,|\.)*(?:il\s+)?([0-2]?\d|3[01])\b/i);
  let weekdayTok = null;
  let dayNum = null;

  if (mW) {
    weekdayTok = String(mW[1] || "");
    dayNum = parseInt(String(mW[2] || ""), 10);
  } else {
    // solo numero (es. "18") o "il 18"
    const mD = cleaned.match(/\b(?:il\s+)?([0-2]?\d|3[01])\b/);
    if (mD) dayNum = parseInt(String(mD[1] || ""), 10);
  }

  if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) return null;

  const base = baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ? new Date(baseDate) : new Date();
  base.setHours(0, 0, 0, 0);

  const cand1 = __findNextValidMonthDay(base, dayNum, 0);
  if (!cand1) return null;

  const baseM = base.getMonth();
  const baseY = base.getFullYear();
  const diff1 = (cand1.getFullYear() - baseY) * 12 + (cand1.getMonth() - baseM);
  const cand2 = __findNextValidMonthDay(base, dayNum, diff1 + 1) || null;

  const weekdayIdx = weekdayTok ? __weekdayIdxFromIT(weekdayTok) : null;

  const match1 = weekdayIdx != null && cand1 ? cand1.getDay() == weekdayIdx : false;
  const match2 = weekdayIdx != null && cand2 ? cand2.getDay() == weekdayIdx : false;
  const show3 = weekdayIdx != null && !match1 && !match2;
  const cand3 = show3 ? __nextWeekdayDate(weekdayIdx, base) : null;

  // salva anche eventuale orario trovato nel testo originale
  let preferredTime = null;
  try {
    preferredTime = (typeof parseTimeSmart === "function" ? parseTimeSmart(raw) : null) || (typeof parseHHMM === "function" ? parseHHMM(raw) : null) || null;
  } catch { }

  const d1 = typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(cand1) : (typeof fmtDate === "function" ? fmtDate(cand1) : cand1.toLocaleDateString("it-IT"));
  const d2 = cand2 ? (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(cand2) : (typeof fmtDate === "function" ? fmtDate(cand2) : cand2.toLocaleDateString("it-IT"))) : null;
  const d3 = cand3 ? (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(cand3) : (typeof fmtDate === "function" ? fmtDate(cand3) : cand3.toLocaleDateString("it-IT"))) : null;

  const human = weekdayTok ? `${__cap(weekdayTok)} ${dayNum}` : `${dayNum}`;

  let lines = `1) ${d1}`;
  if (d2) lines += `\n2) ${d2}`;
  if (show3 && d3) lines += `\n3) Prossimo ${__cap(weekdayTok)}: ${d3}`;

  const maxOpt = show3 ? 3 : (d2 ? 2 : 1);

  const prompt =
    `🔎 Hai scritto: *${human}*\n` +
    `Per evitare errori, quale data intendi?\n` +
    `${lines}\n\n` +
    `Rispondi con *1-${maxOpt}* oppure scrivi una data esatta (es. *18/02*).\n` +
    `0) ❎ Annulla`;

  return {
    awaiting: true,
    human,
    weekdayTok: weekdayTok || null,
    weekdayIdx,
    dayNum,
    preferredTime: preferredTime || null,
    cand1ISO: cand1 ? cand1.toISOString() : null,
    cand2ISO: cand2 ? cand2.toISOString() : null,
    cand3ISO: cand3 ? cand3.toISOString() : null,
    show3: !!show3,
    prompt,
  };
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
  const __isReenter = !!tools?.__reenter;
  const normalizedChatId = String(chatId || "").trim();

  if (!normalizedChatId) {
    log("warn", "handleMessage called without chatId", {
      preview: String(textRaw ?? "").slice(0, 120),
    });
    return "";
  }

  if (isUnsupportedAutomationChatId(normalizedChatId)) {
    log("info", "[IGNORE] Unsupported automation chat", { chatId: normalizedChatId });
    return "";
  }

  chatId = normalizedChatId;

  // Inizializzazione stato
  let state = getState(chatId);

  // ✅ Primo contatto: privacy (una sola volta) + gestione comandi privacy
  // ✅ Inoltre: se l'utente sta rispondendo a "Com'è andata ...", rispondi e STOP (senza avviare prenotazione)
  if (!__isReenter) {
    const __txt = String(textRaw ?? "").trim();

    // Comandi privacy espliciti
    const __pc = privacyCommandKind(__txt);
    if (__pc === "show") {
      await safeSend(client, chatId, getPrivacyText(chatId), { noFooter: true });
      try { markPrivacySent(chatId); } catch { }
      return "";
    }
    if (__pc === "delete") {
      const ok = chatdbDeleteEntry(chatId);
      await safeSend(
        client,
        chatId,
        ok
          ? "✅ Ok! Ho cancellato la cronologia chat salvata. Se vuoi ripartire, scrivi \"prenota\"."
          : "Non ho trovato dati salvati per questo numero.",
        { noFooter: true }
      );
      return "";
    }

    // Privacy automatica al primo messaggio
    let __privacySentNow = false;
    try {
      __privacySentNow = await maybeSendPrivacyNotice(client, chatId);
    } catch (err) {
      logIgnoredError("privacy.notice", err, { chatId });
    }

    // Review reply (non avvia prenotazione)
    try {
      if (__txt) {
        const __handled = await maybeHandleReviewReply(client, chatId, __txt, state);
        if (__handled) return "";
      }
    } catch (err) {
      logIgnoredError("review.reply", err, { chatId });
    }

    // Saluto solo se NON ho appena inviato privacy (evita doppio messaggio)
    if (!__privacySentNow) {
      await greetIfReturningUser(chatId, client, state);
    }
  }


  // Timeout automatico (anti-incastro): se l'utente sparisce, resetta lo stato
  if (!__isReenter) try {
    ensureContext(state);
    const MAX_IDLE_MIN = Number(process.env.FLOW_IDLE_RESET_MIN || 15);
    const MAX_IDLE = Math.max(5, MAX_IDLE_MIN) * 60 * 1000;

    const lastAt = Number(state.context.lastMessageAt || 0) || 0;
    const inFlow = !!(state.step && state.step !== "collect");

    if (inFlow && lastAt && Date.now() - lastAt > MAX_IDLE) {
      try { pending.delete(chatId); } catch (err) {
        logIgnoredError("handleMessage.pending.delete", err, { chatId });
      }
      try { __dateParsingLocks.delete(chatId); } catch { }
      try { releaseSoftHoldByChat?.(chatId); } catch (err) {
        logIgnoredError("handleMessage.releaseSoftHold", err, { chatId });
      }

      // Riparti pulito
      state = getState(chatId);
      ensureContext(state);
      state.step = "collect";
      pending.set(chatId, state);

      await reply(
        client,
        chatId,
        "Ho messo da parte la richiesta precedente perché è passato un po’ di tempo 😊 Vuoi *prenotare* o *modificare*?",
        { noFooter: true }
      );
      return "";
    }
  } catch (err) {
    logIgnoredError("handleMessage.idle-reset", err, { chatId });
  }

  // Tracking leggero per capire se l'utente è bloccato nello stesso step (per suggerimenti)
  if (!__isReenter) try {
    ensureContext(state);
    const nowTs = Date.now();
    const prev = String(state.context._lastStepForCount || "");
    const cur = String(state.step || "");
    state.context.sameStepCount = (prev && prev === cur)
      ? (Number(state.context.sameStepCount || 0) || 0) + 1
      : 0;
    state.context._lastStepForCount = cur;
    state.context.lastMessageAt = nowTs;
    state.context.messageCount = (Number(state.context.messageCount || 0) || 0) + 1;

    const col0 = state.collected || {};
    const active0 = (typeof isBookingFlowActive === "function" && isBookingFlowActive(state, col0));
    if (active0 && !state.context.startedAt) state.context.startedAt = nowTs;

    if (process?.env?.ANALYTICS_BOOKING === "1" && active0) {
      log("analytics", "booking_step", {
        chatId,
        step: state.step,
        messageCount: state.context.messageCount,
        elapsedMs: nowTs - (Number(state.context.startedAt || nowTs) || nowTs),
      });
    }

    pending.set(chatId, state);
  } catch (err) {
    logIgnoredError("handleMessage.step-tracking", err, { chatId, step: state?.step || null });
  }

  // ============================================================================
  // SEZIONE 1: LISTINO / RICHIESTE INFORMATIVE (non avviare prenotazione)
  // ============================================================================
  if (!__isReenter) try {
    if (typeof textRaw === "string" && textRaw.trim()) {
      const raw = textRaw.trim();

      const inEdit = typeof state.step === "string" && state.step.startsWith("edit_");
      if (!isInCriticalStep(state.step) && !inEdit) {
        // 🆕 Keyword info prioritarie
        const INFO_PATTERNS = [
          // Comandi secchi (quando l'utente scrive solo "info")
          /^\s*(?:info|listino|prezzi?|tariffe?)\s*$/i,

          // Prezzi e costi - richiede contesto più specifico
          /\b(?:qual(?:e|i)\s+(?:è|sono)\s+(?:il|i|la|le)\s+)?(prezzo|costo|tariffa|listino)\b/i,
          /\bquanto\s+(?:costa(?:no)?|dura(?:no)?|viene(?:gono)?)\b/i,

          // Prima volta - richiede contesto di cliente
          /\b(?:sono|è)\s+(?:un[oa]?\s+)?(?:nuov[oa]|prim[oa])\s+client[ea]\b/i,
          /\b(?:è|sarebbe)\s+la\s+(?:mia|sua)\s+prima\s+volta\b/i,

          // Richieste informazioni esplicite
          /\b(?:vorrei|posso\s+avere|mi\s+(?:serve(?:no)?|servirebbero?))\s+(?:delle?\s+)?informazioni\b/i,
          /\b(?:mi\s+)?(?:puoi|può)\s+(?:dare|fornire|spiegare)\s+(?:delle?\s+)?(?:info|informazioni|dettagli)\b/i,
          /\b(?:mi\s+)?(?:servirebbero?|avrei\s+bisogno\s+di)\s+(?:delle?\s+)?(?:info|informazioni|dettagli)\b/i,

          // Durata con contesto
          /\b(?:quanto\s+tempo|quale\s+(?:è|sono)\s+la)\s+durat[ae]\b/i,
          /\bper\s+quanto\s+tempo\b/i
        ];

        const BOOKING_PATTERNS = [
          // Prenotazioni esplicite
          /\b(?:vorrei|voglio|posso|potrei)\s+(?:fare\s+)?(?:un[ao]?\s+)?(?:prenotazione|appuntamento)\b/i,
          /\b(?:prenot[ao]|prenot(?:are|iamo)|prenoterei)\b/i,

          // ✅ Typo “apputmamento / appuntameto / …”
          /\bappu\w{0,8}mento\b/i,

          // Disponibilità con intent chiaro
          /\b(?:avete|ci\s+sono|c'è|controllare)\s+(?:un\s+)?(?:posto|slot|buco|disponibilit[àa])\b/i,
          /\b(?:siete|sei)\s+(?:liber[io]|disponibil[io])\b/i,

          // Richieste orari/posti specifiche
          /\bavete\s+(?:posti|orari)\s+(?:liberi|disponibili)\b/i,
          /\bposso\s+(?:venire|passare)\s+(?:domani|oggi|stasera)\b/i
        ];

        const isInfoLike = INFO_PATTERNS.some(p => p.test(raw));

        // When hints più restrittivi - richiede contesto di prenotazione
        const hasWhenHint = (
          // Solo se c'è già un pattern di booking
          BOOKING_PATTERNS.some(p => p.test(raw)) && (
            // Temporal references
            /\b(?:per\s+)?(?:oggi|domani|dopodomani|stasera|stamattina|pomeriggio)\b/i.test(raw) ||
            /\b(?:per\s+)?(?:lun(?:ed[iì])?|mar(?:ted[iì])?|mer(?:coled[iì])?|gio(?:ved[iì])?|ven(?:erd[iì])?|sab(?:ato)?|dom(?:enica)?)\b/i.test(raw) ||
            /\btra\s+\d+\s+(?:giorn[io]|settimane)\b/i.test(raw) ||
            // Time formats (solo se preceduti da "alle" o "verso")
            /\b(?:alle|verso|per\s+le)\s+([01]?\d|2[0-3])[:.][0-5]\d\b/i.test(raw) ||
            // Date formats (solo se con separatore chiaro)
            /\b([0-3]?\d)\s*[\/\-]\s*([01]?\d)(?:\s*[\/\-]\s*\d{2,4})?\b/.test(raw)
          )
        );

        const isBookingLike = BOOKING_PATTERNS.some(p => p.test(raw)) || hasWhenHint;

        if (isInfoLike && !isBookingLike) {
          const svcs = cfgServices() || [];
          if (!svcs.length) {
            await reply(client, chatId, "⚠️ Nessun trattamento configurato. Contatta il salone.");
            return "";
          }

          // Estrai servizio menzionato
          const svcHit = typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(raw) : null;
          // 🆕 Ricorda il trattamento: se l'utente poi scrive solo giorno/ora, possiamo proseguire più facilmente
          if (svcHit) {
            try {
              ensureContext(state);
              state.context.preferredService = svcHit;
              pending.set(chatId, state);
            } catch (err) {
              log("warn", "[CATCH] Errore ignorato", { error: String(err) });
            }
          }
          const pick = svcHit && svcs.includes(svcHit) ? [svcHit] : svcs;

          // 🆕 Output migliorato senza numeri
          const lines = pick.map((svc) => {
            const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;
            const emoji = it?.emoji || "💅";
            const label = (it && (it.label || it.name)) || svc;

            const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
            const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";

            const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
            const durTxt = typeof formatDurationMin === "function"
              ? (formatDurationMin(dur) || `${dur} min`)
              : `${dur} min`;

            // Formato: emoji + nome + prezzo + durata
            return `${emoji} *${label}* • ${price} • ${durTxt}`;
          });

          const header = svcHit ? "ℹ️ Dettagli trattamento:" : "📋 I nostri trattamenti:";
          let msg = `${header}\n\n` + lines.join("\n\n");

          // 🆕 CTA soft invece di istruzioni pesanti
          msg += "\n\n💬 _Se vuoi prenotare dimmi giorno e ora_ 😊";

          await reply(client, chatId, msg, { noFooter: true });
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
  if (!__isReenter && textRaw) {
    const __raw = String(textRaw || "").trim();

    // ✅ Cortesia SOLO se NON siamo dentro un flow attivo
    // (altrimenti "ok/va bene" rubano la conferma del menu "Ho capito così")
    const __stepNow = String((pending.get(chatId) || state)?.step || "collect");
    const __inFlowNow = !!(__stepNow && __stepNow !== "collect");

    if (!__inFlowNow && __raw && COURTESY_PATTERNS.some((pattern) => pattern.test(__raw))) {
      // ⚠️ Non rispondere "a caso" se nel messaggio c'è un intento (prenotazione/modifica/info).
      const __intent = (typeof primaryIntent === "function") ? primaryIntent(__raw) : null;
      const __wantsEdit = (typeof wantsEditMenu === "function" ? wantsEditMenu(__raw) : false) || /\b(?:modifica|cambia|sposta|annulla)\b/i.test(__raw);
      const __isBookingLike = (__intent === "appointment") || (typeof looksLikeBooking === "function" ? looksLikeBooking(__raw) : /\b(?:prenot\w*|appunt\w*)\b/i.test(__raw));
      const __isInfoLike = (__intent === "info") || /\b(?:info|informazioni|prezz\w*|listino|costo|quanto\s+(?:costa|dura))\b/i.test(__raw);

      if (!__isBookingLike && !__isInfoLike && !__wantsEdit) {
        // Social / cortesia: rispondi senza toccare lo stato
        const randomResponse = COURTESY_RESPONSES[Math.floor(Math.random() * COURTESY_RESPONSES.length)];
        await reply(client, chatId, randomResponse, { noFooter: true });
        return "";
      }
    }
  }
  // Ringraziamenti = chiusura silenziosa (come "annulla" ma senza messaggi)
  // Serve per evitare loop tipo: bot chiede data -> utente dice "grazie" -> bot resta bloccato sullo step data.
  if (!__isReenter && textRaw && /^(grazie|grazie mille|grazie infinite|ti ringrazio|grazie di tutto|thanks?|thank you|thx)[\s!.]*/i.test(textRaw.trim())) {
    const st = pending.get(chatId);

    try { if (st) unlockBooking(st); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    try { pending.delete(chatId); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    try { releaseSoftHoldByChat(chatId); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    await reply(client, chatId, "Grazie a te per aver usato il nostro servizio! 💅✨\n");
    return "";
  }

  // Uscita rapida (basta/bye) = annulla tutto e chiudi senza rimanere bloccati in un flow
  if (!__isReenter && textRaw && /^(basta(\s+io)?|stop|fine|esci|bye(\s+bye)?|arrivederci|a presto)[\s!.]*$/i.test(textRaw.trim())) {
    const st = pending.get(chatId);
    try { if (st) unlockBooking(st); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    try { pending.delete(chatId); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    try { releaseSoftHoldByChat(chatId); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    await reply(client, chatId, "Va bene, a presto! 👋", { noFooter: true });
    return "";
  }

  // Gestione saluto + intent di prenotazione (rimuovi saluto e continua)

  // Saluti di apertura (solo se step iniziale)
  if (textRaw && /^(ciao|buongiorno|buonasera|buon\s+giorno|buona\s+sera|salve|hey|ehi|hi|hello)[\s!.]*$/i.test(textRaw.trim()) && state.step === "collect") {
    // Evita doppio saluto: se è appena partito il "bentornato" (inactivity greet), non inviare anche il welcome.
    try {
      const db = loadChatDB();
      const lastGreet = Number(db?.[chatId]?.lastGreet || 0);
      if (lastGreet && Date.now() - lastGreet < 5000) return "";
    } catch (e) { }

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

  // ✅ Kickoff "prenota" senza dettagli -> vai diretto a choose_service + lista servizi
  if (!__isReenter) {
    const __t = String(textRaw || "").trim();
    const __bareBooking =
      /^\s*(?:prenota(?:re)?|prenotazione|voglio\s+(?:prenotare|un\s+appuntamento)|vorrei\s+(?:prenotare|un\s+appuntamento)|mi\s+serve\s+(?:un\s+)?appuntamento|appuntamento)\s*[!.?]*\s*$/iu
        .test(__t);

    if (__bareBooking) {
      // reset soft ma senza rompere stato
      state = pending.get(chatId) || state;
      state.collected = state.collected || {};
      const col = state.collected;

      // non trascinare roba vecchia
      col.service = null;
      col.serviceCandidates = null;
      col.when = null;
      col.time = null;
      col.options = null;

      // scegli servizio
      state.step = "choose_service";

      // usa la stessa builder del menu servizi (come showServicesList)
      const { available, msg: svcMsg } = buildServicesMessageForPro(null);
      col.serviceOptions = available;
      col.svcOptions = available;
      try { ensureUI(state); state.ui.lastServiceList = available; } catch { }

      pending.set(chatId, state);
      await reply(client, chatId, `Ok 😊 Che trattamento vuoi prenotare?\n\n${svcMsg}`, { noFooter: true });
      return "";
    }
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

  // Conferma generica (✅ solo in step iniziale, per non rubare i menu/step del booking)
  if (textRaw && state.step === "collect" && /^(okay|va bene|d'?accordo|perfetto|ok)[\s!.]*$/i.test(textRaw.trim())) {
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
  if (!__isReenter && textRaw && /^(arrivederci|a presto|ci vediamo|buona giornata|buona serata|addio|bye|goodbye|see you)[\s!.]*$/i.test(textRaw.trim())) {
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

    // 🆕 Dedupe in ingresso (anti doppio invio WhatsApp)
    if (!__isReenter && shouldDropIncoming(chatId, text)) {
      log("warn", "[INPUT-DEDUP] Drop duplicate incoming message", { chatId });
      return "";
    }

    // Recupera e inizializza stato
    state = getState(chatId);
    state.collected ||= {};
    state.context ||= {};
    ensureContext(state);

    // 🆕 Watchdog coerenza: se lo stato è rotto, riparti soft
    const __valid = ensureValidState(state);
    if (!__valid.ok) {
      log("warn", "[STATE-WATCHDOG] Stato incoerente → reset soft", { chatId, step: __valid.step, missing: __valid.missing });

      try { pending.delete(chatId); } catch { }
      try { __dateParsingLocks.delete(chatId); } catch { }
      try { releaseSoftHoldByChat?.(chatId); } catch { }

      state = getState(chatId);
      ensureContext(state);
      state.step = "collect";
      pending.set(chatId, state);

      await reply(
        client,
        chatId,
        "Non riesco a riprendere da dove eravamo rimasti 😅 Ripartiamo: vuoi *prenotare* o *modificare*?",
        { noFooter: true }
      );
      return "";
    }

    // 🆕 Step: resume dopo una risposta "info" nel mezzo del flow
    if (state.step === "resume_confirm") {
      const yes = /\b(sì|si|ok|certo|vai|continua|riprendi|prosegui)\b/i.test(text);
      const no = /\b(no|non\s+ora|ferma|stop|basta|annulla|esci)\b/i.test(text);

      if (yes && !no) {
        const prev = String(state?.context?._resumeStep || "collect");
        state.context._resumeStep = null;
        state.step = prev || "collect";
        pending.set(chatId, state);

        await reply(client, chatId, "Perfetto 😊 continuiamo!", { noFooter: true });
        await promptResumeStep(client, chatId, state);
        return "";
      }

      if (no) {
        try { pending.delete(chatId); } catch { }
        try { __dateParsingLocks.delete(chatId); } catch { }
        try { releaseSoftHoldByChat?.(chatId); } catch { }

        state = getState(chatId);
        ensureContext(state);
        state.step = "collect";
        pending.set(chatId, state);

        await reply(
          client,
          chatId,
          'Ok 👍 Quando vuoi: scrivi *prenota* per fissare un appuntamento oppure *modifica* per gestirne uno esistente.',
          { noFooter: true }
        );
        return "";
      }

      await reply(client, chatId, "Dimmi solo *si* oppure *no* 🙂", { noFooter: true });
      return "";
    }

    // 🆕 Comando "stato" / "che manca?"
    if (/\b(stato|dove\s+siamo|a\s+che\s+punto|che\s+manca|manca\s+qualcosa)\b/i.test(t)) {
      const col = state.collected || {};
      const parts = [];

      if (col.service) parts.push(`• Trattamento: *${col.service}*`);
      if (col.professionalAny) parts.push(`• Professionista: *chiunque*`);
      else if (col.professionalName) parts.push(`• Professionista: *${col.professionalName}*`);

      if (col.when) {
        const d =
          typeof formatDateWithWeekdayIT === "function"
            ? formatDateWithWeekdayIT(col.when)
            : (typeof fmtDateWithWeekdayIT === "function" ? fmtDateWithWeekdayIT(col.when) : String(col.when));
        parts.push(`• Giorno: *${d}*`);
      }

      if (col.time) parts.push(`• Ora: *${col.time}*`);
      if (col.customerName) parts.push(`• Nome: *${col.customerName}*`);

      const missing = firstMissingField(col);
      const next =
        missing === "service"
          ? "Mi manca solo il *trattamento*: cosa vuoi fare? 🙂"
          : missing === "when"
            ? "Mi manca solo il *giorno*: per quando? 🙂"
            : missing === "time"
              ? "Mi manca solo l’*orario*: a che ora preferisci? 🙂"
              : missing === "professional"
                ? "Mi manca solo il *professionista*: dimmi il numero o il nome in lista 🙂"
                : missing === "customerName"
                  ? 'Mi manca solo *nome e cognome* (es. "Maria Rossi") 🙂'
                  : "Siamo pronti ✅ Se vuoi confermare, dimmi pure *ok*.";

      const head = parts.length ? `Siamo a questo punto ✅\n${parts.join("\n")}\n\n${next}` : `Non ho ancora dati della prenotazione.\n\n${next}`;
      await reply(client, chatId, head, { noFooter: true });
      return "";
    }

    // Salva messaggio utente nella cronologia
    if (!__isReenter) try {
      await appendUserMessage(chatId, text);
    } catch (e) {
      log("warn", "[APPEND] Failed to save user message", e?.message || e);
    }

    const pureNumber = /^\s*\d+\s*[\).]?\s*$/;
    const phone = typeof phoneFromChatId === "function" ? phoneFromChatId(chatId) : chatId;

    log("info", "[HANDLE] Message received", { chatId, text, step: state.step });
    const BOOKING_INTENT_PATTERNS = [
      // Comandi/keyword dirette
      /^\/?(?:prenota|prenotazione|booking|appuntamento)\b/i,

      // Verbi tipici: "voglio prenotare", "vorrei fissare un appuntamento", ecc.
      /\b(?:voglio|vorrei|volevo|mi\s+serve|devo|posso)\s+(?:prenot\w*|fiss\w*|prendere|fare)\b/i,
      /\b(?:prenot\w*|fiss\w*)\s+(?:un'?\s*)?(?:appunt\w*|prenotazion\w*)\b/i,

      // Disponibilità / slot / posto (più “booking-like”, evita “orari” generici)
      /\b(?:disponibilit[àa]|orari?\s+(?:liber\w*|disponibil\w*)|posti?\s+liber\w*|slot|buco)\b/i
    ];


    // Pattern per riconoscere intent di edit durante booking
    const EDIT_INTENT_PATTERNS = [
      // Comandi secchi
      /^\/?(?:modifica|sposta|cambia|annulla|cancella|disdici|edit|tramanda|inoltra)\b/i,

      // Verbi di modifica/cancellazione con contesto
      /\b(?:voglio|vorrei|volevo|devo|posso|mi\s+serve)\s+(?:modific\w*|spost\w*|cambi\w*|annull\w*|cancell\w*|disdic\w*|rimand\w*|rinvi\w*|posticip\w*|anticip\w*|riprogramm\w*|tramand\w*|inoltr\w*)\b/i,

      // "gestisci prenotazione/appuntamento"
      /\b(?:gestire|gestisci)\s+(?:la\s+)?(?:prenotazion\w*|appunt\w*)\b/i
    ];


    // Switch da EDIT → BOOKING
    if (state.step && state.step.startsWith("edit_")) {
      const hasBookingIntent = BOOKING_INTENT_PATTERNS.some(pattern => pattern.test(text));

      if (hasBookingIntent && !wantsEditMenu(text)) {
        log("info", "[SWITCH] Edit → Booking rapido", { chatId });

        // Reset completo
        try { pending.delete(chatId); } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        try { releaseSoftHoldByChat(chatId); } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

        // Nuovo stato booking (riparto da scelta trattamento)
        state = getState(chatId);
        state.edit = null;
        ensureContext(state);

        // UX: chiedi il nome prima di entrare nel booking (riduce confusione su orari/date)
        if (!state.collected?.customerName && !state.context?.nameConfirmed) {
          state.step = "collect_name";
          pending.set(chatId, state);
          await reply(client, chatId, "Come ti chiami? (nome e cognome)\nSe vuoi, scrivi anche trattamento + giorno + ora.");
          return "";
        }

        state.step = "choose_service";
        col.options = null; // ✅ FIX Bug #8;
        pending.set(chatId, state);

        // Passaggio diretto senza messaggi di annullamento
        await reply(client, chatId, "Ok! Che trattamento vuoi fare? 💅");
        return "";
      }
    }


    // Switch da BOOKING → EDIT (solo se sei in collect/start, non durante il flow booking)
    if (!state.step || !state.step.startsWith("edit_")) {
      const col = state.collected || {};

      const __isInitialForEditSwitch = (!state.step || state.step === "collect" || state.step === "start");

      // Se c'è un booking in corso (anche se step si resetta), NON switcho su EDIT
      const __bookingInProgress = !!(
        col?.service || col?.serviceId ||
        col?.when || col?.day || col?.date ||
        col?.time || col?.timePref ||
        col?.slot || col?.slotStart || col?.slotEnd ||
        col?.professionalName || col?.professionalEmail || typeof col?.professionalAny === 'boolean'
      );

      // Override: solo se l'utente è esplicito su appuntamento/prenotazione esistente
      const __explicitEditIntent = /\b(?:modifica|cancella|annulla|sposta|rimanda|disdici)\b.*\b(?:prenotazion\w*|appunt\w*)\b/i.test(text);

      const hasEditIntent =
        (__explicitEditIntent || (!__bookingInProgress && __isInitialForEditSwitch)) &&
        EDIT_INTENT_PATTERNS.some(pattern => pattern.test(text));

      if (hasEditIntent) {
        log("info", "[SWITCH] Booking → Edit rapido", { chatId });

        // Reset rapido: esco dal booking corrente (evita step incoerenti)
        try { releaseSoftHoldByChat(chatId); } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        try { pending.delete(chatId); } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        state = getState(chatId);

        const phone = phoneFromChatId(chatId);

        const bookings = getUserActiveBookingsAll(phone);

        if (!bookings.length) {
          await reply(client, chatId, "🤔 Non risulta alcuna prenotazione futura da modificare.");
          return "";
        }

        // Passaggio diretto al menu edit
        if (bookings.length === 1) {
          const booking = bookings[0];
          _editSnapshotStateFromBooking(state, booking);
          state.step = "edit_menu";
          state.edit = { target: booking };
          pending.set(chatId, state);
          await reply(client, chatId, showEditMenu(booking), { noFooter: true });
          return "";
        }

        // Più prenotazioni: chiedi quale
        await startEditChooseBooking(client, chatId, bookings, null);
        return "";
      }
    }

    // ============================================================================
    // SEZIONE 4: ROUTING EDIT FLOW
    // ============================================================================
    if (typeof state.step === "string" && state.step.startsWith("edit_")) {
      const isCancelMsg =
        /^(annulla|annula|cancel|stop|fine)\b/i.test(text) ||
        (typeof fuzzyCmd === "function" && fuzzyCmd((String(text || "").trim().split(/\s+/)[0] || ""), ["annulla", "annula", "cancel", "stop", "fine"]));
      const isTextStep = state.step === "edit_reschedule_date" || state.step === "edit_change_name";
      const _menuN = pureNumber.test(t) ? Number(t) : NaN;
      const isMenuNumberInTextStep =
        state.step === "edit_reschedule_date" &&
        Number.isInteger(_menuN) &&
        _menuN >= 0 &&
        _menuN <= 4;

      if (!isCancelMsg && (!isTextStep || isMenuNumberInTextStep)) {
        return await handleNumericReply(client, chatId, textRaw);
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
        const msgWords = N(raw).split(" ").filter(Boolean);
        const longHint = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(raw);
        const shortHint = /\b(cort|corte|corto)\w*\b/i.test(raw);
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

              // token matching: exact + tolleranza piccoli refusi (es. "reffil" ~ "refill")
              let hit = 0;
              for (const tk of toks) {
                if (tk.length < 3) continue;

                if (msg.includes(" " + tk + " ")) {
                  hit++;
                  continue;
                }

                if (tk.length >= 4) {
                  const ok = msgWords.some((w) => {
                    if (w === tk) return true;

                    // tolleranza refusi/trasposizioni su token medi-lunghi (es. "reffil" ~ "refill")
                    const L = Math.max(w.length, tk.length) || 1;
                    const md = (typeof typoMaxDist === "function") ? typoMaxDist(L) : (L >= 6 ? 2 : 1);

                    if (md <= 0) return false;
                    if (Math.abs(w.length - tk.length) > md) return false;

                    try {
                      if (typeof isTypoClose === "function") return isTypoClose(w, tk, md);
                      if (typeof dlDist === "function") return dlDist(String(w).toLowerCase(), String(tk).toLowerCase()) <= md;
                      if (typeof levenshtein === "function") return levenshtein(w, tk) <= md;
                    } catch { }
                    return false;
                  });
                  if (ok) hit++;
                }


              }

              const cover = hit / Math.max(1, toks.length);
              const twoGram = toks.some((_, i) =>
                i < toks.length - 1 && msg.includes(" " + toks[i] + " " + toks[i + 1] + " ")
              );
              const contBonus = twoGram ? 0.1 : 0;
              const lenBonus = Math.min(cand.length / 50, 0.15);

              // bonus generici (non hard-coded): "lunghe/corte" se presenti nella richiesta
              const sizeBonus =
                (longHint && /\blungh/i.test(cand) ? 0.12 : 0) +
                (shortHint && /\bcort/i.test(cand) ? 0.12 : 0);

              score = Math.max(score, 0.65 * cover + contBonus + lenBonus + sizeBonus);
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
      const text = String(raw);

      // Preferenza settimana (es. "settimana prossima", "tra 2 settimane")
      try {
        const lower = text.toLowerCase();
        let w = null;
        if (/\b(la\s+prossima\s+settimana|settimana\s+prossima)\b/i.test(lower)) w = 1;
        else if (/\b(settimana\s+dopo|quella\s+dopo)\b/i.test(lower)) w = 2;
        else {
          const m = lower.match(/\btra\s+(\d{1,2})\s+settimane?\b/);
          if (m) w = Math.max(0, Math.min(12, parseInt(m[1], 10)));
        }
        if (w != null) out.weekOffset = w;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      // 🆕 STEP 0: Riconosci keyword INFO prima di tutto (solo richieste esplicite)
      const INFO_KEYWORDS = [
        // prezzo/listino/durata/costi (espliciti)
        /\b(quanto\s+(?:dura|costa|costano)|quanto\s+tempo|quanti?\s+minut[io]|durata|prezzo|prezzi|costo|costi|tariff[ae]|listino)\b/i,
        // “prima volta” (valgono solo se c'è anche una richiesta info vera e propria)
        /\b(prima\s+volta|nuovo\s+client[ea]|sono\s+nuov[oa])\b/i,
      ];

      const looksLikeInfoAsk =
        /[?]/.test(text) ||
        /\b(quanto\s+(?:dura|costa|costano)|prezzo|costo|durata|info|informazioni|listino|dettagli|spieg[ah]|dimmi|mi\s+dici)\b/i.test(text);

      const isInfoQuery = looksLikeInfoAsk && INFO_KEYWORDS.some((pattern) => pattern.test(text));

      if (isInfoQuery) {
        // Marca come query info
        out.isInfoQuery = true;

        // Estrai comunque il servizio (per sapere DI COSA chiedono info)
        let svc = null;
        try {
          svc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

        if (!svc) {
          try {
            svc = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(text) : null) || null;
          } catch (err) {
            log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
          }
        }

        if (svc) out.service = svc;

        // 🚫 NON estrarre data/ora per query info
        return out;
      }

      // STEP 1: Nome
      // ⚠️ Per evitare falsi positivi (es. "per le 18:30") e perché nel flow chiediamo SEMPRE il nome,
      // non estraiamo automaticamente il nome dall'intake.


      // STEP 2: Servizio (scoring + low confidence)
      let svc = null;
      let svcScore = 0;

      const AUTO_ACCEPT = Number(process.env.SVC_AUTO_ACCEPT || 0.92); // >= auto-pick top1
      const AUTO_GAP = Number(process.env.SVC_AUTO_GAP || 0.08);       // gap minimo sul secondo per auto-pick
      const ACCEPT = Number(process.env.SVC_SCORE_ACCEPT || 0.70);     // >= accetta (senza lista)
      const HINT = Number(process.env.SVC_SCORE_HINT || 0.50);         // >= mostra lista/suggerisci
      const AMBIG_DELTA = Number(process.env.SVC_SCORE_AMBIG_DELTA || 0.06);

      try {
        const names = (typeof cfgServices === "function" ? (cfgServices() || []) : []);
        if (names.length && typeof scoreService === "function") {
          let best = null, bestScore = 0;
          let second = null, secondScore = 0;

          for (const name of names) {
            const syns = (typeof cfgServiceSynonyms === "function" ? (cfgServiceSynonyms(name) || []) : []);
            const sc = scoreService(text, { name, synonyms: syns });

            if (sc > bestScore) {
              second = best; secondScore = bestScore;
              best = name; bestScore = sc;
            } else if (sc > secondScore) {
              second = name; secondScore = sc;
            }
          }

          // debug solo su log
          try {
            log("debug", "[SVC_SCORE]", {
              q: String(text || "").slice(0, 140),
              best, bestScore,
              second, secondScore,
              ACCEPT, HINT
            });
          } catch { }

          const gap = (bestScore || 0) - (secondScore || 0);

          // ✅ Auto-pick aggressivo (best alto + gap)
          if (best && bestScore >= AUTO_ACCEPT && gap >= AUTO_GAP) {
            svc = best;
            svcScore = bestScore;
            out.serviceAutoPicked = true;
          }
          // Ambiguo: best e second vicini -> lista scelta
          else if (best && second && bestScore >= HINT && secondScore >= HINT && Math.abs(bestScore - secondScore) < AMBIG_DELTA) {
            out.serviceCandidates = [best, second];
          }
          // Accetta best se abbastanza alto (e non troppo ambiguo)
          else if (best && bestScore >= ACCEPT) {
            svc = best;
            svcScore = bestScore;
          }
          // Score medio: mostra lista (best + second se esiste)
          else if (best && bestScore >= HINT) {
            out.serviceCandidates = second ? [best, second] : [best];
            out.serviceCandidateScore = bestScore;
            out.serviceCandidateSecond = second;
            out.serviceCandidateSecondScore = secondScore;
          }
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      // fallback vecchio SOLO se scoring non ha dato nulla
      if (!svc && !out.serviceCandidates && !out.serviceCandidate) {
        try {
          const tentative =
            (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;

          if (tentative && typeof scoreService === "function") {
            const syns = (typeof cfgServiceSynonyms === "function" ? (cfgServiceSynonyms(tentative) || []) : []);
            const sc = scoreService(text, { name: tentative, synonyms: syns });

            if (sc >= ACCEPT) { svc = tentative; svcScore = sc; }
            else if (sc >= HINT) { out.serviceCandidate = tentative; out.serviceCandidateScore = sc; }
          }
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) });
        }
      }

      if (svc) {
        out.service = svc;
        out.serviceScore = svcScore;
      }


      // STEP 3: Data (solo se NON è info)
      try {
        const baseForWeek =
          (out.weekOffset != null &&
            Number.isInteger(out.weekOffset) &&
            out.weekOffset > 0 &&
            !/\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(text) &&
            // ✅ Se è "tra/fra N settimane" è un relativo puro: NON shiftare al lunedì
            !/\b(?:tra|fra)\s+\d{1,2}\s+settimane?\b/i.test(text))
            ? (() => {
              const d0 = new Date();
              d0.setHours(12, 0, 0, 0);
              const day = d0.getDay(); // 0=dom, 1=lun...
              const diff = (day === 0 ? -6 : 1) - day; // lunedì corrente
              d0.setDate(d0.getDate() + diff + out.weekOffset * 7);
              d0.setHours(12, 0, 0, 0);
              return d0;
            })()
            : null;

        const d = (typeof safeParseDateWithLock === "function"
          ? safeParseDateWithLock(chatId, text, baseForWeek)
          : null) || null;
        if (d) {
          const at12 = typeof atNoon === "function" ? atNoon(d) : d;
          if (!(typeof isPast === "function" && isPast(at12))) out.when = at12;
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      // STEP 4: Orario (solo se NON è info)
      try {
        let hhmm =
          (typeof parseTimeSmart === "function" ? parseTimeSmart(text) : null) ||
          (typeof parseHHMM === "function" ? parseHHMM(text) : null);

        if (!hhmm && typeof parseNaturalTime === "function") hhmm = parseNaturalTime(text);
        if (hhmm) out.time = hhmm;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      // STEP 5: Professionista (come prima)
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      try {
        const item = config?.services?.[svc] || {};
        const pd = item.professionalDurations || {};
        const d2 = proEmail && pd[proEmail];
        if (Number.isFinite(+d2) && +d2 > 0) return +d2;
        const d = item.duration;
        if (Number.isFinite(+d) && +d > 0) return +d;
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      return (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(svc) || 30) : 30);
    };

    /**
     * Costruisce messaggio servizi disponibili per un professionista
     */
const buildServicesMessageForPro = (proEmail) => {
  const BUL = "➡️"; // bullet richiesto (stile prenotazione)

  const allSvcs =
    (typeof cfgServices === "function" ? (cfgServices() || []) : []) ||
    Object.keys(config?.services || {});

  const availableRaw = allSvcs.filter((svc) => isServiceAvailableForPro(svc, proEmail));
  const unavailable = allSvcs.filter((svc) => !isServiceAvailableForPro(svc, proEmail));

  const labelOfSvc = (svc) => {
    const item =
      (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
      (config?.services?.[svc] || {});
    return item.label || item.name || svc;
  };

  const groups = (typeof groupServicesByType === "function")
    ? groupServicesByType(availableRaw, labelOfSvc)
    : [{ title: "Trattamenti", services: availableRaw }];

  const lines = [];
  const available = []; // ORDER IMPORTANTE: deve combaciare coi numeri mostrati
  let idx = 0;

  for (const g of groups) {
    if (lines.length) lines.push("");
    lines.push(`${BUL} *${g.title || "Trattamenti"}*`);

    for (const svc of (g.services || [])) {
      idx++;
      available.push(svc);

      const item =
        (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
        (config?.services?.[svc] || {});
      const emoji = item.emoji || item.icon || item.emoticon || "";
      const label = item.label || item.name || svc;

      const price =
        (typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "") ||
        (Number.isFinite(+item.price) ? `${item.price}€` : "");

      const dur = getDurForPro(svc, proEmail);
      const durTxt =
        (typeof formatDurationMin === "function"
          ? (formatDurationMin(dur) || `${dur} min`)
          : `${dur} min`);

      const metaParts = [];
      if (price) metaParts.push(price);
      metaParts.push(durTxt);
      const meta = metaParts.join(" • ");

      lines.push(`${BUL} ${idx}) ${emoji ? emoji + " " : ""}*${label}* • ${meta}`);
    }
  }

  const unavailableLines = unavailable.map((svc) => {
    const emails = serviceProsEmails(svc);
    const names = emails.map(proNameByEmailSafe).filter(Boolean);
    const who = names.length ? names.join(", ") : "—";
    const label = labelOfSvc(svc);
    return `${BUL} *${label}* (solo con: ${who})`;
  });

  const proHeader = proEmail ? ` con *${proNameByEmailSafe(proEmail)}*` : "";

  let msg =
    `📋 *Trattamenti disponibili${proHeader}*\n` +
    (lines.length ? lines.join("\n") : `${BUL} ⚠️ Nessun trattamento disponibile.`);

  if (available.length) {
    msg += `\n\n💬 _Per scegliere, scrivi il numero del trattamento (1-${available.length})_`;
  }

  if (unavailableLines.length) {
    msg +=
      `\n\n🚫 *Non disponibili${proHeader}*\n${unavailableLines.join("\n")}\n\n` +
      `ℹ️ Se vuoi uno dei trattamenti non disponibili: digita "annulla" e prenota di nuovo scegliendo un professionista che lo esegue.`;
  }

  return { available, msg };
};


    // ============================================================================
    // SEZIONE 6: SHORT-CIRCUIT ROUTING
    // ============================================================================

    // 🧭 Comandi universali: "menu" / "riepilogo" / "indietro"
    {
      const __rawCmd = String(msg || "").trim();
      const __isEdit = typeof state.step === "string" && state.step.startsWith("edit_");

      const __colCmd = state.collected || (state.collected = {});
      const __activeCmd = !__isEdit && (typeof isBookingFlowActive === "function"
        ? isBookingFlowActive(state, __colCmd)
        : (!!(state.step && state.step !== "collect") || !!(__colCmd.service || __colCmd.when || __colCmd.time)));

      const __wantsMenu = /^\s*(menu|riepilogo|riassunto|stato)\s*$/i.test(__rawCmd);
      const __wantsBack = /^\s*(indietro|back)\s*$/i.test(__rawCmd);

      if (__activeCmd && (__wantsMenu || __wantsBack)) {
        // indietro: se stai scegliendo orario, torna alla scelta giorno; altrimenti mostra menu
        if (__wantsBack) {
          if (state.step === "pick_time" || state.step === "edit_reschedule_time") {
            __colCmd.time = null;
            __colCmd.options = null;
            state.step = "choose_day";
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              'Ok 👍 Torniamo al giorno. Che giorno preferisci? (es. "domani", "venerdì", "23/10")',
              { noFooter: true }
            );
            return "";
          }
        }

        try {
          ensureContext(state);
          const built = buildReviewIntakePrompt(__colCmd);
          state.context.reviewIntakeMap = built.map;
          state.context.reviewIntakeMsg = built.msg;
          state.step = "review_intake";
          pending.set(chatId, state);
          await reply(client, chatId, built.msg, { noFooter: true });
          return "";
        } catch (err) {
          log("warn", "[MENU] buildReviewIntakePrompt failed", err?.message || err);
        }
      }
    }


    // Step: conferma mese/giorno quando il mese non è specificato (es. "giovedì 18")
    if (state.step === "confirm_day_month") {
      try { ensureContext(state); } catch { }
      const col = state.collected || (state.collected = {});
      const ctx = state?.context?.dayMonthConfirm || null;
      const rawIn = String(msg || "").trim();
      const low = rawIn.toLowerCase();

      const cancel = /^\s*0\s*[\).]?\s*$/.test(rawIn) || /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low);
      if (cancel) {
        try { state.context.dayMonthConfirm = null; } catch { }
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Ok 👍 Dimmi che giorno preferisci (es. "domani", "23/10", "lunedì").', { noFooter: true });
        return "";
      }

      if (!ctx || !ctx.awaiting) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Dimmi che giorno preferisci (es. "domani", "23/10", "lunedì").', { noFooter: true });
        return "";
      }

      let chosen = null;
      const num = rawIn.match(/^\s*(\d+)\s*[\).]?\s*$/);
      if (num) {
        const n = parseInt(num[1], 10);
        if (n === 1 && ctx.cand1ISO) chosen = new Date(ctx.cand1ISO);
        else if (n === 2 && ctx.cand2ISO) chosen = new Date(ctx.cand2ISO);
        else if (n === 3 && ctx.show3 && ctx.cand3ISO) chosen = new Date(ctx.cand3ISO);
      } else {
        // data scritta a mano
        try {
          chosen = (typeof safeParseDateWithLock === "function") ? safeParseDateWithLock(chatId, rawIn) : null;
        } catch { }
      }

      if (!(chosen instanceof Date) || Number.isNaN(chosen.getTime())) {
        await reply(client, chatId, ctx.prompt, { noFooter: true });
        return "";
      }

      // valida futuro
      const d0 = new Date(chosen);
      d0.setHours(0, 0, 0, 0);
      const today0 = new Date();
      today0.setHours(0, 0, 0, 0);
      if (d0 < today0) {
        await reply(client, chatId, '⚠️ Quella data è già passata. Scegli una data futura.', { noFooter: true });
        await reply(client, chatId, ctx.prompt, { noFooter: true });
        return "";
      }

      col.when = (typeof atNoon === "function") ? atNoon(chosen) : chosen;

      // se avevamo già un orario, preservalo come preferenza
      if (ctx.preferredTime && !col._preferredTime) {
        col._preferredTime = ctx.preferredTime;
        try { ensureContext(state); state.context.preferredTime = ctx.preferredTime; } catch { }
      }

      // cleanup + vai a review
      try { ensureContext(state); state.context.dayMonthConfirm = null; } catch { }
      try {
        const built = buildReviewIntakePrompt(col);
        ensureContext(state);
        state.context.reviewIntakeMap = built.map;
        state.context.reviewIntakeMsg = built.msg;
        state.step = "review_intake";
        pending.set(chatId, state);
        await reply(client, chatId, built.msg, { noFooter: true });
        return "";
      } catch {
        state.step = "review_intake";
        pending.set(chatId, state);
        await reply(client, chatId, 'Ok! Continuiamo 😊', { noFooter: true });
        return "";
      }
    }

    // Routing per numeri puri (elenchi numerati)
    // 🆕 e anche testo in step numerati che supportano nome (es. scelta pro dopo orario)
    if (pureNumber.test(msg) || state.step === "pick_professional_for_time" || state.step === "review_intake") {
      const col = state.collected || (state.collected = {});
      const hasOptions = Array.isArray(col.options) && col.options.length > 0;
      const waitingService = ["info_select_service", "price_select_service", "confirm_service"].includes(state.step);
      const isChoosingService = !col.service && state.step === "choose_service";
      const awaitingDay = (state.availFlow && state.availFlow.awaiting === "day") || state.step === "choose_day";
      const isEditFlow = typeof state.step === "string" && state.step.startsWith("edit_");
      const isReviewIntake = state.step === "review_intake";
      const inNumberedStep = ["pick_professional_for_time", "price_select_service", "review_intake"].includes(state.step);
      const isPickProfessional = state.step === "pick_professional";

      const isPickingTime = state.step === "pick_time" || state.step === "edit_reschedule_time";

      const forceListHandler = ((state.step === "pick_professional_for_time" || state.step === "review_intake") && !pureNumber.test(msg));
      const shouldUseNumericHandler =
        isReviewIntake ||
        forceListHandler ||
        (
          !isChoosingService &&
          !isPickProfessional &&
          !isPickingTime &&
          (awaitingDay || hasOptions || waitingService || inNumberedStep || isEditFlow)
        );

      const __dmPendingChooseDay = (state.step === "choose_day" && !!(state?.context?.dayMonthConfirm && state.context.dayMonthConfirm.awaiting));
      if (shouldUseNumericHandler && !__dmPendingChooseDay) {
        return await handleNumericReply(client, chatId, text, tools);
      }
    }

    // Fast-path intake: parsing diretto da messaggio libero
    if (!pureNumber.test(text)) {
      const col = state.collected || (state.collected = {});

      // 🧼 NEW BOOKING: se l'utente riparte con "prenota/appuntamento/..." mentre siamo in collect/start,
      // azzera i campi del booking per non riusare un servizio vecchio.
      const __initialBookingKick = (!state.step || state.step === "collect" || state.step === "start");
      const __tNormKick = (typeof norm === "function") ? norm(t || "") : String(t || "").toLowerCase();
      const __isNewBookingKick =
        __initialBookingKick &&
        /\b(prenot|appunt|fiss|riserv|posto|disponibil|quando\s+(?:avete|hai|c'e))\w*/i.test(__tNormKick) &&
        !/\b(modific|cancell|annull|spost|disdici)\w*/i.test(__tNormKick);

      if (__isNewBookingKick) {
        try { releaseSoftHoldByChat(chatId); } catch (err) { }
        const keepName = col.customerName || null;

        col.service = null;
        col.when = null;
        col.time = null;
        col.options = null;
        col.optionIds = null;
        col.slotId = null;
        col.proOptions = null;
        col.svcOptions = null;
        col.serviceOptions = null;
        col.professionalAny = null;
        col.professionalName = null;
        col.professionalEmail = null;

        try { ensureContext(state); state.context.preferredService = null; } catch (err) { }
        if (keepName) col.customerName = keepName;
      }

      if (!/^edit_/.test(state.step || "")) {
        const intake = __isReenter ? null : parseIntake(t);
        if (intake) {
          // 🆕 Se è una query info, gestiscila subito SOLO in "collect" (mai durante step del flow)
          const __critical = (typeof isInCriticalStep === "function") ? isInCriticalStep(state.step) : false;
          const __allowInfoNow = (!state.step || state.step === "collect") && !__critical;
          if (intake.isInfoQuery && __allowInfoNow) {
            const svc = intake.service;

            if (svc) {
              // Info su servizio specifico
              const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;
              const emoji = it?.emoji || "💅";
              const label = (it && (it.label || it.name)) || svc;
              const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
              const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";
              const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
              const durTxt = typeof formatDurationMin === "function"
                ? (formatDurationMin(dur) || `${dur} min`)
                : `${dur} min`;

              const msg = `${emoji} *${label}*\n💸 Prezzo: ${price}\n⏱️ Durata: ${durTxt}\n\n💬 _Vuoi prenotare? Dimmi giorno e ora!_ 😊`;
              await reply(client, chatId, msg, { noFooter: true });
            } else {
              // Info generica - mostra tutti i trattamenti
              const svcs = cfgServices() || [];
              const lines = svcs.map((s) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(s) : null;
                const emoji = it?.emoji || "💅";
                const label = (it && (it.label || it.name)) || s;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(s) : "";
                const price = (priceRaw && String(priceRaw).trim()) || "su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(s) : 0;
                const durTxt = typeof formatDurationMin === "function"
                  ? (formatDurationMin(dur) || `${dur} min`)
                  : `${dur} min`;

                return `${emoji} *${label}* • ${price} • ${durTxt}`;
              });

              const msg = `📋 *I nostri trattamenti:*\n\n` + lines.join("\n\n") + "\n\n💬 _Se vuoi prenotare dimmi giorno e ora!_ 😊";
              await reply(client, chatId, msg, { noFooter: true });
            }
            return "";
          }

          // Resto del flow normale per booking...
          if (
            !col.service &&
            Array.isArray(intake.serviceCandidates) &&
            intake.serviceCandidates.length > 1 &&
            (!state.step || state.step === "collect")
          ) {
            col.serviceCandidates = intake.serviceCandidates.slice();
            state.step = "confirm_service";
            pending.set(chatId, state);

            // 🔎 Omonimia: se l'utente scrive un termine generico (es. "ricostruzione"),
            // espandi la lista con TUTTI i trattamenti che matchano quel termine (nome o sinonimi).
            let homToken = null;
            let opts = Array.isArray(col.serviceCandidates) ? col.serviceCandidates.slice() : [];

            try {
              const STOP = new Set([
                "voglio", "vorrei", "volevo", "prenotare", "prenota", "appuntamento",
                "un", "una", "il", "lo", "la", "i", "gli", "le",
                "per", "di", "da", "del", "della", "dei", "delle",
                "a", "al", "allo", "alla", "alle", "all",
                "nel", "nello", "nella", "nei", "negli", "nelle",
                "con", "senza", "mi", "serve", "che", "come", "fare", "farmi", "fatta", "fatto",
                "questo", "questa", "quello", "quella", "coso",
                "oggi", "domani", "dopodomani", "ieri", "tra", "dopo", "settimana", "prossima", "prossimo",
                "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica",
                "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"
              ]);

              const q = norm(t || "");
              const tokens = q
                .split(/\s+/)
                .map((x) => String(x || "").trim())
                .filter((x) => x && x.length >= 4 && !STOP.has(x) && !/^\d+$/.test(x));

              const services = (typeof cfgServices === "function" ? (cfgServices() || []) : []);

              for (const tok of tokens) {
                const matches = [];

                for (const svc of services) {
                  const it = (typeof cfgServiceItem === "function") ? cfgServiceItem(svc) : null;
                  const label = norm(((it && (it.label || it.name)) || svc));

                  if (label.includes(tok)) {
                    matches.push(svc);
                    continue;
                  }

                  const syns = (typeof cfgServiceSynonyms === "function") ? (cfgServiceSynonyms(svc) || []) : [];
                  if (syns.some((sy) => {
                    const n = norm(sy);
                    return n === tok || n.includes(tok);
                  })) {
                    matches.push(svc);
                  }
                }

                // Se per un token trovo >=2 match, lo considero "omonimia" e mostro TUTTI i match.
                if (matches.length >= 2) {
                  homToken = tok;
                  opts = matches;
                  break;
                }
              }
            } catch { }

            // aggiorna candidates in stato, così la scelta numerica punta alla lista giusta
            col.serviceCandidates = opts.slice();

            const lines = opts
              .map((svc, i) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;
                const emoji = it?.emoji ? it.emoji : "";
                const label = (it && (it.label || it.name)) ? (it.label || it.name) : svc;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
                const price = (priceRaw && String(priceRaw).trim()) ? String(priceRaw).trim() : "prezzo su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
                const durTxt = typeof formatDurationMin === "function"
                  ? (formatDurationMin(dur) || `${dur} min`)
                  : `${dur} min`;
                return `${i + 1}) ${emoji ? emoji + " " : ""}${label} (_${price}_, _*${durTxt}*_)`;
              })
              .join("\n");

            const header = homToken
              ? `❓ “${homToken}” può indicare più trattamenti. Quale intendi?`
              : `❓ Quello che hai scritto può indicare più trattamenti. Quale intendi?`;

            await reply(client, chatId, `${header}\n${lines}\n(1-${opts.length})`);
            return "";
          }

          if (intake.service) col.service = col.service || intake.service;
          if (intake.when) col.when = col.when || intake.when;
          if (intake.time) col.time = col.time || intake.time;

          // 🆕 score basso/medio: suggerisci senza auto-selezionare
          const __canAskSvcFix = (!state.step || state.step === "collect" || state.step === "start");

          // 🆕 se il messaggio è “voglio un appuntamento” (senza servizio/data/ora) => riparto chiedendo il servizio
                    const __m = String(msg || "");

          const __genericBookingNoSvc =
            __canAskSvcFix &&
            (
              hasBookingVerb(__m) ||
              /\bappuntamento\b/i.test(__m) ||
              /\bprenot\w+\b/i.test(__m) ||
              /\bquando\b.*\bappuntamento\b/i.test(__m) ||
              /\bprossim\w*\s+appuntamento\b/i.test(__m)
            ) &&
            !hasDateOrTime(__m) &&
            !parseHHMM(__m) &&
            !intake.service &&
            !intake.when &&
            !intake.time &&
            !intake.serviceCandidate &&
            !intake.serviceCandidates;

          if (__genericBookingNoSvc) {
            // reset leggero: tengo solo il nome se già lo ho
            const keepName = col.customerName || null;
            for (const k of Object.keys(col)) delete col[k];
            if (keepName) col.customerName = keepName;

            state.step = "choose_service";
            pending.set(chatId, state);

            // se hai il builder lista servizi, usalo; altrimenti chiedi testo libero
            try {
              const { available, msg: svcMsg } = buildServicesMessageForPro(null);
              col.serviceOptions = available;
              col.svcOptions = available;
              try { ensureUI(state); state.ui.lastServiceList = available; } catch { }
              await reply(client, chatId, svcMsg, { noFooter: true });
            } catch {
              await reply(client, chatId, "Ok 😊 Che trattamento vuoi prenotare? (es. refill gel, semipermanente, pedicure)", { noFooter: true });
            }
            return "";
          }

                    // Score medio: non costringere l'utente a riscrivere → fai scegliere 1-2 opzioni
          if (__canAskSvcFix && !col.service && intake.serviceCandidate && Number.isFinite(+intake.serviceCandidateScore)) {
            const best = intake.serviceCandidate;
            const second = intake.serviceCandidateSecond || null;

            const opts = [best, second].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
            if (opts.length) {
              col.serviceCandidates = opts.slice();
              state.step = "confirm_service";
              pending.set(chatId, state);

              const lines = opts.map((svc, i) => {
                const it = typeof cfgServiceItem === "function" ? cfgServiceItem(svc) : null;
                const emoji = it?.emoji ? it.emoji : "";
                const label = (it && (it.label || it.name)) ? (it.label || it.name) : svc;
                const priceRaw = typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "";
                const price = (priceRaw && String(priceRaw).trim()) ? String(priceRaw).trim() : "prezzo su richiesta";
                const dur = typeof cfgServiceDuration === "function" ? cfgServiceDuration(svc) : 0;
                const durTxt = typeof formatDurationMin === "function"
                  ? (formatDurationMin(dur) || `${dur} min`)
                  : `${dur} min`;
                return `${i + 1}) ${emoji ? emoji + " " : ""}${label} (_${price}_, _*${durTxt}*_)`;
              }).join("\n");

              await reply(
                client,
                chatId,
                `🤔 Non sono sicuro al 100%. Quale trattamento intendi?\n${lines}\n(1-${opts.length})`,
                { noFooter: true }
              );
              return "";
            }
          }

          if (intake.weekOffset != null) {
            ensureContext(state);
            state.context.weekOffset = intake.weekOffset;
          }

          if (typeof intake.professionalAny === "boolean") col.professionalAny = intake.professionalAny;
          if (intake.professionalName) col.professionalName = intake.professionalName;
          if (intake.professionalEmail) col.professionalEmail = intake.professionalEmail;


          // Se l'utente ha indicato un professionista, non trattarlo come "qualsiasi"
          if ((intake.professionalName || intake.professionalEmail) && typeof intake.professionalAny !== "boolean") {
            col.professionalAny = false;
          }

          // 🆕 REVIEW INTAKE: riepilogo + menu (solo all'inizio, mai su re-enter)
          const __initialForReview = (!state.step || state.step === "collect" || state.step === "start");
          const __hasAnyForReview = !!(
            intake.service ||
            intake.when ||
            intake.time ||
            intake.professionalName ||
            intake.professionalEmail ||
            typeof intake.professionalAny === "boolean"
          );

          if (!__isReenter && __initialForReview && __hasAnyForReview) {
            // Default: professionista = qualsiasi, salvo esplicita scelta dell'utente
            if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") col.professionalAny = true;

            // ✅ Caso: l'utente dà già giorno/ora ma NON dice il trattamento
            // Esempio: "voglio un appuntamento il 15 alle 13"
            const __wantsBooking = /\b(prenot|appunt|fiss|posto|disponibil)\w*/i.test(String(msg || ""));
            if (__wantsBooking && !col.service && (col.when || col.time)) {
              // tratta l'orario come PREFERENZA (non come time confermato)
              try {
                if (col.time) {
                  ensureContext(state);
                  state.context.preferredTime = col.time;
                  col._preferredTime = col.time;
                  col.time = null;
                }
              } catch { }

              const dayTxt = col.when ? fmtWeekdayDateShortIT(col.when) : "";
              const prefTxt = (state?.context?.preferredTime || col._preferredTime) ? String(state.context.preferredTime || col._preferredTime) : "";
              const recap = [dayTxt && `il giorno *${dayTxt}*`, prefTxt && `alle *${prefTxt}*`].filter(Boolean).join(" • ");

              state.step = "choose_service";
              pending.set(chatId, state);

              try {
                const { available, msg: svcMsg } = buildServicesMessageForPro(null);
                col.serviceOptions = available;
                col.svcOptions = available;
                try { ensureUI(state); state.ui.lastServiceList = available; } catch { }

                await reply(
                  client,
                  chatId,
                  `${recap ? `Ok! Ho segnato: ${recap}.\n` : ""}Ora dimmi *che trattamento* vuoi prenotare:\n\n${svcMsg}`,
                  { noFooter: true }
                );
              } catch {
                await reply(
                  client,
                  chatId,
                  `${recap ? `Ok! Ho segnato: ${recap}.\n` : ""}Ora dimmi *che trattamento* vuoi prenotare (es. refill gel, semipermanente, pedicure).`,
                  { noFooter: true }
                );
              }
              return "";
            }



            // ✅ Se l'utente ha scritto un giorno senza mese (es. "giovedì 18"), chiedi conferma per ridurre errori.
            try {
              const __dmCtx = (intake.when ? __buildDayMonthConfirmFromText(String(msg || ""), new Date()) : null);
              if (__dmCtx) {
                ensureContext(state);
                state.context.dayMonthConfirm = __dmCtx;
                // evita di salvare un "when" potenzialmente sbagliato
                col.when = null;
                state.step = "confirm_day_month";
                pending.set(chatId, state);
                await reply(client, chatId, __dmCtx.prompt, { noFooter: true });
                return "";
              }
            } catch { }

            // Default: review intake
            ensureContext(state);
            const built = (typeof buildReviewIntakePrompt === "function")
              ? buildReviewIntakePrompt(col)
              : { msg: "Ok! Procediamo 😊", map: { "1": "continue" } };
            state.context.reviewIntakeMap = built.map;
            state.context.reviewIntakeMsg = built.msg;
            state.step = "review_intake";
            pending.set(chatId, state);
            await reply(client, chatId, built.msg, { noFooter: true });
            return "";
          }

          if (col.service && !state.step) {
            // Default: professionista = qualsiasi, salvo esplicita scelta dell'utente
            if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") col.professionalAny = true;
            state.step = "choose_day";
            col.options = null; // ✅ FIX Bug #8: Reset options;
            pending.set(chatId, state);
          }
        }
      }
    }


    // ============================================================================
    // SEZIONE 7: CANCELLAZIONE GLOBALE
    // ============================================================================
    if (
      /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(t) ||
      (typeof fuzzyCmd === "function" && fuzzyCmd((String(t || "").trim().split(/\s+/)[0] || ""), ["annulla", "annula", "cancel", "stop", "fine", "esci"]))
    ) {
      const st = pending.get(chatId);

      if (st && /^edit_/.test(st.step)) {
        pending.delete(chatId);
        try {
          releaseSoftHoldByChat(chatId);
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        await reply(client, chatId, "✅ Ho chiuso la gestione dell'appuntamento. Nessuna modifica applicata.");
        return "";
      }

      if (st) unlockBooking(st);
      pending.delete(chatId);

      try {
        releaseSoftHoldByChat(chatId);
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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

      if (RE_ADDR.test(t)) {
        const prevStep = String(state.step || "collect");
        const resume = prevStep && prevStep !== "collect" && !String(prevStep).startsWith("edit_");

        if (resume) {
          ensureContext(state);
          state.context._resumeStep = prevStep;
          state.step = "resume_confirm";
          pending.set(chatId, state);
        }

        const addr = (config?.address || config?.addr || "Via Bosco, 44/a, 42019 Reggio Emilia RE").trim();
        await reply(
          client,
          chatId,
          `Ci trovi in ${addr}. 💐💖` + (resume ? `\n\nVuoi continuare con la prenotazione da dove eravamo rimasti? (si/no)` : "")
        );
        return "";
      }
      const RE_HOURS = /(quando\s+(aprite|chiudete|siete\s+aperti?|siete\s+chiusi?|fate)|a\s+che\s+ora|che\s+ore\s+fate|siete\s+aperti?|aperto|chiuso|disponibilit[aà])/i;
      if (RE_HOURS.test(t)) {
        const prevStep = String(state.step || "collect");
        const resume = prevStep && prevStep !== "collect" && !String(prevStep).startsWith("edit_");

        if (resume) {
          ensureContext(state);
          state.context._resumeStep = prevStep;
          state.step = "resume_confirm";
          pending.set(chatId, state);
        }

        const businessHours = config?.businessHours;
        const formattedHours = formatBusinessHours(businessHours);

        await reply(
          client,
          chatId,
          (formattedHours
            ? `I nostri orari sono:\n${formattedHours}`
            : `Siamo aperti dal Lunedì al Venerdì, dalle 9:00 alle 19:00, e il Sabato dalle 9:00 alle 17:00. Domenica chiuso.`) +
          (resume ? `\n\nVuoi continuare con la prenotazione da dove eravamo rimasti? (si/no)` : "")
        );
        return "";
      }
    }

    // Guard: booking bloccato
    if (isBookingLocked(state) && !/^(annula|annulla|cancel|stop|fine|esci)\b/i.test(t)) {
      if (!isInCriticalStep(state.step) && state.step !== "collect") {
        await safeSend(
          client,
          chatId,
          '⏳ Sembra che stiamo già completando una prenotazione.\nSe vuoi interrompere: scrivi *annulla*.\nSe invece vuoi continuare, dimmi pure cosa ti serve 🙂'
          ,
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
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

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
        await reply(client, chatId, showEditMenu(booking), { noFooter: true });
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      state.edit = { target: updated };
      pending.set(chatId, state);

      await reply(client, chatId, `✅ Nome aggiornato.\n\n${showEditMenu(updated)}`);
      return "";
    }

    // ============================================================================
    // SEZIONE 12B: FALLBACK INTENT (non avvia prenotazione su messaggi generici)
    // ============================================================================
    const __isInitialForFallback = (!state.step || state.step === "collect" || state.step === "start");
    const __wantsEditHere = (typeof wantsEditMenu === "function" ? wantsEditMenu(text) : false) || /^\/?(?:modifica|edit)\b/i.test(t);
    const __wantsInfoHere = /\b(?:info|prezz\w*|listino|serviz\w*|trattament\w*|costo|quanto|orari|apert\w*|indirizzo)\b/i.test(t);

    if (!__isReenter && __isInitialForFallback && !pureNumber.test(text) && !looksLikeBooking(t) && !__wantsEditHere && !__wantsInfoHere) {
      const helpMsg =
        "Ciao! 👋 Sono *synkris*\n\n" +
        "✅ Per *prenotare* scrivi *prenota* (oppure: trattamento + giorno + ora).\n" +
        "✏️ Per *modificare* un appuntamento scrivi *modifica*.\n" +
        "ℹ️ Per *info/listino* scrivi *info*.\n\n" +
        "Esempi:\n" +
        "• \"prenota refill gel domani alle 15\"\n" +
        "• \"modifica appuntamento\"";
      await reply(client, chatId, helpMsg, { noFooter: true });
      return "";
    }


    // ============================================================================
    // SEZIONE 13: STEP 1 - SCELTA PROFESSIONISTA
    // ============================================================================
    const inEditFlowGlobal = state.step && typeof state.step === "string" && state.step.startsWith("edit_");
    const needPro = false; // non chiediamo più il professionista come step iniziale
    const alreadyAskingPro = (state.step === "pick_professional");
    const isInitialState = !state.step || state.step === "collect" || state.step === "start";
    const awaitingName = !!(state?.context?.awaitingName);
    const hasService = !!(col?.service);

    // 👇 Nuovo comportamento: il professionista NON si chiede all'inizio.
    // Default: qualsiasi, salvo esplicita scelta dell'utente (es. "con Diana").
    if (!inEditFlowGlobal && isInitialState && !awaitingName && looksLikeBooking(t)) {
      if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== "boolean") {
        col.professionalAny = true;
      }
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
      const isAny =
        /^\s*0\s*[\).]?\s*$/.test(txt) ||
        /\b(non\s+mi\s+interessa|chiunque|qualsiasi|indifferente|nessuna\s+preferenza)\b/i.test(txt);

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

          // Assicura che il nome sia stato raccolto PRIMA di chiedere giorno/orario
          ensureContext(state);
          if (!state.context?.nameConfirmed || !col.customerName) {
            state.step = "collect_name";
            state.context.awaitingName = true;
            pending.set(chatId, state);
            await reply(
              client,
              chatId,
              'Per favore scrivi nome e cognome (es. "Maria Rossi") per completare la prenotazione.',
              { noFooter: true }
            );
            return "";
          }

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
          await reply(
            client,
            chatId,
            `❌ Scelta non valida. Scrivi *0* per nessuna preferenza oppure un numero *1-${pros.length}*.`
          );
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

            // (Nome raccolto più avanti, dopo data e orario)

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
      let choice = typeof resolveProReply === "function" ? resolveProReply(txt, pros) : null;

      // "uguale / come prima" -> riusa ultimo professionista (se noto) oppure 0
      if ((!choice || (choice && !choice.any && !choice.email && !choice.name)) && /\b(uguale|come\s+prima|stess[oa])\b/i.test(txt)) {
        const lastEmail = state?.context?.lastProfessionalEmail || null;
        const lastName = state?.context?.lastProfessionalName || null;
        if (lastEmail || lastName) {
          const email =
            lastEmail ||
            (typeof proEmailByName === "function" && lastName ? proEmailByName(lastName) : null);
          const name =
            lastName ||
            (email && typeof proNameByEmailSafe === "function" ? proNameByEmailSafe(email) : null) ||
            email;
          choice = { any: false, email, name };
        } else {
          choice = { any: true };
        }
      }

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

            // (Nome raccolto più avanti, dopo data e orario)

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

    if (!inEditFlow && !col.service && (!isInitialState || looksLikeBooking(t))) {

      const hasProfessional = col.professionalAny || col.professionalEmail || col.professionalName;

      if (!hasProfessional) {
        // Default: qualsiasi professionista
        col.professionalAny = true;
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
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

        if (svcMatch && svcs.some(s => norm(s) === norm(svcMatch))) return svcMatch;

        try {
          const all = (typeof cfgServices === "function" ? (cfgServices() || []) : []) || [];
          const exists = all.find(s => norm(s) === norm(svcMatch || input));
          if (exists && !isServiceAvailableForPro(exists, proEmail))
            return { __UNAVAILABLE__: true, svc: exists };
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

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
        const who = names.length ? names.join(", ") : "-";
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

      // ✅ Se avevi già giorno+orario, dopo scelta trattamento vai diretto alla richiesta nome
      if (col.when && col.time) {
        state.step = "collect_name";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          'Perfetto 😊 Per completare la prenotazione scrivi *nome e cognome* (es. "Maria Rossi").',
          { noFooter: true }
        );
        return "";
      }

      state.step = "choose_day";
      pending.set(chatId, state);
      const proLine = wasAny && col.professionalEmail
        ? `Hai scelto *${proNameByEmailSafe(col.professionalEmail)}* per il tuo appuntamento.\n`
        : "";

      await reply(client, chatId, `${proLine}Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
      return "";
    }

    // ============================================================================
    // SEZIONE 15: STEP 3 - SCELTA GIORNO
    // ============================================================================
    if (state.step === "choose_day") {
      state.step = "choose_day";

      const col = state.collected || (state.collected = {});
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Prima dimmi che trattamento vuoi prenotare 😊", { noFooter: true });
        return "";
      }

      let userInput = String(msg || "").trim();

      // ✅ Conferma mese/giorno se l'utente scrive solo il numero del giorno o "giovedì 18" senza mese
      try {
        ensureContext(state);
        const dm = state?.context?.dayMonthConfirm || null;
        const rawIn = String(userInput || "").trim();
        const low = rawIn.toLowerCase();

        // se stiamo aspettando la risposta (1/2/3), trasformo in data esplicita e continuo nel flow normale
        if (dm && dm.awaiting) {
          if (/^\s*0\s*[\).]?\s*$/.test(rawIn) || /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low)) {
            state.context.dayMonthConfirm = null;
            pending.set(chatId, state);
            await reply(client, chatId, 'Ok 👍 Dimmi un altro giorno (es. "domani", "23/10").', { noFooter: true });
            return "";
          }

          let chosen = null;
          const num = rawIn.match(/^\s*(\d+)\s*[\).]?\s*$/);
          if (num) {
            const n = parseInt(num[1], 10);
            if (n === 1 && dm.cand1ISO) chosen = new Date(dm.cand1ISO);
            else if (n === 2 && dm.cand2ISO) chosen = new Date(dm.cand2ISO);
            else if (n === 3 && dm.show3 && dm.cand3ISO) chosen = new Date(dm.cand3ISO);
          } else {
            try { chosen = safeParseDateWithLock(chatId, rawIn); } catch { }
          }

          if (!(chosen instanceof Date) || Number.isNaN(chosen.getTime())) {
            await reply(client, chatId, dm.prompt, { noFooter: true });
            return "";
          }

          // preserva eventuale orario del messaggio originale
          if (dm.preferredTime && !col._preferredTime) {
            col._preferredTime = dm.preferredTime;
            try { state.context.preferredTime = dm.preferredTime; } catch { }
          }

          // sostituisci input con data esplicita (evita ambiguità)
          userInput = (typeof fmtDate === "function") ? fmtDate(chosen) : chosen.toLocaleDateString("it-IT");

          state.context.dayMonthConfirm = null;
          pending.set(chatId, state);
        } else {
          // se NON stiamo aspettando, valuta se serve chiedere conferma
          const ctx = __buildDayMonthConfirmFromText(rawIn, new Date());
          if (ctx) {
            state.context.dayMonthConfirm = ctx;
            pending.set(chatId, state);
            await reply(client, chatId, ctx.prompt, { noFooter: true });
            return "";
          }
        }
      } catch { }

      // Quick command: cambio trattamento durante il flow
      if (/\b(?:cambia|modifica)\s+(?:il\s+)?(?:trattament\w*|serviz\w*)\b/i.test(userInput)) {
        // reset servizio e torna alla lista
        col.service = null;
        state.context = state.context || {};
        state.context.preferredService = null;

        // calcola lista servizi rispettando eventuale professionista scelto
        if (!col.professionalName && !col.professionalEmail && typeof col.professionalAny !== 'boolean') col.professionalAny = true;
        let proEmail = null;
        if (!col.professionalAny) {
          proEmail = col.professionalEmail || (typeof proEmailByName === 'function' ? proEmailByName(col.professionalName) : null);
          col.professionalEmail = proEmail;
        }

        const { available, msg: svcMsg } = buildServicesMessageForPro(proEmail);
        col.serviceOptions = available;
        col.svcOptions = available;
        ensureUI(state);
        state.ui.lastServiceList = available;
        state.step = 'choose_service';
        pending.set(chatId, state);
        await reply(client, chatId, svcMsg, { noFooter: true });
        return '';
      }

      // Nota UX: permettiamo di scegliere giorno/orario anche prima del nome.
      // Il nome verrà comunque richiesto esplicitamente prima della conferma finale.

      if (__dateParsingLocks.has(chatId)) {
        log('warn', '[CHOOSE_DAY] Parsing già in corso, ignoro', { chatId });
        return "";
      }

      if (!userInput || userInput.length < 2) {
        await reply(client, chatId, `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`);
        return "";
      }

      // Parsing della data (con auto-scelta se l'utente delega: "dimmi tu", "quando preferisci", ...)
      __dateParsingLocks.add(chatId);
      let parsedDate = null;
      let precomputedSlots = null;

      try {
        // Se l'utente delega la scelta del giorno, prova a selezionare automaticamente il primo giorno con disponibilità
        const delegationPatterns = [
          // 1. DELEGA DIRETTA ("dimmi tu", "scegli tu", "decidi tu")
          /\b(dimmi|fai|scegli|decidi|vedi|pensa|proponi|suggerisci|indica|organizza|sistema|arrangia(?:ti)?|gestisci|trova)\s+tu\b/i,

          // 2. PREFERENZE DELL'OPERATORE ("come vuoi", "come preferisci")
          /\bcome\s+(vuoi|preferisci|ti\s+(?:pare|sembra|va|piace|conviene)|meglio\s+(?:credi|pensi|ritieni)|preferisce|vuole|ritieni|pensi|credi|ti\s+(?:è|e)\s+(?:più\s+)?comodo|vi\s+(?:pare|sembra|va|conviene))\b/i,

          // 3. QUANDO VUOI/PUOI/PREFERISCI
          /\bquando\s+(vuoi|preferisci|puoi|riesci|preferisce|vuole|[èeé]\s+disponibile|(?:ti\s+|vi\s+)?(?:[èeé]|e)\s+(?:più\s+)?comodo|(?:ti\s+|vi\s+)?(?:va|conviene)\s+(?:meglio|bene)|hai\s+(?:un\s+)?(?:posto|buco|slot)|avete\s+(?:un\s+)?(?:posto|buco|slot)|siete\s+liber[ie])\b/i,

          // 4. QUANDO TI/LE FA COMODO
          /\bquando\s+(ti|le|vi)\s+((?:[èeé]|e)\s+comodo|fa\s+comodo|(?:va|viene)\s+(?:meglio|bene)|conviene)\b/i,

          // 5. QUANDO HAI TEMPO/POSTO/DISPONIBILITÀ
          /\bquando\s+(hai|avete|c['']?(?:[èeé]|e)|ci\s+(?:[èeé]|e|sono))\s+(tempo|posto|posti|buco|buchi|slot|disponibilit[aàá]|un\s+(?:posto|buco|slot)|dei\s+posti|qualche\s+(?:posto|buco))\b/i,

          // 6. VA BENE TUTTO / QUALSIASI / QUALUNQUE
          /\b(va\s+bene|vanno\s+bene|[èeé]\s+(?:uguale|lo\s+stesso|indifferente)|qualsiasi|qualunque|(?:non\s+)?importa|fa\s+(?:lo\s+stesso|uguale))\s+(tutto|quando|giorno|giorni|data|date|orario|orari|momento|cosa|slot)\b/i,

          // 7. VA BENE QUALSIASI (forma invertita)
          /\b(qualsiasi|qualunque|ogni|tutti\s+(?:i|gli)|tutte\s+le)\s+(giorno|data|orario|momento|slot)\s+(va\s+bene|vanno\s+bene|[èeé]\s+(?:ok|buon[oa])|mi\s+(?:va|and[aà])\s+bene)\b/i,

          // 8. PRIMO/PRIMA DISPONIBILE
          /\b(prim[oaie]|prima)\s+(disponibile|liber[oaie]|posto|data|slot|orario|buco|(?:che|che\s+c[''](?:[èeé]|e))\s+(?:c[''](?:[èeé]|e)|trovi|hai|avete))\b/i,

          // 9. APPENA/PRIMA POSSIBILE
          /\b(appena|prima|quanto\s+prima|al\s+più\s+presto|il\s+prima)\s+possibile\b/i,

          // 10. SECONDO DISPONIBILITÀ / A DISCREZIONE
          /\b(secondo|in\s+base\s+(?:a|alla)|sulla\s+base\s+(?:di|della)|a)\s+(disponibilit[aàá]|discrezion[ee]|tue\s+esigenze|vostre\s+esigenze|vostra\s+(?:agenda|disponibilit[aàá])|tua\s+(?:agenda|disponibilit[aàá]))\b/i,

          // 11. DIMMI/PROPONIMI/SUGGERISCI + QUANDO/ORARIO/DATA
          /\b(dimmi|proponimi|suggerisci|indica(?:mi)?|consiglia(?:mi)?|proporr[eei]|suggerir[eei]|di['']?\s*(?:mi|a\s+me)|fammi\s+sapere)\s+(quando|un\s+(?:orario|giorno|momento)|una\s+data|(?:un|dei|degli|delle)\s+(?:orari|giorni|date|momenti|slot)|(?:il|la)\s+(?:giorno|data|orario|momento)|cosa\s+(?:[èeé]|e)\s+(?:meglio|disponibile))\b/i,

          // 12. NON HO PREFERENZE / NON IMPORTA QUANDO
          /\bnon\s+(ho\s+(?:preferenze|esigenze\s+particolari|problemi|vincoli)|importa\s+(?:quando|il\s+giorno|l['']orario|quale\s+(?:giorno|orario|data))|mi\s+(?:importa|cambia)|fa\s+differenza|c[''](?:[èeé]|e)\s+(?:problema|differenza))\b/i,

          // 13. INDIFFERENTE / MI ADATTO / FLESSIBILE
          /\b(indifferente|mi\s+(?:adatto|adeguo|regolo)|ci\s+(?:adattiamo|adeguiamo|regoliamo)|(?:sono|siamo)\s+flessibil[ie]|flessibilit[aàá]\s+(?:totale|completa|massima)|nessun[ao]?\s+(?:problema|preferenza|vincolo)|va\s+(?:tutto\s+)?bene|(?:non|senza)\s+problemi)\b/i,

          // 14. COME MEGLIO PER TE/VOI
          /\b(come|quando|quello\s+che)\s+(?:[èeé]\s+)?(?:meglio|più\s+comodo)\s+per\s+(?:te|voi|lei|il\s+salone|l['']operatric[ee])\b/i,

          // 15. AFFIDATI A TE/VOI
          /\b(mi\s+affido|ci\s+affidiamo|affidati|(?:mi|ci)\s+fid[oi]|lasci[oa]\s+(?:fare|decidere|scegliere)\s+a\s+(?:te|voi|lei)|rimetto\s+a\s+(?:te|voi|lei))\b/i,

          // 16. TU SAI MEGLIO / VOI SAPETE MEGLIO
          /\b(tu|voi|lei)\s+(sai|sapete|sa|conosci|conoscete|conosce)\s+(meglio|(?:di|più)\s+(?:me|noi)|cosa\s+(?:[èeé]|e)\s+meglio|come\s+organizzare|(?:la|le)\s+(?:tue|vostre|sue)\s+(?:esigenze|disponibilit[aàá]|agenda))\b/i,

          // 17. DECIDI TU / SCEGLI TU (forma imperativa pura)
          /^(?:decidi(?:\s+tu)?|scegli(?:\s+tu)?|vedi(?:\s+tu)?|organizza(?:\s+tu)?|fai(?:\s+tu)?|pensa(?:\s+tu)?|sistema(?:\s+tu)?)\s*[!.?]?\s*$/i,

          // 18. QUANDO CAPITA / QUANDO C'È POSTO
          /\bquando\s+(capita|c[''](?:[èeé]|e)\s+(?:posto|un\s+buco|disponibilit[aàá])|si\s+(?:libera|apre)\s+un\s+(?:posto|buco|slot)|(?:hai|avete)\s+(?:un\s+)?(?:buco|momento|spazio))\b/i,

          // 19. NON HO VINCOLI / NESSUN VINCOLO
          /\b((?:non|senza)\s+(?:vincoli|limiti|restrizioni|problemi\s+di\s+(?:orario|giorni))|nessun\s+(?:vincolo|limite|restrizione|problema))\b/i,

          // 20. COME TI/VI PARE / COME TI/VI TORNA
          /\bcome\s+(ti|vi|le)\s+(pare|sembra|torna|(?:va|viene)\s+(?:meglio|bene)|(?:[èeé]|e)\s+(?:più\s+)?comodo)\b/i,

          // 21. L'IMPORTANTE È / BASTA CHE
          /\b(l['']important[ee]\s+(?:[èeé]|e)|basta\s+che|purch[eéè]|l['']essential[ee]\s+(?:[èeé]|e))\s+((?:ci\s+)?sia|(?:ci\s+)?siano|si\s+(?:faccia|riesca)|venga\s+(?:fatto|fatta)|si\s+possa\s+(?:fare|venire))\b/i,

          // 22. VA BENE QUANDO VUOI/PUOI (forma completa)
          /\b(va\s+bene|[èeé]\s+ok|perfetto|d['']accordo)\s+quando\s+(vuoi|puoi|preferisci|riesci|(?:ti|vi|le)\s+(?:va|conviene|[èeé]\s+comodo))\b/i,

          // 23. TOTALE FLESSIBILITÀ / MASSIMA DISPONIBILITÀ
          /\b(totale|completa|massima|piena|assoluta)\s+(flessibilit[aàá]|disponibilit[aàá]|apertura)\b/i,

          // 24. NON HO IMPEGNI / SONO LIBERO
          /\b(non\s+ho|non\s+abbiamo|non\s+ci\s+sono)\s+(impegni|vincoli|(?:altri\s+)?appuntamenti|cose\s+particolari)\b/i,

          // 25. SONO LIBERO / SIAMO LIBERI (generico)
          /\b((?:sono|siamo)\s+liber[oiae]|ho\s+tempo|abbiamo\s+tempo)(?:\s+(?:(?:tutto|tutti)\s+(?:il\s+giorno|i\s+giorni)|sempre|praticamente\s+sempre|quasi\s+sempre))?\b/i,

          // 26. QUANDO VUOI / QUANDO VOLETE (standalone)
          /^quando\s+(vuoi|volete|preferisci|preferite|ti\s+(?:va|pare)|vi\s+(?:va|pare))\s*[!.?]?\s*$/i,

          // 27. COME VUOI / COME VOLETE (standalone)
          /^come\s+(vuoi|volete|preferisci|preferite|ti\s+(?:va|pare)|vi\s+(?:va|pare)|meglio\s+(?:credi|credete))\s*[!.?]?\s*$/i,

          // 28. OK PER ME QUALSIASI COSA
          /\b(ok|va\s+bene|perfetto|d['']accordo)\s+per\s+me\s+(qualsiasi\s+(?:cosa|giorno|orario)|tutto|sempre)\b/i,

          // 29. VARIANTI CON "CE" (senza apostrofo)
          /\bquando\s+ce\s+(posto|posti|disponibilit[aàá]|un\s+buco)\b/i,

          // 30. MI VA BENE / CI VA BENE + TUTTO/QUALSIASI
          /\b(mi|ci|ti|vi)\s+va\s+bene\s+(tutto|qualsiasi\s+(?:cosa|giorno|orario|momento)|quando\s+(?:vuoi|volete))\b/i,

          // 31. FAI/FATE/FACCIA COME CREDI / COME RITIENI (carta libera)
          /\b(?:fai|fate|faccia)\s+come\s+(?:credi|ritieni|preferisci|ti\s+pare)\b/i,

          // 32. A (TUA/VOSTRA/SUA) SCELTA / A SCELTA (TUA/VOSTRA/SUA)
          /\b(?:a|alla)\s+(?:tua|vostra|sua)\s+scelta\b/i,
          /\ba\s+scelta\s+(?:tua|vostra|sua)\b/i,

          // 33. CARTA BIANCA (anche “ti lascio carta bianca”)
          /\b(?:ti\s+|vi\s+)?(?:lascio|do|d[oò])\s+carta\s+bianca\b/i,
          /\bcarta\s+bianca\b/i,

          // 34. METTI/FISSA/PRENOTA NEL PRIMO BUCO / PRIMO SPAZIO
          /\b(?:metti|fissa|prenota|piazza)\s+(?:pure\s+)?(?:nel|al)\s+(?:primo|prima)\s+(?:buco|spazio|slot|posto)\b/i,
          /\bnel\s+(?:primo|prima)\s+(?:buco|spazio|slot|posto)\s+(?:che\s+trovi|che\s+c['’]?(?:è|e))\b/i,

          // 35. APPENA TROVI POSTO / APPENA SI LIBERA (varianti più “parlate”)
          /\bappena\s+(?:trovi|trovate|ha[iy]|avete)\s+(?:un\s+)?(?:posto|buco|slot|spazio)\b/i,
          /\bappena\s+si\s+(?:libera|apre)\s+(?:un\s+)?(?:posto|buco|slot|spazio)\b/i,

          // 36. QUANDO TI/VI È PIÙ FACILE/SEMPLICE / QUANDO RIESCI (senza “quando vuoi”)
          /\bquando\s+(?:ti|vi|le)\s+(?:[èeé]|e)\s+pi[uù]\s+(?:facile|semplice|comodo)\b/i,
          /\bquando\s+(?:ti|vi|le)\s+(?:riesce|riesci|riuscite)\s+(?:meglio|bene)\b/i,

          // 37. IN QUALSIASI FASCIA ORARIA / QUALUNQUE MOMENTO DELLA GIORNATA
          /\b(?:in|a)\s+(?:qualsiasi|qualunque)\s+(?:fascia\s+oraria|momento\s+della\s+giornata|orario|momento)\b/i,
          /\b(?:mattina|pomeriggio|sera)\s+indifferente\b/i,

          // 38. NON HO FRETTA / SENZA FRETTA (delegazione “soft”)
          /\b(?:non\s+ho\s+fretta|nessuna\s+fretta|senza\s+fretta|con\s+calma)\b/i,

          // 39. UNO/UNA QUALSIASI (orario/giorno/data/slot)
          /\b(?:uno|una)\s+(?:qualsiasi|qualunque)\s+(?:orario|giorno|data|slot|momento)\b/i,

          // 40. BOH/MAH + SCEGLI/DECIDI TU (messaggistica informale)
          /\b(?:boh|mah|non\s+so)\s*,?\s*(?:scegli|decidi|fai)\s+tu\b/i,

          // 41. DECIDA/SCELGA LEI (formale)
          /\b(?:decida|scelga|veda)\s+lei\b/i,

          // 42. ABBREVIAZIONI “X ME” / “PER ME” + OK/TUTTO/QUALSIASI
          /\b(?:x|per)\s+me\s+(?:ok|va\s+bene|perfetto)\s*(?:tutto|qualsiasi)?\b/i,
        ];

        const isDelegated = delegationPatterns.some(pattern => pattern.test(userInput));

        if (isDelegated && col?.service) {
          const hasOggi = /\boggi\b/i.test(userInput) && !/\bnon\s+oggi\b/i.test(userInput);
          const hasDomani = /\bdomani\b/i.test(userInput) && !/\bnon\s+domani\b/i.test(userInput);

          const candidates = [];

          // Base di ricerca: rispetta eventuale preferenza "settimana prossima / tra N settimane"
          const weekOffset = Number.isInteger(state?.context?.weekOffset) ? state.context.weekOffset : null;
          const relToday = /\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(userInput);

          const base = (() => {
            const d = new Date();
            d.setHours(12, 0, 0, 0);

            if (!relToday && weekOffset && weekOffset > 0) {
              const day = d.getDay(); // 0=dom, 1=lun...
              const diff = (day === 0 ? -6 : 1) - day; // lunedì settimana corrente
              d.setDate(d.getDate() + diff + weekOffset * 7);
              d.setHours(12, 0, 0, 0);
            }
            return d;
          })();

          // Caso tipico: "oggi o domani, dimmi tu"
          if (hasOggi) candidates.push(new Date(base));
          if (hasDomani) {
            const d = new Date(base);
            d.setDate(d.getDate() + 1);
            d.setHours(12, 0, 0, 0);
            candidates.push(d);
          }

          // Se non sono stati citati giorni specifici, prova "appena possibile" (fino a 14 giorni)
          if (!candidates.length) {
            for (let i = 0; i < 14; i++) {
              const d = new Date(base);
              d.setDate(d.getDate() + i);
              d.setHours(12, 0, 0, 0);
              candidates.push(d);
            }
          }

          const durationAuto = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
          const professionalAuto = col.professionalAny ? null : col.professionalEmail || col.professionalName || null;

          for (const candDay of candidates) {
            if (typeof cfgClosedDay === "function" && cfgClosedDay(candDay)) continue;

            const raw = await fetchSlots({
              service: col.service,
              day: candDay,
              duration: durationAuto,
              professional: professionalAuto,
              wantDetail: true,
            });

            let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(raw) : raw) || [];

            // Se oggi, elimina orari passati
            try {
              if (typeof filterOutPastTimesForToday === "function" && slots.length) {
                const allowed = filterOutPastTimesForToday(candDay, slots.map((x) => x.time));
                const set = new Set(allowed);
                slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
              }
            } catch (err) {
              log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
            }

            if (slots.length) {
              parsedDate = candDay;
              precomputedSlots = slots;
              break;
            }
          }
        }

        if (!parsedDate) {
          const weekOffset = Number.isInteger(state?.context?.weekOffset) ? state.context.weekOffset : null;
          const relToday = /\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(userInput);

          const baseForWeek = (!relToday && weekOffset && weekOffset > 0 && !/\b(?:tra|fra)\s+\d{1,2}\s+settimane?\b/i.test(userInput))
            ? (() => {
              const d0 = new Date();
              d0.setHours(12, 0, 0, 0);
              const day = d0.getDay();
              const diff = (day === 0 ? -6 : 1) - day; // lunedì corrente
              d0.setDate(d0.getDate() + diff + weekOffset * 7);
              d0.setHours(12, 0, 0, 0);
              return d0;
            })()
            : null;

          parsedDate = safeParseDateWithLock(chatId, userInput, baseForWeek);
        }
      } finally {
        __dateParsingLocks.delete(chatId);
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) {
        // Se l'utente ha scritto un TRATTAMENTO invece di una data (es. "refill gel mani"),
        // aggiorna il servizio e richiedi di nuovo il giorno.
        let maybeSvc = null;
        try {
          maybeSvc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(userInput) : null) || null;
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        if (maybeSvc) {
          col.service = maybeSvc;
          col.when = null;
          col.time = null;
          col.options = null;
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(client, chatId, `Perfetto! Ho impostato il trattamento: *${maybeSvc}*.\nOra dimmi che giorno preferisci (es. "domani", "23/10").`);
          return "";
        }

        await reply(client, chatId, `🤔 Non ho capito la data.
Prova a scrivere per esempio: *"domani"*, *"lunedì"* oppure una data, tipo: "*15 dicembre*". Se non sai cosa scegliere scrivi: *"scegli tu"* e ti scegliero la prima data disponibile.`);
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

      // 🆕 Se nello stesso messaggio c'era anche un orario ("... alle 16"), memorizzalo
      try {
        const pref =
          (typeof parseTimeSmart === "function" ? parseTimeSmart(userInput) : null) ||
          (typeof parseHHMM === "function" ? parseHHMM(userInput) : null);
        if (pref) col._preferredTime = pref;
      } catch { }

      // Recupera slot disponibili
      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalAny ? null : col.professionalEmail || col.professionalName || null;

      let slots = precomputedSlots;

      if (!Array.isArray(slots) || !slots.length) {
        const rawList = await fetchSlots({
          service: col.service,
          day: day,
          duration,
          professional,
          wantDetail: true,
        });

        slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];
      }

      // Se oggi, elimina orari passati (coerente anche quando non si usa l'auto-scelta)
      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(day, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(day)
          : day.toLocaleDateString();

        col.when = null;
        state.step = "choose_day";
        await reply(client, chatId, `Nessun orario libero per ${dayStr} 😔
Vuoi provare un altro giorno?`);
        return "";
      }

      col.options = slots;

      // 🆕 Fast-path: se l'orario richiesto è disponibile, selezionalo e prosegui
      if (col._preferredTime && /^\d{2}:\d{2}$/.test(col._preferredTime)) {
        const wanted = col._preferredTime;
        const okSlot = slots.find((s) => s && s.time === wanted);
        if (okSlot) {
          col.time = wanted;
          state.step = "pick_time";
          pending.set(chatId, state);

          if (typeof scheduleReenter === "function") {
            await scheduleReenter(client, chatId, `ok ${wanted}`, tools);
            return "";
          }
        }
      }

      state.step = "pick_time"; // options dovrebbero essere già settate;

      ensureContext(state);
      state.context.availOffset = 0;
      state.context.availFilterPart = null;

      const msgOut = buildAvailabilityCompactMessage(day, slots, { offset: 0, pageSize: AVAIL_PAGE_SIZE });

      pending.set(chatId, state);
      await reply(client, chatId, msgOut);
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
      state.step === "pick_time" &&
      (!col.time || state.step === "pick_time") &&
      !(typeof state.step === "string" && state.step.startsWith("edit_"))
    ) {
      state.step = "pick_time";

      // Nota UX: permettiamo di scegliere l'orario anche prima del nome.
      // Il nome verrà comunque richiesto esplicitamente prima della conferma finale.

      // Guard: se manca il giorno o gli slot, torna a chiedere la data
      if (!col.when || !Array.isArray(col.options) || !col.options.length) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(
          client,
          chatId,
          `Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`
        );
        return "";
      }

      // Safety: stato incoerente → riparti dal punto giusto (evita "Disponibilità per :" vuoto)
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Perfetto! Dimmi che trattamento vuoi prenotare 😊");
        return "";
      }
      if (!col.when || !Array.isArray(col.options) || col.options.length === 0) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Che giorno preferisci? (es. "domani", "lunedì prossimo", "23/10")');
        return "";
      }

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

      const cleanedForTime = String(msg || "")
        .replace(/\b(verso|intorno|circa|per\s+le|alle|ore)\b/gi, " ")
        .replace(/[^\d:\.\s]/g, " ")
        .trim();
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
            `Nessun orario libero per ${dayStr} 😔
Vuoi provare un altro giorno?`
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
        const _daySwitchLower = _daySwitchText.toLowerCase();

        // Se sembra un ORARIO (es. 12.30), non interpretarlo come data
        if (/(?:^|\b)(?:alle\s*)?(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d\b/.test(_daySwitchLower)) return false;

        // Richiesta generica di cambiare giorno senza specificare la data
        // (NB: "quando riesci/puoi" qui viene trattato come delega dell'ORARIO, non come cambio giorno)
        if (
          /\b(un'?altr[oa]|altro)\s+(giorn\w*|data)\b/.test(_daySwitchLower) ||
          /\bnon\s+posso\b/.test(_daySwitchLower)
        ) {
          state.step = "choose_day";
          pending.set(chatId, state);
          await reply(
            client,
            chatId,
            'Ok 😊 Dimmi che giorno preferisci (es. "domani", "sabato", "10/01").'
          );
          return true;
        }

        const _hasDayNumberCue =
          /\b(?:il|giorno|data|per\s+il)\s+\d{1,2}(?:\s*(?:°|º))?\b/i.test(_daySwitchText);
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

        ensureContext(state);
        state.context.availOffset = 0;
        state.context.availFilterPart = null;

        const msgOut = buildAvailabilityCompactMessage(col.when, col.options, { offset: 0, pageSize: AVAIL_PAGE_SIZE });

        pending.set(chatId, state);
        await reply(client, chatId, msgOut);

        return true;
      }

      const handledDaySwitch = await tryHandleDaySwitch(rawMsg);
      if (handledDaySwitch) return "";

      // Comandi rapidi sugli orari (max 5 per messaggio)
      if (/^\s*altri\s*$/i.test(rawMsg)) {
        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const items = uniqueTimesFromSlots(list);


        const cur = Math.max(0, Number(state.context.availOffset || 0) || 0);
        const next = (cur + AVAIL_PAGE_SIZE >= items.length) ? 0 : (cur + AVAIL_PAGE_SIZE);

        state.context.availOffset = next;
        pending.set(chatId, state);

        await reply(client, chatId, buildAvailabilityCompactMessage(col.when, list, { offset: next, pageSize: AVAIL_PAGE_SIZE }));
        return "";
      }

      const _mPart = rawMsg.trim().match(/^(mattina|pomeriggio|sera)$/i);
      if (_mPart) {
        ensureContext(state);
        state.context.availFilterPart = _mPart[1].toLowerCase();
        state.context.availOffset = 0;

        const list = filterSlotsByDaypart(col.options, state.context.availFilterPart);
        pending.set(chatId, state);

        await reply(client, chatId, buildAvailabilityCompactMessage(col.when, list, { offset: 0, pageSize: AVAIL_PAGE_SIZE }));
        return "";
      }

      // 🆕 Se la fascia è dentro una frase (es. "quando vuoi tu, pomeriggio"), memorizzala comunque
      const __partHint = rawMsg.match(/\b(mattina|pomeriggio|sera)\b/i)?.[1]?.toLowerCase() || null;
      if (__partHint) {
        ensureContext(state);
        state.context.availFilterPart = __partHint;
      }

      // Parsing orario
      const isDelegatedTime = [

        /\b(dimmi|scegli|decidi|fai)\s+tu\b/i,
        /\bcome\s+(vuoi|preferisci|ti\s+pare|meglio\s+credi)\b/i,
        /\bquando\s+(?:vuoi|preferisci|puoi|riesci|sei\s+liber\w*|avrai\s+tempo)\b/i,
        /\b(primo|prima)\s+(orario|slot)\s+disponibile\b/i,
        /\b(appena|il\s+prima)\s+possibile\b/i,
      ].some((re) => re.test(rawMsg));

      // Supporta opzioni sia come stringhe ("10:00") sia come oggetti ({time:"10:00", pros:[...]})
      const __slotTime = (x) => (typeof x === "string" ? x : (x && x.time) ? x.time : null);

      let tParsed = null;
      if (isDelegatedTime && Array.isArray(col.options) && col.options.length) {
        const part = state?.context?.availFilterPart || null;
        const baseList = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const listForPick = (Array.isArray(baseList) && baseList.length) ? baseList : col.options;

        const sorted = [...listForPick].sort((a, b) => {

          const ta = __slotTime(a);
          const tb = __slotTime(b);
          return (hhmmToMin(ta) ?? 0) - (hhmmToMin(tb) ?? 0);
        });

        // ✅ Se la data è "oggi", scegli il primo slot NON nel passato (con un piccolo margine)
        const now = new Date();
        const day0 = (typeof atNoon === "function" && col.when) ? atNoon(col.when) : col.when;
        const isToday =
          day0 &&
          !isNaN(new Date(day0).getTime()) &&
          new Date(day0).toDateString() === now.toDateString();

        let picked = null;
        if (isToday) {
          const marginMs = 2 * 60 * 1000; // 2 minuti
          for (const s of sorted) {
            const hhmm = __slotTime(s);
            if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) continue;
            const d = new Date(day0);
            d.setHours(+hhmm.slice(0, 2), +hhmm.slice(3, 5), 0, 0);
            if (d.getTime() >= now.getTime() + marginMs) {
              picked = s;
              break;
            }
          }
        }

        tParsed = __slotTime(picked || sorted[0]) || null;
      } else {
        tParsed = tryParseTime();
      }

      if (!tParsed || !/^\d{2}:\d{2}$/.test(tParsed)) {
        log('warn', '[PICK_TIME] Orario non valido', { input: msg, parsed: tParsed });

        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;
        const offset = Math.max(0, Number(state.context.availOffset || 0) || 0);
        const availMsg = buildAvailabilityCompactMessage(col.when, list, { offset, pageSize: AVAIL_PAGE_SIZE });

        await reply(client, chatId, `Non ho capito l'orario.\n${availMsg}`);
        pending.set(chatId, state);
        return "";
      }

      // Match esatto orario
      let chosenSlot = col.options.find((s) => __slotTime(s) === tParsed);

      if (!chosenSlot) {
        // 1) Disambiguazione 12h (es. "alle 3" -> potrebbe voler dire 15:00)
        try {
          const hh = parseInt(String(tParsed).slice(0, 2), 10);
          const mm = String(tParsed).slice(3, 5);
          if (Number.isFinite(hh) && hh >= 0 && hh <= 7) {
            const alt = String((hh + 12) % 24).padStart(2, "0") + ":" + mm;
            const altSlot = col.options.find((s) => __slotTime(s) === alt);
            if (altSlot) {
              ensureContext(state);
              await reply(
                client,
                chatId,
                `Intendi *${alt}*? 🙂\nSe sì scrivi *${alt}* (oppure scegli un altro orario dalla lista).`,
                { noFooter: true }
              );
              pending.set(chatId, state);
              return "";
            }
          }
        } catch { }

        // 2) Niente snap silenzioso: proponi orari vicini e fai scegliere
        ensureContext(state);
        const part = state.context.availFilterPart || null;
        const list = part ? filterSlotsByDaypart(col.options, part) : col.options;

        const times =
          (typeof uniqueTimesFromSlots === "function")
            ? uniqueTimesFromSlots(list)
            : (list || []).map((s) => __slotTime(s)).filter(Boolean);

        const near = (typeof nearestTimes === "function")
          ? nearestTimes(times, tParsed, 3)
          : [];

        const availMsg = buildAvailabilityCompactMessage(col.when, list, { offset: 0, pageSize: AVAIL_PAGE_SIZE });

        if (near && near.length) {
          await reply(
            client,
            chatId,
            `Non abbiamo *${tParsed}* tra gli orari disponibili.\nOrari vicini:\n${near.map((t) => `• ${t}`).join("\n")}\n\nScrivi un orario (es. *${near[0]}*).\n\n${availMsg}`,
            { noFooter: true }
          );
        } else {
          await reply(client, chatId, `Orario non disponibile.\n${availMsg}`, { noFooter: true });
        }

        pending.set(chatId, state);
        return "";
      }


      col.time = __slotTime(chosenSlot);

      // Risoluzione professionista
      const ensureProFromSlot = async () => {
        const __pros =
          (chosenSlot && typeof chosenSlot === "object" && Array.isArray(chosenSlot.pros))
            ? chosenSlot.pros
            : [];

        // Nessun professionista associato allo slot
        if (__pros.length === 0) return "none";

        // Se nello slot c'è un solo professionista, selezionalo automaticamente
        if (__pros.length === 1) {
          const only = __pros[0];
          col.professionalName = only.name;
          col.professionalEmail = only.email || resolveEmailByName(only.name) || null;
          col.professionalAny = false;
          return "one";
        }

        // Pro estratto dal testo (nome/sinonimi) tra quelli disponibili nello slot
        const pick = extractProFromText(msg, __pros);
        if (pick) {
          col.professionalName = pick.name;
          col.professionalEmail = pick.email || resolveEmailByName(pick.name) || null;
          col.professionalAny = false;
          return "one";
        }

        // L'utente dice "chiunque / non importa"
        if (anyRe.test(msg)) {
          col.professionalAny = true;
          col.professionalName = null;
          col.professionalEmail = null;
          return "any";
        }

        // Altrimenti chiedi quale preferisce
        col.proOptions = __pros.slice();
        state.step = "pick_professional_for_time";

        const prosList = __pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n");

        await reply(
          client,
          chatId,
          `Chi preferisci alle ${__slotTime(chosenSlot)}?\n${prosList}\nRispondi con un numero (1-${__pros.length}).`
        );

        pending.set(chatId, state);
        return "ask";
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
          } catch (err) {
            log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
          }
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

      // Prosegui al prossimo step (il nome va sempre richiesto esplicitamente, ma non duplicarlo)
      const __nameValidNow =
        !!state.context?.nameConfirmed &&
        col.customerName &&
        String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

      if (!__nameValidNow) {
        state.step = "collect_name";
        ensureContext(state);
        state.context.awaitingName = true;   // ✅ chiediamo subito il nome
        state.context.nameConfirmed = false;
        pending.set(chatId, state);

        // ✅ IMPORTANTISSIMO: rispondi subito e NON usare "fai tu" come possibile nome
        await reply(
          client,
          chatId,
          'Perfetto 😊 Per completare la prenotazione scrivi *nome e cognome* (es. "Maria Rossi").',
          { noFooter: true }
        );
        return "";
      } else {
        pending.set(chatId, state);
      }

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
        state.step = "collect_name"; // resta qui finché non ricevo nome e cognome
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

      // ✅ Safety: senza trattamento non confermare mai la prenotazione
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        await reply(client, chatId, "Prima dimmi che trattamento vuoi prenotare 😊", { noFooter: true });
        return "";
      }

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
          await reply(client, chatId, `🤔 Non ho capito la data.
Prova così: domani • lunedì • 15 dicembre`);
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
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

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
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }

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
            await reply(client, chatId, `Spiacente, non abbiamo posto per ${dayStr}. Dimmi un altro giorno.`);
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
              `${dayStr} all'orario che hai richiesto siamo pieni. Questi sono gli orari liberi per tutta la giornata:\n${lines}\n\n💬 Scrivi l'orario desiderato (es. "14:30").`
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
        col.customerName = col.customerName || null // ✅ FIX Bug #10;
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
        await reply(client, chatId, showEditMenu(booking), { noFooter: true });
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
          const availMsg = buildAvailabilityCompactMessage(col.when, col.options, { offset: 0, pageSize: AVAIL_PAGE_SIZE });
          await reply(client, chatId, availMsg);
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
          // ✅ l'utente NON ha scelto un pro: resta "Non mi interessa"
          // (salvo solo internamente l'email per creare evento)
          col._autoProEmail = email;
          col.professionalAny = true;
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

        holdOk = await acquireSoftHold({
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
      const proLine = (!col.professionalAny && col.professionalName) ? ` con ${col.professionalName}` : "";
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
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
        }
        return "";
      }
    }

    // ✅ HARD CHECK: evita doppie prenotazioni (booking già presente) ignorando il nostro hold
    try {
      const sMs = start instanceof Date ? start.getTime() : new Date(start).getTime();
      const eMs = sMs + (Number(durationMin) || 0) * 60_000;
      if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
        if (slotOverlapsExistingBookings(proEmail, sMs, eMs, { ignoreChatId: chatId })) {
          try { releaseSoftHoldByChat?.(chatId); } catch { }
          await reply(client, chatId, "Quel posto è appena stato occupato 😕. Scegli un altro orario o un altro giorno.");
          // Rimani nel flow di scelta orario
          col.time = null;
          state.step = "pick_time";
          pending.set(chatId, state);
          return "";
        }
      }
    } catch (hardCheckErr) {
      log('warn', '[BOOKING] Hard-check overlap fallito (ignorato)', { chatId, err: hardCheckErr?.message });
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

      const __startMs = (start instanceof Date ? start.getTime() : new Date(start).getTime());
      const __endMs = __startMs + (Number(durationMin) || 30) * 60_000;

      const bookingRecord = {
        eventId: ev?.id || ev?.eventId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        service: col.service,
        professionalName: col.professionalName || null,
        professionalEmail: proEmail || null,
        clientPhone: phone,
        clientChatId: chatId,
        customerName: col.customerName || null,

        // ✅ campi robusti per availability/overlap
        startTime: new Date(__startMs).toISOString(),
        startMs: __startMs,
        endMs: __endMs,
        endTime: new Date(__endMs).toISOString(),

        durationMin,
        status: "confirmed",
        createdAt: new Date().toISOString(),
      };

      // Implementare saveBooking se necessario
      const okSaved = await persistBooking(bookingRecord);
      if (!okSaved) {
        throw new Error("Salvataggio su database fallito");
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

    // Reset conversazione ma preserva contesto utile (es. "uguale")
    try {
      const prevCtx = (state && state.context) ? state.context : {};
      pending.set(chatId, {
        step: "collect",
        collected: {
          service: null,
          when: null,
          time: null,
          professionalAny: true,
          professionalName: null,
          professionalEmail: null,
          customerName: null,
          options: [],
          proOptions: null,
          daypartWindow: null,
          infoOptions: null,
        },
        context: {
          ...prevCtx,
          lastService: col.service || prevCtx.lastService || null,
          lastProfessionalEmail: proEmail || prevCtx.lastProfessionalEmail || null,
          lastProfessionalName: (col.professionalName || prevCtx.lastProfessionalName || null),
        },
      });
    } catch {
      pending.delete(chatId);
    }
    __dateParsingLocks.delete(chatId);

    // Messaggio di conferma
    const hh = String(start.getHours()).padStart(2, "0");
    const mi = String(start.getMinutes()).padStart(2, "0");
    const proLine = (!col.professionalAny && col.professionalName) ? ` con ${col.professionalName}` : "";

    const tmpBooking = {
      startTime: start,
      service: col.service,
      professionalName: col.professionalName || null,
      professionalEmail: proEmail || null,
      customerName: col.customerName || null,
    };
    const line =
      typeof _fmtBookingLine === "function"
        ? _fmtBookingLine(tmpBooking)
        : `${col.service}${proLine} ${formatDateWithWeekdayIT(start)} alle ${hh}:${mi}.`;

    await reply(
      client,
      chatId,
      `✅ Prenotazione confermata!\n➡️ *${line}*\n\n✏️ Per spostare o cancellare: scrivi *modifica*.`,
      { noFooter: true }
    );

    return "";

  } catch (e) {
    const code = `BKG-${Math.floor(100 + Math.random() * 900)}`;

    log("error", "handleMessage critical error", {
      code,
      err: String(e?.stack || e?.message || e),
      chatId,
      step: state?.step,
    });

    // Cleanup forzato su errore critico
    try {
      pending.delete(chatId);
      __dateParsingLocks.delete(chatId);
      releaseSoftHoldByChat?.(chatId);
    } catch (cleanupErr) {
      log("warn", "[CLEANUP] Errore durante cleanup critico", { err: cleanupErr?.message, code });
    }

    try {
      await reply(client, chatId, `😵‍💫 Ops, ho avuto un intoppo tecnico. Riprova tra poco. (codice: ${code})`, { noFooter: true });
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

  // --- REVIEW INTAKE: menu "Ho rilevato questi dati" ---
  if (state.step === "review_intake") {
    try { ensureContext(state); } catch { }
    const map = state?.context?.reviewIntakeMap || null;
    const prompt = state?.context?.reviewIntakeMsg || null;

    const raw = String(msg || "").trim();
    const low = raw.toLowerCase();

    const clearReview = () => {
      try {
        ensureContext(state);
        state.context.reviewIntakeMap = null;
        state.context.reviewIntakeMsg = null;
      } catch { }
    };

    const cancelNow = () => {
      try { if (state) unlockBooking(state); } catch { }
      try { pending.delete(chatId); } catch { }
      try { releaseSoftHoldByChat(chatId); } catch { }
    };

    const wantsCancel =
      /^\s*0\s*[\).]?\s*$/.test(raw) ||
      /^(annulla|annula|cancel|stop|fine|esci)\b/i.test(low);

    if (wantsCancel) {
      clearReview();
      cancelNow();
      await reply(client, chatId, '✅ Operazione annullata. Se vuoi ricominciare, scrivi "prenota" o "appuntamento".', { noFooter: true });
      return "";
    }

    let action = null;

    // 🆕 Entity extractor: se nel testo libero ci sono info (servizio / pro / data / orario),
    // aggiorna gli slot e prosegui come se l'utente avesse scelto "continua".
    const ent = (typeof extractReviewEntities === "function") ? extractReviewEntities(chatId, raw) : null;
    if (ent) {
      try { ensureContext(state); } catch { }

      // servizio
      if (ent.service) {
        col.service = ent.service;
        col.serviceCandidates = null;
        col.options = null;
        col.time = null;
      }

      // professionista
      if (typeof ent.professionalAny === "boolean") {
        col.professionalAny = ent.professionalAny;
        if (ent.professionalAny) {
          col.professionalEmail = null;
          col.professionalName = null;
        }
      }
      if (ent.professionalEmail || ent.professionalName) {
        col.professionalAny = false;
        if (ent.professionalName) col.professionalName = ent.professionalName;
        if (ent.professionalEmail) col.professionalEmail = ent.professionalEmail;
        if (!ent.professionalEmail && ent.professionalName && typeof proEmailByName === "function") {
          try { col.professionalEmail = proEmailByName(ent.professionalName) || col.professionalEmail || null; } catch { }
        }
        col.options = null;
        col.time = null;
      }

      // data
      if (ent.when) {
        col.when = ent.when;
        col.options = null;
        col.time = null;
      }

      // orario (preferenza)
      if (ent.time) {
        try {
          ensureContext(state);
          state.context.preferredTime = ent.time;
        } catch { }
        col._preferredTime = ent.time;
        col.time = null;
      }

      // Se (servizio, professionista) incompatibili, ripulisci lo slot che crea conflitto
      try {
        if (!col.professionalAny && col.professionalEmail && col.service && typeof validateProfessionalForService === "function") {
          const chk = validateProfessionalForService(col.service, col.professionalEmail);
          if (chk && chk.ok === false) {
            // L'utente ha indicato un pro: meglio chiedere di cambiare trattamento (lista filtrata)
            col.service = null;
            col.options = null;
            col.time = null;
          }
        }
      } catch { }

      setAndPersist();

      // ✅ Feedback immediato: aggiorna "Ho capito così" quando l'utente scrive info spezzettate
      try {
        const built = buildReviewIntakePrompt(col);
        ensureContext(state);
        state.context.reviewIntakeMap = built.map;
        state.context.reviewIntakeMsg = built.msg;
        pending.set(chatId, state);
        await reply(client, chatId, built.msg, { noFooter: true });
        return "";
      } catch {
        // fallback: se qualcosa va storto, continua come prima
        action = "continue";
      }

    }

    const wantsContinueWord =
      /^\s*(?:✅\s*)?(continua|ok(?:ay)?|va\s*bene(?:\s*cos[iì])?|va\s*benissimo|benissimo|perfetto|d['’]accordo|conferma|confermo|confermare|avanti|procedi|prosegui|vai|si|sì|yes)\b/i.test(low);

    if (!action && wantsContinueWord) {
      action = "continue";
    } else if (!action && pureNumber.test(raw) && map) {
      const m = raw.match(/^\s*(\d+)/);
      const key = m ? String(m[1]) : null;
      action = key && map[key] ? map[key] : null;
    }

    if (!action) {
      const intent = (typeof resolveReviewMenuIntent === "function") ? resolveReviewMenuIntent(raw) : null;
      if (intent) action = intent;
    }

    if (!action) {
      await reply(client, chatId, prompt || "Scegli un'opzione valida dal menu (oppure 0 per annullare).", { noFooter: true });
      return "";
    }

    // helper: mostra lista professionisti (step pick_professional)
    const showProsList = async () => {
      const pros = getAllProsList();
      if (!pros.length) {
        state.step = "collect";
        clearReview();
        pending.set(chatId, state);
        await reply(client, chatId, "⚠️ Nessun professionista configurato. Contatta il salone.", { noFooter: true });
        return "";
      }

      const list =
        `💅 Prima di tutto scegli *con chi vuoi effettuare il trattamento*:\n` +
        `0) Non mi interessa\n` +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
        `\n(0-${pros.length})`;

      pending.set(chatId, state);
      await reply(client, chatId, list, { noFooter: true });
      return "";
    };

    // helper: mostra lista servizi (step choose_service)
    const showServicesList = async () => {
      const proEmail =
        col.professionalAny
          ? null
          : (col.professionalEmail ||
            (typeof proEmailByName === "function" ? proEmailByName(col.professionalName) : null) ||
            null);

      const { available, msg: svcMsg } = buildServicesMessageForPro(proEmail);
      col.serviceOptions = available;
      col.svcOptions = available;
      try { ensureUI(state); state.ui.lastServiceList = available; } catch { }
      pending.set(chatId, state);
      await reply(client, chatId, svcMsg, { noFooter: true });
      return "";
    };

    // helper: mostra disponibilità orari (step pick_time)
    const showPickTime = async () => {
      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        return await showServicesList();
      }
      if (!col.when) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23/10")', { noFooter: true });
        return "";
      }

      const professional = col.professionalAny ? null : (col.professionalEmail || col.professionalName || null);
      const duration = (typeof getDurForPro === "function")
        ? getDurForPro(col.service, (col.professionalAny ? null : col.professionalEmail))
        : ((typeof cfgServiceDuration === "function" ? (cfgServiceDuration(col.service) || 30) : 30));

      const rawList = await fetchSlots({
        service: col.service,
        day: typeof atNoon === "function" ? atNoon(col.when) : col.when,
        duration,
        professional,
        wantDetail: true,
      });

      let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(col.when, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) });
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(col.when)
          : (col.when?.toLocaleDateString?.() || "");
        col.when = null;
        col.time = null;
        col.options = null;
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, `Nessun orario libero per ${dayStr} 😔\nVuoi provare un altro giorno?`, { noFooter: true });
        return "";
      }

      col.options = slots;
      col.time = null;
      state.step = "pick_time";
      try {
        ensureContext(state);
        state.context.availOffset = 0;
        state.context.availFilterPart = null;
      } catch { }

      pending.set(chatId, state);
      const msgOut = buildAvailabilityCompactMessage(col.when, slots, { offset: 0, pageSize: AVAIL_PAGE_SIZE });
      await reply(client, chatId, msgOut, { noFooter: true });
      return "";
    };

    // ---- azioni menu ----
    if (action === "edit_service") {
      clearReview();
      col.service = null;
      col.serviceCandidates = null;
      col.time = null;
      col.options = null;
      state.step = "choose_service";
      pending.set(chatId, state);
      return await showServicesList();
    }

    if (action === "edit_professional") {
      clearReview();
      col.professionalAny = false;
      col.professionalName = null;
      col.professionalEmail = null;
      col.time = null;
      col.options = null;
      state.step = "pick_professional";
      pending.set(chatId, state);
      return await showProsList();
    }

    if (action === "edit_when") {
      clearReview();
      col.when = null;
      col.time = null;
      col.options = null;
      state.step = "choose_day";
      pending.set(chatId, state);
      await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23/10")', { noFooter: true });
      return "";
    }

    if (action === "edit_time") {
      clearReview();
      col.time = null;
      col.options = null;
      state.step = "pick_time";
      pending.set(chatId, state);
      return await showPickTime();
    }

    // continue
    if (action === "continue") {
      clearReview();

      const needPro = (!col.professionalAny && !col.professionalName && !col.professionalEmail);
      if (needPro) {
        state.step = "pick_professional";
        pending.set(chatId, state);
        return await showProsList();
      }

      if (!col.service) {
        state.step = "choose_service";
        pending.set(chatId, state);
        return await showServicesList();
      }

      if (!col.when) {
        state.step = "choose_day";
        pending.set(chatId, state);
        await reply(client, chatId, 'Perfetto! Che giorno preferisci? (es. "domani", "lunedì prossimo", "23/10")', { noFooter: true });
        return "";
      }

      if (!col.time) {
        state.step = "pick_time";
        pending.set(chatId, state);
        return await showPickTime();
      }

      // se abbiamo già tutto, chiedi nome (o finalizza se già ok)
      const nameOk =
        !!state.context?.nameConfirmed &&
        col.customerName &&
        String(col.customerName).trim().split(/\s+/).filter(Boolean).length >= 2;

      if (!nameOk) {
        state.step = "collect_name";
        try {
          ensureContext(state);
          state.context.awaitingName = true;
          state.context.nameConfirmed = false;
        } catch { }
        pending.set(chatId, state);

        await reply(
          client,
          chatId,
          'Perfetto 😊 Per completare la prenotazione scrivi *nome e cognome* (es. "Maria Rossi").',
          { noFooter: true }
        );
        return "";
      }

      state.step = "finalize_booking";
      pending.set(chatId, state);
      if (typeof scheduleReenter === "function") {
        await scheduleReenter(client, chatId, "ok", tools);
      }
      return "";
    }

    await reply(client, chatId, prompt || "Scegli un'opzione valida dal menu (oppure 0 per annullare).", { noFooter: true });
    return "";
  }

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

  // ==== CONFERMA SERVIZIO (ambiguità da testo libero) ====
  if (state.step === "confirm_service") {
    const opts = Array.isArray(col.serviceCandidates) ? col.serviceCandidates : [];
    if (!opts.length) {
      state.step = "collect";
      pending.set(chatId, state);
      return safeSend(client, chatId, 'Sessione scaduta. Scrivi di nuovo il trattamento (es. "refill gel").');
    }

    if (!pureNumber.test(String(msg || "").trim())) {
      return safeSend(client, chatId, `Scegli un numero valido (1-${opts.length}).`);
    }

    const n = parseListIndex(msg, opts.length);
    if (!Number.isFinite(n) || n < 1 || n > opts.length) {
      return safeSend(client, chatId, `Scegli un numero valido (1-${opts.length}).`);
    }

    const chosen = opts[n - 1];
    col.service = typeof chosen === "string" ? chosen : String(chosen);

    // pulizia
    col.serviceCandidates = null;

    // Prosegui col flusso normale: prima professionista, poi giorno
    // ✅ DEFAULT: se l'utente non ha specificato un pro, è come "Non mi interessa"
    if (!col.professionalName && !col.professionalEmail && col.professionalAny !== true) {
      col.professionalAny = true;
    }

    if (!col.professionalAny && !col.professionalName && !col.professionalEmail) {
      state.step = "pick_professional";
      pending.set(chatId, state);

      const pros = Object.entries(config?.professionals || {}).map(([email, p]) => ({
        email,
        name: (p?.name) || email,
      }));

      if (!pros.length) {
        return safeSend(client, chatId, "⚠️ Nessun professionista configurato. Contatta il salone.");
      }

      const list =
        `👩‍🔧 Prima scegli il professionista:\n` +
        `0) Non mi interessa\n` +
        pros.map((p, i) => `${i + 1}) ${p.name}`).join("\n") +
        `\n(0-${pros.length})`;

      await reply(client, chatId, list);
      return "";
    }

    // Se l'utente ha già indicato la data (fast-path), non chiedere di nuovo: mostra direttamente gli slot
    if (col.when instanceof Date) {
      const day = col.when;

      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day,
        duration,
        professional,
        wantDetail: true,
      });

      let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      // Se oggi, elimina orari passati (coerente con lo step choose_day)
      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(day, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(day)
          : day.toLocaleDateString();

        col.when = null;
        state.step = "choose_day";
        await reply(client, chatId, `Nessun orario libero per ${dayStr} 😔
Vuoi provare un altro giorno?`);
        return "";
      }

      col.options = slots;
      state.step = "pick_time";

      const availMsg = buildAvailabilityCompactMessage(day, slots, { offset: 0, pageSize: AVAIL_PAGE_SIZE });
      await reply(client, chatId, availMsg);

      pending.set(chatId, state);
      return "";
    }

    state.step = "choose_day"; // data non ancora indicata
    pending.set(chatId, state);

    await reply(
      client,
      chatId,
      `Che giorno preferisci? (es. "domani", "lunedì prossimo", "tra 2 giorni", "23/10", "28 ottobre")`
    );
    return "";
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
      Array.isArray(col.svcOptions) ? col.svcOptions : null, // <- aggiunto (tuo nome)
      Array.isArray(col.serviceOptions) ? col.serviceOptions : null, // <- legacy
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

    // Se l'utente ha già indicato la data (fast-path), non chiedere di nuovo: mostra direttamente gli slot
    if (col.when instanceof Date) {
      const day = col.when;

      const duration = typeof cfgServiceDuration === "function" ? cfgServiceDuration(col.service) || 30 : 30;
      const professional = col.professionalEmail || col.professionalName || null;

      const rawList = await fetchSlots({
        service: col.service,
        day,
        duration,
        professional,
        wantDetail: true,
      });

      let slots = (typeof normalizeSlotsDetail === "function" ? normalizeSlotsDetail(rawList) : rawList) || [];

      // Se oggi, elimina orari passati (coerente con lo step choose_day)
      try {
        if (typeof filterOutPastTimesForToday === "function" && slots.length) {
          const allowed = filterOutPastTimesForToday(day, slots.map((x) => x.time));
          const set = new Set(allowed);
          slots = slots.filter((x) => set.has(x.time)).sort((a, b) => compareHHMM(a.time, b.time));
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      if (!slots.length) {
        const dayStr = typeof formatDateWithWeekdayIT === "function"
          ? formatDateWithWeekdayIT(day)
          : day.toLocaleDateString();

        col.when = null;
        state.step = "choose_day";
        await reply(client, chatId, `Nessun orario libero per ${dayStr} 😔
Vuoi provare un altro giorno?`);
        return "";
      }

      col.options = slots;
      state.step = "pick_time";

      const availMsg = buildAvailabilityCompactMessage(day, slots, { offset: 0, pageSize: AVAIL_PAGE_SIZE });
      await reply(client, chatId, availMsg);

      pending.set(chatId, state);
      return "";
    }

    state.step = "choose_day"; // data non ancora indicata
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

    // ✅ UX: uscita rapida dalla selezione
    if (/b(annulla|esci|stop|chiudi)b/i.test(String(msg || ""))) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Ok 👍 \n Quando vuoi: scrivi "prenota" per fissare un appuntamento oppure "modifica" per gestirne uno esistente.',
        { noFooter: true }
      );
    }

    let n = parseListIndex(msg, list.length);

    // 🆕 Permetti selezione anche scrivendo il trattamento (es. "ceretta", "ceretta alle 09", "alle 18")
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      const m =
        typeof pickBookingMatchFromFreeText === "function"
          ? pickBookingMatchFromFreeText(msg, list)
          : null;

      if (m && m.kind === "hit" && Number.isFinite(m.idx)) {
        n = m.idx + 1;
      } else if (
        m &&
        m.kind === "ambiguous" &&
        Array.isArray(m.candidates) &&
        m.candidates.length
      ) {
        const lines = m.candidates
          .map((idx) => {
            const b = list[idx];
            const line =
              typeof _fmtBookingLine === "function"
                ? _fmtBookingLine(b)
                : String(b?.service || b?.serviceName || "Prenotazione");
            return `*${idx + 1})* ${line}`;
          })
          .join("\n");

        return reply(
          client,
          chatId,
          `Ho trovato più prenotazioni che combaciano con "${String(msg).trim()}":
${lines}

Scrivi il numero (1-${list.length}).`
        );
      }
    }

    // Permetti selezione anche scrivendo una data (es. "27 gennaio", "27/01", "27-01-2026")
    if (!Number.isFinite(n) || n < 1 || n > list.length) {
      let pickedByDate = null;
      try {
        const parsed = safeParseDateWithLock(chatId, msg);
        if (parsed && !isNaN(parsed.getTime())) {
          const d = parsed.getDate();
          const m = parsed.getMonth();
          const y = parsed.getFullYear();
          const hasYear = /\b(19|20)\d{2}\b/.test(msg);

          const matches = list
            .map((b, idx) => ({ b, idx: idx + 1 }))
            .filter(({ b }) => {
              const dt = b?.startTime instanceof Date ? b.startTime : new Date(b?.startTime);
              if (!dt || isNaN(dt.getTime())) return false;
              if (dt.getDate() !== d) return false;
              if (dt.getMonth() !== m) return false;
              if (hasYear && dt.getFullYear() !== y) return false;
              return true;
            });

          if (matches.length === 1) pickedByDate = matches[0].idx;
          if (matches.length > 1) {
            return reply(
              client,
              chatId,
              `Ho trovato più prenotazioni in quella data. Scegli il numero nella lista (1-${list.length}).`
            );
          }
        }
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

      if (pickedByDate != null) {
        n = pickedByDate;
      } else {
        return reply(
          client,
          chatId,
          `Scegli un numero valido (1-${list.length}).\nTip: puoi anche scrivere il trattamento (es. "ceretta") o la data (es. "30/12").\nComandi: annulla`
        );
      }
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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
        )}:\n${renderSlotsList(slots)}\n\nScrivi l'orario desiderato (es. "14:30").`
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
    return reply(client, chatId, showEditMenu(chosen), { noFooter: true });
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
    // 5 = gestisci un'altra prenotazione
    const map = [
      [0, /\b(annull|cancell|disd)(a|o|i|e)?\w*\b/],
      [1, /\b(data|giorno|gg|sposta\s+data|cambia\s+data|nuova\s+data)\b/],
      [2, /\b(ora|orario|time|slot|fascia|fascia\s+orar)\w*\b/],
      [
        3,
        /\b(professionista|operatric(e|i)?|operatore|pro\b|tecnic[oa]|nail|master)\b/,
      ],
      [4, /\b(nome|intestaz|intestat|cliente|intestatario)\w*\b/],
      [5, /\b(altr[ao]|un'?altr[ao])\s+(appunt|prenotaz)\w*\b|^modifica\b/],
      [6, /\b(esci|chiudi|stop|fine|annulla)\b/i],
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

    // Range valido 0..5
    if (Number.isNaN(n) || n < 0 || n > 6) {
      return reply(
        client,
        chatId,
        "Scegli un numero valido (0-6) oppure scrivi: nome / orario / data / professionista / annulla / modifica / esci."
      );
    }

    // 5) Gestisci un'altra prenotazione -> torna alla lista prenotazioni
    if (n === 5) {
      const phone = booking.clientPhone || phoneFromChatId(chatId);
      const bookings = (getUserActiveBookingsAll(phone) || []).filter(Boolean);

      if (bookings.length <= 1) {
        pending.set(chatId, state);
        return reply(
          client,
          chatId,
          "🤔 Non ci sono altre prenotazioni future da scegliere.",
          { noFooter: true }
        );
      }

      return startEditChooseBooking(client, chatId, bookings, null);
    }

    // 6) Esci dal menu modifica (senza modifiche)
    if (n === 6) {
      pending.delete(chatId);
      return reply(
        client,
        chatId,
        'Ok 👍\nQuando vuoi: scrivi "prenota" per fissare un appuntamento oppure "modifica" per gestirne uno esistente.',
        { noFooter: true }
      );
    }

    // 0) Cancella prenotazione
    if (n === 0) {
      state.step = "edit_cancel_confirm";
      pending.set(chatId, state);
      const line = _fmtBookingLine(booking);
      return reply(
        client,
        chatId,
        `🗑️ Vuoi cancellare questa prenotazione?\n*${line}*\n\nRispondi *sì* / *no*.`
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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
        )}:\n${renderSlotsList(slots)}\n\nScrivi l'orario desiderato (es. "14:30").`
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
    const _rawLooksLikeTime =
      // input puro tipo "10" / "10:30" / "10pm" / "10:30pm"
      /^\s*(?:\d{1,2}(?:\s*[:.]\s*[0-5]\d)?\s*(?:am|pm)?|\d{3,4}\s*(?:am|pm)?)\s*$/i.test(raw) ||
      // input con indizi tipo "alle 10", "ore 10", "h10", "alle 10pm"
      /\b(?:alle?\s*|ore\s*|h\s*)(?:\d{1,2})(?:\s*[:.]\s*[0-5]\d)?\s*(?:am|pm)?\b/i.test(raw);

    const maybeNewDay = (!_rawLooksLikeTime && _editParseNewDate) ? _editParseNewDate(raw) : null;
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

      try { releaseSoftHoldByChat(chatId); } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }

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

    // 2) ✅ Nessuna selezione per indice sugli orari:
    //    anche "17" significa 17:00 (non "17° elemento" della lista).

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

    const tmp = { ...(booking || {}), startTime: newDate };
    const dateStr =
      typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(newDate)
        : typeof fmtDate === "function"
          ? fmtDate(newDate)
          : newDate.toLocaleDateString("it-IT");

    const line =
      typeof _fmtBookingLine === "function"
        ? _fmtBookingLine(tmp)
        : `${dateStr} • ${requestedHHMM}`;

    return reply(client, chatId, `✅ Orario spostato!\n➡️ *${line}*`);
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
        `Hai già ${chosenName} assegnata/o a questo appuntamento, te lo ri-confermo! ✅\n\n${showEditMenu(
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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
      const patched = {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      };
      let updated = false;
      if (booking.eventId) {
        updated = await updateBookingByEventId(booking.eventId, patched);
      } else {
        updated = await updateBookingByComposite(
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
      `Scrivi un orario tipo "14:30" o "14.30" (va bene anche "alle 14" / "verso le 15").`

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



  // ✅ Gli orari non sono mai selezionati per indice.
  //    Qui usiamo sempre l'orario scritto dall'utente (es. "10", "10:00", "10.30", "alle 10").


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

    // 0) Nome
    // ⚠️ Per evitare falsi positivi (es. "per le 18:30") e perché nel flow chiediamo SEMPRE il nome,
    // non estraiamo automaticamente il nome dall'intake.


    // 1) Servizio (scored + debug)
    let svc = null;
    let svcScore = 0;

    const ACCEPT = Number(process.env.SVC_SCORE_ACCEPT || 0.56); // >= accetta auto
    const HINT = Number(process.env.SVC_SCORE_HINT || 0.42);     // >= suggerisci (ma NON auto)
    const AMBIG_DELTA = Number(process.env.SVC_SCORE_AMBIG_DELTA || 0.08);

    try {
      const scored = (typeof bestServiceScored === "function") ? bestServiceScored(text) : null;

      if (scored && scored.best) {
        const b = scored.best;
        const bs = Number(scored.bestScore || 0);
        const s2 = scored.second || null;
        const s2s = Number(scored.secondScore || 0);

        // debug su log (visibile solo con LOG_LEVEL=debug)
        try {
          log("debug", "[SVC_SCORE]", {
            q: String(text || "").slice(0, 140),
            best: b, bestScore: bs,
            second: s2, secondScore: s2s,
            ACCEPT, HINT
          });
        } catch { }

        // Ambiguo? -> riusa il flow confirm_service già presente
        if (b && s2 && bs >= HINT && s2s >= HINT && Math.abs(bs - s2s) < AMBIG_DELTA) {
          out.serviceCandidates = [b, s2];
        } else if (b && bs >= ACCEPT) {
          svc = b;
          svcScore = bs;
        } else if (b && bs >= HINT) {
          out.serviceCandidate = b;
          out.serviceCandidateScore = bs;
          out.serviceCandidateSecond = s2;
          out.serviceCandidateSecondScore = s2s;
        }
      }
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) });
    }

    // fallback vecchio SOLO se scoring non ha dato niente
    if (!svc && !out.serviceCandidates && !out.serviceCandidate) {
      try {
        svc = (typeof resolveServiceFromText === "function" ? resolveServiceFromText(text) : null) || null;
      } catch (err) { log("warn", "[CATCH] Errore ignorato", { error: String(err) }); }

      if (!svc) {
        try {
          svc = (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(text) : null) || null;
        } catch (err) { log("warn", "[CATCH] Errore ignorato", { error: String(err) }); }
      }

      if (!svc) {
        try {
          const hit =
            (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(text) : null) ||
            (typeof fuzzyService === "function" ? fuzzyService(text) : null);

          const first = (typeof cfgServices === "function" && (cfgServices()[0] || null)) || null;

          const hasSvcToken = (() => {
            try {
              const tokens = (typeof cfgServices === "function" ? (cfgServices() || []) : [])
                .flatMap((s) => String(s || "").toLowerCase().split(/\W+/))
                .filter((x) => x && x.length >= 4);
              const nq = norm(text);
              return tokens.some((tok) => nq.includes(norm(tok)));
            } catch { return false; }
          })();

          if (hit && !(first && norm(hit) === norm(first) && !hasSvcToken)) svc = hit;
        } catch (err) { log("warn", "[CATCH] Errore ignorato", { error: String(err) }); }
      }

      // score per debug anche nel fallback
      if (svc) {
        try {
          const obj = { name: svc, synonyms: (typeof cfgServiceSynonyms === "function" ? (cfgServiceSynonyms(svc) || []) : []) };
          svcScore = (typeof scoreService === "function") ? scoreService(text, obj) : 0;
        } catch { }
      }
    }

    if (svc) {
      out.service = svc;
      if (svcScore) out.serviceScore = svcScore;
    }

    // 2) Data
    try {
      const baseForWeek =
        (out.weekOffset != null &&
          Number.isInteger(out.weekOffset) &&
          out.weekOffset > 0 &&
          !/\b(oggi|domani|dopodomani|dopo\s+domani)\b/i.test(text))
          ? (() => {
            const d0 = new Date();
            d0.setHours(12, 0, 0, 0);
            const day = d0.getDay(); // 0=dom, 1=lun...
            const diff = (day === 0 ? -6 : 1) - day; // lunedì corrente
            d0.setDate(d0.getDate() + diff + out.weekOffset * 7);
            d0.setHours(12, 0, 0, 0);
            return d0;
          })()
          : null;

      const d = (typeof safeParseDateWithLock === "function"
        ? safeParseDateWithLock(chatId, text, baseForWeek)
        : null) || null;
      if (d) {
        const at12 = typeof atNoon === "function" ? atNoon(d) : d;
        if (!(typeof isPast === "function" && isPast(at12))) out.when = at12;
      }
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

    // 3) Orario
    try {
      let hhmm =
        (typeof parseTimeSmart === "function" ? parseTimeSmart(text) : null) ||
        (typeof parseHHMM === "function" ? parseHHMM(text) : null);

      if (!hhmm && typeof parseNaturalTime === "function") hhmm = parseNaturalTime(text);
      if (hhmm) out.time = hhmm;
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

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
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }

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

  // ✅ FIX Bug #15: Wrapper per garantire filtro past times
  function __ensureFilterPastTimes(day, slots) {
    if (!Array.isArray(slots) || !slots.length) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDay = day instanceof Date ? new Date(day) : new Date(day);
    checkDay.setHours(0, 0, 0, 0);

    // Applica filtro solo se è oggi
    if (checkDay.getTime() === today.getTime()) {
      try {
        if (typeof filterOutPastTimesForToday === 'function') {
          const times = slots.map(s => typeof s === 'string' ? s : s?.time).filter(Boolean);
          const allowed = filterOutPastTimesForToday(day, times);
          const allowedSet = new Set(allowed);
          return slots.filter(s => {
            const t = typeof s === 'string' ? s : s?.time;
            return allowedSet.has(t);
          });
        }
      } catch (err) {
        log('warn', '[FILTER] Errore filtro past times', { error: String(err) });
      }
    }

    return slots;
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
    try {
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

      return buildAvailabilityCompactMessage(D, list, { offset: 0, pageSize: AVAIL_PAGE_SIZE });
    } catch (err) {
      log("error", "[AVAIL] buildAvailabilityMessage failed", {
        error: String(err?.stack || err?.message || err),
        day: String(day),
        service,
        duration,
        professional
      });
      return '😵‍💫 Ops, non riesco a calcolare le disponibilità in questo momento. Riprova tra poco oppure scrivi solo il giorno (es. "venerdì") e poi scegli l’orario.';
    }
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
        professionalAny: true,
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

  const whenRaw =
    booking.startTime || booking.start || booking.date || booking.datetime || booking.day || null;

  const when = whenRaw ? new Date(whenRaw) : new Date();
  const ok = Number.isFinite(when.getTime());

  const dayLabel = ok ? fmtWeekdayDateShortIT(when) : "data da definire";
  const hh = ok ? String(when.getHours()).padStart(2, "0") : "--";
  const mi = ok ? String(when.getMinutes()).padStart(2, "0") : "--";

  const service = booking.service || booking.serviceName || "Trattamento";
  const pro = booking.professionalName || proNameByEmail(booking.professionalEmail) || "";
  const proTxt = pro ? ` con ${pro}` : "";

  const customer =
    (booking.customerName || booking.clientName || "").toString().trim();
  const customerTxt = customer ? `. Prenotato per : ${customer}` : "";

  return `${dayLabel} alle ${hh}:${mi} - ${service}${proTxt}${customerTxt}`.trim();
}

function showEditMenu(booking) {
  const line = _fmtBookingLine(booking);

  return `📍 Prenotazione selezionata:
➡️ *${line}*

📌 Cosa vuoi fare?
1) 🗓️ Cambia data
2) 🕒 Cambia orario
3) 👩‍🔧 Cambia professionista
4) 👤 Cambia nome
5) 🔁 Modifica un'altra prenotazione
0) 🗑️ Cancella prenotazione
6) 🙅 Esci

Scegli un numero dall'elenco tra 0 e 6
(0-6)`;
}

function renderEditBookingList(bookings) {
  const arr = Array.isArray(bookings) ? bookings : [];
  return arr
    .map((b, i) => {
      const line =
        typeof _fmtBookingLine === "function"
          ? _fmtBookingLine(b)
          : String(b?.service || b?.serviceName || "Prenotazione");
      return `*${i + 1})* ${line}`;
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
  const len = bookings.length;

  const msg =
    getLang(chatId) === "en"
      ? `Which booking do you want to manage?
${list}

Reply with the *number* (1-${len}) or the *treatment* (e.g. "wax") or a *date* (e.g. "12/30").
Commands: cancel`
      : `Quale prenotazione vuoi gestire?
${list}

Scrivi *il numero* (1-${len}) oppure *il trattamento* (es. "ceretta") oppure *la data* (es. "30/12").
Comandi: annulla`;

  return reply(client, chatId, msg, { noFooter: true });
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

// Max distanza “sensata” in base alla lunghezza (evita fuzzy troppo aggressivo)
function typoMaxDist(len = 0) {
  const L = Math.max(0, Number(len) || 0);
  if (L <= 3) return 0;
  if (L <= 5) return 1;
  if (L <= 8) return 2;
  if (L <= 12) return 3;
  return 4;
}

// Match “quasi uguale” su token (preferisce Damerau, fallback a levenshtein)
function isTypoClose(a = "", b = "", maxDist = null) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;

  const md = Number.isFinite(maxDist) ? maxDist : typoMaxDist(Math.max(x.length, y.length));
  if (md <= 0) return false;

  // token molto corti: niente fuzzy (troppi falsi positivi)
  if (Math.min(x.length, y.length) <= 3) return false;
  if (Math.abs(x.length - y.length) > md) return false;

  try {
    if (typeof dlDist === "function") return dlDist(x, y) <= md;
    if (typeof levenshtein === "function") return levenshtein(x, y) <= md;
  } catch { }
  return false;
}

// Comandi tipo “modifca”, “anulla”, “cancellaa” ecc.
function fuzzyCmd(text, cmds = [], opts = {}) {
  const raw = String(text || "");
  const s = (typeof simpleNorm === "function" ? simpleNorm(raw) : raw.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return false;

  const tokens = s.split(" ").filter(Boolean);
  const list = Array.isArray(cmds) ? cmds : [cmds];

  for (const c of list) {
    const tgtRaw = String(c || "");
    const tgt = (typeof simpleNorm === "function" ? simpleNorm(tgtRaw) : tgtRaw.toLowerCase())
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!tgt) continue;

    const md0 = Number.isFinite(opts.maxDist) ? opts.maxDist : Math.min(2, typoMaxDist(tgt.length));
    if (md0 <= 0) continue;

    if (tokens.some((tk) => (typeof isTypoClose === "function" ? isTypoClose(tk, tgt, md0) : false)))
      return true;
  }

  return false;
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

// parole che NON devono influenzare il match del trattamento
const __SVC_STOP = new Set([
  "alle", "ore", "il", "lo", "la", "i", "gli", "le", "un", "una", "uno", "di", "del", "della", "da", "con", "per", "a", "in", "su", "nel", "nella",
  "ciao", "salve", "buongiorno", "buonasera", "come", "stai", "grazie", "piacere",
  "voglio", "vorrei", "volevo", "mi", "serve", "devo", "posso", "perfavore", "pls",
  "prenota", "prenotare", "prenotazione", "booking",
  "appuntamento", "appuntamenti", "fissare", "fissa", "fissiamo", "prendere",
  "oggi", "domani", "dopodomani", "settimana", "prossima", "prossimo",
  "lunedi", "lunedì", "martedi", "martedì", "mercoledi", "mercoledì", "giovedi", "giovedì", "venerdi", "venerdì", "sabato", "domenica",
  "mattina", "pomeriggio", "sera", "tarda",
  "nessuno", "nessuna", "indifferente", "qualsiasi", "chiunque"
]);

// token “molto comuni” in un salone unghie: da soli NON devono far scegliere un servizio
const __SVC_COMMON = new Set([
  "gel", "smalto", "unghie", "mani", "piedi", "ricostruzione", "applicazione", "rimozione",
  "extra", "lunga", "lunghe", "lungo", "corta", "corte", "corto", "singola", "singolo"
]);

function _svcNormText(s) {
  const base = (typeof simpleNorm === "function")
    ? simpleNorm(String(s || ""))
    : String(s || "");
  return String(base)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _svcTokensFromText(s) {
  const n = _svcNormText(s);
  if (!n) return [];
  return n
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x && x.length >= 3 && !__SVC_STOP.has(x) && !/^\d+$/.test(x));
}

function _svcIsInformative(tk) {
  if (!tk) return false;
  if (tk.length >= 6) return true;         // es: "refill", "ceretta", "pedicure"
  if (__SVC_COMMON.has(tk)) return false;  // es: "gel" da solo
  return true;
}

function scoreService(text, svc) {
  const qToks = _svcTokensFromText(text);
  if (!qToks.length) return 0; // ✅ se l'utente ha scritto solo booking words -> NO match

  const msg = " " + _svcNormText(text) + " ";
  const qSet = new Set(qToks);

  const phrases = [
    _svcNormText(svc?.name || ""),
    ...((svc?.synonyms || []).map(_svcNormText))
  ].filter(Boolean);

  const longHint = /\b(lung|lungh|lunghe|lungo)\w*\b/i.test(msg);
  const shortHint = /\b(cort|corte|corto)\w*\b/i.test(msg);

  let best = 0;

  for (const cand of phrases) {
    if (!cand || cand.length < 3) continue;

    // match forte: frase intera presente
    if (msg.includes(" " + cand + " ")) {
      best = Math.max(best, 1.0);
      continue;
    }

    const parts = cand
      .split(" ")
      .map((x) => x.trim())
      .filter((x) => x && x.length >= 3 && !__SVC_STOP.has(x));

    if (!parts.length) continue;

    let hit = 0;
    let infoHit = 0;

    for (const p of parts) {
      if (qSet.has(p)) {
        hit++;
        if (_svcIsInformative(p)) infoHit++;
        continue;
      }

      // typo-close contro i token query
      const ok = qToks.some((w) => {
        if (w.length < 4 || p.length < 4) return false;
        const L = Math.max(w.length, p.length) || 1;
        const md = (typeof typoMaxDist === "function") ? typoMaxDist(L) : (L >= 6 ? 2 : 1);
        if (md <= 0) return false;
        if (Math.abs(w.length - p.length) > md) return false;

        try {
          if (typeof isTypoClose === "function") return isTypoClose(w, p, md);
          if (typeof dlDist === "function") return dlDist(w, p) <= md;
        } catch { }
        return false;
      });

      if (ok) {
        hit++;
        if (_svcIsInformative(p)) infoHit++;
      }
    }

    // cover “simmetrico”: se l'utente scrive 2 token e li matchi entrambi -> cover ~ 1
    const denom = Math.max(1, Math.min(parts.length, qToks.length));
    const cover = hit / denom;

    const twoGram = parts.some((_, i) =>
      i < parts.length - 1 && msg.includes(" " + parts[i] + " " + parts[i + 1] + " ")
    );
    const contBonus = twoGram ? 0.08 : 0;
    const lenBonus = Math.min(cand.length / 90, 0.12);

    let hintBonus = 0;
    if (longHint && /\blungh/i.test(cand)) hintBonus += 0.06;
    if (shortHint && /\bcort/i.test(cand)) hintBonus += 0.06;

    let score = Math.min(1, 0.78 * cover + contBonus + lenBonus + hintBonus);

    // freno: evita scegliere servizi solo su token generici (gel/mani/piedi ecc.)
    if (infoHit === 0 && hit < 2) score *= 0.25;

    best = Math.max(best, score);
  }

  return best;
}
function bestServiceScored(text, services = null) {
  try {
    const list =
      Array.isArray(services)
        ? services
        : (typeof _servicesForIntent === "function" ? _servicesForIntent() : []);

    if (!list || !list.length) return null;

    let best = null, bestScore = 0;
    let second = null, secondScore = 0;

    for (const svc of list) {
      if (!svc || !svc.name) continue;
      const sc = (typeof scoreService === "function") ? scoreService(text, svc) : 0;

      if (sc > bestScore) {
        second = best; secondScore = bestScore;
        best = svc.name; bestScore = sc;
      } else if (sc > secondScore) {
        second = svc.name; secondScore = sc;
      }
    }

    if (!best) return null;
    return { best, bestScore, second, secondScore };
  } catch {
    return null;
  }
}
const REFILL_PAT =
  /\b(re[\s-]?fill|refil{1,2}|ritocco|ribilanciamento|manutenzione)\b.*\b(gel|ricostruzione)?\b/i;

/* Risolve il servizio dal testo con priorità alle menzioni esplicite. */
export function resolveServiceIntent(text, state = {}, services = []) {
  const explicit = parseExplicitMention(text);
  if (REFILL_PAT.test(text)) {
    // Non hardcodare un nome "generico" che potrebbe non esistere nel config:
    // prova a scegliere un servizio reale tra quelli passati (preferendo lunghe/corte se indicato).
    const t = _norm(text);
    const longHint = /\b(lungh)\w*\b/i.test(t);
    const shortHint = /\b(cort)\w*\b/i.test(t);

    const names = (services || []).map((x) => x?.name).filter(Boolean);
    const cands = names.filter((n) => /\brefill\b|re\s*-?fill|ritocco|manutenzione/i.test(String(n)));

    if (cands.length) {
      if (longHint) {
        const pick = cands.find((n) => /\blungh/i.test(String(n)));
        if (pick) return pick;
      }
      if (shortHint) {
        const pick = cands.find((n) => /\bcort/i.test(String(n)));
        if (pick) return pick;
      }
      return cands[0];
    }
    // fallback: continua con scoring normale
  }

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

  // ✅ Auto-pick aggressivo ma controllato (best alto + gap sul secondo)
  const AUTO_ACCEPT = Number(process.env.SVC_AUTO_ACCEPT || 0.92);
  const AUTO_GAP = Number(process.env.SVC_AUTO_GAP || 0.08);

  const scored = (typeof bestServiceScored === "function") ? bestServiceScored(t, services) : null;

  if (scored && scored.best) {
    const gap = (scored.bestScore || 0) - (scored.secondScore || 0);

    // 1) super sicuro -> prendi il primo e basta
    if ((scored.bestScore || 0) >= AUTO_ACCEPT && gap >= AUTO_GAP) {
      return scored.best;
    }

    // 2) normale (come prima), ma evita ambiguità: se il secondo è vicino, NON scegliere
    if ((scored.bestScore || 0) >= 0.6) {
      if ((scored.secondScore || 0) >= 0.6 && gap < 0.07) {
        return null; // forza choose_service / lista
      }
      return scored.best;
    }
  }

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
      (typeof formatDateWithWeekdayIT === "function"
        ? formatDateWithWeekdayIT(dt)
        : dt.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })
      );

    const msg =
      `Ciao! Ti ricordiamo che domani hai *${svc}* (${durMin} min) alle *${timeStr}* (${dayStr}) con *${pro}*.\n\n` +
      `Se vuoi modificare qualche dettaglio, scrivi *modifica*.\nNon vediamo l'ora di accoglierti 🌸`;

    try {
      await sendFn(toId, msg);

      if (typeof updateBookingByEventId === "function" && b.eventId) {
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
  const resolvePath = (p) =>
    path.isAbsolute(String(p || ""))
      ? p
      : path.join(DATA_DIR || ".", String(p || ""));

  try {
    // caso: (filePath, obj)
    if (typeof a === "string" && typeof b === "object" && b !== null && c === undefined) {
      const filePath = resolvePath(a);
      __writeJsonAtomic(filePath, b, { label: "setAndPersist" });
      return b;
    }

    // caso: (stateObj, filePath)
    if (typeof a === "object" && a !== null && typeof b === "string" && c === undefined) {
      const stateObj = a;
      const filePath = resolvePath(b);
      __writeJsonAtomic(filePath, stateObj, { label: "setAndPersist" });
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
      __writeJsonAtomic(filePath, stateObj, { label: "setAndPersist" });
      return stateObj;
    }

    throw new Error("setAndPersist: argomenti non riconosciuti");
  } catch (err) {
    // usa la funzione di logging già definita in util.js
    try {
      log && typeof log === "function"
        ? log("error", "[setAndPersist] errore", err?.message || err)
        : log("error", "[setAndPersist] errore", err);
    } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
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

    // 2) Potrebbe esserci una chiave in pd usata come "nome" invece che email - confronto fuzzy semplice
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
      } catch (err) {
        log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
      }
    }

    // default ultimo
    return DEFAULT;
  } catch (err) {
    // sicurezza: non rompere il flusso di prenotazione
    try { log && typeof log === "function" && log("warn", "getServiceDurationForPro error", err?.message || err); } catch (err) {
      log("warn", "[CATCH] Errore ignorato", { error: String(err) }); // ✅ FIX Bug #17
    }
    return 30;
  }
}


const __dateParsingInProgress = new Set();


/**
 * The `parseUnifiedDate` function in JavaScript parses a textual date input into a Date object,
 * considering various formats and relative date expressions.
 * @param text - The function `parseUnifiedDate` is designed to parse a date from a given text input.
 * It attempts to extract and interpret date information from the text and return a corresponding
 * `Date` object.
 * @param [baseDate] - The `baseDate` parameter in the `parseUnifiedDate` function is used to provide a
 * reference date for parsing relative dates. If no `baseDate` is provided, the current date and time
 * will be used as the base date for parsing. This allows for parsing dates relative to a specific
 * reference
 * @returns The function `parseUnifiedDate` returns a Date object representing the parsed date from the
 * input text, based on the rules and conditions specified within the function. If no valid date can be
 * parsed from the input text, the function returns `null`.
 */
function parseUnifiedDate(text, baseDate = new Date()) {
  if (text == null) return null;

  // Fix: evita ReferenceError su `original` e normalizza in modo consistente
  const original = String(text ?? "");

  const stripDiacritics = (s) =>
    String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalize = (s) => {
    let t = stripDiacritics(String(s ?? "").toLowerCase().trim());
    t = t.replace(/[“”"']/g, "");
    t = t.replace(/\s+/g, " ").trim();
    // rimuove punteggiatura ai bordi (così "domani?" / "15/12," ecc)
    t = t
      .replace(/^[?!.,;:()\[\]{}<>]+/g, "")
      .replace(/[?!.,;:()\[\]{}<>]+$/g, "")
      .trim();
    return t;
  };

  // Evita falsi positivi: se l'input è SOLO un orario, non è una data
  const __n0 = normalize(original);
  if (
    /^(?:alle\s*)?(?:[01]?\d|2[0-3])\s*[:.]\s*[0-5]\d\s*\??\s*$/i.test(__n0) ||
    /^(?:alle\s*)?(?:1[0-2]|0?[1-9])(?:\s*[:.]\s*[0-5]\d)?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\s*\??\s*$/i.test(__n0)
  ) return null;


  let s = normalize(original);

  // Evita falsi positivi: un orario tipo "alle 12.30" / "dalle 15:30" non è una data
  s = s.replace(/\b(?:alle|ore|h|dalle)\s*([01]?\d|2[0-3])\s*[.:,]\s*([0-5]\d)\b/gi, " ");

  // Evita falso positivo: "verso le 11/12" (range orario) non è una data (11 dicembre)
  s = s.replace(/\b(?:alle|verso|ore|dalle)\s+([01]?\d|2[0-3])\s*\/\s*([01]?\d|2[0-3])\b/g, " ");

  const base =
    baseDate instanceof Date && !Number.isNaN(baseDate.getTime())
      ? new Date(baseDate)
      : new Date();

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
      un: 1,
      uno: 1,
      una: 1,
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
      tredici: 13,
      quattordici: 14,
      quindici: 15,
      sedici: 16,
      diciassette: 17,
      diciotto: 18,
      diciannove: 19,
      venti: 20,
      ventuno: 21,
      ventidue: 22,
      ventitre: 23,
      ventiquattro: 24,
      venticinque: 25,
      ventisei: 26,
      ventisette: 27,
      ventotto: 28,
      ventinove: 29,
      trenta: 30,
      trentuno: 31,
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

  // "<giorno> del mese prossimo" (es. "17 del mese prossimo", "giorno 17 del prossimo mese")
  {
    const mNext = s.match(/\b(?:giorno\s+)?(\d{1,2})(?:\s*(?:°|º))?\s+(?:del\s+)?(?:mese\s+prossim[oa]|prossimo\s+mese)\b/);
    if (mNext) {
      const day = parseInt(mNext[1], 10);
      if (day >= 1 && day <= 31) {
        let y = baseDay.getFullYear();
        let m = baseDay.getMonth() + 1; // prossimo mese
        if (m > 11) { m = 0; y += 1; }
        const d = makeDate(y, m, day);
        if (d) return d;
      }
    }
  }

  // "settimana prossima", "mese prossimo", "anno prossimo"
  if (/\bsettimana\s+prossima\b/.test(s)) return addDays(7);
  if (/\bmese\s+prossim[oa]\b/.test(s)) return addMonths(1);
  if (/\banno\s+prossim[oa]\b/.test(s)) return addYears(1);

  // "tra/fra X giorni|settimane|mesi|anni" (X cifra o parola)
  {
    const rel = s.match(
      /\b(tra|fra)\s+([a-z0-9]+)\s*(giorno|giorni|g|gg|settimana|settimane|sett|mese|mesi|anno|anni)\b/
    );
    if (rel) {
      const n = wordToNumber(rel[2]);
      const unit = rel[3];
      if (n != null && n >= 0) {
        if (unit === "giorno" || unit === "giorni" || unit === "g" || unit === "gg")
          return addDays(n);
        if (unit === "settimana" || unit === "settimane" || unit === "sett")
          return addDays(n * 7);
        if (unit === "mese" || unit === "mesi") return addMonths(n);
        if (unit === "anno" || unit === "anni") return addYears(n);
      }
    }
  }

  // --- 2) Giorni della settimana ---
  {
    const weekdayMap = {
      lunedi: 1,
      lun: 1,
      martedi: 2,
      mar: 2,
      mercoledi: 3,
      mer: 3,
      giovedi: 4,
      gio: 4,
      venerdi: 5,
      ven: 5,
      sabato: 6,
      sab: 6,
      domenica: 0,
      dom: 0,
    };

    const w = s.match(
      /\b(lunedi|lun|martedi|mar|mercoledi|mer|giovedi|gio|venerdi|ven|sabato|sab|domenica|dom)\b/
    );
    if (w) {
      const key = w[1];
      const targetDow = weekdayMap[key];
      const baseDow = baseDay.getDay(); // 0=dom
      let diff = (targetDow - baseDow + 7) % 7;
      if (diff === 0) diff = 7; // "lunedì" -> prossimo lunedì

      // "<giorno> prossimo" / "prossimo <giorno>" => calcola il prossimo <giorno> e poi +7 giorni
      const keyRe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isWeekdayProssimo = new RegExp(
        `\\b${keyRe}\\s+prossim[oa]\\b|\\bprossim[oa]\\s+${keyRe}\\b`
      ).test(s);

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
      gennaio: 0,
      gen: 0,
      febbraio: 1,
      feb: 1,
      marzo: 2,
      aprile: 3,
      apr: 3,
      maggio: 4,
      mag: 4,
      giugno: 5,
      giu: 5,
      luglio: 6,
      lug: 6,
      agosto: 7,
      ago: 7,
      settembre: 8,
      set: 8,
      sett: 8,
      ottobre: 9,
      ott: 9,
      novembre: 10,
      nov: 10,
      dicembre: 11,
      dic: 11,
    };

    const monthKeys = Object.keys(monthMap)
      .sort((a, b) => b.length - a.length)
      .join("|");

    // giorno + mese (+ anno)
    const dm = s.match(
      new RegExp(
        `\\b(\\d{1,2})(?:\\s*(?:°|º))?\\s*(?:di\\s*)?(${monthKeys})\\b(?:\\s+(\\d{2,4}))?`,
        "i"
      )
    );
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
    const md = s.match(
      new RegExp(
        `\\b(${monthKeys})\\s+(\\d{1,2})(?:\\s*(?:°|º))?\\b(?:\\s+(\\d{2,4}))?`,
        "i"
      )
    );
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

  // --- 5) Giorno del mese dentro frase: "... il 15 ..." ---
  // Esempi: "voglio un appuntamento il 15 alle 13", "il 9 mattina"
  {
    const inPhrase = s.match(/\b(?:il|giorno)\s+(\d{1,2})(?:\s*(?:°|º))?\b/);
    if (inPhrase) {
      const day = parseInt(inPhrase[1], 10);
      if (day >= 1 && day <= 31) {
        let y = baseDay.getFullYear();
        let m = baseDay.getMonth();

        for (let k = 0; k < 14; k++) {
          const d = makeDate(y, m, day);
          if (d && d >= baseDay) return d;

          m += 1;
          if (m > 11) { m = 0; y += 1; }
        }
        return null;
      }
    }
  }

  // --- 5b) Solo giorno: "9", "il 9", "giorno 9" ---
  {
    const onlyDay = s.match(/^(?:il\s+|giorno\s+)?(\d{1,2})(?:\s*(?:°|º))?$/);
    if (onlyDay) {
      const day = parseInt(onlyDay[1], 10);
      if (day >= 1 && day <= 31) {
        // Miglioria: se il mese corrente non ha quel giorno (es. "31" ad aprile),
        // prova i mesi successivi fino a trovare una data valida e futura.
        let y = baseDay.getFullYear();
        let m = baseDay.getMonth();

        for (let k = 0; k < 14; k++) {
          const d = makeDate(y, m, day);
          if (d && d >= baseDay) return d;

          // mese successivo
          m += 1;
          if (m > 11) {
            m = 0;
            y += 1;
          }
        }
        return null;
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
function safeParseDateWithLock(chatIdOrText, maybeText, maybeBaseDate) {
  // Supporta sia safeParseDateWithLock(chatId, text) che safeParseDateWithLock(text)
  const hasChatIdAndText =
    typeof maybeText !== "undefined" &&
    (typeof maybeText === "string" || typeof maybeText === "number");

  const chatKey = hasChatIdAndText ? String(chatIdOrText || "GLOBAL") : "GLOBAL";
  const text = hasChatIdAndText ? maybeText : chatIdOrText;
  const baseDate = hasChatIdAndText ? (maybeBaseDate || null) : (maybeText || null);

  // Previeni parsing ricorsivo per la stessa chat
  if (__dateParsingInProgress.has(chatKey)) {
    log("warn", "[DATE] Parsing già in corso, ignoro", { chatId: chatKey });
    return null;
  }

  try {
    __dateParsingInProgress.add(chatKey);
    return parseUnifiedDate(text, baseDate || undefined);
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
