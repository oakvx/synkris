import test from 'node:test';
import assert from 'node:assert/strict';
import {seedInitialSalonSettings} from '../src/services/initial-salon-settings.js';
import {validateSalonConfig} from '../src/services/setup-validation.js';
test('initial salon name is parameterized and does not overwrite existing preferences',async()=>{
  const calls=[];await seedInitialSalonSettings({query:async(...args)=>calls.push(args)},{salonName:"  Salone d'esempio  "});
  assert.match(calls[0][0],/ON CONFLICT\(setting_key\) DO NOTHING/);
  assert.deepEqual(calls[0][1],['salon_name',"Salone d'esempio"]);
  assert.equal(calls[0][0].includes("d'esempio"),false);
});
test('legacy configuration without salon name does not write preferences',async()=>{
  let called=false;await seedInitialSalonSettings({query:async()=>{called=true;}},{});assert.equal(called,false);
});
test('setup and dashboard enforce the same salon name size',async()=>{
  await assert.rejects(seedInitialSalonSettings({query:async()=>{}},{salonName:'a'.repeat(81)}),/Invalid salon setting/);
  assert.ok(validateSalonConfig({salonName:'a'.repeat(81)}).some(issue=>issue.field==='salonName'));
});
