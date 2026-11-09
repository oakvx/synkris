import path from 'node:path';
import {pathToFileURL} from 'node:url';

// A snapshot is identified by the workflow execution, not by changes in git.
// Thus weekly snapshots remain distinct even if master is unchanged.
export function makeSnapshotTag({version, utcDate, runId, runAttempt = 1}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
    throw new Error('Snapshot requires an rc.N package version.');
  }
  if (typeof utcDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(utcDate) ||
      Number.isNaN(Date.parse(utcDate + 'T00:00:00Z')) ||
      new Date(utcDate + 'T00:00:00Z').toISOString().slice(0, 10) !== utcDate) {
    throw new Error('Snapshot date must be a real UTC YYYY-MM-DD.');
  }
  const id = String(runId);
  const attempt = String(runAttempt);
  if (!/^[1-9]\d*$/.test(id) || !/^[1-9]\d*$/.test(attempt)) {
    throw new Error('GitHub run ID and attempt must be positive integers.');
  }
  return `v${version}-snapshot.${utcDate.replaceAll('-', '')}.${id}.${attempt}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , version, utcDate, runId, runAttempt] = process.argv;
  console.log(makeSnapshotTag({version, utcDate, runId, runAttempt}));
}
