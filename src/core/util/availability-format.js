// ==== UX: Messaggi disponibilità compatti (max 5 orari) ====
export const AVAIL_PAGE_SIZE = 5;

function __hhmmToMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  return h * 60 + mm;
}

function __compactHHMM(hhmm) {
  const m = String(hhmm || "").match(/^0?(\d{1,2}):([0-5]\d)$/);
  if (!m) return String(hhmm || "");
  return `${Number(m[1])}:${m[2]}`;
}

function __fmtDateShortIT(d) {
  try {
    return fmtDateLongIT(d, {
      includeYear: false
    });
  } catch {
    return "";
  }
}

export function fmtWeekdayDateShortIT(d) {
  try {
    const D = d instanceof Date ? d : new Date(d);
    const wd = new Intl.DateTimeFormat("it-IT", {
      weekday: "long"
    }).format(D);
    const cap = wd ? (wd[0].toUpperCase() + wd.slice(1)) : "";
    return `${cap} ${__fmtDateShortIT(D)}`.trim();
  } catch {
    return __fmtDateShortIT(d);
  }
}

//  Formato "umano": "lunedì 2 febbraio"
export function fmtWeekdayDateLongIT(d, {
  capitalizeWeekday = true
} = {}) {
  try {
    const D = d instanceof Date ? d : new Date(d);
    if (!D || Number.isNaN(D.getTime())) return "";
    let s = new Intl.DateTimeFormat("it-IT", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(D); // es: "lunedì 2 febbraio"
    if (capitalizeWeekday && s) s = s[0].toUpperCase() + s.slice(1);
    return s;
  } catch {
    return "";
  }
}

//  Formato data senza slash: "2 gennaio" (opzionale anno)
export function fmtDateLongIT(d, {
  includeYear = false
} = {}) {
  try {
    if (d === null || typeof d === "undefined" || d === "") return "";
    const D = d instanceof Date ? d : new Date(d);
    if (!D || Number.isNaN(D.getTime())) return "";
    const opts = includeYear ? {
      day: "numeric",
      month: "long",
      year: "numeric"
    } : {
      day: "numeric",
      month: "long"
    };
    return new Intl.DateTimeFormat("it-IT", opts).format(D);
  } catch {
    return "";
  }
}

export function uniqueTimesFromSlots(slots) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(slots) ? slots : []) {
    const t = typeof s === "string" ? s : (s?.time || "");
    if (!/^\d{2}:\d{2}$/.test(String(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort((a, b) => (__hhmmToMinutes(a) ?? 0) - (__hhmmToMinutes(b) ?? 0));
  return out;
}

export function filterSlotsByDaypart(slots, part) {
  const p = String(part || "").toLowerCase().trim();
  if (!p) return Array.isArray(slots) ? slots : [];
  const list = Array.isArray(slots) ? slots : [];
  const inRange = (tMin) => {
    if (tMin == null) return false;
    if (p === "mattina") return tMin < 13 * 60;
    if (p === "pomeriggio") return tMin >= 13 * 60 && tMin < 18 * 60;
    if (p === "sera") return tMin >= 18 * 60;
    return true;
  };
  return list.filter((s) => inRange(__hhmmToMinutes(typeof s === "string" ? s : s?.time)));
}

function __inferAvailStepMin(times) {
  try {
    const mins = (Array.isArray(times) ? times : [])
      .map(__hhmmToMinutes)
      .filter((x) => x != null)
      .sort((a, b) => a - b);

    if (mins.length < 3) return 15;

    const freq = new Map();
    for (let i = 1; i < mins.length; i++) {
      const d = mins[i] - mins[i - 1];
      if (!Number.isFinite(d) || d <= 0) continue;
      if (d < 5 || d > 120) continue;
      freq.set(d, (freq.get(d) || 0) + 1);
    }

    // step più frequente (fallback 15)
    let best = 15;
    let bestCnt = -1;
    for (const [d, c] of freq.entries()) {
      if (c > bestCnt) {
        best = d;
        bestCnt = c;
      }
    }

    return best;
  } catch {
    return 15;
  }
}

// Converte lista di orari (HH:MM) in "items" compatti: orari singoli + range (es. "10:00–12:30")
function __availItemsFromSlots(slots, {
  minRun = 4,
  stepMin
} = {}) {
  const times = uniqueTimesFromSlots(slots);
  if (!times.length) return [];

  const step = Number.isFinite(stepMin) ? Number(stepMin) : __inferAvailStepMin(times);
  const runMin = Math.max(3, Number(minRun || 4) || 4);

  const items = [];
  let i = 0;

  while (i < times.length) {
    let j = i;

    while (j + 1 < times.length) {
      const a = __hhmmToMinutes(times[j]);
      const b = __hhmmToMinutes(times[j + 1]);
      if (a == null || b == null) break;
      if (b - a !== step) break;
      j++;
    }

    const runLen = j - i + 1;

    if (runLen >= runMin) {
      items.push(`dalle ${__compactHHMM(times[i])} alle ${__compactHHMM(times[j])}`);
    } else {
      for (let k = i; k <= j; k++) items.push(__compactHHMM(times[k]));
    }

    i = j + 1;
  }

  return items;
}

/**
 * Messaggio disponibilità super-chiaro per WhatsApp (senza paginazione, senza scelte numerate)
 * - Mostra TUTTI gli orari del giorno
 * - Etichette esplicite (Mattina/Pomeriggio/Sera)
 * - Spiega che sono orari di INIZIO appuntamento
 */
export function buildAvailabilityCompactMessage(day, slots, opts = {}) {
  // ==================== CONFIGURAZIONE ====================
  const DEFAULT_STEP_MIN = 30;
  const MAX_STEP_DIFF = 240;

  const RANGE_MIN_COUNT = Math.max(2, Number(opts.rangeMinCount ?? 3) || 3); // min 3 slot consecutivi per fare un range
  const USE_RANGES = opts.useRanges === true; // default true

  // per WhatsApp: righe non infinite
  const MAX_LINE_CHARS = Math.max(30, Number(opts.maxLineChars ?? 120) || 120);

  const TIME_GROUPS = {
    mattina: {
      label: 'Mattina',
      start: 0,
      end: 13
    },
    pomeriggio: {
      label: 'Pomeriggio',
      start: 13,
      end: 18
    },
    sera: {
      label: 'Sera',
      start: 18,
      end: 24
    }
  };

  // ==================== HELPER ORARI ====================
  const toMinutes = (time) => {
    const str = String(time ?? '').trim();
    const match = str.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!match) return NaN;

    let h = Number(match[1]);
    let m = Number(match[2] ?? 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;

    h = Math.max(0, Math.min(24, h));
    m = Math.max(0, Math.min(59, m));
    if (h === 24 && m !== 0) return NaN; // consenti solo 24:00

    return h * 60 + m;
  };

  const formatTime = (time) => {
    const minutes = toMinutes(time);
    if (!Number.isFinite(minutes)) return String(time ?? '').trim();

    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    if (hh === 24 && mm === 0) return '24:00';

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const addMinutes = (hhmm, add) => {
    const base = toMinutes(hhmm);
    if (!Number.isFinite(base)) return hhmm;

    let t = base + add;
    t = Math.max(0, Math.min(24 * 60, t));

    const hh = Math.floor(t / 60);
    const mm = t % 60;
    if (hh === 24 && mm === 0) return '24:00';

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const extractUniqueTimes = (slots) => {
    const set = new Set();
    for (const slot of slots || []) {
      const raw =
        typeof slot === 'string' ?
          slot :
          slot?.time || slot?.start || slot?.hour || slot?.from || slot?.at || '';

      const t = formatTime(raw);
      if (Number.isFinite(toMinutes(t))) set.add(t);
    }
    return Array.from(set).sort((a, b) => toMinutes(a) - toMinutes(b));
  };

  // ==================== INFERENZA STEP ====================
  const inferStepMinutes = (times) => {
    const minutes = times.map(toMinutes).filter(Number.isFinite).sort((a, b) => a - b);
    if (minutes.length < 2) return DEFAULT_STEP_MIN;

    const diffs = [];
    for (let i = 1; i < minutes.length; i++) {
      const d = minutes[i] - minutes[i - 1];
      if (d > 0 && d <= MAX_STEP_DIFF) diffs.push(d);
    }
    if (!diffs.length) return DEFAULT_STEP_MIN;

    const freq = new Map();
    for (const d of diffs) freq.set(d, (freq.get(d) || 0) + 1);

    let best = diffs[0];
    let bestCount = 0;
    for (const [step, count] of freq.entries()) {
      if (count > bestCount || (count === bestCount && step < best)) {
        best = step;
        bestCount = count;
      }
    }
    return best;
  };

  // ==================== WRAP & FORMAT “UMANO” ====================
  const wrapTokens = (tokens, sep = ' • ', maxChars = 46) => {
    const lines = [];
    let current = '';

    for (const tok of tokens) {
      if (!current) {
        current = tok;
        continue;
      }
      const candidate = current + sep + tok;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        lines.push(current);
        current = tok;
      }
    }
    if (current) lines.push(current);
    return lines.join('\n');
  };

  const getTimeGroup = (time) => {
    const mins = toMinutes(time);
    if (!Number.isFinite(mins)) return null;
    const hour = Math.floor(mins / 60);

    for (const [name, cfg] of Object.entries(TIME_GROUPS)) {
      if (hour >= cfg.start && hour < cfg.end) return name;
    }
    return null;
  };

  /**
   * - Range SOLO su consecutivi veri (diff === step)
   * - Range con fine “vera” = ultimo slot + step
   * - Se pochi orari, lascia lista semplice
   */
  const formatTimesSmart = (times, stepMinutes) => {
    if (!times?.length) return '';

    const sorted = [...times].sort((a, b) => toMinutes(a) - toMinutes(b));
    const chunks = [];

    let run = [sorted[0]];

    const flush = () => {
      if (!run.length) return;

      if (USE_RANGES && run.length >= RANGE_MIN_COUNT) {
        const start = run[0];
        const end = addMinutes(run[run.length - 1], stepMinutes);
        chunks.push(`${start}–${end}`);
      } else {
        for (const t of run) chunks.push(t);
      }
      run = [];
    };

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const diff = toMinutes(cur) - toMinutes(prev);

      if (diff === stepMinutes) {
        run.push(cur);
      } else {
        flush();
        run = [cur];
      }
    }
    flush();

    return wrapTokens(chunks, ' • ', MAX_LINE_CHARS);
  };

  // ==================== LOGICA PRINCIPALE ====================
  const dayLabel =
    (typeof fmtWeekdayDateLongIT === "function" ? fmtWeekdayDateLongIT(day) : fmtWeekdayDateShortIT(day));
  const allTimes = extractUniqueTimes(slots);

  if (!allTimes.length) {
    return [
      `*${dayLabel}*`,
      `Nessun orario libero.`,
      `Scrivi un altro giorno (es. "domani").`
    ].join('\n');
  }

  const inferredStep = inferStepMinutes(allTimes);
  const stepMinutes = Math.max(1, Number(opts.stepMin ?? inferredStep) || inferredStep);

  // raggruppa tutti gli orari
  const timesByGroup = {
    mattina: [],
    pomeriggio: [],
    sera: []
  };
  for (const time of allTimes) {
    const g = getTimeGroup(time) || 'mattina';
    (timesByGroup[g] ||= []).push(time);
  }

  // Raggruppa gli orari con intestazioni testuali.
  const groupLines = [];
  for (const [groupName, times] of Object.entries(timesByGroup)) {
    if (!times.length) continue;

    const cfg = TIME_GROUPS[groupName] || { label: 'Orari' };
    const formatted = formatTimesSmart(times, stepMinutes);

    // Se va su più righe, indenta bene (più leggibile per tutti)
    const formattedLines = String(formatted).split('\n');
    groupLines.push(
      `${cfg.label}: ${formattedLines[0]}` +
      (formattedLines.length > 1 ? `\n${formattedLines.slice(1).join('\n')}` : '')
    );

  }

  const serviceName = String(opts.serviceName ?? '').trim();
  const durMin = Number(opts.serviceDurationMin);
  const durLine = Number.isFinite(durMin) && durMin > 0 ? `Durata indicativa: *${durMin} min*` : '';

  const headerExplain = [
    `Orari disponibili${serviceName ? ` per ${serviceName}` : ''}.`,
    durLine
  ].filter(Boolean).join('\n');

  return [
    `${dayLabel}`,
    headerExplain,
    '',
    ...groupLines,
    '',
    `Rispondi scrivendo l’orario che preferisci (es. 10:30).`,
    `Per cambiare giorno: scrivi "domani" oppure "venerdì".`,
    `Per annullare: scrivi "annulla".`
  ].join('\n');
}

function atNoonLocal(dateLike) {
  const d = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
  d.setHours(12, 0, 0, 0);
  return d;
}

export function validateDateInRange(d, maxDays = 30) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    const now = new Date();
    const diff = Math.ceil((dt - atNoonLocal(now)) / (24 * 60 * 60 * 1000));
    return diff >= 0 && diff <= maxDays;
  } catch (e) {
    return false;
  }
}

// Helper robusto per scelte numeriche "1", "1)", "1.", ecc.
// allowZero=true permette "0" (nessuna preferenza).
export function parseListIndex(raw, max, allowZero = false) {
  const s = String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u00a0]/g, "")
    .trim();

  const m = s.match(/^(\d+)\s*[\)\.\-]?$/);
  if (!m) return NaN;

  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return NaN;

  if (max == null) return n;

  if (allowZero) {
    return n >= 0 && n <= max ? n : NaN;
  }

  return n >= 1 && n <= max ? n : NaN;
}

//  Rileva urgenze (unghia rotta / dolore / problema da sistemare) -> devia su chiamata
