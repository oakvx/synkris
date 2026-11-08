import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const runner=fileURLToPath(new URL('../scripts/test-node.mjs',import.meta.url));
function fixture(source,githubActions) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'synk-test-runner-'));
  try {
    fs.mkdirSync(path.join(directory,'tests'));
    fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(directory,'tests/fixture.test.js'),source);
    const env={...process.env,GITHUB_ACTIONS:githubActions?'true':'false'};
    // The outer node --test sets this marker for its own workers. This is a new test run.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath,[runner],{cwd:directory,env,encoding:'utf8'});
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
}
const failure="import test from 'node:test';import assert from 'node:assert/strict';test('synthetic failure',()=>assert.fail('fixture 100% failed\\nsecond line'));";

test('Node test runner preserves passing exit status and TAP output',()=>{
  const result=fixture("import test from 'node:test';test('synthetic success',()=>{});",true);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/ok 1 - synthetic success/);
  assert.doesNotMatch(result.stdout,/::error /);
});
test('Node test runner preserves failures and annotates escaped details in CI',()=>{
  const result=fixture(failure,true);
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stdout,/not ok 1 - synthetic failure/);
  const annotation=result.stdout.split('\n').find(line=>line.startsWith('::error '));
  assert.ok(annotation,'Missing GitHub Checks annotation');
  assert.match(annotation,/synthetic failure/);
  assert.match(annotation,/100%25 failed%0A/);
  assert.match(annotation,/second line/);
});
test('Node test runner does not emit GitHub commands outside CI',()=>{
  const result=fixture(failure,false);
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stdout,/not ok 1 - synthetic failure/);
  assert.doesNotMatch(result.stdout,/::error /);
});
