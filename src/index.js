import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './storage/data-paths.js';
import { loadAndVerifyLicense, storeLicense, verifyLicenseText } from './licensing/license-utils.js';
import { startAdminServer } from './services/admin-server.js';
import { whatsappOptions, isWhatsAppConnectedState, stopWhatsAppClient } from './services/whatsapp-options.js';
import { log } from './core/util/logger.js';
import { createPgPool } from './storage/postgres.js';
import { reconcileCalendarSagas } from './services/calendar-saga.js';
import { cancelCalendarEvent, createCalendarEvent } from './services/gcal.js';
import { createAndLinkCalendarBooking, updateCalendarBookingSummary } from './services/calendar-outbox-booking.js';
import { count, withTrace } from './observability/metrics.js';
import { createLicenseMonitor } from './licensing/license-monitor.js';
import { createMessageDispatcher } from './services/message-dispatcher.js';
import { createPersistentMessageInbox } from './services/message-inbox.js';
import { runCalendarSync } from './services/reconciliation/runner.js';
import { pruneWaitlist, offerVerifiedSlot } from './services/waitlist/waitlist.js';
import { verifyReleasedSlot } from './services/waitlist/availability.js';
import { patchCalendarSchedule } from './services/gcal.js';
import { drainCalendarOutbox } from './services/calendar-outbox.js';
import { getSalonSettings } from './services/salon-settings.js';
import { isChatPaused, deleteChatData, pruneOldChatMessages } from './services/salon-operations.js';
import { updateCalendarEvent } from './services/gcal.js';
import {createAlertMonitor,sendOperationalAlert,smtpSettings} from './services/anomaly-alerts.js';
import {createMultiBookingConversation} from './services/multi-booking-chat.js';
import {getCalendarClient} from './services/gcal.js';
import {isCalendarPaused} from './services/calendar-maintenance.js';

function validateEnvironment() {
  const required = ['DATABASE_URL', 'CALENDAR_ID', 'ADMIN_TOKEN'];
  const missing = required.filter(key => !process.env[key]?.trim());
  if (!process.env.LICENSE_PUBLIC_KEY_PEM && !process.env.LICENSE_PUBLIC_KEY_FILE) {
    missing.push('LICENSE_PUBLIC_KEY_PEM oppure LICENSE_PUBLIC_KEY_FILE');
  }
  if (!process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_CREDENTIALS_B64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    !fs.existsSync(path.join(DATA_DIR, 'google-credentials.json'))) {
    missing.push('credenziali Google Service Account');
  }
  if (missing.length) throw new Error(`Configurazione mancante: ${missing.join(', ')}`);
  if (process.env.ADMIN_TOKEN.trim().length < 32) throw new Error('ADMIN_TOKEN deve contenere almeno 32 caratteri');
}

async function ensureLicense() {
  // Explicit deployment configuration takes precedence over a previously stored license.
  const text = process.env.LICENSE_TEXT || process.env.LICENSE_CODE;
  const file = process.env.LICENSE_FILE;
  if (text || file) {
    const license = text || fs.readFileSync(file, 'utf8');
    await verifyLicenseText(license);
    await storeLicense(license);
    return;
  }
  try {
    await loadAndVerifyLicense();
    return;
  } catch (error) {
    if (process.env.NODE_ENV === 'production' || !process.stdin.isTTY) throw error;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const lic = (await rl.question('Riga LIC=: ')).trim();
    const sig = (await rl.question('Riga SIG=: ')).trim();
    await storeLicense(`LIC=${lic}\nSIG=${sig}\n`);
  } finally {
    rl.close();
  }
}

