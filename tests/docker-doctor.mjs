// Real Docker/Compose boundary test with dynamically generated synthetic keys.
// No real account, customer, browser, DB, network or license issuer is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'synk-doctor-container-'));
const project='synk-doctor-ci-'+crypto.randomBytes(5).toString('hex');
const image=project+'-runtime:local';
const run=(args)=>spawnSync('docker',args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
const compose=(args)=>run(['compose','--profile','tools',...args]);
const write=(name,contents)=>{const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,contents,{mode:0o644});};
try {
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const body=Buffer.from(JSON.stringify({version:1,customer:'Synthetic CI only',plan:'test',hwid:'HW-DOCTOR-CI',expiry:Date.now()+90*86400000}));
  const license='LIC='+body.toString('base64url')+'\nSIG='+crypto.sign(null,body,privateKey).toString('base64url')+'\n';
  write('compose.yaml',fs.readFileSync(new URL('../compose.yaml',import.meta.url)));
  write('.env','COMPOSE_PROJECT_NAME='+project+'\nPOSTGRES_PASSWORD='+crypto.randomBytes(32).toString('hex')+'\nADMIN_TOKEN='+crypto.randomBytes(32).toString('hex')+'\nDASHBOARD_PASSWORD='+crypto.randomBytes(16).toString('hex')+'\nCALENDAR_ID=synthetic@group.calendar.google.com\nAPP_HWID=HW-DOCTOR-CI\n');
  write('secrets/license.txt',license);write('secrets/license-public.pem',publicKey.export({type:'spki',format:'pem'}));
  write('secrets/google-service-account.json',JSON.stringify({type:'service_account',client_email:'synthetic@ci-only.iam.gserviceaccount.com',private_key:rsa,token_uri:'https://oauth2.googleapis.com/token'}));
  write('setup/config.json',JSON.stringify({professionals:{'team@synthetic-salon.test':{name:'Synthetic team'}},services:{Synthetic:{durationMin:30,professionals:['team@synthetic-salon.test']}},businessHours:{'1':['09:00','18:00']},closedDays:[7]}));
  fs.mkdirSync(path.join(root,'runtime/config'),{recursive:true});
  assert.equal(run(['tag','synk-ci-bot',image]).status,0,'Synthetic runtime image alias failed');
  const configResult=compose(['config','--format','json']);assert.equal(configResult.status,0,'Compose configuration invalid');
  const doctor=JSON.parse(configResult.stdout).services.doctor;
  assert.equal(doctor.network_mode,'none');assert.equal(doctor.read_only,true);assert.equal(doctor.pull_policy,'never');
  assert.equal(doctor.build,undefined);assert.ok(doctor.volumes.every(volume=>volume.read_only===true));
  const execute=()=>compose(['run','--rm','--no-deps','-T','--pull','never','doctor']);
  const result=execute();assert.equal(result.status,0,'Isolated doctor failed: '+result.stdout);
  const report=JSON.parse(result.stdout);assert.equal(report.readyForBootstrap,true);assert.equal(report.productionReady,false);
  assert.equal(report.checks.find(check=>check.id==='license').status,'pass');
  assert.equal(fs.existsSync(path.join(root,'runtime/config/.synkris-bootstrap-ok')),false,'Doctor ran an importer');
  assert.equal(compose(['ps','--all','--services']).stdout.trim(),'','Doctor started dependency containers');
  const volumes=run(['volume','ls','--filter','label=com.docker.compose.project='+project,'--format','{{.Name}}']);
  assert.equal(volumes.stdout.trim(),'','Doctor created database/model volumes');
  write('secrets/license.txt','LIC=bad\nSIG=bad\n');
  const invalid=execute();assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).readyForBootstrap,false);
  console.log('PASS: actual isolated Compose doctor; no dependencies, network, import marker or data volumes; invalid signature fails closed.');
} catch(error) {
  const text=String(error.message).slice(0,12000);
  console.error('::error title=Isolated doctor smoke test failed::'+text.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
  process.exitCode=1;
} finally {
  compose(['down','--remove-orphans','--timeout','5']);run(['image','rm',image]);
  fs.rmSync(root,{recursive:true,force:true});
}
