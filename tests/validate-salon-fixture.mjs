// A file-based contract avoids PowerShell 5.1's lossy native stdin encoding and
// legacy quoting of inline JS. This is test tooling, not part of the runtime.
import fs from 'node:fs';
import {assertSalonConfig} from '../src/services/setup-validation.js';
assertSalonConfig(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
