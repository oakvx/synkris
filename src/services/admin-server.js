import { salonSnapshot, topServices } from './analytics.js';
import { getSalonSettings, setSalonSetting } from './salon-settings.js';
import { addToWaitlist, withdrawFromWaitlist, listWaitlistOptions } from './waitlist/waitlist.js';
import { getMetrics } from '../observability/metrics.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {assertChatId, isChatPaused, setChatPaused, listChats, listMessages, listIncidents, deleteChatData, readHoursPlan, replaceHoursPlan, readClientDetails, writeClientNote, readAbsences, saveAbsence, deleteAbsence, listProfessionals, searchClients, updatePrivacyRequest} from './salon-operations.js';
import {resolveOllamaBase,isAIEnabled} from '../ai/ollama-client.js';
import express from 'express';
import {checkCalendarSlot} from './calendar-guard.js';
import {getCalendarClient} from './gcal.js';
import {isCalendarPaused} from './calendar-maintenance.js';

function tokenMatches(actual, expected) {
  const a = crypto.createHash('sha256').update(actual).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createAdminApp(state, actions, { token = process.env.ADMIN_TOKEN, origins = process.env.ADMIN_ALLOWED_ORIGINS || '' } = {}) {
  if (typeof token !== 'string' || token.trim().length < 32) {
    throw new Error('ADMIN_TOKEN deve contenere almeno 32 caratteri');
  }
  const allowedOrigins = new Set(origins.split(',').map(s => s.trim()).filter(Boolean));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // /health verifica solo il processo; /ready segnala se WhatsApp e' davvero operativo.
  app.get('/health', (_req, res) => res.type('text').send('OK'));
  app.get('/ready', (_req, res) => {
    const ready = Boolean(state.online) && state.dbOnline !== false;
    res.status(ready ? 200 : 503).json({ ready });
  });

  const bucket = new Map();
  app.use((req, res, next) => {
    const now = Date.now();
    for (const [key, value] of bucket) if (now - value.ts >= 60_000) bucket.delete(key);
    // The socket address cannot be spoofed with X-Forwarded-For.
    const ip = req.socket.remoteAddress || 'unknown';
    if (!bucket.has(ip) && bucket.size >= 10_000) return res.sendStatus(429);
    const previous = bucket.get(ip);
    const entry = !previous || now - previous.ts >= 60_000
      ? { count: 0, ts: now }
      : previous;
    entry.count++;
    bucket.set(ip, entry);
    if (entry.count > 60) return res.sendStatus(429);
    if (!tokenMatches(String(req.headers['x-admin-token'] || ''), token)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  });
  app.use(express.json({ limit: '50kb' }));
  app.get('/status', (_req, res) => res.json({ online: Boolean(state.online), hasError: Boolean(state.lastError) }));
  app.get('/metrics', (_req, res) => res.json({ counters: getMetrics(), online: Boolean(state.online) }));
  app.get('/api/session/qr', (_req, res) => {
    const age = Date.now() - Number(state.qrUpdatedAt || 0);
    const fresh = Number.isFinite(age) && age >= 0 && age < 20_000;
    res.json({ connected: Boolean(state.online), qr: !state.online && fresh ? state.qrDataUrl : null });
  });
  app.get('/diagnostics', (_req, res) => res.json({
    whatsappReady: Boolean(state.online),
    databaseReady: state.dbOnline !== false,
    licenseStatus: state.licenseStatus || 'unknown',
    lastCalendarRecoveryAt: state.lastCalendarRecoveryAt || null,
    lastInboundSyncAt: state.lastInboundSyncAt || null,
    lastInboundSyncStatus: isCalendarPaused()?'suspended_for_reconciliation':(state.lastInboundSyncStatus || 'disabled'),
    calendarMaintenance: isCalendarPaused(),
    messages: typeof state.queueSnapshot === 'function' ? state.queueSnapshot() : null,
    metrics: getMetrics(),
    aiConfigured: isAIEnabled(),
    aiIntentConfigured: process.env.AI_INTENT_ENABLED === '1',
  }));

  // Internal authenticated gate for dashboard booking writes: never confirm if
  // Calendar is unreachable, misconfigured or contains external busy events.
  app.post('/api/calendar/check-slot', async(req,res)=>{
    if(!state.dbPool)return res.status(503).json({error:'database_unavailable'});
    if(isCalendarPaused())return res.status(503).json({error:'calendar_reconciliation_required'});
    try{
      const calendar=await getCalendarClient();
      const result=await checkCalendarSlot({db:state.dbPool,calendar,request:req.body,
        defaultCalendarId:process.env.CALENDAR_ID});
      res.status(result.available?200:409).json(result);
    }catch(error){
      const code=error instanceof TypeError?400:(error.status===404||error.status===422?error.status:503);
      res.status(code).json({error:code===503?'calendar_unavailable':error.message});
    }
  });

  // Authenticated operational API; never exposes clients or conversation contents.
  app.get('/api/analytics', async (req, res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try { const [months,services] = await Promise.all([salonSnapshot(state.dbPool,{months:req.query.months}),topServices(state.dbPool,{months:req.query.months})]); res.json({months,services}); }
    catch { res.status(503).json({error:'analytics_unavailable'}); }
  });
  app.get('/api/settings', async (_req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try { res.json({settings: await getSalonSettings(state.dbPool)}); }
    catch { res.status(503).json({error:'settings_unavailable'}); }
  });
  app.put('/api/settings', async (req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try { await setSalonSetting(state.dbPool,req.body?.key,req.body?.value);res.json({ok:true}); }
    catch (error) { res.status(error.message==='Invalid salon setting'?400:503).json({error:'settings_update_failed'}); }
  });
  app.get('/api/waitlist/options', async(_req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try {res.json(await listWaitlistOptions(state.dbPool));}
    catch {res.status(503).json({error:'waitlist_options_unavailable'});}
  });
  app.post('/api/waitlist/opt-in', async(req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try {
      const requestId = await addToWaitlist(state.dbPool,{chatId:req.body?.chatId,
        earliestAt:req.body?.earliestAt,latestAt:req.body?.latestAt,
        serviceId:req.body?.serviceId,professionalId:req.body?.professionalId,
        consent:req.body?.consent});
      res.status(201).json({requestId});
    } catch { res.status(400).json({error:'waitlist_request_invalid'}); }
  });
  app.post('/api/waitlist/withdraw', async(req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try { const count = await withdrawFromWaitlist(state.dbPool,req.body?.chatId);res.json({withdrawn:count}); }
    catch {res.status(503).json({error:'waitlist_unavailable'});}
  });

  app.get('/api/schedule',async(_req,res)=>{
    try{res.json(await readHoursPlan(state.dbPool));}catch{res.status(503).json({error:'schedule_unavailable'});}
  });
  app.put('/api/schedule',async(req,res)=>{
    try{res.json(await replaceHoursPlan(state.dbPool,req.body));}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'schedule_update_failed'});}
  });
  app.get('/api/absences', async (_req,res)=>{
    try{const [absences,professionals]=await Promise.all([readAbsences(state.dbPool),listProfessionals(state.dbPool)]);
      res.json({absences,professionals});}
    catch {res.status(503).json({error:'absences_unavailable'});}
  });
  app.post('/api/absences', async (req,res)=>{
    try{res.status(201).json(await saveAbsence(state.dbPool,{professionalId:Number(req.body?.professionalId),
      startDay:req.body?.startDay,endDay:req.body?.endDay}));}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'absence_invalid'});}
  });
  app.post('/api/absences/delete', async (req,res)=>{
    try{res.json(await deleteAbsence(state.dbPool,Number(req.body?.id)));}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'absence_delete_failed'});}
  });
  app.get('/api/clients/search',async(req,res)=>{
    try{res.json({clients:await searchClients(state.dbPool,String(req.query.q||''))});}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'clients_search_unavailable'});}
  });
  app.get('/api/client',async(req,res)=>{
    try{const client=await readClientDetails(state.dbPool,Number(req.query.id));
      if(!client)return res.status(404).json({error:'not_found'});res.json({client});}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'client_unavailable'});}
  });
  app.put('/api/client/note',async(req,res)=>{
    try{res.json(await writeClientNote(state.dbPool,Number(req.body?.id),req.body?.note));}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'client_note_failed'});}
  });
  app.get('/api/operations', async (_req,res) => {
    if (!state.dbPool) return res.status(503).json({error:'database_unavailable'});
    try {
      const incidents = await listIncidents(state.dbPool);
      const backlog = await state.dbPool.query(`SELECT status,count(*)::integer AS count
        FROM public.calendar_outbox WHERE status IN ('pending','attention') GROUP BY status`);
      res.json({incidents,backlog:backlog.rows,lastSync:state.lastInboundSyncAt,
        syncStatus:isCalendarPaused()?'suspended_for_reconciliation':state.lastInboundSyncStatus,
        calendarMaintenance:isCalendarPaused(),whatsapp:!!state.online,database:state.dbOnline});
    } catch {res.status(503).json({error:'operations_unavailable'});}
  });
  app.post('/api/privacy/request/review',async(req,res)=>{
    try{res.json(await updatePrivacyRequest(state.dbPool,Number(req.body?.requestId),req.body?.status));}
    catch(e){res.status(e instanceof TypeError?400:503).json({error:'privacy_update_failed'});}
  });
  app.get('/api/chats', async (_req,res) => {
    try {res.json({chats:await listChats(state.dbPool)});}
    catch {res.status(503).json({error:'chats_unavailable'});}
  });
  app.get('/api/messages', async (req,res) => {
    try {res.json({messages:await listMessages(state.dbPool,req.query.chatId)});}
    catch (error) {res.status(error instanceof TypeError?400:503).json({error:'messages_unavailable'});}
  });
  app.post('/api/handoff', async(req,res) => {
    try {res.json({ok:true,...await setChatPaused(state.dbPool,req.body?.chatId,req.body?.paused)});}
    catch(error) {res.status(error instanceof TypeError?400:503).json({error:'handoff_failed'});}
  });
  app.post('/api/chats/delete', async(req,res) => {
    try {await deleteChatData(state.dbPool,req.body?.chatId);res.json({ok:true});}
    catch(error) {res.status(error instanceof TypeError?400:503).json({error:'delete_failed'});}
  });
  app.get('/api/ai', async (_req,res) => {
    if (!isAIEnabled()) return res.json({enabled:false,intent:false,info:false});
    try {
      const base=resolveOllamaBase();
      const ctl=new AbortController();const timeout=setTimeout(()=>ctl.abort(),3000);
      try {
        const response=await fetch(base+'/api/tags',{signal:ctl.signal,redirect:'error'});
        if (!response.ok) throw new Error('ollama_unavailable');
        const names=new Set((await response.json()).models?.map(x=>x.name)||[]);
        const present=model=>Boolean(model)&&[...names].some(name=>name===model||name===model+':latest');
        res.json({enabled:true,available:true,
          intent:process.env.AI_INTENT_ENABLED==='1' && present(process.env.OLLAMA_INTENT_MODEL),
          info:present(process.env.OLLAMA_MODEL),models:[...names].slice(0,20)});
      } finally {clearTimeout(timeout);}
    } catch {res.json({enabled:true,available:false,intent:false,info:false});}
  });
  app.get('/api/backups', (_req,res) => {
    try {
      const base=path.resolve(process.env.BACKUP_DIR || '/app/runtime/backups');
      const entries=fs.readdirSync(base).filter(n=>/^synk-\d{8}-\d{6}\.dump$/.test(n))
        .map(n=>({name:n,size:fs.statSync(path.join(base,n)).size}))
        .filter(x=>x.size>0).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,30);
      res.json({backups:entries});
    } catch {res.status(503).json({error:'backup_unavailable'});}
  });
  app.get('/api/backups/download', (req,res) => {
    const name=String(req.query.name||'');
    if (!/^synk-\d{8}-\d{6}\.dump$/.test(name)) return res.sendStatus(400);
    const filename=path.join(path.resolve(process.env.BACKUP_DIR || '/app/runtime/backups'),name);
    try {const info=fs.statSync(filename);if(!info.isFile()||info.size<1)return res.sendStatus(404);
      res.setHeader('Content-Type','application/octet-stream');
      res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
      fs.createReadStream(filename).on('error',()=>res.destroy()).pipe(res);
    } catch {res.sendStatus(404);}
  });
  app.post('/api/send', async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const rawMessage = req.body?.message ?? req.body?.msg;
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    if (!/^\d{5,20}@c\.us$/i.test(to)) return res.status(400).json({ ok: false, error: 'invalid_to_format' });
    if (!message) return res.status(400).json({ ok: false, error: 'missing_message' });
    if (message.length > 4000) return res.status(413).json({ ok: false, error: 'message_too_long' });
    if (!state.online || typeof actions?.sendText !== 'function') return res.status(503).json({ ok: false, error: 'client_not_ready' });
    try {
      // Only explicit operator takeover pauses the bot. Booking notifications must not.
      if (req.body?.handoff === true) await setChatPaused(state.dbPool, to, true);
      await actions.sendText(to, message);
      let recorded = true;
      try {
        await state.dbPool.query(`INSERT INTO public.chat_sessions(chat_id,lang,last_active_at)
          VALUES($1,'it',now()) ON CONFLICT(chat_id) DO UPDATE SET last_active_at=now()`,[to]);
        await state.dbPool.query(`INSERT INTO public.chat_messages(chat_id,direction,body)
          VALUES($1,'out',$2)`,[to,message]);
      } catch { recorded = false; }
      // A delivered message remains delivered even when history recording failed.
      return res.json({ ok: true, recorded });
    } catch (error) {
      if (error?.code === 'WHATSAPP_NOT_READY') return res.status(503).json({ ok: false, error: 'client_not_ready' });
      return res.status(502).json({ ok: false, error: error?.outcome === 'unknown' ? 'delivery_unknown' : 'send_failed' });
    }
  });
  app.use((err, _req, res, _next) => {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ ok: false, error: status === 413 ? 'body_too_large' : 'invalid_json' });
  });
  return app;
}

export async function startAdminServer(state, actions) {
  const port = Number(process.env.ADMIN_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_PORT non valida');
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  const app = createAdminApp(state, actions);
  return await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
