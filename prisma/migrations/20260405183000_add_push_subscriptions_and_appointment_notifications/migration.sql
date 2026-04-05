CREATE TABLE device_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_device_push_subscriptions_user_id
  ON device_push_subscriptions(user_id);

CREATE OR REPLACE FUNCTION sync_device_push_subscriptions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_push_subscriptions_updated_at
  BEFORE UPDATE ON device_push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION sync_device_push_subscriptions_updated_at();

CREATE OR REPLACE FUNCTION notify_appointment_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_kind TEXT;
  payload JSON;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_kind := 'created';
    payload := json_build_object(
      'eventKind', event_kind,
      'appointmentId', NEW.appointment_id,
      'status', NEW.status,
      'startTime', NEW.start_time,
      'endTime', NEW.end_time,
      'at', now()
    );
    PERFORM pg_notify('appointment_events', payload::text);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    event_kind := CASE
      WHEN COALESCE(OLD.status, '') <> 'cancelled' AND NEW.status = 'cancelled' THEN 'cancelled'
      ELSE 'updated'
    END;

    payload := json_build_object(
      'eventKind', event_kind,
      'appointmentId', NEW.appointment_id,
      'status', NEW.status,
      'previousStatus', OLD.status,
      'startTime', NEW.start_time,
      'endTime', NEW.end_time,
      'at', now()
    );
    PERFORM pg_notify('appointment_events', payload::text);
    RETURN NEW;
  END IF;

  payload := json_build_object(
    'eventKind', 'deleted',
    'appointmentId', OLD.appointment_id,
    'status', OLD.status,
    'startTime', OLD.start_time,
    'endTime', OLD.end_time,
    'clientId', OLD.client_id,
    'professionalId', OLD.professional_id,
    'at', now()
  );
  PERFORM pg_notify('appointment_events', payload::text);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_appointments_notify_change ON appointments;

CREATE TRIGGER trg_appointments_notify_change
  AFTER INSERT OR UPDATE OR DELETE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION notify_appointment_events();
