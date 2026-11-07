/**
 * Explicit, isolated WhatsApp multi-service booking flow.
 * Always verifies salon hours, professional authorizations, DB conflicts and
 * Google freebusy. An appointment is stored in one PG transaction with its
 * Calendar outbox create job. Never claims provider confirmation before sync.
 */
import { enqueueCalendarJob } from './calendar-outbox.js';

const ENTRY = /^(?:\/multi|prenotazione multipla|pi[uù] trattamenti)$/i;
const MULTI_REQUEST = /(?:prenot|appuntament|vorrei|posso).*\b(?:due|tre|quattro|pi[uù]|diversi|sia)\b.*(?:trattament|serviz|lavor|che|,)/i;
function folded(s){return String(s||'').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
/** Only infer a bundle when two distinct full catalog labels appear in the request. */
export function findMentionedServices(text,serviceNames){
 const source=folded(text);const matched=[];const occupied=[];
 for(const name of [...serviceNames].sort((a,b)=>b.length-a.length)){
   const candidate=folded(name);
   if(candidate.length<3)continue;
   let offset=0;
   while((offset=source.indexOf(candidate,offset))!==-1){
     const end=offset+candidate.length;
     const boundaryLeft=offset===0 || !/[\p{L}\p{N}]/u.test(source[offset-1]);
     const boundaryRight=end===source.length || !/[\p{L}\p{N}]/u.test(source[end]);
     if(boundaryLeft&&boundaryRight&&!occupied.some(([a,b])=>offset<b&&end>a)){
       matched.push({name,offset});occupied.push([offset,end]);break;
     }
     offset=end;
   }
 }
 return matched.sort((a,b)=>a.offset-b.offset).map(x=>x.name);
}
async function mentionedBundle(db,text){
 if(!/(?:prenot|appuntament|vorrei|posso)/i.test(text) || !/(?: e |,|\bpi[uù]\b|\bdue\b|\bsia\b)/i.test(text))return [];
 try {
   const results=await db.query('SELECT service_name FROM public.services WHERE is_active=true ORDER BY service_name LIMIT 300');
   return findMentionedServices(text,results.rows.map(r=>r.service_name));
 }catch{return []; /* Keep the ordinary conversation usable when catalog lookup fails. */}
}
const YES = /^(?:si|sì|confermo)$/i;
const NO = /^(?:no|annulla|stop)$/i;
const DATE_INPUT = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const MAX_AGE = 20*60*1000;
const truthy = v => v === true || v === 't' || v === '1' || v === 1;
const label = x => String(x||'').trim();
const isoDay = date => date.toFormat('yyyy-MM-dd');

export async function parseLocalAppointment(input, {now=Date.now()}={}) {
  if(typeof input!=='string' || !DATE_INPUT.test(input))throw new TypeError('invalid_date');
  const {DateTime} = await import('luxon');
  const date=DateTime.fromFormat(input,'dd/MM/yyyy HH:mm',{zone:'Europe/Rome',locale:'it'});
  if(!date.isValid || date.toFormat('dd/MM/yyyy HH:mm')!==input ||
    date.toMillis()<=now || date.toMillis()>now+90*24*60*60*1000)throw new TypeError('invalid_date');
  return date;
}

export async function createMultiServicePlan(db,names){
  if(!Array.isArray(names)||names.length<2||names.length>6)throw new TypeError('invalid_services');
  const result=[];
  for(const raw of names){
    const name=label(raw);
    if(!name || name.length>100)throw new TypeError('invalid_services');
    const query=await db.query(`SELECT service_id,service_name,default_duration_min,buffer_after_min,base_price
      FROM public.services WHERE lower(service_name)=lower($1) AND is_active=true`,[name]);
    if(query.rows.length!==1)throw new TypeError('unknown_service: '+name);
    const s=query.rows[0];
    if(result.some(x=>x.id===Number(s.service_id)))throw new TypeError('duplicate_service');
    result.push({id:Number(s.service_id),name:s.service_name,baseDuration:Number(s.default_duration_min),
      buffer:Number(s.buffer_after_min||0),price:s.base_price===null?null:Number(s.base_price)});
  }
  return result;
}

export async function enabledProfessionals(db,services){
  const ids=services.map(s=>s.id);
  const result=await db.query(`SELECT p.professional_id,p.full_name,
    (SELECT pe.email FROM public.professional_emails pe WHERE pe.professional_id=p.professional_id
      ORDER BY pe.email LIMIT 1) AS email
    FROM public.professionals p JOIN public.professional_services ps ON ps.professional_id=p.professional_id
    WHERE p.is_active=true AND ps.service_id=ANY($1::bigint[])
    GROUP BY p.professional_id,p.full_name
    HAVING count(DISTINCT ps.service_id)=$2 ORDER BY p.full_name LIMIT 40`,[ids,ids.length]);
  return result.rows.filter(p=>p.email).map(p=>({...p,id:Number(p.professional_id)}));
}

export async function prepareMultiInterval(db,{services,professional,date}){
  const ids=services.map(s=>s.id);
  const result=await db.query(`SELECT service_id,duration_min FROM public.professional_service_durations
    WHERE professional_id=$1 AND service_id=ANY($2::bigint[])`,[professional.id,ids]);
  const overrides=new Map(result.rows.map(r=>[Number(r.service_id),Number(r.duration_min)]));
  const parts=services.map(s=>({...s,duration:overrides.get(s.id)||s.baseDuration}));
  if(parts.some(p=>p.duration<1||p.duration>480||p.buffer<0||p.buffer>180))throw new TypeError('duration_invalid');
  const minutes=parts.reduce((t,p)=>t+p.duration+p.buffer,0);
  if(minutes<1||minutes>960)throw new TypeError('duration_invalid');
  const end=date.plus({minutes});
  if(isoDay(end)!==isoDay(date))throw new TypeError('outside_hours');
  return {parts,start:date.toUTC().toISO(),end:end.toUTC().toISO(),minutes};
}

export async function verifyMultiAvailability(db,{professional,interval,date,calendar}){
  const day=isoDay(date),weekday=date.weekday;
  const [schedule,closures,off,absences,breaks,occupied]=await Promise.all([
    db.query('SELECT open_time,close_time,is_closed FROM public.salon_business_hours WHERE weekday=$1',[weekday]),
    db.query('SELECT 1 FROM public.salon_closed_dates WHERE day=$1::date LIMIT 1',[day]),
    db.query('SELECT 1 FROM public.professional_unavailable_weekdays WHERE professional_id=$1 AND weekday=$2 LIMIT 1',[professional.id,weekday]),
    db.query('SELECT 1 FROM public.professional_time_off WHERE professional_id=$1 AND start_day<=$2::date AND end_day>=$2::date LIMIT 1',[professional.id,day]),
    db.query('SELECT start_time,end_time FROM public.salon_lunch_breaks WHERE weekday=$1',[weekday]),
    db.query(`SELECT EXISTS(SELECT 1 FROM public.appointments WHERE professional_id=$1
      AND lower(status) NOT IN ('cancelled','canceled','annullato','completed','completato','done','no_show')
      AND tstzrange(start_time,end_time,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')) AS occupied`,
      [professional.id,interval.start,interval.end])
  ]);
  const h=schedule.rows[0];
  if(!h||truthy(h.is_closed)||closures.rowCount||off.rowCount||absences.rowCount||truthy(occupied.rows[0]?.occupied))return false;
  const start=date.toFormat('HH:mm'),end=date.plus({minutes:interval.minutes}).toFormat('HH:mm');
  if(start< String(h.open_time).slice(0,5)||end>String(h.close_time).slice(0,5))return false;
  if(breaks.rows.some(b=>start<String(b.end_time).slice(0,5)&&end>String(b.start_time).slice(0,5)))return false;
  try {
    // Calendar generale e calendario dell'operatrice possono contenere impegni
    // diversi: la prenotazione e' sicura solo se ENTRAMBI sono consultabili e liberi.
    const calendarIds=[...new Set([professional.email,process.env.CALENDAR_ID].filter(Boolean))];
    if (!calendarIds.length) return false;
    const response=await calendar.freebusy.query({requestBody:{timeMin:interval.start,timeMax:interval.end,
      items:calendarIds.map(id=>({id}))}});
    return calendarIds.every(id=>{
      const data=response.data?.calendars?.[id];
      return !!data && !data.errors?.length && Array.isArray(data.busy) && data.busy.length===0;
    });
  }catch{return false;}
}

export async function commitMultiBooking(db,{chatId,clientName,professional,interval}){
  if(!/^\d{5,20}@c\.us$/.test(chatId)||!clientName||clientName.length>80)throw new TypeError('invalid_client');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const contact=await client.query(`SELECT client_id FROM public.client_contacts
      WHERE type='whatsapp_chat' AND value=$1 LIMIT 1 FOR UPDATE`,[chatId]);
    let clientId=contact.rows[0]?.client_id;
    if(!clientId){
      const row=await client.query('INSERT INTO public.clients(full_name) VALUES($1) RETURNING client_id',[clientName]);
      clientId=row.rows[0].client_id;
      await client.query(`INSERT INTO public.client_contacts(client_id,type,value)
        VALUES($1,'whatsapp_chat',$2)`,[clientId,chatId]);
      await client.query(`INSERT INTO public.client_contacts(client_id,type,value)
        VALUES($1,'phone',$2) ON CONFLICT DO NOTHING`,[clientId,chatId.split('@')[0]]);
    }
    // Revalidate authorizations inside the booking transaction, after any
    // intervening catalog or personnel edits made from the dashboard.
    const permissions=await client.query(`SELECT count(DISTINCT ps.service_id)::integer AS allowed
      FROM public.professional_services ps
      JOIN public.professionals p ON p.professional_id=ps.professional_id AND p.is_active=true
      JOIN public.services s ON s.service_id=ps.service_id AND s.is_active=true
      WHERE ps.professional_id=$1 AND ps.service_id=ANY($2::bigint[])`,
      [professional.id,interval.parts.map(s=>s.id)]);
    if(Number(permissions.rows[0]?.allowed)!==interval.parts.length)throw new TypeError('service_authorization_changed');
    const appt=await client.query(`INSERT INTO public.appointments
      (client_id,professional_id,service_id,start_time,end_time,status)
      VALUES($1,$2,$3,$4,$5,'pending') RETURNING appointment_id`,
      [clientId,professional.id,interval.parts[0].id,interval.start,interval.end]);
    const id=Number(appt.rows[0].appointment_id);
    for(let i=0;i<interval.parts.length;i++){
      const part=interval.parts[i];
      await client.query(`INSERT INTO public.appointment_services
        (appointment_id,service_id,duration_min,sort_order) VALUES($1,$2,$3,$4)`,
      [id,part.id,part.duration,i]);
    }
    const eventId='b'+id.toString(16).padStart(8,'0');
    await enqueueCalendarJob(client,{operation:'create',eventId,calendarId:process.env.CALENDAR_ID,
      payload:{appointmentId:id}});
    await client.query('COMMIT');
    return id;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release();}
}

