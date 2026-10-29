-- Control plane schema (S6 §5.1-5.9, §8.3). Owned by S6 (range 0200-0299).
-- Plain SQL: the migration runner wraps the file in a transaction.
--
-- Foreign keys exist where the spec marks a column `fk` (topology, builds,
-- snapshots). Sandbox, machine and operation references stay plain uuids: rows
-- are written in an order the FKs would forbid (idempotency key first, decision
-- 3) and tombstones are purged independently. No FKs to schema tunnel (S2).
-- Ids default to uuidv7() (Postgres 18) but are normally generated in code.

CREATE SCHEMA runtime;

-- §5.1 Topology

CREATE TABLE runtime.providers (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  kind           text NOT NULL CHECK (kind IN ('proxmox')),
  name           text NOT NULL UNIQUE,
  cluster_mac_id smallint NOT NULL UNIQUE CHECK (cluster_mac_id BETWEEN 0 AND 255),
  vmid_min       int NOT NULL,
  vmid_max       int NOT NULL,
  api_url        text NOT NULL,
  tls_name       text,
  secret_ref     text NOT NULL,
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'draining', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (vmid_min > 0 AND vmid_min <= vmid_max)
);

CREATE TABLE runtime.nodes (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_id       uuid NOT NULL REFERENCES runtime.providers (id),
  name              text NOT NULL,
  state             text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cordoned', 'down')),
  ram_cap_mb        int NOT NULL CHECK (ram_cap_mb >= 0),
  clone_concurrency int NOT NULL DEFAULT 4 CHECK (clone_concurrency > 0),
  node_agent_ref    text NOT NULL,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);

CREATE TABLE runtime.storages (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_id  uuid NOT NULL REFERENCES runtime.providers (id),
  node_id      uuid REFERENCES runtime.nodes (id),  -- null for shared storage (phase 2)
  name         text NOT NULL,
  driver       text NOT NULL CHECK (driver IN ('lvmthin')),
  data_max_pct int NOT NULL DEFAULT 80 CHECK (data_max_pct BETWEEN 1 AND 100),
  meta_max_pct int NOT NULL DEFAULT 70 CHECK (meta_max_pct BETWEEN 1 AND 100),
  usage        jsonb,
  usage_at     timestamptz,
  UNIQUE NULLS NOT DISTINCT (provider_id, node_id, name)
);

-- §5.2 Template builds

CREATE TABLE runtime.template_builds (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  template_slug  text NOT NULL,
  version        text NOT NULL,
  os             text NOT NULL CHECK (os IN ('linux', 'windows')),
  provider_id    uuid NOT NULL REFERENCES runtime.providers (id),
  node_id        uuid NOT NULL REFERENCES runtime.nodes (id),
  storage_id     uuid NOT NULL REFERENCES runtime.storages (id),
  pve_vmid       int NOT NULL,
  disk_layout    jsonb NOT NULL,
  hw             jsonb NOT NULL,
  agent_version  text,  -- unknown for a seeded pre-S5 template
  boot_timeout_s int NOT NULL CHECK (boot_timeout_s > 0),
  status         text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'active', 'deprecated', 'retired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  promoted_at    timestamptz
);

-- At most one active build per template and node.
CREATE UNIQUE INDEX template_builds_active_uq
  ON runtime.template_builds (template_slug, node_id) WHERE status = 'active';

-- §5.3 Allocator

CREATE TABLE runtime.vmid_leases (
  provider_id uuid NOT NULL REFERENCES runtime.providers (id),
  vmid        int NOT NULL,
  mac         text NOT NULL,
  state       text NOT NULL CHECK (state IN ('reserved', 'active', 'releasing')),
  purpose     text NOT NULL CHECK (purpose IN ('machine', 'template')),
  machine_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, vmid),
  UNIQUE (provider_id, mac)
);

CREATE UNIQUE INDEX vmid_leases_machine_uq
  ON runtime.vmid_leases (machine_id) WHERE machine_id IS NOT NULL AND state <> 'releasing';

