import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir} from '../storage/data-paths.js';
/** Technician-only maintenance flag, never synchronized or sent outside the PC. */
export function calendarPauseFile(env=process.env,cwd=process.cwd()) {
 return path.join(resolveDataDir(env,cwd),'calendar-reconciliation-required.flag');
}
export function isCalendarPaused(env=process.env,cwd=process.cwd()){
 return fs.existsSync(calendarPauseFile(env,cwd));
}
