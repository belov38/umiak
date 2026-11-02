-- R1: replace branded notification channels without rewriting migration history.
-- Function signatures and triggers are preserved; notifications remain transactional.

CREATE OR REPLACE FUNCTION runtime.sandboxes_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('umiak_sandboxes', NEW.id::text);
    RETURN NULL;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.health IS DISTINCT FROM OLD.health THEN
    PERFORM pg_notify('umiak_sandboxes', NEW.id::text);
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.blocked IS DISTINCT FROM OLD.blocked
     OR NEW.block_reason IS DISTINCT FROM OLD.block_reason THEN
    PERFORM pg_notify('umiak_routes', OLD.slug);
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN
      PERFORM pg_notify('umiak_routes', NEW.slug);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION runtime.hosted_ports_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_slug text;
  new_slug text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_slug := regexp_replace(OLD.label, '-[0-9]+$', '');
    PERFORM pg_notify('umiak_routes', old_slug);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_slug := regexp_replace(NEW.label, '-[0-9]+$', '');
    IF new_slug IS DISTINCT FROM old_slug THEN
      PERFORM pg_notify('umiak_routes', new_slug);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION runtime.operations_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('umiak_operations', NEW.id::text);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION identity.notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  collection text := TG_ARGV[0];
  old_key text;
  new_key text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'last_used_at') = (to_jsonb(OLD) - 'last_used_at') THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'memberships' THEN
    IF TG_OP <> 'INSERT' THEN old_key := OLD.user_id || ':' || OLD.team_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_key := NEW.user_id || ':' || NEW.team_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN old_key := OLD.id::text; END IF;
    IF TG_OP <> 'DELETE' THEN new_key := NEW.id::text; END IF;
  END IF;
  IF old_key IS NOT NULL THEN
    PERFORM pg_notify('umiak_identity', collection || ':' || old_key);
  END IF;
  IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
    PERFORM pg_notify('umiak_identity', collection || ':' || new_key);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION identity.notify_ssh_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payload text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'users' THEN
      payload := 'user:' || identity.public_id('usr', OLD.id);
    WHEN 'memberships' THEN
      payload := 'member:' || identity.public_id('team', OLD.team_id)
        || ':' || identity.public_id('usr', OLD.user_id);
    WHEN 'api_keys' THEN
      payload := 'key:' || identity.public_id('key', OLD.id);
    WHEN 'teams' THEN
      payload := 'team:' || identity.public_id('team', OLD.id);
  END CASE;
  PERFORM pg_notify('umiak_ssh_revoke', payload);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION runtime.desktop_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sb uuid; slug_value text;
BEGIN
 IF TG_OP='DELETE' THEN sb:=OLD.sandbox_id; ELSE sb:=NEW.sandbox_id; END IF;
 SELECT slug INTO slug_value FROM runtime.sandboxes WHERE id=sb;
 IF slug_value IS NOT NULL THEN PERFORM pg_notify('umiak_routes',slug_value); END IF;
 RETURN NULL;
END;
$$;
