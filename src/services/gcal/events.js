import { eventMatchesExpected, isCalendarConflict } from './event-identity.js';
/** Google Calendar events domain. */
export function createModule(dependencies, shared) {
  const { _retry, buildTreatmentEvent, ensureCalendarAccess, getCalendarClient, resolveCalendarId } = dependencies;

async function createCalendarEvent({
  eventId = null,
  calendarId = null,
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  clientName = null,
  startTime,
  durationMin,
  price = null,
  serviceDetails = null,
  allergies = null, // string | string[] | null
  allergic = null, // true | false | null
  reminders,
  allergicWarning = null
}) {
  if (!serviceName || !professionalEmail || !clientPhone || !startTime || !durationMin) {
    throw new Error('Parametri obbligatori mancanti (serviceName, professionalEmail, clientPhone, startTime, durationMin).');
  }

  const calendar = await getCalendarClient();
  const CALENDAR_ID = calendarId || resolveCalendarId();
  await ensureCalendarAccess(CALENDAR_ID);

  const eventPayload = buildTreatmentEvent({
    serviceName,
    professionalEmail,
    professionalName,
    clientPhone,
    clientName,
    startTime,
    durationMin,
    price,
    serviceDetails,
    allergies,
    allergic,
    reminders,
    allergicWarning
  });

  if (eventId) {
    if (!/^[a-v0-9]{5,1024}$/.test(eventId)) throw new Error('Google Calendar event ID non valido');
    eventPayload.id = eventId;
  }

  try {
    const res = await _retry(() =>
      calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventPayload,
        supportsAttachments: true,
      })
    );
    return res.data;
  } catch (err) {
    // Ambiguous network retries can create the event before the client sees
    // the response. Re-read provider state and accept 409 only on exact match.
    if (eventId && isCalendarConflict(err)) {
      try {
        const found = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
        if (eventMatchesExpected(found?.data, eventPayload, eventId)) return found.data;
      } catch { /* never assume that an unknown event belongs to this booking */ }
    }
    const reason = String(err?.errors?.[0]?.reason || err?.code || err?.message || 'unknown');
    if (reason.toLowerCase().includes('login required')) {
      throw new Error('Login Required — il service account non ha accesso al calendario o manca l’impersonation (DWD). Condividi il calendario con l’email del SA o imposta GCAL_IMPERSONATE.');
    }
    throw new Error(`Creazione evento fallita: ${reason}`);
  }
}

async function updateCalendarEvent({
  eventId,
  serviceName,
  professionalEmail,
  professionalName = null,
  clientPhone,
  clientName = null,
  startTime,
  durationMin,
  price = null,
  serviceDetails = null,
  allergies = null, // string | string[] | null
  allergic = null, // true | false | null
  reminders = [{
    method: 'popup',
    minutes: 1440
  }],
  allergicWarning = null,
  calendarId = (process.env.CALENDAR_ID)
}) {
  if (!eventId) throw new Error('eventId mancante per updateCalendarEvent');
  const calendar = await getCalendarClient();

  // Ricostruisci il payload evento (summary/description/orari)
  const body = buildTreatmentEvent({
    serviceName,
    professionalEmail,
    professionalName,
    clientPhone,
    clientName,
    startTime,
    durationMin,
    price,
    serviceDetails,
    allergies,
    allergic,
    reminders,
    allergicWarning
  });

  // UPDATE (mantiene lo stesso eventId); manda update a tutti
  const res = await _retry(() => calendar.events.update({
    calendarId,
    eventId,
    sendUpdates: 'all',
    requestBody: body
  }));
  return res.data;

}

async function cancelCalendarEvent(
  eventId,
  calendarId = (process.env.CALENDAR_ID)
) {
  const calendar = await getCalendarClient();
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all'
    });
    return true;
  } catch (err) {
    const code = err?.code || err?.response?.status;
    if (code === 404) {
      const e = new Error('Evento non trovato.');
      e.code = 'EVENT_NOT_FOUND';
      throw e;
    }
    if (code === 403) {
      const e = new Error('Permesso negato.');
      e.code = 'PERMISSION_DENIED';
      throw e;
    }
    if (code === 429) {
      const e = new Error('Quota superata.');
      e.code = 'QUOTA_EXCEEDED';
      throw e;
    }
    const e = new Error('CANCEL_FAILED');
    e.cause = err;
    throw e;
  }
}

async function deleteEvent({
  eventId,
  calendarId
} = {}) {
  if (!eventId) throw new Error('deleteEvent: eventId required');
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId: calendarId || resolveCalendarId(),
    eventId,
    sendUpdates: 'none', // nessuna notifica agli invitati
  });
  return true;
}

async function cancelEvent({
  eventId,
  calendarId
} = {}) {
  if (!eventId) throw new Error('cancelEvent: eventId required');
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId: calendarId || resolveCalendarId(),
    eventId,
    sendUpdates: 'all', // invia email di annullamento agli invitati
  });
  return true;
}

  return { createCalendarEvent, updateCalendarEvent, cancelCalendarEvent, deleteEvent, cancelEvent };
}
