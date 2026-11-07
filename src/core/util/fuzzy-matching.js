/**
 * Pure fuzzy text matching utilities.
 * Kept isolated from the booking flow for deterministic testing.
 */
import { simpleNorm } from "./text-utils.js";

export function levenshtein(a, b, maxDist = null) {
  let A = String(a ?? "");
  let B = String(b ?? "");
  if (A === B) return 0;

  // canonicalizza per memoria/caching (distanza simmetrica)
  if (B.length > A.length) {
    const t = A;
    A = B;
    B = t;
  }

  const al = A.length,
    bl = B.length;
  if (!al) return bl;
  if (!bl) return al;

  const md = Number.isFinite(maxDist) ? Math.max(0, Math.floor(maxDist)) : null;
  if (md != null && Math.abs(al - bl) > md) return md + 1;

  // cache piccola per token/phrase (molte ripetizioni nel bot)
  let cache = null;
  let cacheKey = null;
  try {
    const MAX_CACHE_LEN = 80;
    if (al <= MAX_CACHE_LEN && bl <= MAX_CACHE_LEN) {
      cache = levenshtein._cache || (levenshtein._cache = new Map());
      cacheKey = (A <= B) ? (A + "\u0000" + B) : (B + "\u0000" + A);

      const hit = cache.get(cacheKey);
      if (typeof hit === "number") {
        // se md è presente e il valore è già > md, va bene lo stesso
        if (md == null || hit <= md) return hit;
        return hit;
      }

      if (cache.size > 8000) cache.clear();
    }
  } catch {
    cache = null;
    cacheKey = null;
  }

  const INF = md != null ? md + 1 : 1e9;

  // OSA distance (Levenshtein + trasposizione adiacente)
  let prevPrev = new Array(bl + 1);
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);

  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let j = 0; j <= bl; j++) prevPrev[j] = INF;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];

    const startJ = md != null ? Math.max(1, i - md) : 1;
    const endJ = md != null ? Math.min(bl, i + md) : bl;

    for (let j = 1; j < startJ; j++) cur[j] = INF;

    const Ai1 = A.charCodeAt(i - 1);
    const Ai2 = i > 1 ? A.charCodeAt(i - 2) : -1;

    for (let j = startJ; j <= endJ; j++) {
      const Bj1 = B.charCodeAt(j - 1);
      const cost = Ai1 === Bj1 ? 0 : 1;

      let best = prev[j] + 1; // delete
      const ins = cur[j - 1] + 1; // insert
      if (ins < best) best = ins;

      const sub = prev[j - 1] + cost; // substitute
      if (sub < best) best = sub;

      // trasposizione adiacente
      if (i > 1 && j > 1) {
        const Bj2 = B.charCodeAt(j - 2);
        if (Ai1 === Bj2 && Ai2 === Bj1) {
          const tr = prevPrev[j - 2] + 1;
          if (tr < best) best = tr;
        }
      }

      cur[j] = best;
      if (best < rowMin) rowMin = best;
    }

    for (let j = endJ + 1; j <= bl; j++) cur[j] = INF;

    if (md != null && rowMin > md) return md + 1;

    const tmp = prevPrev;
    prevPrev = prev;
    prev = cur;
    cur = tmp;
  }

  const res = prev[bl];

  try {
    if (cache && cacheKey && (md == null || res <= md)) cache.set(cacheKey, res);
  } catch { }

  return res;
}

// Match “quasi uguale” su token (preferisce Damerau, fallback a levenshtein)
export function isTypoClose(a = "", b = "", maxDist = null) {
  const x = String(a || "").toLowerCase().trim();
  const y = String(b || "").toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;

  const md = Number.isFinite(maxDist) ?
    Math.max(0, Math.floor(maxDist)) :
    (typeof typoMaxDist === "function" ? typoMaxDist(Math.max(x.length, y.length)) : 2);

  if (md <= 0) return false;

  // token molto corti: niente fuzzy (troppi falsi positivi)
  if (Math.min(x.length, y.length) <= 3) return false;
  if (Math.abs(x.length - y.length) > md) return false;

  // anti falsi-positivi: per distanze >=2, richiedi prefisso coerente
  if (md >= 2) {
    if ((x[0] || "") !== (y[0] || "")) return false;
    if (md >= 3 && (x[1] || "") && (y[1] || "") && (x[1] !== y[1])) return false;
  }

  try {
    if (typeof dlDist === "function") return dlDist(x, y, md) <= md;
    if (typeof levenshtein === "function") return levenshtein(x, y, md) <= md;
  } catch { }
  return false;
}
// - supports optional maxDist: if distance > maxDist returns maxDist+1 (fast fail)
export function dlDist(a = "", b = "", maxDist = null) {
  const x = String(a);
  const y = String(b);

  // Preferisci la versione ottimizzata (implementata sotto come levenshtein OSA)
  try {
    if (typeof levenshtein === "function") return levenshtein(x, y, maxDist);
  } catch { }

  // Fallback minimal: Levenshtein classico (2 righe) senza trasposizione
  const al = x.length,
    bl = y.length;
  if (!al) return bl;
  if (!bl) return al;

  const md = Number.isFinite(maxDist) ? Math.max(0, Math.floor(maxDist)) : null;
  if (md != null && Math.abs(al - bl) > md) return md + 1;

  let A = x,
    B = y;
  if (B.length > A.length) {
    const t = A;
    A = B;
    B = t;
  }
  const n = A.length,
    m = B.length;

  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  const INF = md != null ? md + 1 : 1e9;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];

    const startJ = md != null ? Math.max(1, i - md) : 1;
    const endJ = md != null ? Math.min(m, i + md) : m;

    for (let j = 1; j < startJ; j++) cur[j] = INF;

    for (let j = startJ; j <= endJ; j++) {
      const cost = A.charCodeAt(i - 1) === B.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;

      let v = del;
      if (ins < v) v = ins;
      if (sub < v) v = sub;

      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }

    for (let j = endJ + 1; j <= m; j++) cur[j] = INF;

    if (md != null && rowMin > md) return md + 1;

    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  return prev[m];
}

export function typoSim(a = "", b = "") {
  const L = Math.max(a.length, b.length) || 1;
  return 1 - dlDist(a, b) / L; // 0..1
}

// Max distanza “sensata” in base alla lunghezza (evita fuzzy troppo aggressivo)
export function typoMaxDist(len = 0) {
  const L = Math.max(0, Number(len) || 0);
  if (L <= 3) return 0;
  if (L <= 5) return 1;
  if (L <= 8) return 2;
  if (L <= 12) return 3;
  return 4;
}

// Match “quasi uguale” su token (preferisce Damerau, fallback a levenshtein)
// Comandi tipo “modifca”, “anulla”, “cancellaa” ecc.
export function fuzzyCmd(text, cmds = [], opts = {}) {
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
