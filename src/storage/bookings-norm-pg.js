// bookings-norm-pg.js (ESM)
// Storage prenotazioni su PostgreSQL in schema normalizzato (campi atomici, senza JSONB)
// Obiettivo: eliminare dipendenze transitive (cliente/professionista/servizio separati).

import { createPgPool } from './postgres.js';
const pool = createPgPool();

let __inited = false;

function digits(v) {
  return String(v || "").replace(/\D/g, "");
}
function phoneKey(v) {
  let d = digits(v);
  d = d.replace(/^00?39/, "").replace(/^39/, "");
  return d || null;
}
function toISO(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? v.toISOString() : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function inferStartISO(obj) {
  const iso =
    toISO(obj?.startTime) ||
    toISO(obj?.start) ||
    toISO(obj?.datetime) ||
    toISO(obj?.date) ||
    toISO(obj?.day) ||
    toISO(obj?.when) ||
    (Number.isFinite(Number(obj?.startMs)) ? new Date(Number(obj.startMs)).toISOString() : null);

  return iso;
}
function inferEndISO(obj, startISO) {
  const iso =
    toISO(obj?.endTime) ||
    toISO(obj?.end) ||
    (Number.isFinite(Number(obj?.endMs)) ? new Date(Number(obj.endMs)).toISOString() : null);

  if (iso) return iso;

  const durMin = Number(obj?.durationMin ?? obj?.duration ?? obj?.minutes ?? 0) || 0;
  if (durMin > 0 && startISO) {
    const s = Date.parse(startISO);
    if (Number.isFinite(s)) return new Date(s + durMin * 60_000).toISOString();
  }
  return null;
}
function normalizeStatus(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "attesa";
  if (s === "confirmed" || s === "confermato") return "confirmed";
  if (s === "completed" || s === "completato" || s === "done") return "completato";
  if (s === "cancelled" || s === "canceled" || s === "annullato") return "annullato";
  if (s === "attesa" || s === "pending") return "attesa";
  if (s === "no_show" || s === "no-show") return "no_show";
  // fallback: non bloccare (ma lo normalizziamo a 'attesa' per coerenza)
  return "attesa";
}

export async function initBookingsNormDbPg() {
  if (__inited) return true;

  // Schema normalizzato (stile 5NF pratico)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id   BIGSERIAL PRIMARY KEY,
      full_name   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_contacts (
      client_id BIGINT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
      type      TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (client_id, type, value)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_client_phone
      ON client_contacts(value)
      WHERE type = 'phone';

    CREATE UNIQUE INDEX IF NOT EXISTS ux_client_whatsapp
      ON client_contacts(value)
      WHERE type = 'whatsapp_chat';


    CREATE TABLE IF NOT EXISTS professionals (
      professional_id BIGSERIAL PRIMARY KEY,
      full_name       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS professional_emails (
      professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
      email           TEXT NOT NULL,
      PRIMARY KEY (professional_id, email)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_professional_email
      ON professional_emails(lower(email));


    CREATE TABLE IF NOT EXISTS services (
      service_id            BIGSERIAL PRIMARY KEY,
      service_name          TEXT NOT NULL UNIQUE,
      default_duration_min  INT NOT NULL CHECK (default_duration_min > 0)
    );

    CREATE TABLE IF NOT EXISTS professional_services (
      professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
      service_id      BIGINT NOT NULL REFERENCES services(service_id) ON DELETE RESTRICT,
      PRIMARY KEY (professional_id, service_id)
    );


    CREATE TABLE IF NOT EXISTS appointments (
      appointment_id BIGSERIAL PRIMARY KEY,
      client_id       BIGINT NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
      professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE RESTRICT,
      start_time TIMESTAMPTZ NOT NULL,
      end_time   TIMESTAMPTZ NOT NULL,
      status     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (end_time > start_time)
    );

    CREATE INDEX IF NOT EXISTS ix_appointments_start_time ON appointments(start_time);

    CREATE TABLE IF NOT EXISTS appointment_calendar (
      appointment_id BIGINT PRIMARY KEY REFERENCES appointments(appointment_id) ON DELETE CASCADE,
      provider       TEXT NOT NULL DEFAULT 'gcal',
      event_id       TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS appointment_services (
      appointment_id BIGINT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
      service_id     BIGINT NOT NULL REFERENCES services(service_id) ON DELETE RESTRICT,
      duration_min   INT NOT NULL CHECK (duration_min > 0),
      PRIMARY KEY (appointment_id, service_id)
    );
  `);

  __inited = true;
  return true;
}

async function getOrCreateClient(db, { customerName, clientPhone, clientChatId }) {
  const name = String(customerName || "").trim() || "Cliente";
  const phoneDigits = digits(clientPhone);
  const chatId = String(clientChatId || "").trim();

  let clientId = null;

  // Il numero deve combaciare per intero: gli ultimi 7 possono appartenere a clienti diversi.
  if (phoneDigits) {
    const q = await db.query(
      `
      SELECT client_id
      FROM client_contacts
      WHERE type='phone'
        AND value = $1
      ORDER BY length(value) DESC
      LIMIT 1;
      `,
      [phoneDigits]
    );
    clientId = q.rows?.[0]?.client_id ?? null;
  }

  // 2) fallback match per chatId
  if (!clientId && chatId) {
    const q = await db.query(
      `
      SELECT client_id
      FROM client_contacts
      WHERE type='whatsapp_chat' AND value = $1
      LIMIT 1;
      `,
      [chatId]
    );
    clientId = q.rows?.[0]?.client_id ?? null;
  }

  if (!clientId) {
    const ins = await db.query(
      `INSERT INTO clients(full_name) VALUES ($1) RETURNING client_id;`,
      [name]
    );
    clientId = ins.rows?.[0]?.client_id;
  } else {
    // aggiorna nome solo se utile (evita di sovrascrivere con stringhe vuote)
    if (name && name !== "Cliente") {
      await db.query(
        `UPDATE clients SET full_name = $2 WHERE client_id = $1 AND (full_name IS NULL OR full_name = '' OR full_name = 'Cliente');`,
        [clientId, name]
      );
    }
  }

  // contatti (idempotente)
  if (phoneDigits) {
    await db.query(
      `INSERT INTO client_contacts(client_id,type,value) VALUES ($1,'phone',$2) ON CONFLICT DO NOTHING;`,
      [clientId, phoneDigits]
    );
  }
  if (chatId) {
    await db.query(
      `INSERT INTO client_contacts(client_id,type,value) VALUES ($1,'whatsapp_chat',$2) ON CONFLICT DO NOTHING;`,
      [clientId, chatId]
    );
  }

  return clientId;
}

async function getOrCreateProfessional(db, { professionalName, professionalEmail }) {
  const name = String(professionalName || "").trim() || "Operatore";
  const email = String(professionalEmail || "").trim();

  let professionalId = null;

  if (email) {
    const q = await db.query(
      `SELECT professional_id FROM professional_emails WHERE lower(email) = lower($1) LIMIT 1;`,
      [email]
    );
    professionalId = q.rows?.[0]?.professional_id ?? null;
  }

  if (!professionalId) {
    const ins = await db.query(
      `INSERT INTO professionals(full_name) VALUES ($1) RETURNING professional_id;`,
      [name]
    );
    professionalId = ins.rows?.[0]?.professional_id;
  } else {
    if (name && name !== "Operatore") {
      await db.query(
        `UPDATE professionals SET full_name = $2 WHERE professional_id = $1 AND (full_name IS NULL OR full_name = '' OR full_name = 'Operatore');`,
        [professionalId, name]
      );
    }
  }

  if (email) {
    await db.query(
      `INSERT INTO professional_emails(professional_id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING;`,
      [professionalId, email]
    );
  }

  return professionalId;
}

async function getOrCreateService(db, { serviceName, durationMin }) {
  const name = String(serviceName || "").trim() || "Servizio";
  const dur = Math.max(1, Number(durationMin) || 30);

  const q = await db.query(`SELECT service_id FROM services WHERE service_name = $1 LIMIT 1;`, [name]);
  if (q.rowCount > 0) return q.rows[0].service_id;

  const ins = await db.query(
    `INSERT INTO services(service_name, default_duration_min) VALUES ($1,$2) RETURNING service_id;`,
    [name, dur]
  );
  return ins.rows?.[0]?.service_id;
}

async function findAppointmentId(db, { eventId, clientId, startISO }) {
  if (eventId) {
    const q = await db.query(
      `SELECT appointment_id FROM appointment_calendar WHERE event_id = $1 LIMIT 1;`,
      [eventId]
    );
    // Un nuovo eventId non deve sovrascrivere un appuntamento con evento diverso.
    return q.rows?.[0]?.appointment_id ?? null;
  }

  if (clientId && startISO) {
    const q = await db.query(
      `SELECT appointment_id FROM appointments WHERE client_id = $1 AND start_time = $2::timestamptz ORDER BY appointment_id DESC LIMIT 1;`,
      [clientId, startISO]
    );
    if (q.rowCount > 0) return q.rows[0].appointment_id;
  }

  return null;
}

async function upsertAppointmentFlags(db, appointmentId, booking) {
  const now = new Date().toISOString();
  const confirmAt = toISO(booking.confirmAskedAt) || (booking.confirmAsked ? now : null);
  const reviewAt = toISO(booking.reviewAskedAt) || (booking.reviewAsked ? now : null);
  if (!confirmAt && !reviewAt) return;
  await db.query(`
    INSERT INTO appointment_flags(appointment_id, confirm_asked_at, review_asked_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz)
    ON CONFLICT (appointment_id) DO UPDATE SET
      confirm_asked_at=COALESCE(appointment_flags.confirm_asked_at, EXCLUDED.confirm_asked_at),
      review_asked_at=COALESCE(appointment_flags.review_asked_at, EXCLUDED.review_asked_at)
  `, [appointmentId, confirmAt, reviewAt]);
}

async function upsertAppointment(db, booking) {
  const eventId = String(booking?.eventId || booking?.event_id || "").trim() || null;

  const customerName = booking?.customerName || booking?.customer_name || null;
  const clientPhone = booking?.clientPhone || booking?.phone || booking?.customerPhone || booking?.whatsapp || null;
  const clientChatId = booking?.clientChatId || booking?.chatId || null;

  const professionalName = booking?.professionalName || null;
  const professionalEmail = booking?.professionalEmail || null;

  const serviceName = booking?.service || booking?.serviceName || null;

  const startISO = inferStartISO(booking);
  if (!startISO) throw new Error("booking senza startTime/startMs");
  const endISO = inferEndISO(booking, startISO);
  if (!endISO) throw new Error("booking senza endTime/endMs/durationMin");

  const status = normalizeStatus(booking?.status || booking?.state);

  const createdAtISO = toISO(booking?.createdAt) || new Date().toISOString();
  const updatedAtISO = toISO(booking?.updatedAt) || new Date().toISOString();

  // duration (preferisci quello esplicito, altrimenti derivato)
  let durMin = Number(booking?.durationMin ?? booking?.duration ?? 0) || 0;
  if (!durMin) {
    const s = Date.parse(startISO);
    const e = Date.parse(endISO);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      durMin = Math.round((e - s) / 60_000);
    }
  }
  durMin = Math.max(1, durMin || 30);

  const clientId = await getOrCreateClient(db, { customerName, clientPhone, clientChatId });
  // Se il chiamante ha gia' risolto gli ID dalla configurazione SQL, mantenerli:
  // non creare un professionista generico in caso di email temporaneamente assente.
  const requestedProfessionalId = Number(booking?.professional_id ?? booking?.professionalId);
  const requestedServiceId = Number(booking?.service_id ?? booking?.serviceId);
  let professionalId;
  let serviceId;
  if (Number.isSafeInteger(requestedProfessionalId) && requestedProfessionalId > 0) {
    const found = await db.query('SELECT professional_id FROM professionals WHERE professional_id=$1', [requestedProfessionalId]);
    if (!found.rowCount) throw new Error('professional_id inesistente');
    professionalId = requestedProfessionalId;
  } else {
    professionalId = await getOrCreateProfessional(db, { professionalName, professionalEmail });
  }
  if (Number.isSafeInteger(requestedServiceId) && requestedServiceId > 0) {
    const found = await db.query('SELECT service_id FROM services WHERE service_id=$1', [requestedServiceId]);
    if (!found.rowCount) throw new Error('service_id inesistente');
    serviceId = requestedServiceId;
  } else {
    serviceId = await getOrCreateService(db, { serviceName, durationMin: durMin });
  }

  // 5NF: relazione pro-servizi (idempotente)
  try {
    await db.query(
      `INSERT INTO professional_services(professional_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;`,
      [professionalId, serviceId]
    );
  } catch { }

  const appointmentId = await findAppointmentId(db, { eventId, clientId, startISO });

  if (appointmentId) {
    await db.query(
      `
      UPDATE appointments
      SET client_id=$2,
          professional_id=$3,
          service_id=$8,
          start_time=$4::timestamptz,
          end_time=$5::timestamptz,
          status=$6,
          updated_at=$7::timestamptz
      WHERE appointment_id=$1;
      `,
      [appointmentId, clientId, professionalId, startISO, endISO, status, updatedAtISO, serviceId]
    );

    if (eventId) {
      // 1-1 calendar
      await db.query(
        `
        INSERT INTO appointment_calendar(appointment_id, provider, event_id, calendar_id)
        VALUES ($1,'gcal',$2,$3)
        ON CONFLICT (appointment_id) DO UPDATE SET event_id=EXCLUDED.event_id,
          calendar_id=EXCLUDED.calendar_id;
        `,
        [appointmentId, eventId, process.env.CALENDAR_ID || null]
      );
    }

    // Assumiamo 1 servizio per appuntamento (compatibile con il tuo bot)
    await db.query(`DELETE FROM appointment_services WHERE appointment_id=$1;`, [appointmentId]);
    await db.query(
      `INSERT INTO appointment_services(appointment_id, service_id, duration_min) VALUES ($1,$2,$3);`,
      [appointmentId, serviceId, durMin]
    );

    await upsertAppointmentFlags(db, appointmentId, booking);
    return appointmentId;
  }

  const ins = await db.query(
    `
    INSERT INTO appointments(client_id, professional_id, service_id, start_time, end_time, status, created_at, updated_at)
    VALUES ($1,$2,$8,$3::timestamptz,$4::timestamptz,$5,$6::timestamptz,$7::timestamptz)
    RETURNING appointment_id;
    `,
    [clientId, professionalId, startISO, endISO, status, createdAtISO, updatedAtISO, serviceId]
  );
  const newId = ins.rows?.[0]?.appointment_id;

  if (eventId) {
    await db.query(
      `INSERT INTO appointment_calendar(appointment_id, provider, event_id, calendar_id) VALUES ($1,'gcal',$2,$3);`,
      [newId, eventId, process.env.CALENDAR_ID || null]
    );
  }

  await db.query(
    `INSERT INTO appointment_services(appointment_id, service_id, duration_min) VALUES ($1,$2,$3);`,
    [newId, serviceId, durMin]
  );

  await upsertAppointmentFlags(db, newId, booking);
  return newId;
}

export async function bulkUpsertBookingsNormPg(items) {
  await initBookingsNormDbPg();

  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return true;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const b of arr) {
      if (!b || typeof b !== "object") continue;
      await upsertAppointment(client, b);
    }
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { }
    throw e;
  } finally {
    client.release();
  }
}

export async function listBookingsNormPg() {
  await initBookingsNormDbPg();

  // 1 riga per appointment (prendiamo 1 servizio + 1 phone + 1 whatsapp + 1 email)
  const res = await pool.query(`
    SELECT
      cal.event_id AS event_id,

      c.full_name AS customer_name,

      ph.value AS client_phone,
      wa.value AS client_chat_id,

      p.full_name AS professional_name,
      p.professional_id AS professional_id,
      a.service_id AS primary_service_id,
      em.email AS professional_email,

      svc.service_name AS service_name,
      svc.duration_min AS duration_min,

      a.start_time,
      a.end_time,
      a.status,
      a.created_at,
      a.updated_at,
      af.confirm_asked_at,
      af.review_asked_at
    FROM appointments a
    LEFT JOIN appointment_calendar cal ON cal.appointment_id = a.appointment_id
    LEFT JOIN appointment_flags af ON af.appointment_id = a.appointment_id
    JOIN clients c ON c.client_id = a.client_id
    JOIN professionals p ON p.professional_id = a.professional_id

    LEFT JOIN LATERAL (
      SELECT value
      FROM client_contacts
      WHERE client_id = c.client_id AND type='phone'
      ORDER BY length(value) DESC
      LIMIT 1
    ) ph ON true

    LEFT JOIN LATERAL (
      SELECT value
      FROM client_contacts
      WHERE client_id = c.client_id AND type='whatsapp_chat'
      ORDER BY length(value) DESC
      LIMIT 1
    ) wa ON true

    LEFT JOIN LATERAL (
      SELECT email
      FROM professional_emails
      WHERE professional_id = p.professional_id
      ORDER BY email ASC
      LIMIT 1
    ) em ON true

    LEFT JOIN LATERAL (
      SELECT s.service_name, aps.duration_min
      FROM appointment_services aps
      JOIN services s ON s.service_id = aps.service_id
      WHERE aps.appointment_id = a.appointment_id
      ORDER BY s.service_name ASC
      LIMIT 1
    ) svc ON true

    ORDER BY a.start_time ASC, a.updated_at DESC, a.appointment_id DESC;
  `);

  const out = [];
  for (const r of res.rows || []) {
    const startISO = r.start_time ? new Date(r.start_time).toISOString() : null;
    const endISO = r.end_time ? new Date(r.end_time).toISOString() : null;
    const createdISO = r.created_at ? new Date(r.created_at).toISOString() : null;
    const updatedISO = r.updated_at ? new Date(r.updated_at).toISOString() : null;

    const startMs = startISO ? Date.parse(startISO) : null;
    const endMs = endISO ? Date.parse(endISO) : null;

    out.push({
      eventId: r.event_id || null,

      customerName: r.customer_name || null,
      clientPhone: r.client_phone || null,
      clientChatId: r.client_chat_id || null,

      professionalName: r.professional_name || null,
      professionalEmail: r.professional_email || null,
      professional_id: r.professional_id ? Number(r.professional_id) : null,
      service_id: r.primary_service_id ? Number(r.primary_service_id) : null,

      service: r.service_name || null,
      durationMin: Number(r.duration_min) || null,

      startTime: startISO,
      endTime: endISO,
      startMs: Number.isFinite(startMs) ? startMs : undefined,
      endMs: Number.isFinite(endMs) ? endMs : undefined,

      status: r.status || "attesa",
      confirmAsked: Boolean(r.confirm_asked_at),
      confirmAskedAt: r.confirm_asked_at ? new Date(r.confirm_asked_at).toISOString() : null,
      reviewAsked: Boolean(r.review_asked_at),
      reviewAskedAt: r.review_asked_at ? new Date(r.review_asked_at).toISOString() : null,
      createdAt: createdISO,
      updatedAt: updatedISO,
    });
  }

  return out.filter((x) => x && typeof x === "object");
}

export async function closeBookingsNormDbPg() {
  try {
    await pool.end();
  } catch { }
}
