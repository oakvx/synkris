import test from 'node:test';
import assert from 'node:assert/strict';
import {createMultiServicePlan,enabledProfessionals,prepareMultiInterval,verifyMultiAvailability,commitMultiBooking,createMultiBookingConversation} from '../src/services/multi-booking-chat.js';

const services=[{id:1,name:'Manicure',baseDuration:45,buffer:10,price:30},{id:2,name:'Pedicure',baseDuration:30,buffer:15,price:25}];
test('multi service plan validates catalog entries and rejects duplicates',async()=>{
 const db={query:async(sql,args)=>({rows:args[0]==='Manicure'?
  [{service_id:1,service_name:'Manicure',default_duration_min:45,buffer_after_min:10,base_price:'30'}]:
  [{service_id:2,service_name:'Pedicure',default_duration_min:30,buffer_after_min:15,base_price:'25'}]})};
 const result=await createMultiServicePlan(db,['Manicure','Pedicure']);
 assert.deepEqual(result,services);
 await assert.rejects(createMultiServicePlan(db,['Manicure','Manicure']),/duplicate_service/);
 await assert.rejects(createMultiServicePlan(db,['Manicure']),/invalid_services/);
});
test('qualified professionals require all service authorizations',async()=>{
 let sqlQuery='';const db={query:async(sql,args)=>{sqlQuery=sql;assert.deepEqual(args,[[1,2],2]);return {rows:[{professional_id:3,full_name:'Operatrice',email:'op@salone.it'}]};}};
 assert.equal((await enabledProfessionals(db,services))[0].id,3);
 assert.match(sqlQuery,/HAVING count\(DISTINCT ps.service_id\)=\$2/);
});
test('duration builder sums each customized duration and associated buffer',async()=>{
 const date={toUTC:()=>({toISO:()=> '2026-12-14T09:00:00Z'}),plus:({minutes})=>({toUTC:()=>({toISO:()=> '2026-12-14T10:40:00Z'}),toFormat:()=> '2026-12-14'}),toFormat:()=> '2026-12-14'};
 const db={query:async()=>({rows:[{service_id:1,duration_min:55}]})};
 const interval=await prepareMultiInterval(db,{services,professional:{id:3},date});
 assert.equal(interval.minutes,110); // 55+10+30+15
 assert.deepEqual(interval.parts.map(x=>x.duration),[55,30]);
});
test('calendar rejects conflicting intervals and cannot fail open',async()=>{
 const date={weekday:1,toFormat:key=>key==='HH:mm'?'09:00':'2026-12-14',plus:()=>({toFormat:()=> '10:40'})};
 const seq=[{rows:[{open_time:'09:00:00',close_time:'18:00:00',is_closed:false}]},{rows:[],rowCount:0},{rows:[],rowCount:0},{rows:[],rowCount:0},{rows:[]},{rows:[{occupied:false}]}];
 const db={query:async()=>seq.shift()};const options={db,professional:{id:3,email:'op@salone.it'},interval:{start:'2026-12-14T09:00:00Z',end:'2026-12-14T10:40:00Z',minutes:100},date};
 const calendar={freebusy:{query:async()=>({data:{calendars:{'op@salone.it':{busy:[{start:'2026-12-14T09:00:00Z',end:'2026-12-14T09:15:00Z'}]}}}})}};
 assert.equal(await verifyMultiAvailability(db,{...options,calendar}),false);
});
test('transaction inserts one appointment and two ordered services with Calendar outbox',async()=>{
 const calls=[];
 const connection={query:async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('SELECT client_id'))return {rows:[]};
  if(sql.includes('INSERT INTO public.clients'))return {rows:[{client_id:55}]};
  if(sql.includes('count(DISTINCT ps.service_id)'))return {rows:[{allowed:2}]};
  if(sql.includes('INSERT INTO public.appointments'))return {rows:[{appointment_id:150}]};
  if(sql.includes('INSERT INTO public.calendar_outbox'))return {rows:[{job_id:99}]};
  return {rows:[]};},release:()=>{}};
 const db={connect:async()=>connection};
 const id=await commitMultiBooking(db,{chatId:'393331234567@c.us',clientName:'Cliente Test',professional:{id:3},interval:{start:'2026-12-14T09:00:00Z',end:'2026-12-14T10:40:00Z',parts:[{id:1,duration:55},{id:2,duration:30}]}});
 assert.equal(id,150);
 assert.equal(calls.filter(x=>x.sql.includes('INSERT INTO public.appointment_services')).length,2);
 assert.ok(calls.some(x=>x.sql.includes('INSERT INTO public.calendar_outbox')));
 assert.equal(calls.at(-1).sql,'COMMIT');
});
test('multi booking chat demands privacy acceptance before collecting services',async()=>{
 const sent=[];const conversation=createMultiBookingConversation({db:{},send:async(id,message)=>sent.push(message),calendarClient:async()=>{},privacyText:()=> 'Informativa del salone'});
 assert.equal(await conversation.handle('393331234567@c.us','/multi'),true);
 assert.match(sent.at(-1),/ACCETTO/);
 assert.equal(await conversation.handle('393331234567@c.us','altro'),true);
 assert.match(sent.at(-1),/ACCETTO/);
 assert.equal(await conversation.handle('393331234567@c.us','ACCETTO'),true);
 assert.match(sent.at(-1),/separati da virgola/);
 conversation.cancel('393331234567@c.us');
 assert.equal(await conversation.handle('393331234567@c.us','manicure, pedicure'),false);
});
