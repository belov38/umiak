-- S6 §7.8, S9 §24.8: a snapshot of a stopped VM is `powered_off` only after a
-- clean guest shutdown the worker saw. A hard stop leaves the disks as after a
-- power loss. The stop sets clean_stop with `stopped`; any other state clears
-- it, so a start, a crash or a failed restart never keeps an old confirmation.
-- Existing machines have no confirmation: fail closed.
ALTER TABLE runtime.machines ADD COLUMN clean_stop boolean NOT NULL DEFAULT false;

CREATE FUNCTION runtime.machines_clean_stop_reset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'stopped' THEN
    NEW.clean_stop := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machines_clean_stop_reset
  BEFORE UPDATE ON runtime.machines
  FOR EACH ROW EXECUTE FUNCTION runtime.machines_clean_stop_reset();
