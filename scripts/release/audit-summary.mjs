import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const severities = ['critical', 'high', 'moderate', 'low', 'info'];

export function auditSummary(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || !severities.every(key => Number.isInteger(counts[key]) && counts[key] >= 0)) {
    throw new Error('Dependency audit report is missing or malformed.');
  }
  const total = severities.reduce((sum, key) => sum + counts[key], 0);
  if (!Number.isInteger(counts.total) || counts.total < total) {
    throw new Error('Dependency audit totals are inconsistent.');
  }
  const rows = severities.map(key => `| ${key} | ${counts[key]} |`).join('\n');
  const verdict = counts.critical
    ? '**BLOCKED:** critical production dependency findings.'
    : total
      ? '**REVIEW REQUIRED:** noncritical production dependency findings; this is not production approval.'
      : '**PASS:** no reported production dependency findings.';
  return [
    '### Production dependency audit',
    '',
    verdict,
    '',
    '| Severity | Findings |',
    '| --- | ---: |',
    rows,
    `| **Total** | **${counts.total}** |`,
    '',
    'Scope: `npm audit --omit=dev`. Full machine-readable report: `dependency-audit` workflow artifact.',
    ''
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = JSON.parse(fs.readFileSync(process.argv[2] || 'artifacts/dependency-audit.json', 'utf8'));
  const summary = auditSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
}
