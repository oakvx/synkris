import { fmtDateLongIT } from "./availability-format.js";

import { norm, _norm } from "./text-utils.js";



// Date/time formatting and parsing helpers extracted from core util.

function toISOStringLocal(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60_000);
  // yyyy-mm-ddThh:mm:ss
  return local.toISOString().slice(0, 19);
}

function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

function monthLabelIT(idx) {
  const m = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ];
  return m[idx] ?? "";
}

function itaWeekdayName(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const names = ["domenica", "lunedì", "martedì", "mercoledì",
    "giovedì", "venerdì", "sabato"
  ];
  return names[d.getDay()] || "";
}

function listNextWeekDays() {
  const now = new Date();
  const isoToday = now.getDay() === 0 ? 7 : now.getDay(); // 1..7
  const deltaToNextMon = (8 - isoToday) % 7 || 7; // giorni fino al prossimo lunedì
  const mon = new Date(now);
  mon.setDate(now.getDate() + deltaToNextMon);
  mon.setHours(12, 0, 0, 0);
  return Array.from({
    length: 7
  },
    (_, i) =>
      new Date(
        mon.getFullYear(),
        mon.getMonth(),
        mon.getDate() + i,
        12,
        0,
        0,
        0
      )
  );
}

function buildAskDayOfMonthPrompt(year, monthIdx) {
  const max = daysInMonth(year, monthIdx);
  return `Quale giorno di ${monthLabelIT(monthIdx)} ${year}? (1-${max})`;
}

function fmtDate(d) {
  if (d === null || typeof d === "undefined" || d === "") return "";
  const D = d instanceof Date ? d : new Date(d);
  if (!D || Number.isNaN(D.getTime())) return "";
  if (D.getFullYear && D.getFullYear() <= 1971) return "";
  return fmtDateLongIT(D, {
    includeYear: true
  });
}

function fmtDateWithWeekdayIT(d) {
  if (d === null || typeof d === "undefined" || d === "") return "";
  const D = d instanceof Date ? d : new Date(d);
  if (!D || Number.isNaN(D.getTime())) return "";
  if (D.getFullYear && D.getFullYear() <= 1971) return "";
  const wd = typeof itaWeekdayName === "function" ? itaWeekdayName(D) : "";
  const ds = fmtDate(D);
  return wd ? `${wd} ${ds}` : ds;
}

function _buildRescheduleConfirmation(prevStartISO, nextStartISO) {
  try {
    const prev = prevStartISO ? new Date(prevStartISO) : null;
    const next = nextStartISO ? new Date(nextStartISO) : null;

    if (!next || Number.isNaN(next.getTime())) return " Prenotazione aggiornata.";

    const hhmm = (D) =>
      `${String(D.getHours()).padStart(2, "0")}:${String(D.getMinutes()).padStart(2, "0")}`;

    const sameDate =
      prev &&
      !Number.isNaN(prev.getTime()) &&
      prev.getFullYear() === next.getFullYear() &&
      prev.getMonth() === next.getMonth() &&
      prev.getDate() === next.getDate();

    const sameTime =
      prev &&
      !Number.isNaN(prev.getTime()) &&
      hhmm(prev) === hhmm(next);

    const nextDayLabel =
      typeof fmtDateWithWeekdayIT === "function" ?
        fmtDateWithWeekdayIT(next) :
        next.toLocaleDateString("it-IT");
    const nextTime = hhmm(next);

    if (sameDate && !sameTime) return ` Appuntamento spostato alle ${nextTime}.`;
    if (!sameDate && sameTime) return ` Appuntamento spostato a ${nextDayLabel}.`;
    if (!sameDate && !sameTime) return ` Appuntamento spostato a ${nextDayLabel} alle ${nextTime}.`;
    return " Prenotazione aggiornata.";
  } catch {
    return " Prenotazione aggiornata.";
  }
}

function timeToMinutes(hhmm) {
  const parts = String(hhmm || "").split(":");
  const h = Number(parts[0] || 0);
  const m = Number(parts[1] || 0);
  return h * 60 + (m || 0);
}

function minutesToHHMM(min) {
  const H = Math.floor(min / 60);
  const M = min % 60;
  const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
  return `${pad2(H)}:${pad2(M)}`;
}

