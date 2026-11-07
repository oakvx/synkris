/**
 * booking/availability: extracted from the booking orchestrator.
 * Dependencies are supplied by the compatibility facade (src/core/util.js).
 * Keep domain logic here; new callers should import from the facade until the
 * migration to explicit services is complete.
 */
export function createModule(dependencies, shared) {
  const {
    __dbAllPros,
    atNoon,
    cfgClosedDay,
    cfgServiceDuration,
    compareHHMM,
    config,
    getHoldIntervalsForDay,
    getServiceDurationForPro,
    isoWeekday,
    loadBookings,
    log,
    norm,
    now,
    proEmailByName,
    proNameByEmail,
    proShort,
    resolveEmailByName,
    timeToMinutes,
  } = dependencies;

function isProfessionalOffFullDay({
  professionalEmail,
  day
}) {
  if (!professionalEmail || !day) return false;

  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return false;

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  const dayKey = isoWeekday(D);
  const dayStart = new Date(D);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(D);
  dayEnd.setHours(23, 59, 59, 999);

  const unav = config.unavailability || {};
  const rules = Array.isArray(unav[professionalEmail]) ?
    unav[professionalEmail] : [];
  if (!rules.length) return false;

  const IT2NUM = {
    lun: "1",
    lunedi: "1",
    lunedì: "1",
    mar: "2",
    martedi: "2",
    martedì: "2",
    mer: "3",
    mercoledi: "3",
    mercoledì: "3",
    gio: "4",
    giovedi: "4",
    giovedì: "4",
    ven: "5",
    venerdi: "5",
    venerdì: "5",
    sab: "6",
    sabato: "6",
    dom: "7",
    domenica: "7",
  };
  const EN2NUM = {
    mon: "1",
    monday: "1",
    tue: "2",
    tuesday: "2",
    wed: "3",
    wednesday: "3",
    thu: "4",
    thursday: "4",
    fri: "5",
    friday: "5",
    sat: "6",
    saturday: "6",
    sun: "7",
    sunday: "7",
  };

  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };

  const daysMatch = (ruleDays) => {
    if (!Array.isArray(ruleDays) || ruleDays.length === 0) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };

  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };

  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const type = String(r.type || "").toLowerCase();

    // Giorno fisso della settimana
    if (type === "day" && Array.isArray(r.days)) {
      if (daysMatch(r.days) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }

    // Data/e specifiche: date / dates
    if (type === "date" || type === "dates") {
      const dates = Array.isArray(r.dates) ? r.dates : r.date ? [r.date] : [];
      if (dates.includes(toYMD(D)) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }

    // Range di date (from/to)
    if (type === "range") {
      if (inRange(r.from, r.to) && daysMatch(r.days)) {
        if (!r.hours || r.fullDay === true) return true;
      }
      continue;
    }

    // Ricorrenze (tipo: tutti i lun, mer, ecc.)
    if (type === "recurrence") {
      if (daysMatch(r.days) && (!r.hours || r.fullDay === true)) {
        return true;
      }
      continue;
    }
  }

  return false;
}

function nextOpenDay(fromDate) {
  const d = new Date(fromDate);
  for (let i = 0; i < 14; i++) {
    if (!cfgClosedDay(d)) return atNoon(d);
    d.setDate(d.getDate() + 1);
  }
  return atNoon(fromDate);
}

