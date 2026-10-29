-- Control plane triggers (S6 §5.4, §14.1, §14.2 with S7 override O7, S7 §20.2 item 13).
-- Plain SQL: the migration runner wraps the file in a transaction.

-- machines.sandbox_id is set once and never changes (S2: a machine is not reused).
CREATE FUNCTION runtime.machines_sandbox_id_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id THEN
    RAISE EXCEPTION 'machines.sandbox_id of machine % is already set and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machines_sandbox_id_immutable
  BEFORE UPDATE OF sandbox_id ON runtime.machines
  FOR EACH ROW EXECUTE FUNCTION runtime.machines_sandbox_id_immutable();

-- NOTIFY sbx_sandboxes '<id>' when a sandbox appears or its state or health
-- changes (long-poll in S7, dashboard in S8).
-- NOTIFY sbx_routes '<slug>' when state, machine_id or slug changes; a rename
-- sends the old and then the new slug (gateway route cache, S7 O7).
CREATE FUNCTION runtime.sandboxes_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('sbx_sandboxes', NEW.id::text);
    RETURN NULL;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.health IS DISTINCT FROM OLD.health THEN
    PERFORM pg_notify('sbx_sandboxes', NEW.id::text);
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    PERFORM pg_notify('sbx_routes', OLD.slug);
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN
      PERFORM pg_notify('sbx_routes', NEW.slug);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER sandboxes_notify
  AFTER INSERT OR UPDATE ON runtime.sandboxes
  FOR EACH ROW EXECUTE FUNCTION runtime.sandboxes_notify();

-- NOTIFY sbx_routes '<slug>' on any hosted_ports change (mode, token, revoke,
-- label). The slug is the label without its trailing '-<port>' (S4 §4.2: a
-- slug never ends in '-<digits>'); a changed label notifies both slugs.
CREATE FUNCTION runtime.hosted_ports_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_slug text;
  new_slug text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_slug := regexp_replace(OLD.label, '-[0-9]+$', '');
    PERFORM pg_notify('sbx_routes', old_slug);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_slug := regexp_replace(NEW.label, '-[0-9]+$', '');
    IF new_slug IS DISTINCT FROM old_slug THEN
      PERFORM pg_notify('sbx_routes', new_slug);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER hosted_ports_notify
  AFTER INSERT OR UPDATE OR DELETE ON runtime.hosted_ports
  FOR EACH ROW EXECUTE FUNCTION runtime.hosted_ports_notify();

-- NOTIFY sbx_operations '<id>' when an operation reaches a terminal state
-- (GET /operations/{id}?waitSeconds in S7).
CREATE FUNCTION runtime.operations_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sbx_operations', NEW.id::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER operations_notify
  AFTER UPDATE OF state ON runtime.operations
  FOR EACH ROW
  WHEN (NEW.state IN ('succeeded', 'failed', 'superseded') AND NEW.state IS DISTINCT FROM OLD.state)
  EXECUTE FUNCTION runtime.operations_notify();
