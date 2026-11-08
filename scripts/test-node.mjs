import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const tests=fs.readdirSync('tests').filter(name=>name.endsWith('.test.js')).sort().map(name=>'tests/'+name);
execFileSync(process.execPath,['--test',...tests],{stdio:'inherit'});
