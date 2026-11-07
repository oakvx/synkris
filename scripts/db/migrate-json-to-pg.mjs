import 'dotenv/config';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createPgPool } from '../../src/storage/postgres.js';
import { DATA_DIR } from '../../src/storage/data-paths.js';

const pool = createPgPool();
let transactionClient;

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`JSON non leggibile o non valido: ${path.basename(file)}`);
  }
}

function isoWeekdayFromAny(k) {
  const n = Number(k);
  if (Number.isFinite(n) && n >= 1 && n <= 7) return n;
  return null;
}

function asTimePair(spec) {
  // spec può essere ["09:00","17:00"] o array multiplo (supporto minimo)
  if (!spec) return null;
  if (Array.isArray(spec) && spec.length === 2 && typeof spec[0] === 'string') return spec;
  return null;
}

async function q(text, params) {
  return (transactionClient || pool).query(text, params);
}

async function ensureProfessional(email, nameFallback = null) {
  const e = String(email || '').trim();
  if (!e) throw new Error('professionalEmail mancante');

  // 1) prova a trovare via professional_emails
  const found = await q(
    `SELECT p.professional_id, p.full_name
     FROM public.professional_emails pe
     JOIN public.professionals p ON p.professional_id = pe.professional_id
     WHERE pe.email = $1`,
    [e]
  );
  if (found.rows[0]) return found.rows[0].professional_id;

  // 2) crea professionista + email
  const name = (nameFallback && String(nameFallback).trim())
    ? String(nameFallback).trim()
    : e.split('@')[0].replace(/[._-]+/g, ' ').trim();

  const ins = await q(
    `INSERT INTO public.professionals(full_name)
     VALUES ($1)
     RETURNING professional_id`,
    [name]
  );
  const professionalId = ins.rows[0].professional_id;

  await q(
    `INSERT INTO public.professional_emails(professional_id, email)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET professional_id = EXCLUDED.professional_id`,
    [professionalId, e]
  );

  return professionalId;
}

async function ensureService(serviceName, durationMin, price = null, materialsCost = null) {
  const s = String(serviceName || '').trim();
  if (!s) throw new Error('serviceName mancante');

  const dur = Number(durationMin);
  const durOk = Number.isFinite(dur) && dur > 0 ? Math.trunc(dur) : 30;

  const res = await q(
    `INSERT INTO public.services(service_name, default_duration_min, price, materials_cost)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (service_name) DO UPDATE
       SET default_duration_min = EXCLUDED.default_duration_min,
           price = COALESCE(EXCLUDED.price, public.services.price),
           materials_cost = COALESCE(EXCLUDED.materials_cost, public.services.materials_cost)
     RETURNING service_id`,
    [s, durOk, price, materialsCost]
  );

  return res.rows[0].service_id;
}

async function ensureClient(phone, fullName = null, whatsappChatId = null) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) throw new Error('clientPhone mancante');

  // 1) trova via contatto phone
  const found = await q(
    `SELECT c.client_id
     FROM public.client_contacts cc
     JOIN public.clients c ON c.client_id = cc.client_id
     WHERE cc.type='phone' AND cc.value=$1`,
    [p]
  );
  if (found.rows[0]) return found.rows[0].client_id;

  // 2) crea client + contatti
  const name = (fullName && String(fullName).trim()) ? String(fullName).trim() : p;
  const ins = await q(
    `INSERT INTO public.clients(full_name)
     VALUES ($1)
     RETURNING client_id`,
    [name]
  );
  const clientId = ins.rows[0].client_id;

  await q(
    `INSERT INTO public.client_contacts(client_id, type, value)
     VALUES ($1, 'phone', $2)
     ON CONFLICT (value) WHERE (type='phone') DO UPDATE SET client_id = EXCLUDED.client_id`,
    [clientId, p]
  );

  if (whatsappChatId) {
    const w = String(whatsappChatId).trim();
    if (w) {
      await q(
        `INSERT INTO public.client_contacts(client_id, type, value)
         VALUES ($1, 'whatsapp_chat', $2)
         ON CONFLICT (value) WHERE (type='whatsapp_chat') DO UPDATE SET client_id = EXCLUDED.client_id`,
        [clientId, w]
      );
    }
  }

  return clientId;
}

