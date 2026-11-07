/**
 * PostgreSQL transactional outbox for Calendar side effects.
 *
 * Invariant: a writer must enqueue in the same transaction that changes an
 * appointment. Provider calls are retried separately and are idempotent.
 * Each lease has a fencing token, preventing an expired worker from marking a
 * newer worker's job as complete.
 */
const VALID_OPERATIONS = new Set(['create', 'cancel', 'update', 'reschedule']);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TERMINAL_STATUS = new Set([400, 401, 403, 422]);
const TERMINAL_CODES = new Set(['UNBOUND_CALENDAR','INVALID_APPOINTMENT','BOOKING_METADATA_MISSING','BOOKING_NO_LONGER_ACTIVE']);
const MAX_ATTEMPTS = 12;

export function validateCalendarJob({ operation, eventId, payload = {} }) {
  if (!VALID_OPERATIONS.has(operation) || typeof eventId !== 'string' || !eventId.trim()) {
    throw new TypeError('Invalid Calendar outbox operation or eventId');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      JSON.stringify(payload).length > 20_000) {
    throw new TypeError('Invalid Calendar outbox payload');
  }
  if (operation === 'reschedule') {
    const start = Date.parse(payload.start);
    const end = Date.parse(payload.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new TypeError('Invalid reschedule interval');
    }
  }
}

export async function enqueueCalendarJob(tx, job) {
  validateCalendarJob(job);
  const result = await tx.query(
    `INSERT INTO public.calendar_outbox(operation,event_id,payload,calendar_id)
     VALUES($1,$2,$3::jsonb,$4) RETURNING job_id`,
    [job.operation, job.eventId, JSON.stringify(job.payload || {}), job.calendarId || null],
  );
  return result.rows[0].job_id;
}

/** FIFO per event: concurrent workers cannot execute a newer operation first. */
export async function claimCalendarJobs(pool, limit = 10) {
  const result = await pool.query(`
    UPDATE public.calendar_outbox AS target
    SET lease_until = now() + interval '2 minutes',
        lease_token = gen_random_uuid()
    WHERE target.job_id IN (
      SELECT candidate.job_id
      FROM public.calendar_outbox AS candidate
      WHERE candidate.status = 'pending'
        AND candidate.available_at <= now()
        AND (candidate.lease_until IS NULL OR candidate.lease_until < now())
        AND NOT EXISTS (
          SELECT 1 FROM public.calendar_outbox AS earlier
          WHERE earlier.event_id = candidate.event_id
            AND earlier.job_id < candidate.job_id
            AND earlier.status <> 'done'
        )
      ORDER BY candidate.job_id
      LIMIT $1 FOR UPDATE OF candidate SKIP LOCKED
    )
    RETURNING target.job_id,target.operation,target.event_id,target.calendar_id,
              target.payload,target.attempts,target.lease_token`,
    [Math.max(1, Math.min(50, Number(limit) || 10))],
  );
  return result.rows;
}

function providerCalendarId(job, env) {
  if (job.calendar_id) return job.calendar_id;
  const ids = String(env.CALENDAR_SYNC_CALENDARS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length > 1) return null;
  return env.CALENDAR_ID || ids[0] || null;
}

function errorCode(error) {
  return Number(error?.response?.status || error?.code) || 0;
}

function permanent(error, attempt) {
  const status = errorCode(error);
  if (TERMINAL_CODES.has(error?.code)) return true;
  if (TERMINAL_STATUS.has(status)) return true;
  if (attempt >= MAX_ATTEMPTS) return true;
  // Unknown provider or network error: retry with capped backoff.
  return false;
}

export async function drainCalendarOutbox({ pool, cancel, update, reschedule, create, limit = 10,
  logger = () => {}, onCancelled = null, env = process.env }) {
  const jobs = await claimCalendarJobs(pool, limit);
  let done = 0;
  let attention = 0;

  for (const job of jobs) {
    try {
      const calendarId = providerCalendarId(job, env);
      if (!calendarId) {
        const error = new Error('Unbound calendar');
        error.code = 'UNBOUND_CALENDAR';
        throw error;
      }
      if (job.operation === 'create') {
        if (typeof create !== 'function') throw new Error('Missing create handler');
        await create({ ...job, calendar_id: calendarId });
      } else if (job.operation === 'cancel') {
        if (typeof cancel !== 'function') throw new Error('Missing cancel handler');
        try { await cancel(job.event_id, calendarId); }
        catch (error) {
          if (errorCode(error) !== 404 && error?.code !== 'EVENT_NOT_FOUND') throw error;
        }
      } else if (job.operation === 'reschedule') {
        if (typeof reschedule !== 'function') throw new Error('Missing reschedule handler');
        await reschedule({ ...job.payload, eventId: job.event_id, calendarId });
      } else {
        if (typeof update !== 'function') throw new Error('Missing update handler');
        await update({ ...job.payload, eventId: job.event_id, calendarId });
      }

      // Only after provider confirmation: offer an explicitly opted-in waitlist candidate.
      // Callback failures are retried, while provider cancellation is idempotent (404=success).
      if (job.operation === 'cancel' && typeof onCancelled === 'function' &&
          job.payload?.start && job.payload?.end && job.payload?.professionalId && job.payload?.serviceId) {
        await onCancelled(job.payload);
      }
      const result = await pool.query(`
        UPDATE public.calendar_outbox SET status='done',lease_until=NULL,
          lease_token=NULL,finished_at=now(),last_error=NULL
        WHERE job_id=$1 AND lease_token=$2 AND status='pending'`,
      [job.job_id, job.lease_token]);
      if (result.rowCount > 0) done++;
    } catch (error) {
      const attempts = Number(job.attempts) + 1;
      const terminal = permanent(error, attempts);
      const backoff = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
      const reason = String(error?.code || error?.name || 'provider_error').slice(0, 64);
      const result = await pool.query(`
        UPDATE public.calendar_outbox
        SET attempts=$2,status=$3,lease_until=NULL,lease_token=NULL,
          available_at=now()+($4*interval '1 second'),last_error=$5
        WHERE job_id=$1 AND lease_token=$6 AND status='pending'`,
      [job.job_id, attempts, terminal ? 'attention' : 'pending', backoff,
        reason, job.lease_token]);
      if (terminal && result.rowCount > 0) attention++;
      logger('warn', 'calendar_outbox_retry', { code: reason, attempts, terminal });
    }
  }
  return { processed: jobs.length, done, attention };
}
