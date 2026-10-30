-- `updatedAt` of the Sandbox resource (S7 §8.1): the time of the last change
-- of the row, set by a trigger on every UPDATE. Plain SQL: the migration
-- runner wraps the file in a transaction.

ALTER TABLE runtime.sandboxes
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION runtime.sandboxes_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandboxes_touch
  BEFORE UPDATE ON runtime.sandboxes
  FOR EACH ROW EXECUTE FUNCTION runtime.sandboxes_touch();