function formatDurationMin(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  if (!m) return `${h}h`;
  return `${h}h ${m}min`;
}

function compareHHMM(a, b) {
  return timeToMinutes(a) - timeToMinutes(b);
}

function parseNaturalTime(s = "") {
  const t = norm(s);
  if (!t) return null;

  const txt = String(t).trim();

  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (h, m) => {
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${pad2(h)}:${pad2(m)}`;
  };

  const normSpaces = (x) => String(x || "").trim().replace(/\s+/g, " ");

  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---- Meridiem / contesto (soft) ----
  const ctxAM = /\b(?:mattina|stamattina|domattina)\b/.test(txt);
  const ctxPM = /\b(?:pomeriggio|sera|stasera)\b/.test(txt);

  const applyMeridiem = (h, localMer) => {
    let hh = h;
    const mer = localMer ? localMer.toLowerCase().replace(/\./g, "") : null;

    if (mer === "pm") hh = (hh % 12) + 12;
    else if (mer === "am") hh = hh % 12; // 12am => 0
    else if (ctxPM && !ctxAM && hh < 12) hh += 12;

    return hh;
  };

  // ---- Speciali ----
  if (/\bmezzogiorn/.test(txt)) return "12:00";
  if (/\bmezzanott/.test(txt)) return "00:00";

  // ---- Parole -> numeri (ore/minuti) ----
  const HOUR_WORDS = {
    zero: 0,
    una: 1,
    uno: 1,
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
    "venti uno": 21,
    ventidue: 22,
    "venti due": 22,
    ventitre: 23,
    "venti tre": 23,
  };

  const MIN_WORDS = [
    ["tre quarti", 45],
    ["trequarti", 45],
    ["un quarto", 15],
    ["unquarto", 15],
    ["quarto", 15],
    ["quindici", 15],
    ["venticinque", 25],
    ["venti cinque", 25],
    ["venti", 20],
    ["dieci", 10],
    ["cinque", 5],
    ["mezza", 30],
    ["mezzo", 30],
    ["trenta", 30],
    ["quaranta", 40],
    ["cinquanta", 50],
    ["cinquantacinque", 55],
  ].sort((a, b) => b[0].length - a[0].length);

  const parseHourToken = (tok) => {
    const k = normSpaces(tok).toLowerCase();
    if (/^\d{1,2}$/.test(k)) return +k;
    if (HOUR_WORDS[k] != null) return HOUR_WORDS[k];
    return null;
  };

  const parseMinToken = (tok) => {
    const k = normSpaces(tok).toLowerCase();
    if (/^\d{1,2}$/.test(k)) return +k;
    for (const [key, val] of MIN_WORDS) {
      if (new RegExp(`\\b${escapeRegExp(key)}\\b`).test(k)) return val;
    }
    return null;
  };

  // Token ora: numero o parole (es. "nove", "venti due")
  const H_TOKEN = `(?:[01]?\\d|2[0-3]|[a-z]+(?:\\s+[a-z]+)?)`;
  const M_TOKEN = `(?:[0-5]?\\d|[a-z]+(?:\\s+[a-z]+)?)`;

  // 1) "9:30" / "9.30" / "9,30" / "9h30" (+ opzionale am/pm)
  {
    const m = txt.match(
      /\b([01]?\d|2[0-3])\s*(?:[:\.]|,|h)\s*([0-5]?\d)\s*(?:\s*(a\.?m\.?|p\.?m\.?|am|pm))?\b/
    );
    if (m) {
      const h = applyMeridiem(+m[1], m[3]);
      const mm = +m[2];
      const out = clamp(h, mm);
      if (out) return out;
    }
  }

  // 2) "9 e 30" / "alle nove e mezza" / "ore 9 e un quarto"
  {
    const re = new RegExp(
      `\\b(?:alle?\\s+|ore\\s+|h\\s*|dalle\\s+)?(${H_TOKEN})\\s*(?:\\b(?:e|ed)\\b)\\s*(${M_TOKEN})\\b`,
      "i"
    );
    const m = txt.match(re);
    if (m) {
      const h0 = parseHourToken(m[1]);
      const mm0 = parseMinToken(m[2]);
      if (h0 != null && mm0 != null) {
        const h = applyMeridiem(h0, null);
        const out = clamp(h, mm0);
        if (out) return out;
      }
    }
  }

  // 3) "10 meno 20" / "dieci meno un quarto"
  {
    const reNum = new RegExp(
      `\\b(?:alle?\\s+|ore\\s+|h\\s*)?(${H_TOKEN})\\s*meno\\s*(${M_TOKEN})\\b`,
      "i"
    );
    const m = txt.match(reNum);
    if (m) {
      const hRaw = parseHourToken(m[1]);
      const mmRaw = parseMinToken(m[2]);
      if (hRaw != null && mmRaw != null) {
        const hMer = applyMeridiem(hRaw, null);
        const h = (hMer - 1 + 24) % 24;
        const mm = 60 - mmRaw;
        const out = clamp(h, mm);
        if (out) return out;
      }
    }
  }

  // 4) "930" / "0930" (solo se messaggio è “time-like” o c’è keyword)
  {
    const only = /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{3,4}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
      txt
    );
    const hasKw = /\b(?:alle?|ore|h|dalle)\b/.test(txt);

    if (only || hasKw) {
      const m = txt.match(/\b(\d{3,4})\b/);
      if (m) {
        const n = m[1];
        let hh, mm;
        if (n.length === 3) {
          hh = +n.slice(0, 1);
          mm = +n.slice(1);
        } else {
          hh = +n.slice(0, 2);
          mm = +n.slice(2);
        }
        if (hh <= 23 && mm <= 59) {
          const mer = txt.match(/\b(a\.?m\.?|p\.?m\.?|am|pm)\b/i)?.[1] || null;
          const h = applyMeridiem(hh, mer);
          const out = clamp(h, mm);
          if (out) return out;
        }
      }
    }
  }

  // 5) "ore 9", "h9", "alle 9", "nove" (solo se “time-like” o con keyword)
  {
    const only =
      /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?[a-z0-9]+(?:\s+[a-z]+)?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
        txt
      );

    // se è una frase lunga, accetta solo se c’è keyword (evita date tipo "25 dicembre")
    const allow =
      only || /\b(?:alle?|ore|h|dalle)\b/.test(txt);

    if (allow) {
      const re = new RegExp(
        `\\b(?:alle?\\s+|ore\\s+|h\\s*)?(${H_TOKEN})\\s*(?:\\b|$)\\s*(?:\\s*(a\\.?(?:m)\\.?|p\\.?(?:m)\\.?|am|pm))?\\b`,
        "i"
      );
      const m = txt.match(re);
      if (m) {
        const h0 = parseHourToken(m[1]);
        if (h0 != null) {
          const h = applyMeridiem(h0, m[2]);
          const out = clamp(h, 0);
          if (out) return out;
        }
      }
    }
  }

  // 6) "9 30" (spazio) SOLO se è chiaramente un orario (evita "25 12" = data)
  {
    const m = txt.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/);
    if (m) {
      const isSafe =
        /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{1,2}\s+\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\s*$/i.test(
          txt
        ) || /\b(?:alle?|ore|h|dalle)\b/.test(txt);

      if (isSafe) {
        const mer = txt.match(/\b(a\.?m\.?|p\.?m\.?|am|pm)\b/i)?.[1] || null;
        const h = applyMeridiem(+m[1], mer);
        const out = clamp(h, +m[2]);
        if (out) return out;
      }
    }
  }

  return null;
}

function parseTimeRangeFallback(s = "") {
  if (!s) return null;

  const t = String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (h, m) => {
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${pad2(h)}:${pad2(m)}`;
  };

  // Attiva fallback solo se ci sono indizi di "range/approssimazione"
  // (evita di sovrascrivere date reali tipo 11/12 come "orario")
  const hasTimeHint =
    /\b(verso|intorn(?:o|a)|circa|tipo|dalle|tra|fra|entro|ore|alle|h|mattin|pomerigg|sera|tarda|pranzo|cena)\b/i.test(
      t
    );

  // Se la stringa contiene una data "forte" (gg/mm/aaaa o gg-mm-aaaa), non attivare
  const hasStrongDate =
    /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(t) ||
    /\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b/.test(t);

  if (!hasTimeHint || hasStrongDate) return null;

  // Pattern: "11 dicembre" "11-12" "11 – 12" "11 / 12"
  // Nota: SOLO ore (0-23), senza minuti.
  const m = t.match(/\b([01]?\d|2[0-3])\s*[\/\-–-]\s*([01]?\d|2[0-3])\b/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Se sembra un range "orario" vero (a < b) o invertito (b < a), scegli un punto sensato:
  // - se adiacenti: :30 (tra le due ore)
  // - altrimenti: ora più bassa con :00
  // - caso wrap (23-0 o 0-23): scegli 23:30 per 23/0, e 00:30 per 0/1 ecc.
  const diff = Math.abs(a - b);
  const isWrap = (a === 23 && b === 0) || (a === 0 && b === 23);

  let hh;
  let mm;

  if (isWrap) {
    hh = 23;
    mm = 30;
  } else if (diff === 1) {
    hh = Math.min(a, b);
    mm = 30;
  } else {
    hh = Math.min(a, b);
    mm = 0;
  }

  return clamp(hh, mm);
}

function parseTimeSmart(s = "") {
  const raw = String(s ?? "");

  // Preferisci orari introdotti da keyword ("alle", "ore", "h") per evitare
  // falsi positivi tipo: "il 13 alle 17" -> non prendere 13:00 (giorno), ma 17:00 (orario).
  try {
    const cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, " ");
    const kwRe = /\b(?:alle?|ore|h|dalle)\b/gi;

    const hits = [];
    let m;
    while ((m = kwRe.exec(cleaned)) !== null) hits.push(m.index);

    // Prova dalla keyword PIÙ a destra (tipicamente l'orario è lì vicino)
    for (let i = hits.length - 1; i >= 0; i--) {
      const sub = cleaned.slice(hits[i]);
      const t = parseHHMM(sub) || parseNaturalTime(sub) || parseTimeRangeFallback(sub);
      if (t) return t;
    }
  } catch {
    // no-op
  }

  return parseHHMM(raw) || parseNaturalTime(raw) || parseTimeRangeFallback(raw);
}