-- §5.5 Snapshots (before machines: machines.origin_snapshot_id references it)

CREATE TABLE runtime.snapshots (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  kind                text NOT NULL CHECK (kind IN ('auto', 'saved', 'fork_source')),
  team_id             uuid NOT NULL,
  name                text,
  pending_name        text,
  source_sandbox_id   uuid,
  source_machine_id   uuid,
  consumer_sandbox_id uuid,
  provider_id         uuid NOT NULL REFERENCES runtime.providers (id),
  node_id             uuid NOT NULL REFERENCES runtime.nodes (id),
  storage_id          uuid NOT NULL REFERENCES runtime.storages (id),
  template_build_id   uuid NOT NULL REFERENCES runtime.template_builds (id),
  lv_id               text NOT NULL UNIQUE CHECK (lv_id ~ '^[0-9a-f]{32}$'),  -- id without dashes (decision 2)
  hw                  jsonb,
  consistency         text CHECK (consistency IN ('quiesced', 'crash', 'powered_off')),
  quiesce_broken      boolean NOT NULL DEFAULT false,
  state               text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'ready', 'failed', 'deleting', 'deleted')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  deleted_at          timestamptz,
  version             int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX snapshots_saved_name_uq
  ON runtime.snapshots (team_id, name) WHERE kind = 'saved' AND state = 'ready';

-- §5.4 Machines and disks

CREATE TABLE runtime.machines (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),  -- = machineId in smbios (S2)
  provider_id         uuid NOT NULL REFERENCES runtime.providers (id),
  node_id             uuid NOT NULL REFERENCES runtime.nodes (id),
  storage_id          uuid NOT NULL REFERENCES runtime.storages (id),
  vmid                int,
  mac                 text,
  template_build_id   uuid NOT NULL REFERENCES runtime.template_builds (id),
  origin              text NOT NULL CHECK (origin IN ('template', 'snapshot')),
  origin_snapshot_id  uuid REFERENCES runtime.snapshots (id),  -- set once the source snapshot exists
  pool_key            text,
  size_slug           text NOT NULL,
  vcpu                int NOT NULL CHECK (vcpu > 0),
  memory_mb           int NOT NULL CHECK (memory_mb > 0),
  sandbox_id          uuid,  -- set once, never changes (trigger in 0201)
  state               text NOT NULL CHECK (state IN (
                        'allocating', 'provisioning', 'booting', 'warm', 'claiming', 'running',
                        'stopping', 'stopped', 'starting', 'failed', 'deleting', 'deleted')),
  power_observed      text NOT NULL DEFAULT 'unknown' CHECK (power_observed IN ('running', 'stopped', 'paused', 'unknown')),
  power_observed_at   timestamptz,
  unexpected_stops    jsonb NOT NULL DEFAULT '[]',
  provisioned_boot_id text,
  ready_boot_id       text,  -- boot_id on which the agent reported pool_ready (decision 4)
  agent_phase         text,  -- last agent phase (decision 5)
  exec_attempt        int NOT NULL DEFAULT 0,
  error_code          text,
  error_detail        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  warm_at             timestamptz,
  claimed_at          timestamptz,
  deleted_at          timestamptz,
  state_changed_at    timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 0
);

CREATE INDEX machines_node_state_idx ON runtime.machines (node_id, state);
CREATE INDEX machines_pool_state_idx ON runtime.machines (pool_key, state);
CREATE INDEX machines_sandbox_idx ON runtime.machines (sandbox_id);

CREATE TABLE runtime.disks (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  machine_id  uuid REFERENCES runtime.machines (id),
  snapshot_id uuid REFERENCES runtime.snapshots (id),
  storage_id  uuid NOT NULL REFERENCES runtime.storages (id),
  slot        text NOT NULL CHECK (slot IN ('efidisk0', 'scsi0', 'tpmstate0')),
  volume      text NOT NULL,
  size_bytes  bigint,  -- S1 DiskSet carries no size
  options     jsonb NOT NULL DEFAULT '{}',
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CHECK (num_nonnulls(machine_id, snapshot_id) = 1)
);

