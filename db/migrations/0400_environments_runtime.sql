-- Team environments move from identity.environments to runtime.environments
-- (S8 §10.3, §17.3). Teams and users now live in the Payload schema, so the
-- foreign keys of the stand-in table to identity.teams / identity.users would
-- reject environments of new teams; team_id and updated_by are plain uuids
-- here. The sets {env, secrets, secretFiles} stay an AES-256-GCM blob with AAD
-- `environment:<id>:v<key_version>`, so rows are copied with the same ids.
-- identity.environments is kept: expand/contract, the table is dropped in a
-- later release. Plain SQL: the migration runner wraps the file in a
-- transaction.

CREATE TABLE runtime.environments (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id               uuid NOT NULL,
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
  updated_by            uuid,
  UNIQUE (team_id, name)
);

-- At most one default environment per team.
CREATE UNIQUE INDEX environments_one_default ON runtime.environments (team_id)
  WHERE is_default;

INSERT INTO runtime.environments
  (id, team_id, name, is_default, revision, key_version, nonce, ciphertext,
   repositories, exclude_owner_secrets, created_at, updated_at, updated_by)
SELECT id, team_id, name, is_default, revision, key_version, nonce, ciphertext,
       repositories, exclude_owner_secrets, created_at, updated_at, updated_by
  FROM identity.environments;
