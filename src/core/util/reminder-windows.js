/** Pure predicate: trigger a reminder only near the configured lead time. */
export function dueForConfirmation(startMs, now, { leadMinutes = 180, windowMinutes = 15 } = {}) {
  if (![startMs, now, leadMinutes, windowMinutes].every(Number.isFinite)) return false;
  if (leadMinutes < 0 || windowMinutes < 0) return false;
  const deltaMinutes = (startMs - now) / 60_000;
  return deltaMinutes >= Math.max(0, leadMinutes - windowMinutes)
    && deltaMinutes <= leadMinutes + windowMinutes;
}

/** Trigger a review only after treatment and within the chosen lookback. */
export function dueForReview(endMs, now, { lookbackDays = 3, minAfterEndMinutes = 15, windowMinutes } = {}) {
  if (![endMs, now, lookbackDays, minAfterEndMinutes].every(Number.isFinite)) return false;
  const lookbackMinutes = windowMinutes ?? lookbackDays * 24 * 60;
  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0 || minAfterEndMinutes < 0) return false;
  const elapsedMinutes = (now - endMs) / 60_000;
  return elapsedMinutes >= minAfterEndMinutes && elapsedMinutes <= lookbackMinutes;
}
