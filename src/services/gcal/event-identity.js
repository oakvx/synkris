/** Strict match for Calendar 409 recovery: never assume a conflicting event is ours. */
export function eventMatchesExpected(existing, expected, eventId) {
  if (!existing || !expected || !eventId || existing.id !== eventId) return false;
  if (existing.summary !== expected.summary || existing.description !== expected.description) return false;
  const equalTime = (left, right) => {
    const a = Date.parse(left?.dateTime || '');
    const b = Date.parse(right?.dateTime || '');
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  };
  return equalTime(existing.start, expected.start) && equalTime(existing.end, expected.end);
}

export function isCalendarConflict(error) {
  const status = Number(error?.response?.status || error?.code || error?.status);
  return status === 409;
}