function parseHHMM(s) {
  const t = (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return null;

  const pad2 = (n) => String(n).padStart(2, "0");
  const clamp = (h, m) => {
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${pad2(h)}:${pad2(m)}`;
  };

  // euristica: se la stringa è "time-like" oppure contiene keyword
  const isTimeLike =
    /^\s*(?:alle?\s+|ore\s+|h\s*|dalle\s+)?\d{1,4}(?:\s*[:.,h]\s*\d{1,2})?\s*(?:am|pm)?\s*$/i.test(
      t
    ) || /\b(?:alle?|ore|h|dalle)\b/.test(t);

  // 1) 12h: "10pm", "10 pm", "10:30pm", "10.30 pm"
  {
    const m = t.match(
      /\b(1[0-2]|0?[1-9])\s*(?:[:.,h]|\s)\s*([0-5]\d)?\s*(am|pm)\b/
    );
    if (m) {
      let h = +m[1];
      const mm = m[2] != null ? +m[2] : 0;
      const ap = m[3];

      if (ap === "am") {
        if (h === 12) h = 0;
      } else {
        if (h !== 12) h += 12;
      }

      const out = clamp(h, mm);
      if (out) return out;
    }
  }

  // 2) 12h: "930pm" / "0930pm"
  {
    const m = t.match(/\b(\d{3,4})\s*(am|pm)\b/);
    if (m) {
      const n = m[1];
      let h = 0,
        mm = 0;

      if (n.length === 3) {
        h = +n.slice(0, 1);
        mm = +n.slice(1);
      } else {
        h = +n.slice(0, 2);
        mm = +n.slice(2);
      }

      if (h >= 1 && h <= 12 && mm >= 0 && mm <= 59) {
        const ap = m[2];
        if (ap === "am") {
          if (h === 12) h = 0;
        } else {
          if (h !== 12) h += 12;
        }
        const out = clamp(h, mm);
        if (out) return out;
      }
    }
  }

  // 3) 24h: "9:30", "9.30", "9,30", "9h30"
  {
    const m = t.match(/\b([01]?\d|2[0-3])\s*[:.,h]\s*([0-5]?\d)\b/);
    if (m) {
      const out = clamp(+m[1], +m[2]);
      if (out) return out;
    }
  }

  // 4) 24h: "9 30" (solo se time-like, evita "25 12" come data)
  {
    const m = t.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/);
    if (m && isTimeLike) {
      const out = clamp(+m[1], +m[2]);
      if (out) return out;
    }
  }

  // 5) 24h compatto: "930" / "0930" (solo se time-like o keyword)
  {
    const m = t.match(/\b(\d{3,4})\b/);
    if (m && isTimeLike) {
      const n = m[1];
      let h, mm;
      if (n.length === 3) {
        h = +n.slice(0, 1);
        mm = +n.slice(1);
      } else {
        h = +n.slice(0, 2);
        mm = +n.slice(2);
      }
      const out = clamp(h, mm);
      if (out) return out;
    }
  }

  // 6) 24h: hour only "9" (solo se time-like o keyword)
  {
    const m = t.match(/\b([01]?\d|2[0-3])\b/);
    if (m && isTimeLike) {
      const out = clamp(+m[1], 0);
      if (out) return out;
    }
  }

  return null;
}

function atNoon(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  return d;
}

function isoWeekday(d) {
  const D = d instanceof Date ? d : new Date(d);
  const day = D.getDay();
  return String(day === 0 ? 7 : day);
}

function nextWeekday(dayIndex) {
  const d = new Date();
  const today = d.getDay();
  const delta = (dayIndex + 7 - (today === 0 ? 7 : today)) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function itaMonthToIndex(m) {
  const months = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ];
  const short = [
    "gen",
    "feb",
    "mar",
    "apr",
    "mag",
    "giu",
    "lug",
    "ago",
    "set",
    "ott",
    "nov",
    "dic",
  ];
  const s = String(m || "").toLowerCase();
  let idx = short.indexOf(s);
  if (idx >= 0) return idx;
  idx = months.indexOf(s);
  return idx >= 0 ? idx : null;
}

function setTime(date, hhmm) {
  const parts = String(hhmm || "00:00").split(":");
  const H = Number(parts[0] || 0);
  const M = Number(parts[1] || 0);
  const d = new Date(date);
  d.setHours(H, M || 0, 0, 0);
  return d;
}

function isPast(date) {
  return date.getTime() < Date.now();
}

const DOW_IT = {
  domenica: 0,
  dom: 0,
  lunedi: 1,
  lunedì: 1,
  lun: 1,
  martedi: 2,
  martedì: 2,
  mar: 2,
  mercoledi: 3,
  mercoledì: 3,
  mer: 3,
  giovedi: 4,
  giovedì: 4,
  gio: 4,
  venerdi: 5,
  venerdì: 5,
  ven: 5,
  sabato: 6,
  sab: 6,
};

const INT_IT = {
  uno: 1,
  una: 1,
  un: 1,
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
};

function _startOfISOWeek(d) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const day = x.getDay();
  const delta = (day + 6) % 7;
  x.setDate(x.getDate() - delta);
  return x;
}

function _dateForDow(baseDate, dow, weeksOffset = 0) {
  const baseMon = _startOfISOWeek(baseDate);
  const d = new Date(baseMon);
  d.setDate(baseMon.getDate() + weeksOffset * 7 + ((dow + 6) % 7));
  d.setHours(12, 0, 0, 0);
  return d;
}

function _toInt(tok) {
  if (!tok) return null;
  const n = Number(tok);
  if (!Number.isNaN(n) && n >= 0) return n;
  return INT_IT[_norm(tok)] ?? null;
}



export {

  toISOStringLocal,

  daysInMonth,

  monthLabelIT,

  itaWeekdayName,

  listNextWeekDays,

  buildAskDayOfMonthPrompt,

  fmtDate,

  fmtDateWithWeekdayIT,

  _buildRescheduleConfirmation,

  timeToMinutes,

  minutesToHHMM,

  formatDurationMin,

  compareHHMM,

  parseNaturalTime,

  parseTimeRangeFallback,

  parseTimeSmart,

  parseHHMM,

  atNoon,

  isoWeekday,

  nextWeekday,

  itaMonthToIndex,

  setTime,

  isPast,

  DOW_IT,

  INT_IT,

  _startOfISOWeek,

  _dateForDow,

  _toInt,

};
