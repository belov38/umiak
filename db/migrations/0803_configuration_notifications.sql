-- S24: notifications are transactional even for direct SQL writes.
CREATE OR REPLACE FUNCTION runtime.public_id(prefix text, id uuid) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  b bytea := decode(replace(id::text, '-', ''), 'hex');
  body text := '';
  v int;
  k int;
BEGIN
  FOR i IN 0..25 LOOP
    v := 0;
    FOR j IN 0..4 LOOP
      -- Bit k of the uuid, counted from its most significant bit; get_bit
      -- numbers the bits of each byte from the least significant one.
      k := i * 5 + j - 2;
      v := v * 2;
      IF k >= 0 THEN
        v := v + get_bit(b, (k / 8) * 8 + 7 - (k % 8));
      END IF;
    END LOOP;
    body := body || substr(alphabet, v + 1, 1);
  END LOOP;
  RETURN prefix || '_' || body;
END;
$$;


CREATE OR REPLACE FUNCTION runtime.configuration_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 doc jsonb;
 slug text := replace(TG_TABLE_NAME,'_','-');
 message text;
 bookkeeping text[] := ARRAY['last_used_at','last_login_at','updated_at'];
 changed boolean := true;
BEGIN
 IF TG_OP='DELETE' THEN doc := to_jsonb(OLD); ELSE doc := to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='users' THEN bookkeeping := bookkeeping || ARRAY['groups','preferred_username']; END IF;
 IF TG_OP='UPDATE' THEN changed := (to_jsonb(OLD)-bookkeeping) IS DISTINCT FROM (to_jsonb(NEW)-bookkeeping); END IF;
 IF TG_TABLE_NAME IN ('users','teams','memberships','api_keys','ssh_keys') AND changed THEN
  IF TG_TABLE_NAME='memberships' THEN message := 'memberships:' || (doc->>'user_id') || ':' || (doc->>'team_id');
  ELSE message := slug || ':' || (doc->>'id'); END IF;
  PERFORM pg_notify('umiak_identity',message);
 END IF;
 IF TG_TABLE_NAME IN ('templates','sizes','pool_targets','platform_defaults') OR
    (TG_TABLE_NAME='teams' AND (TG_OP<>'UPDATE' OR
      (to_jsonb(OLD)->'quota_max_active_sandboxes') IS DISTINCT FROM (doc->'quota_max_active_sandboxes') OR
      (to_jsonb(OLD)->'quota_max_ram_mb') IS DISTINCT FROM (doc->'quota_max_ram_mb') OR
      (to_jsonb(OLD)->'quota_max_saved_snapshots') IS DISTINCT FROM (doc->'quota_max_saved_snapshots'))) THEN
  IF TG_TABLE_NAME='platform_defaults' THEN message := 'platform-defaults:global'; ELSE message := slug || ':' || (doc->>'id'); END IF;
  PERFORM pg_notify('umiak_config',message);
 END IF;
 IF TG_TABLE_NAME='platform_defaults' AND (TG_OP<>'UPDATE' OR
    (to_jsonb(OLD)->'public_ports_enabled') IS DISTINCT FROM (doc->'public_ports_enabled') OR
    (to_jsonb(OLD)->'public_desktop_enabled') IS DISTINCT FROM (doc->'public_desktop_enabled')) THEN
  PERFORM pg_notify('umiak_routes','*');
 END IF;
 IF TG_TABLE_NAME='users' AND ((TG_OP='DELETE' AND (to_jsonb(OLD)->'active') IS DISTINCT FROM 'false'::jsonb) OR
    (TG_OP='UPDATE' AND (to_jsonb(OLD)->'active') IS DISTINCT FROM 'false'::jsonb AND doc->'active'='false'::jsonb)) THEN
  PERFORM pg_notify('umiak_ssh_revoke','user:' || runtime.public_id('usr',OLD.id));
 ELSIF TG_TABLE_NAME='memberships' AND TG_OP='DELETE' THEN
  PERFORM pg_notify('umiak_ssh_revoke','member:' || runtime.public_id('team',OLD.team_id) || ':' || runtime.public_id('usr',OLD.user_id));
 ELSIF TG_TABLE_NAME='teams' AND TG_OP='DELETE' THEN
  PERFORM pg_notify('umiak_ssh_revoke','team:' || runtime.public_id('team',OLD.id));
 ELSIF TG_TABLE_NAME='api_keys' AND TG_OP IN ('UPDATE','DELETE') AND (to_jsonb(OLD)->>'revoked_at') IS NULL THEN
  IF TG_OP='DELETE' OR (doc->>'revoked_at') IS NOT NULL OR (to_jsonb(OLD)->'secret_hash') IS DISTINCT FROM (doc->'secret_hash') THEN
   PERFORM pg_notify('umiak_ssh_revoke','key:' || runtime.public_id('key',OLD.id));
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.users FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.teams FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.memberships FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.api_keys FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.ssh_keys FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.templates FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.sizes FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.pool_targets FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
CREATE TRIGGER configuration_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.platform_defaults FOR EACH ROW EXECUTE FUNCTION runtime.configuration_notify();
