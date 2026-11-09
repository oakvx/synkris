import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeCommitPrereleaseTag,makeWeeklyReleaseTag} from '../scripts/release/release-tags.mjs';

const version='1.2.0-rc.6';
const shaA='a'.repeat(40);
const shaB='b'.repeat(40);

test('one immutable commit prerelease tag per SHA even without a version bump',()=>{
  assert.equal(makeCommitPrereleaseTag({version,sha:shaA}), 'v1.2.0-rc.6-commit.'+shaA);
  assert.notEqual(makeCommitPrereleaseTag({version,sha:shaA}),makeCommitPrereleaseTag({version,sha:shaB}));
  assert.notEqual(makeCommitPrereleaseTag({version,sha:shaA}),makeCommitPrereleaseTag({version:'1.2.0-rc.7',sha:shaA}));
});

test('weekly Release uses ISO calendar week and remains unique with no new commits',()=>{
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2026-11-09'}), 'v1.2.0-rc.6-weekly.2026w46');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2026-11-15'}), 'v1.2.0-rc.6-weekly.2026w46');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2026-11-16'}), 'v1.2.0-rc.6-weekly.2026w47');
  assert.notEqual(makeWeeklyReleaseTag({version,utcDate:'2026-11-09'}),makeWeeklyReleaseTag({version:'1.2.0-rc.7',utcDate:'2026-11-09'}));
});

test('ISO weeks across New Year do not produce incorrect duplicate weekly tags',()=>{
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2026-12-31'}), 'v1.2.0-rc.6-weekly.2026w53');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2027-01-01'}), 'v1.2.0-rc.6-weekly.2026w53');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2027-01-04'}), 'v1.2.0-rc.6-weekly.2027w01');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2021-01-01'}), 'v1.2.0-rc.6-weekly.2020w53');
  assert.equal(makeWeeklyReleaseTag({version,utcDate:'2021-01-04'}), 'v1.2.0-rc.6-weekly.2021w01');
});

test('version, dates and source SHAs are fail-closed before tag creation',()=>{
  for(const invalid of ['1.2.0','1.2.0-beta.1','v1.2.0-rc.6','1.2.0-rc.']) {
    assert.throws(()=>makeCommitPrereleaseTag({version:invalid,sha:shaA}),/rc.N/);
    assert.throws(()=>makeWeeklyReleaseTag({version:invalid,utcDate:'2026-11-09'}),/rc.N/);
  }
  for(const sha of ['abc','A'.repeat(40),'g'.repeat(40),'0'.repeat(41)]) {
    assert.throws(()=>makeCommitPrereleaseTag({version,sha}),/40-character/);
  }
  for(const utcDate of ['2026-02-30','2026-11-9','2026-13-01','2027-02-29','2026-12-00']) {
    assert.throws(()=>makeWeeklyReleaseTag({version,utcDate}),/real UTC/);
  }
});

test('GitHub Actions regenerates and publishes a prerelease on each master push',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/prerelease.yml',import.meta.url),'utf8');
  assert.match(workflow,/push:\s*\n\s*branches:\s*\n\s*- master/);
  assert.match(workflow,/schedule:\s*\n\s*- cron: '17 6 \* \* 1'/);
  assert.match(workflow,/uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(workflow,/needs: checks/);
  assert.match(workflow,/scripts\/release\/release-tags\.mjs commit/);
  assert.match(workflow,/scripts\/release\/release-tags\.mjs weekly/);
  assert.match(workflow,/--target "\$GITHUB_SHA"/);
  assert.match(workflow,/--prerelease --latest=false/);
  assert.match(workflow,/FLAGS=\(--latest=false\)/);
  assert.match(workflow,/--draft --prerelease --latest=false/);
  assert.match(workflow,/sha256sum --check/);
  assert.match(workflow,/sourceCommit!==process\.env\.GITHUB_SHA/);
  assert.match(workflow,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow,/persist-credentials: false/);
  assert.doesNotMatch(workflow,/cancel-in-progress:\s*true/);
  assert.doesNotMatch(workflow,/^\s*concurrency:/m);
  assert.match(workflow,/TAG_SHA.*GITHUB_SHA/);
  assert.match(workflow,/\.targetCommitish == \$sha/);
  assert.match(workflow,/weekly-release-notes\.md/);
});

test('manual publication defaults to artifact-only; non-master publication is rejected',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/prerelease.yml',import.meta.url),'utf8');
  assert.match(workflow,/default: artifacts-only/);
  assert.match(workflow,/Reject manual publication outside master/);
  for(const mode of ['commit-prerelease','weekly-release','draft-rc']) assert.ok(workflow.includes(mode));
  assert.match(workflow,/refs\/heads\/master/);
});
