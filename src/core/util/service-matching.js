/** Service scoring based on normalized customer text and configured synonyms. */
import { simpleNorm } from "./text-utils.js";
import { dlDist, isTypoClose, typoMaxDist } from "./fuzzy-matching.js";

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

export function _svcNormText(s) {
  const base = (typeof simpleNorm === "function") ?
    simpleNorm(String(s || "")) :
    String(s || "");
  return String(base)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function _svcTokensFromText(s) {
  const n = _svcNormText(s);
  if (!n) return [];
  return n
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x && x.length >= 3 && !__SVC_STOP.has(x) && !/^\d+$/.test(x));
}

function _svcIsInformative(tk) {
  if (!tk) return false;
  if (tk.length >= 6) return true; // es: "refill", "ceretta", "pedicure"
  if (__SVC_COMMON.has(tk)) return false; // es: "gel" da solo
  return true;
}

export function scoreService(text, svc) {
  const qToks = _svcTokensFromText(text);
  if (!qToks.length) return 0; //  se l'utente ha scritto solo booking words -> NO match

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

export function bestServiceScored(text, services = null) {
  try {
    const list = Array.isArray(services) ? services : [];

    if (!list || !list.length) return null;

    let best = null,
      bestScore = 0;
    let second = null,
      secondScore = 0;

    for (const svc of list) {
      if (!svc || !svc.name) continue;
      const sc = (typeof scoreService === "function") ? scoreService(text, svc) : 0;

      if (sc > bestScore) {
        second = best;
        secondScore = bestScore;
        best = svc.name;
        bestScore = sc;
      } else if (sc > secondScore) {
        second = svc.name;
        secondScore = sc;
      }
    }

    if (!best) return null;
    return {
      best,
      bestScore,
      second,
      secondScore
    };
  } catch {
    return null;
  }
}
