import express from "express";
import twilio from "twilio";
import { DateTime } from "luxon";

// stessi helper del progetto
import { readJSON } from "./fs-json.js";

// util.js (tuo)
import {
  makeEvent,
  persistBooking,
  cancelEventSafe,
  slotOverlapsExistingBookings,
  fetchSlotsForProfessional,
} from "./util.js";

// gcal.js (tuo) - per check extra su prenotazioni create “a mano”
import { getCalendarClient, resolveCalendarId, ensureCalendarAccess } from "./gcal.js";

const { VoiceResponse } = twilio.twiml;
const app = express();
app.use(express.urlencoded({ extended: false }));

const TZ = process.env.TZ || "Europe/Rome";
const PORT = Number(process.env.IVR_PORT || 3011);

// se usi Cloudflare Tunnel / ngrok: metti la base pubblica (es: https://xxxxx.trycloudflare.com)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim() || null;

// TTS migliore (Twilio doc: Polly.* / Google.*). Default: Polly Bianca Neural.
const TTS_LANG = "it-IT";
const TTS_VOICE = (process.env.TTS_VOICE || "Polly.Bianca-Neural").trim();

// abilita SSML (break) se vuoi
const USE_SSML = ["1", "true", "yes", "on"].includes(String(process.env.USE_SSML || "true").toLowerCase());

// check extra su Google Calendar (per prenotazioni “fuori bot”)
const USE_GCAL_CHECK = ["1", "true", "yes", "on"].includes(String(process.env.USE_GCAL_CHECK || "true").toLowerCase());

// modalità check:
// - "pro" = prova prima su calendario del pro (id=proEmail) e poi fallback sul calendario principale filtrando per pro
// - "main" = solo calendario principale filtrando per pro
// - "off" = disabilitato
const GCAL_CHECK_MODE = (process.env.GCAL_CHECK_MODE || "pro").trim().toLowerCase();

// ===== Sessione per CallSid =====
const SESS = new Map(); // CallSid -> session

function sid(req) {
  return String(req.body.CallSid || "no-sid");
}
function sess(req) {
  const k = sid(req);
  if (!SESS.has(k)) {
    SESS.set(k, {
      step: "MENU",
      createdAt: Date.now(),
      lastSeen: Date.now(),
      pageSvc: 0,
      pagePro: 0,
      pageSlot: 0,
      // data booking
      serviceName: null,
      baseDurationMin: null,
      servicePros: null,
      serviceProDur: null,
      anyPro: false,
      proEmail: null,
      proName: null,
      dayISO: null, // YYYY-MM-DD
      bucket: "ALL", // MORNING/AFTERNOON/EVENING/ALL
      pickedHHmm: null, // HH:mm
      dtISO: null, // ISO completo
      durationMin: null,
      // cache slot list
      slotCacheKey: null,
      slotTimes: null,
      slotMap: null, // time -> [proEmail...]
    });
  }
  const s = SESS.get(k);
  s.lastSeen = Date.now();
  return s;
}
function setSess(req, patch) {
  Object.assign(sess(req), patch || {});
}
function resetBooking(req) {
  const s = sess(req);
  Object.assign(s, {
    step: "BOOKING",
    pageSvc: 0,
    pagePro: 0,
    pageSlot: 0,
    serviceName: null,
    baseDurationMin: null,
    servicePros: null,
    serviceProDur: null,
    anyPro: false,
    proEmail: null,
    proName: null,
    dayISO: null,
    bucket: "ALL",
    pickedHHmm: null,
    dtISO: null,
    durationMin: null,
    slotCacheKey: null,
    slotTimes: null,
    slotMap: null,
  });
}

// ===== Helpers URL / voice =====
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers["host"] || "").toString();
  return `${proto}://${host}`.replace(/\/+$/, "");
}
function abs(req, path) {
  if (!path) return baseUrl(req);
  if (String(path).startsWith("http")) return String(path);
  return `${baseUrl(req)}${String(path).startsWith("/") ? "" : "/"}${path}`;
}
function stripSSML(s) {
  return String(s || "").replace(/<[^>]+>/g, "");
}
function say(vr, text, { ssml = false } = {}) {
  const t = ssml && USE_SSML ? String(text || "") : stripSSML(text);
  vr.say({ language: TTS_LANG, voice: TTS_VOICE }, t);
}
function sayG(g, text, { ssml = false } = {}) {
  const t = ssml && USE_SSML ? String(text || "") : stripSSML(text);
  g.say({ language: TTS_LANG, voice: TTS_VOICE }, t);
}
function fromPhone(req) {
  return String(req.body.From || "").trim();
}
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

