import test from 'node:test';
import assert from 'node:assert/strict';
import {auditSummary} from '../scripts/release/audit-summary.mjs';

const report = counts => ({metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0,...counts}}});

test('clean production audit shows PASS and artifact reference', () => {
  const summary = auditSummary(report({}));
  assert.match(summary, /PASS/);
  assert.match(summary, /dependency-audit/);
});

test('high and moderate findings require review, not production approval', () => {
  const summary = auditSummary(report({high:11,moderate:8,total:19}));
  assert.match(summary, /REVIEW REQUIRED/);
  assert.match(summary, /\| high \| 11 \|/);
  assert.match(summary, /\| \*\*Total\*\* \| \*\*19\*\* \|/);
});

test('critical findings are explicitly blocked', () => {
  assert.match(auditSummary(report({critical:1,total:1})), /BLOCKED/);
});

test('malformed or inconsistent audits fail closed', () => {
  assert.throws(() => auditSummary({}), /missing or malformed/);
  assert.throws(() => auditSummary(report({high:-1})), /missing or malformed/);
  assert.throws(() => auditSummary(report({high:2,total:1})), /inconsistent/);
});

test('package triage shows direct and transitive dependencies with suggested fixes', () => {
  const input = report({high:1,moderate:1,total:2});
  input.vulnerabilities = {
    'z-transitive': {severity:'moderate',isDirect:false,fixAvailable:true,via:[{title:'sensitive advisory content'}]},
    'a-direct': {severity:'high',isDirect:true,fixAvailable:{name:'a-direct',version:'3.0.0',isSemVerMajor:true}},
  };
  const summary = auditSummary(input);
  assert.ok(summary.indexOf('a-direct | high') < summary.indexOf('z-transitive | moderate'));
  assert.match(summary, /a-direct \| high \| Direct \| a-direct@3\.0\.0 \(outside allowed SemVer range\)/);
  assert.match(summary, /z-transitive \| moderate \| Transitive \| Fix reported/);
  assert.doesNotMatch(summary, /sensitive advisory content/);
});

test('package names are escaped in GitHub Markdown summary', () => {
  const input = report({low:1,total:1});
  input.vulnerabilities = {'bad|package\nnew row':{severity:'low',isDirect:false,fixAvailable:false}};
  const summary = auditSummary(input);
  assert.match(summary, /bad package new row \| low \| Transitive \| No fix reported/);
  assert.doesNotMatch(summary, /bad\|package/);
});

test('large npm audits are bounded and refer to full artifact', () => {
  const input = report({high:43,total:43});
  input.vulnerabilities = Object.fromEntries(Array.from({length:43},(_,i)=>[
    'dependency-'+String(i).padStart(2,'0'),
    {severity:'high',isDirect:false,fixAvailable:false}
  ]));
  const summary = auditSummary(input);
  assert.equal((summary.match(/\| dependency-\d\d \|/g) || []).length, 40);
  assert.match(summary, /and 3 more packages in the artifact/);
  assert.match(summary, /dependency-audit/);
});
