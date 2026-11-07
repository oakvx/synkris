import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createModule} from '../src/services/gcal/availability.js';
import {createAlertMonitor,findOperationalAnomalies,smtpSettings} from '../src/services/anomaly-alerts.js';

function read(rel){return readFileSync(new URL('../'+rel,import.meta.url),'utf8');}
test('slot durations include operator-specific minutes plus post-treatment buffer',async()=>{
 const date=new Date('2026-12-14T12:00:00+01:00');const wd=date.getDay();
 const shared={services:{'Manicure':{duration:30,bufferAfterMin:15,
  professionals:['a@example.com','b@example.com'],professionalDurations:{'b@example.com':45}}},
  BUSINESS_HOURS:{[wd]:['09:00','12:00']},MAX_OVERRUN:0,holidays:[],unavailability:{}};
 const deps={__isoDow:d=>d.getDay()||7,getCalendarClient:async()=>({freebusy:{query:async()=>({data:{calendars:{'a@example.com':{busy:[]},'b@example.com':{busy:[]}}}})}}),retry:fn=>fn()};
 const result=await createModule(deps,shared).getFreeSlotsForDay('Manicure',date);
 assert.equal(result['a@example.com'].slots.length,4); // 45min
 assert.equal(result['b@example.com'].slots.length,3); // 60min
});
test('anomaly detection has a startup grace period for WhatsApp',()=>{
 const state={dbOnline:true,online:false,lastInboundSyncStatus:'ok',startedAt:1};
 assert.deepEqual(findOperationalAnomalies(state,{now:5000,graceMs:10000}),[]);
 assert.deepEqual(findOperationalAnomalies(state,{now:20000,graceMs:10000}),['whatsapp_offline']);
});
test('alert monitor waits for repeated failures and applies cooldown',async()=>{
 let time=60_000;const delivered=[];const state={online:true,dbOnline:false,startedAt:0};
 const check=createAlertMonitor({state,send:async x=>delivered.push(x),clock:()=>time,requiredTicks:3,cooldownMs:60000});
 await check();await check();assert.equal(delivered.length,0);
 await check();assert.equal(delivered.length,1);
 await check();assert.equal(delivered.length,1);
 time+=61_000;await check();assert.equal(delivered.length,2);
 state.dbOnline=true;await check();state.dbOnline=false;await check();
 assert.equal(delivered.length,2); // new incident still needs three observations
});
test('no SMTP without explicit opt-in and invalid mail configuration fails closed',()=>{
 assert.equal(smtpSettings({ALERT_EMAIL_ENABLED:'0'}),null);
 assert.throws(()=>smtpSettings({ALERT_EMAIL_ENABLED:'1'}),/SMTP/);
});
test('php persistence includes multi-service sequence, authorization and normalized duration',()=>{
 const code=read('dashboard/api/router.php');
 assert.match(code,/trattamento_non_abilitato_per_operatrice/);
 assert.match(code,/\$serviceIds = array_map\('intval'/);
 assert.match(code,/\$totalMinutes \+= \$minutes \+ \$buffer/);
 assert.match(code,/INSERT INTO public\.appointment_services\(appointment_id,service_id,duration_min,sort_order\)/);
 assert.match(code,/\$pdo->beginTransaction\(\)/);
});
test('dashboard supports editing operator durations and multi-service selection',()=>{
 assert.match(read('dashboard/assets/management-appointments.js'),/gProDuration/);
 assert.match(read('dashboard/assets/management-appointments.js'),/gApptSvcCheck/);
 assert.match(read('dashboard/assets/management-catalog.js'),/gSvcBuffer/);
 assert.match(read('src/services/calendar-outbox-booking.js'),/string_agg\(ss\.service_name/);
});
