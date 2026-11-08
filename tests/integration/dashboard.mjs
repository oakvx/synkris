import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {testPool,resetDatabase,seed} from './helpers.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const pool=testPool();let ids,folder,php,gate,base;
const calls=[];let gateStatus=200;let cookie='',csrf='';
const adminToken=crypto.randomBytes(32).toString('hex');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function updateCookie(response){for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0];if(pair.startsWith('synk_session='))cookie=pair;}}
async function request(route,{method='GET',body,headers={}}={}){
  const response=await fetch(base+'/?route='+encodeURIComponent(route),{method,redirect:'manual',headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={raw:text};}return{status:response.status,data,headers:response.headers};
}
async function currentAppointment(){const response=await request('db_appointments',{headers:{}});return response.data.appointments.find(a=>a.client_id==ids.client);}
async function doneJobs(){await pool.query("UPDATE public.calendar_outbox SET status='done',finished_at=now() WHERE status='pending'");}
before(async()=>{
  await resetDatabase(pool);ids=await seed(pool);
  folder=fs.mkdtempSync(path.join(os.tmpdir(),'synk-http-'));fs.mkdirSync(path.join(folder,'sessions'));fs.mkdirSync(path.join(folder,'config'));
  gate=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    calls.push({path:req.url,token:req.headers['x-admin-token'],body:chunks.length?JSON.parse(Buffer.concat(chunks)):null});
    res.setHeader('Content-Type','application/json');
    if(req.headers['x-admin-token']!==adminToken){res.writeHead(401);res.end('{}');return;}
    if(req.url==='/api/calendar/check-slot'){res.writeHead(gateStatus);res.end(JSON.stringify(gateStatus===200?{available:true}:{error:'synthetic_provider_failure'}));return;}
    if(req.url==='/api/onboarding'){res.end('{"schema":1,"productionReady":false}');return;}
    if(req.url==='/status'){res.end('{"online":true}');return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>gate.listen(0,'127.0.0.1',resolve));
  const port=await freePort();base='http://127.0.0.1:'+port;
  php=spawn(process.env.PHP_BINARY||'php',['-d','session.save_path='+path.join(folder,'sessions'),'-S','127.0.0.1:'+port,'-t',root,path.join(root,'tests/integration/php-router.php')],{cwd:root,env:{...process.env,TMPDIR:folder,DATABASE_URL:process.env.TEST_DATABASE_URL,DASHBOARD_PASSWORD:'synthetic-test-password-only',ADMIN_TOKEN:adminToken,BOT_API_INTERNAL:'http://127.0.0.1:'+gate.address().port,APP_DATA_DIR:path.join(folder,'config'),TZ:'Europe/Rome'},stdio:['ignore','ignore','pipe']});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Native PHP test server did not start.')),15000);
    php.once('error',error=>{clearTimeout(timeout);reject(error);});
    php.once('exit',code=>{clearTimeout(timeout);reject(new Error('Native PHP exited: '+code));});
    php.stderr.on('data',chunk=>{if(String(chunk).includes('Development Server')){clearTimeout(timeout);resolve();}});
  });
});
after(async()=>{
  if(php&&php.exitCode===null){php.kill();await new Promise(resolve=>php.once('exit',resolve));}
  if(gate?.listening)await new Promise(resolve=>gate.close(resolve));
  await pool.end();if(folder)fs.rmSync(folder,{recursive:true,force:true});
});
test('unauthenticated APIs and CSRF-less login are rejected',async()=>{
  assert.equal((await request('db_catalog')).status,401);
  const response=await fetch(base+'/',{method:'POST',body:new URLSearchParams({password:'synthetic-test-password-only'})});
  assert.equal(response.status,403);
  assert.equal((await fetch(base+'/bridge.php?path=%2Fstatus')).status,401);
});
test('login rotates the session and renders a token without exposing internal credentials',async()=>{
  const login=await fetch(base+'/');updateCookie(login);const oldCookie=cookie;
  const html=await login.text();csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const response=await fetch(base+'/',{method:'POST',redirect:'manual',headers:{Cookie:cookie},body:new URLSearchParams({password:'synthetic-test-password-only',csrf})});
  assert.equal(response.status,303);updateCookie(response);assert.notEqual(cookie,oldCookie);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/i);assert.match(response.headers.get('set-cookie'),/SameSite=Strict/i);
  const page=await fetch(base+'/',{headers:{Cookie:cookie}});const content=await page.text();
  assert.equal(page.status,200);csrf=content.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  assert.equal(content.includes(adminToken),false);assert.match(page.headers.get('content-security-policy'),/object-src 'none'/);
});
test('write methods, CSRF, origin and proxy destinations are enforced',async()=>{
  assert.equal((await request('db_client_create')).status,405);
  assert.equal((await request('db_client_create',{method:'POST',body:{name:'Blocked'},headers:{'X-CSRF-Token':'bad'}})).status,403);
  assert.equal((await request('db_client_create',{method:'POST',body:{name:'Blocked'},headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await request('unknown')).status,404);
  const response=await fetch(base+'/bridge.php?path='+encodeURIComponent('//attacker.invalid/status'),{headers:{Cookie:cookie}});assert.equal(response.status,400);
  const status=await fetch(base+'/bridge.php?path=%2Fstatus',{headers:{Cookie:cookie}});assert.equal(status.status,200);assert.equal(calls.at(-1).token,adminToken);
});
test('clients without past appointments are listed and duplicate contacts rollback atomically',async()=>{
  const result=await request('db_clients');assert.equal(result.data.clients.length,1);
  assert.equal((await request('db_client_create',{method:'POST',body:{name:'New synthetic client',phone:'390000111222'}})).status,201);
  assert.equal((await request('db_client_create',{method:'POST',body:{name:'Duplicate synthetic',phone:'390000111222'}})).status,409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.clients')).rows[0].n,2);
});
test('external Calendar failure/conflict cannot commit an appointment or outbox job',async()=>{
  const body={clientId:ids.client,professionalId:ids.pro,serviceIds:[ids.service],startTime:'2099-01-15T09:30'};
  for(const status of [503,409]){gateStatus=status;assert.equal((await request('db_appointment_save',{method:'POST',body})).status,status);}
  gateStatus=200;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.appointments')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.calendar_outbox')).rows[0].n,0);
});
test('canonical save normalizes Rome time and durational buffer in a real PostgreSQL transaction',async()=>{
  const result=await request('db_appointment_save',{method:'POST',body:{clientId:ids.client,professionalId:ids.pro,serviceIds:[ids.service],startTime:'2099-01-15T09:30'}});
  assert.equal(result.status,201,JSON.stringify(result.data));assert.equal(result.data.calendarStatus,'pending');
  const row=(await pool.query('SELECT start_time,end_time FROM public.appointments')).rows[0];
  assert.equal(row.start_time.toISOString(),'2099-01-15T08:30:00.000Z');assert.equal((row.end_time-row.start_time)/60000,55);
  const job=(await pool.query('SELECT payload,calendar_id FROM public.calendar_outbox')).rows[0];
  assert.deepEqual(Object.keys(job.payload),['appointmentId']);assert.equal(job.calendar_id,'operator@example.com');
  const appt=await currentAppointment();assert.equal(appt.calendar_status,'pending');
  assert.equal((await request('db_appointment_cancel',{method:'POST',body:{id:Number(appt.appointment_id),updatedAt:appt.updated_at}})).status,409);
});
test('optimistic edits reject stale versions and enqueue reschedule/summary after sync',async()=>{
  await doneJobs();const old=await currentAppointment();
  await pool.query('UPDATE public.appointments SET updated_at=clock_timestamp() WHERE appointment_id=$1',[old.appointment_id]);
  const body={id:Number(old.appointment_id),updatedAt:old.updated_at,clientId:ids.client,professionalId:ids.pro,serviceIds:[ids.service],startTime:'2099-01-15T11:00'};
  assert.equal((await request('db_appointment_save',{method:'POST',body})).status,409);
  body.updatedAt=(await currentAppointment()).updated_at;
  const result=await request('db_appointment_save',{method:'POST',body});assert.equal(result.status,200,JSON.stringify(result.data));
  const jobs=(await pool.query("SELECT operation FROM public.calendar_outbox WHERE status='pending' ORDER BY job_id")).rows.map(r=>r.operation);assert.deepEqual(jobs,['reschedule','update']);
});
test('cancellation queues a remote cancel and cannot be reactivated via status changes',async()=>{
  await doneJobs();let row=await currentAppointment();
  const result=await request('db_appointment_cancel',{method:'POST',body:{id:Number(row.appointment_id),updatedAt:row.updated_at,status:'cancelled'}});assert.equal(result.status,200,JSON.stringify(result.data));
  row=await currentAppointment();assert.equal(row.status,'cancelled');
  assert.equal((await request('db_appointment_cancel',{method:'POST',body:{id:Number(row.appointment_id),updatedAt:row.updated_at,status:'confirmed'}})).status,409);
});
test('persistent restore-maintenance flag blocks booking writes before any commit',async()=>{
  const flag=path.join(folder,'config/calendar-reconciliation-required.flag');fs.writeFileSync(flag,'synthetic maintenance');
  try{const result=await request('db_appointment_save',{method:'POST',body:{clientId:ids.client,professionalId:ids.pro,serviceIds:[ids.service],startTime:'2099-01-16T10:00'}});assert.equal(result.status,503);assert.equal(result.data.error,'calendar_reconciliation_required');}
  finally{fs.unlinkSync(flag);}
});
test('legacy activation files are ignored without affecting authenticated database access',async()=>{
  const legacy=path.join(folder,'license.txt');fs.writeFileSync(legacy,'obsolete-invalid-activation-file');
  assert.equal((await request('db_catalog')).status,200);
  assert.equal(fs.readFileSync(legacy,'utf8'),'obsolete-invalid-activation-file');
});

test('first-run checklist proxy keeps login, token, origin and read-only method boundaries',async()=>{
  const url=base+'/bridge.php?path='+encodeURIComponent('/api/onboarding');
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{Cookie:cookie}});assert.equal(response.status,200);
  assert.equal((await response.json()).productionReady,false);assert.equal(calls.at(-1).token,adminToken);
  assert.equal((await fetch(url,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'})).status,405);
  assert.equal((await fetch(url,{headers:{Cookie:cookie,Origin:'https://attacker.invalid'}})).status,403);
});
