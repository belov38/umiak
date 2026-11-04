# S6. Control plane core: specification

Status: agreed (the master session on Ilia's behalf), 2026-10-29. Supplemented with the MVP recommendations R2, R10, R11 (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29). Area S6 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§3 data model, §6 warm pool, §10 deployment, §11 security). Relies on `docs/specs/s1-proxmox-foundation.md` (primitives, allocator, SMBIOS §6.4, storage driver) and `docs/specs/s2-tunnel-protocol.md` (registry, events, `agent-client`, §15).

The mark **[S6 decision]** is a decision of the spec author within the brief without separate agreement; it can be changed during planning if the reason is recorded. The [S6 decision]s and the edits after the independent review were also approved by the master session. The rest was agreed with the master session on Ilia's behalf (answers to Q1–Q7 and to the open questions of §21, 2026-10-29).

## 1. Why

S6 is the TypeScript core between the public API (S7) and the infrastructure (S1 Proxmox, S2 tunnel). It knows which sandboxes and machines exist and in what state, performs create / stop / resume / fork / delete reliably under failures and retries, holds the warm pool, and reconciles the database with the reality of Proxmox.

What counts as success:
1. Create from the warm pool reaches `ready` in seconds; a cold create works when the pool is empty.
2. No operation leaves dangling VMs, LVs, VMIDs, or rows when a worker pod dies at any step; a retry brings it to the end.
3. Two operations on one sandbox never run at the same time; a repeated request with the same `Idempotency-Key` does not create a second sandbox.
4. The RAM on a node never exceeds the limit (8 GB in the PoC), even with parallel creates from several pods.
5. Long work of the agent inside a sandbox is never stopped for idleness.

## 2. Goals, non-goals, anti-goals

**Goals**
- The runtime data model in Postgres (schema `runtime`), ready for several clusters and nodes.
- The state machines of Sandbox, Machine, and Operation with explicit transitions and invariants.
- `apps/worker` on pg-boss: operation jobs, controllers (pool, health, auto-stop, reconcile, cleanup), horizontal scaling in Kubernetes.
- A warm pool accounting for RAM and template versions.
- Orchestration through the S1 primitives and the S2 events.
- Storage of sandbox env and secrets in encrypted form.
- Interfaces for S7 (the service layer), S4 (routes), S3 (agent RPC), S5 (registration of template builds), S8 (configuration).

**Non-goals (other areas)**
- The form of the public REST API, HTTP codes, NDJSON, SDKs (S7). Here only the service layer and domain error codes.
- Payload, UI, users, teams, API keys (S8). S6 only reads the configuration.
- Agent internals (S3), the gateway (S4), template builds (S5), Windows (S9).
- Moving a sandbox between nodes, archive to PBS, periodic snapshots, webhooks (phase 2).

**Anti-goals (a failure even if everything works)**
- A machine is given to a second sandbox or returned to the pool after a tenant has touched it.
- A secret (env, secret files, the bootstrap secret) gets into logs, pg-boss job data, `operations.request`, a snapshot, or metrics.
- The reconciler deleted something that is not marked as ours (not in the pool `umiak`, without the tag `umiak`, outside the VMID range).
- A sandbox with a running command or an open PTY was stopped for idleness.
- The sum of RAM on a node exceeded the limit due to a race of two pods.

## 3. Constraints

- The control plane in Kubernetes: `api`, `worker`, `web`, `gateway`. One Postgres, schemas: `runtime` (S6), `tunnel` (S2), `payload` (S8), `pgboss` (the queue).
- PoC: one node `pve`, the RAM of all sandboxes and warm machines ≤ 8 GB, VMID 500–598, storage `local-lvm` (S1).
- The toolchain from `mise.toml` (Node 26.13.0, pnpm 12.16.1). The library versions in §17 were checked on 2026-10-29; re-check during implementation (`CLAUDE.md`).
- The repository layout per `CLAUDE.md`: TS in `apps/` and `packages/`, vitest tests, biome lint.

## 4. Overview

```
                 apps/api (Hono)                         apps/worker (pg-boss)
   S7 routes ──> packages/core: SandboxService     ┌──> op handlers (sandbox-op, machine-op)
   /internal/v1/agent-events ─> core.events.ingest │    controllers: pool, health, autostop,
   /internal/v1/routes, ssh ──> core.routes        │    reconcile, cleanup
                 │                                 │         │              │
                 v                                 │         v              v
           Postgres: runtime.*, tunnel.*, pgboss.* ┘   packages/pve    packages/agent-client
                 ^                                     (S1: PVE API,   (S2: gateway -> agent)
                 │ ConfigReader                          umiak-node)
           Payload Local API (payload.*)  — packages/config
```

### 4.1 Packages

| Path | What | Who uses it |
|---|---|---|
| `packages/db` | The SQL migration runner from `db/migrations/` (§5.12); the Drizzle schema `runtime` and descriptions of the `tunnel` tables for types and queries; the Postgres implementation of `AllocatorStore` | core, worker, api |
| `packages/core` | Domain logic without HTTP: state machines (pure transition functions), `SandboxService`, admission and RAM accounting, idempotency, secret encryption, agent event intake, routes for S4 | api, worker |
| `packages/config` | `ConfigReader`: an implementation on the Payload Local API and a static one (YAML) for the PoC before S8 and for tests | core, worker, api |
| `packages/pve` | S1 as is; S6 substitutes the Postgres implementation of `AllocatorStore` (lives in `packages/db`) | worker |
| `packages/agent-client` | S2 as is | worker, api |
| `apps/worker` | The worker process: pg-boss queue registration, handlers, controllers, metrics, graceful shutdown | — |
| `apps/api` | S7. S6 gives it internal endpoints as thin wrappers over `packages/core` (§14.1) | — |

Rule: `packages/core` does not import `packages/pve` directly in code that runs in `api`; calls to Proxmox and the agent within operations are made only by the worker. `api` talks to the agent only for commands, files, and ports (S7) through `agent-client`.

## 5. Data model (schema `runtime`)

General rules [S6 decision]:
- Primary keys are UUIDv7 (`uuidv7()` from Postgres 18). Exceptions: `commands.id` is a ULID (S2 §9.1), `machines.id` = `machineId` from S2 (UUIDv7).
- Time is `timestamptz`. Enumerations are `text` with `CHECK` (migrations are simpler than with `enum`).
- Mutable rows with a state machine have `version int` for optimistic locking. A state transition is always `UPDATE … WHERE id = $1 AND state = ANY($from) RETURNING`; zero rows means a conflict.
- The public id format (prefixes, encoding) is decided by S7 on top of the UUID.

### 5.1 Topology (multi-cluster from day one)

```
providers(                         -- one Proxmox cluster
  id uuid pk, kind text,           -- 'proxmox'
  name text unique,
  cluster_mac_id smallint unique,  -- S1 UMIAK_CLUSTER_ID, byte 2 of the MAC
  vmid_min int, vmid_max int,      -- S1 UMIAK_VMID_RANGE
  api_url text, tls_name text,
  secret_ref text,                 -- name of the mounted Secret dir with token and CA, never the secret itself
  state text,                      -- active | draining | disabled
  created_at, updated_at)

nodes(
  id uuid pk, provider_id fk, name text,   -- 'pve'
  state text,                       -- active | cordoned | down
  ram_cap_mb int,                   -- budget for sandboxes on this node (8192 in the PoC)
  clone_concurrency int,            -- S1 limit, default 4
  node_agent_ref text,              -- umiak-node endpoint and Secret dir
  last_seen_at, created_at, updated_at,
  unique(provider_id, name))

storages(
  id uuid pk, provider_id fk, node_id fk null,  -- null for shared storage (phase 2)
  name text,                        -- 'local-lvm'
  driver text,                      -- 'lvmthin'
  data_max_pct int, meta_max_pct int,  -- S1: 80 / 70
  usage jsonb, usage_at,            -- last StorageDriver.usage()
  unique(provider_id, node_id, name))
```

Topology rows are created by a seed migration or the operator CLI (`umiak-admin` in `apps/worker`, §15). Secrets are only files from a Kubernetes Secret by `secret_ref` (S1 §6.1).

### 5.2 Template builds

```
template_builds(
  id uuid pk,
  template_slug text,               -- key of the Payload Template
  version text,                     -- build version from S5
  os text,                          -- linux | windows
  provider_id fk, node_id fk, storage_id fk,  -- template LVs are node-local
  pve_vmid int,                     -- e.g. 599
  disk_layout jsonb,                -- DiskSet slots and options (S1 §6.2)
  hw jsonb,                         -- whitelisted hardware keys (S1 §6.3)
  agent_version text,
  boot_timeout_s int,               -- default 300 linux, 1200 windows
  status text,                      -- building | active | deprecated | retired
  created_at, promoted_at)
-- at most one active build per (template_slug, node_id)
unique (template_slug, node_id) where status = 'active'
```

Written by S5 (the pipeline registers a build and moves it to `active`). Before S5 template 599 is created by a seed. The transition to `active` changes the pool generation (§9.4). `deprecated` is not used for new machines, but existing sandboxes on it live on: their disks are their own.

### 5.3 Allocator (from S1 §6.5)

```
vmid_leases(
  provider_id fk, vmid int, mac text,
  state text,                       -- reserved | active | releasing
  purpose text,                     -- machine | template
  machine_id uuid null,
  created_at, updated_at,
  primary key(provider_id, vmid), unique(provider_id, mac))
unique (machine_id) where machine_id is not null and state <> 'releasing'
```

`AllocatorStore` from `packages/pve` is implemented on top of this table. A free VMID is chosen as in S1: the smaller one from the range that is neither in the table, nor in Proxmox, nor among the LVs. Allocation is idempotent by `machine_id`: if a machine already has a lease not in `releasing`, it is returned (§7.4).

### 5.4 Machines and disks

```
machines(
  id uuid pk,                       -- = machineId in smbios (S2)
  provider_id fk, node_id fk, storage_id fk,
  vmid int null, mac text null,     -- null until allocated
  template_build_id fk,             -- lineage, also for forks
  origin text,                      -- template | snapshot
  origin_snapshot_id fk null,
  pool_key text null,               -- '<template_slug>/<size_slug>' while it is a pool machine
  size_slug text, vcpu int, memory_mb int,
  sandbox_id uuid null,             -- set once, never changes (trigger)
  state text,                       -- §6.2
  power_observed text,              -- running | stopped | paused | unknown
  power_observed_at,
  unexpected_stops jsonb,           -- timestamps of recent unexpected stops (§11.3)
  provisioned_boot_id text null,    -- boot_id on which env and secrets were last delivered (§10.2)
  secret_files_on_disk bool,        -- Windows: files may remain until a confirmed wipe (§7.8)
  secrets_generation int,           -- pending/reconnect/restart delivery requests, default 0
  provisioned_secrets_generation int, -- generation captured before the last successful delivery
  exec_attempt int,                 -- fencing token for machine-op handlers (§15.1)
  error_code text, error_detail text,
  created_at, warm_at, claimed_at, deleted_at, state_changed_at, version int)

disks(
  id uuid pk,
  machine_id fk null, snapshot_id fk null,   -- exactly one is set (CHECK)
  storage_id fk, slot text,         -- scsi0 | efidisk0 | tpmstate0
  volume text,                      -- LV name or volid
  size_bytes bigint, options jsonb,
  state text,                       -- active | deleting | deleted
  created_at, deleted_at)
```

A trigger forbids changing `machines.sandbox_id` if it is no longer `null`. This is the S2 rule "a machine is not reused".

`disks` mirrors what the driver returned (`DiskSet`, `SnapshotRef`). The reconciler compares it with `umiak-node lv.list`.

### 5.5 Snapshots

```
snapshots(
  id uuid pk,
  kind text,                        -- auto | saved | fork_source  (auto is reserved, not created in phase 1)
  team_id uuid,                     -- owner
  name text null,                   -- saved only, set when ready
  pending_name text null,           -- saved only, while creating
  source_sandbox_id uuid null, source_machine_id uuid null,
  consumer_sandbox_id uuid null,    -- fork_source: the fork target
  provider_id fk, node_id fk, storage_id fk,
  template_build_id fk,             -- lineage
  hw jsonb,                         -- S1 snapshot metadata (no smbios1, vmgenid, MAC, name)
  consistency text,                 -- quiesced | crash | powered_off
  quiesce_broken bool,              -- set by the quiesce.watchdog_thawed event (§10.2)
  state text,                       -- creating | ready | failed | deleting | deleted
  created_at, ready_at, deleted_at, version int)
unique (team_id, name) where kind = 'saved' and state = 'ready'
```

### 5.6 Sandboxes

```
sandboxes(
  id uuid pk,
  slug text unique,                 -- S4 §4.2 grammar, 3-40 chars, default three words (S7 §5.4); DNS label part, hostname umiak-<slug>
  team_id uuid, created_by uuid,    -- Payload ids
  name text null, labels jsonb,
  template_slug text, size_slug text,
  vcpu int, memory_mb int,          -- copied from the Size at create/resume time
  template_build_id fk,
  origin text,                      -- template | snapshot | fork
  origin_snapshot_id uuid null, forked_from_sandbox_id uuid null,
  provider_id fk null, node_id fk null,   -- fixed once disks exist
  machine_id uuid null,             -- current machine (1:N history via machines.sandbox_id)
  state text,                       -- §6.1
  stop_reason text null,            -- user | ttl | idle | unexpected_shutdown | retention
  health text,                      -- ok | degraded
  health_reason text null, degraded_since null,
  activity text,                    -- busy | idle | unknown
  activity_counters jsonb,          -- last {runningCommands, openPtys, tcpStreams} from the agent
  last_activity_at, last_api_call_at,
  ttl_seconds int null,             -- null = no TTL
  deadline_at null,                 -- TTL deadline
  idle_timeout_seconds int null,    -- null = no idle-stop
  last_reboot_at null, last_reboot_reason text null,
  last_recover_at null,
  error_code text null, error_message text null,
  created_at, ready_at, stopped_at, deleted_at, state_changed_at, version int)

sandbox_secrets(
  sandbox_id uuid pk,
  key_version int, nonce bytea, ciphertext bytea,  -- AES-256-GCM, §13
  updated_at)

sandbox_events(                     -- audit and outbox for later webhooks
  id uuid pk, sandbox_id, type text, -- state_changed | health_changed | operation_*
  from_state text null, to_state text null, reason text null,
  data jsonb, created_at)
```

A `deleted` row stays as a tombstone (for `GET` and audit) and is deleted by cleanup after 30 days [S6 decision].

### 5.7 Operations and idempotency

```
operations(
  id uuid pk,
  sandbox_id uuid,
  kind text,          -- create | fork | stop | resume | recover | delete | save_snapshot | reprovision
  state text,         -- pending | running | succeeded | failed | superseded
  request jsonb,      -- non-secret parameters only
  step text null,     -- last completed step
  progress jsonb,     -- step outputs (machine id, vmid, snapshot id, ...)
  attempt int,
  error_code text null, error_message text null, retryable bool null,
  requested_by uuid null,           -- principal (user or API key owner)
  parent_operation_id uuid null,    -- fork: target create -> source fork
  superseded_by uuid null,
  deadline_at,
  created_at, started_at, finished_at, version int)
-- one active operation per sandbox
unique (sandbox_id) where state in ('pending', 'running')

idempotency_keys(
  principal_id uuid, key text,      -- principal = API key or user
  scope text,                       -- 'sandboxes.create', 'sandboxes.fork', ...
  request_hash bytea,               -- key version || HMAC of the canonical request body (§13.1)
  operation_id uuid, sandbox_id uuid,
  response jsonb,                   -- what the service returned the first time
  created_at, expires_at,           -- 24 h
  primary key(principal_id, scope, key))
```

### 5.8 Commands and ports

```
commands(
  id text pk,                       -- ULID, = commandId for Process/Start (S2)
  sandbox_id uuid, machine_id uuid,
  cmd text,                         -- first 64 KiB
  cwd text null, env_keys text[],   -- variable names only, values are not stored
  mode text,                        -- sync | stream | detached | pty
  timeout_seconds int null,
  status text,                      -- starting | running | exited | killed | timed_out | lost | failed_to_start
  exit_code int null, signal text null,
  stdout_bytes bigint null, stderr_bytes bigint null,
  boot_id text null,                -- boot on which it was started
  created_by uuid null, request_id text null,
  created_at, started_at, ended_at)

hosted_ports(
  id uuid pk, sandbox_id uuid, port int,
  label text,                       -- '<slug>-<port>', DNS label for *.umiak.<domain>
  mode text,                        -- token | sso | public
  token_hash bytea null,            -- sha256 of the access token (mode=token)
  auth_epoch int,                   -- bumped on token rotation, mode change, revoke
  created_at, deleted_at)
unique (sandbox_id, port) where deleted_at is null
unique (label) where deleted_at is null
```

The `commands` records are created by S7 (before calling `Process/Start`), the status is updated by S7 (from the stream) and by the event handler (§10). A terminal status is not overwritten. Retention 90 days (cleanup).

### 5.9 Agent events

```
agent_events(
  machine_id uuid, seq bigint,
  boot_id text, type text, time timestamptz,
  payload jsonb,                    -- decoded payload
  received_at, processed_at null,
  primary key(machine_id, seq))

agent_synthetic_events(
  machine_id uuid, epoch bigint, type text,  -- S2 §9.6 key
  instance_id text, time timestamptz,
  received_at, processed_at null,
  primary key(machine_id, epoch, type))
```

Kept 7 days [S6 decision].

### 5.10 S2 tables (schema `tunnel`)

S6 writes only `tunnel_credentials.bs_hash` (when preparing a machine) and `tunnel_credentials.retired_at` (on delete). It reads `tunnel_sessions` (whether a machine is connected, `disconnected_at`, `boot_id`, `capabilities`) and `gateway_instances` (heartbeat freshness). The SQL migrations of the `tunnel` schema are written by S2 (`s2-impl`) in the shared directory, in the number range 0100–0199 (§5.12); `packages/db` describes these tables in Drizzle only for types and queries.

### 5.11 Configuration from Payload (S8)

Payload owns the editable configuration. S6 reads it through `ConfigReader`:

```ts
interface ConfigReader {
  template(slug: string): Promise<TemplateConfig | null>
  // { slug, os, enabled, defaultSize, allowedSizes[] }
  size(slug: string): Promise<SizeConfig | null>
  // { slug, vcpu, memoryMb }  (disk size comes from the template build in phase 1)
  poolTargets(): Promise<PoolTarget[]>
  // { templateSlug, sizeSlug, providerId?, target, maxAgeHours? }
  teamQuota(teamId: string): Promise<Quota>
  // { maxActiveSandboxes, maxRamMb, maxSavedSnapshots }
  defaults(): Promise<PlatformDefaults>
  // { ttlSeconds: null, maxTtlSeconds, idleTimeoutSeconds: 900, stoppedRetentionDays: null,
  //   errorRetentionDays: 7, recoverMinIntervalSeconds: 600 }
}
```

- The `PayloadConfigReader` implementation is the Payload Local API (`getPayload({ config })`, without Next). A cache in the process for 10 s; reset by `LISTEN umiak_config`. `NOTIFY umiak_config` is sent by `afterChange` hooks of the Payload collections (S8's duty).
- The Payload config must be importable from a package without Next (S8's duty, §16). Before S8 a `StaticConfigReader` with a YAML file is used (`UMIAK_CONFIG_FILE`).
- Users, teams, and API keys are read by S7; S6 receives an already verified `Principal { userId, teamId, apiKeyId?, scopes }`.

### 5.12 Migrations (a decision of the master session, concerns S2 too)

- One directory of SQL migrations for all runtime schemas: `db/migrations/NNNN_<name>.sql` — plain ordered SQL files, no on-the-fly generation.
- Number ranges: **0100–0199** — the schema `tunnel` (written by `s2-impl`), **0200+** — the schema `runtime` (S6). Schemas are created by their own migrations (`CREATE SCHEMA`).
- The runner lives in the S6 implementation (`packages/db`): applies files by number in a transaction, keeps a table of applied migrations with the file hash, and takes an advisory lock so that `api` and `worker` pods do not run migrations at the same time. A changed already-applied file is an error.
- The Drizzle schema in TS is needed for types and queries and must match the SQL (a test compares it with the live DB after migrations).
- Go tests (gateway, S2) apply the same files directly.
- Payload keeps its own migrations for the schema `payload`; pg-boss creates and updates the schema `pgboss` itself.

## 6. State machines

### 6.1 Sandbox

```
            create/fork/from-snapshot
                     |
                     v
                 creating ----------(fail)----------> error
                     |                                  |  ^
                  (ready)                       resume  |  | resume fails
                     v                                  v  |
   +------------->  ready  --stop/ttl/idle-->  stopping --+--> stopped
   |                 |  ^                                         |
   |        recover  |  |                                         | resume
   |                 v  |                                         v
   |              (recover op)                                starting
   +---------------------------------------(ready)----------------+
   any non-terminal --delete--> deleting --> deleted (terminal)
```

| State | Means | Commands and files (S7) |
|---|---|---|
| `creating` | a create, a fork target, or a create from a snapshot is running | wait for readiness (S7 decides how long) |
| `ready` | the VM is running, the agent has connected and is provisioned | work; with `health=degraded` — `503 agent_unavailable` per S2 |
| `stopping` | a shutdown is running | `409` |
| `stopped` | the VM is off, disks on the node, RAM free | `409 sandbox_not_ready` |
| `starting` | a resume is running (or a repeated start after recover from `error`) | wait |
| `error` | an operation failed with no automatic way back, `error_code` | `409` |
| `deleting` | a deletion is running | `409` |
| `deleted` | terminal | `404` (S7 decides) |

Transitions (only these; everything else is `invalid_state`):

| From | Operation / event | To | Who |
|---|---|---|---|
| — | create, fork (target), create from saved | `creating` | API |
| `creating` | create finished | `ready` | worker |
| `creating` | create failed | `error` | worker |
| `ready` | stop (user, TTL, idle) | `stopping` | API / controller |
| `stopping` | the VM is shut down | `stopped` | worker |
| `stopping` | stop failed after the deadline | `error` (`stop_failed`) | worker |
| `ready` | the VM shut down unexpectedly, the first time within an hour (§11.3) | `starting` (system resume) | reconciler |
| `ready` | the VM shut down unexpectedly a second time within an hour (§11.3) | `stopped` (`unexpected_shutdown`) | reconciler |
| `stopped`; `error` if the machine is `stopped` (VM and disks in place) | resume | `starting` | API |
| `starting` | the agent is connected, provisioned | `ready` | worker |
| `starting` | deadline or error | `error` (`resume_failed`) | worker |
| `ready`; `error` if the machine is not `failed`/`deleting`/`deleted` | recover | `starting` | API |
| `ready`, `stopped` | fork, save_snapshot | no state change (an operation on the source) | API |
| any except `deleting`/`deleted` | delete | `deleting` | API |
| `deleting` | deletion verified | `deleted` | worker |
| `creating`, `ready`, `stopped`, `starting`, `stopping` without an active operation | the machine's VM disappeared in Proxmox | `error` (`machine_lost`) | reconciler |

`error` with `machine_lost` is terminal in meaning: there is no VM config, and restoring a VM from the remaining disks is not available in phase 1. Only delete is allowed. If the disappearance is detected by a step of an active operation, the operation itself fails with the same code.

`error` with `machine_state_conflict`: a step of create (and of a fork target), stop, resume, or recover found the machine not in the state it expected (it was moved by another participant — reconcile, delete, a stale executor; the sandbox has no machine; the VMID is not recorded). The VM may exist, so the machine is not marked `machine_lost`. Like `machine_lost`, this code wins over the operation's code (`create_failed`, `stop_failed`, `resume_failed`). Create and a fork target hand their machines over for deletion (`deleting`, `machine-op delete`); stop, resume, and recover do not touch the machine (no hard stop) — it is handled by reconcile (§11). Then the general rules of `error` apply: delete — always; resume — if the machine is `stopped`; recover — if the machine is not `failed`/`deleting`/`deleted`.

`health` and `activity` are fields, not states:
- `health = degraded` if `state = ready` and the agent is absent for more than 60 s (§11.1). Return to `ok` on the event `connected`.
- `activity = busy | idle | unknown` from the agent's counters and API calls (§12). `unknown` while the agent is unavailable.

### 6.2 Machine

```
allocating -> provisioning -> booting -> warm -> claiming -> running <-> stopping/stopped/starting
                                   \                 ^
                                    \----------------/   (cold path: sandbox_id set from the start)
any -> deleting -> deleted          any -> failed -> deleting (auto)
```

| State | Means | RAM (§8.1) |
|---|---|---|
| `allocating` | the row was created as a RAM reservation, no VMID yet | reserved |
| `provisioning` | VMID and MAC allocated, BS written, config and disk clone in progress (S1 create/fork) | reserved |
| `booting` | the VM is started, waiting for the agent to connect and be ready | reserved, powered |
| `warm` | in the pool, the agent is connected, ready for claim (only `pool_key` non-null, `sandbox_id` null) | reserved, powered |
| `claiming` | assigned to a sandbox, MT rotation and `System/Claim` in progress | reserved, powered |
| `running` | running for a sandbox | reserved, powered |
| `stopping` / `starting` | power transitions | reserved, powered |
| `stopped` | off, disks present | reserved, only if waiting for resume/recover |
| `failed` | preparation failed or the machine is lost; the worker itself moves it to `deleting` (unless it is needed for diagnostics of the sandbox `error`) | powered while the VM is not stopped |
| `deleting` | `retired_at` is set, S1 delete with verification in progress | powered while the VM is not stopped |
| `deleted` | the VMID is released, no LVs | — |

A machine from the pool (`pool_key` non-null) after claim loses `pool_key` and never returns to `warm`.

### 6.3 Operation

`pending → running → succeeded | failed | superseded`. `superseded` is set only by delete (§7.2). A repeat of a step after a worker crash does not change the operation's state: it stays `running`, `attempt` grows.

### 6.4 Invariants

1. No more than one active operation per sandbox (a unique partial index) and no more than one executor of an operation (fencing by `attempt`, §15.1).
2. `machines.sandbox_id` does not change once set (a trigger). A machine that has been in `claiming` is deleted after a failure, not returned to the pool.
3. `sandbox.state = ready` ⇒ the current machine has `state = running`. The exception is the window before reconcile detects an unexpected shutdown (up to 60 s, §11.3).
4. For each node `reserved ≤ ram_cap_mb` and `powered ≤ ram_cap_mb` (§8.1): the first is ensured by admission, the second by a check before every VM start. Both under the node's advisory lock.
5. `vmid_leases.state = active` ⇔ there is a machine not in `deleted`; `releasing` is picked up by the reconciler.
6. A `ready` snapshot ⇒ all its `disks` are `active`.
7. `sandbox.node_id` does not change once disks appear (phase 1: everything on the one node where the LVs live).
8. `deleted` is terminal: the sandbox has no machine not in `deleted`, no `sandbox_secrets`, no active `hosted_ports`. Saved snapshots outlive the sandbox.
9. Secrets exist only in `sandbox_secrets.ciphertext`, in the handler's memory, and in RPC to the agent.

## 7. Operations

### 7.1 General mechanism

1. The **API** (through `SandboxService`) in one transaction: checks the state, quotas, and admission (§8); moves the sandbox to a transitional state; inserts `operations` (`pending`); writes `idempotency_keys` (for create and fork); sends the pg-boss job `sandbox-op {operationId}` (a transactional `send` through the Drizzle adapter). The response is the sandbox and the operation.
2. The **worker** takes the job. The queue `sandbox-op` with the policy `singleton` and `singletonKey = sandboxId`: no more than one job per sandbox is active at a time. The handler:
   - reads the operation; if it is terminal — exits (a redelivery);
   - if the operation has `parent_operation_id` and the parent is not yet `succeeded` — exits without error (the parent will enqueue it); if the parent is `failed`/`superseded` — the operation is `failed` (`fork_failed`);
   - moves `pending → running` and increments `attempt`; the handler keeps its `attempt` value as a fencing token;
   - executes the steps in order, starting after `step`. Each step is idempotent (an "already done?" check → action → write of `step` and `progress`). A step write is `UPDATE … WHERE id = $1 AND attempt = $myAttempt AND state = 'running'`; zero rows means the operation is already being executed by another executor or has been superseded, and the handler exits at once;
   - before each step and every 2 s inside long waits (boot, agent connection, RAM, shutdown) it re-reads the operation: if `superseded` or `attempt` is not its own — it exits (compensation is left to delete);
   - a transient error is an exception, pg-boss retries the job with backoff; a permanent error is compensation, the operation `failed`, the job finishes without an exception.
3. **The operation deadline** (`deadline_at`, §7.9). If it has expired, the next attempt performs no new steps but runs compensation and `failed`.
4. **The `requestId` to the agent** is a deterministic UUIDv5 of `operationId:step`, so a repeat of a step after a pod crash passes the same id to the agent (S2 §9.2).

Repeats of the same kind: `stop` while a `stop` is active returns the same operation. Any other operation while one is active is the error `operation_in_progress` (retryable, with the id of the active operation). The exception is delete (§7.2).

### 7.2 Delete preempts

- Delete is accepted in any state except `deleting`/`deleted` (there the current delete operation is returned).
- In one transaction: the active operation → `superseded` (`superseded_by` = delete), the sandbox → `deleting`, insert the delete operation, the `sandbox-op` job.
- The delete job is in the same singleton queue and starts when the superseded job exits. S1 calls take seconds, and long waits check `superseded` every 2 s (§7.1), so delete waits no more than a few seconds.
- Delete itself removes everything the superseded operation managed to create: it works from the actual state (all machines with this `sandbox_id` not in `deleted`, the superseded operation's `progress`, the `fork_source` snapshots with `consumer_sandbox_id` = this sandbox, and also snapshots in `creating` with `source_sandbox_id` = this sandbox), not by a plan. Ready `fork_source` snapshots of other targets and saved snapshots outlive the source's delete.
- Delete steps: `retire` (`tunnel_credentials.retired_at`), `stop` (S1 stop, immediately `power_observed = stopped` to free RAM for waiting starts), `destroy` (S1 `delete` with verification), `snapshots`, `ports` (`hosted_ports.deleted_at`, `NOTIFY umiak_routes`), `secrets` (delete `sandbox_secrets`), `finish` (`deleted`).
- If a fork target is still waiting for its parent, its delete simply preempts the `pending` operation: the parent will see this and after the snapshot is `ready` will delete it itself, since the target is already `deleting`.

### 7.3 Create

Input: `template`, `size`, `name`, `slug`, `labels`, `env`, `secrets`, `secretFiles`, `ttlSeconds`, `idleTimeoutSeconds`, `from` (a saved snapshot), `environment` and `excludeOwnerSecrets` (S8 §10), `failFast` — the form is set by S7.

**API (synchronously):** check the template (`enabled`, the size is allowed) and the team quota. Then admission (§8):
- **claim:** there is a `warm` machine of this pair with the active build → in the same transaction machine → `claiming`, `sandbox_id` set, `sandbox.machine_id`, `node_id` filled in;
- **cold:** otherwise, if RAM suffices (accounting for eviction of warm machines of other pairs) → a new machine `allocating` with `sandbox_id`;
- otherwise → `out_of_capacity` (S7 returns `503`), nothing is created.

**`failFast`** (MVP rec. R2): admission is claim only. No `warm` machine of the pair with the active build → `pool_exhausted` (retryable), the transaction rolls back: no sandbox, `sandbox_secrets`, operation, job, or `idempotency_keys` row. The cold branch and eviction of warm machines do not apply. With `from` → `validation` (a create from a snapshot is always cold). The template and quota are checked earlier, as usual. `failFast` is written to `operations.request`; a claim retry after an agent refusal (below) is also only from the pool.

Sandbox `creating`, `sandbox_secrets` (encrypted env and files), the operation `create`.

**Worker, steps:**

| Step | What it does | "Already done" check |
|---|---|---|
| `provision` (cold only) | §7.4, including the RAM check and start | the machine is not in `allocating`/`provisioning` |
| `boot` (cold only) | wait for the connection and the agent phase `pool_ready` (no longer than `boot_timeout_s`) | the machine is connected, the phase was received |
| `rotate_token` | `POST /v1/machines/{id}/rotate-token` on the gateway (S2 §5.2) | idempotent itself |
| `claim` | `System/Claim{reason: claim, sandboxId, hostname: umiak-<slug>, env, secrets, secretFiles, authorizedKeys}` with `requestId`; wait for the response with the phase `ready`; write `provisioned_boot_id` | the agent's `requestId` |
| `finish` | machine → `running`, sandbox → `ready`, `ready_at`, `deadline_at = now + ttl`, `sandbox_events`, `NOTIFY umiak_routes` | the state |

Errors:
- The agent is unavailable — a transient error (a retry per S2 up to 30 s per call, then a retry of the job).
- Claim rejected by the agent or did not finish before the deadline: machine → `deleting` (a tenant touched it). If the machine was from the pool, the operation tries once more (admission: another warm or cold; with `failFast` — only another warm), otherwise — the sandbox `error` (`create_failed`).
- Cold preparation failed: machine `failed → deleting`, sandbox `error` (`create_failed`).

`authorizedKeys` are the user's public SSH keys (S8); if S8 does not provide them, an empty list.

**Create from a saved snapshot:** always cold, bypassing the pool. The node is the snapshot's node. The `provision` step uses S1 `fork(snapshot)` instead of `create(template)`. `template_build_id` is taken from the snapshot.

### 7.4 Machine preparation (a shared step for the pool, cold create, fork, from-snapshot)

The durable marker of the step is the machine state: `allocating`/`provisioning` mean "preparation not finished", the transition to `booting` is written **before** the start call. This works the same for a sandbox operation and for the pool's `machine-op`, which has no `operations` row.

1. Machine → `provisioning`.
2. A new BS (32 bytes): `tunnel_credentials(machine_id, bs_hash)` upsert. The BS lives only in this step's memory.
3. Acquire the node's clone slot (§8.3).
4. S1 `create(template, size, {smbios1})` or `fork(snapshot, size, {smbios1})`, `smbios1` per S2 §5.2 (`uuid = machineId`). The VMID and MAC are taken by S1 from `AllocatorStore`; the S6 implementation is idempotent by `machine_id` (§5.3). Write `vmid`, `mac` into the machine, the `DiskSet` into `disks`.
5. Release the slot.
6. A RAM check before start (§8.1) and in the same transaction machine → `booting`. Only after that — S1 `start`.

**A repeat after a crash** (the machine is still in `provisioning`): the VM has never been started, so the partial result is thrown away. If the machine has a lease and a VM or LVs with this VMID, S1 `delete(vmid)` is called (it verifies deletion and releases the lease), then steps 2–6 repeat with a new BS and possibly another VMID. The BS is not stored anywhere, so a repeat always goes with a new one; after the transition to `booting` the BS never changes [S6 decision]. This way S6 does not need a primitive "rewrite `smbios1`".

### 7.5 Stop

Reason: `user`, `ttl`, `idle`. API: sandbox → `stopping`, the operation `stop`.

| Step | What it does |
|---|---|
| `prepare` | Best effort, 10 s: `System/PrepareStop` (the agent flushes buffers and wipes secrets). Only the confirmation `secret_files_wiped = true` clears `machines.secret_files_on_disk`; unavailability, a timeout, or `false` keep the flag |
| `shutdown` | S1 `shutdown(timeout 60 s Linux / 300 s Windows, S9 §24.9)`; if the VM did not shut down — S1 `stop` (hard, `progress.shutdown = hard`). A task that did not get the VM lock (`can't lock file … got timeout`, qmeventd after stop and a quick start) did not ask the guest: a retry (`retryOnVmLock`), not a hard stop |
| `verify` | the VM status is `stopped` |
| `finish` | machine → `stopped`, sandbox → `stopped`, `stopped_at`, `stop_reason`; this machine's commands in `starting`/`running` → `lost`; `NOTIFY umiak_routes` |

S1 `stop` in all worker paths (stop, recover, delete, compensation, reconcile, an emergency stop after a failed thaw) is retried via `retryOnVmLock`: 5 attempts with 10 s pauses cover the 30 s of cleanup of the old QEMU in qmeventd. The power lock is released between attempts, before each the fence of the calling operation (if any) and the original owner of the VMID are checked again; while waiting, the fence is checked every 2 s. A change of owner or of the attempt stops the retries.

### 7.6 Resume

API: the state `stopped` or `error` with the machine in `stopped` (§6.1). Quota and admission (§8.2) on the sandbox's node: the machine's RAM (with eviction of warm machines of other pairs; if `size` is passed, its RAM is counted [S6 decision]); if not enough → `out_of_capacity`. Sandbox → `starting`, the operation `resume`; the machine stays `stopped` until the `start` step.

Input: `size`, `ttlSeconds`, `env`, `secrets`, `secretFiles` (MVP rec. R11). The passed sets are in the same transaction overlaid by key on the sandbox's `sandbox_secrets` (decrypt, merge, check the S7 §8.3 limits, encrypt): the same key — the request wins, secret files — by name, `null` deletes the key. The result stays with the sandbox even if the resume later failed. `operations.request` gets the non-secret parameters (`size`, `ttlSeconds`) and the hash of the canonical body, no env and secret values; a repeated resume while a resume is active returns it if the hash matches (an empty body is also a body), otherwise `operation_in_progress` (S7 §8.2). The values reach the agent in the `provision` step.

| Step | What it does |
|---|---|
| `resize` (if `size` changed) | `PUT config` cores and memory while the VM is off |
| `start` | a RAM check before start (§8.1, wait with 1 s polling), then S1 `start` |
| `wait_agent` | a new connection (`tunnel_sessions` with a `boot_id` different from `provisioned_boot_id`) |
| `provision` | `System/UpdateEnv{env}`, `System/UpdateSecrets{secret_env, secret_files}`, and `System/UpdateSshCa{keys}` (S3 §8.1: claim is once per identity, after boot the sets are delivered by these calls) — env and secrets are passed again in full (the guest has no secrets after boot, the S3 phase `secrets: missing`); `keys` is the worker's current set of SSH user CA keys (the same as in claim), so sandboxes created before a CA change or before it was configured get the keys on the next resume; write `provisioned_boot_id` |
| `finish` | machine → `running`, sandbox → `ready`, `deadline_at = now + ttl` (the TTL can be passed again), `health=ok` |

An error or deadline: S1 `stop` (hard), machine → `stopped`, sandbox → `error` (`resume_failed`). The disks are intact, the resume can be repeated.

### 7.7 Fork

Input: a source in `ready` or `stopped` without an active operation; the target's parameters (`name`, `slug`, `labels`, `ttlSeconds`, `idleTimeoutSeconds`, `size`, `env`, `secrets`, `secretFiles`) and `forceStop`. A Windows source in `ready` without `forceStop: true` — `snapshot_requires_stop` (409) before any writes, with a hint to repeat with the flag (§7.8 "Windows only from a stopped VM"). The flag is ignored for Linux and for a stopped source and is not written into the operation's `request`.

**API:** RAM admission for the target on the source's node (eviction of warm machines allowed; there are no other nodes — the LVs are local). Created are:
- the target: sandbox `creating` (`origin = fork`, `forked_from_sandbox_id`), `sandbox_secrets` — a copy of the source's env and secrets, overlaid by key with `env`, `secrets`, `secretFiles` from the request (MVP rec. R11: rules, limits, and `null` as in resume, §7.6), encrypted with the target's AAD; the target's machine `allocating`;
- a `fork` operation on the source (`pending`) and a `create` operation on the target (`pending`, `parent_operation_id` = fork). A job is enqueued only for `fork`.

**Worker, the `fork` operation on the source:**
1. `snapshot`: a `snapshots` row (`kind = fork_source`, `consumer_sandbox_id` = the target, `creating`). If the Linux source is running — S1 `snapshot` with `QuiesceHook` from S3 (`System/Quiesce` with a lease and watchdog; the fallback path is QGA fsfreeze through S1), `consistency = quiesced`. If neither the agent nor QGA answers — the error `quiesce_failed`. A running Windows is not snapshotted live (§7.8, S9 §24.8): only from a stopped VM. If the source is off — without freeze, `powered_off`. After thaw the handler checks `quiesce_broken`: if the watchdog managed to thaw the FS earlier, the snapshot is inconsistent, the operation fails with `quiesce_failed`.
2. The snapshot → `ready`. In one transaction: the `fork` operation → `succeeded`; the target operation gets `deadline_at = now + deadline`; the `sandbox-op` job for the target. If the target is already `deleting`/`deleted` by then, the job is not enqueued, and the snapshot is deleted by this same operation.

**Worker, the `create` operation on the target:** the steps `provision` (S1 `fork(snapshot)`), `boot`, `claim` (the agent will see the `machineId` change and change its identity, S3), `finish` — as in cold create. Then `cleanup_source`: S1 `delete(snapshot)`, the snapshot → `deleted` (thin snapshots are independent).

**Who owns the `fork_source` snapshot.** While the snapshot is `creating`, it is owned by the source's `fork` operation: on its failure or preemption it (or the source's delete, §7.2) deletes the partially created LVs. From the moment of `ready` it is owned by the target: `cleanup_source`, compensation of the target's create on error, and the target's delete remove it. Cleanup (§15.4) touches only `fork_source` in `ready`/`failed` whose target is in `error`/`deleted`, or any older than 1 h — a safety net, not the main path.

Errors: the failure or preemption of the operation on the source → the target's handler (by `parent_operation_id`, §7.1) moves its operation to `failed`, the target → `error` (`fork_failed`). The source does not touch the target itself: each sandbox is changed only by its own operation.

The source's node must be `active` (and its provider too): on a node withdrawn from placement (`cordoned`, provider `draining`) new machines are not created (§8.4), nor is a fork; the error is `out_of_capacity` with `details.reason = node_not_active` (storage above thresholds — `storage_over_threshold`).

A fork inherits from the source: the disk, env and secrets (with the request's values overlaid), `template_slug`, `size` (if not passed), `labels` (if not passed), `exclude_owner_secrets` (S8 §10.1). The environment is not applied again (S8 §10.1). It does not inherit: the TTL (taken from the request or the default), hosted ports, command history.

### 7.8 Saved snapshot, recover, reprovision, update

**Save snapshot** (the `save_snapshot` operation on a source in `ready`/`stopped`): a snapshot `kind = saved`, `pending_name`, the same way as in fork. When it is `ready`, in one transaction: the old `ready` snapshot with this name → `deleting` (the name is released), the new one gets `name`. On error the name stays with the previous snapshot. Linux keeps secrets in tmpfs. For Windows the refinement of S9 §18.6 item 5 applies: a stopped machine with `machines.secret_files_on_disk = true` gets `snapshot_requires_clean_stop` before the LVs are created (a running Windows without `forceStop` is rejected earlier, below). Fork is not limited by this rule.

`secret_files_on_disk` is conservatively set **before** `Claim` / `UpdateSecrets` with non-empty Windows secret files (including live PUT/PATCH env): a lost response could have meant a successful write. A successful delivery of an empty set clears the flag, an unsuccessful one keeps it. Only a confirmed `PrepareStop{secret_files_wiped: true}` clears it at stop; a hard stop by itself confirms nothing. The migration of old Windows machines without confirmed wiping sets `true`.

**Windows only from a stopped VM (Ilia's decision 2026-11-01, S9 §24.8).** The QGA/VSS thaw hangs, and a crash-consistent snapshot of a running VM loses or zeroes recent writes from the cache. Therefore a Windows fork and saved snapshot are taken only from a powered-off VM (`powered_off`); the former crash-consistent fallback (§24.7) was removed from the public path, there are no new `consistency = crash` (the value stays in the schema for old snapshots).

- API: a Windows source in `ready` without `forceStop: true` → `snapshot_requires_stop` (409), `details {reason: "windows_running", retryWith: {forceStop: true}, cli: "--force-stop"}`. The same code (a message with a hint) is given by the worker's `snapshot` step if it finds a running Windows without the flag.
- With `forceStop: true` the API writes `request.forceStop = true` (only for a `ready` Windows), the operation deadline = its deadline + the stop deadline (§7.9). The steps of fork / save_snapshot: `stop_prepare` → `stop_shutdown` → `stop_verify` (the stop path §7.5: PrepareStop with secret wiping; the shutdown timeout is the same as for stop (`SHUTDOWN_TIMEOUT_S`: 300 s Windows, 60 s Linux); **without a hard stop**, see below) → `stopped` (machine → `stopped` with `clean_stop`, commands → `lost`; progress `forceStopped`) → `snapshot` (`powered_off`; then `deadline_at = max(deadline_at, now + max(resume deadline, boot_timeout_s + 5 min))`, progress `snapshotTaken: true`) → `restart` (the pre-start check of §8.2 and S1 start with `retryOnVmLock` for the qmeventd lock) → `restart_agent` (a new boot) → `restart_provision` (env, secrets, CA; machine → `running`; progress `sourceRestarted: true`) → finish (fork: handing over to the target). The sandbox all this time is `ready` with an active operation; its machine goes through `running → stopping → stopped → starting → running`. The RAM of the stopped machine stays in `reserved` while an operation with `forceStop` is active (§8.1).
- The shutdown did not fit the timeout (fix acceptance 2026-11-01: the first shutdown of a fresh Windows clone took 118.4 s with the former 120 s limit) → the operation `failed` with `shutdown_timeout` (`retryable: true`: repeating the request is safe), the snapshot is not taken. Compensation, as for any failure before the snapshot: a hard stop of the machine in `stopping` (a known state), then starting the source (`restartForcedSource`). A snapshot after a hard stop is never marked `powered_off`.
- After the snapshot (`progress.snapshotTaken`) nothing fails the operation anymore. The deadline no longer applies to it (`deadlinePassed` = false: neither before steps, nor before finish, nor on a job retry); the extended `deadline_at` only bounds the restart waits. Transient restart errors (not `retryable: false`: `ECONNRESET`, PVE errors, waiting for RAM, the qmeventd lock) are retried with a 5 s pause until the extended deadline expires.
- The restart never succeeded: a hard stop (best effort), machine → `stopped` (or `failed` on `machine_lost`), sandbox `ready → error` (`resume_failed`, an event with `reason: force_stop_restart`), progress `sourceRestarted: false`, `restartError {code, message}`; the fork continues, the snapshot is intact. The user brings the source up with a regular `resume`.
- A failure before the snapshot (for example, saved with unconfirmed secret wiping → `snapshot_requires_clean_stop`) is compensated as usual, and the compensation starts the source again by the same path (`restartForcedSource`).
- A saved Windows snapshot from a stopped VM still requires `secret_files_on_disk = false`: a forced save gets it from the PrepareStop of its own stop. The agent's `System/Quiesce` is no longer called for Windows.
- **`powered_off` only after a clean shutdown (fix acceptance 2026-11-01).** `machines.clean_stop` = true is set only by a stop whose shutdown completed on its own (`progress.shutdown = clean`, without a hard stop in `stop_verify`); a trigger resets the flag in any state other than `stopped` (start, resume, recover, VM crash), and the reconcile power drift resets it at its hard stop. The `snapshot` step for a VM that is not running and has no `clean_stop`: Windows → `snapshot_requires_clean_stop` before the LVs are created (message: resume and repeat with `forceStop: true`, or stop again); Linux → a snapshot with `consistency = crash` (an honest label: disks as after a power loss; a Linux fork of a stopped sandbox after a hard stop is not forbidden). This applies to a regular stop with a hard stop after 60/300 s, and to a machine after a failed resume/restart. Existing machines without confirmation: `clean_stop = false` (fail closed). The worker always passes S1 `crashConsistent: false`; S1 without an explicit choice refuses a snapshot of a running Windows (S9 §24.8).

The snapshot after a restart also uses `retryOnVmLock` (5 attempts, 10 s pauses), including `freeze took … (budget …)` after waiting for the VM lock. Each attempt re-reads the source, checks the fence and deadline, deletes the leftovers of the previous attempt, and creates fresh hooks; a thaw error does not repeat the snapshot. Fence checks continue during the pauses.

**Deleting a saved snapshot** (`deleteSavedSnapshot` or a replacement on save): the snapshot goes at once to `deleting` (the name is released, new creates from it are impossible), a `snapshot-op delete` job. The handler deletes the LVs only when there is no sandbox in `creating` with `origin_snapshot_id` = this snapshot whose operation has not yet passed the `provision` step; until then it waits (a job retry in 30 s). This way a create from a snapshot waiting for RAM does not lose its disks.

**Recover** (`ready` or `error` with a machine; no more often than every `recoverMinIntervalSeconds` = 600): sandbox → `starting`; the steps `reset` (S1 `stop` + `start`, a hard power cycle), `wait_agent`, `provision`, `finish`. It is never started automatically.

**Reprovision** (internal): a new boot needs delivery as in the `provision` step of resume (§7.6). `readiness.changed{phase: secrets, state: pending}` / `secrets_missing` of the current boot, `connected`, and `agent_restarted` require re-delivery even with the same `boot_id`; commands stay alive after a restart. The events increment `secrets_generation`, a successful delivery writes the generation read **before** the RPC into `provisioned_secrets_generation`. So a new pending during an RPC is not lost. For a `ready` sandbox without an active operation, a difference between the generations or the boot schedules a reprovision. With an active operation the request stays in the machine: it is checked after the operation finishes and by reconcile (recovery after a worker crash). An old boot and a repeated processing of an already processed event do not create a request. The live delivery of PUT/PATCH env also accounts for generations; an empty response does not clear the files flag when there is a newer request.

**Update** (`name`, `labels`, `ttlSeconds`, `idleTimeoutSeconds`) and **extend** (`deadline_at = now + ttl`) — without an operation, a plain `UPDATE` with a `version` check.

### 7.9 Operation deadlines [S6 decision]

| Operation | Linux | Windows (S9 will refine) |
|---|---|---|
| create from the pool | 2 min | 5 min |
| create cold / from snapshot / fork target | 6 min | 20 min |
| fork (snapshot on the source) | 2 min | 3 min; with `forceStop` + 7 min (stop), after the snapshot at least now + max(15 min (resume), `boot_timeout_s` + 5 min) and it no longer fails the operation (§7.8) |
| stop | 3 min | 7 min (shutdown up to 300 s + PrepareStop, VM lock retries, verify; S9 §24.9) |
| resume, recover | 5 min | 15 min |
| save_snapshot | 5 min | 5 min; with `forceStop` + 7 min (stop), after the snapshot as for fork |
| delete | no deadline: retries with backoff up to 10 min; after 30 min the alert metric `umiak_delete_stuck` | the same |

The time until agent readiness comes from `template_builds.boot_timeout_s`.

## 8. Capacity, placement, admission

### 8.1 RAM accounting

The RAM of a machine = `memory_mb` (S1: `balloon=0`, no overcommit). The limit is `nodes.ram_cap_mb` (8192 in the PoC). Two quantities are computed on a node:

- **`reserved`** — promised RAM: the sum over machines in `allocating`, `provisioning`, `booting`, `warm`, `claiming`, `running`, `starting`, `stopping`, plus `stopped` machines that have a `pending`/`running` resume or recover operation, or a fork/save_snapshot with `request.forceStop` (the place for their start has already been given). Machines in `failed`/`deleting` are **not** included: their place was given up.
- **`powered`** — the RAM of VMs that may be running right now: machines in `booting`, `warm`, `claiming`, `running`, `starting`, `stopping`, and also `failed`/`deleting`/`stopped` whose `power_observed` is not `stopped`.

Invariants: `reserved ≤ cap` (ensured by admission, §8.2) and `powered ≤ cap` (ensured by the check before start, §8.2). Both checks run under `pg_advisory_xact_lock(hash(node_id))`.

### 8.2 Admission and the pre-start check

**Admission** is the function `admit(node, needMb, pairKey)` in `packages/core`, in the API transaction (or the pool controller's) under the node lock:
1. `reserved + need ≤ cap` → yes. The reservation is the machine row itself (`allocating`) or the resume/recover operation.
2. Otherwise the RAM of `warm` machines of **other** pairs on this node is computed (the oldest first). If it suffices, these machines go in the same transaction → `deleting` (a `machine-op delete` job), `reserved` decreases, the answer is yes.
3. Otherwise — `out_of_capacity`.

The pool is refilled only from free RAM (without eviction).

**Node locks and retries.** An admission refusal releases the lock of its node: `admit` takes it in a savepoint and on refusal rolls it back (nothing was written). So a service transaction holds no more than one node lock: create tries the candidates (§8.4) one by one, fork, resume, recover, and create from a snapshot work on one node. The transactions of create, fork, resume, and recover on `40P01` (deadlock) or `40001` (serialization failure) are repeated entirely up to 3 times with a short random pause (10–50 ms × the retry number); after that — `out_of_capacity` (retryable), only the SQLSTATE goes to the log.

**The pre-start check** is in the step that starts the VM (§7.4 step 6, `start` in resume and recover), under the same lock: `powered + need ≤ cap`. If yes — in the same transaction the machine goes to `booting`/`starting` (it is now in `powered`), then S1 `start` is called. If no — wait with 1 s polling (checking `superseded`, §7.1): evicted machines are still stopping. Delete writes `power_observed = stopped` right after S1 stop, so the wait is seconds.

### 8.3 Clone slots

S1 limits parallel clones on a node (`clone_concurrency`, default 4). Clones come from different queues (pool, create, fork), so the limit is a shared semaphore in the DB [S6 decision]:

```
node_clone_slots(node_id, slot int, holder text null, expires_at null, primary key(node_id, slot))
```

Acquisition is `UPDATE … SET holder, expires_at = now() + 2 min WHERE node_id = $1 AND (holder IS NULL OR expires_at < now()) … LIMIT 1 FOR UPDATE SKIP LOCKED`. Release in `finally`; a lost slot expires itself.

### 8.4 Placement (multi-node readiness)

`place(templateSlug, sizeMb)`: the provider's nodes `active`, the node `active`, an `active` build of the template exists on this node, storage is below thresholds (S1: data 80%, metadata 70%), admission passes. Of the suitable ones — the one with the most free RAM [S6 decision]. Fork, resume, and create from a saved snapshot are bound to the node of their disks. In the PoC there is one node.

Each node gets its own instance of the `packages/pve` clients (the provider's PVE API and the node's `umiak-node`) from the registry in the worker by `providers`/`nodes` and the Secret files.

### 8.5 Quotas

Checked for create, fork (the target), and resume in the same transaction as admission, under `pg_advisory_xact_lock(hash(team_id))`. The lock order is always: team, then node. The number of the team's sandboxes in `creating`, `ready`, `starting`, `stopping` ≤ `maxActiveSandboxes`; their total RAM ≤ `maxRamMb`; saved snapshots ≤ `maxSavedSnapshots` (on save). The error is `quota_exceeded`. The values are set by S8.

## 9. Warm pool

### 9.1 Targets

`poolTargets` from `ConfigReader`: `(templateSlug, sizeSlug, target)`. PoC: `linux/2GB = 1` (2 GB of 8, the other 6 GB are for 3 sandboxes).

### 9.2 The `pool` controller (every 10 s)

For each target and each node with an `active` template build (in the PoC there is one node, the whole target on it):
1. `supply` = machines with this `pool_key` and the active build in the states `allocating`, `provisioning`, `booting`, `warm`.
2. `supply < target`: for each missing one — admission without eviction; if yes, a machine `allocating` with `pool_key` and a `machine-op provision` job. If there is no RAM — nothing (the pool waits).
3. `supply > target`: the oldest surplus `warm` → `deleting`.
4. The old generation (§9.4) and stale ones (`warm_at` older than `maxAgeHours`, default 24 h [S6 decision]) — replace: first order a new one (if RAM allows), then delete the old; if there is not enough RAM for both — delete the old one first.
5. A `warm` machine whose agent has been disconnected for more than 60 s → `deleting` (cheaper to replace than to repair).

### 9.3 Pool machine preparation (`machine-op provision`)

§7.4 (including the RAM check and start), then waiting for the agent to connect and the `pool_ready` phase event (or a `System/Info` response with readiness, if S3 so decides), no longer than `boot_timeout_s`. Then machine → `warm`, `warm_at`. On an error or timeout — `failed → deleting`.

### 9.4 Template versions

The pool generation is `template_build_id`. Claim takes only machines with the pair's current `active` build. When S5 moves a new build to `active`, the old `warm` machines of the pair are replaced per step 4. Sandboxes on the old build are not touched.

### 9.5 Claim

Atomic in the API transaction (§7.3):

```sql
UPDATE runtime.machines SET state = 'claiming', sandbox_id = $sandbox, pool_key = NULL, claimed_at = now()
WHERE id = (SELECT id FROM runtime.machines
            WHERE state = 'warm' AND pool_key = $pair AND template_build_id = $activeBuild AND node_id = ANY($nodes)
            ORDER BY warm_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```

Then the worker: `rotate_token` (a new MT at claim, S2), `System/Claim`. The identity (`machineId`, BS in `smbios1`) is already in the machine from the preparation, it does not change at claim: one machine for the whole life of the sandbox.

## 10. Agent events

### 10.1 Intake

`POST /internal/v1/agent-events` (S2 §9.6) lives in `apps/api` and calls `core.events.ingest(batch)`:
1. In one transaction: `INSERT … ON CONFLICT DO NOTHING` into `agent_events` or `agent_synthetic_events`; a `machine-events {machineId}` job (a queue with the `stately` policy and `singletonKey = machineId`: no more than one waiting and one active per machine).
2. The response `{ackedSeq}` = the largest `seq` of the batch (all rows of the batch are already written).

### 10.2 Handling (`machine-events`)

The handler reads all unprocessed events of the machine (agent ones by `seq`, synthetic by `time`) and applies them idempotently, then sets `processed_at`. The current connection state is taken from `tunnel_sessions`, not from the order of events (S2).

| Event | S6 reaction |
|---|---|
| `connected` (synth.) | if `health=degraded` → `ok`, `sandbox_events: recovered`; re-delivery of secrets of the current boot (§7.8) |
| `disconnected` (synth.) | nothing at once; the degraded rule is the `health` controller (§11.1) |
| `agent_restarted` (synth.) | a journal entry; commands are alive (S2); re-delivery of secrets even without a `boot_id` change |
| `rebooted` (synth.) | `last_reboot_at`; this machine's commands with the previous `boot_id` → `lost`; if the sandbox is `ready`, there is no active operation, and the new `boot_id` (from `tunnel_sessions`) ≠ `provisioned_boot_id` → `reprovision` |
| `identity_changed` (synth.) | expected only at the first connection of a fork target or a VM from a snapshot; otherwise the alert metric `umiak_unexpected_identity_change` |
| `phase{pool_ready \| ready \| secrets_missing}` | `pool_ready` → machine `warm` (if waiting); `secrets_missing` of the current boot keeps the re-delivery request even if the boot is already provisioned (§7.8) |
| `command.exited{commandId, status, code, signal, stdoutEnd, stderrEnd}` | the command's terminal status, if not yet terminal |
| `pty.closed{commandId}` | the status of the PTY command |
| `activity{runningCommands, openPtys, tcpStreams}` | counters, `activity`, `last_activity_at` (§12) |
| `ports.changed{listening[]}` | only stored for now (for S7 `/ports`) |
| `quiesce.watchdog_thawed` | an alert metric; for a snapshot in `creating` of this machine `quiesce_broken = true` (the operation itself is not touched: it will check the flag after thaw, §7.7) |

The exact names and payloads of agent events are set by S3; S6 requires the set above (§16).

## 11. Health and recovery

### 11.1 The `health` controller (every 10 s)

For a `ready` sandbox whose machine has `tunnel_sessions.state = disconnected` and `disconnected_at < now − 60 s` (or there is no session and the owner gateway's heartbeat is stale — S2 §7): `health = degraded`, `degraded_since`, `sandbox_events: degraded`. Then step by step [S6 decision]:
1. A QGA probe via PVE (`agent/ping`) and the VM status.
2. The VM is running, QGA answers → `health_reason = agent_unreachable`; after 2 min in `degraded` — restart the agent service once through QGA (`guest-exec`), no more often than every 10 min.
3. The VM is running, QGA is silent → `vm_unresponsive`. We do nothing ourselves: the user calls `recover`.
4. The VM is off → `health_reason = vm_stopped`, nothing more: a shutdown is handled only by reconcile (§11.3), so that one event is not counted twice.

A `degraded` sandbox is not stopped or rebooted automatically.

### 11.2 The `reconcile` controller (every 60 s per provider)

Reads: VMs from `/cluster/resources` in the pool `umiak`, `umiak-node lv.list` (tags `umiak`), `vmid_leases`, `machines`, `disks`, `snapshots`. It touches nothing that is not in the pool `umiak`, has no tag `umiak`, or is outside the VMID range (the S1 protections are duplicated in code). The grace for "fresh" objects is 10 min (longer than any preparation step).

| Discrepancy | Action |
|---|---|
| A VM in the pool without a machine row (or the machine is `deleted`), older than grace | S1 `delete(vmid)`, metric `orphan_vm` |
| An LV `umiak-vm-N` without a VM and without a machine/disk; an LV `umiak-snap-<id>` without a snapshot in `creating`/`ready`, older than grace | `lv.remove`, metric `orphan_lv` |
| A machine not in `allocating`/`provisioning`/`deleting`/`deleted`, but no VM, no active operation | machine `failed` (`lost`); this machine's sandbox → `error` (`machine_lost`) (§6.1) |
| A machine `running`, the VM is off, no active operation | §11.3 |
| A machine `stopped`, but the VM is running (started by hand) | S1 `shutdown`, metric `power_drift` |
| `vmid_leases.releasing` | repeat the S1 delete check, then release |
| A machine `deleted`, but `tunnel_sessions` is `connected` | set `retired_at` again, a metric |
| An operation `running`/`pending` for longer than the deadline + 5 min with no pg-boss job in progress | enqueue the job again (the handler itself will perform compensation by deadline) |
| A `pending` operation older than 1 min without a job, with no active parent (`parent_operation_id`) | enqueue the job again (if the parent is active, the handler exits anyway, §7.1) |

The mode `UMIAK_RECONCILE_DRY_RUN=1` only writes what it would do. In the PoC the first run is in this mode.

### 11.3 Unexpected shutdown

The VM of a machine in `running` is off without our operation (the user did `shutdown`, the guest crashed). Detected only by reconcile. In one transaction (team and node locks): machine `running → stopped` (a conditional `UPDATE`, so one shutdown is handled once), `power_observed = stopped`, the time is appended to `unexpected_stops`. Then:
- the first time within an hour — a system `resume` operation (`requested_by = null`, quota not checked, admission as usual), sandbox `ready → starting`. If admission refused — as in the second case;
- the second time within an hour — sandbox → `stopped` (`stop_reason = unexpected_shutdown`). The user decides whether to resume.

## 12. Auto-stop: TTL and idle

The `autostop` controller (every 15 s):
- **TTL.** `deadline_at = (create or resume) + ttl_seconds`. At `deadline_at ≤ now` a `ready` sandbox → a `stop` operation (`stop_reason = ttl`). If a TTL is set explicitly, it is hard: activity does not extend it, only `extend` or `PATCH ttlSeconds` does. **The default is `null` (no hard TTL)**: the main protection against costs is idle-stop, which counts commands, PTYs, and TCP streams as activity, so long agent tasks are not killed by a timer by default. Boat extends the deadline while the agent's prompt is running; for us the same effect is given by the absence of a TTL by default.
- **Idle.** A sandbox is a stop candidate if all of the following hold:
  - the agent is connected, and the last `activity` event is fresh (not older than 150 s, i.e. no more than one heartbeat missed) and shows `runningCommands = 0`, `openPtys = 0`, `tcpStreams = 0`;
  - `idle_timeout_seconds` has passed since the counters became zero;
  - `idle_timeout_seconds` has passed since `last_api_call_at`.

  Before stopping, the controller **checks live**: it calls the agent's `System/Activity` (no side effects, S3) and requires zeros right now. Only then a `stop` operation (`stop_reason = idle`). This way the lag of the event pipeline does not lead to stopping a busy sandbox. The default is 900, `null` — no idle-stop.
- `runningCommands` includes detached commands and any processes under a shim (S2 §9.1), `openPtys` — PTYs, alive with or without a client. So long agent work (a coding agent, a build, a `sleep` under a shim) is never considered idle.
- The agent is unavailable (`activity = unknown`), the `activity` event is stale, or the live check failed → idle-stop does not fire; the TTL works.
- `last_api_call_at` is updated by `api` on any call on the sandbox (no more often than once per 30 s per sandbox, `UPDATE … WHERE last_api_call_at < now() − 30 s`).
- The agent sends `activity` when any counter moves between 0 and non-0 and every 60 s as a heartbeat (S3, §16).

## 13. Security

### 13.1 Env and secrets (decision Q7, agreed by the master session; Ilia is informed and may revisit)

- **Where they are stored.** A sandbox's env, secrets, and secret files (from create, fork, resume, and `PUT`/`PATCH /env`, S7 §8.3) are stored in `sandbox_secrets` as one encrypted blob `{env, secrets, secretFiles}`.
- **Encryption.** AES-256-GCM via `node:crypto`, a random 96-bit nonce per write, AAD = `sandbox:<sandboxId>:v<keyVersion>`.
- **Keys.** A ring from a Kubernetes Secret, the file `UMIAK_DATA_KEYS_FILE`: `{"current": 2, "keys": {"1": "<base64>", "2": "<base64>"}}`. Rotation: a new key is first distributed to all replicas of `api` and `worker` as non-`current` (each can already decrypt and check the hash with it), then becomes `current`; the `cleanup` controller re-encrypts rows with the old version; the old key is removed when there are zero rows with it (a metric) **and** at least 24 h have passed since the rotation (the idempotency period, see below).
- **Request body hash.** The bodies of create, fork, and resume contain env and secret values, so `idempotency_keys.request_hash` and `operations.request.bodyHash` are not a bare sha256 but `key version (uint32 BE) || HMAC-SHA256(subkey, scope "\n" canonical body)`; the subkey is HKDF-SHA256 of the data key of that version (`info = umiak-request-hash/v1`). The comparison recomputes the HMAC with the version from the stored hash, so a rotation within 24 h does not break a repeat with the same `Idempotency-Key`. Hence the key deletion rule above (zero rows and not earlier than 24 h after rotation): a hash whose key has been removed matches nothing (`idempotency_key_reused`, no duplicate).
- **Delivery.** Secrets are passed to the agent at every claim, resume, recover, and reprovision (`System/Claim`). In the guest they live only in tmpfs (Linux) or in a directory with an ACL for SYSTEM (Windows) and are wiped at stop (S3).
- **Fork.** Inherits the source's env and secrets: decryption, overlaying the request's values (§7.7), and encryption with the target's AAD. A saved snapshot carries no secrets.
- **Delete.** The `sandbox_secrets` row is deleted (crypto-erase for this sandbox).
- **Leaks.** The values do not get into logs, `operations.request`, `idempotency_keys.response`, pg-boss job data (ids only), metrics, and `commands` (variable names only). The logger redacts the fields `env`, `secrets`, `secretFiles`, `bs`, `token`. The body hash for `Idempotency-Key` is computed from the canonical body together with the secrets, but the secret itself is not stored.

### 13.2 Machine credentials

- The BS is generated in the preparation step (§7.4), only the `sha256` is in the DB (S2). It does not change after the VM's first start.
- `retired_at` is set by the first step of delete, before the VM stops: the gateway closes the tunnel and answers `403`.
- The MT is rotated at claim (`rotate-token`). At resume no rotation is needed: the MT lived only in agent memory, after boot the agent presents the BS again.

### 13.3 Other

- The worker is the only component with the PVE token and the `umiak-node` SSH key (a Kubernetes Secret, S1 §6.1). `api` does not get them.
- The internal `api` endpoints (`/internal/v1/*`) — only with a service token (S2 §5.5) and only from the cluster network (NetworkPolicy, S12).
- The reconciler and cleanup delete only what is marked as ours (§11.2).

## 14. Interfaces S6 gives to other areas

### 14.1 S7 (public API): `SandboxService` in `packages/core`

```ts
interface SandboxService {
  create(p: Principal, input: CreateInput, idemKey?: string): Promise<{ sandbox: Sandbox; operation: Operation }>
  get(p: Principal, id: string): Promise<Sandbox>
  list(p: Principal, filter: ListFilter, cursor?: string): Promise<Page<Sandbox>>
  update(p: Principal, id: string, patch: UpdateInput): Promise<Sandbox>   // name, labels, ttl, idle timeout
  extend(p: Principal, id: string): Promise<Sandbox>
  stop(p: Principal, id: string): Promise<Operation>
  resume(p: Principal, id: string, input: ResumeInput): Promise<Operation>
  fork(p: Principal, id: string, input: ForkInput, idemKey?: string): Promise<{ sandbox: Sandbox; operation: Operation }>
  recover(p: Principal, id: string): Promise<Operation>
  delete(p: Principal, id: string): Promise<Operation>
  saveSnapshot(p: Principal, id: string, name: string): Promise<Operation>
  deleteSavedSnapshot(p: Principal, name: string): Promise<void>
  listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]>
  getOperation(p: Principal, id: string): Promise<Operation>
  waitForState(id: string, states: SandboxState[], timeoutMs: number): Promise<Sandbox> // LISTEN umiak_sandboxes
  // commands, files, ports
  resolveAgentTarget(p: Principal, id: string): Promise<{ machineId: string; capabilities: string[] }> // throws sandbox_not_ready
  createCommand(p: Principal, id: string, spec: CommandSpec): Promise<Command>   // row before Process/Start
  completeCommand(commandId: string, result: CommandResult): Promise<void>
  touchApiActivity(id: string): Promise<void>
  hostPort(p: Principal, id: string, port: number, mode: PortMode): Promise<{ hostedPort: HostedPort; token?: string }>
  unhostPort(p: Principal, id: string, port: number): Promise<void>
  rotatePortToken(p: Principal, id: string, port: number): Promise<{ token: string }>
}
```

Domain errors (`UmiakError{code, retryable, details}`) that S7 maps to HTTP: `not_found`, `invalid_state` (with the current `state`), `operation_in_progress` (retryable, `operationId`), `out_of_capacity` (retryable, `retryAfterSeconds`), `pool_exhausted` (retryable, `retryAfterSeconds`; create with `failFast`, §7.3), `quota_exceeded`, `idempotency_key_reused` (the same key, a different body), `template_unavailable`, `snapshot_not_found`, `sandbox_not_ready`, `recover_rate_limited`, `validation`.

Idempotency: the same `(principal, scope, key)` with the same body hash → the saved response (the same sandbox and operation); with a different hash → `idempotency_key_reused`; a parallel duplicate waits for the first one's commit (a unique key in the transaction). Lifetime 24 h. A repeat without a key creates a new sandbox.

`NOTIFY umiak_sandboxes '<sandboxId>'` is sent by a trigger on a change of `state` or `health`, for the S7 long-poll and the S8 dashboard.

### 14.2 S4 (gateway): routes and SSH

- `core.routes.lookup(label)` and the endpoint `GET /internal/v1/routes/{label}` in `api` → `{sandboxId, machineId, port, mode, tokenHash, authEpoch, state}`. `state` is the sandbox state: the gateway itself decides what to show for non-`ready` (a "stopped" page, etc.). The label is `<slug>-<port>`; per the S4 §4.2 grammar the slug does not end with `-<digits>`, so the port number is everything after the last `-`.
- `NOTIFY umiak_routes '<label>'` on a change of `hosted_ports`; on a change of the sandbox's `state` or `machine_id` — one notification for each of its labels (triggers).
- `POST /internal/v1/ssh/authorize {sandbox, user, publicKeyFingerprint}` → `{allowed, machineId, state}`. S6 gives the permission for the sandbox and its state; checking the key against the user's keys and rights on the sandbox is S7/S8 (keys and access in Payload).
- The exchange of the SSO code for the `sso` mode is S7/S8, not S6.

An automatic resume on a request to the URL of a stopped sandbox is not done in phase 1.

### 14.3 S5: registering builds

S5 writes `template_builds` (via `umiak-admin template register|promote` or a direct insert in migrations): `template_slug`, `version`, `node`, `pve_vmid`, `disk_layout`, `hw`, `agent_version`, `boot_timeout_s`; then `promote` (the old `active` → `deprecated`). The pool updates itself (§9.4).

### 14.4 S8: what S6 expects from Payload

See §16.

## 15. Worker

### 15.1 pg-boss queues [S6 decision on the parameters]

| Queue | Policy | Key | Data | Parameters |
|---|---|---|---|---|
| `sandbox-op` | `singleton` | `sandboxId` | `{operationId}` | `heartbeatSeconds 30`, `expireInSeconds 3600`, `retryLimit 20`, `retryBackoff`, `retryDelay 2`, `retryDelayMax 120`, dead letter `sandbox-op-dlq` |
| `machine-op` | `singleton` | `machineId` | `{machineId, action: provision \| delete}` | as above |
| `snapshot-op` | `singleton` | `snapshotId` | `{snapshotId, action: delete}` | as above |
| `machine-events` | `stately` | `machineId` | `{machineId}` | `heartbeatSeconds 30`, `expireInSeconds 300`, `retryLimit 10`, `retryBackoff` (without a heartbeat the job of a dead pod would hold the machine's events until expiry, 15 min) |
| `ctl-pool`, `ctl-health`, `ctl-autostop`, `ctl-reconcile`, `ctl-cleanup` | `exclusive` | — | `{}` | `heartbeatSeconds 30`, `expireInSeconds 900`; see below |

- An operation job is only a trigger; the source of truth is the `operations` row. A redelivery is safe (§7.1).
- **Fencing.** pg-boss singleton and heartbeat do not protect against a stuck pod that lost its connection to the DB but still goes to Proxmox: the job will return, and there will be two executors. Therefore each handler at startup increments a counter (`operations.attempt`, `machines.exec_attempt` for `machine-op`) and writes every step conditionally on its own value (§7.1). The old executor gets zero rows on its very first write and exits. Its in-flight Proxmox call is harmless: the steps are idempotent, the allocator gives one lease to one machine (§5.3), and the partial preparation is thrown away on a repeat (§7.4).
- **The node power lock** (2026-10-30). Proxmox start, stop, shutdown requests, delete, and the create/fork rollback in S1 (`MachinesOptions.powerLock`) on one node go one at a time: first an in-process queue (no more than one waiting pool client per node), then `pg_advisory_lock` by the key `power:<nodeId>` on a separate connection. The reason is a race in writing `ethers` and IPAM on parallel start/delete (S1 §12). The lock is never taken inside a DB transaction. Under it, after waiting and right before the Proxmox call, come the S1 owner check (§16) and the caller's callback: for start — a repeated fence check (an executor preempted during the wait does not start the VM), for reconcile (§11.2, power discrepancy) — a repeated check that the machine has not changed. Waiting for the guest to finish shutdown is already outside the lock. Clones (create, fork) are not under it and run in parallel within the slots (§8.3).
- A job in the dead letter means exhausted retries: the operation → `failed` with `error_code = retries_exhausted` and compensation, an alert metric. Dead letter is not used for delete: `retryLimit` without a bound, an alert on `umiak_delete_stuck`.
- **Controllers.** Each controller is an `exclusive` queue (no more than one waiting or active job in the whole cluster). At the end the job enqueues itself again with `startAfter` (10 s pool and health, 15 s autostop, 60 s reconcile, 10 min cleanup). A safety net is the pg-boss cron once a minute on each queue (`exclusive` drops a duplicate). Leader election is not needed.
- **Heartbeat.** Long steps (waiting for boot, shutdown) run in jobs with `heartbeatSeconds 30`. If a pod died, the job returns in ~30 s, and the steps continue from the last written one.

### 15.2 Scaling and shutdown

- The Deployment `worker`, 2 replicas in production, 1 in the PoC. pg-boss works in multi-master mode.
- `localConcurrency` per pod: `sandbox-op` 16, `machine-op` 8, `snapshot-op` 4, `machine-events` 8, controllers 1. The overall load on Proxmox is limited by the clone slots (§8.3), not by the number of pods.
- SIGTERM: `boss.stop({ graceful: true, timeout: 60_000 })`, `terminationGracePeriodSeconds: 90`. Unfinished jobs return by heartbeat; the steps are idempotent.
- Readiness: pg-boss is started and Postgres answers. Liveness: the event loop is not hung.
- Connection pool: a `pg` Pool per pod, 30 connections by default (`UMIAK_DB_POOL_MAX`; it was 20 before the power lock) (pg-boss and Drizzle share one pool through the adapter) [S6 decision]. The power lock (§15.1) holds one connection per node and takes one more under it (owner and fence checks), so the pool size (`UMIAK_DB_POOL_MAX`) must noticeably exceed the number of nodes.

### 15.3 `umiak-admin`

A CLI in `apps/worker` (the same image): `providers add`, `nodes add|cordon|uncordon`, `template register|promote`, `pool status`, `reconcile --dry-run`, `op retry <id>`, `machine delete <id>`. Needed in the PoC before S8.

### 15.4 Cleanup (every 10 min)

- `idempotency_keys` past `expires_at`; `agent_events` and synthetic ones older than 7 days; `commands` older than 90 days; tombstones of `deleted` sandboxes older than 30 days; `sandbox_events` older than 90 days.
- A safety net for `fork_source` (the main path is §7.7): snapshots in `ready`/`failed` whose target is in `error`/`deleted`, and any `fork_source` older than 1 h → delete.
- A sandbox `error` without a machine and without disks older than `errorRetentionDays` (7) → delete.
- If `stoppedRetentionDays` is set — a sandbox in `stopped` longer than this period → delete (`stop_reason` is kept in the events as `retention`). Off by default.
- Re-encryption of `sandbox_secrets` with an old key version.
- pg-boss jobs are cleaned by pg-boss itself (`deleteAfterSeconds` 7 days).

## 16. Assumptions about other areas

- **S1.** `packages/pve` as in the S1 spec: `create`/`fork` accept `smbios1`, `snapshot` accepts `QuiesceHook`, `delete` with verification and lease release, a replaceable `AllocatorStore`, `usage()`, `start`/`shutdown`/`stop`, QGA `ping`. Small additions that S6 itself makes in `packages/pve`, agreed with `s1-impl`:
  - `AllocatorStore.allocate` gets `ownerId` (= `machineId`) so that the S6 implementation is idempotent by machine (§5.3);
  - `configure(vmid, {cores, memory})` for resizing a stopped VM (§7.6);
  - reading the status of one VM and a batch read of all pool VMs (`/cluster/resources`) for reconcile;
  - `lv.list` by tags exposed outward (for reconcile);
  - QGA `exec` through the PVE API (agent restart, §11.1);
  - a client factory per (provider, node) instead of a global configuration from env (§8.4); the S1 env stays for `apps/bench`.
  - an owner check for `start`/`stop`/`shutdown`/`delete` (2026-10-30): an optional `expectedOwner` (`machineId`; `delete` also accepts `null` — an orphan VM without a lease). Right before the action S1 reads the VMID lease (`checkLeaseOwner`) and on a foreign or missing lease throws `OwnerMismatchError` (permanent, code `owner_mismatch`) without touching Proxmox; a delete that has neither the owner's lease nor a VM does nothing;
  - `Allocator.reserveForDelete(vmid)`: a delete of a VMID without a lease first occupies it with a `releasing` lease without an owner so that create does not issue this VMID before the delete ends; the final release removes only the `releasing` row of its owner (`null` for a reservation), and does not touch a foreign lease;
  - `MachinesOptions.powerLock`: a wrapper under which S1 performs the create/fork rollback (delete) — the same node power lock as the worker's (§15.1);
  - `allocate(ownerId)` in a race of two calls of one owner returns the already inserted lease of this owner (`reused`) instead of iterating over the range.
- **S2.** The `tunnel.*` tables, `POST /v1/machines/{id}/rotate-token` on the gateway's internal listener, synthetic events, `agent-client` with retries and a wait of up to 30 s.
- **S3.** RPC (names are S3's):
  - `System/Claim{reason: claim | resume | recover, sandboxId, hostname, env, secrets, secretFiles, authorizedKeys}` — idempotent by `requestId`, answers after applying (or streams phases, the result `ready`); after boot (resume, recover, reprovision) the sets are delivered by `System/UpdateEnv`, `System/UpdateSecrets`, and `System/UpdateSshCa` (S3 §8.1; the `provision` step, §7.6);
  - `System/PrepareStop` — best effort;
  - `System/Quiesce` with a lease and watchdog and `Thaw` — the implementation of `QuiesceHook`;
  - `System/Info` — version, capabilities, readiness phase;
  - `System/Activity` — the current `{runningCommands, openPtys, tcpStreams}`, `NO_SIDE_EFFECTS` (the live check before idle-stop, §12);
  - events: `phase{pool_ready | ready | secrets_missing}`, `command.exited`, `pty.closed`, `activity{runningCommands, openPtys, tcpStreams}` (on 0 ↔ non-0 transitions and every 60 s), `ports.changed`, `quiesce.watchdog_thawed`;
  - identity change on a new `machineId` (fork, a VM from a snapshot).
- **S4.** Uses §14.2. The `tcpStreams` counter is provided by the agent (it is the CONNECT server), the gateway sends nothing for activity.
- **S5.** Registers builds (§14.3). The template contains the agent and qemu-guest-agent.
- **S7.** Builds HTTP on top of `SandboxService`; creates `commands` before `Process/Start`; calls `touchApiActivity`; exposes the internal endpoints of §10.1 and §14.2; the id and error format.
- **S8.** Collections: Templates (`slug`, `os`, `enabled`, `defaultSize`, `allowedSizes`), Sizes (`slug`, `vcpu`, `memoryMb`), PoolTargets, Quotas (per team), PlatformDefaults (a global setting); the `afterChange` hooks send `NOTIFY umiak_config`; the Payload config is exported by a package without Next so that `api` and `worker` can call `getPayload`. The user's public SSH keys for `authorizedKeys`.
- **S9.** Windows deadlines (§7.9), `boot_timeout_s`, a Windows snapshot only from a stopped VM with `forceStop` (§7.8, S9 §24.8) and protection of the secret files of a saved snapshot (§7.8).
- **S12.** The Deployment `worker` (2 replicas, grace 90 s), a Secret with the data keys (`UMIAK_DATA_KEYS_FILE`), the PVE and `umiak-node` Secret, a NetworkPolicy for `/internal/v1/*`, Postgres 18.

## 17. Libraries

Versions checked on 2026-10-29 (`npm view`); re-check during implementation and take the latest stable.

| Purpose | Library | Version |
|---|---|---|
| Job queue | `pg-boss` | 12.38.0 |
| ORM (types and queries) | `drizzle-orm` | 0.45.4 (the same line as `@payloadcms/db-postgres` 3.92.1); `drizzle-kit` 0.31.11 — at the implementer's option only as a helper for generating SQL, the source of truth is the files in `db/migrations/` |
| Postgres driver | `pg` | 8.23.1 (shared by pg-boss and Drizzle) |
| Payload Local API | `payload` | 3.92.1 |
| Validation | `zod` | 4.6.7 |
| Postgres | — | 18.6 (19 is still RC, GA planned 2026-11-19) |
| ULID for `commandId` | `ulid` | 3.0.2 |

Rejected: `graphile-worker` 0.18.0. It is good, but it has no global concurrency limit per group, no `singleton`/`stately`/`exclusive` policies out of the box, and no transactional send through a Drizzle adapter, while the architecture already assumes pg-boss. Kysely (0.29.7) is not taken so as not to keep a second query layer next to Payload's Drizzle.

## 18. Tests and acceptance

**Unit (vitest):**
- tables of Sandbox, Machine, Operation transitions: every invalid transition is rejected; the invariants of §6.4 are checked by property tests on random sequences of events;
- admission and eviction, clone slots, idempotency (the same and a different hash), encryption (AAD, key rotation), parsing the route label.

**Integration** (a real Postgres 18 in a container, pg-boss, fakes of the S1 `packages/pve` and `agent-client`/gateway):
- **The failure matrix.** For each operation and each step: a crash after the side effect, before the `step` write. A repeat brings it to the end, the Proxmox fake has no extra VMs and LVs, no dangling leases.
- **Concurrency.** Two worker processes, 30 parallel creates with a RAM limit for 3 machines: no more than 3 accepted, the rest `out_of_capacity`; `reserved` and `powered` (§8.1) never exceeded the limit (checked after every transaction). The same with eviction of warm machines. Parallel creates of one team do not exceed the quota. Delete during create, cold create, fork (including while the target waits for the snapshot). A double `Idempotency-Key`.
- **Fencing.** Two executors of one operation (the second starts when the first's heartbeat expires): the first exits on its first step write, the Proxmox fake has one VM and one lease.
- **Pool.** Filling to the target, replacement on a new build, eviction of warm machines of another pair for a create, deleting a warm machine when the agent is disconnected.
- **Events.** Duplicates and reordering of events, `rebooted` moves commands to `lost`, degraded after 60 s and back.
- **Auto-stop.** Idle does not fire with `runningCommands > 0`, with an open PTY, with `tcpStreams > 0`, with a fresh API call, and with an unavailable agent; the TTL always fires.
- **Reconcile.** Injected orphans (VMs, LVs, `releasing` leases) are cleaned up; foreign objects (VMs outside the pool, LVs without a tag) are not touched.

**E2E on `pve`** (after S3, S4, S5): the scenario `umiak-bench s6` in `apps/bench`:
- the pool fills;
- create from the pool → exec → stop → resume → exec;
- fork of a running sandbox: the marker file is in place, the identity is new;
- save snapshot → create from it;
- cold create with an empty pool;
- delete everything;
- an injected orphan is cleaned by reconcile;
- the "world before" and "world after" match (S1 `inventory`).

Measurements: claim-to-ready, cold create, stop, resume, fork, save snapshot (median and p95).

**S6 readiness criterion:** the unit and integration tests pass; the E2E scenario on `pve` passes within 8 GB and leaves no traces.

## 19. Implementation stages

The plan is written separately (`docs/plans/s6-*.md`). Recommended order:
1. **PoC:** `packages/db`, `packages/core` (states, admission, idempotency, encryption), `packages/config` (static), the worker with `sandbox-op`/`machine-op`, create (claim + cold), delete, the pool, event intake, health, reconcile (dry-run, then enable).
2. **MVP:** stop/resume, fork, saved snapshots, recover, auto-stop, cleanup, `PayloadConfigReader` (after S8), endpoints for S4.

## 20. Left to the implementer

- The file layout inside packages, id generation (`uuidv7()` in the DB or in code), the format of the canonical body for the idempotency hash.
- The Postgres test infrastructure (testcontainers, a CI service, or PGlite for unit tests if pg-boss and Drizzle work with it identically).
- Log and metrics libraries (`pino`, `prom-client`, or the OTel SDK) — the latest stable; the list of metrics: pool size by pair and state, operation duration and outcome by kind, error causes, used RAM and the limit per node, reconcile actions, the number of `degraded`, pg-boss queue depth, event processing lag, `umiak_delete_stuck`.

## 21. Answers to the open questions (master session, 2026-10-29)

1. **TTL.** An explicitly set TTL stays hard, but the default is `ttlSeconds = null`. The main protection against costs is idle-stop at 900 s (§12).
2. **Retention of stopped sandboxes.** In the PoC there is no default limit (`stoppedRetentionDays` is off).
3. **Starting a stopped sandbox on a request to its URL** — phase 2.

Left for phase 2: moving a sandbox between nodes and archiving stopped ones to PBS will need a new machine for the same sandbox; the 1:N model already allows this.


**An addendum to the lock check (S9 follow-ups).** Stop inside a VM deletion and the rollback
do not bypass `retryOnVmLock`: the whole deletion attempt is repeated with a new check of the
lease owner, the shared node power lock is released between attempts.
The fake-PVE regression holds the lock for up to 30 s, then confirms the deletion.
