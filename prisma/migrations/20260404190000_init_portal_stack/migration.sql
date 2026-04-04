CREATE TYPE bot_connection_status AS ENUM (
  'disconnected',
  'waiting_qr',
  'waiting_pairing',
  'connecting',
  'connected',
  'error'
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Portal User',
  timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
  locale TEXT NOT NULL DEFAULT 'it-IT',
  preferred_connection_mode TEXT NOT NULL DEFAULT 'qr',
  phone_number TEXT,
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bot_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL DEFAULT 'mock',
  status bot_connection_status NOT NULL DEFAULT 'disconnected',
  last_error TEXT,
  session_path TEXT,
  qr_code_data_url TEXT,
  pairing_code TEXT,
  phone_number TEXT,
  connected_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_instances_user_id_name_key UNIQUE (user_id, name)
);

CREATE TABLE bot_session_metadata (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL UNIQUE REFERENCES bot_instances(id) ON DELETE CASCADE,
  session_key TEXT,
  provider_session_id TEXT,
  is_persisted BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE service_categories (
  category_id BIGSERIAL PRIMARY KEY,
  category_name TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE services (
  service_id BIGSERIAL PRIMARY KEY,
  service_name TEXT NOT NULL UNIQUE,
  default_duration_min INTEGER NOT NULL CHECK (default_duration_min > 0),
  base_price NUMERIC(10,2),
  materials_cost NUMERIC(10,2),
  category TEXT,
  category_id BIGINT REFERENCES service_categories(category_id) ON DELETE SET NULL,
  emoji TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE service_synonyms (
  service_id BIGINT NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
  synonym TEXT NOT NULL,
  PRIMARY KEY (service_id, synonym)
);

CREATE TABLE service_allergens (
  service_id BIGINT NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
  allergen TEXT NOT NULL,
  PRIMARY KEY (service_id, allergen)
);

CREATE TABLE professionals (
  professional_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE professional_emails (
  professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  PRIMARY KEY (professional_id, email)
);

CREATE TABLE professional_services (
  professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(service_id) ON DELETE RESTRICT,
  PRIMARY KEY (professional_id, service_id)
);

CREATE TABLE professional_unavailable_weekdays (
  professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  PRIMARY KEY (professional_id, weekday)
);

CREATE TABLE clients (
  client_id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL
);

CREATE TABLE client_contacts (
  client_id BIGINT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL UNIQUE,
  PRIMARY KEY (client_id, type, value)
);

CREATE TABLE appointments (
  appointment_id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
  professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE RESTRICT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time)
);

CREATE INDEX ix_appointments_start_time ON appointments(start_time);

CREATE TABLE appointment_calendar (
  appointment_id BIGINT PRIMARY KEY REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'gcal',
  event_id TEXT NOT NULL UNIQUE
);

CREATE TABLE appointment_services (
  appointment_id BIGINT NOT NULL REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(service_id) ON DELETE RESTRICT,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  PRIMARY KEY (appointment_id, service_id)
);

CREATE TABLE appointment_flags (
  appointment_id BIGINT PRIMARY KEY REFERENCES appointments(appointment_id) ON DELETE CASCADE,
  confirm_asked_at TIMESTAMPTZ,
  review_asked_at TIMESTAMPTZ
);

CREATE TABLE salon_business_hours (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
  open_time TEXT,
  close_time TEXT,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE salon_lunch_breaks (
  lunch_break_id BIGSERIAL PRIMARY KEY,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE chat_sessions (
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
  last_review_prompt_service_id BIGINT REFERENCES services(service_id) ON DELETE SET NULL,
  last_review_prompt_professional_id BIGINT REFERENCES professionals(professional_id) ON DELETE SET NULL,
  last_review_reply_at TIMESTAMPTZ,
  reminder_choice INTEGER
);

CREATE TABLE chat_messages (
  message_id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(chat_id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_messages_chat_id_created_at_idx ON chat_messages(chat_id, created_at);

CREATE TABLE appointment_holds (
  hold_id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(chat_id) ON DELETE CASCADE,
  professional_id BIGINT NOT NULL REFERENCES professionals(professional_id) ON DELETE CASCADE,
  service_id BIGINT REFERENCES services(service_id) ON DELETE SET NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX appointment_holds_status_expires_at_idx ON appointment_holds(status, expires_at);