// ===== Config loader (config.json) =====
function loadCfg() {
  const cfg = readJSON("config.json") || {};
  const servicesMap = cfg.services || {};
  const prosMap = cfg.professionals || {};

  const services = Object.keys(servicesMap).map((name) => {
    const it = servicesMap[name] || {};
    const pros = Array.isArray(it.professionals) ? it.professionals : [];
    const duration = Number(it.durationMin || it.duration || 30) || 30;
    const proDur = it.professionalDurations || {};
    return { name, duration, pros, proDur };
  });

  const proName = (email) => (prosMap[email]?.name || email);

  return { cfg, services, proName };
}

// ===== Bookings read (idempotenza) =====
function asBookingsArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.bookings)) return data.bookings;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}
function loadBookingsArray() {
  const raw = readJSON("bookings.json") || [];
  return asBookingsArray(raw).filter((x) => x && typeof x === "object");
}
function phoneKeyIT(digits) {
  let d = String(digits || "").replace(/\D/g, "");
  d = d.replace(/^00?39/, "").replace(/^39/, "");
  return d;
}
function findExistingIvrBooking({ callSid, phoneDigits, startISO }) {
  const rows = loadBookingsArray();
  const sid0 = String(callSid || "").trim();
  const p0 = phoneKeyIT(phoneDigits);
  const s0 = String(startISO || "").trim();

  return (
    rows.find((b) => sid0 && String(b.ivrCallSid || "") === sid0) ||
    rows.find((b) => {
      const bp = phoneKeyIT(b.clientPhone || b.phone || "");
      const bs = String(b.startTime || b.start || b.datetime || "").trim();
      return !!p0 && !!s0 && bp === p0 && bs === s0;
    }) ||
    null
  );
}

// ===== Parsing giorno (speech IT) =====
function normalizeItNumbers(s) {
  let t = String(s || "").toLowerCase();
  const map = {
    uno: "1", una: "1",
    due: "2",
    tre: "3",
    quattro: "4",
    cinque: "5",
    sei: "6",
    sette: "7",
    otto: "8",
    nove: "9",
    dieci: "10",
    undici: "11",
    dodici: "12",
    tredici: "13",
    quattordici: "14",
    quindici: "15",
    sedici: "16",
    diciassette: "17",
    diciotto: "18",
    diciannove: "19",
    venti: "20",
    ventuno: "21",
    ventidue: "22",
    ventitre: "23",
    "ventitré": "23",
    trenta: "30",
    trentuno: "31",
  };
  for (const [k, v] of Object.entries(map)) {
    t = t.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  }
  return t;
}
function weekdayToIndex(itName) {
  const w = String(itName || "").toLowerCase();
  const map = {
    lunedi: 1, "lunedì": 1,
    martedi: 2, "martedì": 2,
    mercoledi: 3, "mercoledì": 3,
    giovedi: 4, "giovedì": 4,
    venerdi: 5, "venerdì": 5,
    sabato: 6,
    domenica: 7,
  };
  return map[w] || null;
}
function nextWeekday(now, targetWeekday) {
  const today = now.weekday; // 1..7
  let delta = targetWeekday - today;
  if (delta < 0) delta += 7;
  return now.plus({ days: delta }).startOf("day");
}
function parseDayIT(spoken) {
  const now = DateTime.now().setZone(TZ);
  const txt0 = normalizeItNumbers(spoken)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  let base = null;
  let needConfirm = false;

  if (/\boggi\b/.test(txt0)) base = now.startOf("day");
  else if (/\bdomani\b/.test(txt0)) base = now.plus({ days: 1 }).startOf("day");
  else if (/\bdopodomani\b/.test(txt0)) base = now.plus({ days: 2 }).startOf("day");

  if (!base) {
    const keys = [
      "lunedi", "lunedì",
      "martedi", "martedì",
      "mercoledi", "mercoledì",
      "giovedi", "giovedì",
      "venerdi", "venerdì",
      "sabato", "domenica",
    ];
    const w = keys.find((k) => new RegExp(`\\b${k}\\b`).test(txt0));
    if (w) {
      const target = weekdayToIndex(w);
      if (target) base = nextWeekday(now, target);
    }
  }

  // dd/mm(/yyyy)
  if (!base) {
    const dm = txt0.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (dm) {
      const d = Number(dm[1]);
      const mo = Number(dm[2]);
      let y = dm[3] ? Number(dm[3].length === 2 ? ("20" + dm[3]) : dm[3]) : now.year;
      base = DateTime.fromObject({ year: y, month: mo, day: d }, { zone: TZ }).startOf("day");
      if (!dm[3]) needConfirm = true;
      if (base < now.startOf("day")) { base = base.plus({ years: 1 }); needConfirm = true; }
    }
  }

  // "18 gennaio"
  if (!base) {
    const months = {
      gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
      luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
    };
    const monKey = Object.keys(months).find((k) => new RegExp(`\\b${k}\\b`).test(txt0));
    const dMon = txt0.match(/\b(?:il\s*)?(\d{1,2})\b/);
    if (monKey && dMon) {
      const d = Number(dMon[1]);
      const mo = months[monKey];
      base = DateTime.fromObject({ year: now.year, month: mo, day: d }, { zone: TZ }).startOf("day");
      needConfirm = true;
      if (base < now.startOf("day")) { base = base.plus({ years: 1 }); needConfirm = true; }
    }
  }

  // solo giorno "il 15" -> mese ambiguo
  if (!base) {
    const dOnly = txt0.match(/\b(?:il\s*)?(\d{1,2})\b/);
    if (dOnly) {
      const d = Number(dOnly[1]);
      base = DateTime.fromObject({ year: now.year, month: now.month, day: d }, { zone: TZ }).startOf("day");
      if (!base.isValid) return { ok: false, reason: "bad_date" };
      needConfirm = true;
      if (base < now.startOf("day")) base = base.plus({ months: 1 });
    }
  }

  if (!base || !base.isValid) return { ok: false, reason: "missing_date" };
  return { ok: true, day: base, needConfirm };
}

