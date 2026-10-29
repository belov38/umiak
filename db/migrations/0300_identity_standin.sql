-- Identity stand-in until S8 (S7 plan decision 2): users, teams, memberships,
-- team API keys, SSH keys and environments behind IdentityStore and
-- EnvironmentStore of packages/auth. S8 replaces it with Payload collections.
-- Ids are UUIDs (S7 §17.3). Plain SQL: the migration runner wraps the file in
-- a transaction.

CREATE SCHEMA identity;

CREATE TABLE identity.teams (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL,
  -- The team created at the first login of a user (S8 §6.1).
  personal   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.users (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Stored lowercased (S8 §5.2), so a plain unique constraint is case-insensitive.
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text,
  active          boolean NOT NULL DEFAULT true,
  is_operator     boolean NOT NULL DEFAULT false,
  -- `sub` of the IdP (S8 §5.3); null for seeded users that never logged in.
  idp_subject     text UNIQUE,
  default_team_id uuid REFERENCES identity.teams (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.memberships (
  user_id    uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES identity.teams (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

CREATE INDEX memberships_team_idx ON identity.memberships (team_id);

-- Team API keys (S7 §7.2): only sha256(secret) is stored.
CREATE TABLE identity.api_keys (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kind           text NOT NULL DEFAULT 'team' CHECK (kind IN ('team')),
  sandbox_id     uuid,
  team_id        uuid NOT NULL REFERENCES identity.teams (id) ON DELETE CASCADE,
  name           text NOT NULL,
  secret_hash    text NOT NULL UNIQUE,
  prefix         text NOT NULL,
  last4          text NOT NULL,
  scopes         text[] NOT NULL,
  created_by     uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  created_via    text NOT NULL CHECK (created_via IN ('api', 'cli', 'dashboard')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  revoked_by_key uuid REFERENCES identity.api_keys (id) ON DELETE SET NULL
);

CREATE INDEX api_keys_team_idx ON identity.api_keys (team_id, created_at);

CREATE TABLE identity.ssh_keys (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  public_key   text NOT NULL,
  fingerprint  text NOT NULL UNIQUE,
  type         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX ssh_keys_user_idx ON identity.ssh_keys (user_id, created_at);

-- Environments of a team (S8 §10). The sets {env, secrets, secretFiles} are an
-- AES-256-GCM blob with AAD `environment:<id>:v<key_version>` (S6 §13.1).
CREATE TABLE identity.environments (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id               uuid NOT NULL REFERENCES identity.teams (id) ON DELETE CASCADE,
  name                  text NOT NULL,
  is_default            boolean NOT NULL DEFAULT false,
  revision              int NOT NULL DEFAULT 1,
  key_version           int NOT NULL,
  nonce                 bytea NOT NULL,
  ciphertext            bytea NOT NULL,
  repositories          jsonb NOT NULL DEFAULT '[]',
  exclude_owner_secrets boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES identity.users (id) ON DELETE SET NULL,
  UNIQUE (team_id, name)
);

-- At most one default environment per team.
CREATE UNIQUE INDEX environments_one_default ON identity.environments (team_id)
  WHERE is_default;

-- NOTIFY sbx_identity '<table>:<id>' after a change (S8 §8, S7 §7.2, §7.4);
-- delivered after commit, so a listener reads the new data. Memberships have a
-- composite key: 'memberships:<user_id>:<team_id>'. Updates that only touch
-- last_used_at (touchApiKey, touchSshKey) and no-op updates do not notify.
CREATE FUNCTION identity.notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
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
    PERFORM pg_notify('sbx_identity', TG_TABLE_NAME || ':' || old_key);
  END IF;
  IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
    PERFORM pg_notify('sbx_identity', TG_TABLE_NAME || ':' || new_key);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_notify AFTER INSERT OR UPDATE OR DELETE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION identity.notify_change();
CREATE TRIGGER memberships_notify AFTER INSERT OR UPDATE OR DELETE ON identity.memberships
  FOR EACH ROW EXECUTE FUNCTION identity.notify_change();
CREATE TRIGGER api_keys_notify AFTER INSERT OR UPDATE OR DELETE ON identity.api_keys
  FOR EACH ROW EXECUTE FUNCTION identity.notify_change();
CREATE TRIGGER ssh_keys_notify AFTER INSERT OR UPDATE OR DELETE ON identity.ssh_keys
  FOR EACH ROW EXECUTE FUNCTION identity.notify_change();
