import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateSlotRequest,overlapsBusyEvents,checkCalendarSlot} from '../src/services/calendar-guard.js';
import {findMentionedServices,createMultiBookingConversation} from '../src/services/multi-booking-chat.js';
import {calendarPauseFile} from '../src/services/calendar-maintenance.js';
const read=rel=>readFileSync(new URL('../'+rel,import.meta.url),'utf8');
const slot={professionalId:2,appointmentId:42,start:'2026-12-03T10:00:00+01:00',end:'2026-12-03T11:00:00+01:00'};
test('calendar slot validator refuses malformed and excessive intervals',()=>{
 assert.equal(validateSlotRequest(slot).professionalId,2);
 assert.throws(()=>validateSlotRequest({...slot,end:'2026-12-03T09:00:00+01:00'}),TypeError);
 assert.throws(()=>validateSlotRequest({...slot,end:'2026-12-04T09:00:00+01:00'}),TypeError);
 assert.throws(()=>validateSlotRequest({...slot,professionalId:'abc'}),TypeError);
});
test('provider calendar overlaps external events, but ignores only matching event ID',()=>{
 const busy=[{id:'ours',start:{dateTime:'2026-12-03T10:15:00+01:00'},end:{dateTime:'2026-12-03T10:30:00+01:00'}}];
 assert.equal(overlapsBusyEvents(busy,slot),true);
 assert.equal(overlapsBusyEvents(busy,{...slot,ignoreEventId:'ours'}),false);
 assert.equal(overlapsBusyEvents([{...busy[0],transparency:'transparent'}],slot),false);
 assert.equal(overlapsBusyEvents([{...busy[0],status:'cancelled'}],slot),false);
 assert.throws(()=>overlapsBusyEvents([{start:{dateTime:'broken'},end:{dateTime:'broken'}}],slot),/invalid_calendar_event/);
});
test('calendar gate checks the professional AND salon calendar, fail closed',async()=>{
 const ids=[];
 const db={async query(sql){ if(sql.includes('FROM public.professionals'))return {rows:[{email:'operator@example.com'}]};
   return {rows:[{professional_id:2,event_id:'ours',calendar_id:'operator@example.com'}]}; }};
 const calendar={events:{async list({calendarId}){
   ids.push(calendarId);return {data:{items:calendarId==='salon@example.com'?
    [{id:'external',start:{dateTime:'2026-12-03T10:30:00+01:00'},end:{dateTime:'2026-12-03T11:00:00+01:00'}}]:
    [{id:'ours',start:{dateTime:'2026-12-03T10:00:00+01:00'},end:{dateTime:'2026-12-03T11:00:00+01:00'}}]}};
 }}};
 assert.deepEqual(await checkCalendarSlot({db,calendar,request:slot,defaultCalendarId:'salon@example.com'}),{available:false});
 assert.deepEqual(ids,['operator@example.com','salon@example.com']);
 await assert.rejects(checkCalendarSlot({db,calendar:{events:{list:async()=>{throw Error('offline');}}},request:slot}),/offline/);
});
test('calendar gate never excludes managed event when professional changes',async()=>{
 const db={async query(sql){return sql.includes('FROM public.professionals')?{rows:[{email:'new@example.com'}]}:
 {rows:[{professional_id:1,event_id:'ours',calendar_id:'new@example.com'}]};}};
 const calendar={events:{list:async()=>({data:{items:[{id:'ours',start:{dateTime:slot.start},end:{dateTime:slot.end}}]}})}};
 assert.deepEqual(await checkCalendarSlot({db,calendar,request:slot}),{available:false});
});
test('natural language identifies two exact catalog labels in spoken order',()=>{
 assert.deepEqual(findMentionedServices('Vorrei prenotare pedicure e manicure gel',
 ['Manicure gel','Manicure','Pedicure']),['Pedicure','Manicure gel']);
 assert.deepEqual(findMentionedServices('Vorrei prenotare manicure', ['Manicure','Pedicure']),['Manicure']);
});
test('technician update recognizes flat ZIP and restore blocks unsafe replay',()=>{
 const update=read('strumenti/aggiorna.ps1');
 assert.match(update,/\$new=\$staging/);assert.match(update,/src\/index\.js/);
 assert.doesNotMatch(update,/\$new=Join-Path \$staging 'synk'/);
 const restore=read('strumenti/ripristina.ps1');
 assert.match(restore,/calendar-reconciliation-required\.flag/);
 assert.ok(restore.indexOf('calendar-reconciliation-required.flag')<restore.indexOf('pg_restore --list'));
 assert.match(restore,/restore_reconcile_required/);
 const node=read('src/index.js');
 assert.match(node,/isCalendarPaused\(\)/);
 const php=read('dashboard/api/router.php');
 assert.match(php,/assert_external_calendar_available/);
 assert.match(php,/assert_calendar_not_suspended/);
});
test('maintenance flag is a local persistent runtime file',()=>{
 assert.equal(calendarPauseFile({APP_DATA_DIR:'/app/runtime/config'},'/app'),'/app/runtime/config/calendar-reconciliation-required.flag');
});