async function upsertAppointmentFromBooking(b) {
  const eventId = String(b.eventId || b.event_id || '').trim();
  if (!eventId) return;

  const start = new Date(b.startTime || b.start_time || b.start);
  if (Number.isNaN(start.getTime())) return;

  const durMin = Number(b.durationMin || b.duration_min || 30) || 30;
  const end = new Date(start.getTime() + durMin * 60_000);

  const status = String(b.status || 'confirmed').toLowerCase();

  const professionalEmail = b.professionalEmail || b.professional_email;
  const professionalName = b.professionalName || b.professional_name || null;
  const proId = await ensureProfessional(professionalEmail, professionalName);

  const clientPhone = b.clientPhone || b.client_phone;
  const clientChatId = b.clientChatId || b.client_chat_id || null;
  const customerName = b.customerName || b.customer_name || null;
  const clientId = await ensureClient(clientPhone, customerName, clientChatId);

  const serviceName = b.service || b.serviceName || b.service_name;
  const serviceId = await ensureService(serviceName, durMin, null, null);

  // 1) se esiste event_id -> prendi appointment_id
  const existing = await q(
    `SELECT appointment_id FROM public.appointment_calendar
     WHERE provider='gcal' AND event_id=$1`,
    [eventId]
  );

  let appointmentId;
  if (existing.rows[0]) {
    appointmentId = existing.rows[0].appointment_id;
    await q(
      `UPDATE public.appointments
       SET client_id=$1, professional_id=$2, start_time=$3, end_time=$4, status=$5, updated_at=now()
       WHERE appointment_id=$6`,
      [clientId, proId, start.toISOString(), end.toISOString(), status, appointmentId]
    );
  } else {
    const ins = await q(
      `INSERT INTO public.appointments(client_id, professional_id, start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING appointment_id`,
      [clientId, proId, start.toISOString(), end.toISOString(), status]
    );
    appointmentId = ins.rows[0].appointment_id;

    await q(
      `INSERT INTO public.appointment_calendar(appointment_id, provider, event_id)
       VALUES ($1,'gcal',$2)
       ON CONFLICT (appointment_id) DO UPDATE SET event_id=EXCLUDED.event_id`,
      [appointmentId, eventId]
    );
  }

  await q(
    `INSERT INTO public.appointment_services(appointment_id, service_id, duration_min)
     VALUES ($1,$2,$3)
     ON CONFLICT (appointment_id, service_id) DO UPDATE SET duration_min=EXCLUDED.duration_min`,
    [appointmentId, serviceId, Math.trunc(durMin)]
  );

  // follow-up flags (se presenti)
  const confirmAskedAt = b.confirmAskedAt ? new Date(b.confirmAskedAt) : null;
  const reviewAskedAt = b.reviewAskedAt ? new Date(b.reviewAskedAt) : null;

  if (confirmAskedAt || reviewAskedAt) {
    await q(
      `INSERT INTO public.appointment_flags(appointment_id, confirm_asked_at, review_asked_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (appointment_id) DO UPDATE
         SET confirm_asked_at = COALESCE(EXCLUDED.confirm_asked_at, public.appointment_flags.confirm_asked_at),
             review_asked_at  = COALESCE(EXCLUDED.review_asked_at,  public.appointment_flags.review_asked_at)`,
      [
        appointmentId,
        confirmAskedAt && !Number.isNaN(confirmAskedAt.getTime()) ? confirmAskedAt.toISOString() : null,
        reviewAskedAt && !Number.isNaN(reviewAskedAt.getTime()) ? reviewAskedAt.toISOString() : null,
      ]
    );
  }
}

