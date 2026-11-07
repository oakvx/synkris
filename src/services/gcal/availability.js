/** Google Calendar availability domain. */
export function createModule(dependencies, shared) {
  const { __isoDow, getCalendarClient, retry, rrulestr } = dependencies;

function matchesUnavailability(date, entry) {
  switch (entry.type) {
    case 'weekday': {
      const iso = __isoDow(date);
      const days = Array.isArray(entry.days) ? entry.days.map(String) : [];
      return days.includes(String(iso));
    }
    case 'day': {
      // backward compat: se days sono 1..7 -> weekday ISO, altrimenti day-of-month
      const daysN = Array.isArray(entry.days) ? entry.days.map((x) => Number(x)) : [];
      const finite = daysN.filter(Number.isFinite);
      const max = finite.length ? Math.max(...finite) : 0;
      if (max > 0 && max <= 7) {
        const iso = __isoDow(date);
        return finite.map(String).includes(String(iso));
      }
      return finite.includes(Number(date.getDate()));
    }
    case 'range': {
      const start = new Date(entry.start);
      start.setHours(0, 0, 0, 0);
      const end = new Date(entry.end);
      end.setHours(23, 59, 59, 999);
      return date >= start && date <= end;
    }
    case 'recurrence': {
      if (!entry.rule || !rrulestr) return false;
      const rule = rrulestr(`RRULE:${entry.rule}`);
      const sd = new Date(date);
      sd.setHours(0, 0, 0, 0);
      const ed = new Date(date);
      ed.setHours(23, 59, 59, 999);
      return rule.between(sd, ed, true).length > 0;
    }
    default:
      return false;
  }
}

function isAvailable(email, date) {
  const rules = shared.unavailability[email] || [];
  return !rules.some(entry => matchesUnavailability(new Date(date), entry));
}

function salonDayKey(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) throw new TypeError('Invalid appointment date');
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isSalonClosedDate(date) {
  return Array.isArray(shared.holidays) && shared.holidays.includes(salonDayKey(date));
}

function computeSlots(busyIntervals, windowStart, windowEnd, durationMin) {
  const lower = new Date(windowStart).getTime();
  const upper = new Date(windowEnd).getTime();
  const durationMs = Number(durationMin) * 60_000;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower ||
      !Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('Invalid availability interval');

  const busy = busyIntervals.map(iv => ({
    start: new Date(iv.start).getTime(), end: new Date(iv.end).getTime()
  })).sort((a, b) => a.start - b.start);
  if (busy.some(iv => !Number.isFinite(iv.start) || !Number.isFinite(iv.end) || iv.end <= iv.start))
    throw new TypeError('Invalid provider busy interval');
  const free = [];
  let cursor = lower;
  for (const iv of busy) {
    // Events outside opening hours must never extend offered slots beyond closing.
    if (iv.end <= lower || iv.start >= upper) continue;
    const start = Math.max(lower, iv.start);
    const end = Math.min(upper, iv.end);
    if (start > cursor) free.push({ start: new Date(cursor), end: new Date(start) });
    if (end > cursor) cursor = end;
  }
  if (cursor < upper) free.push({ start: new Date(cursor), end: new Date(upper) });
  const overrunMs = Math.max(0, Number(shared.MAX_OVERRUN) || 0) * 60_000;
  return free.filter(slot => {
    const availableMs = slot.end.getTime() - slot.start.getTime();
    if (availableMs >= durationMs) return true;
    // An overrun is only permitted past closing, NEVER through a busy event.
    return slot.end.getTime() === upper && availableMs > 0 &&
      durationMs - availableMs <= overrunMs;
  });
}

async function getFreeSlotsForProfessional(email, duration, date) {
  if (isSalonClosedDate(date)) return [];
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  const wd = dayStart.getDay();
  const hours = shared.BUSINESS_HOURS[wd] || [];
  if (!isAvailable(email, dayStart) || hours.length === 0) return [];
  let busy = [];
  try {
    const cal = await getCalendarClient();
    const calendars = [...new Set([email, process.env.CALENDAR_ID].filter(Boolean))];
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        items: calendars.map(id => ({ id }))
      }
    });
    for (const id of calendars) {
      const result = fb.data?.calendars?.[id];
      if (!result || result.errors?.length || !Array.isArray(result.busy))
        throw new Error('Disponibilità calendario non verificabile');
      busy.push(...result.busy);
    }
  } catch (error) {
    // Never offer slots when the calendar could not be checked.
    throw new Error('Impossibile verificare la disponibilità del calendario', { cause: error });
  }
  const slots = [];
  for (let i = 0; i < hours.length; i += 2) {
    const [sh, sm] = hours[i].split(':').map(Number);
    const [eh, em] = hours[i + 1].split(':').map(Number);
    const ws = new Date(dayStart);
    ws.setHours(sh, sm, 0, 0);
    const we = new Date(dayStart);
    we.setHours(eh, em, 0, 0);
    computeSlots(busy, ws, we, duration).forEach(s => slots.push(`${s.start.getHours().toString().padStart(2, '0')}:${s.start.getMinutes().toString().padStart(2, '0')}`));
  }
  return slots.sort();
}

