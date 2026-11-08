import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {collectReleaseFiles,isReleasePath,requiredFiles} from '../scripts/release/layout.mjs';
import {createArchive,verifyArchive} from '../scripts/release/archive.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=Object.fromEntries(collectReleaseFiles(root).map(name=>[name,fs.readFileSync(path.join(root,name))]));
const metadata={version:JSON.parse(files['package.json']).version,sourceCommit:'a'.repeat(40),sourceDirty:false};
const {archive,manifest}=createArchive(files,metadata);

test('release archive is flat, complete and versioned with per-file hashes',()=>{
  assert.equal(verifyArchive(archive).version,metadata.version);
  const entries=unzipSync(archive);
  for(const name of requiredFiles)assert.ok(entries[name],name);
  assert.equal(manifest.requiresRealWorldValidation,true);
  assert.equal(manifest.kind,'reconstructed-prerelease');
  assert.equal(entries['synk/src/index.js'],undefined);
});
test('release generation is deterministic for identical source and provenance',()=>{
  const again=createArchive(files,metadata).archive;
  assert.deepEqual(again,archive);
});
test('private data and generated files are never eligible for packaging',()=>{
  for(const name of ['.env','.env.production','secrets/license.txt','runtime/session/file.json','setup/config.json','src/config.json','src/customer.json','src/private.pem','node_modules/pg/index.js','../package.json','src/../.env','C:/a','src\\index.js','src/CON.js','src/a.'])assert.equal(isReleasePath(name),false,name);
  assert.equal(isReleasePath('.env.example'),true);
  assert.equal(isReleasePath('setup/config.example.json'),true);
});
test('ignored salon files remain out of an otherwise complete deployment tree',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'synk-package-'));
  try {
    for(const [name,bytes]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(temp,name)),{recursive:true});fs.writeFileSync(path.join(temp,name),bytes);}
    for(const name of ['.env','setup/config.json','secrets/license.txt','runtime/customer.json']){fs.mkdirSync(path.dirname(path.join(temp,name)),{recursive:true});fs.writeFileSync(path.join(temp,name),'synthetic private fixture');}
    const names=collectReleaseFiles(temp);
    for(const name of ['.env','setup/config.json','secrets/license.txt','runtime/customer.json'])assert.equal(names.includes(name),false);
    fs.writeFileSync(path.join(temp,'src/private.key'),'synthetic');
    assert.throws(()=>collectReleaseFiles(temp),/Forbidden/);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
test('archive verification fails on content tampering or undeclared entries',()=>{
  const entries=unzipSync(archive);
  entries['src/index.js']=strToU8('tampered');
  assert.throws(()=>verifyArchive(zipSync(entries)),/Hash mismatch/);
  const extra=unzipSync(archive);extra['src/unexpected.js']=strToU8('extra');
  assert.throws(()=>verifyArchive(zipSync(extra)),/Unexpected/);
});
test('archive verification rejects path traversal and partial packages',()=>{
  assert.throws(()=>verifyArchive(zipSync({'../.env':strToU8('fixture')})),/Unsafe/);
  assert.throws(()=>verifyArchive(zipSync({'package.json':files['package.json']})),/Manifest missing/);
});
test('runtime provider matches the bot create/event API without starting a session',async()=>{
  const provider=await import('@open-wa/wa-automate');
  assert.equal(typeof provider.create,'function');
  assert.equal(typeof provider.ev?.on,'function');
});

test('patched URL parser preserves the OpenWA Postman builder contract',async()=>{
  const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
  const parse=require(require.resolve('parse-url',{paths:[require.resolve('@open-wa/wa-automate')]}));
  const parsed=parse('https://localhost:8080/api');
  assert.equal(parsed.resource,'localhost');assert.equal(parsed.pathname,'/api');assert.equal(parsed.protocol,'https');
});

test('dependency gate blocks critical findings and missing audit results',async()=>{
  const {assessAudit}=await import('../scripts/release/audit.mjs');
  assert.throws(()=>assessAudit({error:'network unavailable'}),/unavailable/);
  assert.throws(()=>assessAudit({metadata:{vulnerabilities:{low:0,moderate:0,high:0,critical:1,total:1}}}),/blocked/);
  assert.equal(assessAudit({metadata:{vulnerabilities:{low:0,moderate:0,high:2,critical:0,total:2}}}).high,2);
});

test('Windows updater code allowlist covers every generated package entry',()=>{
  const source=fs.readFileSync(new URL('../strumenti/common.ps1',import.meta.url),'utf8');
  const declaration=source.split('\n').find(line=>line.startsWith('$script:CodePaths = '));
  const paths=[...declaration.matchAll(/'([^']+)'/g)].map(match=>match[1]);
  for(const name of Object.keys(files))assert.ok(paths.some(prefix=>name===prefix||name.startsWith(prefix+'/')),'Updater cannot deploy '+name);
});
