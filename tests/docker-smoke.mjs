import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const name='synk-smoke-'+crypto.randomBytes(5).toString('hex');
let container;
try{
  container=docker('run','-d','--name',name,'-p','127.0.0.1::80','-e','DASHBOARD_PASSWORD=synthetic-smoke-password','synk-ci-dashboard');
  const binding=JSON.parse(docker('inspect',container))[0].NetworkSettings.Ports['80/tcp'][0];
  const base='http://127.0.0.1:'+binding.HostPort;
  let login;
  for(let attempt=0;attempt<40;attempt++){
    try{login=await fetch(base+'/');if(login.status===200)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(login?.status,200,'Apache/login did not become ready');
  const html=await login.text();assert.match(html,/Benvenuta in synk/);
  const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  for(const path of ['/.env','/package.json','/deploy/session.php','/dashboard/api/router.php','/dashboard/view.html','/setup/config.json']){
    const response=await fetch(base+path,{redirect:'manual'});assert.ok([403,404].includes(response.status),'Public private path: '+path);
  }
  assert.equal((await fetch(base+'/dashboard/assets/app.css')).status,200);
  assert.equal((await fetch(base+'/assets/logo.svg')).status,200);
  assert.equal((await fetch(base+'/?route=db_catalog')).status,401);
  assert.equal((await fetch(base+'/bridge.php?path=%2Fstatus')).status,401);
  assert.equal((await fetch(base+'/',{method:'POST',headers:{Cookie:cookie},body:new URLSearchParams({password:'synthetic-smoke-password'})})).status,403);
  const auth=await fetch(base+'/',{method:'POST',redirect:'manual',headers:{Cookie:cookie},body:new URLSearchParams({password:'synthetic-smoke-password',csrf})});
  assert.equal(auth.status,303);
  const session=auth.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await fetch(base+'/',{headers:{Cookie:session}})).status,403,'Missing production license must fail closed');
  console.log('PASS: Docker Apache/auth/private-file boundary smoke checks. No real provider was contacted.');
}finally{
  if(container)docker('rm','-f',container);
}
