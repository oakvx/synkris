import { google } from 'googleapis';
import { readFile } from 'node:fs/promises';
import { syncCalendarIncremental } from './calendar-sync.js';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
export async function createReadOnlyCalendarApi(env = process.env) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  const key = env.GOOGLE_CREDENTIALS_JSON ? JSON.parse(env.GOOGLE_CREDENTIALS_JSON) :
    path ? JSON.parse(await readFile(path, 'utf8')) :
      env.GOOGLE_CREDENTIALS_B64 ? JSON.parse(Buffer.from(env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')) : null;
  if (!key) throw new Error('Missing Calendar service account credentials');
  const auth = new google.auth.JWT({email:key.client_email,key:key.private_key?.replaceAll('\\n','\n'),scopes:SCOPES,
    subject:env.GCAL_IMPERSONATE||env.GOOGLE_IMPERSONATE||undefined});
  return google.calendar({version:'v3',auth});
}
export async function runCalendarSync(pool,{ env=process.env,logger=()=>{} }={}) {
  if (env.CALENDAR_INBOUND_SYNC !== '1') return {status:'disabled'};
  const calendarIds = String(env.CALENDAR_SYNC_CALENDARS || env.CALENDAR_ID || '')
    .split(',').map(id => id.trim()).filter(Boolean);
  if (!calendarIds.length || calendarIds.includes('primary') ||
      new Set(calendarIds).size !== calendarIds.length || calendarIds.length > 20) {
    throw new Error('Configure unique explicit CALENDAR_SYNC_CALENDARS IDs');
  }
  const api = await createReadOnlyCalendarApi(env);
  const calendars = {};
  for (const calendarId of calendarIds) {
    // Independent cursors/locks: a failure in one calendar does not advance its cursor.
    try {
      calendars[calendarId] = await syncCalendarIncremental({ pool, api, calendarId, logger,
        daysBack: Number(env.CALENDAR_SYNC_LOOKBACK_DAYS || 90) });
    } catch (error) {
      calendars[calendarId] = { status: 'error', code: String(error.code || 'sync_error') };
      logger('warn', 'calendar_sync_failed', { calendarId, code: calendars[calendarId].code });
    }
  }
  // Consumers use counts.applied to refresh the in-memory booking cache.
  // Preserve that contract when synchronizing multiple independent calendars.
  const counts = { applied: 0, unchanged: 0, unmanaged: 0, ignored: 0, conflict: 0 };
  for (const result of Object.values(calendars)) {
    for (const key of Object.keys(counts)) counts[key] += Number(result.counts?.[key] || 0);
  }
  return { status: Object.values(calendars).every(item => item.status === 'ok') ? 'ok' : 'degraded',
    calendars, counts };
}