function intervalsFromSpec(spec, day) {
  if (!spec) return [];
  const D = day instanceof Date ? day : new Date(day);
  const toMs = (hhmm) => {
    const [H, M] = String(hhmm || "")
      .split(":")
      .map(Number);
    return new Date(
      D.getFullYear(),
      D.getMonth(),
      D.getDate(),
      H || 0,
      M || 0,
      0,
      0
    ).getTime();
  };
  const out = [];
  if (Array.isArray(spec) && spec.every((x) => typeof x === "string")) {
    const arr = spec;
    if (arr.length === 2) {
      const s = toMs(arr[0]),
        e = toMs(arr[1]);
      if (e > s) out.push([s, e]);
      return out;
    }
    if (arr.length >= 4 && arr.length % 2 === 0) {
      for (let i = 0; i < arr.length; i += 2) {
        const s = toMs(arr[i]),
          e = toMs(arr[i + 1]);
        if (e > s) out.push([s, e]);
      }
      return out;
    }
  }
  const arr = Array.isArray(spec) ? spec : [spec];
  for (const item of arr) {
    if (!item) continue;
    if (Array.isArray(item) && item.length === 2) {
      const s = toMs(item[0]);
      const e = toMs(item[1]);
      if (e > s) out.push([s, e]);
    } else if (typeof item === "string" && item.includes("-")) {
      const [a, b] = item.split("-");
      const s = toMs(a);
      const e = toMs(b);
      if (e > s) out.push([s, e]);
    } else if (typeof item === "object" && item.start && item.end) {
      const s = toMs(item.start);
      const e = toMs(item.end);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}

function getBusyIntervalsForDay(day, email, opts = {}) {
  const D = day instanceof Date ? new Date(day.getTime()) : new Date(day);

  // Giorno locale [00:00 .. 24:00)
  const dayStart = new Date(D.getFullYear(), D.getMonth(), D.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  // Se il DB prenotazioni non è disponibile, per sicurezza consideriamo la giornata piena.
  // (Evita di mostrare slot liberi quando non possiamo leggere i booking reali.)
  if (!shared.__bookingsDBOk) return [
    [dayStart, dayEnd]
  ];

  const ignoreChatId = opts && opts.ignoreChatId ? String(opts.ignoreChatId) : null;

  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const raw = String(email ?? "").trim();
  const wantEmail = raw.includes("@") ? norm(raw) : "";

  // Fallback: nome del pro (utile se email non è consistente tra config/booking)
  const wantName = (() => {
    if (!raw) return "";
    if (!raw.includes("@")) return norm(raw);
    try {
      const n = (typeof proNameByEmail === "function" ? proNameByEmail(wantEmail) : "") || "";
      return norm(n);
    } catch {
      return "";
    }
  })();

  const isCancelled = (b) => {
    const s = norm(b?.status);
    return s === "cancelled" || s === "canceled" || s === "annullato" || s === "annullata" || s === "deleted";
  };

  const parseMs = (raw) => {
    if (!raw) return NaN;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;

    const s = String(raw).trim();
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;

    // Supporta "YYYY-MM-DD HH:mm" o "YYYY-MM-DDTHH:mm[:ss]"
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const Y = +m[1],
        M = +m[2],
        DD = +m[3],
        H = +m[4],
        MI = +m[5],
        SS = +(m[6] ?? 0);
      const d = new Date(Y, M - 1, DD, H, MI, SS, 0);
      return d.getTime();
    }
    return NaN;
  };

  const bookingEmail = (b) => {
    const e1 = norm(b?.professionalEmail);
    if (e1) return e1;

    const name = String(b?.professionalName ?? "").trim();
    if (!name) return "";

    const resolved =
      (typeof resolveEmailByName === "function" ? resolveEmailByName(name) : null) ||
      (typeof proEmailByName === "function" ? proEmailByName(name) : null) ||
      null;

    return norm(resolved);
  };

  const getStartEnd = (b) => {
    const startRaw =
      (b && (b.startTime ?? b.start ?? b.startMs ?? b.datetime ?? b.date ?? b.when)) ?? null;
    const endRaw =
      (b && (b.endTime ?? b.end ?? b.endMs ?? b.until)) ?? null;

    const s = parseMs(startRaw);
    if (!Number.isFinite(s)) return null;

    // Se c’è un end esplicito, usa quello
    const endParsed = parseMs(endRaw);
    if (Number.isFinite(endParsed) && endParsed > s) return [s, endParsed];

    // Altrimenti durata
    let durMin = Number(b?.durationMin ?? b?.duration ?? b?.minutes ?? 0);
    if (!Number.isFinite(durMin) || durMin < 0) durMin = 0;

    // Se dur=0 ma esiste un servizio con durata in config, prova fallback (opzionale)
    if (durMin === 0 && b?.service && typeof cfgServiceDuration === "function") {
      const d = Number(cfgServiceDuration(b.service) ?? 0);
      if (Number.isFinite(d) && d > 0) durMin = d;
    }

    let e = s + durMin * 60_000;
    if (!Number.isFinite(e) || e <= s) {
      // Fallback ultra-sicuro: non ignorare il booking se durata mancante/0.
      // Blocca almeno 30 minuti così non si possono sovrapporre prenotazioni.
      durMin = 30;
      e = s + durMin * 60_000;
      if (!Number.isFinite(e) || e <= s) return null;
    }

    return [s, e];
  };

  const normalizeIntervals = (intervals) => {
    const cleaned = [];
    for (const it of intervals) {
      if (!it) continue;
      const a = Number(it[0]),
        b = Number(it[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      // Taglia ai limiti della giornata per evitare rumore
      const s = Math.max(a, dayStart);
      const e = Math.min(b, dayEnd);
      if (e > s) cleaned.push([s, e]);
    }
    cleaned.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    // Merge sovrapposizioni/adiacenze
    const merged = [];
    for (const cur of cleaned) {
      const last = merged[merged.length - 1];
      if (!last) merged.push(cur);
      else if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
      else merged.push(cur);
    }
    return merged;
  };

  const arr = (typeof loadBookings === "function" ? loadBookings() : []) || [];
  const bookings = Array.isArray(arr) ? arr : [];

  const out = [];
  for (const b of bookings) {
    if (!b || isCancelled(b)) continue;

    // Filtra per professionista (robusto)
    if (wantEmail || wantName) {
      const bEmail = bookingEmail(b);
      const bName = norm(b?.professionalName ?? b?.professional ?? b?.proName ?? b?.staffName ?? "");

      const byEmail = wantEmail && bEmail && bEmail === wantEmail;
      const byName =
        wantName &&
        bName &&
        (bName === wantName || bName.startsWith(wantName) || wantName.startsWith(bName));

      if (!byEmail && !byName) continue;
    }

    const se = getStartEnd(b);
    if (!se) continue;

    const [s, e] = se;
    // Interseca il giorno
    if (s < dayEnd && e > dayStart) out.push([s, e]);
  }

  // Holds attivi (di altri chat; ignora il nostro hold se richiesto)
  const holdEmail =
    wantEmail ||
    (wantName ?
      norm(
        (typeof resolveEmailByName === "function" ? resolveEmailByName(raw) : null) ||
        (typeof proEmailByName === "function" ? proEmailByName(raw) : null) ||
        ""
      ) :
      "");

  const heldRaw = (typeof getHoldIntervalsForDay === "function") ?
    (getHoldIntervalsForDay(D, holdEmail || wantEmail || raw, {
      ignoreChatId
    }) || []) : [];
  if (Array.isArray(heldRaw)) out.push(...heldRaw);

  return normalizeIntervals(out);
}

async function fetchSlotsForProfessional({
  service = null,
  day,
  duration = null,
  professional,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return [];

  // Risolvi email dal nome, se serve
  const email =
    professional && professional.includes("@") ?
      professional :
      proEmailByName(professional);
  if (!email) return [];

  // Durata (servizio -> durataMin) o fallback 30'
  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    if (service && professional) {
      durMin = getServiceDurationForPro(service, professional);
    } else if (service) {
      const svc0 = config.services?.[service] || null;
      durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
    } else {
      durMin = 30;
    }
  }

  const durMs = durMin * 60_000;
  const stepMs = durMs;

  const toYMD = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  // Giorno chiuso?
  const closedDates = Array.isArray(config.holidays) ?
    config.holidays :
    Array.isArray(config.closedDates) ?
      config.closedDates : [];
  if (closedDates.includes(toYMD(D))) return [];
  const hours =
    config.businessHours && config.businessHours[dayKey] ?
      config.businessHours[dayKey] :
      null;
  if (!hours) return [];
  let openIntervals = intervalsFromSpec(hours, D);

  // Pause (es. pranzo)
  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey] ?
      config.lunchBreaks[dayKey] :
      null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [
          [s, e]
        ];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  // Indisponibilità del professionista
  const unav = config.unavailability || {};
  const rules = Array.isArray(unav[email]) ? unav[email] : [];

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const daysMatch = (ruleDays) => {
    if (!Array.isArray(ruleDays) || !ruleDays.length) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };
  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  let partialBusy = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const type = String(r.type || "").toLowerCase();
    const applies =
      (type === "day" && daysMatch(r.days)) ||
      (type === "recurrence" && daysMatch(r.days)) ||
      (type === "date" &&
        (Array.isArray(r.dates) ? r.dates : [r.date]).includes(toYMD(D))) ||
      (type === "range" && inRange(r.from, r.to) && daysMatch(r.days));
    if (!applies) continue;
    if (!r.hours || r.fullDay === true) return []; // giorno off intero per il pro
    partialBusy.push(...intervalsFromSpec(r.hours, D));
  }
  partialBusy = mergeIntervals(partialBusy);

  // Busy = booking esistenti del pro + indisponibilità parziale
  const booked = getBusyIntervalsForDay(D, email) || [];
  const busy = mergeIntervals([...booked, ...partialBusy]);

  // Genera slot
  const nowTs = Date.now();
  const times = [];
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

  for (const [winS, winE] of openIntervals) {
    let cursor = winS;
    const mod = (cursor - dayStart) % stepMs;
    if (mod !== 0) cursor += stepMs - mod;

    while (cursor + durMs <= winE) {
      if (cursor < nowTs) {
        cursor += stepMs;
        continue;
      }
      let clash = false;
      for (const [bs, be] of busy) {
        if (overlaps(cursor, cursor + durMs, bs, be)) {
          clash = true;
          break;
        }
        if (bs >= cursor + durMs) break;
      }
      if (!clash) {
        const d = new Date(cursor);
        times.push(
          `${String(d.getHours()).padStart(2, "0")}:${String(
            d.getMinutes()
          ).padStart(2, "0")}`
        );
      }
      cursor += stepMs;
    }
  }

  return Array.from(new Set(times)).sort();
}

async function fetchSlots({
  service = null,
  day,
  duration = null,
  professional = null,
  wantDetail = false,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return wantDetail ? [] : [];

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate()
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const daysMatch = (ruleDays) => {
    if (!Array.isArray(ruleDays) || ruleDays.length === 0) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };
  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    if (service && professional) {
      // Usa durata specifica per questo professionista
      durMin = getServiceDurationForPro(service, professional);
    } else if (service) {
      // Fallback: durata generica del servizio
      const svc0 = config.services?.[service] || null;
      durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
    } else {
      durMin = 30; // fallback assoluto
    }
  }

  const durMs = durMin * 60_000;
  const stepMs = durMs;

  // Giorno chiuso?
  const closedDates = Array.isArray(config.holidays) ?
    config.holidays :
    Array.isArray(config.closedDates) ?
      config.closedDates : [];
  const isClosedDate = closedDates.includes(toYMD(D));
  const closedDays = config.closedDays || config.daysOff || {};
  const closedDayKeys = Array.isArray(closedDays) ?
    closedDays.map(String) :
    Object.keys(closedDays);
  const isClosedWeekday = closedDayKeys.includes(String(dayKey));
  if (isClosedDate || isClosedWeekday) return wantDetail ? [] : [];

  // Intervalli di apertura
  const hours =
    config.businessHours && config.businessHours[dayKey] ?
      config.businessHours[dayKey] :
      null;
  if (!hours) return wantDetail ? [] : [];
  let openIntervals = intervalsFromSpec(hours, D);

  // Pausa pranzo o altre chiusure temporanee
  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey] ?
      config.lunchBreaks[dayKey] :
      null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [
          [s, e]
        ];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  // Seleziona professionisti
  const svc = service && (config.services?.[service] || null);
  const proCfg = Array.isArray(svc?.professionals) ? svc.professionals : null;
  const prosBase =
    proCfg && proCfg.length ? proCfg : __dbAllPros().map(p => p.email);
  const proEmail =
    professional && professional.includes("@") ?
      professional :
      professional ?
        proEmailByName(professional) :
        null;
  const candidatePros = proEmail ? [proEmail] : prosBase;

  // ===== UNAVAILABILITY =====
  const unav = config.unavailability || {};
  const filteredPros = [];
  const partialBusyByPro = new Map();

  const toEmail = (key) =>
    key.includes("@") ? key : proEmailByName(key) || key;

  for (let key of candidatePros) {
    const email = toEmail(key);
    const rules = Array.isArray(unav[email]) ? unav[email] : [];
    let skip = false;
    let partialBusy = [];

    for (const r of rules) {
      if (!r || typeof r !== "object") continue;
      const type = String(r.type || "").toLowerCase();
      if (type === "day" && Array.isArray(r.days)) {
        const days = r.days;
        const hasHours = !!r.hours;
        if (daysMatch(days)) {
          if (!hasHours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "date" || type === "dates") {
        const dates = Array.isArray(r.dates) ? r.dates : r.date ? [r.date] : [];
        if (dates.includes(toYMD(D))) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "range") {
        if (inRange(r.from, r.to) && daysMatch(r.days)) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
      if (type === "recurrence") {
        if (daysMatch(r.days)) {
          if (!r.hours || r.fullDay === true) {
            skip = true;
            break;
          } else {
            partialBusy.push(...intervalsFromSpec(r.hours, D));
          }
        }
        continue;
      }
    }

    if (!skip) {
      filteredPros.push(email);
      if (partialBusy.length)
        partialBusyByPro.set(email, mergeIntervals(partialBusy));
    }
  }
  if (filteredPros.length === 0) {
    return wantDetail ? [] : [];
  }

  const pros = filteredPros.length ? filteredPros : candidatePros;

  // Calcola intervalli occupati per ciascun pro
  const busyByPro = new Map();
  for (const email of pros) {
    const booked = getBusyIntervalsForDay(D, email) || [];
    const extra = partialBusyByPro.get(email) || [];
    busyByPro.set(email, mergeIntervals([...booked, ...extra]));
  }

  // Genera slot con lista pro liberi
  const nowTs = Date.now();
  const detailed = new Map(); // time -> [{email,name}]
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

  for (const [winS, winE] of openIntervals) {
    let cursor = winS;
    const mod = (cursor - dayStart) % stepMs;
    if (mod !== 0) cursor += stepMs - mod;

    while (cursor + durMs <= winE) {
      if (cursor < nowTs) {
        cursor += stepMs;
        continue;
      }

      const freePros = [];
      for (const email of pros) {
        const busy = busyByPro.get(email) || [];
        let clash = false;
        for (const [bs, be] of busy) {
          if (overlaps(cursor, cursor + durMs, bs, be)) {
            clash = true;
            break;
          }
          if (bs >= cursor + durMs) break;
        }
        if (!clash) {
          const name = (proNameByEmail(email) || "").trim();
          freePros.push({
            email,
            name: name || "-"
          });
        }
      }

      if (freePros.length) {
        const d = new Date(cursor);
        const key = `${String(d.getHours()).padStart(2, "0")}:${String(
          d.getMinutes()
        ).padStart(2, "0")}`;
        detailed.set(key, freePros);
      }
      cursor += stepMs;
    }
  }

  if (wantDetail)
    return Array.from(detailed.entries())
      .map(([time, pros]) => ({
        time,
        pros
      }))
      .sort((a, b) => compareHHMM(a.time, b.time));
  return Array.from(detailed.keys()).sort(compareHHMM);
}

async function fetchSlotsWithPros({
  service = null,
  day,
  duration = null,
  professional = null,
}) {
  const D = day instanceof Date ? day : new Date(day);
  if (!(D instanceof Date) || isNaN(D)) return {
    times: [],
    map: {}
  };

  let durMin = Number(duration);
  if (!Number.isFinite(durMin) || durMin <= 0) {
    const svc0 = service && (config.services?.[service] || null);
    durMin = Number(svc0?.durationMin || svc0?.duration || 0) || 30;
  }
  const durMs = durMin * 60_000;
  const stepMs = durMs;

  const toYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  const dayKey = isoWeekday(D);
  const dayStart = new Date(
    D.getFullYear(),
    D.getMonth(),
    D.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const closedDates = Array.isArray(config.holidays) ?
    config.holidays :
    Array.isArray(config.closedDates) ?
      config.closedDates : [];
  if (closedDates.includes(toYMD(D))) return {
    times: [],
    map: {}
  };

  const closedDays = config.closedDays || config.daysOff || {};
  const closedDayKeys = Array.isArray(closedDays) ?
    closedDays.map(String) :
    Object.keys(closedDays);
  if (closedDayKeys.includes(String(dayKey))) return {
    times: [],
    map: {}
  };

  const hours =
    config.businessHours && config.businessHours[dayKey] ?
      config.businessHours[dayKey] :
      null;
  if (!hours) return {
    times: [],
    map: {}
  };
  let openIntervals = intervalsFromSpec(hours, D);

  const lb =
    config.lunchBreaks && config.lunchBreaks[dayKey] ?
      config.lunchBreaks[dayKey] :
      null;
  if (lb) {
    const breaks = intervalsFromSpec(lb, D);
    if (breaks.length) {
      const next = [];
      for (const [s, e] of openIntervals) {
        let segs = [
          [s, e]
        ];
        for (const [bs, be] of breaks) {
          const tmp = [];
          for (const [x, y] of segs) {
            if (be <= x || y <= bs) {
              tmp.push([x, y]);
            } else {
              if (x < bs) tmp.push([x, Math.max(x, bs)]);
              if (be < y) tmp.push([Math.min(be, y), y]);
            }
          }
          segs = tmp;
        }
        next.push(...segs);
      }
      openIntervals = next.filter(([a, b]) => b > a);
    }
  }

  const svc = service && (config.services?.[service] || null);
  const proCfg = Array.isArray(svc?.professionals) ? svc.professionals : null;
  const prosBase =
    proCfg && proCfg.length ? proCfg : __dbAllPros().map(p => p.email);
  const proEmail =
    professional && professional.includes("@") ?
      professional :
      professional ?
        proEmailByName(professional) :
        null;
  const candidatePros = proEmail ? [proEmail] : prosBase;

  const unav = config.unavailability || {};
  const partialBusyByPro = new Map();
  const filteredPros = [];

  const IT2NUM = {
    lun: "1",
    mar: "2",
    mer: "3",
    gio: "4",
    ven: "5",
    sab: "6",
    dom: "7",
  };
  const EN2NUM = {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7",
  };
  const normDayKey = (v) => {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (/^[1-7]$/.test(s)) return s;
    if (IT2NUM[s]) return IT2NUM[s];
    if (EN2NUM[s]) return EN2NUM[s];
    if (s.startsWith("lun")) return "1";
    if (s.startsWith("mar")) return "2";
    if (s.startsWith("mer") || s.startsWith("wed")) return "3";
    if (s.startsWith("gio") || s.startsWith("thu")) return "4";
    if (s.startsWith("ven") || s.startsWith("fri")) return "5";
    if (s.startsWith("sab") || s.startsWith("sat")) return "6";
    if (s.startsWith("dom") || s.startsWith("sun")) return "7";
    return null;
  };
  const dayKeySetHas = (ruleDays) => {
    if (!Array.isArray(ruleDays) || ruleDays.length === 0) return true;
    const set = new Set(ruleDays.map(normDayKey).filter(Boolean));
    return set.has(String(dayKey));
  };
  const inRange = (from, to) => {
    const s = from ? new Date(from).getTime() : -Infinity;
    const e = to ? new Date(to).getTime() : Infinity;
    return dayStart <= e && dayEnd > s;
  };

  const mergeIntervals = (arr) => {
    if (!arr?.length) return [];
    const sorted = arr.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      const last = out[out.length - 1];
      if (s <= last[1]) {
        if (e > last[1]) last[1] = e;
      } else out.push([s, e]);
    }
    return out;
  };

  for (const email of candidatePros) {
    const rules = Array.isArray(unav[email]) ? unav[email] : [];
    let skip = false;
    let partialBusy = [];

    for (const r of rules) {
      if (!r || typeof r !== "object") continue;
      const type = String(r.type || "").toLowerCase();

      const applies =
        (type === "day" && Array.isArray(r.days) && dayKeySetHas(r.days)) ||
        (type === "recurrence" && dayKeySetHas(r.days)) ||
        (type === "date" &&
          (Array.isArray(r.dates) ? r.dates : [r.date]).includes(toYMD(D))) ||
        (type === "range" && inRange(r.from, r.to) && dayKeySetHas(r.days));

      if (applies) {
        if (!r.hours || r.fullDay === true) {
          skip = true;
          break;
        }
        partialBusy.push(...intervalsFromSpec(r.hours, D));
      }
    }

    if (!skip) {
      filteredPros.push(email);
      if (partialBusy.length)
        partialBusyByPro.set(email, mergeIntervals(partialBusy));
    }
  }
  if (filteredPros.length === 0) {
    return {
      times: [],
      map: {}
    };
  }

  const pros = filteredPros.length ? filteredPros : candidatePros;
  const slotsByPro = new Map();
  const busyByPro = new Map();

  // FIX: carica gli intervalli occupati (booking + unavailability) per ogni pro
  for (const email of pros) {
    const booked = getBusyIntervalsForDay(D, email) || [];
    const extra = partialBusyByPro.get(email) || [];
    busyByPro.set(email, mergeIntervals([...booked, ...extra]));
  }

  const nowTs = Date.now();

  for (const email of pros) {
    // Durata specifica per questo professionista
    const durMin = service ?
      getServiceDurationForPro(service, email) :
      Number(duration) || 30;
    const durMs = durMin * 60_000;
    const stepMs = durMs;

    const busy = busyByPro.get(email) || [];
    const freeTimes = new Set();

    for (const [winS, winE] of openIntervals) {
      let cursor = winS;
      const mod = (cursor - dayStart) % stepMs;
      if (mod !== 0) cursor += stepMs - mod;

      while (cursor + durMs <= winE) {
        if (cursor < nowTs) {
          cursor += stepMs;
          continue;
        }

        let clash = false;
        for (const [bs, be] of busy) {
          if (cursor < be && bs < cursor + durMs) {
            clash = true;
            break;
          }
          if (bs >= cursor + durMs) break;
        }

        if (!clash) {
          const d = new Date(cursor);
          const key = `${String(d.getHours()).padStart(2, "0")}:${String(
            d.getMinutes()
          ).padStart(2, "0")}`;
          freeTimes.add(key);
        }

        cursor += stepMs;
      }
    }

    slotsByPro.set(email, freeTimes);
  }

  // Costruisci mappa finale: time -> lista professionisti liberi
  const map = {};
  const allTimes = new Set();

  for (const [email, times] of slotsByPro) {
    for (const t of times) {
      allTimes.add(t);
      if (!map[t]) map[t] = [];
      map[t].push(email);
    }
  }

  const times = Array.from(allTimes).sort((a, b) => a.localeCompare(b));
  return {
    times,
    map
  };
}

function filterSlotsByWindow(slots, windowPair) {
  const list = Array.isArray(slots) ? slots : [];
  const w =
    Array.isArray(windowPair) && windowPair.length === 2 ? windowPair : null;
  if (!w) return list.slice();
  const from = timeToMinutes(w[0]);
  const to = timeToMinutes(w[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return list.slice();
  return list
    .filter((h) => {
      const m = timeToMinutes(h);
      return Number.isFinite(m) && m >= from && m <= to;
    })
    .sort(compareHHMM);
}

function getDaypartBoundaries() {
  const def = {
    mattina: ["09:00", "12:30"],
    pomeriggio: ["14:00", "17:30"],
    sera: ["17:30", "20:30"],
  };
  try {
    if (config && config.dayparts) {
      const d = config.dayparts;
      const pick2 = (keys, fb) => {
        for (const k of keys) {
          if (Array.isArray(d[k]) && d[k].length === 2) return d[k];
        }
        return fb;
      };
      return {
        mattina: pick2(["mattina", "morning"], def.mattina),
        pomeriggio: pick2(["pomeriggio", "afternoon"], def.pomeriggio),
        sera: pick2(["sera", "evening"], def.sera),
      };
    }
  } catch (err) {
    log("warn", "[CATCH] Errore ignorato", {
      error: String(err)
    }); //  FIX Bug #17
  }
  return def;
}

function groupSlotsByDaypart(slots) {
  const list = Array.isArray(slots) ? slots.slice().sort(compareHHMM) : [];
  const dp = getDaypartBoundaries();
  return {
    mattina: filterSlotsByWindow(list, dp.mattina),
    pomeriggio: filterSlotsByWindow(list, dp.pomeriggio),
    sera: filterSlotsByWindow(list, dp.sera),
  };
}

function normalizeSlotsDetail(raw) {
  const list = Array.isArray(raw) ?
    raw :
    Array.isArray(raw?.slots) ?
      raw.slots :
      Array.isArray(raw?.times) ?
        raw.times : [];

  const toHHMM = (v) => {
    if (!v) return null;

    if (v instanceof Date) {
      const hh = String(v.getHours()).padStart(2, "0");
      const mm = String(v.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    const s = String(v).trim();
    const m = s.match(/(\d{1,2})\s*[:.]\s*(\d{1,2})/);
    if (!m) return null;

    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  const normPro = (p) => {
    if (!p) return null;

    // stringa: può essere email oppure nome
    if (typeof p === "string") {
      const s = String(p).trim();
      if (!s) return null;
      if (s.includes("@")) {
        const nice = (typeof proNameByEmail === "function" ? proNameByEmail(s) : "") || "";
        return {
          name: nice || "-",
          email: s
        };
      }
      return {
        name: s,
        email: ""
      };
    }

    if (typeof p !== "object") return null;

    const email = String(p.email || p.mail || p.id || p.value || "").trim();
    const rawName = String(p.name || p.displayName || p.fullName || p.label || p.title || "").trim();

    // Evita che il nome visualizzato sia un'email
    let name = rawName;
    if (!name || name.includes("@")) {
      const nice = email && (typeof proNameByEmail === "function" ? proNameByEmail(email) : "");
      name = String(nice || "").trim();
    }

    if (!name && !email) return null;
    return {
      name: name || "-",
      email: email || null
    };
  };

  const byTime = new Map(); // "HH:MM" -> {time, pros:[]}

  const add = (time, pros) => {
    if (!time) return;
    const cur = byTime.get(time) || {
      time,
      pros: []
    };

    if (Array.isArray(pros) && pros.length) {
      const seen = new Set(
        cur.pros.map((x) => String(x.email || x.name || "").toLowerCase())
      );
      for (const p of pros) {
        const key = String(p.email || p.name || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        cur.pros.push(p);
      }
    }

    byTime.set(time, cur);
  };

  for (const item of list) {
    if (typeof item === "string") {
      add(toHHMM(item), []);
      continue;
    }
    if (item && typeof item === "object") {
      const time = toHHMM(
        item.time ?? item.hhmm ?? item.startTime ?? item.start ?? item.slot
      );
      let pros = item.pros ?? item.professionals ?? item.availablePros ?? [];
      if (!Array.isArray(pros)) pros = [];
      pros = pros.map(normPro).filter((p) => p && p.name);
      add(time, pros);
    }
  }

  return Array.from(byTime.values()).sort((a, b) =>
    a.time.localeCompare(b.time)
  );
}

function normalizePro(p) {
  if (!p) return {
    name: "",
    email: ""
  };
  if (typeof p === "string") {
    if (p.includes("@")) {
      // prova a risolvere il nome leggibile se disponibile
      const nice =
        (typeof proNameByEmail === "function" ? proNameByEmail(p) : "") || p;
      return {
        name: nice,
        email: p
      };
    }
    return {
      name: p,
      email: ""
    };
  }
  const email = String(p.email || "").trim();
  const name =
    String(p.name || "").trim() ||
    (email && typeof proNameByEmail === "function" ?
      proNameByEmail(email) :
      "") ||
    email;
  return {
    name,
    email
  };
}

function labelProsForSlot(item) {
  try {
    const pros = Array.isArray(item?.pros) ? item.pros : [];
    if (!pros.length) return "";
    const names = pros.map((p) => {
      const raw = String(p?.name || p?.email || "").trim();
      const nice =
        raw.includes("@") ?
          ((typeof proNameByEmail === "function" ? proNameByEmail(raw) : "") || "").trim() :
          raw;
      return proShort(nice || "-");
    });
    if (names.length <= 2) return names.filter(Boolean).join(", ");
    const head = names.slice(0, 2).filter(Boolean).join(", ");
    return `${head} +${names.length - 2}`;
  } catch {
    return "";
  }
}

function parseDurationEnv({
  msVar = "OLLAMA_KEEP_ALIVE_MS",
  anyVar = "OLLAMA_KEEP_ALIVE",
  def = "5m",
} = {}) {
  const raw = (process.env[anyVar] ?? process.env[msVar] ?? "")
    .toString()
    .trim();
  if (!raw) return def; // default
  if (/^\d+$/.test(raw)) return `${raw}ms`; // numero nudo -> millisecondi
  if (/^\d+\s*(ns|us|µs|ms|s|m|h)$/i.test(raw)) return raw; // già con unità
  log("warn", `[OLLAMA] durata non valida "${raw}", uso default ${def}`);
  return def;
}

function formatBusinessHours(businessHours) {
  if (!businessHours || Object.keys(businessHours).length === 0) {
    return null;
  }

  const dayNames = {
    1: "Lunedì",
    2: "Martedì",
    3: "Mercoledì",
    4: "Giovedì",
    5: "Venerdì",
    6: "Sabato",
    7: "Domenica"
  };

  // Raggruppa giorni con gli stessi orari
  const schedule = [];
  let currentGroup = null;

  for (let day = 1; day <= 7; day++) {
    const hours = businessHours[day];
    const hoursStr = hours ? `${hours[0]} - ${hours[1]}` : "Chiuso";

    if (!currentGroup || currentGroup.hours !== hoursStr) {
      if (currentGroup) {
        schedule.push(currentGroup);
      }
      currentGroup = {
        startDay: day,
        endDay: day,
        hours: hoursStr
      };
    } else {
      currentGroup.endDay = day;
    }
  }

  if (currentGroup) {
    schedule.push(currentGroup);
  }

  // Formatta il testo finale
  return schedule.map(group => {
    const dayRange = group.startDay === group.endDay ?
      dayNames[group.startDay] :
      `- ${dayNames[group.startDay]} - ${dayNames[group.endDay]}`;
    return `${dayRange}: ${group.hours}`;
  }).join('\n');
}

  return { isProfessionalOffFullDay, nextOpenDay, intervalsFromSpec, getBusyIntervalsForDay, fetchSlotsForProfessional, fetchSlots, fetchSlotsWithPros, filterSlotsByWindow, getDaypartBoundaries, groupSlotsByDaypart, normalizeSlotsDetail, normalizePro, labelProsForSlot, parseDurationEnv, formatBusinessHours };
}
