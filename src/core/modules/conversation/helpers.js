/**
 * conversation/helpers: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const { cfgServices, escapeReg, fmtDate, getAllergens, getRecentMessages, handleMessage, itaWeekdayName, log, norm, pending, reply, tokens } = dependencies;

function scheduleReenter(client, chatId, text, tools = {}) {
  try {
    const reTools = {
      ...(tools || {}),
      __reenter: true
    };
    setTimeout(() => {
      Promise.resolve(handleMessage(client, chatId, text, reTools)).catch((err) => {
        try {
          log("error", "[REENTER] handleMessage failed", {
            chatId,
            error: String(err && err.stack ? err.stack : err),
          });
        } catch (err) {
          log("warn", "[CATCH] Errore ignorato", {
            error: String(err)
          }); //  FIX Bug #17
        }
      });
    }, 0);
  } catch (e) {
    log("warn", "[REENTER] schedule failed", {
      chatId,
      error: String(e)
    });
  }
}

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
    return {
      has: false,
      list: []
    };
  if (/^\s*s[iì]\s*$/i.test(raw)) return {
    has: true,
    list: []
  };

  const nums = raw
    .split(/[,\s]+/)
    .map((x) => parseInt(x, 10))
    .filter(Number.isInteger);
  if (nums.length) {
    const hits = nums
      .filter((n) => n >= 1 && n <= list.length)
      .map((n) => list[n - 1]);
    return {
      has: hits.length > 0,
      list: hits
    };
  }

  const hits = new Set();
  for (const a of list)
    if (new RegExp(`\\b${escapeReg(a)}\\b`, "i").test(raw)) hits.add(a);
  return hits.size ? {
    has: true,
    list: Array.from(hits)
  } : null;
}

function wantsAffectionReply(t) {
  return /\b(amore|tesoro|tesorino|tesorina|cara|carissima|caro|carissimo)\b/i.test(
    norm(t)
  );
}

function greetCTA() {
  const exampleSvc = cfgServices()[0] || "manicure";
  return `Ciao tesoro!  Puoi prenotare un trattamento o farmi domande sui nostri servizi.\nPer prenotare, ad esempio: scrivi "${exampleSvc} domani alle 10:30".`;
}

function phoneFromChatId(chatId) {
  const s = String(chatId || "");
  const num = s.split("@")[0];
  return num.replace(/\D/g, "");
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
  // PATCH: Rimuovi "per una mia amica/amico/collega/mamma/papà" ecc.
  s = s.replace(/\b(?:per|a\s+nome\s+di)\s+(?:un(?:a)?\s+)?(?:mi(?:a|o)?\s+)?(?:amica?|collega|sorella|fratello|mamma|papà|fidanzat[ao]|partner|moglie|marito|ragazza|ragazzo)\b/gi, '');

  // Rimuovi frasi introduttive per il nome (più pattern) - con word boundary
  s = s.replace(
    /^(mi\s+chiamo|io\s+mi\s+chiamo|io\s+sono|sono\s+|il\s+mio\s+nome\s+è|il\s+mio\s+nome\s+e|mi\s+presento|nome\s*[:=]\s*|nome\s+e\s+cognome\s*[:=]\s*|cognome\s*[:=]\s*|mi\s+chiamano)\s*/i,
    ''
  );

  // Rimuove pittogrammi e caratteri non validi dai nomi.
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

  // Anti-nonsense: se non c'è nessuna vocale è quasi sicuramente testo casuale (es. "cmc ci")
  if (!/[aeiouàèìòù]/i.test(letters)) return returnFallback ? FALLBACK : null;

  // Heuristic anti-nonsense: se non c'è NESSUNA vocale, probabilmente non è un nome (es. "cmc ci")
  // (riduce falsi positivi senza introdurre uno step extra)
  if (!/[aeiouàèìòù]/i.test(letters)) return returnFallback ? FALLBACK : null;

  // Heuristic anti-nonsense: se non c'è NESSUNA vocale, probabilmente non è un nome (es. "cmc ci")
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

function buildQAPromptWithMemory(chatId, basePrompt) {
  const recent = getRecentMessages(chatId).slice(-5).join("\n");
  return `${basePrompt}\n\n[Contesto chat]\n L'utente ha scritto questi 5 messaggi:${recent} usali come contesto per la tua risposta!`;
}

function _digitsPhone(s) {
  return String(s || "").replace(/\D+/g, "");
}

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

function proShort(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const iniz = last[0] ? last[0].toUpperCase() : "";
  return `${parts[0]} ${iniz}.`;
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

function parseExplicitMention(text = "") {
  const s = text.toLowerCase();
  const m = s.match(
    /(?:info|informazioni|dettagli|spiegami|dimmi).{0,20}\b(?:su|sul|sulla|sui|sulle)\s+([^\?\!\.\n]+)/i
  );
  return m ? m[1].trim() : null;
}

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

  return { scheduleReenter, formatDateWithWeekdayIT, extractAllergensFromText, parseAllergyInfo, wantsAffectionReply, greetCTA, phoneFromChatId, extractCustomerName, buildQAPromptWithMemory, _digitsPhone, looksLikeInfoQuestion, proShort, askInfoWhichService, parseExplicitMention, normalizeRecipientId, floorToHalfHour, slotKey };
}
