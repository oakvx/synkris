/**
 * conversation/privacy: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { PRIVACY_NOTICE_VERSION, __dbInsertChatMessage, loadBookings, loadChatDB, log, now, safeSend, saveChatDB } = dependencies;

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
  return "*Informativa sul trattamento dei dati (WhatsApp)*\n\n" +
    "Utilizziamo il numero di telefono e i messaggi necessari per gestire richieste e appuntamenti. " +
    "I dati operativi sono conservati sul PC del salone; Google Calendar e WhatsApp " +
    "sono servizi esterni coinvolti nel funzionamento.\n\n" +
    "Scrivi *privacy* per rileggere queste informazioni o *cancella dati* per richiedere " +
    "l'eliminazione dei dati della conversazione, nei limiti degli obblighi di legge. " +
    "Per conoscere titolare, tempi di conservazione e modalità di esercizio dei diritti, contatta il salone.";
}

function privacyNoticeTextEN() {
  return (
    " *Privacy notice (WhatsApp)*\n\n" +
    "We use your phone number *only* to manage bookings and appointment-related messages.\n" +
    "Operational data is stored on the salon PC; WhatsApp and Google Calendar are external services used to provide the service.\n\n" +
    " At any time you can write: *\"privacy\"* to read this again, or *\"delete my data\"* to remove chat history.\n\n" +
    "Contact the salon for the full privacy information and to exercise your rights."
  );
}

function getPrivacyText(chatId) {
  // Se in futuro userai davvero la lingua, qui puoi leggere getLang(chatId)
  return privacyNoticeTextIT();
}

function isGroupChatId(chatId) {
  return String(chatId || "").endsWith("@g.us");
}

function chatdbDeleteEntry(chatId) {
  const db = loadChatDB();
  if (db && db[chatId]) {
    delete db[chatId];
    saveChatDB(db);
    return true;
  }
  return false;
}

function markPrivacySent(chatId) {
  const db = loadChatDB();
  const now = Date.now();
  const entry = db[chatId] || {
    msgs: []
  };
  entry.firstSeenAt = entry.firstSeenAt || now;
  entry.lastActive = now;
  entry.phone = entry.phone || chatIdToE164(chatId) || String(chatId || "");
  entry.privacy = entry.privacy || {};
  entry.privacy.version = PRIVACY_NOTICE_VERSION;
  entry.privacy.sentAt = entry.privacy.sentAt || now;
  db[chatId] = entry;
  saveChatDB(db);
}

async function maybeSendPrivacyNotice(client, chatId) {
  try {
    if (!client) return false;
    if (!chatId || isGroupChatId(chatId)) return false;

    const db = loadChatDB();
    const entry = db[chatId] || null;

    const sentAt = entry?.privacy?.sentAt || 0;
    const ver = entry?.privacy?.version || 0;

    // invia se mai inviata oppure se aggiorni versione
    if (sentAt && ver >= PRIVACY_NOTICE_VERSION) return false;

    const text = getPrivacyText(chatId);

    // 1) invia prima; se fallisce non segnare come "sent"
    const __sent = await safeSend(client, chatId, text, {
      noFooter: true
    });
    if (!__sent) return false;

    // 2) persisti dopo invio
    const now = Date.now();
    const next = entry || {
      msgs: []
    };
    next.firstSeenAt = next.firstSeenAt || now;
    next.lastActive = now;
    next.phone = next.phone || chatIdToE164(chatId) || String(chatId || "");
    next.privacy = next.privacy || {};
    next.privacy.version = PRIVACY_NOTICE_VERSION;
    next.privacy.sentAt = now;
    db[chatId] = next;
    saveChatDB(db);

    log("info", "[privacy] sent", {
      chatId
    });
    return true;
  } catch (e) {
    log("warn", "[privacy] send failed", {
      chatId,
      error: e?.message || String(e)
    });
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

function appendUserMessage(chatId, text) {
  const db = loadChatDB();
  const now = Date.now();

  db[chatId] = db[chatId] || {
    msgs: []
  };

  // Identità minima (utile anche per privacy check)
  db[chatId].firstSeenAt = db[chatId].firstSeenAt || now;
  db[chatId].phone = db[chatId].phone || chatIdToE164(chatId) || String(chatId || "");

  db[chatId].msgs.push(String(text || "").slice(0, 800));
  if (db[chatId].msgs.length > 5) {
    db[chatId].msgs = db[chatId].msgs.slice(-5);
  }

  // Aggiorna il timestamp di ultima attività dell'utente
  db[chatId].lastActive = now;
  saveChatDB(db);
  void __dbInsertChatMessage(chatId, "in", text);
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

  return { chatIdToE164, privacyNoticeTextIT, privacyNoticeTextEN, getPrivacyText, isGroupChatId, chatdbDeleteEntry, markPrivacySent, maybeSendPrivacyNotice, privacyCommandKind, appendUserMessage, getRecentMessages, getLastService, getLastInfoTopic, rememberService, rememberInfoTopic };
}
