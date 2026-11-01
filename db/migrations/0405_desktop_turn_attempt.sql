-- TURN renewal order: a desktop whose guest did not answer goes behind the others.
ALTER TABLE runtime.sandbox_desktops ADD COLUMN turn_attempted_at timestamptz;
