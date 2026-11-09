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
