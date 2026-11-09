import path from 'node:path';
import {pathToFileURL} from 'node:url';

function checkVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
    throw new Error('Automatic releases require an rc.N package version.');
  }
}

function checkedUtcDate(utcDate) {
  if (typeof utcDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) {
    throw new Error('Date must be a real UTC YYYY-MM-DD.');
  }
  const date = new Date(utcDate + 'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== utcDate) {
    throw new Error('Date must be a real UTC YYYY-MM-DD.');
  }
  return date;
}

// Every pushed commit gets an immutable prerelease tag. Never move an old tag
// to a newer commit: that would invalidate both provenance and SHA256 claims.
export function makeCommitPrereleaseTag({version, sha}) {
  checkVersion(version);
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Commit SHA must be a complete 40-character lowercase git SHA.');
  }
  return `v${version}-commit.${sha}`;
}

// ISO week is stable for Monday's scheduled publication, even if the runner
// starts late. Two runs in the same week must never create two weekly releases.
export function makeWeeklyReleaseTag({version, utcDate}) {
  checkVersion(version);
  const thursday = checkedUtcDate(utcDate);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((Math.floor((thursday - start) / 86400000) + 1) / 7);
  return `v${version}-weekly.${year}w${String(week).padStart(2,'0')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , mode, version, value] = process.argv;
  if (mode === 'commit') console.log(makeCommitPrereleaseTag({version,sha:value}));
  else if (mode === 'weekly') console.log(makeWeeklyReleaseTag({version,utcDate:value}));
  else throw new Error('Usage: release-tags.mjs commit VERSION SHA | weekly VERSION UTC_DATE');
}
