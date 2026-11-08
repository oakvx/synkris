import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

export function assessAudit(report) {
  const counts=report?.metadata?.vulnerabilities;
  if(!counts||!['low','moderate','high','critical','total'].every(key=>Number.isInteger(counts[key])&&counts[key]>=0))throw new Error('Dependency audit is unavailable or malformed; review manually before packaging.');
  if(counts.critical>0)throw new Error(`Prerelease blocked: ${counts.critical} critical dependency findings.`);
  return counts;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(!process.env.npm_execpath)throw new Error('Run with npm run audit:release.');
  let raw;
  try{raw=execFileSync(process.execPath,[process.env.npm_execpath,'audit','--omit=dev','--json'],{encoding:'utf8',maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});}
  catch(error){if(error.status!==1||!error.stdout)throw new Error('Dependency audit failed to execute.');raw=String(error.stdout);}
  const report=JSON.parse(raw);
  fs.mkdirSync('artifacts',{recursive:true});
  fs.writeFileSync('artifacts/dependency-audit.json',JSON.stringify(report,null,2)+'\n');
  const counts=assessAudit(report);
  console.log('Production dependency audit:',JSON.stringify(counts));
  if(counts.total)console.warn('OPEN DEPENDENCY FINDINGS: this is a test prerelease, not production approval. Review artifacts/dependency-audit.json.');
}
