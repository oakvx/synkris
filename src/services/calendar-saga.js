/**
 * Durable compensation journal for Calendar-first bookings.
 * This is a recovery mechanism, not an atomic transaction across Google and PG.
 * Never log customer data or write credentials to the journal.
 */
import { randomBytes } from 'node:crypto';

export function newCalendarEventId() {
  // Calendar API ids permit the base32hex alphabet (0-9, a-v).
  return `a${randomBytes(24).toString('hex')}`;
}

export async function beginCalendarSaga(db, eventId = newCalendarEventId()) {
  if (!db || !/^[a-v0-9]{5,1024}$/.test(eventId)) throw new Error('Invalid saga database or event identifier');
  await db.query(`INSERT INTO public.calendar_booking_sagas(event_id, status)
    VALUES ($1, 'pending') ON CONFLICT (event_id) DO NOTHING`, [eventId]);
  return eventId;
}

export async function completeCalendarSaga(db, eventId, status) {
  if (!['committed', 'compensated'].includes(status)) throw new Error('Invalid calendar saga status');
  await db.query(`UPDATE public.calendar_booking_sagas
    SET status=$2, updated_at=now(), last_error=NULL, locked_until=NULL
    WHERE event_id=$1`, [eventId, status]);
}

export async function claimPendingSagas(db, limit = 10) {
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  const result = await db.query(`UPDATE public.calendar_booking_sagas s
    SET locked_until=now()+interval '2 minutes', updated_at=now()
    WHERE s.event_id IN (
      SELECT event_id FROM public.calendar_booking_sagas
      WHERE status='pending' AND created_at < now()-interval '15 minutes'
        AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
      ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
    ) RETURNING s.event_id, s.attempts`, [n]);
  return result.rows;
}

export async function reconcileCalendarSagas({ db, cancelEvent, limit = 10, logger = () => {} }) {
  let repaired = 0;
  let needsAttention = 0;
  const sagas = await claimPendingSagas(db, limit);
  for (const saga of sagas) {
    try {
      const booked = await db.query(`SELECT EXISTS (
        SELECT 1 FROM public.appointment_calendar WHERE event_id=$1
      ) AS present`, [saga.event_id]);
      if (booked.rows[0]?.present) {
        await completeCalendarSaga(db, saga.event_id, 'committed');
        continue;
      }
      try {
        // Google Calendar deletion is idempotent when 404 means already gone.
        await cancelEvent(saga.event_id);
      } catch (error) {
        if (Number(error?.code || error?.response?.status) !== 404 && error?.code !== 'EVENT_NOT_FOUND') throw error;
      }
      await completeCalendarSaga(db, saga.event_id, 'compensated');
      repaired++;
    } catch (error) {
      const attempts = Number(saga.attempts || 0) + 1;
      const delay = Math.min(3600, 60 * Math.pow(2, Math.min(attempts, 6)));
      const stalled = attempts >= 12;
      await db.query(`UPDATE public.calendar_booking_sagas
        SET attempts=$2, next_attempt_at=now()+($3*interval '1 second'),
        locked_until=NULL, last_error=$4, updated_at=now(), status=$5 WHERE event_id=$1`,
        [saga.event_id, attempts, delay, String(error?.code || error?.name || 'sync_error').slice(0, 60),
          stalled ? 'needs_attention' : 'pending']);
      if (stalled) needsAttention++;
      logger(stalled ? 'error' : 'warn', stalled ? 'calendar_saga_needs_attention' : 'calendar_saga_retry',
        { attempts, errorCode: String(error?.code || 'unknown') });
    }
  }
  return { examined: sagas.length, repaired, needsAttention };
}
