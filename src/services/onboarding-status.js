import {readBackupStatus} from './backup-status.js';

export function buildOnboardingStatus({state = {}, catalog = null, backup = {status:'missing'}, calendarPaused = false, now = Date.now()} = {}) {
  const steps = [];
  const add = (id,status,title,help,page = null) => steps.push({id,status,title,help,page});
  const db = state.dbOnline === true;
  add('database',db ? 'done' : state.dbOnline === false ? 'attention' : 'unknown','Database locale',db ? 'PostgreSQL risponde al controllo del processo.' : 'Apri INSTALLA_UNA_VOLTA e usa la diagnostica. Non modificare o eliminare i volumi Docker.');
  const counts = catalog && ['services','professionals','assignments','opening_days','unassigned_services'].every(key => catalog[key] !== null && catalog[key] !== undefined && Number.isInteger(Number(catalog[key])) && Number(catalog[key]) >= 0);
  const configured = counts && Number(catalog.services) > 0 && Number(catalog.professionals) > 0 && Number(catalog.assignments) > 0 && Number(catalog.opening_days) > 0 && Number(catalog.unassigned_services) === 0;
  add('catalog',!counts || !db ? 'unknown' : configured ? 'done' : 'todo','Team, trattamenti e orari',configured && db ? 'Esistono trattamenti attivi abilitati al team e almeno un giorno di apertura.' : 'Controlla Trattamenti e team e Orari e assenze. Ogni trattamento attivo deve avere almeno una persona abilitata.','catalog');
  add('whatsapp',state.online === true ? 'done' : 'todo','Collega WhatsApp',state.online === true ? 'Il provider segnala la sessione pronta. Il collaudo di ricezione e invio resta necessario.' : 'Apri Conversazioni, poi sul telefono WhatsApp > Dispositivi collegati > Collega un dispositivo. Il QR resta riservato.','chats');
  const syncAt = typeof state.lastInboundSyncAt === 'number' ? state.lastInboundSyncAt : Date.parse(state.lastInboundSyncAt);
  const fresh = Number.isFinite(syncAt) && syncAt <= now && now - syncAt <= 6 * 60000;
  const synced = !calendarPaused && state.lastInboundSyncStatus === 'ok' && fresh;
  add('calendar',calendarPaused ? 'attention' : synced ? 'done' : 'todo','Sincronizzazione Google Calendar',calendarPaused ? 'Prenotazioni sospese: serve riconciliazione tecnica. Non rimuovere il blocco per forzare l\'avvio.' : synced ? 'Una sincronizzazione entrante recente e riuscita. Creazione, modifica e annullamento richiedono comunque il collaudo.' : 'Prima collega WhatsApp; poi verifica la condivisione dei calendari con il service account e attendi una sincronizzazione riuscita.','overview');
  add('backup',backup.status === 'recent' ? 'done' : ['stale','invalid','unavailable'].includes(backup.status) ? 'attention' : 'todo','Backup locale recente',backup.status === 'recent' ? 'Rilevato un file PostgreSQL recente. Non prova integrita completa, ripristino o presenza di una copia esterna cifrata.' : backup.status === 'stale' ? 'L\'ultimo file di backup ha piu di 36 ore. Lascia il PC acceso e verifica il servizio backup con il tecnico.' : 'Nessun backup recente utilizzabile rilevato. Controlla il servizio backup e pianifica una prova di ripristino.','settings');
  const completed = steps.filter(step => step.status === 'done').length;
  return {schema:1,checkedAt:new Date(now).toISOString(),completed,total:steps.length,automaticChecksComplete:completed === steps.length,productionReady:false,
    nextStep:steps.find(step => step.status !== 'done')?.id || null,steps};
}

export async function readOnboardingStatus({state, calendarPaused = false, backupDirectory, now = Date.now()} = {}) {
  let catalog = null;
  if (state?.dbOnline === true && state.dbPool) try {
    const result = await state.dbPool.query({text:`SELECT
      (SELECT count(*) FROM public.services WHERE is_active) AS services,
      (SELECT count(*) FROM public.professionals WHERE is_active) AS professionals,
      (SELECT count(*) FROM public.professional_services ps JOIN public.services s USING(service_id)
        JOIN public.professionals p USING(professional_id) WHERE s.is_active AND p.is_active) AS assignments,
      (SELECT count(*) FROM public.salon_business_hours WHERE NOT is_closed AND open_time IS NOT NULL AND close_time > open_time) AS opening_days,
      (SELECT count(*) FROM public.services s WHERE s.is_active AND NOT EXISTS(
        SELECT 1 FROM public.professional_services ps JOIN public.professionals p USING(professional_id)
        WHERE ps.service_id=s.service_id AND p.is_active)) AS unassigned_services`,query_timeout:3000});
    catalog = result.rows[0];
  } catch { /* Unknown is not success; SQL/provider details never reach the UI. */ }
  return buildOnboardingStatus({state,catalog,calendarPaused,now,backup:readBackupStatus({directory:backupDirectory,now})});
}
