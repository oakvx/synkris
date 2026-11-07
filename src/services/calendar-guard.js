/** Fail-closed verification of external Calendar events for dashboard mutations.
 * Managed event can be excluded ONLY in the same calendar, allowing reschedules.
 */
export function validateSlotRequest(input) {
  const professionalId=Number(input?.professionalId);
  const appointmentId=input?.appointmentId==null?null:Number(input.appointmentId);
  const startMs=Date.parse(input?.start||'');const endMs=Date.parse(input?.end||'');
  if(!Number.isSafeInteger(professionalId)||professionalId<1||
    (appointmentId!==null&&(!Number.isSafeInteger(appointmentId)||appointmentId<1))||
    !Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs||endMs-startMs>16*3600e3)
    throw new TypeError('invalid_calendar_slot');
  return {professionalId,appointmentId,start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()};
}
/** Google Calendar all-day dates represent midnight in the calendar's time
 * zone, NOT midnight UTC. UTC interpretation would miss early-morning busy
 * hours in Europe/Rome (particularly at the DST boundary).
 */
export function calendarMidnightUtc(date, zone='Europe/Rome') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_calendar_date');
  const midnightUtc=Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnightUtc) || new Date(midnightUtc).toISOString().slice(0,10)!==date)
    throw new Error('invalid_calendar_date');
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let estimate=midnightUtc;
  for(let n=0;n<4;n++) {
    const parts=Object.fromEntries(fmt.formatToParts(new Date(estimate))
      .filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
    const observed=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    estimate+=midnightUtc-observed;
  }
  return estimate;
}
function getEventTimes(event,calendarTimeZone){
  const resolve=(part)=>{
    if(part?.dateTime) {
      const t=Date.parse(part.dateTime);
      if(!Number.isFinite(t))throw new Error('invalid_calendar_event');
      return t;
    }
    if(part?.date)return calendarMidnightUtc(part.date,part.timeZone||calendarTimeZone);
    throw new Error('invalid_calendar_event');
  };
  const a=resolve(event?.start),b=resolve(event?.end);
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)throw new Error('invalid_calendar_event');
  return [a,b];
}
export function overlapsBusyEvents(events,{start,end,ignoreEventId=null,calendarTimeZone='Europe/Rome'}={}) {
  const a=Date.parse(start||''),b=Date.parse(end||'');
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)throw new TypeError('invalid_calendar_slot');
  for(const item of events){
    if(item.status==='cancelled'||item.transparency==='transparent'||(ignoreEventId&&item.id===ignoreEventId))continue;
    const [x,y]=getEventTimes(item,calendarTimeZone);
    if(x<b&&y>a)return true;
  }
  return false;
}
export async function checkCalendarSlot({db,calendar,request,defaultCalendarId}){
  const slot=validateSlotRequest(request);
  const [pro,existing]=await Promise.all([
    db.query(`SELECT pe.email FROM public.professionals p JOIN public.professional_emails pe
       ON pe.professional_id=p.professional_id WHERE p.professional_id=$1 AND p.is_active=true
       ORDER BY pe.email LIMIT 1`,[slot.professionalId]),
    slot.appointmentId?db.query(`SELECT a.professional_id,ac.event_id,ac.calendar_id
       FROM public.appointments a LEFT JOIN public.appointment_calendar ac
       ON ac.appointment_id=a.appointment_id WHERE a.appointment_id=$1`,[slot.appointmentId]):Promise.resolve({rows:[]})
  ]);
  if(!pro.rows?.[0]?.email)throw Object.assign(new Error('calendar_professional_unconfigured'),{status:422});
  if(slot.appointmentId&&!existing.rows.length)throw Object.assign(new Error('appointment_not_found'),{status:404});
  const professionalCalendar=String(pro.rows[0].email);
  const calendars=[...new Set([professionalCalendar,defaultCalendarId].filter(Boolean))];
  // Do not consider Calendar verified until every configured calendar succeeds.
  for(const calendarId of calendars){
    const mapped=existing.rows[0];
    const ignoreEventId=(mapped&&Number(mapped.professional_id)===slot.professionalId&&
      mapped.calendar_id===calendarId)?mapped.event_id:null;
    let pageToken=undefined;
    for(let page=0;page<10;page++){
      const result=await calendar.events.list({calendarId,
        timeMin:slot.start,timeMax:slot.end,singleEvents:true,showDeleted:false,maxResults:250,
        pageToken});
      // A malformed or incomplete provider response is NOT an empty agenda.
      if (!result?.data || !Array.isArray(result.data.items))
        throw new Error('calendar_response_invalid');
      if(overlapsBusyEvents(result.data.items,{...slot,ignoreEventId,calendarTimeZone:process.env.TZ||'Europe/Rome'}))return {available:false};
      pageToken=result.data.nextPageToken;
      if(!pageToken)break;
      if(page===9)throw new Error('calendar_results_truncated');
    }
  }
  return {available:true};
}
