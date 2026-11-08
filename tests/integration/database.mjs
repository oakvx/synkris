import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {testPool,resetDatabase,seed} from './helpers.mjs';
import {enqueueCalendarJob,drainCalendarOutbox} from '../../src/services/calendar-outbox.js';
import {seedInitialSalonSettings} from '../../src/services/initial-salon-settings.js';
import {createAndLinkCalendarBooking} from '../../src/services/calendar-outbox-booking.js';
const pool=testPool();let ids;
before(async()=>{await resetDatabase(pool);ids=await seed(pool);});
after(async()=>{await pool.end();});
test('schema initialization is idempotent on PostgreSQL 16 and preserves seeded entities',async()=>{
  await pool.query(fs.readFileSync(new URL('../../scripts/db/schema.sql',import.meta.url),'utf8'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.clients')).rows[0].n,1);
});
test('exclusion constraint rejects overlaps while allowing adjacent and cancelled appointments',async()=>{
  const insert=(status,start,end)=>pool.query('INSERT INTO public.appointments(client_id,professional_id,service_id,start_time,end_time,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING appointment_id',[ids.client,ids.pro,ids.service,start,end,status]);
  const a=await insert('confirmed','2099-01-15T09:00:00+01:00','2099-01-15T10:00:00+01:00');
  await assert.rejects(insert('confirmed','2099-01-15T09:30:00+01:00','2099-01-15T10:30:00+01:00'),e=>e.code==='23P01');
  await insert('confirmed','2099-01-15T10:00:00+01:00','2099-01-15T10:30:00+01:00');
  await insert('cancelled','2099-01-15T09:15:00+01:00','2099-01-15T09:45:00+01:00');
  assert.ok(a.rows[0].appointment_id);
});
test('transaction rollback cannot leave a provider job after a failed appointment write',async()=>{
  const tx=await pool.connect();
  try{await tx.query('BEGIN');await enqueueCalendarJob(tx,{operation:'cancel',eventId:'rollback-fixture',calendarId:'operator@example.com'});await tx.query('ROLLBACK');}
  finally{tx.release();}
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.calendar_outbox WHERE event_id='rollback-fixture'")).rows[0].n,0);
});
test('durable outbox creates and links a synthetic provider event and marks it done',async()=>{
  const row=await pool.query("INSERT INTO public.appointments(client_id,professional_id,service_id,start_time,end_time) VALUES($1,$2,$3,'2099-01-16T09:00:00+01:00','2099-01-16T09:55:00+01:00') RETURNING appointment_id",[ids.client,ids.pro,ids.service]);
  const id=Number(row.rows[0].appointment_id);
  await pool.query('INSERT INTO public.appointment_services(appointment_id,service_id,duration_min,sort_order) VALUES($1,$2,55,0)',[id,ids.service]);
  await pool.query("INSERT INTO public.appointment_calendar(appointment_id,event_id,calendar_id) VALUES($1,'0123456789abcdef','operator@example.com')",[id]);
  await enqueueCalendarJob(pool,{operation:'create',eventId:'0123456789abcdef',calendarId:'operator@example.com',payload:{appointmentId:id}});
  const calls=[];
  const result=await drainCalendarOutbox({pool,create:job=>createAndLinkCalendarBooking({pool,job,createEvent:async request=>{calls.push(request);return{id:request.eventId};}})});
  assert.equal(result.done,1);assert.equal(calls[0].durationMin,55);assert.equal(calls[0].calendarId,'operator@example.com');
  assert.equal((await pool.query("SELECT status FROM public.calendar_outbox WHERE event_id='0123456789abcdef'")).rows[0].status,'done');
});

test('simultaneous writes on two PostgreSQL connections cannot double-book one operator',async()=>{
  const first=await pool.connect(),second=await pool.connect();
  const sql="INSERT INTO public.appointments(client_id,professional_id,service_id,start_time,end_time) VALUES($1,$2,$3,'2099-01-17T09:00:00+01:00','2099-01-17T10:00:00+01:00')";
  try{
    await first.query('BEGIN');await second.query('BEGIN');
    await first.query(sql,[ids.client,ids.pro,ids.service]);
    const rejected=assert.rejects(second.query(sql,[ids.client,ids.pro,ids.service]),error=>error.code==='23P01');
    await first.query('COMMIT');await rejected;await second.query('ROLLBACK');
  }finally{
    await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();
  }
});

test('initial wizard salon name is imported once and cannot overwrite dashboard preferences',async()=>{
  await pool.query("DELETE FROM public.salon_settings WHERE setting_key='salon_name'");
  await seedInitialSalonSettings(pool,{salonName:"Salone d'esempio"});
  assert.equal((await pool.query("SELECT setting_value FROM public.salon_settings WHERE setting_key='salon_name'")).rows[0].setting_value,"Salone d'esempio");
  await pool.query("UPDATE public.salon_settings SET setting_value='Modificato dalla dashboard' WHERE setting_key='salon_name'");
  await seedInitialSalonSettings(pool,{salonName:'Modello precedente'});
  assert.equal((await pool.query("SELECT setting_value FROM public.salon_settings WHERE setting_key='salon_name'")).rows[0].setting_value,'Modificato dalla dashboard');
});
