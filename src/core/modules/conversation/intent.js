/**
 * conversation/intent: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    HYBRID_PATTERNS,
    MESSAGES,
    __cap,
    bestServiceBySynonyms,
    config,
    fmtDate,
    fmtDateWithWeekdayIT,
    fuzzyCmd,
    fuzzyService,
    isReactionOnly,
    levenshtein,
    loadChatDB,
    matchProFromFreeText,
    norm,
    now,
    parseDaypartWindow,
    parseHHMM,
    parseTimeSmart,
    safeParseDateWithLock,
    saveChatDB,
    simpleNorm,
  } = dependencies;

function isUrgencyMessage(text) {
  const s = String(text || "").toLowerCase();

  // parole chiave urgenza
  const urgencyWord = /\b(urgente|urgenza|subito|prima\s+possibile|oggi\s+stesso|entro\s+oggi)\b/i.test(s);

  // problemi tipici: rotta/spezzata/staccata, gel saltato, dolore/sangue
  const damageWord = /\b(rott[oa]|spezzat[oa]|spaccat[oa]|staccat[oa]|saltat[oa]|cadut[oa])\b/i.test(s);
  const nailContext = /\b(unghi[ae]|gel|semipermanente)\b/i.test(s);
  const injuryWord = /\b(dolor[ei]|sanguin|infiammaz|gonfi|infezion|incarnit)\b/i.test(s);

  // Trigger: urgenza OR (danno+contesto) OR injury
  if (urgencyWord) return true;
  if (injuryWord) return true;
  if (damageWord && nailContext) return true;

  // Frasi comuni: "mi si è rotta", "si è spezzata"
  if (/mi\s+si\s+[eè]\s+(?:rott[ao]|spezzat[ao]|staccat[ao]|spaccat[ao])/i.test(s)) return true;

  return false;
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
  db[chatId] = db[chatId] || {
    msgs: []
  };
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

function __isBookingIntentText(s = "") {
  const t = String(s || "");
  // Se ci sono segnali di prenotazione, NON trattarlo come risposta al feedback
  if (/\b(prenot|appunt|disponibil|orari|slot|fiss|riserv|sposta|modifica|cambia|annulla)\w*/i.test(t)) return true;

  // segnali "data/ora" tipici della prenotazione (es. "domani alle 15", "lunedi 10:30", "23 ottobre")
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

  // Riconosce risposte contenenti esclusivamente reazioni Unicode.
  if (isReactionOnly(raw)) return true;

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

