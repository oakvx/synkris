/**
 * booking/notifications: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    __REVIEW_MENU_INTENTS,
    __isBookingIntentText,
    __looksLikeReviewAnswer,
    atNoon,
    bestServiceBySynonyms,
    buildConfirmMessage,
    buildReviewMessage,
    cfgServiceItem,
    config,
    dueForConfirmation,
    dueForReview,
    formatDateWithWeekdayIT,
    fuzzyServiceSafe,
    loadBookings,
    loadChatDB,
    log,
    matchProFromFreeText,
    norm,
    normalizeRecipientId,
    now,
    parseHHMM,
    parseTimeSmart,
    parseUnifiedDate,
    proNameByEmailSafe,
    reply,
    resolveServiceFromText,
    safeParseDateWithLock,
    safeSend,
    saveChatDB,
    updateBookingByEventId,
  } = dependencies;

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

  // Anti-falso-positivo: "ok/grazie/perfetto" NON sono feedback
  if (/^\s*(?:ok(?:ay)?|va\s+bene|perfetto|grazie(?:\s+mille)?|capito|ricevuto)\s*[!.]*\s*$/i.test(msg)) {
    return false;
  }

  // Rispondi come "feedback" SOLO se abbiamo chiesto davvero una recensione di recente
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

  let resp = "Grazie per il feedback! ";
  if (positive) {
    const svcTxt = svc ? ` per la ${svc}` : "";
    const proTxt = pro ? ` con ${pro}` : "";
    resp = `Grazie! Ci fa davvero piacere${svcTxt}${proTxt} `;
  } else if (negative) {
    resp = "Mi dispiace  Vuoi dirmi cosa non è andato? Così possiamo migliorare.";
  }

  await reply(client, chatId, resp, {
    noFooter: true
  });

  // marca come risposta al feedback (evita che i prossimi "ok" vengano catturati)
  __markReviewReplied(chatId);
  return true;
}

async function reviewFollowupsTick(sendFn, opts = {}) {
  const {
    windowMinutes,
    lookbackDays = 3,
    minAfterEndMinutes = 15,
    batchLimit = 20
  } = opts;
  if (typeof sendFn !== "function")
    throw new Error("reviewFollowupsTick: sendFn mancante");

  const now = Date.now();
  const reviewWindow = { windowMinutes, lookbackDays, minAfterEndMinutes };
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

    if (dueForReview(endMs, now, reviewWindow)) {
      const toId = normalizeRecipientId(b);
      if (!toId) continue;

      try {
        await sendFn(toId, buildReviewMessage(b));
        try {
          __rememberReviewPrompt(toId, b);
        } catch (e) { }
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

async function confirmAppointmentsTick(sendFn, opts = {}) {
  const {
    leadMinutes = 180,
    windowMinutes = 15,
    batchLimit = 20
  } = opts;
  if (typeof sendFn !== "function")
    throw new Error("confirmAppointmentsTick: sendFn mancante");

  const now = Date.now();
  const reminderWindow = { leadMinutes, windowMinutes };
  const arr = loadBookings();
  let sent = 0;

  if (!Array.isArray(arr)) return 0;

  for (const b of arr) {
    if (sent >= batchLimit) break;
    if (!b || b.status === "cancelled") continue;

    const startMs = Date.parse(b.startTime);
    if (!Number.isFinite(startMs)) continue;
    if (!b.confirmAsked && dueForConfirmation(startMs, now, reminderWindow)) {
      const recipient = normalizeRecipientId(b);
      if (!recipient) continue;
      try {
        await sendFn(recipient, buildConfirmMessage(b));
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

function resolveReviewMenuIntent(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  for (const it of __REVIEW_MENU_INTENTS) {
    if (it.re.test(s)) return it.action;
  }
  return null;
}

function extractReviewEntities(chatId, raw) {
  if (!raw) return null;
  const text = String(raw);

  // Se è un comando/menu ("cambia trattamento", "orario", ecc.) NON fare slot-filling:
  // deve gestirlo il menu di review_intake.
  try {
    const intent = (typeof resolveReviewMenuIntent === "function") ? resolveReviewMenuIntent(text) : null;
    if (intent) return null;
  } catch { }

  const out = {};

  // Servizio (anti-falso-positivo: "appuntamento", "trattamento", ecc.)
  try {
    const low = (typeof norm === "function" ? norm(text) : text.toLowerCase());

    const svcText = low
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\b(prenot\w*|appunt\w*|booking|trattament\w*|servizi?|cambia|modifica|sposta|annulla|conferma|continua|avanti|procedi|giorno|data|quando|orario|ora)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (svcText && svcText.length >= 4) {
      const svc =
        (typeof resolveServiceFromText === "function" ? resolveServiceFromText(svcText) : null) ||
        (typeof bestServiceBySynonyms === "function" ? bestServiceBySynonyms(svcText) : null) ||
        (typeof fuzzyServiceSafe === "function" ? fuzzyServiceSafe(svcText) : null) ||
        null;
      if (svc) out.service = svc;
    }
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
          if (nn && (q.includes(nn) || nn.includes(q))) {
            hit = p;
            break;
          }
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

      const label = (it && (it.label || it.name)) || col.service;
      svcTxt = String(label);
    }
  } catch { }

  // Giorno
  let dayTxt = "-";
  try {
    if (col.when) {
      dayTxt = (typeof formatDateWithWeekdayIT === "function") ?
        formatDateWithWeekdayIT(col.when) :
        (col.when?.toLocaleDateString?.("it-IT") || String(col.when));
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

  /*
   const header =
      ` Ho capito così:\n` +
      `- Trattamento: ${svcTxt}\n` +
      `- Professionista: ${proTxt}\n`
      `- Giorno: ${dayTxt}\n` +
      `- Orario: ${timeTxt}\n`;
  */
  const header =
    ` Ho capito così:\n` +
    `- Trattamento: ${svcTxt}\n` +
    `- Professionista: ${proTxt}\n` +
    `- Giorno: ${dayTxt}\n` +
    `- Orario: ${timeTxt}\n`;
  const menu =
    `\n Vuoi modificare qualcosa?\n` +
    `1) ${col.service ? "Cambia trattamento" : "Scegli trattamento"}\n` +
    `2) ${(col.professionalAny || col.professionalName || col.professionalEmail) ? "Cambia professionista" : "Scegli professionista"}\n` +
    `3) ${col.when ? "Cambia giorno" : "Scegli giorno"}\n` +
    `4) ${(col.time || col._preferredTime) ? "Cambia orario" : "Scegli orario"}\n` +
    `5)  Conferma e continua\n` +
    `\n Puoi rispondere con *5* oppure scrivere: *conferma* / *ok* / *va bene*.\n` +
    ` Puoi anche scrivere direttamente un dettaglio (trattamento / giorno / orario), es. "refill gel", "dopodomani", "alle 10", "dopodomani alle 10".\n` +
    `0)  Annulla\n` +
    `(0-5)`;

  return {
    msg: header + menu,
    map
  };
}

