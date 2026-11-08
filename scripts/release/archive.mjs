import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {isReleasePath,requiredFiles} from './layout.mjs';

export const sha256 = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function createArchive(files,metadata) {
  const hashes=Object.fromEntries(Object.keys(files).sort().map(name=>{
    if(!isReleasePath(name))throw new Error('Unsafe package entry: '+name);
    return [name,sha256(files[name])];
  }));
  const manifest={format:1,version:metadata.version,kind:'reconstructed-prerelease',requiresRealWorldValidation:true,
    sourceCommit:metadata.sourceCommit,sourceDirty:Boolean(metadata.sourceDirty),files:hashes};
  const entries={...files,'RELEASE-MANIFEST.json':strToU8(JSON.stringify(manifest,null,2)+'\n')};
  const zipInput=Object.fromEntries(Object.keys(entries).sort().map(name=>[name,[entries[name],{mtime:new Date(2000,0,1,0,0,0),os:3,attrs:0o100644<<16}]]));
  const archive=zipSync(zipInput,{level:9});
  verifyArchive(archive);
  return {archive,manifest};
}
export function verifyArchive(bytes) {
  if(bytes.length>64*1024*1024)throw new Error('Archive too large.');
  let count=0,total=0; const seen=new Set();
  const entries=unzipSync(bytes,{filter:entry=>{
    const key=entry.name.toLowerCase();
    if(seen.has(key))throw new Error('Duplicate archive entry: '+entry.name);
    seen.add(key);count++;total+=entry.originalSize;
    if(count>10000||total>64*1024*1024||entry.originalSize>20*1024*1024)throw new Error('Uncompressed package too large.');
    if(entry.name!=='RELEASE-MANIFEST.json'&&!isReleasePath(entry.name))throw new Error('Unsafe archive entry: '+entry.name);
    return true;
  }});
  if(!entries['RELEASE-MANIFEST.json'])throw new Error('Manifest missing.');
  const manifest=JSON.parse(strFromU8(entries['RELEASE-MANIFEST.json']));
  if(manifest.format!==1||!/^\d+\.\d+\.\d+-rc\.\d+$/.test(manifest.version)||manifest.requiresRealWorldValidation!==true||manifest.kind!=='reconstructed-prerelease'||typeof manifest.sourceDirty!=='boolean'||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)||!manifest.files||Array.isArray(manifest.files))throw new Error('Invalid prerelease manifest.');
  const actual=Object.keys(entries).filter(n=>n!=='RELEASE-MANIFEST.json').sort();
  const declared=Object.keys(manifest.files).sort();
  if(JSON.stringify(actual)!==JSON.stringify(declared))throw new Error('Unexpected/missing archive files.');
  for(const required of requiredFiles)if(!actual.includes(required))throw new Error('Required package file missing: '+required);
  for(const name of actual) {
    if(!isReleasePath(name)||!/^[a-f0-9]{64}$/.test(manifest.files[name])||sha256(entries[name])!==manifest.files[name])throw new Error('Hash mismatch: '+name);
  }
  const pkg=JSON.parse(strFromU8(entries['package.json']));
  const lock=JSON.parse(strFromU8(entries['package-lock.json']));
  if(pkg.version!==manifest.version||lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version)throw new Error('Package and manifest versions differ.');
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(!process.argv[2])throw new Error('Usage: node scripts/release/archive.mjs <zip>');
  const manifest=verifyArchive(fs.readFileSync(process.argv[2]));
  console.log(`Archive verified: ${manifest.version}, ${Object.keys(manifest.files).length} files, working tree dirty: ${manifest.sourceDirty}`);
}
