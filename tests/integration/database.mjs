import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {testPool,resetDatabase,seed} from './helpers.mjs';
import {enqueueCalendarJob,drainCalendarOutbox} from '../../src/services/calendar-outbox.js';
import {readOnboardingStatus} from '../../src/services/onboarding-status.js';
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

test('onboarding aggregates use the real PostgreSQL schema without exposing client records',async()=>{
  const state={dbPool:pool,dbOnline:true,online:false};
  const report=await readOnboardingStatus({state,backupDirectory:'/nonexistent/synk-test-backups'});
  assert.equal(report.steps.find(step=>step.id==='catalog').status,'done');
  assert.equal(report.productionReady,false);assert.equal(report.steps.length,5);
  assert.equal(JSON.stringify(report).includes('Synthetic client'),false);
});

// The module's testPool/resetDatabase guards already require an explicitly
// disposable synk_test DB; no salon database or provider account is involved.
test('real bootstrap imports once without activation files and ignores obsolete settings on restart',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'synk-bootstrap-no-activation-'));
  const marker=path.join(folder,'.synkris-bootstrap-ok');
  try {
    const email='bootstrap@synthetic-salon.test';
    fs.writeFileSync(path.join(folder,'config.json'),JSON.stringify({salonName:'Synthetic bootstrap',professionals:{[email]:{name:'Synthetic bootstrap team'}},services:{'Synthetic bootstrap treatment':{durationMin:30,professionals:[email]}},businessHours:{'1':['09:00','18:00']},closedDays:[7]}));
    const google=path.join(folder,'google.json');
    const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
    fs.writeFileSync(google,JSON.stringify({type:'service_account',client_email:'synthetic@ci.iam.gserviceaccount.com',private_key:key}));
    const env={...process.env,NODE_ENV:'production',DATABASE_URL:process.env.TEST_DATABASE_URL,APP_DATA_DIR:folder,GOOGLE_APPLICATION_CREDENTIALS:google,CALENDAR_ID:'synthetic@group.calendar.google.com',ADMIN_TOKEN:crypto.randomBytes(32).toString('hex')};
    for(const name of Object.keys(env))if(name.startsWith('LICENSE_')||name==='HWID'||name==='APP_HWID')delete env[name];
    const run=()=>spawnSync(process.execPath,['scripts/deploy/bootstrap.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env,encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
    const first=run();assert.equal(first.status,0,first.stderr);
    assert.ok(fs.existsSync(marker),'Bootstrap did not publish its successful import marker');
    assert.equal(fs.existsSync(path.join(folder,'licenses')),false);
    const imported=await pool.query("SELECT count(*)::int AS n FROM public.services WHERE service_name='Synthetic bootstrap treatment'");
    assert.equal(imported.rows[0].n,1);
    const before=fs.readFileSync(marker,'utf8');
    // A stale template and deliberately invalid legacy license configuration
    // must not reimport the catalog or restore the removed activation gate.
    fs.writeFileSync(path.join(folder,'config.json'),'{}');
    Object.assign(env,{LICENSE_FILE:path.join(folder,'missing-license.txt'),LICENSE_PUBLIC_KEY_FILE:path.join(folder,'missing-key.pem'),APP_HWID:'obsolete'});
    const second=run();assert.equal(second.status,0,second.stderr);
    assert.equal(fs.readFileSync(marker,'utf8'),before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.services WHERE service_name='Synthetic bootstrap treatment'")).rows[0].n,1);
    assert.equal((await pool.query("SELECT setting_value FROM public.salon_settings WHERE setting_key='salon_name'")).rows[0].setting_value,'Modificato dalla dashboard');
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
