/**
 * catalog/services: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    REFILL_PAT,
    __SVC_GROUP_PREFERRED,
    __SVC_GROUP_STOPWORDS,
    __fmtEurMaybe,
    __svcKey,
    _n,
    _norm,
    config,
    dlDist,
    formatDurationMin,
    getServiceDurationForPro,
    levenshtein,
    log,
    matchProFromFreeText,
    norm,
    parseExplicitMention,
    reply,
    scoreService,
    scoreServiceCatalog,
    simpleNorm,
    tokens,
  } = dependencies;

function __dbAllPros() {
  const seen = new Set();
  const out = [];
  for (const list of shared.__servicesProsCache.values()) {
    for (const p of list) {
      if (!seen.has(p.email)) {
        seen.add(p.email);
        out.push(p);
      }
    }
  }
  // Se la cache servizi non è ancora caricata, fallback su __proNameToId
  if (!out.length) {
    for (const [name, id] of shared.__proNameToId.entries()) {
      const email = `pro:${id}`;
      if (!seen.has(email)) {
        seen.add(email);
        out.push({
          name,
          email,
          professional_id: id,
          hasRealEmail: false
        });
      }
    }
  }
  return out;
}

function proCatalog(service) {
  // Fonte di verità: DB, non config.professionals (che conterrebbe email gcal come "evelin.com")
  const dbPros = cfgServiceProfessionals(service);
  if (dbPros.length) return dbPros;
  return __dbAllPros();
}

function renderProPrompt(list) {
  if (!list.length) {
    return ' Non ho professionisti configurati per questo servizio: non posso completare la prenotazione. Scrivi "annulla".';
  }
  const lines = list.map((p, i) => `${i + 1}) ${p.name}`).join("\n");

  return ` Preferisci una professionista in particolare?
0) Nessuna preferenza
${lines}

Rispondi con *0*, con un numero (1-${list.length}) oppure scrivi il *nome*.
(0-${list.length})`;
}

function resolveProReply(reply, list) {
  const txt = (reply || "").trim();
  const pureNumber = /^\s*\d+\s*[\).]?\s*$/; // accetta "3" "3)" "3."

  // no-preference textual answers
  if (/\b(no|non\s+mi\s+interessa|chiunque|qualsiasi|indifferente|nessuno|no\s+grazie)\b/i.test(txt)) {
    return {
      any: true,
      noPreference: true
    };
  }

  // "Sì/ok" quando c'è una sola scelta: interpreta come "scegli l'unico professionista"
  // (evita che l'utente resti bloccato quando l'elenco è: 0) Indietro, 1) Diana)
  if (/\b(si|sì|ok|okay|va\s*bene|certo|perfetto|yes|yep)\b/i.test(txt)) {
    if (Array.isArray(list) && list.length === 1) return list[0];
  }

  // input numerico
  if (pureNumber.test(txt)) {
    const n = parseInt(txt, 10);
    if (n === 0) return {
      any: true
    };
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

function askProfessional(service) {
  const list = proCatalog(service);
  return renderProPrompt(list);
}

function cfgServices() {
  return Array.isArray(shared.__servicesListCache) ? shared.__servicesListCache.slice() : [];
}

function cfgServiceItem(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;

  const canon = shared.__svcKeyToName.get(__svcKey(raw)) || raw;
  return shared.__servicesItemCache.get(canon) || null;
}

function cfgServiceSynonyms(service) {
  const it = cfgServiceItem(service) || {};
  const canon = (it && (it.name || it.label)) ? (it.name || it.label) : String(service || "").trim();

  const base = (shared.__servicesSynCache.get(canon) || []).slice();

  // include anche label/name così l'utente può scrivere quello che vede in chat
  const extra = [];
  if (it.label) extra.push(it.label);
  if (it.name) extra.push(it.name);

  const out = [...extra, ...base].filter(Boolean);

  // auto-synonyms refill/ritocco (copre "reffil")
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
  const list = shared.__servicesProsCache.get(canon) || [];
  return Array.isArray(list) ? list.slice() : [];
}

function cfgServicePriceText(name) {
  const it = cfgServiceItem(name) || {};
  const p = (typeof it.price === "number" || typeof it.price === "string") ? it.price : null;
  const eur = __fmtEurMaybe(p);
  return eur || "prezzo su richiesta";
}

function proNameByEmailSafe(email) {
  try {
    const key = String(email || "").toLowerCase();

    // Prima cerca nel DB via __proNameToId (inverso)
    // Se è un identificatore sintetico "pro:N", cerca per professional_id
    if (key.startsWith("pro:")) {
      const id = Number(key.slice(4));
      for (const [name, pid] of shared.__proNameToId.entries()) {
        if (pid === id) return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }

    // Cerca per email reale nelle mappe DB
    for (const p of __dbAllPros()) {
      if (String(p.email || "").toLowerCase() === key && p.name) return p.name;
    }

    // Fallback proNameByEmail (che può ancora leggere config, ma come ultima istanza)
    return (
      (typeof proNameByEmail === "function" ? proNameByEmail(email) : null) ||
      email || ""
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
      (typeof cfgServiceProfessionals === "function" ?
        (cfgServiceProfessionals(svc) || []) :
        null) || null;
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
  const buffer = Math.max(0, Number(config?.services?.[svc]?.bufferAfterMin) || 0);
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
    if (Number.isFinite(+d2) && +d2 > 0) return +d2 + buffer;

    const d = item.durationMin ?? item.duration;
    if (Number.isFinite(+d) && +d > 0) return +d + buffer;
  } catch { }

  try {
    return (typeof cfgServiceDuration === "function" ? (cfgServiceDuration(svc) || 30) : 30) + buffer;
  } catch {
    return 30;
  }
}

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

  const d = (typeof levenshtein === "function") ? levenshtein(x, y, md) : Infinity;
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
      if (md > 0 && typeof levenshtein === "function" && levenshtein(tk, pref, md) <= md) {
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
      g = {
        key: anchor,
        title: titleize(anchor),
        services: []
      };
      groups.push(g);
    }
    g.services.push(svc);
  }

  // 3) ordine: gruppi piu' grandi prima (UX migliore)
  groups.sort((a, b) => (b.services.length - a.services.length) || a.title.localeCompare(b.title));

  return groups;
}

function groupServicesByCategory(serviceKeys, labelOfSvc) {
  const svcs = Array.isArray(serviceKeys) ? serviceKeys.slice() : [];

  const keyOf = (it) => {
    const cid = it && Number.isFinite(+it.categoryId) ? String(+it.categoryId) : "";
    if (cid) return `id:${cid}`;
    const name = String(it?.category || "").trim().toLowerCase();
    return `name:${name || "altro"}`;
  };

  const titleOf = (it) => {
    const t = String(it?.category || "").trim();
    return t || "Altro";
  };

  const orderOf = (it) => {
    const o = Number(it?.categoryOrder);
    return Number.isFinite(o) ? o : 9999;
  };

  const labelSafe = (svc) => (typeof labelOfSvc === "function" ? (labelOfSvc(svc) || svc) : svc);

  const groupsMap = new Map(); // key -> { key, title, order, services: [] }

  for (const svc of svcs) {
    const it = (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {});
    const k = keyOf(it);
    let g = groupsMap.get(k);
    if (!g) {
      g = {
        key: k,
        title: titleOf(it),
        order: orderOf(it),
        services: []
      };
      groupsMap.set(k, g);
    }
    g.services.push(svc);
  }

  // ordina servizi dentro ogni gruppo
  for (const g of groupsMap.values()) {
    g.services.sort((a, b) => {
      const ia = (typeof cfgServiceItem === "function" ? (cfgServiceItem(a) || {}) : {});
      const ib = (typeof cfgServiceItem === "function" ? (cfgServiceItem(b) || {}) : {});
      const oa = Number(ia.displayOrder ?? 1000);
      const ob = Number(ib.displayOrder ?? 1000);
      if (oa !== ob) return oa - ob;
      return String(labelSafe(a)).localeCompare(String(labelSafe(b)));
    });
  }

  const groups = Array.from(groupsMap.values());
  groups.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
  return groups;
}

function buildServicesMessageForPro(proEmail) {
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

  const groups = (typeof groupServicesByCategory === "function") ?
    groupServicesByCategory(availableRaw, labelOfSvc) : (typeof groupServicesByType === "function") ?
      groupServicesByType(availableRaw, labelOfSvc) : [{
        title: "Trattamenti",
        services: availableRaw
      }];

  const lines = [];
  const available = []; // ORDER IMPORTANTE: deve combaciare coi numeri mostrati
  let idx = 0;

  for (const g of groups) {
    if (lines.length) lines.push(""); // separatore visivo tra gruppi
    lines.push(`*${g.title || "Trattamenti"}*`);

    for (const svc of (g.services || [])) {
      idx++;
      available.push(svc);

      const item =
        (typeof cfgServiceItem === "function" ? (cfgServiceItem(svc) || {}) : {}) ||
        (config?.services?.[svc] || {});
      const label = item.label || item.name || svc;

      const price =
        (typeof cfgServicePriceText === "function" ? cfgServicePriceText(svc) : "") ||
        (Number.isFinite(+item.price) ? `${item.price}€` : "");

      const dur = getDurForPro(svc, proEmail);
      const durTxt =
        (typeof formatDurationMin === "function" ? (formatDurationMin(dur) || `${dur} min`) : `${dur} min`);

      const pricePart = price ? ` (_${price}_, _*${durTxt}*_)` : ` (_*${durTxt}*_)`;
      lines.push(`${idx}) ${label}${pricePart}`);
    }
  }

  const unavailableLines = unavailable.map((svc) => {
    const emails = serviceProsEmails(svc);
    const names = emails.map(proNameByEmailSafe).filter(Boolean);
    const who = names.length ? names.join(", ") : "—";
    return `* ${svc} (disponibile con: ${who})`;
  });

  const proHeader = proEmail ? ` con *${proNameByEmailSafe(proEmail)}*` : "";

  let msg =
    ` Trattamenti disponibili${proHeader}:\n` +
    (lines.length ? lines.join("\n") : " Nessun trattamento disponibile.");

  if (available.length) msg += `\n(1-${available.length})`;

  if (unavailableLines.length) {
    msg +=
      `\n\n Non disponibili${proHeader}:\n${unavailableLines.join("\n")}\n\n` +
      ` Se vuoi uno dei trattamenti non disponibili: digita "annulla" e prenota di nuovo scegliendo un professionista che lo esegue.`;
  }

  return {
    available,
    msg
  };
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

function resolveServiceFromText(t) {
  const raw = String(t || "");
  let q0 = norm(raw);

  // Anti-falso-positivo: parole generiche di booking/menu non devono diventare "servizi"
  q0 = q0
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(prenot\w*|appunt\w*|booking|trattament\w*|servizi?|cambia|modifica|sposta|annulla|conferma|continua|avanti|procedi|scegli|preferisc\w*|riassunto|riepilogo|menu|stato)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!q0) return null;

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

      resolveServiceFromText._cache = {
        key: cacheKey,
        df,
        weight,
        docs: D,
        tokenize,
        N
      };
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

  const distFn = (a, b, md = null) => {
    const x = String(a || "");
    const y = String(b || "");
    if (typeof dlDist === "function") return dlDist(x, y, md);
    if (typeof levenshtein === "function") return levenshtein(x, y, md);
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

    const d = distFn(a, b, md);
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

    if (!toks.length) return {
      score: 0
    };

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

    return {
      score
    };
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

function proNameByEmail(email, professionalsOrConfig) {
  if (!email) return "";

  const deriveNameFromEmail = (mail) => {
    const s = String(mail || "").trim();
    if (!s) return "";
    if (!s.includes("@")) return s;
    const local = s.split("@")[0] || s;
    const cleaned = local.replace(/[._-]+/g, " ").trim();
    if (!cleaned) return "";
    return cleaned
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  };

  const sanitize = (nameOrEmail, fallbackEmail) => {
    const v = String(nameOrEmail || "").trim();
    if (!v) return "";
    if (v.includes("@")) return deriveNameFromEmail(fallbackEmail || v) || "";
    return v;
  };

  let pros;
  if (professionalsOrConfig) {
    pros = Array.isArray(professionalsOrConfig) ?
      professionalsOrConfig :
      professionalsOrConfig?.professionals;
  } else if (typeof config !== "undefined") {
    pros = config?.professionals;
  }

  const key = String(email).toLowerCase();

  if (pros && !Array.isArray(pros) && typeof pros === "object") {
    const o = pros[email] || pros[key] || pros[key?.trim?.()];
    if (o && typeof o === "object") {
      const nm = o.name || o.displayName || "";
      return sanitize(nm || email, email) || deriveNameFromEmail(email) || String(email);
    }
  }

  if (Array.isArray(pros)) {
    const found = pros.find((p) => String(p?.email || "").toLowerCase() === key);
    if (found) {
      const nm = found.name || found.displayName || "";
      return sanitize(nm || email, found.email || email) || deriveNameFromEmail(email) || String(email);
    }
  }

  // fallback finale: se è una mail, mostra solo il "nome" derivato (senza dominio)
  return deriveNameFromEmail(email) || sanitize(email, email) || String(email);
}

function findProfessionalCandidatesByText(inputText, serviceCtx = null) {
  const normTxt = simpleNorm(inputText);
  const specific = ((serviceCtx && cfgServiceProfessionals(serviceCtx)) || [])
    .map((p) => p.name)
    .filter(Boolean);
  const candidates = specific.length ?
    specific :
    __dbAllPros().map((p) => p.name);
  const hits = [];
  for (const name of candidates) {
    const nname = simpleNorm(name);
    let score = 0;
    if (nname && normTxt.includes(nname)) score += 3;
    for (const tok of nname.split(" ").filter(Boolean)) {
      if (tok.length >= 3 && normTxt.includes(tok)) score += 1;
    }
    if (score > 0) hits.push({
      name,
      score
    });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const topScore = hits[0].score;
  const bestCandidates = hits
    .filter((h) => h.score === topScore)
    .map((h) => h.name);
  if (bestCandidates.length === 1) return {
    resolved: bestCandidates[0]
  };
  return {
    ambiguous: bestCandidates.slice(0, 6)
  };
}

function proEmailByName(name) {
  if (!name) return null;
  const normName = norm(name);

  // Prima cerca nel DB (fonte di verità)
  const dbKey = String(name).toLowerCase().trim();
  const dbId = shared.__proNameToId.get(dbKey);
  if (dbId) {
    // cerca l'email reale nella mappa email->id (inversa)
    for (const [email, id] of shared.__proEmailToId.entries()) {
      if (id === dbId) return email;
    }
    // professionista senza email reale: usa identificatore sintetico
    return `pro:${dbId}`;
  }

  // Fuzzy match su tutti i pro DB
  for (const p of __dbAllPros()) {
    if (norm(p.name) === normName) return p.email;
  }

  // Fallback a config (mantenuto per retrocompatibilità ma non dovrebbe mai servire)
  const pros = config.professionals || {};
  for (const [email, o] of Object.entries(pros)) {
    const n = o?.name || email;
    if (norm(n) === normName) return email;
  }
  return null;
}

function _servicesForIntent() {
  return cfgServices().map((n) => ({
    name: n,
    synonyms: cfgServiceSynonyms(n),
  }));
}

function bestServiceScored(text, services = null) {
  const catalog = Array.isArray(services) ? services : _servicesForIntent();
  return scoreServiceCatalog(text, catalog);
}

function resolveServiceIntent(text, state = {}, services = []) {
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
    let best = {
      name: null,
      score: 0
    };
    for (const s of services) {
      const sc = scoreService(e, s);
      if (sc > best.score) best = {
        name: s.name,
        score: sc
      };
    }
    if (best.score >= 0.6) return best.name;
  }

  const t = _norm(text);

  // Auto-pick aggressivo ma controllato (best alto + gap sul secondo)
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

  return { __dbAllPros, proCatalog, renderProPrompt, resolveProReply, askProfessional, cfgServices, cfgServiceItem, cfgServiceSynonyms, cfgServiceDuration, cfgServiceProfessionals, cfgServicePriceText, proNameByEmailSafe, serviceProsEmails, isServiceAvailableForPro, getDurForPro, __svcCleanLabelForGrouping, __svcMaxDistToken, __svcKeysClose, __svcGroupKeyFromLabel, __svcTokensFromLabel, __svcAnchorFromTokens, groupServicesByType, groupServicesByCategory, buildServicesMessageForPro, cfgAllergensForService, getAllergens, fuzzyService, resolveServiceFromText, proNameByEmail, findProfessionalCandidatesByText, proEmailByName, _servicesForIntent, bestServiceScored, resolveServiceIntent };
}