async function importConfig(config) {
  if (!config || typeof config !== 'object') return;

  // professionals
  if (config.professionals && typeof config.professionals === 'object') {
    for (const [email, p] of Object.entries(config.professionals)) {
      await ensureProfessional(email, p?.name || null);
    }
  }

  // services + mappings
  const services = config.services && typeof config.services === 'object' ? config.services : {};
  for (const [serviceName, s] of Object.entries(services)) {
    const serviceId = await ensureService(
      serviceName,
      s?.durationMin ?? s?.duration,
      (s?.price !== undefined && s?.price !== null) ? Number(s.price) : null,
      (s?.materialsCost !== undefined && s?.materialsCost !== null) ? Number(s.materialsCost) : null
    );

    // synonyms
    if (Array.isArray(s?.synonyms)) {
      for (const syn of s.synonyms) {
        const v = String(syn || '').trim();
        if (!v) continue;
        await q(
          `INSERT INTO public.service_synonyms(service_id, synonym)
           VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [serviceId, v]
        );
      }
    }

    // allergens
    if (Array.isArray(s?.allergens)) {
      for (const a of s.allergens) {
        const v = String(a || '').trim();
        if (!v) continue;
        await q(
          `INSERT INTO public.service_allergens(service_id, allergen)
           VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [serviceId, v]
        );
      }
    }

    // professionals allowed for service
    if (Array.isArray(s?.professionals)) {
      for (const email of s.professionals) {
        const proId = await ensureProfessional(email, null);
        await q(
          `INSERT INTO public.professional_services(professional_id, service_id)
           VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [proId, serviceId]
        );
      }
    }

    // override durations by professional
    if (s?.professionalDurations && typeof s.professionalDurations === 'object') {
      for (const [email, d] of Object.entries(s.professionalDurations)) {
        const proId = await ensureProfessional(email, null);
        const dm = Number(d);
        if (!Number.isFinite(dm) || dm <= 0) continue;
        await q(
          `INSERT INTO public.professional_service_durations(professional_id, service_id, duration_min)
           VALUES ($1,$2,$3)
           ON CONFLICT (professional_id, service_id) DO UPDATE SET duration_min=EXCLUDED.duration_min`,
          [proId, serviceId, Math.trunc(dm)]
        );
      }
    }
  }

  // business hours
  if (config.businessHours && typeof config.businessHours === 'object') {
    for (const [k, spec] of Object.entries(config.businessHours)) {
      const wd = isoWeekdayFromAny(k);
      const pair = asTimePair(spec);
      if (!wd || !pair) continue;
      await q(
        `INSERT INTO public.salon_business_hours(weekday, open_time, close_time, is_closed)
         VALUES ($1,$2,$3,false)
         ON CONFLICT (weekday) DO UPDATE SET open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time, is_closed=false`,
        [wd, pair[0], pair[1]]
      );
    }
  }

  // closed weekdays (closedDays/daysOff)
  const closed = config.closedDays || config.daysOff || {};
  const closedKeys = Array.isArray(closed) ? closed.map(String) : Object.keys(closed);
  for (const k of closedKeys) {
    const wd = isoWeekdayFromAny(k);
    if (!wd) continue;
    await q(
      `INSERT INTO public.salon_business_hours(weekday, is_closed)
       VALUES ($1, true)
       ON CONFLICT (weekday) DO UPDATE SET is_closed=true, open_time=NULL, close_time=NULL`,
      [wd]
    );
  }

  // lunch breaks: reset and insert
  if (config.lunchBreaks && typeof config.lunchBreaks === 'object') {
    await q(`TRUNCATE TABLE public.salon_lunch_breaks RESTART IDENTITY`);
    for (const [k, spec] of Object.entries(config.lunchBreaks)) {
      const wd = isoWeekdayFromAny(k);
      const pair = asTimePair(spec);
      if (!wd || !pair) continue;
      await q(
        `INSERT INTO public.salon_lunch_breaks(weekday, start_time, end_time)
         VALUES ($1,$2,$3)`,
        [wd, pair[0], pair[1]]
      );
    }
  }

  // unavailability: solo weekday full-day nel tuo file attuale
  if (config.unavailability && typeof config.unavailability === 'object') {
    for (const [email, rules] of Object.entries(config.unavailability)) {
      const proId = await ensureProfessional(email, null);
      if (!Array.isArray(rules)) continue;
      for (const r of rules) {
        if (!r || String(r.type || '').toLowerCase() !== 'day') continue;
        const days = Array.isArray(r.days) ? r.days : [];
        for (const d of days) {
          const wd = isoWeekdayFromAny(d);
          if (!wd) continue;
          await q(
            `INSERT INTO public.professional_unavailable_weekdays(professional_id, weekday)
             VALUES ($1,$2)
             ON CONFLICT DO NOTHING`,
            [proId, wd]
          );
        }
      }
    }
  }
}

async function importChatDb(chatdb) {
  if (!chatdb || typeof chatdb !== 'object') return;

  for (const [chatId, v] of Object.entries(chatdb)) {
    const phone = v?.phone ? String(v.phone) : null;
    const lang = v?.lang === 'en' ? 'en' : 'it';

    const firstSeenAt = v?.firstSeenAt ? new Date(Number(v.firstSeenAt)) : null;
    const lastActiveAt = v?.lastActive ? new Date(Number(v.lastActive)) : null;
    const lastGreetAt = v?.lastGreet ? new Date(Number(v.lastGreet)) : null;

    const privacyVer = v?.privacy?.version ?? null;
    const privacySentAt = v?.privacy?.sentAt ? new Date(Number(v.privacy.sentAt)) : null;

    const lastReviewPromptAt = v?.lastReviewPromptAt ? new Date(Number(v.lastReviewPromptAt)) : null;
    const lastReviewPromptEventId = v?.lastReviewPromptEventId ? String(v.lastReviewPromptEventId) : null;

    await q(
      `INSERT INTO public.chat_sessions(
         chat_id, phone_e164, lang, first_seen_at, last_active_at, last_greet_at,
         privacy_version, privacy_sent_at, last_review_prompt_at, last_review_prompt_event_id, last_review_reply_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chat_id) DO UPDATE SET
         phone_e164=COALESCE(EXCLUDED.phone_e164, public.chat_sessions.phone_e164),
         lang=COALESCE(EXCLUDED.lang, public.chat_sessions.lang),
         first_seen_at=COALESCE(EXCLUDED.first_seen_at, public.chat_sessions.first_seen_at),
         last_active_at=GREATEST(COALESCE(public.chat_sessions.last_active_at,'epoch'), COALESCE(EXCLUDED.last_active_at,'epoch')),
         last_greet_at=GREATEST(COALESCE(public.chat_sessions.last_greet_at,'epoch'), COALESCE(EXCLUDED.last_greet_at,'epoch')),
         privacy_version=COALESCE(EXCLUDED.privacy_version, public.chat_sessions.privacy_version),
         privacy_sent_at=COALESCE(EXCLUDED.privacy_sent_at, public.chat_sessions.privacy_sent_at),
         last_review_prompt_at=COALESCE(EXCLUDED.last_review_prompt_at, public.chat_sessions.last_review_prompt_at),
         last_review_prompt_event_id=COALESCE(EXCLUDED.last_review_prompt_event_id, public.chat_sessions.last_review_prompt_event_id),
         last_review_reply_at=COALESCE(EXCLUDED.last_review_reply_at, public.chat_sessions.last_review_reply_at)`,
      [
        chatId,
        phone,
        lang,
        firstSeenAt && !Number.isNaN(firstSeenAt.getTime()) ? firstSeenAt.toISOString() : null,
        lastActiveAt && !Number.isNaN(lastActiveAt.getTime()) ? lastActiveAt.toISOString() : null,
        lastGreetAt && !Number.isNaN(lastGreetAt.getTime()) ? lastGreetAt.toISOString() : null,
        privacyVer,
        privacySentAt && !Number.isNaN(privacySentAt.getTime()) ? privacySentAt.toISOString() : null,
        lastReviewPromptAt && !Number.isNaN(lastReviewPromptAt.getTime()) ? lastReviewPromptAt.toISOString() : null,
        lastReviewPromptEventId,
        v?.lastReviewReplyAt ? new Date(Number(v.lastReviewReplyAt)).toISOString() : null,
      ]
    );

    // salva gli ultimi msg (solo IN, max 5)
    const msgs = Array.isArray(v?.msgs) ? v.msgs.slice(-5) : [];
    if (msgs.length) {
      const base = lastActiveAt && !Number.isNaN(lastActiveAt.getTime()) ? lastActiveAt.getTime() : Date.now();
      for (let i = 0; i < msgs.length; i++) {
        const body = String(msgs[i] || '').slice(0, 800);
        if (!body.trim()) continue;
        const ts = new Date(base - (msgs.length - i) * 1000);
        await q(
          `INSERT INTO public.chat_messages(chat_id, direction, body, created_at)
           VALUES ($1,'in',$2,$3)`,
          [chatId, body, ts.toISOString()]
        );
      }
    }

    // pulizia: tieni max 5 msg IN
    await q(
      `DELETE FROM public.chat_messages
       WHERE chat_id=$1 AND message_id IN (
         SELECT message_id FROM public.chat_messages
         WHERE chat_id=$1 AND direction='in'
         ORDER BY created_at DESC
         OFFSET 5
       )`,
      [chatId]
    );
  }
}

async function importHolds(holds) {
  if (!Array.isArray(holds)) return;

  for (const h of holds) {
    const chatId = String(h.chatId || '').trim();
    const email = String(h.professionalEmail || '').trim();
    if (!chatId || !email) continue;

    const proId = await ensureProfessional(email, null);
    const startMs = Number(h.startMs);
    const endMs = Number(h.endMs);
    const createdAt = Number(h.createdAt);
    const expiresAt = Number(h.expiresAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(expiresAt)) continue;

    // assicurati sessione
    await q(
      `INSERT INTO public.chat_sessions(chat_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [chatId]
    );

    const status = (expiresAt <= Date.now()) ? 'expired' : 'active';

    await q(
      `INSERT INTO public.appointment_holds(
         chat_id, professional_id, start_time, end_time, created_at, expires_at, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        chatId,
        proId,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
        new Date(expiresAt).toISOString(),
        status,
      ]
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL obbligatorio per la migrazione');
  const configPath = path.join(DATA_DIR, 'config.json');
  const bookingsPath = path.join(DATA_DIR, 'bookings.json');
  const chatdbPath = path.join(DATA_DIR, 'chatdb.json');
  const holdsPath = path.join(DATA_DIR, 'holds.json');

  const cfg = await readJson(configPath, null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !cfg.services) {
    throw new Error('config.json mancante o non valido nella directory APP_DATA_DIR');
  }
  const bookings = await readJson(bookingsPath, []);
  const chatdb = await readJson(chatdbPath, {});
  const holds = await readJson(holdsPath, []);

  console.log('[migrate] DATA_DIR =', DATA_DIR);
  console.log('[migrate] config:', !!cfg, 'bookings:', Array.isArray(bookings) ? bookings.length : 0, 'chatdb keys:', chatdb ? Object.keys(chatdb).length : 0, 'holds:', Array.isArray(holds) ? holds.length : 0);

  try {
    transactionClient = await pool.connect();
    await q('BEGIN');

    await importConfig(cfg);

    if (Array.isArray(bookings)) {
      for (const b of bookings) {
        await upsertAppointmentFromBooking(b);
      }
    }

    await importChatDb(chatdb);
    await importHolds(holds);

    await q('COMMIT');
    console.log('[migrate] OK');
  } catch (e) {
    if (transactionClient) await transactionClient.query('ROLLBACK').catch(() => {});
    console.error('[migrate] FAIL', e.code || 'Errore durante la migrazione');
    process.exitCode = 1;
  } finally {
    transactionClient?.release();
    transactionClient = null;
    await pool.end();
  }
}

main().catch(async error => {
  console.error('[migrate] FAIL', error.code || error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