CREATE INDEX disks_machine_idx ON runtime.disks (machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX disks_snapshot_idx ON runtime.disks (snapshot_id) WHERE snapshot_id IS NOT NULL;

-- §5.6 Sandboxes

CREATE TABLE runtime.sandboxes (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  slug                   text NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 3 AND 40),  -- grammar checked in core
  team_id                uuid NOT NULL,
  created_by             uuid,  -- null for a team API key (S7 §20.2 item 9)
  created_by_key         uuid,
  name                   text,
  labels                 jsonb NOT NULL DEFAULT '{}',
  template_slug          text NOT NULL,
  size_slug              text NOT NULL,
  vcpu                   int NOT NULL CHECK (vcpu > 0),
  memory_mb              int NOT NULL CHECK (memory_mb > 0),
  template_build_id      uuid NOT NULL REFERENCES runtime.template_builds (id),
  origin                 text NOT NULL CHECK (origin IN ('template', 'snapshot', 'fork')),
  origin_snapshot_id     uuid,
  forked_from_sandbox_id uuid,
  provider_id            uuid REFERENCES runtime.providers (id),
  node_id                uuid REFERENCES runtime.nodes (id),
  machine_id             uuid,
  state                  text NOT NULL CHECK (state IN (
                           'creating', 'ready', 'stopping', 'stopped', 'starting', 'error', 'deleting', 'deleted')),
  stop_reason            text CHECK (stop_reason IN ('user', 'ttl', 'idle', 'unexpected_shutdown', 'retention')),
  health                 text NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'degraded')),
  health_reason          text,
  degraded_since         timestamptz,
  activity               text NOT NULL DEFAULT 'unknown' CHECK (activity IN ('busy', 'idle', 'unknown')),
  activity_counters      jsonb,
  last_activity_at       timestamptz,
  last_api_call_at       timestamptz,
  ttl_seconds            int CHECK (ttl_seconds > 0),
  deadline_at            timestamptz,
  idle_timeout_seconds   int CHECK (idle_timeout_seconds > 0),
  last_reboot_at         timestamptz,
  last_reboot_reason     text,
  last_recover_at        timestamptz,
  error_code             text,
  error_message          text,
  listening_ports        jsonb,  -- last ports.changed (decision 5, S7 §20.2 item 8)
  created_at             timestamptz NOT NULL DEFAULT now(),
  ready_at               timestamptz,
  stopped_at             timestamptz,
  deleted_at             timestamptz,
  state_changed_at       timestamptz NOT NULL DEFAULT now(),
  version                int NOT NULL DEFAULT 0
);

CREATE INDEX sandboxes_team_created_idx ON runtime.sandboxes (team_id, created_at DESC);

