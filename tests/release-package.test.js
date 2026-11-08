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
  for(const name of ['.env','.env.production','secrets/license.txt','runtime/session/file.json','src/.wwebjs_auth/session-whatsapp-ai/Default/service.js','src/.wwebjs_cache/cache.js','setup/config.json','src/config.json','src/customer.json','src/private.pem','node_modules/pg/index.js','../package.json','src/../.env','C:/a','src\\index.js','src/CON.js','src/a.'])assert.equal(isReleasePath(name),false,name);
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
test('runtime provider imports the pinned Client/LocalAuth/event API without a browser',async()=>{
  const {default:provider}=await import('whatsapp-web.js');
  assert.equal(provider.version,'1.34.7');
  assert.equal(typeof provider.Client,'function');
  assert.equal(typeof provider.LocalAuth,'function');
  assert.equal(typeof provider.Client.prototype.initialize,'function');
  assert.equal(typeof provider.Client.prototype.sendMessage,'function');
  assert.equal(typeof provider.Client.prototype.getContactLidAndPhone,'function');
  assert.equal(typeof provider.Client.prototype.destroy,'function');
  assert.equal(provider.Events.READY,'ready');
  assert.equal(provider.WAState.CONNECTED,'CONNECTED');
});

test('OpenWA and its obsolete override are absent from the install graph',async()=>{
  const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
  assert.throws(()=>require.resolve('@open-wa/wa-automate'),{code:'MODULE_NOT_FOUND'});
  const pkg=JSON.parse(files['package.json']);
  const lock=JSON.parse(files['package-lock.json']);
  assert.equal(pkg.dependencies['@open-wa/wa-automate'],undefined);
  assert.equal(pkg.overrides?.['@open-wa/wa-automate'],undefined);
  assert.equal(Object.keys(lock.packages).some(name=>name.includes('@open-wa/')),false);
  assert.equal(pkg.dependencies['whatsapp-web.js'],'1.34.7');
  assert.equal(pkg.dependencies.qrcode,'1.5.4');
});

test('dependency gate blocks critical findings and missing audit results',async()=>{
  const {assessAudit}=await import('../scripts/release/audit.mjs');
  assert.throws(()=>assessAudit({error:'network unavailable'}),/unavailable/);
  assert.throws(()=>assessAudit({metadata:{vulnerabilities:{low:0,moderate:0,high:0,critical:1,total:1}}}),/blocked/);
  assert.equal(assessAudit({metadata:{vulnerabilities:{low:0,moderate:0,high:2,critical:0,total:2}}}).high,2);
});

test('release carries the new upstream license texts without relicensing them',()=>{
  const notices=Buffer.from(files['deploy/THIRD_PARTY_NOTICES.md']).toString('utf8').replace(/\r\n/g,'\n');
  for(const name of ['whatsapp-web.js/LICENSE','qrcode/license']) {
    const license=fs.readFileSync(path.join(root,'node_modules',name),'utf8').replace(/\r\n/g,'\n').trim();
    assert.ok(notices.includes(license),'Missing original upstream notice: '+name);
  }
  assert.match(fs.readFileSync(path.join(root,'Dockerfile'),'utf8'),/COPY LICENSE\.md deploy\/THIRD_PARTY_NOTICES\.md/);
});

test('entrypoint waits for real provider readiness and keeps bounded shutdown without activation code',()=>{
  const source=Buffer.from(files['src/index.js']).toString('utf8');
  const ready=source.indexOf('await client.initialize();');
  assert.ok(ready>source.indexOf('client = createWhatsAppClient('));
  assert.ok(ready<source.indexOf('acceptingMessages = true;'));
  assert.ok(ready<source.indexOf('actions.sendText = (to, message)'));
  assert.match(source,/if \(closing \|\| !acceptingMessages\) return;/);
  assert.ok(source.indexOf('client?.beginShutdown();')<source.indexOf('Promise.allSettled([...inflightMessages])'));
  assert.match(Buffer.from(files['compose.yaml']).toString('utf8'),/stop_grace_period: 30s/);
  assert.doesNotMatch(source,/ensureLicense|verifyLicense|createLicenseMonitor|LICENSE_|APP_HWID/);
  for(const name of Object.keys(files))assert.doesNotMatch(name,/^(?:src\/licensing\/|deploy\/license-guard\.php$|scripts\/deploy\/verify-installation-license\.mjs$)/);
});

test('Windows updater code allowlist covers every generated package entry',()=>{
  const source=fs.readFileSync(new URL('../strumenti/common.ps1',import.meta.url),'utf8');
  const declaration=source.split('\n').find(line=>line.startsWith('$script:CodePaths = '));
  const paths=[...declaration.matchAll(/'([^']+)'/g)].map(match=>match[1]);
  for(const name of Object.keys(files))assert.ok(paths.some(prefix=>name===prefix||name.startsWith(prefix+'/')),'Updater cannot deploy '+name);
});
