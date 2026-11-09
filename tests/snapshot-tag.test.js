import test from 'node:test';
import assert from 'node:assert/strict';
import {makeSnapshotTag} from '../scripts/release/snapshot-tag.mjs';

test('weekly snapshot tags identify the run even with unchanged source commit', () => {
  const base={version:'1.2.0-rc.6',utcDate:'2026-11-09',runAttempt:1};
  assert.equal(makeSnapshotTag({...base,runId:42550001}), 'v1.2.0-rc.6-snapshot.20261109.42550001.1');
  assert.notEqual(
    makeSnapshotTag({...base,runId:42550001}),
    makeSnapshotTag({...base,runId:42550002})
  );
});

test('retries and future dates never overwrite an earlier snapshot', () => {
  const base={version:'1.2.0-rc.6',utcDate:'2026-11-09',runId:42550001};
  assert.notEqual(makeSnapshotTag({...base,runAttempt:1}),makeSnapshotTag({...base,runAttempt:2}));
  assert.notEqual(makeSnapshotTag(base),makeSnapshotTag({...base,utcDate:'2026-11-16'}));
  assert.notEqual(makeSnapshotTag(base),makeSnapshotTag({...base,version:'1.2.0-rc.7'}));
});

test('the tag generator rejects invalid versions, dates and run metadata', () => {
  const defaults={version:'1.2.0-rc.6',utcDate:'2026-11-09',runId:1,runAttempt:1};
  for(const version of ['1.2.0', '1.2.0-beta.1', 'x1.2.0-rc.6']) {
    assert.throws(()=>makeSnapshotTag({...defaults,version}),/rc.N/);
  }
  for(const utcDate of ['2026-02-30','2026-11-9','2026-13-01']) {
    assert.throws(()=>makeSnapshotTag({...defaults,utcDate}),/real UTC/);
  }
  for(const runId of [0,-1,'abc','1.1']) {
    assert.throws(()=>makeSnapshotTag({...defaults,runId}),/positive integers/);
  }
  assert.throws(()=>makeSnapshotTag({...defaults,runAttempt:0}),/positive integers/);
});

test('workflow runs weekly on default branch and never auto-publishes a release', async () => {
  const {readFileSync} = await import('node:fs');
  const yml=readFileSync(new URL('../.github/workflows/prerelease.yml',import.meta.url),'utf8');
  assert.match(yml,/schedule:\s*\n\s*- cron: '17 6 \* \* 1'/);
  assert.match(yml,/github\.event_name == 'schedule' \|\| inputs\.create_draft/);
  assert.match(yml,/scripts\/release\/snapshot-tag\.mjs/);
  assert.match(yml,/--target "\$GITHUB_SHA" --draft --prerelease/);
  assert.doesNotMatch(yml,/--latest\b/);
  assert.match(yml,/sha256sum --check/);
});
