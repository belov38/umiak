-- NOTIFY sbx_ssh_revoke for open SSH sessions (S4 §9.5) from the identity
-- stand-in, in the transaction of the change, whoever writes it (the store,
-- the identity file, an operator's SQL). S8 sends the same payloads from
-- Payload hooks. Payloads carry public ids (S7 §5.3), the format the gateway
-- compares with the ids of ssh/authorize answers:
--   user deactivated or deleted -> user:<usr_...>
--   membership removed          -> member:<team_...>:<usr_...>
--   API key revoked (or deleted while live) -> key:<key_...>
--   team deleted                -> team:<team_...>
-- Plain SQL: the migration runner wraps the file in a transaction.

-- Public id of a UUID, as encodeUuid of @sbx/auth: prefix "_" 26 characters
-- of Crockford base32 (lower case) over 130 bits, the top two zero.
CREATE FUNCTION identity.public_id(prefix text, id uuid) RETURNS text
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

CREATE FUNCTION identity.notify_ssh_revoke() RETURNS trigger
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
  PERFORM pg_notify('sbx_ssh_revoke', payload);
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_ssh_revoke AFTER UPDATE OF active ON identity.users
  FOR EACH ROW WHEN (OLD.active AND NOT NEW.active)
  EXECUTE FUNCTION identity.notify_ssh_revoke();
CREATE TRIGGER users_ssh_revoke_delete AFTER DELETE ON identity.users
  FOR EACH ROW WHEN (OLD.active)
  EXECUTE FUNCTION identity.notify_ssh_revoke();
CREATE TRIGGER memberships_ssh_revoke AFTER DELETE ON identity.memberships
  FOR EACH ROW EXECUTE FUNCTION identity.notify_ssh_revoke();
CREATE TRIGGER api_keys_ssh_revoke AFTER UPDATE OF revoked_at ON identity.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION identity.notify_ssh_revoke();
CREATE TRIGGER api_keys_ssh_revoke_delete AFTER DELETE ON identity.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL)
  EXECUTE FUNCTION identity.notify_ssh_revoke();
CREATE TRIGGER teams_ssh_revoke AFTER DELETE ON identity.teams
  FOR EACH ROW EXECUTE FUNCTION identity.notify_ssh_revoke();
