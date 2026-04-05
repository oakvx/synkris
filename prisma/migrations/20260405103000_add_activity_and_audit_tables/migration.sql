CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_role TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_created_at_idx ON audit_events(created_at);
CREATE INDEX audit_events_category_created_at_idx ON audit_events(category, created_at);

CREATE TABLE bot_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES bot_instances(id) ON DELETE SET NULL,
  level TEXT NOT NULL DEFAULT 'info',
  code TEXT NOT NULL,
  status bot_connection_status,
  provider TEXT,
  message TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bot_events_user_id_created_at_idx ON bot_events(user_id, created_at);
CREATE INDEX bot_events_instance_id_created_at_idx ON bot_events(instance_id, created_at);
