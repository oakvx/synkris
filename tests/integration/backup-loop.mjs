import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../../deploy/backup-loop.sh',import.meta.url));
function fixture(action){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'synk-backup-loop-'));const bin=path.join(root,'bin');const folder=path.join(root,'backups');
  fs.mkdirSync(bin);fs.mkdirSync(folder);
  const executable=(name,source)=>fs.writeFileSync(path.join(bin,name),'#!/bin/sh\n'+source+'\n',{mode:0o755});
  executable('chgrp','exit 0');
  executable('date',"printf '20261108-120000\\n'");
  executable('pg_dump',`for arg do case "$arg" in --file=*) file=\${arg#--file=} ;; esac; done
printf 'PGDMPsynthetic-backup-only-no-real-database' > "$file"
[ "\${TEST_DUMP_FAIL:-0}" != 1 ]`);
  executable('pg_restore','[ "${TEST_VERIFY_FAIL:-0}" != 1 ]');
  const run=(extra={})=>spawnSync('sh',[script],{encoding:'utf8',timeout:5000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,SYNK_BACKUP_DIR:folder,SYNK_BACKUP_ONCE:'1',...extra}});
  try{return action({root,folder,run});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('backup shell has valid POSIX syntax',()=>assert.equal(spawnSync('sh',['-n',script]).status,0));
test('successful dump is published with a matching checksum and no partial files',()=>fixture(({folder,run})=>{
  const result=run();assert.equal(result.status,0,result.stderr);
  const names=fs.readdirSync(folder).sort();assert.deepEqual(names,['synk-20261108-120000.dump','synk-20261108-120000.dump.sha256']);
  const bytes=fs.readFileSync(path.join(folder,names[0]));const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(fs.readFileSync(path.join(folder,names[1]),'utf8'),digest+'  '+names[0]+'\n');
}));
for(const flag of ['TEST_DUMP_FAIL','TEST_VERIFY_FAIL'])test('failed backup never publishes a partial file: '+flag,()=>fixture(({folder,run})=>{
  const old=path.join(folder,'synk-20261107-120000.dump');fs.writeFileSync(old,'old backup must survive');
  const result=run({[flag]:'1'});assert.equal(result.status,1);assert.deepEqual(fs.readdirSync(folder),[path.basename(old)]);
  assert.equal(fs.readFileSync(old,'utf8'),'old backup must survive');
}));
test('existing dump collision cannot overwrite an earlier backup',()=>fixture(({folder,run})=>{
  const file=path.join(folder,'synk-20261108-120000.dump');fs.writeFileSync(file,'existing');
  assert.equal(run().status,1);assert.equal(fs.readFileSync(file,'utf8'),'existing');
}));
test('retention removes old matching dumps and checksums but not unrelated files',()=>fixture(({folder,run})=>{
  const old=path.join(folder,'synk-20261001-120000.dump');const sidecar=old+'.sha256';const unrelated=path.join(folder,'keep-me.dump');
  for(const file of [old,sidecar,unrelated]){fs.writeFileSync(file,'synthetic');fs.utimesSync(file,new Date(Date.now()-16*86400000),new Date(Date.now()-16*86400000));}
  assert.equal(run().status,0);assert.equal(fs.existsSync(old),false);assert.equal(fs.existsSync(sidecar),false);assert.equal(fs.existsSync(unrelated),true);
}));
test('invalid cadence fails closed without running backup tools',()=>fixture(({folder,run})=>{
  assert.equal(run({SYNK_BACKUP_INTERVAL_SECONDS:'0'}).status,64);assert.deepEqual(fs.readdirSync(folder),[]);
}));
