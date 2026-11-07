/** Name matching and free-text selection for salon professionals and bookings. */
import { simpleNorm } from "./text-utils.js";
import { isTypoClose, typoMaxDist } from "./fuzzy-matching.js";

const _n = (value) => simpleNorm(String(value || "")).trim();
const _tok = (value) => _n(value).split(/\s+/).filter(Boolean);

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
export function matchProFromFreeText(raw, list) {
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
  let best = null,
    bestScore = 0;
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
export function pickBookingIndexFromFreeText(raw, list) {
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

  let best = {
    idx: -1,
    score: 0
  };
  let second = {
    idx: -1,
    score: 0
  };

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
      for (const t of qToks)
        if (svcSet.has(t)) hit++;
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
      best = {
        idx: i,
        score
      };
    } else if (score > second.score) {
      second = {
        idx: i,
        score
      };
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

export function pickBookingMatchFromFreeText(raw, list) {
  const idx = pickBookingIndexFromFreeText(raw, list);
  if (Number.isFinite(idx)) return {
    kind: "hit",
    idx
  };

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
      for (const t of qToks)
        if (svcSet.has(t)) hit++;
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

    if (score > 0) scored.push({
      idx: i,
      score
    });
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
    return {
      kind: "ambiguous",
      candidates: top.map((x) => x.idx)
    };
  }

  return null;
}
