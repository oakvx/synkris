import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectInstallation} from '../src/services/installation-doctor.js';
const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'});
const env={POSTGRES_PASSWORD:'a'.repeat(64),ADMIN_TOKEN:'b'.repeat(64),DASHBOARD_PASSWORD:'c'.repeat(32),CALENDAR_ID:'calendar@group.calendar.google.com'};
const credentials=extra=>JSON.stringify({type:'service_account',client_email:'sensitive-email-marker@synthetic-project.iam.gserviceaccount.com',private_key:rsa,token_uri:'https://oauth2.googleapis.com/token',...extra});
function fixture(action){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'synk-doctor-'));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  write('.env',Object.entries(env).map(([key,value])=>key+'='+value).join('\n'));
  write('secrets/google-service-account.json',credentials());
  write('setup/config.json',JSON.stringify({professionals:{'private-team@salone.it':{name:'sensitive-team-marker'}},services:{Trattamento:{durationMin:30,professionals:['private-team@salone.it']}},businessHours:{'1':['09:00','18:00']},closedDays:[7]}));
  try{return action({root,write,check:()=>inspectInstallation({root})});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const get=(report,id)=>report.checks.find(check=>check.id===id);
test('offline doctor completes without activation settings, keys or license files',()=>fixture(({root,check})=>{
  const before=fs.readdirSync(root).sort();const report=check();
  assert.equal(report.readyForBootstrap,true);assert.equal(report.productionReady,false);assert.equal(report.scope,'offline');
  assert.equal(get(report,'google_credentials').status,'pass');
  assert.deepEqual(fs.readdirSync(root).sort(),before);
  assert.equal(fs.existsSync(path.join(root,'secrets/license.txt')),false);
  assert.ok(report.checks.every(check=>!['license','license_key','hwid','activation_policy'].includes(check.id)));
}));
test('obsolete activation files/settings cannot block installation and are not modified',()=>fixture(({root,write})=>{
  write('secrets/license.txt','SENSITIVE_LEGACY_ACTIVATION_MARKER');
  const report=inspectInstallation({root,env:{...env,LICENSE_FILE:'/missing',LICENSE_PUBLIC_KEY_PEM:'invalid',APP_HWID:'old',HWID:'other',LICENSE_DISABLE_HWID_CHECK:'1'}});
  assert.equal(report.readyForBootstrap,true);
  assert.equal(fs.readFileSync(path.join(root,'secrets/license.txt'),'utf8'),'SENSITIVE_LEGACY_ACTIVATION_MARKER');
  assert.doesNotMatch(JSON.stringify(report),/SENSITIVE_LEGACY|HWID|license/);
}));
test('doctor output never contains file values, keys, names or emails',()=>fixture(({check})=>{
  const output=JSON.stringify(check());
  for(const value of [...Object.values(env),rsa,'sensitive-team-marker','sensitive-email-marker','private-team@salone.it'])assert.equal(output.includes(value),false);
}));
for(const [label,file,replacement,id]of[
  ['missing environment','.env',null,'environment'],
  ['missing Google credentials','secrets/google-service-account.json',null,'google_credentials'],
  ['Google malformed JSON','secrets/google-service-account.json','{bad','google_credentials'],
  ['Google wrong credential type','secrets/google-service-account.json',credentials({type:'authorized_user'}),'google_credentials'],
  ['Google malformed key','secrets/google-service-account.json',credentials({private_key:'invalid'}),'google_credentials'],
  ['Google arbitrary token endpoint','secrets/google-service-account.json',credentials({token_uri:'https://untrusted.example/token'}),'google_credentials'],
  ['missing config','setup/config.json',null,'salon_config'],
  ['invalid config','setup/config.json','{}','salon_config'],
])test('offline doctor rejects '+label,()=>fixture(({root,write,check})=>{
  if(replacement===null)fs.unlinkSync(path.join(root,file));else write(file,replacement);
  const report=check();assert.equal(report.readyForBootstrap,false);assert.equal(get(report,id).status,'fail');
}));
for(const [key,value,id]of[['ADMIN_TOKEN','short','admin_token'],['DASHBOARD_PASSWORD','short','dashboard_password'],['POSTGRES_PASSWORD','SOSTITUISCI_PASSWORD_CASUALE','postgres_password'],['CALENDAR_ID','calendario-del-salone@group.calendar.google.com','calendar_id']])test('doctor still rejects unsafe '+key,()=>fixture(({root})=>{
  const report=inspectInstallation({root,env:{...env,[key]:value}});assert.equal(report.readyForBootstrap,false);assert.equal(get(report,id).status,'fail');
}));
test('existing DB-managed configuration tolerates a stale setup template',()=>fixture(({write,check})=>{
  write('runtime/config/.synkris-bootstrap-ok','already initialized');write('setup/config.json','{}');
  assert.equal(get(check(),'salon_config').status,'pass');
}));
test('oversized credentials fail with a redacted message',()=>fixture(({write,check})=>{
  write('secrets/google-service-account.json','sensitive-marker'.repeat(10000));
  const report=check();assert.equal(get(report,'google_credentials').status,'fail');assert.doesNotMatch(JSON.stringify(report),/sensitive-marker/);
}));
test('doctor CLI supports JSON without activation and rejects incomplete Google configuration',()=>fixture(({root})=>{
  const script=fileURLToPath(new URL('../scripts/deploy/doctor.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).readyForBootstrap,true);assert.equal(result.stderr,'');
  fs.unlinkSync(path.join(root,'secrets/google-service-account.json'));
  const failed=spawnSync(process.execPath,[script,'--json'],{cwd:root,encoding:'utf8'});
  assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).readyForBootstrap,false);
}));
