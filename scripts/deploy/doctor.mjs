import {inspectInstallation} from '../../src/services/installation-doctor.js';
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--json','--container','--help'].includes(arg))) {
  console.error('Uso: node scripts/deploy/doctor.mjs [--json] [--container]');
  process.exitCode = 2;
} else if (args.has('--help')) {
  console.log('Controlli OFFLINE, in sola lettura, senza mostrare credenziali.');
  console.log('Uso: node scripts/deploy/doctor.mjs [--json] [--container]');
} else {
  const report = inspectInstallation({container:args.has('--container')});
  if (args.has('--json')) console.log(JSON.stringify(report,null,2));
  else {
    console.log('synk · diagnostica installazione (offline, nessun dato riservato mostrato)');
    for (const check of report.checks) console.log(`[${{pass:'OK',warn:'NOTA',fail:'DA COMPLETARE'}[check.status]}] ${check.label}\n  ${check.help}`);
    console.log(report.readyForBootstrap ? '\nControlli offline completati. Resta obbligatorio il collaudo reale.' : '\nCompleta i punti indicati e ripeti la diagnostica.');
  }
  process.exitCode = report.readyForBootstrap ? 0 : 1;
}