export function createMultiBookingConversation({db,send,calendarClient,privacyText,parseDate=parseLocalAppointment,now=()=>Date.now()}){
  const sessions=new Map();
  const say=(id,message)=>send(id,message);
  const clear=id=>sessions.delete(id);
  async function handle(chatId,input){
    const text=label(input);const key=text.toLowerCase();
    let state=sessions.get(chatId);
    if(state&&now()-state.updatedAt>MAX_AGE){clear(chatId);state=null;}
    const inferred=!state && !ENTRY.test(text) ? await mentionedBundle(db,text) : [];
    if(ENTRY.test(text) || MULTI_REQUEST.test(text) || inferred.length>=2){
      sessions.set(chatId,{step:'consent',updatedAt:now(),presetServices:inferred.length>=2?inferred:null});
      await say(chatId,'Prenotazione con più trattamenti. Prima di procedere, leggi l’informativa:\n'+privacyText(chatId)+
        '\n\nPer proseguire scrivi ACCETTO. Per uscire scrivi ANNULLA.');
      return true;
    }
    if(!state)return false;
    if(NO.test(key)){clear(chatId);await say(chatId,'Richiesta multipla annullata.');return true;}
    state.updatedAt=now();
    try{
      if(state.step==='consent'){
        if(key!=='accetto'){await say(chatId,'Per procedere scrivi ACCETTO o ANNULLA.');return true;}
        if(state.presetServices){
          state.services=await createMultiServicePlan(db,state.presetServices);
          state.professionals=await enabledProfessionals(db,state.services);
          if(!state.professionals.length){clear(chatId);await say(chatId,'Nessuna operatrice può eseguire tutti i trattamenti richiesti. Contatta il salone.');return true;}
          state.step='professional';
          await say(chatId,'Trattamenti riconosciuti: '+state.services.map(s=>s.name).join(' + ')+
            '\nScegli l’operatrice rispondendo con il numero:\n'+state.professionals.map((v,i)=>`${i+1}) ${v.full_name}`).join('\n'));
          return true;
        }
        state.step='services';await say(chatId,'Scrivi da 2 a 6 trattamenti, separati da virgola, con i nomi esatti del listino.');return true;
      }
      if(state.step==='services'){
        const names=text.split(',').map(x=>x.trim()).filter(Boolean);
        state.services=await createMultiServicePlan(db,names);
        state.professionals=await enabledProfessionals(db,state.services);
        if(!state.professionals.length){clear(chatId);await say(chatId,'Nessuna operatrice può eseguire tutti i trattamenti scelti. Contatta il salone.');return true;}
        state.step='professional';await say(chatId,'Scegli l’operatrice rispondendo con il numero:\n'+
          state.professionals.map((p,i)=>`${i+1}) ${p.full_name}`).join('\n'));return true;
      }
      if(state.step==='professional'){
        const idx=Number(key)-1;
        if(!Number.isInteger(idx)||idx<0||idx>=state.professionals.length){await say(chatId,'Indica un numero valido dell’elenco.');return true;}
        state.professional=state.professionals[idx];state.step='date';
        await say(chatId,'Scrivi data e ora desiderate nel formato GG/MM/AAAA HH:MM (es. 15/12/2026 14:30).');return true;
      }
      if(state.step==='date'){
        state.date=await parseDate(text,{now:now()});
        state.interval=await prepareMultiInterval(db,{services:state.services,professional:state.professional,date:state.date});
        const available=await verifyMultiAvailability(db,{professional:state.professional,
          interval:state.interval,date:state.date,calendar:await calendarClient()});
        if(!available){await say(chatId,'Orario non disponibile o calendario non verificabile. Inserisci un’altra data e ora.');return true;}
        state.step='name';await say(chatId,'L’orario risulta disponibile. Scrivi il nome e cognome da associare alla prenotazione.');return true;
      }
      if(state.step==='name'){
        if(text.length<3||text.length>80||/[\r\n]/.test(text)){await say(chatId,'Inserisci un nome e cognome valido (3-80 caratteri).');return true;}
        state.name=text;state.step='confirm';
        await say(chatId,`Riepilogo: ${state.services.map(s=>s.name).join(' + ')}\n`+
          `Operatrice: ${state.professional.full_name}\nQuando: ${state.date.toFormat('dd/MM/yyyy HH:mm')}\n`+
          `Blocco agenda: ${state.interval.minutes} minuti (pause comprese).\n`+
          'Scrivi CONFERMO per richiedere la prenotazione, oppure ANNULLA.');return true;
      }
      if(state.step==='confirm'){
        if(!YES.test(key)){await say(chatId,'Scrivi CONFERMO oppure ANNULLA.');return true;}
        state.step='saving';
        const interval=await prepareMultiInterval(db,{services:state.services,professional:state.professional,date:state.date});
        if(!await verifyMultiAvailability(db,{professional:state.professional,interval,date:state.date,calendar:await calendarClient()})){
          state.step='date';await say(chatId,'Lo slot non è più disponibile. Scegli un’altra data e ora.');return true;
        }
        await commitMultiBooking(db,{chatId,clientName:state.name,professional:state.professional,interval});
        clear(chatId);
        await say(chatId,'Richiesta registrata nel salone. La sincronizzazione con Google Calendar è in corso; per la conferma definitiva contatta il salone.');
        return true;
      }
      if(state.step==='saving')return true;
    }catch(error){
      if(state.step==='saving')state.step='date';
      if(error?.code==='23P01'){state.step='date';await say(chatId,'Nel frattempo lo slot è stato occupato. Inserisci un’altra data e ora.');}
      else if(error instanceof TypeError && state.step==='services')await say(chatId,'Trattamenti non riconosciuti. Inserisci da 2 a 6 nomi esatti separati da virgola.');
      else if(error instanceof TypeError && state.step==='date')await say(chatId,'Data o durata non valida. Usa GG/MM/AAAA HH:MM entro i prossimi 90 giorni.');
      else {clear(chatId);await say(chatId,'Non posso completare la richiesta in sicurezza. Contatta il salone.');}
      return true;
    }
    return true;
  }
  return {handle,cancel:clear};
}
