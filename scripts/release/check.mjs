import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectReleaseFiles,requiredFiles} from './layout.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=new Set(process.argv.slice(2));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(pkg.version)) throw new Error('Only release candidates can be packaged by this workflow.');
if (lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version||lock.lockfileVersion<3) throw new Error('package-lock.json is missing or out of sync.');
for(const field of ['dependencies','devDependencies']) {
  if(JSON.stringify(pkg[field]||{})!==JSON.stringify(lock.packages[''][field]||{})) throw new Error('Lockfile dependency declarations differ: '+field);
}
const names=collectReleaseFiles(root);
for(const required of requiredFiles) if(!names.includes(required))throw new Error('Release component missing: '+required);
for(const dockerfile of ['Dockerfile','Dockerfile.dashboard']) {
  const source=fs.readFileSync(path.join(root,dockerfile),'utf8');
  for(const line of source.split('\n')) {
    if(!/^COPY\s/i.test(line))continue;
    const sources=line.trim().split(/\s+/).slice(1,-1);
    for(const name of sources) if(!fs.existsSync(path.join(root,name)))throw new Error(`${dockerfile} refers to missing ${name}`);
  }
}
const dockerSource=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
if(!dockerSource.includes('npm ci')||!dockerSource.includes('package-lock.json'))throw new Error('Docker must use npm ci with the lockfile.');
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
for(const name of files) {
  if ((/^(?:\.env(?:\.|$)|runtime\/|secrets\/|setup\/config\.json$|node_modules\/|artifacts\/|\.cache\/)/.test(name)&&!['.env.example','secrets/LEGGIMI.txt'].includes(name)) || /\.(pem|key|dump|zip)$/i.test(name)) throw new Error('Private/generated file must not be tracked: '+name);
  const filename=path.join(root,name);
  if(fs.existsSync(filename)&&fs.statSync(filename).isFile()&&fs.statSync(filename).size<5*1024*1024) {
    const text=fs.readFileSync(filename,'utf8');
    if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)||/AIza[0-9A-Za-z_-]{35}/.test(text))throw new Error('Possible credential detected in '+name);
  }
}
function walk(dir) {
  return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
}
if(args.has('--syntax')) {
  for(const name of [...names,...walk('tests')].filter(n=>/\.(?:js|mjs|cjs)$/.test(n)))execFileSync(process.execPath,['--check',path.join(root,name)],{stdio:'inherit'});
}
if(args.has('--php')) {
  const php=process.env.PHP_BINARY||'php';
  const phpFiles=[...names,...walk('tests')].filter(n=>n.endsWith('.php'));
  for(const name of phpFiles)execFileSync(php,['-l',path.join(root,name)],{stdio:'inherit'});
}
console.log(`Release structure and repository audit OK: ${pkg.version}, ${names.length} deployment files.`);
