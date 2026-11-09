import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const severities = ['critical', 'high', 'moderate', 'low', 'info'];

// Render only package metadata from npm audit; never dump advisory payloads or local paths.
const safeCell = value => String(value ?? '').replace(/[\r\n|`]/g, ' ').slice(0, 120);
function packageDetails(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) return [];
  const items = Object.entries(vulnerabilities)
    .filter(([, info]) => info && typeof info === 'object' && !Array.isArray(info))
    .sort(([nameA, infoA], [nameB, infoB]) =>
      (severities.indexOf(infoA.severity) === -1 ? 99 : severities.indexOf(infoA.severity)) -
      (severities.indexOf(infoB.severity) === -1 ? 99 : severities.indexOf(infoB.severity)) ||
      nameA.localeCompare(nameB));
  if (!items.length) return [];
  const rows = items.slice(0, 40).map(([name, info]) => {
    const scope = info.isDirect === true ? 'Direct' : info.isDirect === false ? 'Transitive' : 'Unknown';
    const fix = info.fixAvailable;
    let resolution = 'Not reported';
    if (fix === false) resolution = 'No fix reported';
    else if (fix === true) resolution = 'Fix reported';
    else if (fix && typeof fix === 'object' && typeof fix.name === 'string' && typeof fix.version === 'string') {
      resolution = safeCell(fix.name + '@' + fix.version) + (fix.isSemVerMajor ? ' (outside allowed SemVer range)' : '');
    }
    return `| ${safeCell(name)} | ${safeCell(info.severity || 'unknown')} | ${scope} | ${resolution} |`;
  });
  return [
    '#### Affected packages (triage)',
    '',
    '| Package | Severity | Dependency | npm fixAvailable |',
    '| --- | --- | --- | --- |',
    ...rows,
    ...(items.length > 40 ? [`... and ${items.length - 40} more packages in the artifact.`] : []),
    '',
    'A reported fix is not automatically safe: validate compatibility, lockfile changes and CI before upgrading.',
    ''
  ];
}

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
    ...packageDetails(report),
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
