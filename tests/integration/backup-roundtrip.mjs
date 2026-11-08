// Execute only on the explicitly named disposable CI database/container.
// This proves a synthetic PostgreSQL 16 roundtrip, never a salon-PC restore.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const container=process.env.TEST_POSTGRES_CONTAINER;
const source=process.env.TEST_DATABASE_URL;
if (!source || new URL(source).pathname !== '/synk_test' || process.env.SYNK_TEST_DB_ALLOW_RESET !== '1' || !/^[a-f0-9]{12,64}$/.test(container || '')) throw new Error('Refusing non-CI backup restore: explicit synk_test database/container/reset authorization required.');
const suffix=crypto.randomBytes(6).toString('hex');
const target='synk_restore_probe_'+suffix;
const folder='/tmp/synk-backup-probe-'+suffix;
const script='/tmp/synk-backup-loop-'+suffix+'.sh';
const docker=(args)=>spawnSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
const checked=(result,stage)=>{if(result.status!==0)throw new Error(stage+': '+String(result.stderr||'').slice(0,6000));return result.stdout.trim();};
const exec=(args,extra=[])=>docker(['exec','-e','PGHOST=127.0.0.1','-e','PGUSER=synk_test','-e','PGPASSWORD=synk_test','-e','PGDATABASE=synk_test',...extra,container,...args]);
let authorized=false,created=false;
try {
  const inspection=JSON.parse(checked(docker(['inspect',container]),'Inspect disposable container'))[0];
  const env=new Set(inspection.Config.Env);
  assert.ok(env.has('POSTGRES_DB=synk_test') && env.has('POSTGRES_USER=synk_test') && env.has('POSTGRES_PASSWORD=synk_test'),'Refusing a container without the exact disposable CI identity');
  authorized=true;
  const actual=checked(exec(['psql','-At','-c','SELECT current_database()']),'Check source identity');assert.equal(actual,'synk_test');
  const version=Number(checked(exec(['psql','-At','-c','SHOW server_version_num']),'Verify PostgreSQL version'));
  assert.ok(version>=160000 && version<170000,'This roundtrip requires PostgreSQL 16');
  checked(docker(['cp',fileURLToPath(new URL('../../deploy/backup-loop.sh',import.meta.url)),container+':'+script]),'Copy backup producer');
  checked(exec(['sh',script],['-e','SYNK_BACKUP_ONCE=1','-e','SYNK_BACKUP_DIR='+folder]),'Run real pg_dump/pg_restore --list');
  const listed=checked(exec(['find',folder,'-maxdepth','1','-name','synk-*.dump','-type','f']),'Find published dump').split('\n');
  assert.equal(listed.length,1);assert.ok(new RegExp('^'+folder+'/synk-\\d{8}-\\d{6}\\.dump$').test(listed[0]));
  const dump=listed[0];
  const digest=checked(exec(['sha256sum',dump]),'Hash real dump').split(/\s+/)[0];
  assert.equal(checked(exec(['cat',dump+'.sha256']),'Read published checksum'),digest+'  '+dump.split('/').at(-1));
  checked(exec(['createdb',target]),'Create new disposable restore target');created=true;
  checked(exec(['pg_restore','--exit-on-error','--no-owner','--no-privileges','--single-transaction','-d',target,dump]),'Restore synthetic database');
  const sql='SELECT (SELECT count(*) FROM public.clients),(SELECT count(*) FROM public.appointments),(SELECT count(*) FROM public.professionals),(SELECT count(*) FROM public.services),(SELECT count(*) FROM public.calendar_outbox)';
  const before=checked(exec(['psql','-At','-F','|','-d','synk_test','-c',sql]),'Read source counts');
  const after=checked(exec(['psql','-At','-F','|','-d',target,'-c',sql]),'Read restored counts');
  assert.equal(after,before,'Synthetic entity/outbox counts changed after restore');
  console.log('PASS: real PostgreSQL 16 dump/list/SHA256/transactional restore into a new disposable CI database; entity and outbox counts preserved.');
} catch(error) {
  console.error('::error title=Disposable PostgreSQL backup roundtrip failed::'+String(error.message).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
  process.exitCode=1;
} finally {
  // Drop only the exact random target created above; never reset the source.
  if(created)exec(['dropdb',target]);
  if(authorized)exec(['rm','-rf',folder,script]);
}