function __cap(s) {
  const t = String(s || "");
  return t ? (t[0].toUpperCase() + t.slice(1)) : "";
}

function startReviewFollowupsLoop(client, opts = {}) {
  const {
    intervalMinutes = 30,
    lookbackDays = 3,
    minAfterEndMinutes = 15,
    batchLimit = 20,
    alignToHalfHour = true,
    isSuspended = () => false
  } = opts;

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('intervalMinutes non valido per review loop');
  }
  const sendFn = (to, msg) => safeSend(client, to, msg, {
    noFooter: true
  });

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

  let timer = null;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped || isSuspended()) return;
    busy = true;
    try {
      await reviewFollowupsTick(sendFn, { lookbackDays, minAfterEndMinutes, batchLimit });
    } catch (err) {
      log('error', '[REVIEW_LOOP] Error in reviewFollowupsTick', err?.message || err);
    } finally {
      busy = false;
    }
  };
  const initial = setTimeout(() => {
    if (stopped) return;
    void tick();
    timer = setInterval(() => void tick(), intervalMinutes * 60_000);
  }, initialDelay);

  log('info', `[REVIEW_LOOP] Will check every ${intervalMinutes} minutes (first run in ${Math.round(initialDelay / 1000)}s)`);
  return () => {
    stopped = true;
    clearTimeout(initial);
    if (timer) clearInterval(timer);
  };
}

  return { __rememberReviewPrompt, __markReviewReplied, maybeHandleReviewReply, reviewFollowupsTick, confirmAppointmentsTick, resolveReviewMenuIntent, extractReviewEntities, buildReviewIntakePrompt, __cap, startReviewFollowupsLoop };
}
