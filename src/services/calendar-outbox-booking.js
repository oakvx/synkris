/**
 * Local appointment -> provider event creation.
 * The outbox contains only appointmentId, never the customer's phone or name.
 * The provider event ID is assigned by the dashboard and reused after retries.
 */
import { enqueueCalendarJob } from './calendar-outbox.js';

const CANCELLED = new Set(['cancelled', 'canceled', 'annullato']);

function terminalBookingError(message) {
  return Object.assign(new Error(message), { code: 'BOOKING_NO_LONGER_ACTIVE' });
}

function isCancelled(status) {
  return CANCELLED.has(String(status || '').toLowerCase());
}

async function bookingForCalendar(db, appointmentId) {
  const result = await db.query(`
    SELECT a.appointment_id, a.status, a.start_time, a.end_time,
      c.full_name AS client_name,
      COALESCE((SELECT string_agg(ss.service_name,' + ' ORDER BY aps.sort_order,aps.service_id)
        FROM public.appointment_services aps JOIN public.services ss ON ss.service_id=aps.service_id
        WHERE aps.appointment_id=a.appointment_id),s.service_name) AS service_name,
      p.full_name AS professional_name,
      (SELECT pe.email FROM public.professional_emails pe
       WHERE pe.professional_id=a.professional_id ORDER BY pe.email LIMIT 1) AS professional_email,
      (SELECT cc.value FROM public.client_contacts cc
       WHERE cc.client_id=a.client_id AND cc.type='phone' LIMIT 1) AS client_phone
    FROM public.appointments a
    JOIN public.clients c ON c.client_id=a.client_id
    JOIN public.services s ON s.service_id=a.service_id
    LEFT JOIN public.professionals p ON p.professional_id=a.professional_id
    WHERE a.appointment_id=$1`, [appointmentId]);
  return result.rows[0] || null;
}

/**
 * On successful provider creation, map the event or queue a compensating cancel
 * if the appointment disappeared while the remote API was processing.
 */
export async function createAndLinkCalendarBooking({ pool, job, createEvent }) {
  const appointmentId = Number(job.payload?.appointmentId);
  if (!Number.isSafeInteger(appointmentId) || appointmentId < 1) {
    throw Object.assign(new Error('Invalid appointment reference'), { code: 'INVALID_APPOINTMENT' });
  }
  const booking = await bookingForCalendar(pool, appointmentId);
  // An interrupted previous create may have reached Google already. Never
  // silently discard the job; require operator reconciliation.
  if (!booking || isCancelled(booking.status)) {
    throw terminalBookingError('Appointment absent or cancelled; inspect Calendar for an orphan');
  }
  if (!booking.professional_email || !booking.service_name) {
    throw Object.assign(new Error('Missing Calendar booking metadata'), { code: 'BOOKING_METADATA_MISSING' });
  }
  const durationMin = Math.round((new Date(booking.end_time) - new Date(booking.start_time)) / 60_000);
  if (!Number.isSafeInteger(durationMin) || durationMin < 1) {
    throw Object.assign(new Error('Invalid appointment duration'), { code: 'INVALID_APPOINTMENT' });
  }
  const created = await createEvent({
    eventId: job.event_id,
    calendarId: job.calendar_id,
    serviceName: booking.service_name,
    professionalEmail: booking.professional_email,
    professionalName: booking.professional_name,
    clientPhone: booking.client_phone || 'Non fornito',
    clientName: booking.client_name,
    startTime: new Date(booking.start_time).toISOString(),
    durationMin,
  });
  if (created?.id !== job.event_id) throw new Error('Provider returned unexpected eventId');

  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const current = await tx.query(`SELECT start_time,end_time,status FROM public.appointments
      WHERE appointment_id=$1 FOR UPDATE`, [appointmentId]);
    if (!current.rowCount || isCancelled(current.rows[0].status)) {
      await enqueueCalendarJob(tx, { operation: 'cancel', eventId: job.event_id,
        calendarId: job.calendar_id });
      await tx.query('COMMIT');
      return { status: 'compensating_cancel' };
    }
    await tx.query(`INSERT INTO public.appointment_calendar(appointment_id,provider,event_id,calendar_id)
      VALUES($1,'gcal',$2,$3) ON CONFLICT (appointment_id) DO NOTHING`,
    [appointmentId, job.event_id, job.calendar_id]);
    const link = await tx.query(`SELECT event_id,calendar_id FROM public.appointment_calendar
      WHERE appointment_id=$1`, [appointmentId]);
    if (link.rows[0]?.event_id !== job.event_id || link.rows[0]?.calendar_id !== job.calendar_id) {
      await enqueueCalendarJob(tx, { operation: 'cancel', eventId: job.event_id,
        calendarId: job.calendar_id });
    } else {
      const latest = current.rows[0];
      const newStart = new Date(latest.start_time).toISOString();
      const newEnd = new Date(latest.end_time).toISOString();
      if (newStart !== new Date(booking.start_time).toISOString() ||
          newEnd !== new Date(booking.end_time).toISOString()) {
        await enqueueCalendarJob(tx, {operation:'reschedule', eventId: job.event_id,
          calendarId: job.calendar_id, payload:{start:newStart,end:newEnd}});
      }
    }
    await tx.query('COMMIT');
    return { status: 'linked' };
  } catch(error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

/** Keep a multi-treatment summary in sync after edits without overwriting
 * the provider's attendees, alarms, or other third-party event fields. */
export async function updateCalendarBookingSummary({pool,job,getCalendarClient}){
  const id=Number(job.payload?.appointmentId);
  if(!Number.isSafeInteger(id)||id<1)throw Object.assign(new Error('Invalid appointment reference'),{code:'INVALID_APPOINTMENT'});
  const booking=await bookingForCalendar(pool,id);
  if(!booking||isCancelled(booking.status))throw terminalBookingError('Appointment not active');
  const summary=`${booking.service_name} - ${booking.professional_name||booking.professional_email}`;
  const client=await getCalendarClient();
  await client.events.patch({calendarId:job.calendarId||job.calendar_id,eventId:job.event_id,
    requestBody:{summary:summary.slice(0,500)},sendUpdates:'none'});
}
