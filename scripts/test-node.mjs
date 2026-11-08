import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const tests=fs.readdirSync('tests').filter(name=>name.endsWith('.test.js')).sort().map(name=>'tests/'+name);
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{
  encoding:'utf8',maxBuffer:16*1024*1024,
});
process.stdout.write(result.stdout||'');
process.stderr.write(result.stderr||'');
if(result.error)console.error(result.error);
if(result.status!==0&&process.env.GITHUB_ACTIONS==='true') {
  // Keep failures visible through the Checks API, even when log downloads are unavailable.
  const failures=[...(result.stdout||'').matchAll(/^not ok .*(?:\r?\n[ \t]+.*)*/gm)].map(match=>match[0]);
  const detail=failures.join('\n\n')||[result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\n')||'Node tests terminated without an exit status.';
  const escaped=detail.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  process.stdout.write('::error title=Node test suite failed::'+escaped+'\n');
}
process.exitCode=result.status??1;
