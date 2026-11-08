import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../strumenti/accesso.ps1',import.meta.url),'utf8');
test('local credential access starts masked and never prints or rotates a password',()=>{
  assert.match(source,/\$field.UseSystemPasswordChar = \$true/);assert.match(source,/\$reveal.Checked = \$false/);
  assert.doesNotMatch(source,/Set-EnvValue|Write-(?:Host|Output|Error).*\$(?:password|field)|Start-Process.*\$password/);
  assert.match(source,/\[void\]\$window.ShowDialog\(\)/);
});
test('clipboard use requires a user click and does not overwrite unrelated clipboard data on close',()=>{
  assert.match(source,/\$copy.Add_Click\(\{/);assert.match(source,/Clipboard\]::SetText\(\$field.Text\)/);
  assert.match(source,/GetText\(\) -ceq \$password/);assert.match(source,/cronologia appunti.*NON vengono cancellate/);
  assert.match(source,/\$field.Text = ''; \$password = \$null; \$window.Dispose\(\)/);
});
