import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeEnvironment,validateBootstrapEnvironment} from '../src/services/runtime-environment.js';
const env={DATABASE_URL:'postgresql://synthetic',CALENDAR_ID:'synthetic@group.calendar.google.com',ADMIN_TOKEN:'a'.repeat(64),GOOGLE_APPLICATION_CREDENTIALS:'/synthetic/google.json'};
const exists=file=>file==='/synthetic/google.json';
test('production startup and bootstrap require no activation settings or signed files',()=>{
  assert.doesNotThrow(()=>validateRuntimeEnvironment({env:{...env,NODE_ENV:'production'},exists}));
  assert.doesNotThrow(()=>validateBootstrapEnvironment({env:{...env,NODE_ENV:'production'},exists}));
});
test('obsolete activation settings are ignored, including bad files and invalid monitor intervals',()=>{
  const legacy={...env,APP_HWID:'obsolete',HWID:'different',LICENSE_FILE:'/missing',LICENSE_PUBLIC_KEY_FILE:'/missing',LICENSE_PUBLIC_KEY_PEM:'invalid',LICENSE_TEXT:'invalid',LICENSE_CODE:'invalid',LICENSE_CHECK_INTERVAL_MINUTES:'not-a-number',LICENSE_DISABLE_HWID_CHECK:'1'};
  assert.doesNotThrow(()=>validateRuntimeEnvironment({env:legacy,exists}));
  assert.doesNotThrow(()=>validateBootstrapEnvironment({env:legacy,exists}));
});
for(const key of ['DATABASE_URL','CALENDAR_ID','ADMIN_TOKEN'])test('startup still rejects missing '+key,()=>{
  for(const validate of [validateRuntimeEnvironment,validateBootstrapEnvironment])assert.throws(()=>validate({env:{...env,[key]:''},exists}),/Configurazione mancante/);
});
test('administrator token remains mandatory and at least 32 characters',()=>{
  for(const validate of [validateRuntimeEnvironment,validateBootstrapEnvironment])assert.throws(()=>validate({env:{...env,ADMIN_TOKEN:'short'},exists}),/ADMIN_TOKEN/);
});
test('Google credentials remain required without license gates',()=>{
  assert.throws(()=>validateRuntimeEnvironment({env:{...env,GOOGLE_APPLICATION_CREDENTIALS:''},exists:()=>false}),/Google/);
  assert.throws(()=>validateBootstrapEnvironment({env,exists:()=>false}),/Google/);
});
test('standalone runtime retains existing inline and private-directory Google credential support',()=>{
  for(const source of ['GOOGLE_CREDENTIALS_JSON','GOOGLE_CREDENTIALS_B64'])assert.doesNotThrow(()=>validateRuntimeEnvironment({env:{...env,GOOGLE_APPLICATION_CREDENTIALS:'',[source]:'synthetic'},exists:()=>false}));
  let requested;
  validateRuntimeEnvironment({env:{...env,GOOGLE_APPLICATION_CREDENTIALS:'',APP_DATA_DIR:'/synthetic/private'},exists:file=>{requested=file;return true;}});
  assert.match(requested.replaceAll('\\','/'),/synthetic\/private\/google-credentials.json$/);
});