async function getFreeSlotsForDay(serviceName, date) {
  const svc = shared.services[serviceName];
  if (!svc) throw new Error(`Servizio sconosciuto: ${serviceName}`);

  // Closed dates are salon-local calendar days, not UTC days.
  if (isSalonClosedDate(date)) return {};

  // 1) giorno, apertura e chiusura
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const wd = dayStart.getDay();
  const hours = shared.BUSINESS_HOURS[wd] || [];
  if (hours.length === 0) return {}; // chiuso

  // 2) chiusura della giornata
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  // 3) filtra professionisti disponibili giornalmente
  const pros = svc.professionals.filter(e => isAvailable(e, dayStart));
  if (pros.length === 0) return {};

  // 4) freebusy per tutti i pro
  const cal = await getCalendarClient();
  const salonCalendarId = process.env.CALENDAR_ID || null;
  const calendarIds = [...new Set([...pros, salonCalendarId].filter(Boolean))];
  const fb = await retry(() => cal.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: calendarIds.map(id => ({ id }))
    }
  }));
  const busyMap = fb.data?.calendars || {};
  for (const id of calendarIds) {
    if (!busyMap[id] || busyMap[id].errors?.length || !Array.isArray(busyMap[id].busy))
      throw new Error('Disponibilità calendario non verificabile');
  }
  const salonBusy = salonCalendarId ? busyMap[salonCalendarId].busy : [];

  // 5) per ciascun pro, genero slot a step = duration
  const available = {};
  for (const email of pros) {
    if (!busyMap[email] || busyMap[email].errors?.length) {
      throw new Error('Disponibilità calendario non verificabile');
    }
    const busy = [...busyMap[email].busy, ...salonBusy].map(iv => ({
      start: new Date(iv.start),
      end: new Date(iv.end)
    }));
    const slots = [];

    // per ogni intervallo di BUSINESS_HOURS (coppie [apertura, chiusura])
    for (let i = 0; i < hours.length; i += 2) {
      const [hOpen, mOpen] = hours[i].split(':').map(Number);
      const [hClose, mClose] = hours[i + 1].split(':').map(Number);

      // punto di partenza e fine blocco orario
      const windowStart = new Date(dayStart);
      windowStart.setHours(hOpen, mOpen, 0, 0);
      const windowEnd = new Date(dayStart);
      windowEnd.setHours(hClose, mClose, 0, 0);

      // La durata può dipendere dalla singola operatrice; non usare quella generica.
      const durationMin = (Number(svc.professionalDurations?.[email]) || Number(svc.duration)) + (Number(svc.bufferAfterMin) || 0);
      if (!Number.isFinite(durationMin) || durationMin <= 0) throw new Error('Durata trattamento non valida');
      const stepMs = durationMin * 60000;
      for (let cursor = windowStart.getTime(); cursor + stepMs <= windowEnd.getTime(); cursor += stepMs) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor + stepMs);

        // controllo sovrapposizioni col busy
        const overlaps = busy.some(iv =>
          iv.start < slotEnd && iv.end > slotStart
        );
        if (!overlaps) {
          const hh = slotStart.getHours().toString().padStart(2, '0');
          const mm = slotStart.getMinutes().toString().padStart(2, '0');
          slots.push(`${hh}:${mm}`);
        }
      }
    }

    if (slots.length) available[email] = {
      slots
    };
  }

  return available;
}

  return { matchesUnavailability, isAvailable, computeSlots, getFreeSlotsForProfessional, getFreeSlotsForDay };
}
