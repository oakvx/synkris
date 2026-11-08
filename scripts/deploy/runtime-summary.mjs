import {collectRuntimeSummary} from '../../src/services/support-summary.js';
try { console.log(JSON.stringify(await collectRuntimeSummary())); }
catch { console.log(JSON.stringify({schema:1,scope:'runtime-status',error:'runtime_unavailable'}));process.exitCode = 1; }
