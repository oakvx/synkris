import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {releaseFiles,requiredFiles} from '../scripts/release/layout.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('one installer and one startup entrypoint exist in the repository and release package',()=>{
  const launchers=fs.readdirSync(root).filter(name=>/^(?:APRI|AVVIA|INSTALLA)_.*\.bat$/i.test(name)).sort();
  assert.deepEqual(launchers,['AVVIA_SYNK.bat','INSTALLA_SYNK.bat']);
  assert.ok(releaseFiles.includes('INSTALLA_SYNK.bat'));
  assert.ok(releaseFiles.includes('AVVIA_SYNK.bat'));
  for(const obsolete of ['APRI_SYNK.bat','INSTALLA_UNA_VOLTA.bat']) {
    assert.equal(fs.existsSync(path.join(root,obsolete)),false,obsolete);
    assert.equal(releaseFiles.includes(obsolete),false,obsolete);
  }
});

test('the installer and daily start use exactly their respective modules',()=>{
  const install=read('INSTALLA_SYNK.bat');
  const start=read('AVVIA_SYNK.bat');
  assert.match(install,/if not exist "%~dp0strumenti\\installa\.ps1"/i);
  assert.match(install,/powershell\.exe.*-File "%~dp0strumenti\\installa\.ps1" -Menu/i);
  assert.doesNotMatch(install,/avvio\.ps1|avvia\.ps1/i);
  assert.match(start,/if not exist "%~dp0strumenti\\avvio\.ps1"/i);
  assert.match(start,/powershell\.exe.*-File "%~dp0strumenti\\avvio\.ps1" -Run/i);
  assert.doesNotMatch(start,/installa\.ps1|avvia\.ps1/i);
  assert.match(start,/if errorlevel 1/i);
});

test('one runnable startup engine is also reusable by installer and Windows autostart',()=>{
  const engine=read('strumenti/avvio.ps1');
  const autostart=read('strumenti/avvio-automatico.ps1');
  assert.match(engine,/^param\(\[switch\]\$Run, \[switch\]\$NoBrowser, \[switch\]\$Quiet\)/);
  assert.match(engine,/if \(\$Run\) \{/);
  assert.match(engine,/Start-SynkServices -NoBrowser:\$NoBrowser/);
  assert.equal(fs.existsSync(path.join(root,'strumenti/avvia.ps1')),false);
  assert.equal(requiredFiles.includes('strumenti/avvia.ps1'),false);
  assert.match(autostart,/strumenti\/avvio\.ps1/);
  assert.match(autostart,/-Run -NoBrowser -Quiet/);
  assert.match(autostart,/if \(\$shortcut\.Arguments -ceq \$oldArguments\) \{ return 'legacy' \}/);
});

test('release updater accepts the same canonical launchers as the manifest',()=>{
  const common=read('strumenti/common.ps1');
  const declaration=common.split('\n').find(line=>line.startsWith('$script:CodePaths = '));
  const allowed=[...declaration.matchAll(/'([^']+)'/g)].map(m=>m[1]);
  assert.ok(allowed.includes('INSTALLA_SYNK.bat'));
  assert.ok(allowed.includes('AVVIA_SYNK.bat'));
  assert.equal(allowed.includes('INSTALLA_UNA_VOLTA.bat'),false);
  assert.equal(allowed.includes('APRI_SYNK.bat'),false);
});
