import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModule } from '../src/services/gcal/availability.js';
import { checkCalendarSlot } from '../src/services/calendar-guard.js';
import { pruneWaitlist, offerVerifiedSlot } from '../src/services/waitlist/waitlist.js';

const Z = 'Z';
const dt = hhmm => new Date('2026-12-14T'+hhmm+':00'+Z);

test('free intervals cannot cross a busy event even when MAX_OVERRUN permits late closing', () => {
  const module = createModule({}, {MAX_OVERRUN:30});
  const available = module.computeSlots([
    {start:dt('09:00'),end:dt('09:40')},
    {start:dt('09:50'),end:dt('10:00')},
  ],dt('09:00'),dt('10:00'),30);
  assert.deepEqual(available,[]);
});

test('a provider event after closing cannot push an available slot beyond opening hours', () => {
  const module = createModule({}, {MAX_OVERRUN:0});
  const available = module.computeSlots([
    {start:dt('12:00'),end:dt('13:00')},
  ],dt('09:00'),dt('10:00'),30);
  assert.equal(available.length,1);
  assert.equal(available[0].start.toISOString(),dt('09:00').toISOString());
  assert.equal(available[0].end.toISOString(),dt('10:00').toISOString());
});

test('a gap at closing can overrun only when no busy event blocks the treatment', () => {
  const module = createModule({}, {MAX_OVERRUN:15});
  const available = module.computeSlots([
    {start:dt('09:00'),end:dt('09:40')},
  ],dt('09:00'),dt('10:00'),30);
  assert.equal(available.length,1);
  assert.equal(available[0].start.toISOString(),dt('09:40').toISOString());
});

test('all treatment slots include the general salon calendar and operator calendar', async () => {
  const previous = process.env.CALENDAR_ID;
  process.env.CALENDAR_ID = 'salon@example.com';
  try {
    let requested=[];
    const cal={freebusy:{query:async ({requestBody})=>{
      requested=requestBody.items.map(x=>x.id);
      return {data:{calendars:{
        'pro@example.com':{busy:[]},
        'salon@example.com':{busy:[{start:'2026-12-14T09:00:00Z',end:'2026-12-14T09:30:00Z'}]}
      }}};
    }}};
    const date = dt('09:00');
    const day=date.getDay();
    const module=createModule({
      getCalendarClient:async()=>cal,
      retry:fn=>fn(),
      __isoDow:()=>1,
    },{
      BUSINESS_HOURS:{[day]:['09:00','10:00']},
      services:{Manicure:{duration:30,professionals:['pro@example.com']}},
      unavailability:{},holidays:[],MAX_OVERRUN:0
    });
    const result=await module.getFreeSlotsForDay('Manicure',date);
    assert.deepEqual(requested,['pro@example.com','salon@example.com']);
    assert.deepEqual(result['pro@example.com'].slots,['09:30']);
    await module.getFreeSlotsForProfessional('pro@example.com',30,date);
    assert.deepEqual(requested,['pro@example.com','salon@example.com']);
  } finally {
    if(previous===undefined)delete process.env.CALENDAR_ID;
    else process.env.CALENDAR_ID=previous;
  }
});

test('calendar slot guard rejects malformed provider success payload instead of treating it as free',async()=>{
  const db={query:async()=>({rows:[{email:'pro@example.com'}]})};
  for(const response of [null,{}, {data:{}}, {data:{items:null}}]){
    const calendar={events:{list:async()=>response}};
    await assert.rejects(checkCalendarSlot({db,calendar,
      request:{professionalId:1,start:'2026-12-14T09:00:00Z',end:'2026-12-14T09:30:00Z'},
      defaultCalendarId:'salon@example.com'}),/calendar_response_invalid/);
  }
});

