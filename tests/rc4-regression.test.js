import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createModule as createEventModule} from '../src/services/gcal/events.js';
import {calendarMidnightUtc, overlapsBusyEvents, checkCalendarSlot} from '../src/services/calendar-guard.js';

const read = path => fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Calendar all-day busy times are local Rome midnights, including DST switch',()=>{
  assert.equal(new Date(calendarMidnightUtc('2026-10-25')).toISOString(),'2026-10-24T22:00:00.000Z');
  assert.equal(new Date(calendarMidnightUtc('2026-10-26')).toISOString(),'2026-10-25T23:00:00.000Z');
  assert.equal(new Date(calendarMidnightUtc('2026-07-15')).toISOString(),'2026-07-14T22:00:00.000Z');
  assert.equal(overlapsBusyEvents([{start:{date:'2026-10-25'},end:{date:'2026-10-26'}}],
    {start:'2026-10-24T22:30:00Z',end:'2026-10-24T23:00:00Z'}),true);
});

test('Calendar creation respects outbox calendarId rather than env/default calendar',async()=>{
  const ids=[];
  const calendar={events:{insert:async({calendarId,requestBody})=>{
    ids.push(calendarId);
    return {data:{id:requestBody.id,summary:requestBody.summary}};
  }}};
  const {createCalendarEvent}=createEventModule({
    _retry: action=>action(),
    buildTreatmentEvent: ({serviceName,startTime})=>({summary:serviceName,description:'example',start:{dateTime:startTime},end:{dateTime:startTime}}),
    ensureCalendarAccess:async (id)=>{ids.push('check:'+id);},
    getCalendarClient:async()=>calendar,
    resolveCalendarId:()=> 'salon-default@group.calendar.google.com'
  },{});
  const result=await createCalendarEvent({eventId:'b12345',calendarId:'employee@group.calendar.google.com',
    serviceName:'Manicure',professionalEmail:'employee@example.com',clientPhone:'Non fornito',
    startTime:'2026-10-29T10:00:00+01:00',durationMin:30});
  assert.equal(result.id,'b12345');
  assert.deepEqual(ids,['check:employee@group.calendar.google.com','employee@group.calendar.google.com']);
});

test('Calendar check fails closed when a second calendar contains a busy event', async()=>{
  const calls=[];
  const db={query:async(sql)=> sql.includes('FROM public.professionals') ? {rows:[{email:'pro@example.com'}]} : {rows:[]}};
  const calendar={events:{list:async({calendarId})=>{
    calls.push(calendarId);
    return {data:{items:calendarId==='salon@group.calendar.google.com'?
      [{start:{date:'2026-10-25'},end:{date:'2026-10-26'}}]:[]}};
  }}};
  const result=await checkCalendarSlot({db,calendar,request:{professionalId:1,
    start:'2026-10-24T22:30:00Z',end:'2026-10-24T23:00:00Z'},
    defaultCalendarId:'salon@group.calendar.google.com'});
  assert.deepEqual(result,{available:false});
  assert.deepEqual(calls,['pro@example.com','salon@group.calendar.google.com']);
});

test('dashboard booking writer parses local timestamps to ISO with offsets before Calendar check',()=>{
  const php=read('dashboard/api/router.php');
  const a=php.indexOf('$startAt = synk_parse_appointment_datetime($startTime)');
  const b=php.indexOf('$startTime = $startAt->format(');
  const c=php.indexOf('assert_external_calendar_available($proId, $startTime, $endTime');
  assert.ok(a>0 && b>a && c>b,'Calendar check must use normalized local time');
});

test('dashboard date filter uses local day rather than UTC date slice',()=>{
  const js=read('dashboard/assets/management-appointments.js');
  assert.match(js,/const localToday =/);
  assert.doesNotMatch(js,/new Date\(\)\.toISOString\(\)\.slice\(0,10\)/);
});

test('WhatsApp multiple-service availability verifies employee AND salon calendars',async()=>{
  const {verifyMultiAvailability}=await import('../src/services/multi-booking-chat.js');
  const before=process.env.CALENDAR_ID;
  process.env.CALENDAR_ID='salon@group.calendar.google.com';
  try {
    let checked=[];
    const db={query:async sql=>{
      if(sql.includes('public.salon_business_hours'))return {rows:[{open_time:'09:00:00',close_time:'19:00:00',is_closed:false}]};
      if(sql.includes('SELECT EXISTS'))return {rows:[{occupied:false}]};
      return {rows:[],rowCount:0};
    }};
    const date={weekday:1,toFormat:format=>format==='yyyy-MM-dd'?'2026-11-02':'10:00',
      plus:()=>({toFormat:()=> '11:00'})};
    const calendar={freebusy:{query:async({requestBody})=>{
      checked=requestBody.items.map(x=>x.id);
      return {data:{calendars:{'pro@example.com':{busy:[]},
        'salon@group.calendar.google.com':{busy:[{start:'2026-11-02T10:30:00+01:00'}]}}}};
    }}};
    const available=await verifyMultiAvailability(db,{professional:{id:1,email:'pro@example.com'},
      interval:{start:'2026-11-02T09:00:00Z',end:'2026-11-02T10:00:00Z',minutes:60},date,calendar});
    assert.equal(available,false);
    assert.deepEqual(checked,['pro@example.com','salon@group.calendar.google.com']);
  } finally {
    if (before === undefined) delete process.env.CALENDAR_ID;
    else process.env.CALENDAR_ID=before;
  }
});

test('waitlist does not offer a freed slot when salon main calendar remains busy',async()=>{
  const {verifyReleasedSlot}=await import('../src/services/waitlist/availability.js');
  const before=process.env.CALENDAR_ID;
  process.env.CALENDAR_ID='salon@group.calendar.google.com';
  try {
    const start='2026-11-02T10:00:00Z',end='2026-11-02T11:00:00Z';
    const db={query:async()=>({rows:[{occupied:false}]})};
    const apiFactory=async()=>({
      freebusy:{query:async()=>({data:{calendars:{
        'pro@example.com':{busy:[]},
        'salon@group.calendar.google.com':{busy:[{start,end}]}
      }}})}
    });
    const result=await verifyReleasedSlot({db,start,end,professionalId:1,
      professionalEmail:'pro@example.com',apiFactory});
    assert.equal(result,false);
  } finally {
    if (before === undefined) delete process.env.CALENDAR_ID;
    else process.env.CALENDAR_ID=before;
  }
});
