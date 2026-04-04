// loader.cjs (template) — usato dal metodo pkg per caricare app.jsc dallo snapshot
const fs = require('fs'), path = require('path'), os = require('os');
require('bytenode');
try { process.chdir(path.dirname(process.execPath)); } catch {}
const snap = p => path.join(__dirname, p);
const out  = p => { const b=fs.readFileSync(snap(p)); const o=path.join(os.tmpdir(),`wa-${process.pid}-${path.basename(p)}`); fs.writeFileSync(o,b); return o; };
require(out('app.jsc'));