test('expired waiting-list offers are reopened while consent still holds',async()=>{
  const sql=[];
  const db={query:async query=>{sql.push(query);return {rowCount:1};}};
  await pruneWaitlist(db);
  assert.match(sql[0],/status='offered'/);
  assert.match(sql[0],/SET status=CASE WHEN w\.expires_at<=now\(\) THEN 'expired' ELSE 'active' END/);
  assert.match(sql[0],/NOT EXISTS/);
  assert.match(sql[1],/status IN \('active','offered'\)/);
});

test('waitlist does not notify twice for a duplicate slot and resets request',async()=>{
  const future=new Date(Date.now()+86_400_000).toISOString();
  const end=new Date(Date.now()+87_000_000).toISOString();
  const queries=[];let notified=0;
  const db={query:async sql=>{
    queries.push(sql);
    if(sql.includes('FROM public.waitlist_requests'))return {rows:[{request_id:4,chat_id:'393331234567@c.us'}]};
    if(sql.includes('SET status=\'offered\''))return {rowCount:1};
    if(sql.includes('INSERT INTO public.waitlist_offers'))return {rowCount:0};
    return {rowCount:1};
  }};
  const result=await offerVerifiedSlot({db,start:future,end,professionalId:1,serviceId:2,
    verifyAvailability:async()=>true,notify:async()=>{notified++;}});
  assert.deepEqual(result,{offered:0});
  assert.equal(notified,0);
  assert.ok(queries.some(sql=>sql.includes("SET status='active'")));
});

test('dashboard status changes validate external Calendar and forbid unsafe cancellation reactivation',()=>{
  const source=fs.readFileSync(new URL('../dashboard/api/router.php',import.meta.url),'utf8');
  const start=source.indexOf("if ($route === 'db_appointment_cancel')");
  const end=source.indexOf("if ($route === 'db_appointment_delete')",start);
  const block=source.slice(start,end);
  assert.ok(start>0 && end>start);
  assert.match(block,/Cannot reactivate a cancelled appointment/);
  assert.match(block,/assert_external_calendar_available\(/);
  assert.match(block,/pg_advisory_xact_lock/);
});

test('waitlist slot validation rejects malformed or excessive dates before using the DB',async()=>{
  const {verifyReleasedSlot}=await import('../src/services/waitlist/availability.js');
  const db={query:async()=>{throw new Error('must not query DB for malformed slot');}};
  const goodStart=new Date(Date.now()+3_600_000).toISOString();
  const tooLateEnd=new Date(Date.now()+30*3_600_000).toISOString();
  for(const [start,end] of [
    ['bad',goodStart],
    [goodStart,'invalid'],
    [goodStart,tooLateEnd],
  ]) {
    assert.equal(await verifyReleasedSlot({db,start,end,professionalId:1,professionalEmail:'pro@example.com'}),false);
  }
  assert.equal(await verifyReleasedSlot({db,start:goodStart,end:tooLateEnd,
    professionalId:'abc',professionalEmail:'pro@example.com'}),false);
});

test('holiday checks use Europe/Rome salon day, not yesterday in UTC',async()=>{
  const original = process.env.TZ;
  process.env.TZ = 'Europe/Rome';
  try {
    const date = new Date('2026-12-24T23:30:00.000Z'); // 25 Dec, 00:30 in Rome
    const module=createModule({
      getCalendarClient:async()=>{throw new Error('holiday must not call Calendar');},
      retry:fn=>fn(),
      __isoDow:()=>5,
    },{
      BUSINESS_HOURS:{[date.getDay()]:['00:00','07:00']},
      services:{Manicure:{duration:30,professionals:['pro@example.com']}},
      unavailability:{},holidays:['2026-12-25'],MAX_OVERRUN:0
    });
    assert.deepEqual(await module.getFreeSlotsForDay('Manicure',date),{});
    assert.deepEqual(await module.getFreeSlotsForProfessional('pro@example.com',30,date),[]);
  } finally {
    if(original===undefined)delete process.env.TZ;
    else process.env.TZ=original;
  }
});
