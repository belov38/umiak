-- One-time codes of port SSO (S7 §7.7, §12.2): the api issues a code on
-- /sbx-auth/authorize, the gateway exchanges it once. Only sha256 of the
-- 32-byte code is stored. The worker cleanup deletes rows older than a day.
-- Plain SQL: the migration runner wraps the file in a transaction.

CREATE TABLE runtime.port_auth_codes (
  code_hash  bytea PRIMARY KEY,
  label      text NOT NULL,
  user_id    text NOT NULL,
  email      text NOT NULL,
  auth_epoch int NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX port_auth_codes_created_at_idx ON runtime.port_auth_codes (created_at);
