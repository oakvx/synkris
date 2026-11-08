import test from 'node:test';
import assert from 'node:assert/strict';
import {filterRuntimeDiagnostics,collectRuntimeSummary} from '../src/services/support-summary.js';
const env={ADMIN_TOKEN:'synthetic-runtime-support-token-only'};
test('support summary copies only enumerated states and real booleans, never arbitrary diagnostics',()=>{
  const summary=filterRuntimeDiagnostics({whatsappReady:true,databaseReady:'SENSITIVE_MARKER',licenseStatus:'valid',lastInboundSyncStatus:'error',calendarMaintenance:false,aiConfigured:false,
    messages:{chatId:'SENSITIVE_MARKER'},lastError:'SENSITIVE_MARKER',token:'SENSITIVE_MARKER',metrics:{SENSITIVE_MARKER:1}});
  assert.equal(summary.whatsappReady,true);assert.equal(summary.databaseReady,null);assert.equal(summary.licenseStatus,'valid');
  assert.doesNotMatch(JSON.stringify(summary),/SENSITIVE_MARKER|messages|lastError|metrics|token/);
});
test('unexpected strings cannot masquerade as a checked status',()=>{
  const summary=filterRuntimeDiagnostics({licenseStatus:'SENSITIVE_LICENSE_PAYLOAD',lastInboundSyncStatus:'SENSITIVE_PROVIDER_ERROR'});
  assert.equal(summary.licenseStatus,'unknown');assert.equal(summary.calendarStatus,'unknown');
});
test('null or array diagnostics remain unknown',()=>{
  for(const data of [null,[],undefined])assert.equal(filterRuntimeDiagnostics(data).whatsappReady,null);
});
test('runtime collection uses only container loopback with auth headers, bounded body and no redirects',async()=>{
  let request;const result=await collectRuntimeSummary({env,fetchImpl:async(url,options)=>{
    request={url,options};return new Response(JSON.stringify({databaseReady:true,whatsappReady:false,private:'SENSITIVE_MARKER'}));
  }});
  assert.equal(request.url,'http://127.0.0.1:3000/diagnostics');assert.equal(request.options.headers['X-Admin-Token'],env.ADMIN_TOKEN);
  assert.equal(request.options.redirect,'error');assert.equal(result.databaseReady,true);assert.doesNotMatch(JSON.stringify(result),/SENSITIVE_MARKER|synthetic-runtime/);
});
for(const response of [()=>new Response('x'.repeat(32769)),()=>new Response('bad-json-SENSITIVE_MARKER'),()=>new Response('{}',{status:403})])test('bad runtime replies fail with a redacted error',async()=>{
  await assert.rejects(collectRuntimeSummary({env,fetchImpl:async()=>response()}),{message:'runtime_unavailable'});
});
test('missing token or invalid port never sends an HTTP request',async()=>{
  let called=false;for(const bad of [{},{...env,ADMIN_PORT:'99999'}])await assert.rejects(collectRuntimeSummary({env:bad,fetchImpl:async()=>{called=true;}}),/runtime_unavailable/);
  assert.equal(called,false);
});
