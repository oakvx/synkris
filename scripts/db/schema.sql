-- Bootstrap idempotente per PostgreSQL 16+.
-- Non importa dati locali e non cancella tabelle o record esistenti.
CREATE SCHEMA IF NOT EXISTS public;

CREATE TABLE IF NOT EXISTS public.clients (
  client_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_contacts (
  client_id BIGINT NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (client_id, type, value)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_client_phone
  ON public.client_contacts(value) WHERE type = 'phone';
CREATE UNIQUE INDEX IF NOT EXISTS ux_client_whatsapp
  ON public.client_contacts(value) WHERE type = 'whatsapp_chat';

CREATE TABLE IF NOT EXISTS public.professionals (
  professional_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.professional_emails (
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  PRIMARY KEY (professional_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_professional_email
  ON public.professional_emails(lower(email));

CREATE TABLE IF NOT EXISTS public.service_categories (
  category_id BIGSERIAL PRIMARY KEY,
  category_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.services (
  service_id BIGSERIAL PRIMARY KEY,
  service_name TEXT NOT NULL UNIQUE,
  default_duration_min INTEGER NOT NULL CHECK (default_duration_min > 0),
  price NUMERIC(12,2),
  base_price NUMERIC(12,2),
  materials_cost NUMERIC(12,2),
  category_id BIGINT REFERENCES public.service_categories(category_id) ON DELETE SET NULL,
  category TEXT,
  emoji TEXT,
  display_order INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_services_category ON public.services(category_id);

-- Migrazione JSON e Google Calendar usano price; la dashboard usa base_price.
-- Entrambi i formati devono poter scrivere lo stesso prezzo.
CREATE OR REPLACE FUNCTION public.sync_service_price()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.base_price IS NULL THEN NEW.base_price := NEW.price;
    ELSE NEW.price := NEW.base_price;
    END IF;
  ELSIF NEW.base_price IS DISTINCT FROM OLD.base_price THEN
    NEW.price := NEW.base_price;
  ELSIF NEW.price IS DISTINCT FROM OLD.price THEN
    NEW.base_price := NEW.price;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER sync_service_price
  BEFORE INSERT OR UPDATE OF price, base_price ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.sync_service_price();

CREATE TABLE IF NOT EXISTS public.service_synonyms (
  service_id BIGINT NOT NULL REFERENCES public.services(service_id) ON DELETE CASCADE,
  synonym TEXT NOT NULL,
  PRIMARY KEY (service_id, synonym)
);
CREATE TABLE IF NOT EXISTS public.service_allergens (
  service_id BIGINT NOT NULL REFERENCES public.services(service_id) ON DELETE CASCADE,
  allergen TEXT NOT NULL,
  PRIMARY KEY (service_id, allergen)
);

CREATE TABLE IF NOT EXISTS public.professional_services (
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES public.services(service_id) ON DELETE RESTRICT,
  PRIMARY KEY (professional_id, service_id)
);
CREATE INDEX IF NOT EXISTS ix_professional_services_service
  ON public.professional_services(service_id);

CREATE TABLE IF NOT EXISTS public.professional_service_durations (
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES public.services(service_id) ON DELETE CASCADE,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  PRIMARY KEY (professional_id, service_id)
);

CREATE TABLE IF NOT EXISTS public.salon_business_hours (
  weekday SMALLINT PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
  open_time TIME,
  close_time TIME,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time > open_time))
);
CREATE TABLE IF NOT EXISTS public.salon_lunch_breaks (
  lunch_break_id BIGSERIAL PRIMARY KEY,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE (weekday, start_time, end_time)
);
CREATE TABLE IF NOT EXISTS public.salon_closed_dates (
  day DATE PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS public.professional_unavailable_weekdays (
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  PRIMARY KEY (professional_id, weekday)
);

CREATE TABLE IF NOT EXISTS public.appointments (
  appointment_id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  professional_id BIGINT REFERENCES public.professionals(professional_id) ON DELETE RESTRICT,
  service_id BIGINT REFERENCES public.services(service_id) ON DELETE RESTRICT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS ix_appointments_start_time ON public.appointments(start_time);
CREATE INDEX IF NOT EXISTS ix_appointments_professional_time
  ON public.appointments(professional_id, start_time);
CREATE INDEX IF NOT EXISTS ix_appointments_client ON public.appointments(client_id);
CREATE INDEX IF NOT EXISTS ix_appointments_service ON public.appointments(service_id);

-- Concorrenza: impedisce due appuntamenti attivi sovrapposti dello stesso operatore.
-- Intervalli [inizio, fine): due appuntamenti consecutivi sono consentiti.
-- Il vincolo si applica a TUTTI i writer di appointments (bot, dashboard, IVR).
-- L'installazione su dati esistenti con conflitti si interrompe e NON cancella record.
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_no_professional_overlap'
      AND conrelid = 'public.appointments'::regclass
  ) THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_no_professional_overlap
      EXCLUDE USING gist (
        professional_id WITH =,
        tstzrange(start_time, end_time, '[)') WITH &&
      )
      WHERE (
        professional_id IS NOT NULL
        AND lower(status) NOT IN ('cancelled', 'canceled', 'annullato', 'completed', 'completato', 'done', 'no_show')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.appointment_calendar (
  appointment_id BIGINT PRIMARY KEY REFERENCES public.appointments(appointment_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'gcal',
  event_id TEXT NOT NULL UNIQUE
);
-- A legacy event ID alone cannot identify which of several calendars owns an event.
-- Unbound legacy rows are not synchronized automatically until reviewed and bound.
ALTER TABLE public.appointment_calendar
  ADD COLUMN IF NOT EXISTS calendar_id TEXT;
CREATE INDEX IF NOT EXISTS ix_appointment_calendar_calendar_event
  ON public.appointment_calendar(calendar_id, event_id);

CREATE TABLE IF NOT EXISTS public.appointment_services (
  appointment_id BIGINT NOT NULL REFERENCES public.appointments(appointment_id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES public.services(service_id) ON DELETE RESTRICT,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  PRIMARY KEY (appointment_id, service_id)
);
CREATE INDEX IF NOT EXISTS ix_appointment_services_service
  ON public.appointment_services(service_id);
CREATE TABLE IF NOT EXISTS public.appointment_flags (
  appointment_id BIGINT PRIMARY KEY REFERENCES public.appointments(appointment_id) ON DELETE CASCADE,
  confirm_asked_at TIMESTAMPTZ,
  review_asked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.chat_sessions (
  chat_id TEXT PRIMARY KEY,
  phone_e164 TEXT,
  lang TEXT NOT NULL DEFAULT 'it',
  first_seen_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  last_greet_at TIMESTAMPTZ,
  privacy_version INTEGER,
  privacy_sent_at TIMESTAMPTZ,
  last_review_prompt_at TIMESTAMPTZ,
  last_review_prompt_event_id TEXT,
  last_review_prompt_service_id BIGINT REFERENCES public.services(service_id) ON DELETE SET NULL,
  last_review_prompt_professional_id BIGINT REFERENCES public.professionals(professional_id) ON DELETE SET NULL,
  last_review_reply_at TIMESTAMPTZ,
  reminder_choice INTEGER
);
CREATE TABLE IF NOT EXISTS public.chat_messages (
  message_id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES public.chat_sessions(chat_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_chat_messages_history
  ON public.chat_messages(chat_id, direction, created_at DESC);

CREATE TABLE IF NOT EXISTS public.appointment_holds (
  hold_id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES public.chat_sessions(chat_id) ON DELETE CASCADE,
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  service_id BIGINT REFERENCES public.services(service_id) ON DELETE SET NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS ix_appointment_holds_active
  ON public.appointment_holds(professional_id, start_time, end_time) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_appointment_holds_expiry
  ON public.appointment_holds(expires_at) WHERE status = 'active';

-- Compatibilita con gli endpoint JSONB della dashboard PHP.
CREATE TABLE IF NOT EXISTS public.bookings (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT,
  phone_key TEXT,
  start_ms BIGINT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bookings_event_id ON public.bookings(event_id);
CREATE INDEX IF NOT EXISTS ix_bookings_start_ms ON public.bookings(start_ms);

-- Durable recovery for Calendar-first booking attempts.
-- Best-effort durable deduplication of provider callback identifiers.
-- Store only SHA-256 digests, never the original provider id or customer text.
CREATE TABLE IF NOT EXISTS public.whatsapp_message_inbox (
  message_hash CHAR(64) PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_message_inbox_retention
  ON public.whatsapp_message_inbox(completed_at) WHERE status='completed';

-- A pending operation older than 15 minutes is reconciled with appointment_calendar.
CREATE TABLE IF NOT EXISTS public.calendar_booking_sagas (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','compensated','needs_attention')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent migration for existing installations created before needs_attention.
ALTER TABLE public.calendar_booking_sagas
  DROP CONSTRAINT IF EXISTS calendar_booking_sagas_status_check;
ALTER TABLE public.calendar_booking_sagas
  ADD CONSTRAINT calendar_booking_sagas_status_check
  CHECK (status IN ('pending','committed','compensated','needs_attention'));
CREATE INDEX IF NOT EXISTS ix_calendar_sagas_attention
  ON public.calendar_booking_sagas(updated_at) WHERE status='needs_attention';
CREATE INDEX IF NOT EXISTS ix_calendar_sagas_pending
  ON public.calendar_booking_sagas(next_attempt_at, created_at) WHERE status='pending';

-- synk v2: incremental inbound reconciliation (metadata-only audit).
CREATE TABLE IF NOT EXISTS public.calendar_sync_cursors (
  calendar_id TEXT PRIMARY KEY,
  sync_token TEXT NOT NULL,
  last_success_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.calendar_sync_conflicts (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (calendar_id,event_id)
);
CREATE TABLE IF NOT EXISTS public.calendar_sync_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT REFERENCES public.appointments(appointment_id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK (operation IN ('cancel','update')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_calendar_sync_audit_created ON public.calendar_sync_audit(created_at DESC);

-- Transactional outbox for future calendar mutations. Never stores client messages or secrets.
CREATE TABLE IF NOT EXISTS public.calendar_outbox (
 job_id BIGSERIAL PRIMARY KEY,
 operation TEXT NOT NULL CHECK (operation IN ('create','cancel','update','reschedule')),
 event_id TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','attention')),
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_until TIMESTAMPTZ,
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ,
 UNIQUE (operation,event_id,created_at)
);
-- Existing installations need the new operation in their CHECK constraint.
ALTER TABLE public.calendar_outbox DROP CONSTRAINT IF EXISTS calendar_outbox_operation_check;
ALTER TABLE public.calendar_outbox ADD CONSTRAINT calendar_outbox_operation_check
  CHECK (operation IN ('create','cancel','update','reschedule'));
ALTER TABLE public.calendar_outbox ADD COLUMN IF NOT EXISTS calendar_id TEXT;
ALTER TABLE public.calendar_outbox ADD COLUMN IF NOT EXISTS lease_token UUID;
CREATE INDEX IF NOT EXISTS ix_calendar_outbox_due ON public.calendar_outbox(available_at)
 WHERE status='pending';

-- Operator-controlled waiting list: explicit opt-in; short retention and no chat text.
CREATE TABLE IF NOT EXISTS public.waitlist_requests (
 request_id BIGSERIAL PRIMARY KEY,
 chat_id TEXT NOT NULL,
 service_id BIGINT REFERENCES public.services(service_id) ON DELETE CASCADE,
 professional_id BIGINT REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
 earliest_at TIMESTAMPTZ NOT NULL,
 latest_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','offered','accepted','expired','revoked')),
 consent_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK(latest_at > earliest_at),
 CHECK(expires_at <= consent_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS ix_waitlist_active ON public.waitlist_requests(earliest_at,latest_at)
 WHERE status='active';
CREATE TABLE IF NOT EXISTS public.waitlist_offers (
 offer_id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES public.waitlist_requests(request_id) ON DELETE CASCADE,
 start_time TIMESTAMPTZ NOT NULL,
 end_time TIMESTAMPTZ NOT NULL,
 sent_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,
 UNIQUE (request_id,start_time)
);

CREATE TABLE IF NOT EXISTS public.salon_settings (
 setting_key TEXT PRIMARY KEY,
 setting_value TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (setting_key ~ '^[a-z_]{3,50}$'),
 CHECK(length(setting_value) <= 1000)
);

-- Synk 1.1 - a temporary operator handoff overrides automatic replies.
CREATE TABLE IF NOT EXISTS public.chat_handoffs (
  chat_id TEXT PRIMARY KEY CHECK (chat_id ~ '^[0-9]{5,20}@c\.us$'),
  paused BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS ix_chat_handoffs_active ON public.chat_handoffs(expires_at)
 WHERE paused = true;
-- Customer notes are not exposed to AI or external services.
CREATE TABLE IF NOT EXISTS public.client_notes (
  client_id BIGINT PRIMARY KEY REFERENCES public.clients(client_id) ON DELETE CASCADE,
  note TEXT NOT NULL CHECK (length(note) <= 1000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Date-specific operator absences, separate from recurring weekly unavailability.
CREATE TABLE IF NOT EXISTS public.professional_time_off (
  absence_id BIGSERIAL PRIMARY KEY,
  professional_id BIGINT NOT NULL REFERENCES public.professionals(professional_id) ON DELETE CASCADE,
  start_day DATE NOT NULL,
  end_day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_day >= start_day),
  CHECK (end_day <= start_day + interval '365 days')
);
CREATE INDEX IF NOT EXISTS ix_pro_time_off ON public.professional_time_off(professional_id,start_day,end_day);

-- synk 1.1 RC4 - buffer post-trattamento e ordine multi-servizio.
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS buffer_after_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_buffer_after_min_valid;
ALTER TABLE public.services ADD CONSTRAINT services_buffer_after_min_valid CHECK (buffer_after_min BETWEEN 0 AND 180);
ALTER TABLE public.appointment_services ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_appt_services_order ON public.appointment_services(appointment_id,sort_order);

-- Local GDPR follow-up queue. Contains client reference but never chat content.
-- Staff reviews Google Calendar, WhatsApp and legal retention outside chat deletion.
CREATE TABLE IF NOT EXISTS public.privacy_requests (
 request_id BIGSERIAL PRIMARY KEY,
 client_id BIGINT REFERENCES public.clients(client_id) ON DELETE SET NULL,
 request_hash CHAR(64) NOT NULL,
 request_kind TEXT NOT NULL DEFAULT 'erasure' CHECK (request_kind IN ('erasure','access')),
 status TEXT NOT NULL DEFAULT 'to_review' CHECK (status IN ('to_review','in_progress','closed')),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_privacy_requests_status
 ON public.privacy_requests(requested_at DESC) WHERE status<>'closed';