function wantsEditMenu(text) {
  const s = norm(text || "").trim();

  // Comando secco sempre valido
  if (/^\/?modifica\b/i.test(s)) return true;

  // refusi su comandi (es. "modifca", "modifia", ecc.)
  if (
    typeof fuzzyCmd === "function" &&
    (
      fuzzyCmd((s.split(/\s+/)[0] || ""), ["modifica", "modificare", "cambia", "cambiare"], {
        maxDist: 2
      }) ||
      fuzzyCmd((s.split(/\s+/)[0] || ""), ["sposta", "spostare"], {
        maxDist: 1
      })
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

function extractInfoTopic(text) {
  const s = norm(text || "");
  if (/\bhenne|henn[eè]\b/.test(s)) return "henné";
  if (/\bprezz|costo|tariff\w*/.test(s)) return "prezzo";
  if (/\bdurat|quanto\s+dura\b/.test(s)) return "durata";
  if (/\bcontroindic|effetti\b/.test(s)) return "controindicazioni";
  return null; // “generico”
}

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

function __intentHeuristicOverride(userText) {
  const t = norm(String(userText || ""));
  // Se parla di modifiche/cancellazioni, preferisci sempre EDIT (anche se c'è un saluto in testa)
  const hasEditVerb = /\b(sposta|spostare|riprogramma|riprogrammare|cambia|cambiare|modifica|modificare|annulla|annullare|disdici|disdire|disdetta|cancella|cancellare|rinvia|rinviare|posticipa|posticipare|anticipa|anticipare|non\s+posso\s+venire|ritardo|sono\s+in\s+ritardo)\b/i.test(t);
  const mentionsAppt = /(appunt|prenot)/i.test(t);
  if (hasEditVerb && (mentionsAppt || /\b(domani|oggi|stasera|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica)\b/i.test(t))) {
    return "edit";
  }
  return null;
}

function looksLikeBooking(t) {
  const s = String(t || "").trim();
  if (!s) return false;

  // Se l'utente segnala un problema da sistemare, consideralo comunque un intento di prenotazione.
  // 1) Frasi esplicite di prenotazione (anche senza data/servizio)
  if (/\b(?:voglio|vorrei|volevo|mi\s+serve|devo|posso|potrei|puoi)\b.*\b(?:prenot\w*|appunt\w*|fiss\w*)\b/i.test(s)) return true;

  // "quando ... posto/disponibilità/appuntamento" (booking-like)
  if (/\bquando\b.*\b(?:avete|hai|puoi|riesci|potresti)\b.*\b(?:posto|disponibil\w*|appunt\w*|prenot\w*)\b/i.test(s)) return true;

  // caso corto: "quando riesci/puoi farmi" (4-6 parole)
  if (/^\s*quando\s+(?:riesci|puoi|potresti)\s+(?:a\s+)?farmi\b/i.test(s) && s.split(/\s+/).filter(Boolean).length <= 6) return true;

  // Typos su "appuntamento" (es. "apputmamento") + nome professionista -> booking
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

function hasBookingVerb(s) {
  s = norm(s || "");
  return /\b(prenot|appunt|fiss|riserv|disponibil|spost|cancell|modific|posto|quando\s+(?:avete|hai|c'e))\w*/i.test(s);
  // Aggiunto: "posto", "quando avete", "quando hai"
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

function parseAvailabilityRequest(text) {
  const t = norm(text || "");
  const out = {
    kind: null
  };

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

    const m1 = hasTimeSlash ?
      null :
      t.match(/\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/);
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
        afterM[1].length === 1 ?
          `0${afterM[1]}:00` :
          afterM[1].includes(":") ?
            afterM[1] :
            `${afterM[1]}:00`;
    const beforeM = t.match(
      /\b(?:prima|entro)\s+(?:le\s*)?([0-2]?\d(?::[0-5]\d)?)\b/
    );
    if (beforeM)
      out.before =
        beforeM[1].length === 1 ?
          `0${beforeM[1]}:00` :
          beforeM[1].includes(":") ?
            beforeM[1] :
            `${beforeM[1]}:00`;
  }

  return out.kind ? out : null;
}

function tokens(s) {
  return simpleNorm(String(s || ""))
    .split(" ")
    .filter(Boolean);
}

function simRatio(a, b) {
  a = simpleNorm(a);
  b = simpleNorm(b);
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  const m = Math.max(a.length, b.length);
  return m ? 1 - d / m : 0;
}

function fuzzyContains(
  text,
  phrase, {
    minRatio = 0.82,
    minCoverage = 0.66
  } = {}
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

function hasAnyDateOrTime(text) {
  return hasDateOrTime(text) || !!parseHHMM(text) || !!safeParseDateWithLock(text);
}

function intentByHybrid(t) {
  const text = (t || "").toLowerCase();

  const scores = {
    booking: 0,
    edit: 0,
    cancel: 0,
    info: 0
  };

  for (const key of Object.keys(HYBRID_PATTERNS)) {
    const {
      regex,
      weight
    } = HYBRID_PATTERNS[key];
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

  return {
    label,
    scores
  };
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
    ` Hai scritto: *${human}*\n` +
    `Per evitare errori, quale data intendi?\n` +
    `${lines}\n\n` +
    `Rispondi con *1-${maxOpt}* oppure scrivi una data esatta (es. *18 febbraio*).\n` +
    `0)  Annulla`;

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

  return { isUrgencyMessage, detectLangHeuristic, getLang, setLang, ensureLang, tr, __isBookingIntentText, __looksLikeReviewAnswer, wantsEditMenu, extractInfoTopic, composeInfoPrompt, baseCandidates, __intentHeuristicOverride, looksLikeBooking, hasBookingVerb, hasDateOrTime, scoreInfoIntent, scoreBookingIntent, primaryIntent, parseAvailabilityRequest, tokens, simRatio, fuzzyContains, hasAnyRegex, fuzzyAny, hasAnyDateOrTime, intentByHybrid, __weekdayIdxFromIT, __findNextValidMonthDay, __nextWeekdayDate, __buildDayMonthConfirmFromText };
}
