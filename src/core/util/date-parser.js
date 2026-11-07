import { log } from './logger.js';

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
export function parseUnifiedDate(text, baseDate = new Date()) {
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
    baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ?
      new Date(baseDate) :
      new Date();

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
        if (m > 11) {
          m = 0;
          y += 1;
        }
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
          if (m > 11) {
            m = 0;
            y += 1;
          }
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
    const d = parseDaySmart(String(text), {
      baseDate: baseDay
    });
    if (d && !Number.isNaN(d.getTime())) return setNoon(new Date(d));
  }

  return null;
}

/**
 * Wrapper sicuro per prevenire loop
 */
export function safeParseDateWithLock(chatIdOrText, maybeText, maybeBaseDate) {
  // Supporta sia safeParseDateWithLock(chatId, text) che safeParseDateWithLock(text)
  const hasChatIdAndText =
    typeof maybeText !== "undefined" &&
    (typeof maybeText === "string" || typeof maybeText === "number");

  const chatKey = hasChatIdAndText ? String(chatIdOrText || "GLOBAL") : "GLOBAL";
  const text = hasChatIdAndText ? maybeText : chatIdOrText;
  const baseDate = hasChatIdAndText ? (maybeBaseDate || null) : (maybeText || null);

  // Previeni parsing ricorsivo per la stessa chat
  if (__dateParsingInProgress.has(chatKey)) {
    log("warn", "[DATE] Parsing già in corso, ignoro", {
      chatId: chatKey
    });
    return null;
  }

  try {
    __dateParsingInProgress.add(chatKey);
    return parseUnifiedDate(text, baseDate || undefined);
  } finally {
    __dateParsingInProgress.delete(chatKey);
  }
}
