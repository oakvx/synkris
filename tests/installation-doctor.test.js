import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectInstallation} from '../src/services/installation-doctor.js';
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'});
const env={POSTGRES_PASSWORD:'a'.repeat(64),ADMIN_TOKEN:'b'.repeat(64),DASHBOARD_PASSWORD:'c'.repeat(32),CALENDAR_ID:'calendar@group.calendar.google.com',APP_HWID:'HW-synthetic-installation'};
const licenseText=(extra={})=>{
  const bytes=Buffer.from(JSON.stringify({version:1,customer:'sensitive-customer-marker',plan:'private',hwid:env.APP_HWID,expiry:Date.now()+60*86400000,...extra}));
  return 'LIC='+bytes.toString('base64url')+'\nSIG='+crypto.sign(null,bytes,privateKey).toString('base64url')+'\n';
};
function fixture(action){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'synk-doctor-'));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  write('.env',Object.entries(env).map(([key,value])=>key+'='+value).join('\n'));
  write('secrets/license-public.pem',publicKey.export({format:'pem',type:'spki'}));
  write('secrets/license.txt',licenseText());
  write('secrets/google-service-account.json',JSON.stringify({type:'service_account',client_email:'sensitive-email-marker@synthetic-project.iam.gserviceaccount.com',private_key:rsa,token_uri:'https://oauth2.googleapis.com/token'}));
  write('setup/config.json',JSON.stringify({professionals:{'private-team@salone.it':{name:'sensitive-team-marker'}},services:{Trattamento:{durationMin:30,professionals:['private-team@salone.it']}},businessHours:{'1':['09:00','18:00']},closedDays:[7]}));
  try{return action({root,write,check:()=>inspectInstallation({root})});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const get=(report,id)=>report.checks.find(check=>check.id===id);
test('offline doctor verifies a signed installation without DB or external providers',()=>fixture(({root,check})=>{
  const before=fs.readdirSync(root).sort();const report=check();
  assert.equal(report.readyForBootstrap,true);assert.equal(report.productionReady,false);assert.equal(report.scope,'offline');
  assert.equal(get(report,'license').status,'pass');assert.equal(get(report,'google_credentials').status,'pass');
  assert.deepEqual(fs.readdirSync(root).sort(),before);
}));
test('doctor output never contains file values, keys, customer identity, names or emails',()=>fixture(({check})=>{
  const output=JSON.stringify(check());
  for(const value of [...Object.values(env),rsa,'sensitive-customer-marker','sensitive-team-marker','sensitive-email-marker','private-team@salone.it'])assert.equal(output.includes(value),false);
  assert.doesNotMatch(output,/LIC=|SIG=|BEGIN PUBLIC KEY/);
}));
for(const [label, file, replacement, id]of[
  ['missing environment','.env',null,'environment'],
  ['missing license','secrets/license.txt',null,'license'],
  ['tampered license','secrets/license.txt','LIC=invalid\nSIG=invalid\n','license'],
  ['wrong HWID','secrets/license.txt',()=>licenseText({hwid:'HW-other'}),'license'],
  ['expired license','secrets/license.txt',()=>licenseText({expiry:Date.now()-10*86400000,graceDays:0}),'license'],
  ['wrong public key','secrets/license-public.pem','not a key','license_key'],
  ['private key mistaken for public','secrets/license-public.pem',()=>privateKey.export({format:'pem',type:'pkcs8'}),'license_key'],
  ['Google malformed JSON','secrets/google-service-account.json','{bad','google_credentials'],
  ['Google malformed key','secrets/google-service-account.json',JSON.stringify({type:'service_account',client_email:'test@synthetic-project.iam.gserviceaccount.com',private_key:'invalid'}),'google_credentials'],
  ['Google arbitrary token endpoint','secrets/google-service-account.json',()=>JSON.stringify({type:'service_account',client_email:'test@synthetic-project.iam.gserviceaccount.com',private_key:rsa,token_uri:'https://untrusted.example/token'}),'google_credentials'],
  ['missing config','setup/config.json',null,'salon_config'],
  ['invalid config','setup/config.json','{}','salon_config'],
])test('offline doctor rejects '+label,()=>fixture(({root,write,check})=>{
  if(replacement===null)fs.unlinkSync(path.join(root,file));else write(file,typeof replacement==='function'?replacement():replacement);
  const report=check();assert.equal(report.readyForBootstrap,false);assert.equal(get(report,id).status,'fail');
}));
test('production verification cannot inherit a development HWID bypass',()=>fixture(({write,check})=>{
  const saved=process.env.LICENSE_DISABLE_HWID_CHECK;process.env.LICENSE_DISABLE_HWID_CHECK='1';
  try{write('secrets/license.txt',licenseText({hwid:'HW-other'}));assert.equal(get(check(),'license').status,'fail');}
  finally{if(saved===undefined)delete process.env.LICENSE_DISABLE_HWID_CHECK;else process.env.LICENSE_DISABLE_HWID_CHECK=saved;}
}));
test('doctor rejects bypasses or alternative inline keys in the deploy configuration',()=>fixture(({root})=>{
  for(const extra of [{LICENSE_DISABLE_HWID_CHECK:'1'},{HWID:'different'},{LICENSE_PUBLIC_KEY_PEM:'inline'}]){
    const report=inspectInstallation({root,env:{...env,...extra}});assert.equal(get(report,'activation_policy').status,'fail');assert.equal(report.readyForBootstrap,false);
  }
}));
test('doctor flags license grace rather than pretending renewal is complete',()=>fixture(({write,check})=>{
  write('secrets/license.txt',licenseText({expiry:Date.now()-86400000,graceDays:7}));
  assert.equal(get(check(),'license').status,'warn');
}));
test('existing DB-managed configuration is not rejected because the setup template became stale',()=>fixture(({write,check})=>{
  write('runtime/config/.synkris-bootstrap-ok','already initialized');write('setup/config.json','{}');
  assert.equal(get(check(),'salon_config').status,'pass');
}));
test('oversized credentials fail with a redacted message',()=>fixture(({write,check})=>{
  write('secrets/google-service-account.json','sensitive-marker'.repeat(10000));
  const report=check();assert.equal(get(report,'google_credentials').status,'fail');assert.doesNotMatch(JSON.stringify(report),/sensitive-marker/);
}));
test('doctor CLI supports JSON and uses nonzero status for incomplete installations',()=>fixture(({root})=>{
  const script=fileURLToPath(new URL('../scripts/deploy/doctor.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).readyForBootstrap,true);assert.equal(result.stderr,'');
  fs.unlinkSync(path.join(root,'secrets/license.txt'));
  const failed=spawnSync(process.execPath,[script,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).readyForBootstrap,false);
}));
