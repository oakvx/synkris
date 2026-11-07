/** Incremental reconciliation of EXISTING synk-owned Calendar events.
 * Unknown/personal Calendar entries are never imported and their content is not stored.
 * Calendar -> PG synchronization is monotonic, transactional and conflict-aware.
 */
const MAX_PAGES = 200;
export function mapCalendarChange(event) {
  if (!event || typeof event.id !== 'string' || !event.id.trim()) return null;
  if (event.status === 'cancelled') return { eventId: event.id, kind: 'cancel' };
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) ||
      Date.parse(end) <= Date.parse(start)) return null;
  return { eventId: event.id, kind: 'update', start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
export async function applyCalendarChange(db, change, calendarId) {
  if (!calendarId || typeof calendarId !== 'string') throw new TypeError('calendarId required');
  if (!change) return { status: 'ignored' };
  await db.query('BEGIN');
  try {
    const match = await db.query(`SELECT a.appointment_id, a.start_time, a.end_time, a.status
      FROM public.appointment_calendar ac JOIN public.appointments a ON a.appointment_id=ac.appointment_id
      WHERE ac.event_id=$1 AND ac.calendar_id=$2 FOR UPDATE OF a`, [change.eventId, calendarId]);
    if (!match.rowCount) { await db.query('COMMIT'); return { status: 'unmanaged' }; }
    const booking = match.rows[0];
    // An unsent dashboard change wins until the outbox has settled; never
    // silently overwrite the user's local edit with stale provider state.
    const outbox = await db.query(`SELECT 1 FROM public.calendar_outbox
      WHERE event_id=$1 AND status IN ('pending','attention')
      AND (calendar_id IS NULL OR calendar_id=$2) LIMIT 1`, [change.eventId, calendarId]);
    if (outbox.rowCount) {
      await db.query('COMMIT');
      return { status: 'conflict', code: 'outbound_change_pending' };
    }
    let changed = false;
    if (change.kind === 'cancel') {
      if (!['cancelled','canceled','annullato'].includes(String(booking.status).toLowerCase())) {
        await db.query(`UPDATE public.appointments SET status='cancelled',updated_at=now() WHERE appointment_id=$1`, [booking.appointment_id]);
        changed = true;
      }
    } else if (!['cancelled','canceled','annullato','completed','completato'].includes(String(booking.status).toLowerCase())) {
      if (new Date(booking.start_time).getTime() !== Date.parse(change.start) ||
          new Date(booking.end_time).getTime() !== Date.parse(change.end)) {
        await db.query(`UPDATE public.appointments SET start_time=$2,end_time=$3,updated_at=now()
          WHERE appointment_id=$1`, [booking.appointment_id, change.start, change.end]);
        changed = true;
      }
    }
    if (changed) await db.query(`INSERT INTO public.calendar_sync_audit (appointment_id, operation)
      VALUES ($1, $2)`, [booking.appointment_id, change.kind]);
    await db.query('COMMIT');
    return { status: changed ? 'applied' : 'unchanged' };
  } catch (error) {
    await db.query('ROLLBACK');
    // Genuine calendar/PG collision should be held for manual review.
    if (error.code === '23P01' || error.code === '23514') return { status: 'conflict', code: error.code };
    throw error;
  }
}
export async function syncCalendarIncremental({ pool, api, calendarId, logger = () => {}, daysBack = 90 }) {
  if (!pool || !api || typeof calendarId !== 'string' || !calendarId.trim()) throw new Error('Missing calendar synchronization dependency');
  const lock = await pool.connect();
  // Advisory lock keeps two bot instances from concurrently consuming the cursor.
  try {
    const lockResult = await lock.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`, [`synk_calendar_${calendarId}`]);
    if (!lockResult.rows[0]?.acquired) return { status: 'busy' };
    try {
      const cursorResult = await lock.query(`SELECT sync_token FROM public.calendar_sync_cursors WHERE calendar_id=$1`, [calendarId]);
      let token = cursorResult.rows[0]?.sync_token || null;
      let reset = false;
      const counts = { applied: 0, unchanged: 0, unmanaged: 0, ignored: 0, conflict: 0 };
      // A 410 means the incremental token expired. Restart from a bounded full scan.
      for (let pass = 0; pass < 2; pass++) {
        let pageToken = undefined;
        let nextSyncToken = null;
        try {
          for (let page = 0; page < MAX_PAGES; page++) {
            const options = { calendarId, maxResults: 250, showDeleted: true, pageToken };
            if (token) options.syncToken = token;
            else options.timeMin = new Date(Date.now() - Math.max(1, Math.min(730, daysBack)) * 86_400_000).toISOString();
            const response = await api.events.list(options);
            for (const event of response.data?.items || []) {
              const change = mapCalendarChange(event);
              const result = await applyCalendarChange(lock, change, calendarId);
              counts[result.status] = (counts[result.status] || 0) + 1;
              if (result.status === 'conflict') {
                await lock.query(`INSERT INTO public.calendar_sync_conflicts (calendar_id,event_id,reason)
                  VALUES ($1,$2,$3) ON CONFLICT (calendar_id,event_id)
                  DO UPDATE SET reason=EXCLUDED.reason,last_seen_at=now(),resolved_at=NULL`,
                  [calendarId, change.eventId, result.code]);
                logger('warn', 'calendar_sync_conflict', { code: result.code });
              }
            }
            pageToken = response.data?.nextPageToken;
            nextSyncToken = response.data?.nextSyncToken || nextSyncToken;
            if (!pageToken) {
              if (!nextSyncToken) throw new Error('Missing nextSyncToken in final Calendar page');
              await lock.query(`INSERT INTO public.calendar_sync_cursors(calendar_id,sync_token,last_success_at)
                VALUES ($1,$2,now()) ON CONFLICT (calendar_id) DO UPDATE
                SET sync_token=EXCLUDED.sync_token,last_success_at=now()`, [calendarId,nextSyncToken]);
              return { status: 'ok', reset, counts };
            }
          }
          throw new Error('Calendar pagination exceeded safety bound');
        } catch (error) {
          if ((error.code === 410 || error.response?.status === 410) && token && pass === 0) {
            token = null;
            reset = true;
            continue;
          }
          throw error;
        }
      }
      throw new Error('Could not recover expired Calendar token');
    } finally { await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`synk_calendar_${calendarId}`]); }
  } finally { lock.release(); }
}
