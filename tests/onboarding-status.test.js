import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOnboardingStatus,readOnboardingStatus} from '../src/services/onboarding-status.js';
import {createAdminApp} from '../src/services/admin-server.js';
const now=Date.now();
const catalog={services:'1',professionals:'1',assignments:'1',opening_days:'5',unassigned_services:'0'};
const state={dbOnline:true,online:true,lastInboundSyncStatus:'ok',lastInboundSyncAt:new Date(now-1000).toISOString()};
const complete=()=>({state:{...state},catalog:{...catalog},backup:{status:'recent'},now});
const step=(report,id)=>report.steps.find(item=>item.id===id);
test('all measured checks can complete but never certify production or real-provider acceptance',()=>{
  const report=buildOnboardingStatus(complete());
  assert.equal(report.completed,5);assert.equal(report.automaticChecksComplete,true);assert.equal(report.productionReady,false);
  assert.equal(report.nextStep,null);assert.match(step(report,'backup').help,/Non prova/);
  assert.match(step(report,'calendar').help,/collaudo/);
});
test('missing database state is unknown, not a successful check',()=>{
  const report=buildOnboardingStatus();assert.equal(step(report,'database').status,'unknown');assert.equal(report.automaticChecksComplete,false);
});
test('checklist has five operational checks and no activation requirement',()=>{
  const data=complete();data.state.licenseStatus='invalid';
  const report=buildOnboardingStatus(data);
  assert.deepEqual(report.steps.map(step=>step.id),['database','catalog','whatsapp','calendar','backup']);
  assert.equal(report.total,5);assert.equal(report.completed,5);
  assert.doesNotMatch(JSON.stringify(report),/licenseStatus|HWID|Attivazione/);
});
for(const change of [{services:0},{professionals:0},{assignments:0},{opening_days:0},{unassigned_services:1},{assignments:undefined}])test('incomplete catalog cannot pass '+JSON.stringify(change),()=>{
  const data=complete();Object.assign(data.catalog,change);assert.notEqual(step(buildOnboardingStatus(data),'catalog').status,'done');
});
for(const time of [null,'bad-date',new Date(now+60000).toISOString(),new Date(now-7*60000).toISOString()])test('Calendar needs a fresh nonfuture successful sync: '+time,()=>{
  const data=complete();data.state.lastInboundSyncAt=time;assert.equal(step(buildOnboardingStatus(data),'calendar').status,'todo');
});
test('persistent Calendar reconciliation takes precedence over a successful sync',()=>{
  const data=complete();data.calendarPaused=true;
  assert.equal(step(buildOnboardingStatus(data),'calendar').status,'attention');
});
test('readiness lookup uses bounded read-only aggregate SQL and hides DB exceptions',async()=>{
  let query;const data={...state,dbPool:{query:async value=>{query=value;return {rows:[catalog]};}}};
  const report=await readOnboardingStatus({state:data,backupDirectory:'/nonexistent/synk-test-backup',now});
  assert.equal(query.query_timeout,3000);assert.match(query.text,/SELECT count\(\*\)/);assert.doesNotMatch(query.text,/UPDATE|INSERT|DELETE|client_contacts|chat_messages/);
  assert.equal(step(report,'catalog').status,'done');
  data.dbPool.query=async()=>{throw Error('SENSITIVE_DATABASE_EXCEPTION_MARKER');};
  const failed=await readOnboardingStatus({state:data,now});
  assert.equal(step(failed,'catalog').status,'unknown');assert.doesNotMatch(JSON.stringify(failed),/SENSITIVE_DATABASE_EXCEPTION_MARKER/);
});
test('onboarding endpoint remains token protected, no-store, origin guarded and contains no QR or customer data',async t=>{
  const token='synthetic-onboarding-admin-token-only';
  const server=createAdminApp({...state,qrDataUrl:'SENSITIVE_QR_MARKER',dbPool:{query:async()=>({rows:[catalog]})}},{},{token}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url='http://127.0.0.1:'+server.address().port+'/api/onboarding';
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{'X-Admin-Token':token,Origin:'https://untrusted.example'}})).status,403);
  const response=await fetch(url,{headers:{'X-Admin-Token':token}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const text=await response.text();assert.doesNotMatch(text,/SENSITIVE_QR_MARKER|SELECT|BEGIN PUBLIC KEY/);
  assert.equal(JSON.parse(text).steps.length,5);
});