async function main() {
  validateEnvironment();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  await ensureLicense();
  // Read non-secret salon settings before importing the legacy facade, whose
  // presentation constants are initialized at module import time.
  const settingsPool = createPgPool();
  try {
    const settings = await getSalonSettings(settingsPool);
    for (const [key, envKey] of [['salon_name','SALON_NAME'],['salon_phone','SALON_PHONE'],['review_url','REVIEW_URL']]) {
      if (settings[key]) process.env[envKey] = settings[key];
    }
  } catch (error) { log('warn','salon_settings_load_failed',{code:error.code||'unavailable'}); }
  finally { await settingsPool.end(); }

  const {
    handleMessage, remind24hTick, resetState, safeSend, getPrivacyText,
    startReviewFollowupsLoop, confirmAppointmentsTick, warmModels, refreshBookingsCache, refreshServicesCache,
  } = await import('./core/util.js');
  const { create, ev } = await import('@open-wa/wa-automate');
  const clientOptions = whatsappOptions();
  fs.mkdirSync(clientOptions.sessionDataPath, { recursive: true, mode: 0o700 });
  if (clientOptions.executablePath && !fs.existsSync(clientOptions.executablePath)) {
    throw new Error('Eseguibile Chrome configurato non trovato');
  }

  const status = { startedAt:Date.now(), online: false, qrDataUrl: null, qrUpdatedAt: 0, dbOnline: false, lastError: null, lastCalendarRecoveryAt: null, lastInboundSyncAt: null, lastInboundSyncStatus: 'disabled', queueSnapshot: null };
  const actions = { sendText: null };
  const server = await startAdminServer(status, actions);
  let client;
  const timers = [];
  let closing = false;
  const inflightMessages = new Set();
  let stopReviewLoop = () => {};
  const recoveryPool = createPgPool();
  const messageInbox = createPersistentMessageInbox(recoveryPool);
  status.dbPool = recoveryPool; // Only available behind administrative token auth.
  const checkDatabase = async () => {
    try {
      await recoveryPool.query({ text: 'SELECT 1', query_timeout: 3000 });
      status.dbOnline = true;
    } catch (error) {
      status.dbOnline = false;
      count('database_healthcheck_failed');
      log('warn', 'database_healthcheck_failed', { code: error?.code || 'unavailable' });
    }
  };
  await checkDatabase();
  timers.push(setInterval(() => { void checkDatabase(); }, 30_000));
  // Manual changes performed by the dashboard must be reflected in bot availability.
  timers.push(setInterval(() => {
    if (status.dbOnline) void refreshBookingsCache().catch(error =>
      log('warn','bookings_cache_refresh_failed',{code:error.code||'unavailable'}));
  },60_000));
  // External notifications are disabled unless SMTP is explicitly configured by the salon.
  // They contain only status codes; they never carry bookings, phone numbers or chat data.
  let emailAlertConfig=null;
  try {emailAlertConfig=smtpSettings();}
  catch(error){log('warn','alert_email_not_configured',{code:'invalid_smtp'});}
  const monitorAlerts=createAlertMonitor({state:status,
    send:alert=>sendOperationalAlert(alert,emailAlertConfig),logger:log});
  const runAlertCheck=async()=>{
    if(!emailAlertConfig)return;
    let attention=false;
    if(status.dbOnline)try{
      const r=await recoveryPool.query(`SELECT EXISTS(SELECT 1 FROM public.calendar_outbox
        WHERE status='attention') AS pending_attention`);
      attention=!!r.rows[0]?.pending_attention;
    }catch{ /* database failures monitored separately */ }
    await monitorAlerts({attention});
  };
  timers.push(setInterval(()=>{void runAlertCheck().catch(()=>{});},60_000));
  timers.push(setInterval(() => {
    void Promise.all([refreshServicesCache(),import('./services/gcal.js').then(m=>m.ensureRuntimeConfig(true))])
      .catch(error=>log('warn','salon_config_reload_failed',{code:error.code||'unavailable'}));
  },90_000));

  let recoveryRunning = false;
  const recoverCalendar = async () => {
    if (recoveryRunning || isCalendarPaused()) return;
    recoveryRunning = true;
    try {
      const recovered = await reconcileCalendarSagas({ db: recoveryPool, cancelEvent: cancelCalendarEvent, logger: log });
      status.lastCalendarRecoveryAt = new Date().toISOString();
      if (recovered.repaired) count('calendar_events_compensated', recovered.repaired);
      if (recovered.needsAttention) count('calendar_sagas_attention_required', recovered.needsAttention);
    } catch (error) {
      log('warn', 'calendar_saga_recovery_failed', { code: error?.code || 'unknown' });
    } finally {
      recoveryRunning = false;
    }
  };
  let syncRunning = false;
  const inboundSync = async () => {
    if (syncRunning || isCalendarPaused() || process.env.CALENDAR_INBOUND_SYNC !== '1') return;
    syncRunning = true;
    try {
      const result = await runCalendarSync(recoveryPool, { logger: log });
      status.lastInboundSyncAt = new Date().toISOString();
      status.lastInboundSyncStatus = result.status;
      if (result.counts?.conflict) count('calendar_inbound_conflicts', result.counts.conflict);
      if (result.counts?.applied) {
        await refreshBookingsCache();
        count('calendar_inbound_applied', result.counts.applied);
      }
    } catch (error) {
      status.lastInboundSyncStatus = 'error';
      count('calendar_inbound_failed');
      log('warn', 'calendar_inbound_sync_failed', { code: error.code || 'unavailable' });
    } finally { syncRunning = false; }
  };
  const shutdown = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    status.online = false;
    actions.sendText = null;
    timers.forEach(clearInterval);
    stopReviewLoop();
    server.close();
    // Allow a running booking transaction to finish before closing the browser.
    // Calendar saga journaling covers crashes after this bounded drain window.
    const deadline = setTimeout(() => process.exit(exitCode), 20_000);
    deadline.unref();
    await Promise.race([
      Promise.allSettled([...inflightMessages]),
      new Promise(resolve => setTimeout(resolve, 12_000)),
    ]);
    try { await stopWhatsAppClient(client); } catch { }
    try { await recoveryPool.end(); } catch { }
    process.exit(exitCode);
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('uncaughtException', error => {
    log('error', 'Errore fatale', { error: error.message });
    void shutdown(1);
  });
  process.once('unhandledRejection', error => {
    log('error', 'Promise non gestita', { error: error?.message || 'unknown' });
    void shutdown(1);
  });

  // OpenWA emette il QR prima che create() completi l'associazione. Solo RAM,
  // niente QR/sessioni su disco o log. L'API amministrativa richiede il token.
  ev.on('qr.**', (qr) => {
    const value = typeof qr === 'string' ? qr : '';
    if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length < 200000) {
      status.qrDataUrl = value;
      status.qrUpdatedAt = Date.now();
    }
  });
  ev.on('client.ready', () => { status.qrDataUrl = null; status.qrUpdatedAt = 0; });

  try {
    // Warm-up is optional and should not prevent QR authentication or health checks.
    void warmModels().catch(() => log('warn', 'Warm-up modelli AI non disponibile'));
    client = await create(clientOptions);
    const sendText = (to, message) => safeSend(client, to, message);
    const multiBooking = createMultiBookingConversation({db:recoveryPool,send:sendText,
      calendarClient:getCalendarClient,privacyText:getPrivacyText});
    actions.sendText = (to, message) => client.sendText(to, message);
    status.online = true;
    status.qrDataUrl = null;
    log('info', 'WhatsApp pronto');
    void recoverCalendar();
    void inboundSync();
    timers.push(setInterval(() => { void inboundSync(); }, 2 * 60_000));
    timers.push(setInterval(() => { void pruneWaitlist(recoveryPool).catch(() => count('waitlist_prune_failed')); }, 60*60_000));
    const retentionDays=Number(process.env.CHAT_RETENTION_DAYS||90);
    if(!Number.isInteger(retentionDays)||retentionDays<7||retentionDays>730)
      throw new Error('CHAT_RETENTION_DAYS deve essere compreso tra 7 e 730');
    const pruneChats=()=>pruneOldChatMessages(recoveryPool,retentionDays)
      .catch(error=>log('warn','chat_retention_failed',{code:error.code||'unavailable'}));
    void pruneChats();
    timers.push(setInterval(()=>void pruneChats(),24*60*60_000));
    if (process.env.CALENDAR_OUTBOX_ENABLED === '1') {
      const offerReleasedSlot = async ({start,end,professionalId,serviceId}) => {
        if (!status.online || !actions.sendText || Date.parse(start) <= Date.now()) return;
        const result=await recoveryPool.query(`SELECT email FROM public.professional_emails
          WHERE professional_id=$1 ORDER BY email LIMIT 1`,[professionalId]);
        const email=result.rows[0]?.email;
        if (!email)return;
        await offerVerifiedSlot({db:recoveryPool,start,end,professionalId,serviceId,
          verifyAvailability:()=>verifyReleasedSlot({db:recoveryPool,start,end,professionalId,professionalEmail:email}),
          notify:(to,message)=>actions.sendText(to,message)});
      };
      const workOutbox = () => isCalendarPaused() ? Promise.resolve({processed:0,done:0,attention:0}) : drainCalendarOutbox({ pool: recoveryPool, cancel: cancelCalendarEvent,
        update: job => job.payload?.appointmentId ?
        updateCalendarBookingSummary({pool:recoveryPool,job,getCalendarClient}) :
        updateCalendarEvent({...job.payload,eventId:job.event_id,calendarId:job.calendar_id}),
        reschedule: patchCalendarSchedule,
        create: job => createAndLinkCalendarBooking({ pool: recoveryPool, job, createEvent: createCalendarEvent }),
        onCancelled:offerReleasedSlot,logger: log }).then(result => { if(result.done) count('calendar_outbox_done',result.done); })
        .catch(error => log('warn','calendar_outbox_failed',{code:error.code||'unavailable'}));
      void workOutbox();
      timers.push(setInterval(() => { void workOutbox(); }, 60_000));
    }
    timers.push(setInterval(() => { void recoverCalendar(); }, 2 * 60_000));

    timers.push(setInterval(() => {
      // Alcune versioni di OpenWA espongono getState() asincrono.
      Promise.resolve(client.getState())
        .then(state => { status.online = isWhatsAppConnectedState(state); })
        .catch(() => { status.online = false; });
    }, 15_000));
    const licenseCheckMinutes = Number(process.env.LICENSE_CHECK_INTERVAL_MINUTES || 15);
    if (!Number.isFinite(licenseCheckMinutes) || licenseCheckMinutes < 1 || licenseCheckMinutes > 1440) {
      throw new Error('LICENSE_CHECK_INTERVAL_MINUTES deve essere compreso tra 1 e 1440');
    }
    const monitor = createLicenseMonitor({
      readLicense: async () => {
        const configured = process.env.LICENSE_TEXT || process.env.LICENSE_CODE;
        if (configured) return configured;
        if (process.env.LICENSE_FILE) return fs.readFileSync(process.env.LICENSE_FILE, 'utf8');
        const saved = await loadAndVerifyLicense();
        return fs.readFileSync(saved.file, 'utf8');
      },
      verify: verifyLicenseText,
      outageGraceMs: Number(process.env.LICENSE_READ_GRACE_MINUTES || 10) * 60_000,
    });
    await monitor.check();
    status.licenseStatus = monitor.snapshot().status;
    timers.push(setInterval(() => {
      monitor.check().then(result => {
        status.licenseStatus = monitor.snapshot().status;
        if (result.degraded) log('warn', 'license_storage_temporarily_unavailable');
      }).catch(error => {
        count('license_verification_failed');
        log('error', 'Licenza non valida durante il funzionamento', { code: error?.code || 'invalid_license' });
        void shutdown(1);
      });
    }, licenseCheckMinutes * 60_000));
    timers.push(setInterval(() => {
      if (isCalendarPaused()) return;
      remind24hTick(sendText, { graceMinutes: 10, batchLimit: 200 })
        .catch(error => log('warn', 'Promemoria 24h fallito', { error: error.message }));
    }, 60_000));
    stopReviewLoop = startReviewFollowupsLoop(client, {
      intervalMinutes: 30, lookbackDays: 3, minAfterEndMinutes: 15,
      batchLimit: 20, alignToHalfHour: true, isSuspended:isCalendarPaused,
    });
    const confirmOpts = {
      leadMinutes: Number(process.env.CONFIRM_LEAD_MINUTES || 180),
      windowMinutes: 15, batchLimit: 50,
    };
    const confirm = () => isCalendarPaused() ? Promise.resolve(0) : confirmAppointmentsTick(sendText, confirmOpts)
      .catch(error => log('warn', 'Promemoria conferma fallito', { error: error.message }));
    void confirm();
    timers.push(setInterval(confirm, 15 * 60_000));

    const dispatcher = createMessageDispatcher({ inbox: messageInbox, handle: message => withTrace(async () => {
      try {
        count('whatsapp_messages_received');
        if (!message || message.isGroupMsg || message.fromMe) return;
        const chatId = message.from;
        const text = (message.body || message.caption || '').trim();
        if (!text) return;
        if (/^\s*(?:privacy|informativa)\s*$/i.test(text)) {
          await sendText(chatId,getPrivacyText(chatId));return;
        }
        if (/^\s*(?:cancella\s+dati|elimina\s+dati|delete\s+my\s+data)\s*$/i.test(text)) {
          resetState(chatId);
          multiBooking.cancel(chatId);
          try {
            await sendText(chatId,'Procedo con la cancellazione della cronologia della conversazione dal PC del salone. Gli appuntamenti e gli eventi su WhatsApp o Google Calendar non vengono cancellati automaticamente: contatta il salone per ulteriori richieste.');
          } finally {
            await deleteChatData(recoveryPool,chatId);
          }
          return;
        }
        // Operator handoff: ALL automated responses are suppressed, including 'reset'.
        if (await isChatPaused(recoveryPool, chatId)) {count('operator_handoff_skipped');return;}
        if (/^\s*(annulla|reset|stop|ricomincia)\s*$/i.test(text)) {
          resetState(chatId);
          multiBooking.cancel(chatId);
          await sendText(chatId, 'Operazione annullata. Scrivi "prenota" per ricominciare.');
          return;
        }
        if (isCalendarPaused()) {
          await sendText(chatId,'Le prenotazioni automatiche sono temporaneamente sospese per un controllo dell’agenda. Contatta il salone.');
          return;
        }
        if (process.env.MULTI_BOOKING_WHATSAPP_ENABLED==='1' &&
            await multiBooking.handle(chatId,text)){
          count('whatsapp_multi_booking_messages');return;
        }
        await handleMessage(client, chatId, text);
        count('whatsapp_messages_processed');
      } catch (error) {
        count('whatsapp_messages_failed');
        status.lastError = error?.message || 'message_failed';
        log('error', 'Gestione messaggio fallita');
        try { await sendText(message.from, 'Errore temporaneo. Riprova.'); } catch { }
        throw error;
      }
      }) });
    status.queueSnapshot = dispatcher.snapshot;
    // Cleanup operates only on hashed completed IDs, never message contents.
    timers.push(setInterval(() => {
      void messageInbox.prune().catch(error =>
        log('warn', 'message_inbox_prune_failed', { code: error?.code || 'unavailable' }));
    }, 24 * 60 * 60_000));
    client.onMessage(message => {
      if (closing) return;
      const task = dispatcher.submit(message);
      inflightMessages.add(task);
      void task.then(result => {
        if (result.reason === 'duplicate') count('whatsapp_messages_duplicate');
        if (result.reason === 'queue_full' || result.reason === 'at_capacity') {
          count('whatsapp_messages_backpressure');
          log('warn', 'whatsapp_message_backpressure', { reason: result.reason });
        }
      }).catch(error => log('error', 'whatsapp_dispatch_error', { code: error?.code || 'unknown' }))
        .finally(() => inflightMessages.delete(task));
      return task;
    });
  } catch (error) {
    log('error', 'Avvio WhatsApp fallito', { error: error.message });
    await shutdown(1);
  }
}

main().catch(error => {
  log('error', 'Avvio fallito', { error: error.message });
  process.exit(1);
});
