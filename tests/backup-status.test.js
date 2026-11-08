import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readBackupStatus} from '../src/services/backup-status.js';
function fixture(action){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'synk-backup-state-'));try{return action(directory);}finally{fs.rmSync(directory,{recursive:true,force:true});}}
const name='synk-20261108-120000.dump';
const now=Date.now();
function dump(directory,age=1000,bytes='PGDMPsynthetic-backup-header-only'){
  const file=path.join(directory,name);fs.writeFileSync(file,bytes);fs.utimesSync(file,new Date(now-age),new Date(now-age));return file;
}
test('empty backup folders are missing, never declared healthy',()=>fixture(directory=>assert.equal(readBackupStatus({directory,now}).status,'missing')));
test('recent metadata is not an integrity or restore certification',()=>fixture(directory=>{
  dump(directory);const report=readBackupStatus({directory,now});assert.equal(report.status,'recent');assert.equal(report.integrityVerified,false);assert.equal(report.restoreVerified,false);
  assert.equal(JSON.stringify(report).includes(directory),false);
}));
test('backups older than 36 hours are stale',()=>fixture(directory=>{dump(directory,37*3600000);assert.equal(readBackupStatus({directory,now}).status,'stale');}));
test('future backup timestamps do not produce a green status',()=>fixture(directory=>{dump(directory,-60000);assert.equal(readBackupStatus({directory,now}).status,'invalid');}));
for(const value of ['','not-a-database-archive-at-all'])test('malformed or empty final dump is invalid: '+value.length,()=>fixture(directory=>{dump(directory,1000,value);assert.equal(readBackupStatus({directory,now}).status,'invalid');}));
test('partial files and lookalike filenames cannot satisfy backup readiness',()=>fixture(directory=>{
  fs.writeFileSync(path.join(directory,name+'.partial'),'PGDMPsynthetic-staging');fs.writeFileSync(path.join(directory,'unrelated.dump'),'PGDMPsynthetic');
  assert.equal(readBackupStatus({directory,now}).status,'missing');
}));
test('an invalid newest final dump does not silently fall back to an older valid one',()=>fixture(directory=>{
  dump(directory,3000);const latest=path.join(directory,'synk-20261108-130000.dump');fs.writeFileSync(latest,'bad');fs.utimesSync(latest,new Date(now-1000),new Date(now-1000));
  assert.equal(readBackupStatus({directory,now}).status,'invalid');
}));
