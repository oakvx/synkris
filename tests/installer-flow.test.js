import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../strumenti/installa.ps1',import.meta.url),'utf8');
test('one-click installation runs guided setup and imports before starting dependencies',()=>{
  for(const command of ['Initialize-SynkSalonConfiguration','Initialize-SynkCredentials','Initialize-SynkEnvironment','Get-SynkOfflineDoctor'])assert.ok(source.includes(command));
  const preflight=source.indexOf('$report = Get-SynkOfflineDoctor');
  assert.ok(preflight>source.indexOf("@('build','bootstrap','bot','dashboard')"));
  assert.ok(preflight<source.indexOf("@('up','-d'"));
  assert.match(source,/if \(-not \$report.readyForBootstrap\) \{ throw/);
  assert.doesNotMatch(source,/Write-Host \$dashboardPassword|Copy-Item.*config.example.json/);
});
test('installer explicitly prepares required images before no-pull startup and protects restore holds',()=>{
  assert.match(source,/@\('pull','postgres','backup'\)/);
  assert.match(source,/@\('up','-d','--no-build','--pull','never'\)/);
  assert.ok(source.indexOf('calendar-reconciliation-required.flag')<source.indexOf('Initialize-SynkSalonConfiguration'));
  assert.match(source,/Initialize-SynkEnvironment -DatabaseExists:\$databaseExists/);
});
test('guided reconfiguration is restricted to initial setup and makes an atomic private backup',()=>{
  const wizard=fs.readFileSync(new URL('../strumenti/configurazione.ps1',import.meta.url),'utf8');
  assert.match(wizard,/\$Reconfigure -and \(Test-Path -LiteralPath \$marker\)/);
  assert.match(wizard,/RICONFIGURA \/ ANNULLA/);assert.match(wizard,/\[IO.File\]::Replace\(\$staging,\$destination,\$backup\)/);
  assert.match(wizard,/runtime\/setup-backups/);assert.match(wizard,/runtime\/setup-staging/);
});
