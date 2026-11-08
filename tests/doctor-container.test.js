import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('offline doctor uses the installed runtime image with no network and read-only mounts',()=>{
  const compose=read('compose.yaml');const doctor=compose.split('\n  doctor:\n')[1].split('\n  ollama:\n')[0];
  assert.match(doctor,/network_mode: none/);assert.match(doctor,/read_only: true/);assert.match(doctor,/pull_policy: never/);
  assert.match(doctor,/cap_drop: \["ALL"\]/);assert.match(doctor,/profiles: \["tools"\]/);
  assert.doesNotMatch(doctor,/build:|depends_on:|ports:|runtime\/session/);
  for(const line of doctor.split('\n').filter(line=>line.trim().startsWith('- ./')))assert.ok(line.endsWith(':ro'));
  assert.equal((compose.match(/image: \$\{COMPOSE_PROJECT_NAME:-synk\}-runtime:local/g)||[]).length,3);
  assert.match(read('Dockerfile'),/COPY scripts\/deploy \.\/scripts\/deploy/);
});
test('Windows diagnostics do not run provider clients or start dependencies',()=>{
  const source=read('strumenti/preflight.ps1');
  assert.match(source,/run --rm --no-deps -T --pull never doctor/);
  assert.doesNotMatch(source,/compose logs|compose up|compose build|config --format json/);
});