function prettyDayISO(dayISO) {
  return DateTime.fromISO(dayISO, { zone: TZ }).setLocale("it").toFormat("cccc dd/LL/yyyy");
}
function prettyDateTimeISO(dtISO) {
  return DateTime.fromISO(dtISO, { zone: TZ }).setLocale("it").toFormat("cccc dd/LL/yyyy 'alle' HH:mm");
}

function bucketFilter(hhmm, bucket) {
  const [hh] = String(hhmm).split(":").map((x) => Number(x));
  if (!Number.isFinite(hh)) return true;
  const b = String(bucket || "ALL").toUpperCase();
  if (b === "MORNING") return hh < 12;
  if (b === "AFTERNOON") return hh >= 12 && hh < 18;
  if (b === "EVENING") return hh >= 18;
  return true;
}

function computeDurationMinForPro(s, proEmail) {
  let dur = Number(s.baseDurationMin || 30) || 30;
  const map = s.serviceProDur && typeof s.serviceProDur === "object" ? s.serviceProDur : null;
  if (map && proEmail && map[proEmail] != null) {
    const ov = Number(map[proEmail]);
    if (Number.isFinite(ov) && ov > 0) dur = ov;
  }
  return dur;
}

// ===== Google calendar check (best-effort) =====
async function slotOverlapsGoogle({ proEmail, proName, startISO, endISO }) {
  if (!USE_GCAL_CHECK) return false;
  if (GCAL_CHECK_MODE === "off") return false;

  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;

  const cal = await getCalendarClient();

  // A) PRO calendar freebusy (se usi calendari separati per professionista)
  if (GCAL_CHECK_MODE === "pro" && proEmail) {
    try {
      const fb = await cal.freebusy.query({
        requestBody: {
          timeMin: new Date(startMs).toISOString(),
          timeMax: new Date(endMs).toISOString(),
          items: [{ id: proEmail }],
        },
      });
      const busy = fb?.data?.calendars?.[proEmail]?.busy || [];
      if (Array.isArray(busy) && busy.length) return true;
    } catch {
      // ignore, fallback su calendario principale
    }
  }

  // B) calendario principale (CALENDAR_ID) con filtro per professionista via summary/description
  try {
    const calendarId = resolveCalendarId();
    await ensureCalendarAccess(calendarId);

    const res = await cal.events.list({
      calendarId,
      timeMin: new Date(startMs - 60_000).toISOString(),
      timeMax: new Date(endMs + 60_000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const items = Array.isArray(res?.data?.items) ? res.data.items : [];
    const needleEmail = String(proEmail || "").trim().toLowerCase();
    const needleName = String(proName || "").trim().toLowerCase();

    const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

    for (const ev of items) {
      const s0 = ev?.start?.dateTime || ev?.start?.date;
      const e0 = ev?.end?.dateTime || ev?.end?.date;
      const sMs = s0 ? Date.parse(s0) : NaN;
      const eMs = e0 ? Date.parse(e0) : NaN;
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) continue;
      if (!overlaps(startMs, endMs, sMs, eMs)) continue;

      const hay = `${ev?.summary || ""}\n${ev?.description || ""}`.toLowerCase();
      const matchesPro =
        (needleEmail && hay.includes(needleEmail)) ||
        (needleName && hay.includes(needleName));

      // se non riesco a matchare pro, NON blocco (altrimenti blocchi tutto il salone)
      if (matchesPro) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

// ===== ROUTES =====
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// MENU
app.post("/voice/answer", (req, res) => {
  const vr = new VoiceResponse();
  sess(req);

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 7,
    action: abs(req, "/voice/menu"),
    bargeIn: true,
  });

  sayG(g, "Ciao, Benvenuta da The Beautiful Room, prenotare è semplice.", { ssml: true });
  sayG(g, "Premi 1 per prenotare.");
  sayG(g, "Premi 0 per ripetere.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/menu", (req, res) => {
  const vr = new VoiceResponse();
  const d = String(req.body.Digits || "").trim();

  if (d === "1") {
    resetBooking(req);
    say(vr, "Perfetto. Puoi premere 0 in qualsiasi momento per tornare al menu.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 1: SERVIZIO =====
app.post("/voice/book/service", (req, res) => {
  const vr = new VoiceResponse();
  const { services } = loadCfg();
  const s = sess(req);

  if (!services.length) {
    say(vr, "Non ho trovato servizi. Controlla config.json.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }

  const pageSize = 7;
  const page = Number(s.pageSvc || 0) || 0;
  const start = page * pageSize;
  const chunk = services.slice(start, start + pageSize);

  if (!chunk.length) {
    setSess(req, { pageSvc: 0 });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 8,
    action: abs(req, "/voice/book/servicePick"),
    bargeIn: true,
  });

  sayG(g, "Scegli il trattamento. Se conosci il numero, puoi digitarlo subito.");
  chunk.forEach((it, i) => sayG(g, `${i + 1}. ${it.name}`));

  if (page > 0) sayG(g, "Premi 8 per tornare indietro.");
  if (start + pageSize < services.length) sayG(g, "Premi 9 per altri trattamenti.");
  sayG(g, "Premi 0 per menu.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/servicePick", (req, res) => {
  const vr = new VoiceResponse();
  const { services, proName } = loadCfg();
  const d = String(req.body.Digits || "").trim();
  const s = sess(req);

  const pageSize = 7;
  const page = Number(s.pageSvc || 0) || 0;
  const start = page * pageSize;
  const chunk = services.slice(start, start + pageSize);

  if (d === "0") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "9") {
    setSess(req, { pageSvc: page + 1 });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "8") {
    setSess(req, { pageSvc: Math.max(0, page - 1) });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  const idx = Number(d) - 1;
  const picked = chunk[idx];
  if (!picked) {
    say(vr, "Scelta non valida.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  setSess(req, {
    serviceName: picked.name,
    baseDurationMin: picked.duration,
    servicePros: picked.pros,
    serviceProDur: picked.proDur,
    anyPro: false,
    proEmail: null,
    proName: null,
    dayISO: null,
    bucket: "ALL",
    pickedHHmm: null,
    dtISO: null,
    durationMin: null,
    pagePro: 0,
    pageSlot: 0,
    slotCacheKey: null,
    slotTimes: null,
    slotMap: null,
  });

  const pros = Array.isArray(picked.pros) ? picked.pros : [];
  if (!pros.length) {
    say(vr, "Questo trattamento non ha professioniste configurate.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  if (pros.length === 1) {
    const email = pros[0];
    setSess(req, { proEmail: email, proName: proName(email), anyPro: false });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 2: PROFESSIONISTA (o qualsiasi) =====
app.post("/voice/book/pro", (req, res) => {
  const vr = new VoiceResponse();
  const { proName } = loadCfg();
  const s = sess(req);

  const pros = Array.isArray(s.servicePros) ? s.servicePros : [];
  if (pros.length <= 1) {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  const pageSize = 6;
  const page = Number(s.pagePro || 0) || 0;
  const start = page * pageSize;
  const chunk = pros.slice(start, start + pageSize);

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 8,
    action: abs(req, "/voice/book/proPick"),
    bargeIn: true,
  });

  sayG(g, "Scegli la professionista. Oppure premi 7 per qualsiasi disponibile.");
  chunk.forEach((email, i) => sayG(g, `${i + 1}. ${proName(email)}`));
  sayG(g, "7. Qualsiasi disponibile.");

  if (page > 0) sayG(g, "Premi 8 per tornare indietro.");
  if (start + pageSize < pros.length) sayG(g, "Premi 9 per altre professioniste.");
  sayG(g, "Premi 0 per tornare ai trattamenti.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/proPick", (req, res) => {
  const vr = new VoiceResponse();
  const { proName } = loadCfg();
  const d = String(req.body.Digits || "").trim();
  const s = sess(req);

  const pros = Array.isArray(s.servicePros) ? s.servicePros : [];
  const pageSize = 6;
  const page = Number(s.pagePro || 0) || 0;
  const start = page * pageSize;
  const chunk = pros.slice(start, start + pageSize);

  if (d === "0") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "9") {
    setSess(req, { pagePro: page + 1 });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "8") {
    setSess(req, { pagePro: Math.max(0, page - 1) });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "7") {
    setSess(req, { anyPro: true, proEmail: null, proName: null });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  const idx = Number(d) - 1;
  const email = chunk[idx];
  if (!email) {
    say(vr, "Scelta non valida.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
    return res.type("text/xml").send(vr.toString());
  }

  setSess(req, { anyPro: false, proEmail: email, proName: proName(email) });
  vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 3: GIORNO (speech) =====
app.post("/voice/book/askDay", (req, res) => {
  const vr = new VoiceResponse();
  const s = sess(req);

  if (!s.serviceName) {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  say(vr, "Dimmi il giorno.");
  say(vr, "Esempio: domani. Oppure giovedì. Oppure 18 gennaio.");
  say(vr, "Premi 8 per tornare indietro. Premi 0 per menu.");

  const g = vr.gather({
    method: "POST",
    input: "speech dtmf",
    action: abs(req, "/voice/book/day"),
    timeout: 6,
    speechTimeout: "auto",
    language: "it-IT",
    actionOnEmptyResult: true,
    bargeIn: true,
    hints:
      "oggi, domani, dopodomani, lunedi, martedi, mercoledi, giovedi, venerdi, sabato, domenica, gennaio, febbraio, marzo, aprile, maggio, giugno, luglio, agosto, settembre, ottobre, novembre, dicembre",
  });
  sayG(g, "Parla dopo il bip.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/day", (req, res) => {
  const vr = new VoiceResponse();
  const s = sess(req);

  const d = String(req.body.Digits || "").trim();
  if (d === "0") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "8") {
    const pros = Array.isArray(s.servicePros) ? s.servicePros : [];
    if (pros.length > 1) vr.redirect({ method: "POST" }, abs(req, "/voice/book/pro"));
    else vr.redirect({ method: "POST" }, abs(req, "/voice/book/service"));
    return res.type("text/xml").send(vr.toString());
  }

  const spoken = String(req.body.SpeechResult || "").trim();
  if (!spoken) {
    say(vr, "Non ho capito. Riprova.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  const parsed = parseDayIT(spoken);
  if (!parsed.ok) {
    say(vr, "Non ho capito bene il giorno. Riprova.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  const dayISO = parsed.day.toISODate();

  setSess(req, {
    dayISO,
    bucket: "ALL",
    pageSlot: 0,
    pickedHHmm: null,
    dtISO: null,
    durationMin: null,
    slotCacheKey: null,
    slotTimes: null,
    slotMap: null,
  });

  const dayStr = prettyDayISO(dayISO);
  if (parsed.needConfirm) say(vr, `Solo per sicurezza: ho capito ${dayStr}.`);
  else say(vr, `Ok: ${dayStr}.`);

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 4: FASCIA ORARIA =====
app.post("/voice/book/bucket", (req, res) => {
  const vr = new VoiceResponse();
  const s = sess(req);

  if (!s.dayISO) {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 8,
    action: abs(req, "/voice/book/bucketPick"),
    bargeIn: true,
  });

  sayG(g, "Scegli la fascia oraria.");
  sayG(g, "Premi 1 per mattina.");
  sayG(g, "Premi 2 per pomeriggio.");
  sayG(g, "Premi 3 per sera.");
  sayG(g, "Premi 4 per tutto il giorno.");
  sayG(g, "Premi 8 per cambiare giorno. Premi 0 per menu.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/bucketPick", (req, res) => {
  const vr = new VoiceResponse();
  const d = String(req.body.Digits || "").trim();
  const s = sess(req);

  if (d === "0") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "8") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  let bucket = "ALL";
  if (d === "1") bucket = "MORNING";
  else if (d === "2") bucket = "AFTERNOON";
  else if (d === "3") bucket = "EVENING";
  else if (d === "4") bucket = "ALL";
  else {
    say(vr, "Scelta non valida.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
    return res.type("text/xml").send(vr.toString());
  }

  setSess(req, { bucket, pageSlot: 0, pickedHHmm: null, dtISO: null, slotCacheKey: null, slotTimes: null, slotMap: null });
  vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 5: LISTA SLOT =====
async function buildSlotsForSession(s) {
  const { proName } = loadCfg();
  const day = DateTime.fromISO(s.dayISO, { zone: TZ }).toJSDate();

  const cacheKey = [
    s.serviceName || "",
    s.dayISO || "",
    s.bucket || "",
    s.anyPro ? "ANY" : (s.proEmail || ""),
  ].join("|");

  if (s.slotCacheKey === cacheKey && Array.isArray(s.slotTimes) && s.slotTimes.length) {
    return { times: s.slotTimes, map: s.slotMap || {}, cacheKey };
  }

  // pro fissato
  if (!s.anyPro && s.proEmail) {
    const allTimes = await fetchSlotsForProfessional({
      service: s.serviceName,
      day,
      duration: null,
      professional: s.proEmail,
    });
    const times = (Array.isArray(allTimes) ? allTimes : []).filter((t) => bucketFilter(t, s.bucket));
    const map = {};
    for (const t of times) map[t] = [s.proEmail];
    return { times, map, cacheKey };
  }

  // anyPro: merge time->pros
  const pros = Array.isArray(s.servicePros) ? s.servicePros : [];
  const map = {}; // time -> [pros]
  for (const email of pros) {
    const times0 = await fetchSlotsForProfessional({
      service: s.serviceName,
      day,
      duration: null,
      professional: email,
    });
    const list = (Array.isArray(times0) ? times0 : []).filter((t) => bucketFilter(t, s.bucket));
    for (const t of list) {
      if (!map[t]) map[t] = [];
      map[t].push(email);
    }
  }
  const times = Object.keys(map).sort();

  // arricchisci: ordina pros per nome (più carino)
  for (const t of times) {
    map[t] = (map[t] || []).slice().sort((a, b) => (proName(a) || a).localeCompare(proName(b) || b));
  }

  return { times, map, cacheKey };
}

app.post("/voice/book/slots", async (req, res) => {
  const vr = new VoiceResponse();
  const s = sess(req);

  if (!s.dayISO) {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }

  let built;
  try {
    built = await buildSlotsForSession(s);
  } catch {
    built = { times: [], map: {}, cacheKey: null };
  }

  const times = built.times || [];
  const map = built.map || {};
  setSess(req, { slotCacheKey: built.cacheKey, slotTimes: times, slotMap: map });

  if (!times.length) {
    say(vr, "Purtroppo non ci sono disponibilità in questa fascia oraria.");
    const g = vr.gather({
      method: "POST",
      numDigits: 1,
      timeout: 8,
      action: abs(req, "/voice/book/noSlotsPick"),
      bargeIn: true,
    });
    sayG(g, "Premi 1 per cambiare fascia oraria.");
    sayG(g, "Premi 2 per cambiare giorno.");
    sayG(g, "Premi 0 per menu.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
    return res.type("text/xml").send(vr.toString());
  }

  // pagina slot (7 per volta)
  const pageSize = 7;
  const page = Number(s.pageSlot || 0) || 0;
  const start = page * pageSize;
  const chunk = times.slice(start, start + pageSize);

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 8,
    action: abs(req, "/voice/book/slotPick"),
    bargeIn: true,
  });

  sayG(g, "Scegli un orario. Se conosci il numero, puoi digitarlo subito.");

  chunk.forEach((t, i) => {
    // se anyPro: puoi dire “disponibile” senza leggere pro
    sayG(g, `${i + 1}. ${t}`);
  });

  if (page > 0) sayG(g, "Premi 8 per tornare indietro.");
  if (start + pageSize < times.length) sayG(g, "Premi 9 per altri orari.");
  sayG(g, "Premi 7 per cambiare fascia. Premi 6 per cambiare giorno. Premi 0 per menu.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/noSlotsPick", (req, res) => {
  const vr = new VoiceResponse();
  const d = String(req.body.Digits || "").trim();

  if (d === "1") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "2") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }
  vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/book/slotPick", (req, res) => {
  const vr = new VoiceResponse();
  const d = String(req.body.Digits || "").trim();
  const s = sess(req);

  if (d === "0") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "6") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "7") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/bucket"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "9") {
    setSess(req, { pageSlot: (Number(s.pageSlot || 0) || 0) + 1 });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "8") {
    setSess(req, { pageSlot: Math.max(0, (Number(s.pageSlot || 0) || 0) - 1) });
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
    return res.type("text/xml").send(vr.toString());
  }

  const times = Array.isArray(s.slotTimes) ? s.slotTimes : [];
  const pageSize = 7;
  const page = Number(s.pageSlot || 0) || 0;
  const start = page * pageSize;
  const chunk = times.slice(start, start + pageSize);

  const idx = Number(d) - 1;
  const picked = chunk[idx];
  if (!picked) {
    say(vr, "Scelta non valida.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
    return res.type("text/xml").send(vr.toString());
  }

  // risolvi pro se anyPro
  let proEmail = s.proEmail;
  let proName = s.proName;
  if (s.anyPro) {
    const { proName: proNameFn } = loadCfg();
    const map = s.slotMap || {};
    const list = Array.isArray(map[picked]) ? map[picked] : [];
    if (!list.length) {
      say(vr, "Ops, quell'orario non è più disponibile. Riprova.");
      vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
      return res.type("text/xml").send(vr.toString());
    }
    // scelta automatica: prima disponibile (ordinata per nome)
    proEmail = list[0];
    proName = proNameFn(proEmail);
  }

  // calcola dtISO e durata
  const dt = DateTime.fromISO(`${s.dayISO}T${picked}`, { zone: TZ });
  const dtISO = dt.toISO();

  const durationMin = computeDurationMinForPro(s, proEmail);
  const endISO = dt.plus({ minutes: durationMin }).toISO();

  setSess(req, {
    pickedHHmm: picked,
    proEmail,
    proName,
    dtISO,
    durationMin,
    pageSlot: 0,
  });

  // vai al riepilogo
  vr.redirect({ method: "POST" }, abs(req, "/voice/book/review"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 6: RIEPILOGO + CONFERMA =====
app.post("/voice/book/review", (req, res) => {
  const vr = new VoiceResponse();
  const s = sess(req);

  if (!s.serviceName || !s.proEmail || !s.dtISO || !s.durationMin) {
    say(vr, "Mi manca qualche dato. Ripartiamo.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }

  const start = DateTime.fromISO(s.dtISO, { zone: TZ });
  const end = start.plus({ minutes: Number(s.durationMin) || 30 });

  say(vr, "Perfetto. Ti riepilogo la prenotazione:");
  say(vr, `Trattamento: ${s.serviceName}.`);
  say(vr, `Professionista: ${s.proName || "la professionista"}.`);
  say(vr, `Quando: ${start.setLocale("it").toFormat("cccc dd/LL/yyyy 'alle' HH:mm")}.`);
  say(vr, `Durata: ${s.durationMin} minuti, fino alle ${end.toFormat("HH:mm")}.`);

  const g = vr.gather({
    method: "POST",
    numDigits: 1,
    timeout: 10,
    action: abs(req, "/voice/book/confirm"),
    bargeIn: true,
  });

  sayG(g, "Premi 1 per confermare.");
  sayG(g, "Premi 2 per cambiare orario.");
  sayG(g, "Premi 3 per cambiare giorno.");
  sayG(g, "Premi 0 per annullare.");

  vr.redirect({ method: "POST" }, abs(req, "/voice/book/review"));
  res.type("text/xml").send(vr.toString());
});

// ===== STEP 7: CONFERMA (scrive Google Calendar + bookings.json) =====
app.post("/voice/book/confirm", async (req, res) => {
  const vr = new VoiceResponse();
  const d = String(req.body.Digits || "").trim();
  const s = sess(req);

  if (d === "0") {
    say(vr, "Ok, annullato. Torniamo al menu.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "2") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d === "3") {
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/askDay"));
    return res.type("text/xml").send(vr.toString());
  }
  if (d !== "1") {
    say(vr, "Scelta non valida.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/review"));
    return res.type("text/xml").send(vr.toString());
  }

  const callSid = String(req.body.CallSid || "").trim();
  const phoneDigits = digitsOnly(fromPhone(req));

  const serviceName = s.serviceName;
  const proEmail = s.proEmail;
  const proName = s.proName || null;
  const durationMin = Number(s.durationMin || 30) || 30;
  const startISO = s.dtISO;

  if (!serviceName || !proEmail || !startISO) {
    say(vr, "Mi manca qualche dato. Ripartiamo.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/answer"));
    return res.type("text/xml").send(vr.toString());
  }

  const start = new Date(startISO);
  const startMs = start.getTime();
  const endMs = startMs + durationMin * 60_000;
  const endISO = new Date(endMs).toISOString();

  // ✅ idempotenza: se Twilio ritenta, non creare doppioni
  const existing = findExistingIvrBooking({
    callSid,
    phoneDigits,
    startISO: new Date(startMs).toISOString(),
  });
  if (existing) {
    say(vr, "Risulta già una prenotazione registrata. Grazie!");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // ✅ check overlap su bookings/holds (fonte “bot”)
  if (slotOverlapsExistingBookings(proEmail, startMs, endMs)) {
    say(vr, "Ops, quell'orario non è più disponibile. Scegli un altro orario.");
    vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
    return res.type("text/xml").send(vr.toString());
  }

  // ✅ check extra Google Calendar (prenotazioni fatte a mano)
  try {
    const gcalBusy = await slotOverlapsGoogle({
      proEmail,
      proName,
      startISO: new Date(startMs).toISOString(),
      endISO,
    });
    if (gcalBusy) {
      say(vr, "Ops, risulta già occupato su calendario. Scegli un altro orario.");
      vr.redirect({ method: "POST" }, abs(req, "/voice/book/slots"));
      return res.type("text/xml").send(vr.toString());
    }
  } catch {
    // se fallisce il check, non blocchiamo (ma rimane il check bookings/holds)
  }

  let ev = null;
  let created = false;

  try {
    // 1) crea evento Google Calendar (tramite util.js -> gcal.js)
    ev = await makeEvent({
      serviceName,
      professionalEmail: proEmail,
      professionalName: proName || undefined,
      clientPhone: fromPhone(req),
      customerName: null,
      startTime: start,
      durationMin,
      notes: null,
    });
    created = true;

    const eventId = (ev && (ev.id || ev.eventId)) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 2) salva booking su bookings.json
    const rec = {
      // idempotenza IVR
      ivrCallSid: callSid,
      source: "ivr",

      eventId,
      service: serviceName,
      professionalName: proName,
      professionalEmail: proEmail,

      clientPhone: phoneDigits,
      clientChatId: null,
      customerName: null,

      startTime: new Date(startMs).toISOString(),
      startMs,
      endMs,
      endTime: new Date(endMs).toISOString(),
      durationMin,

      status: "confirmed",
      createdAt: new Date().toISOString(),
    };

    const okSaved = persistBooking(rec);
    if (!okSaved) throw new Error("persistBooking failed");

    // 3) conferma
    say(vr, "Perfetto! Prenotazione confermata.");
    say(vr, `${serviceName} con ${proName || "la professionista"}.`);
    say(vr, `${prettyDateTimeISO(s.dtISO)}.`);
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  } catch (e) {
    // rollback evento se creato ma non salvato
    try {
      if (created) {
        const id = ev?.id || ev?.eventId;
        if (id) await cancelEventSafe(id);
      }
    } catch {
      // ignore
    }

    say(vr, "C'è stato un errore nel salvataggio. Riprova tra poco.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }
});

// ===== Cleanup sessioni (evita memory leak) =====
setInterval(() => {
  const now = Date.now();
  const TTL = 4 * 60 * 60_000; // 4 ore
  for (const [k, s] of SESS.entries()) {
    if (!s?.lastSeen || now - s.lastSeen > TTL) SESS.delete(k);
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`[IVR] listening on http://localhost:${PORT}`);
  if (PUBLIC_BASE_URL) console.log(`[IVR] PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
  console.log(`[IVR] TTS_VOICE=${TTS_VOICE} USE_GCAL_CHECK=${USE_GCAL_CHECK} GCAL_CHECK_MODE=${GCAL_CHECK_MODE}`);
});
