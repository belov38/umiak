-- Rotating a team key (POST /v1/api-keys/{key}/rotate) ends what was
-- authorized by the old secret: open SSH sessions of the key get
-- NOTIFY sbx_ssh_revoke 'key:<key_...>' (as on revocation, 0302), and
-- ssh/authorize refuses login certificates issued before rotated_at.
-- Plain SQL: the migration runner wraps the file in a transaction.

ALTER TABLE identity.api_keys ADD COLUMN rotated_at timestamptz;

CREATE TRIGGER api_keys_ssh_revoke_rotate AFTER UPDATE OF secret_hash ON identity.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND OLD.secret_hash IS DISTINCT FROM NEW.secret_hash)
  EXECUTE FUNCTION identity.notify_ssh_revoke();
