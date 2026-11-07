import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHoursPlan,isChatPaused,setChatPaused,deleteChatData,validChatId,replaceHoursPlan} from '../src/services/salon-operations.js';
import {validateCalendarJob,claimCalendarJobs,drainCalendarOutbox} from '../src/services/calendar-outbox.js';
import {resolveOllamaBase,postOllama} from '../src/ai/ollama-client.js';
import {createModule as createPrivacyModule} from '../src/core/modules/conversation/privacy.js';

const baseHours=()=>({hours:Array.from({length:7},(_,i)=>({weekday:i+1,closed:i>4,
  open:'09:00',close:'18:00',breakStart:i>4?'':'13:00',breakEnd:i>4?'':'14:00'})),
  closedDates:['2026-12-25']});

test('valid salon hours incl lunch and closed dates',()=>{
  const plan=validateHoursPlan(baseHours());
  assert.equal(plan.hours.length,7);assert.equal(plan.hours[6].closed,true);assert.equal(plan.closedDates[0],'2026-12-25');
});
test('invalid overlapping lunch, times, and duplicate days are rejected',()=>{
  const plan=baseHours();plan.hours[0].breakEnd='20:00';
  assert.throws(()=>validateHoursPlan(plan),/invalid_break/);
  plan.hours[0].breakEnd='14:00';plan.hours[0].open='18:00';
  assert.throws(()=>validateHoursPlan(plan),/invalid_opening_hours/);
  assert.throws(()=>validateHoursPlan({hours:[]}));
});
test('schedule writes are atomic and rollback on error',async()=>{
  const events=[];
  const db={async connect(){return {async query(sql){events.push(sql);
    if(sql.includes('INSERT INTO public.salon_closed_dates'))throw Error('disk');},release(){events.push('RELEASE');}}}};
  await assert.rejects(replaceHoursPlan(db,baseHours()),/disk/);
  assert.ok(events.includes('BEGIN'));assert.ok(events.includes('ROLLBACK'));
  assert.ok(!events.includes('COMMIT'));
});
test('WhatsApp id format validated before any DB access',async()=>{
  assert.ok(validChatId('393331234567@c.us'));assert.ok(!validChatId('outside@web'));
  await assert.rejects(setChatPaused({query(){throw Error('must not happen');}},'1@web',true),TypeError);
});
test('operator handoff stops messages when DB says paused',async()=>{
  const q=[];const db={async query(sql,args){q.push({sql,args});if(sql.includes('INSERT'))return {rowCount:1};return {rowCount:1};}};
  assert.deepEqual(await setChatPaused(db,'393331234567@c.us',true),{chatId:'393331234567@c.us',paused:true});
  assert.equal(await isChatPaused(db,'393331234567@c.us'),true);
  assert.equal(q.length,2);
});
test('privacy deletion uses transaction and removes chat/consent records',async()=>{
  const calls=[];const db={async connect(){return {async query(sql){calls.push(sql);return {rows:[]};},release(){calls.push('RELEASE');}}}};
  const previous=process.env.ADMIN_TOKEN;process.env.ADMIN_TOKEN='a'.repeat(64);
  try{await deleteChatData(db,'393331234567@c.us');}
  finally{if(previous===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=previous;}
  assert.ok(calls.some(sql=>sql.includes('privacy_requests')));
  assert.deepEqual([calls[0],calls.at(-2),calls.at(-1)],['BEGIN','COMMIT','RELEASE']);
  assert.ok(calls.some(sql=>sql.includes('waitlist_requests')));
});
test('calendar outbox claim uses the candidate alias and proper locking',async()=>{
  const db={async query(sql){assert.match(sql,/candidate\.lease_until/);
    assert.match(sql,/earlier\.event_id = candidate\.event_id/);
    assert.match(sql,/SKIP LOCKED/);return {rows:[]};}};
  assert.deepEqual(await claimCalendarJobs(db),[]);
});
test('Calendar cancellation invokes verified waitlist callback after provider reply',async()=>{
  const payload={start:'2026-12-10T10:00:00+01:00',end:'2026-12-10T10:30:00+01:00',professionalId:3,serviceId:4};
  const calls=[];
  const db={async query(sql){if(sql.includes('UPDATE public.calendar_outbox AS target'))return {rows:[{job_id:9,operation:'cancel',event_id:'e9',attempts:0,lease_token:'lease',payload}]};
    calls.push('done');return {rowCount:1};}};
  const result=await drainCalendarOutbox({pool:db,cancel:async()=>{calls.push('calendar');},onCancelled:async data=>{
    assert.deepEqual(data,payload);calls.push('waitlist');},env:{CALENDAR_ID:'salone@example.com'}});
  assert.deepEqual(calls,['calendar','waitlist','done']);assert.equal(result.done,1);
});
test('bad calendar job is rejected; retryable failure never marks success',async()=>{
  assert.throws(()=>validateCalendarJob({operation:'delete',eventId:'abc'}),TypeError);
  const events=[];
  const pool={async query(sql){if(sql.includes('UPDATE public.calendar_outbox AS target'))return {rows:[{job_id:1,operation:'cancel',event_id:'e',attempts:0,lease_token:'token',payload:{}}]};
    events.push(sql);return {rowCount:1};}};
  const result=await drainCalendarOutbox({pool,cancel:async()=>{throw Error('network_down');}});
  assert.equal(result.done,0);assert.match(events[0],/SET attempts=\$2/);
});
test('Ollama docker local host allowed, plaintext remote refused',()=>{
  assert.equal(resolveOllamaBase({OLLAMA_URL:'http://ollama:11434'}),'http://ollama:11434');
  assert.throws(()=>resolveOllamaBase({OLLAMA_URL:'http://example.com:11434',OLLAMA_ALLOW_REMOTE:'1'}),/HTTPS/);
});
test('AI disabled never sends external requests',async()=>{
  let called=false;
  const result=await postOllama('/api/generate',{model:'x'}, {env:{AI_ENABLED:'0'},fetchImpl:()=>{called=true;}});
  assert.equal(result,null);assert.equal(called,false);
});
test('Italian privacy notice is nonempty and accurate about external providers',()=>{
  const p=createPrivacyModule({PRIVACY_NOTICE_VERSION:1},{});
  const notice=p.privacyNoticeTextIT();
  assert.match(notice,/Google Calendar/);assert.match(notice,/WhatsApp/);assert.ok(notice.length>100);
});
