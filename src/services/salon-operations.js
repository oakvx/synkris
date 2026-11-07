/** Operator functions: parameterized queries, short lists, limited retention. */
import crypto from 'node:crypto';
export const validChatId = chatId => typeof chatId === 'string' && /^\d{5,20}@c\.us$/i.test(chatId);
export function assertChatId(chatId) {
  if (!validChatId(chatId)) throw new TypeError('invalid_chat_id');
  return chatId;
}
export async function isChatPaused(db, chatId) {
  const result = await db.query(`SELECT paused FROM public.chat_handoffs
    WHERE chat_id=$1 AND paused=true AND expires_at>now()`, [assertChatId(chatId)]);
  return result.rowCount > 0;
}
export async function setChatPaused(db, chatId, paused) {
  assertChatId(chatId);
  if (typeof paused !== 'boolean') throw new TypeError('invalid_state');
  await db.query(`INSERT INTO public.chat_handoffs(chat_id,paused,expires_at)
    VALUES($1,$2,now() + interval '24 hours')
    ON CONFLICT(chat_id) DO UPDATE SET paused=EXCLUDED.paused,
    expires_at=EXCLUDED.expires_at,updated_at=now()`, [chatId,paused]);
  return {chatId,paused};
}
export async function listChats(db) {
  const result = await db.query(`SELECT s.chat_id,s.last_active_at,
    COALESCE(h.paused,false) AND h.expires_at>now() AS paused,
    (SELECT body FROM public.chat_messages m WHERE m.chat_id=s.chat_id ORDER BY message_id DESC LIMIT 1) AS preview
    FROM public.chat_sessions s LEFT JOIN public.chat_handoffs h ON h.chat_id=s.chat_id
    WHERE s.chat_id ~ '^[0-9]{5,20}@c\.us$' ORDER BY s.last_active_at DESC NULLS LAST LIMIT 100`);
  return result.rows.map(r => ({chatId:r.chat_id, lastActiveAt:r.last_active_at, paused:r.paused,
    preview:String(r.preview || '').slice(0,120)}));
}
export async function listMessages(db, chatId) {
  const result = await db.query(`SELECT direction,body,created_at FROM (
    SELECT direction,body,created_at,message_id FROM public.chat_messages
    WHERE chat_id=$1 ORDER BY message_id DESC LIMIT 40) recent ORDER BY message_id ASC`,[assertChatId(chatId)]);
  return result.rows.map(r => ({direction:r.direction, body:r.body, at:r.created_at}));
}
export async function listIncidents(db) {
  const [calendar, conflicts, sagas] = await Promise.all([
    db.query(`SELECT job_id,operation,attempts,last_error,created_at FROM public.calendar_outbox
      WHERE status='attention' ORDER BY created_at DESC LIMIT 20`),
    db.query(`SELECT calendar_id,reason,last_seen_at FROM public.calendar_sync_conflicts
      WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 20`),
    db.query(`SELECT event_id,updated_at FROM public.calendar_booking_sagas
      WHERE status='needs_attention' ORDER BY updated_at DESC LIMIT 20`).catch(() => ({rows:[]})),
  ]);
  const privacy=await db.query(`SELECT request_id,client_id,request_kind,status,requested_at
    FROM public.privacy_requests WHERE status<>'closed' ORDER BY requested_at DESC LIMIT 30`);
  return {calendar:calendar.rows,conflicts:conflicts.rows,sagas:sagas.rows,privacy:privacy.rows};
}
export async function deleteChatData(db,chatId) {
  assertChatId(chatId);
  // Only chat records, not legal booking records. Transaction guards partial deletion.
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    // Preserve an explicit workflow item for manual GDPR review of booking,
    // WhatsApp and external Calendar systems; the raw chat ID is NOT retained.
    const contact=await client.query(`SELECT client_id FROM public.client_contacts
      WHERE type='whatsapp_chat' AND value=$1 LIMIT 1`,[chatId]);
    const secret=process.env.ADMIN_TOKEN;
    if(typeof secret!=='string'||secret.length<32)throw new Error('privacy_audit_key_missing');
    const digest=crypto.createHmac('sha256',secret).update(chatId).digest('hex');
    await client.query(`INSERT INTO public.privacy_requests(client_id,request_hash,request_kind)
      VALUES($1,$2,'erasure')`,[contact.rows[0]?.client_id||null,digest]);
    await client.query('DELETE FROM public.chat_handoffs WHERE chat_id=$1',[chatId]);
    await client.query('DELETE FROM public.waitlist_requests WHERE chat_id=$1',[chatId]);
    await client.query('DELETE FROM public.chat_sessions WHERE chat_id=$1',[chatId]);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK').catch(()=>{});throw e; }
  finally { client.release(); }
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function validateHoursPlan(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new TypeError('invalid_plan');
  const hours = input.hours;
  if (!Array.isArray(hours)||hours.length!==7) throw new TypeError('seven_weekdays_required');
  const validated = hours.map((item,index)=>{
    if (!item || Number(item.weekday)!==index+1 || typeof item.closed!=='boolean') throw new TypeError('invalid_weekday');
    const start = String(item.open||''),end = String(item.close||'');
    if (!item.closed && (!TIME_RE.test(start)||!TIME_RE.test(end)||start>=end)) throw new TypeError('invalid_opening_hours');
    const bstart=String(item.breakStart||''),bend=String(item.breakEnd||'');
    if ((bstart||bend) && (item.closed||!TIME_RE.test(bstart)||!TIME_RE.test(bend)||bstart>=bend||bstart<start||bend>end)) throw new TypeError('invalid_break');
    return {weekday:index+1,closed:item.closed,open:item.closed?null:start,close:item.closed?null:end,
      breakStart:bstart||null,breakEnd:bend||null};
  });
  const closedDates=input.closedDates||[];
  if (!Array.isArray(closedDates)||closedDates.length>150 ||
      closedDates.some(x=>!/^\d{4}-\d{2}-\d{2}$/.test(x)||Number.isNaN(Date.parse(x+'T00:00:00Z')))) throw new TypeError('invalid_closed_dates');
  return {hours:validated,closedDates:[...new Set(closedDates)]};
}
export async function readHoursPlan(db){
 const [hours,breaks,dates]=await Promise.all([
  db.query('SELECT weekday,open_time,close_time,is_closed FROM public.salon_business_hours ORDER BY weekday'),
  db.query('SELECT weekday,start_time,end_time FROM public.salon_lunch_breaks ORDER BY weekday'),
  db.query("SELECT to_char(day,'YYYY-MM-DD') AS day FROM public.salon_closed_dates ORDER BY day")]);
 const rows=Array.from({length:7},(_,i)=>({weekday:i+1,closed:true,open:'09:00',close:'18:00',breakStart:'',breakEnd:''}));
 for(const r of hours.rows){const i=Number(r.weekday)-1;if(i<0||i>6)continue;
  rows[i].closed=!!r.is_closed;rows[i].open=String(r.open_time||'09:00').slice(0,5);
  rows[i].close=String(r.close_time||'18:00').slice(0,5);}
 for(const r of breaks.rows){const i=Number(r.weekday)-1;if(i<0||i>6)continue;
  rows[i].breakStart=String(r.start_time||'').slice(0,5);rows[i].breakEnd=String(r.end_time||'').slice(0,5);}
 return {hours:rows,closedDates:dates.rows.map(r=>r.day)};
}
export async function replaceHoursPlan(db,input){
 const plan=validateHoursPlan(input),client=await db.connect();
 try{
  await client.query('BEGIN');
  for(const d of plan.hours){await client.query(`INSERT INTO public.salon_business_hours
    (weekday,open_time,close_time,is_closed) VALUES($1,$2,$3,$4)
    ON CONFLICT(weekday) DO UPDATE SET open_time=EXCLUDED.open_time,
      close_time=EXCLUDED.close_time,is_closed=EXCLUDED.is_closed`,
      [d.weekday,d.open,d.close,d.closed]);}
  await client.query('DELETE FROM public.salon_lunch_breaks');
  for(const d of plan.hours)if(d.breakStart)await client.query(`INSERT INTO public.salon_lunch_breaks
    (weekday,start_time,end_time) VALUES($1,$2,$3)`,[d.weekday,d.breakStart,d.breakEnd]);
  await client.query('DELETE FROM public.salon_closed_dates');
  for(const d of plan.closedDates)await client.query('INSERT INTO public.salon_closed_dates(day) VALUES($1)',[d]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
 return {ok:true};
}
export async function readClientDetails(db,clientId){
 if(!Number.isSafeInteger(clientId)||clientId<1)throw new TypeError('invalid_client_id');
 const result=await db.query(`SELECT c.client_id,c.full_name,COALESCE(n.note,'') AS note,
    (SELECT count(*)::integer FROM public.appointments a WHERE a.client_id=c.client_id) AS appointment_count
  FROM public.clients c LEFT JOIN public.client_notes n ON n.client_id=c.client_id
  WHERE c.client_id=$1`,[clientId]);
 const client=result.rows[0];
 if(!client)return null;
 const history=await db.query(`SELECT a.appointment_id,a.start_time,a.end_time,a.status,
    COALESCE(s.service_name,'Trattamento non disponibile') AS service_name,
    COALESCE(p.full_name,'Operatrice non assegnata') AS professional_name
    FROM public.appointments a
    LEFT JOIN public.services s ON s.service_id=a.service_id
    LEFT JOIN public.professionals p ON p.professional_id=a.professional_id
    WHERE a.client_id=$1 ORDER BY a.start_time DESC LIMIT 20`,[clientId]);
 return {...client,appointments:history.rows};
}
export async function writeClientNote(db,clientId,note){
 if(!Number.isSafeInteger(clientId)||clientId<1||typeof note!=='string'||note.length>1000)throw new TypeError('invalid_client_note');
 if(!note.trim())await db.query('DELETE FROM public.client_notes WHERE client_id=$1',[clientId]);
 else await db.query(`INSERT INTO public.client_notes(client_id,note) VALUES($1,$2)
 ON CONFLICT(client_id) DO UPDATE SET note=EXCLUDED.note,updated_at=now()`,[clientId,note.trim()]);
 return {ok:true};
}

export async function readAbsences(db) {
 const result=await db.query(`SELECT p.full_name,t.absence_id,t.professional_id,
    to_char(t.start_day,'YYYY-MM-DD') AS start_day,
    to_char(t.end_day,'YYYY-MM-DD') AS end_day
    FROM public.professional_time_off t JOIN public.professionals p USING (professional_id)
    WHERE t.end_day >= current_date-interval '1 day'
    ORDER BY t.start_day LIMIT 100`);
 return result.rows;
}
export async function saveAbsence(db,{professionalId,startDay,endDay}) {
 if(!Number.isSafeInteger(professionalId)||professionalId<1 ||
   !/^\d{4}-\d{2}-\d{2}$/.test(startDay)||!/^\d{4}-\d{2}-\d{2}$/.test(endDay)||
   startDay>endDay || (Date.parse(endDay)-Date.parse(startDay))>365*864e5)throw new TypeError('invalid_absence');
 const result=await db.query(`INSERT INTO public.professional_time_off(professional_id,start_day,end_day)
    VALUES($1,$2,$3) RETURNING absence_id`,[professionalId,startDay,endDay]);
 return {id:result.rows[0].absence_id};
}
export async function deleteAbsence(db,id){
 if(!Number.isSafeInteger(id)||id<1)throw new TypeError('invalid_absence');
 const result=await db.query('DELETE FROM public.professional_time_off WHERE absence_id=$1',[id]);
 return {deleted:result.rowCount};
}

export async function searchClients(db,query){
 if(typeof query!=='string'||query.length>80)throw new TypeError('invalid_search');
 const result=await db.query(`SELECT client_id,full_name FROM public.clients
  WHERE lower(full_name) LIKE lower($1) ORDER BY full_name LIMIT 25`,['%'+query.trim()+'%']);
 return result.rows;
}
export async function listProfessionals(db){
 const result=await db.query('SELECT professional_id,full_name FROM public.professionals WHERE is_active=true ORDER BY full_name LIMIT 100');
 return result.rows;
}

/** Explicit human verification is required before closing an erasure request. */
export async function updatePrivacyRequest(db,requestId,status){
 if(!Number.isSafeInteger(requestId)||requestId<1||!['in_progress','closed'].includes(status))
   throw new TypeError('invalid_privacy_request');
 const result=await db.query(`UPDATE public.privacy_requests SET status=$2,
  reviewed_at=CASE WHEN $2='closed' THEN now() ELSE NULL END
  WHERE request_id=$1 AND status<>'closed' RETURNING request_id`,[requestId,status]);
 if(!result.rowCount)throw new TypeError('privacy_request_unavailable');
 return {ok:true};
}
/** Chat retention does not touch bookings or external legal/Calendar records. */
export async function pruneOldChatMessages(db,days=90){
 if(!Number.isInteger(days)||days<7||days>730)throw new TypeError('invalid_retention_days');
 const result=await db.query(`DELETE FROM public.chat_messages WHERE message_id IN (
   SELECT message_id FROM public.chat_messages WHERE created_at<now()-($1 * interval '1 day')
   ORDER BY created_at LIMIT 1000)`,[days]);
 return {deleted:result.rowCount};
}
