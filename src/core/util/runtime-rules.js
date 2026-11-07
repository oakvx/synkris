/**
 * Regole di calendario e disponibilità condivise dai diversi canali.
 * Le funzioni ricevono le dipendenze esterne come argomenti per restare testabili.
 */
export function isClosedDay(date, config = {}) {
  const day = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(day.getTime())) return true;
  const isoDay = String(day.getDay() === 0 ? 7 : day.getDay());
  const weekly = config.closedDays ?? config.daysOff ?? {};
  if (Array.isArray(weekly) && weekly.map(String).includes(isoDay)) return true;
  if (weekly && !Array.isArray(weekly) && typeof weekly === 'object' &&
      Object.hasOwn(weekly, isoDay) && weekly[isoDay] !== false) return true;
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const dates = Array.isArray(config.holidays) ? config.holidays :
    Array.isArray(config.closedDates) ? config.closedDates : [];
  return dates.includes(ymd);
}

export function filterOutPastTimesForToday(day, times, clock = new Date()) {
  const target = day instanceof Date ? day : new Date(day);
  if (Number.isNaN(target.getTime())) return [];
  if (target.getFullYear() !== clock.getFullYear() || target.getMonth() !== clock.getMonth() ||
      target.getDate() !== clock.getDate()) return times;
  const lowerBound = clock.getHours() * 60 + clock.getMinutes();
  return (times || []).filter((hhmm) => {
    const match = String(hhmm).match(/^(\d{1,2}):([0-5]\d)$/);
    return match && Number(match[1]) * 60 + Number(match[2]) >= lowerBound;
  }).sort((a, b) => a.localeCompare(b));
}

export function normalizeDaypart(text, normalize, boundaries) {
  const value = normalize(String(text || ''));
  const dayparts = boundaries();
  if (/\bmattin/.test(value)) return dayparts.mattina;
  if (/\bpomeriggio\b/.test(value)) return dayparts.pomeriggio;
  if (/\bsera\b/.test(value)) return dayparts.sera;
  return null;
}