CREATE TABLE runtime.sandbox_secrets (
  sandbox_id  uuid PRIMARY KEY,
  key_version int NOT NULL,
  nonce       bytea NOT NULL,
  ciphertext  bytea NOT NULL,  -- AES-256-GCM (§13)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime.sandbox_events (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  sandbox_id uuid NOT NULL,
  type       text NOT NULL,  -- state_changed | health_changed | operation_*
  from_state text,
  to_state   text,
  reason     text,
  data       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_events_sandbox_idx ON runtime.sandbox_events (sandbox_id, created_at);

-- §5.7 Operations and idempotency

CREATE TABLE runtime.operations (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  sandbox_id          uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN (
                        'create', 'fork', 'stop', 'resume', 'recover', 'delete', 'save_snapshot', 'reprovision')),
  state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
  request             jsonb NOT NULL DEFAULT '{}',  -- non-secret parameters only
  step                text,
  progress            jsonb NOT NULL DEFAULT '{}',
  attempt             int NOT NULL DEFAULT 0,
  error_code          text,
  error_message       text,
  retryable           boolean,
  requested_by        uuid,
  requested_by_key    uuid,  -- S7 §20.2 item 9
  parent_operation_id uuid,
  superseded_by       uuid,
  deadline_at         timestamptz,  -- null for delete (§7.9)
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  version             int NOT NULL DEFAULT 0
);

-- One active operation per sandbox.
CREATE UNIQUE INDEX operations_active_uq
  ON runtime.operations (sandbox_id) WHERE state IN ('pending', 'running');

CREATE TABLE runtime.idempotency_keys (
  principal_id uuid NOT NULL,  -- API key or user
  key          text NOT NULL,
  scope        text NOT NULL,  -- sandboxes.create, sandboxes.fork, ...
  request_hash bytea NOT NULL,  -- sha256 of the canonical request body
  operation_id uuid,
  sandbox_id   uuid,
  response     jsonb,  -- may be filled later in the same transaction
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (principal_id, scope, key)
);

CREATE INDEX idempotency_keys_expires_idx ON runtime.idempotency_keys (expires_at);

-- §5.8 Commands and ports

CREATE TABLE runtime.commands (
  id              text PRIMARY KEY,  -- ULID, = commandId for Process/Start (S2)
  sandbox_id      uuid NOT NULL,
  machine_id      uuid NOT NULL,
  cmd             text NOT NULL,  -- first 64 KiB
  cwd             text,
  env_keys        text[] NOT NULL DEFAULT '{}',  -- names only
  mode            text NOT NULL CHECK (mode IN ('sync', 'stream', 'detached', 'pty')),
  timeout_seconds int,
  status          text NOT NULL DEFAULT 'starting' CHECK (status IN (
                    'starting', 'running', 'exited', 'killed', 'timed_out', 'lost', 'failed_to_start')),
  exit_code       int,
  signal          text,
  stdout_bytes    bigint,
  stderr_bytes    bigint,
  boot_id         text,
  created_by      uuid,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  ended_at        timestamptz
);

CREATE INDEX commands_sandbox_created_idx ON runtime.commands (sandbox_id, created_at DESC);
CREATE INDEX commands_machine_active_idx
  ON runtime.commands (machine_id) WHERE status IN ('starting', 'running');

CREATE TABLE runtime.hosted_ports (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  sandbox_id uuid NOT NULL,
  port       int NOT NULL CHECK (port BETWEEN 1 AND 65535),
  label      text NOT NULL,  -- '<slug>-<port>'
  mode       text NOT NULL CHECK (mode IN ('token', 'sso', 'public')),
  token_hash bytea,
  auth_epoch int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX hosted_ports_sandbox_port_uq
  ON runtime.hosted_ports (sandbox_id, port) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX hosted_ports_label_uq
  ON runtime.hosted_ports (label) WHERE deleted_at IS NULL;

-- §5.9 Agent events

CREATE TABLE runtime.agent_events (
  machine_id   uuid NOT NULL,
  seq          bigint NOT NULL,
  boot_id      text NOT NULL,
  type         text NOT NULL,
  time         timestamptz NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (machine_id, seq)
);

CREATE INDEX agent_events_unprocessed_idx
  ON runtime.agent_events (machine_id) WHERE processed_at IS NULL;

CREATE TABLE runtime.agent_synthetic_events (
  machine_id   uuid NOT NULL,
  epoch        bigint NOT NULL,
  type         text NOT NULL,
  instance_id  text NOT NULL,
  time         timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (machine_id, epoch, type)
);

CREATE INDEX agent_synthetic_events_unprocessed_idx
  ON runtime.agent_synthetic_events (machine_id) WHERE processed_at IS NULL;

-- §8.3 Clone slots: a shared per-node semaphore for S1 clones.

CREATE TABLE runtime.node_clone_slots (
  node_id    uuid NOT NULL REFERENCES runtime.nodes (id),
  slot       int NOT NULL,
  holder     text,
  expires_at timestamptz,
  PRIMARY KEY (node_id, slot)
);
