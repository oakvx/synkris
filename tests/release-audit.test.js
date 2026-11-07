import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModule } from '../src/services/gcal/availability.js';
import {addToWaitlist,findWaitlistCandidates,listWaitlistOptions} from '../src/services/waitlist/waitlist.js';
import {readClientDetails} from '../src/services/salon-operations.js';

function windowDates(){const start=new Date(Date.now()+24*3600e3);const end=new Date(Date.now()+48*3600e3);return {earliestAt:start.toISOString(), latestAt:end.toISOString()};}
test('waiting list does not accept generic requests without a real treatment',async()=>{
 const db={async query(){throw new Error('No DB query should happen before validation');}};
 await assert.rejects(addToWaitlist(db,{chatId:'393331234567@c.us',consent:true,...windowDates()}),/Trattamento obbligatorio/);
});
test('waiting list checks service and operator permissions before enrolling',async()=>{
 const queries=[];const db={async query(sql,args){queries.push({sql,args});
  if(sql.includes('FROM public.services'))return {rows:[{service_id:42}]};
  if(sql.includes('FROM public.professional_services'))return {rows:[]};
  return {rows:[{request_id:7}]};}};
 await assert.rejects(addToWaitlist(db,{chatId:'393331234567@c.us',serviceId:42,professionalId:3,consent:true,...windowDates()}),/non abilitata/);
 assert.equal(queries.length,2);
});
test('waiting list new requests correctly link service and professional',async()=>{
 const db={async query(sql,args){
  if(sql.includes('FROM public.services'))return {rows:[{service_id:42}]};
  if(sql.includes('FROM public.professional_services'))return {rows:[{ok:1}]};
  assert.match(sql,/INSERT INTO public.waitlist_requests/);
  assert.equal(args[3],3); assert.equal(args[4],42);
  return {rows:[{request_id:9}]};}};
 assert.equal(await addToWaitlist(db,{chatId:'393331234567@c.us',serviceId:42,professionalId:3,consent:true,...windowDates()}),9);
});
test('waiting list filters for exact service on cancellation',async()=>{
 const db={async query(sql){assert.match(sql,/AND service_id=\$4/);assert.doesNotMatch(sql,/service_id IS NULL OR/);return {rows:[]};}};
 assert.deepEqual(await findWaitlistCandidates(db,{start:'2026-12-10T10:00:00+01:00',end:'2026-12-10T10:30:00+01:00',professionalId:1,serviceId:42}),[]);
});
test('operator selections come from active database entities',async()=>{
 const sql=[];const db={async query(q){sql.push(q);return {rows:[]};}};
 const result=await listWaitlistOptions(db);
 assert.deepEqual(result,{services:[],professionals:[]});
 assert.ok(sql.every(q=>q.includes('is_active=true')));
});
test('availability uses per-operator duration, not only service default',async()=>{
 const chosen=new Date('2026-12-14T12:00:00+01:00');
 const wd=new Date(chosen).getDay();
 const shared={services:{Manicure:{duration:30,professionals:['a@example.com','b@example.com'],professionalDurations:{'b@example.com':60}}},
  BUSINESS_HOURS:{[wd]:['09:00','11:00']},unavailability:{},holidays:[],MAX_OVERRUN:0};
 const calendars = {
   'a@example.com': {busy:[]},
   'b@example.com': {busy:[]},
 };
 const calendarClient = {freebusy:{query:async()=>({data:{calendars}})}};
 const deps={
   __isoDow:date=>date.getDay()===0?7:date.getDay(),
   getCalendarClient:async()=>calendarClient,
   retry:fn=>fn(),
   rrulestr:null
 };
 const module=createModule(deps,shared);
 const result=await module.getFreeSlotsForDay('Manicure',chosen);
 assert.equal(result['a@example.com'].slots.length,4);
 assert.equal(result['b@example.com'].slots.length,2);
});
test('dashboard does not pretend local settings change database backup frequency',()=>{
 const html=fs.readFileSync(new URL('../dashboard/view.html',import.meta.url),'utf8');
 assert.ok(!html.includes('id="settingsBackup"'));
 assert.ok(html.includes('id="synkWaitService"'));
 assert.ok(html.includes('id="synkWaitWithdraw"'));
 const bridge=fs.readFileSync(new URL('../bridge.php',import.meta.url),'utf8');
 assert.ok(bridge.includes("'/api/waitlist/options'"));
});

test('salon closed dates are selected as ISO dates for PostgreSQL DATE compatibility',()=>{
 const code=fs.readFileSync(new URL('../src/services/gcal.js',import.meta.url),'utf8');
 assert.match(code,/SELECT to_char\(day, 'YYYY-MM-DD'\) AS day FROM public\.salon_closed_dates/);
});

test('client detail loads recent booking history with parameterized query',async()=>{
 const calls=[];const db={async query(sql,args){calls.push({sql,args});return calls.length===1?{rows:[{client_id:123,full_name:'Test Client',appointment_count:1,note:''}]}:
 {rows:[{appointment_id:9,service_name:'Manicure',professional_name:'Operator',status:'confirmed'}]};}};
 const client=await readClientDetails(db,123);
 assert.equal(client.appointments.length,1);
 assert.deepEqual(calls[1].args,[123]);
 assert.match(calls[1].sql,/ORDER BY a.start_time DESC LIMIT 20/);
});
