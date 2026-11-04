# S6 Control plane: implementation plan

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, a review by a fresh subagent after each task) and superpowers:test-driven-development. Steps are `- [ ]` checkboxes.

**Goal:** implement S6 per `docs/specs/s6-control-plane.md`: the `runtime` data model with migrations, state machines, the `SandboxService` service layer for S7, `apps/worker` on pg-boss (operations, warm pool, controllers), encryption of env and secrets, and the local `deploy/compose` stack.

**Architecture:** `packages/db` — the SQL migration runner from `db/migrations/`, the Drizzle schema, transactions, `PgAllocatorStore`, a test Postgres. `packages/config` — `ConfigReader` (static YAML). `packages/core` — domain logic without HTTP and without Proxmox: states, admission, idempotency, encryption, `SandboxService`, event intake, routes; enqueues pg-boss jobs in its own transaction. `apps/worker` — queue handlers and controllers; it reaches Proxmox and the agent only through ports (`NodeInfra`, `AgentPort`, `GatewayPort`), which have fakes for tests and real adapters (`@sbx/pve`, HTTP gateway).

**Stack:** Node 26.13.0 (native type stripping: TS without a build, imports with `.ts`, like `packages/pve`), TypeScript 7 (`tsc --noEmit`), vitest 5, biome 2. Libraries (checked with `npm view` 2026-10-29): `pg-boss` 12.38.0, `drizzle-orm` 0.45.4, `pg` 8.23.1 + `@types/pg` 8.23.1, `zod` 4.6.7, `ulid` 3.0.2, `yaml` 2.9.1, `pino` 10.4.0, `prom-client` 15.1.3, `fast-check` 4.10.2 (dev). Postgres 18.6 (`postgres:18.6-alpine`).

**Specification:** `docs/specs/s6-control-plane.md` (source of truth; the § numbers below are from it). Related: S1 (`packages/pve`), S2 §5.2, §7, §9.6 and the migration `0100_tunnel_init.sql` from `s2-impl`, S3 §8 and §16, S4 §4.2, S7 §5.3–5.7, §7.5, §8, §20, S8 §17.2, §20.1.

## Global constraints

- Tools only via mise (`mise exec -- <cmd>`). Before adding a dependency, re-check the latest stable version.
- Packages: `@sbx/db` (`packages/db`), `@sbx/config` (`packages/config`), `@sbx/core` (`packages/core`), `@sbx/worker` (`apps/worker`). `packages/pve` style: `"exports": {".": "./src/index.ts"}`, `tsconfig` with `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`; scripts `test` (`vitest run`) and `typecheck`. No build: the process is started with `node src/main.ts`.
- `erasableSyntaxOnly`: no `enum`, `namespace`, parameter properties. String enumerations are `as const` arrays + union types.
- Migrations: `db/migrations/NNNN_<name>.sql`, S6 — **0200–0299**, plain SQL without `BEGIN/COMMIT` (the runner wraps the file in a transaction). S2 — 0100–0199 (`s2-impl`), S7 — 0300–0399, S8 — 0400–0499.
- Secrets (env, secrets, secretFiles, BS, MT, port tokens) never end up in logs, `operations.request`, `idempotency_keys.response`, pg-boss job data (ids only), metrics. The pino logger with `redact` on the paths `*.env`, `*.secrets`, `*.secretFiles`, `*.bs`, `*.token`, `*.serial`.
- Postgres in tests: `SBX_TEST_DATABASE_URL`, otherwise the global setup starts `postgres:18.6-alpine` via the docker CLI (as in `s2-impl`); `SBX_TEST_SKIP_PG=1` — skip, otherwise missing Docker is an error.
- **Run nothing** on `pve` until master allows it. Host rules after permission: VMID 500+ (599 is the template, do not change), ≤ 8 GB RAM for sandbox VMs, `local-lvm`, do not touch VMs/LXCs < 500, `vmbr0`, templates 9000/9001, no firewall/SDN/host changes, clean up everything.
- Do not edit S2 code. Report S2/S3 contract discrepancies to master.
- Code comments in English. No `Claude-Session:` in commits.

## Implementer's decisions (deviations and spec clarifications)

1. **`AllocatorStore` in S1 is synchronous** — a Postgres implementation is impossible that way. In `packages/pve` (S6 §16 allows small additions): `AllocatorStore` methods return `T | Promise<T>`, `Allocator` methods are async; `VmidLease.ownerId?: string`, `AllocatorStore.findByOwner?(cluster, ownerId)`; `Allocator.allocate(ownerId?)` first looks for the owner's lease not in `releasing`. `Machines.create/fork` accept `ownerId`; `Machines.snapshot(vmid, {hook?, id?})` — an external `QuiesceHook` (S3) and the snapshot id; `StorageDriver.snapshot(m, hook, opts?: {id?})`. `apps/bench` and `SqliteStateStore` are adapted. The fakes `test/fakes.ts` are exported as `@sbx/pve/testing`.
2. **Snapshot id in the LV.** `sbx-node` accepts a snapshot id `[a-z0-9]{1,32}`, so the LV id = the snapshot UUID without dashes (`snapshots.id` → 32 hex).
3. **Ids are generated in code** (`uuidv7()` in `@sbx/core`), not `DEFAULT uuidv7()`: the `idempotency_keys` row is written first in the create transaction and must already know the sandbox and operation ids. `DEFAULT uuidv7()` is still in the DDL.
4. **`machines.ready_boot_id text null`** (an addition to §5.4): the `boot_id` on which the agent reported the phase `pool_ready`. The `boot` step and pool preparation wait for `ready_boot_id = tunnel_sessions.boot_id` with `state = connected`. This way the wait does not depend on event processing order.
5. **`machines.agent_phase text null`, `sandboxes.listening_ports jsonb null`** — the last phase state and `ports.changed` (S7 §20.2 item 8 reads it).
6. **Applied migrations table** — `public.sbx_schema_migrations(version int pk, name text, sha256 text, applied_at timestamptz)`; lock `pg_advisory_lock(727001)`.
7. **Transactions** — `withTx(pool, fn)` in `@sbx/db`: `BEGIN` on a `PoolClient`, Drizzle on top of the same client; pg-boss `send` gets `{db: {executeSql: client.query}}` and writes the job in the same transaction.
8. **Dead letter.** The `sandbox-op-dlq` handler: for `delete` it re-enqueues the job (`startAfter` 60 s) and the metric `sbx_delete_dead_letter_total` (alert `sbx_delete_stuck` — a gauge in health: delete longer than 30 min); for the others — `failed`, `retries_exhausted`, and compensation (§15.1).
9. **Principal** — the form of S7 §7.5 (`kind`, `userId | null`, `teamId`, `role`, `isOperator`, `apiKeyId?`, `scopes`). The idempotency principal is `apiKeyId ?? userId`. S6 adds the columns of S7 §20.2 item 9: `sandboxes.created_by_key`, `operations.requested_by_key`.
10. **From S7 §20.2 done in S6 right away** (cheap and within our migrations): item 7 (`resume`/`recover` with an active operation of the same kind return it; `resume` — when the body hash matches), item 12 (`extend(p, id, ttlSeconds?)`), item 13 (`NOTIFY sbx_operations`), O7 (`NOTIFY sbx_routes` with payload = slug, triggers on `sandboxes` and `hosted_ports`). The rest (§20.2 items 1–6, 8, 10–11) is S7.
11. **Slug.** The grammar of S4 §4.2 / S7 §5.4 (validation in core). If no slug is passed, core generates three words from a built-in dictionary (~300 words) with up to 5 retries, then four words; S7 may replace the dictionary with its own (~1500).
12. **There is no real adapter for the agent RPC (S3)**: `proto/sbx/agent/v1` does not exist yet. `AgentPort` is an interface + a fake; the real implementation on `@sbx/agent-client` will appear with S3. Until then the worker in compose runs with `UnavailableAgentPort` (every call is a retryable `agent_unavailable`).
13. **Agent events.** core accepts already decoded JSON (`payload` is an object); protojson and `Any` are parsed by S7. Internal names are from S6 §10.2; the adapter of S3 names (`readiness.changed`, `quiesce.auto_thawed`, `identity.reset`, `claim.applied`) is `normalizeAgentEvent` in core. S3 has no `activity` and `System/Activity` (it has `idle.changed{idle, since}`) — an open question; idle-stop is implemented per S6.
14. **Topology and template 599** are created by `sbx-admin bootstrap` from the `topology` section of the same YAML as `StaticConfigReader`, not by a migration (environment data does not belong in migrations).
15. **`ctl-idp-sync`** (S8 §17.2 S6): an `exclusive` queue every `SBX_IDP_SYNC_INTERVAL` (300 s) in the worker calls a pluggable `IdpSync.run()`; the logic is in `@sbx/payload` (S8). Without an implementation the controller is not registered.
17. **Warm pool simplified (Ilia's decision via master, 2026-10-29: cold Linux create ~12 s, the pool is not needed in the MVP).** What is already done stays: claim from the pool and `failFast`/`pool_exhausted` in `SandboxService.create` (Task 7), pool machine preparation `machine-op provision` (Task 9). The `ctl-pool` controller (Task 11, §9.2) is **not built** — phase 2; the seam for it: `machine-op provision` and `pool_key`. Pool targets default to 0 (`StaticConfigReader` and compose). The main path is cold create: the failure matrix and the end-to-end tests of Tasks 10 and 13 follow it; the claim path in Task 10 is covered by one scenario without pool setup.
16. **The `tunnel` schema before the S2 merge.** After the migrations, the test helper applies the fixture `packages/db/test/fixtures/0100_tunnel_init.sql` (a copy of the file from `s2-impl`) only if the `tunnel` schema is absent. After `main` is merged with S2 the fixture is not applied and is removed.

## Review Focus

1. **A repeated create after a failure between S1 `create` and writing `vmid` to the machine.** A lease with `machine_id` exists, the VM exists, `vmid` in the machine is null. The retry must find the lease by `machine_id`, delete the VM via S1 `delete`, release the lease, and prepare again. Test — task 9 (preparation failure matrix).
2. **Double job delivery and a stuck executor.** Two handlers of one operation: the old one gets 0 rows on its first step write and exits without further side effects. Test — tasks 9 and 10 (fencing).
3. **Admission race from several processes.** 30 parallel creates with a limit of 3 machines: `reserved` and `powered` are never above the limit. Test — task 6 (parallel transactions on separate connections) and task 13 (two worker processes).
4. **Delete during any operation**, including a fork target waiting for a snapshot and a cold create waiting for RAM. Expectation: the fake has no VM, LV, lease; `fork_source` snapshots are removed; saved snapshots are alive. Test — task 10.
5. **Secret leak.** No env/secrets/secretFiles value appears in `operations.request`, `idempotency_keys.response`, `pgboss.job.data`, or the worker logs. Test — task 10 (a search for a marker string in the dump of these tables and in captured logs).

---

### Task 1: `packages/pve` additions (async allocator, ownerId, hook, snapshot id)

**Files:**
- Modify: `packages/pve/src/allocator.ts`, `src/machine.ts`, `src/storage/types.ts`, `src/storage/lvmthin.ts`, `src/state-sqlite.ts`, `package.json` (`exports["./testing"] = "./test/fakes.ts"`)
- Modify: `apps/bench/src/*.ts` (await the new async methods)
- Test: `packages/pve/test/allocator.test.ts`, `test/machine.test.ts`, `test/lvmthin.test.ts`

**Interfaces:**
- Produces: `AllocatorStore { tryInsert(l): boolean | Promise<boolean>; get(...): VmidLease | undefined | Promise<…>; list(...); setState(...); remove(...); findByOwner?(cluster: number, ownerId: string): VmidLease | undefined | Promise<…> }`; `VmidLease.ownerId?: string`; `Allocator.allocate(ownerId?: string): Promise<{vmid, mac}>`, `markActive/markReleasing/release/ensureTemplate/get/list` — async. `Machines.create(opts: {size?, smbios?, ownerId?})`, `Machines.fork(snap, {size?, smbios?, ownerId?})`, `Machines.snapshot(vmid, {crashConsistent?, hook?: QuiesceHook, id?: string})`. `StorageDriver.snapshot(m, hook, opts?: {id?: string})`.

- [ ] **Step 1: tests** — `allocate("m1")` twice returns the same VMID; after `markReleasing` — a new one; a store with async methods (a wrapper over a Map with `await Promise.resolve()`) works; `Machines.snapshot(vmid, {hook, id: "abc"})` calls `hook.freeze/thaw` and creates the LV `sbx-snap-abc-scsi0`; `snapshot` without `hook` on a running VM still goes through QGA.
- [ ] **Step 2:** run, make sure they fail.
- [ ] **Step 3:** implement. `SqliteStateStore` stores `owner_id` (SQLite schema migration: `ALTER TABLE … ADD COLUMN` if absent) and implements `findByOwner`.
- [ ] **Step 4:** `pnpm --filter @sbx/pve test`, `pnpm --filter @sbx/bench test`, `pnpm -r typecheck`, `pnpm lint` — green.
- [ ] **Step 5:** commit `pve: async allocator store, lease owner, external quiesce hook and snapshot id (S6 §16)`.

### Task 2: `packages/db` — migrations, schema, transactions, test Postgres

**Files:**
- Create: `db/migrations/0200_runtime_init.sql`, `db/migrations/0201_runtime_triggers.sql`
- Create: `packages/db/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/migrate.ts`, `src/tx.ts`, `src/schema/runtime.ts`, `src/schema/tunnel.ts`, `src/testing/{global-setup.ts,database.ts,index.ts}`, `test/fixtures/0100_tunnel_init.sql`
- Test: `packages/db/test/migrate.test.ts`, `test/schema-drift.test.ts`, `test/triggers.test.ts`

**Interfaces:**
- Produces:
  - `migrate(pool: pg.Pool, opts?: {dir?: string; log?: (msg: string) => void}): Promise<{applied: string[]}>` — by number, file in a transaction, advisory lock, sha256; a changed applied file → `MigrationChecksumError`.
  - `missingMigrations(pool, dir?): Promise<string[]>` — known to the code but not applied (for readiness; newer unknown ones are allowed).
  - `MIGRATIONS_DIR` — the absolute path to `db/migrations` (via `import.meta.url`), overridable by `SBX_MIGRATIONS_DIR`.
  - `createPool(url: string, max = 20): pg.Pool`; `type Db = NodePgDatabase<typeof schema>`; `interface Tx { db: Db; client: pg.PoolClient }`; `withTx<T>(pool, fn: (tx: Tx) => Promise<T>): Promise<T>` (rollback on exception); `dbOf(pool): Db`.
  - `schema` — all `runtime` tables (§5.1–5.9, §8.3) and `tunnel` (`gateway_instances`, `tunnel_sessions`, `tunnel_credentials`), camelCase fields.
  - `@sbx/db/testing`: `globalSetup` (vitest, provide `sbxPgAdminDsn`), `createTestDatabase(): Promise<{url, pool, db, drop()}>` — a separate DB per test file from the template `sbx_tmpl`, which is migrated once (with the tunnel fixture, decision 16).

DDL (decisions on top of §5): all columns from §5 with `NOT NULL` where the value is always present; `CHECK` on enumerations; FKs inside `runtime`; no FKs on `tunnel`. Additionally: `machines.ready_boot_id`, `machines.agent_phase`, `sandboxes.listening_ports`, `sandboxes.created_by_key`, `operations.requested_by_key`, `snapshots.lv_id text` (32 hex). Indexes: `operations(sandbox_id) WHERE state IN ('pending','running')` unique; `machines(node_id, state)`; `machines(pool_key, state)`; `machines(sandbox_id)`; `sandboxes(team_id, created_at desc)`; `agent_events(machine_id) WHERE processed_at IS NULL`; the partial uniques from §5. `node_clone_slots` from §8.3.

Triggers (`0201`): forbid changing `machines.sandbox_id` from non-`null`; `NOTIFY sbx_sandboxes '<id>'` on a change of `state`/`health`; `NOTIFY sbx_routes '<slug>'` on a change of `state`, `machine_id`, `slug` of a sandbox (for slug — old and new) and any change of `hosted_ports`; `NOTIFY sbx_operations '<id>'` when an operation moves to `succeeded|failed|superseded`.

- [ ] **Step 1: tests** — `migrate` applies 0200/0201 and a second call does nothing; a changed file → `MigrationChecksumError`; two parallel `migrate` calls do not fail (lock); `missingMigrations` is empty after migrate; a drift test: for each Drizzle table the set of columns, type (`information_schema.columns.udt_name`) and nullability match the live DB; the `sandbox_id` trigger rejects the change; `LISTEN sbx_routes` receives the old and new slug on rename; `sbx_sandboxes` — on a `state` change.
- [ ] **Step 2:** run — they fail.
- [ ] **Step 3:** implement the SQL, the runner, the schema, the helpers.
- [ ] **Step 4:** `pnpm --filter @sbx/db test`, typecheck, lint.
- [ ] **Step 5:** commit `db: runtime schema migrations, runner, drizzle schema and test postgres`.

### Task 3: `PgAllocatorStore`

**Files:** Create `packages/db/src/allocator-store.ts`; Test `packages/db/test/allocator-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `AllocatorStore`; Task 2 `vmid_leases`.
- Produces: `class PgAllocatorStore implements AllocatorStore { constructor(pool: pg.Pool, providerId: string) }`. The S1 `cluster` argument is ignored (one store per provider). `tryInsert` — `INSERT … ON CONFLICT DO NOTHING`, a conflict on `(provider_id, vmid)`, `mac`, or `machine_id` → `false`. `ownerId` ↔ `machine_id`.

- [ ] **Step 1: tests** — a real `Allocator` on top of the store: two parallel `allocate()` calls of different owners give different VMIDs; `allocate("m")` twice — one VMID; 20 parallel `allocate` calls from two connection pools — no duplicates; `release` deletes the row; the template lease (`purpose = template`) is not issued.
- [ ] **Step 2–4:** fail → implement → pass (`pnpm --filter @sbx/db test`).
- [ ] **Step 5:** commit `db: postgres allocator store`.

### Task 4: `packages/config` — `ConfigReader` and `StaticConfigReader`

**Files:** Create `packages/config/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/types.ts`, `src/static.ts`; Test `packages/config/test/static.test.ts`, fixture `test/fixtures/poc.yaml`

**Interfaces:**
- Produces: types `TemplateConfig {slug, os: "linux"|"windows", enabled, defaultSize, allowedSizes: string[]}`, `SizeConfig {slug, vcpu, memoryMb}`, `PoolTarget {templateSlug, sizeSlug, providerId?, target, maxAgeHours?}`, `Quota {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}`, `PlatformDefaults {ttlSeconds: number|null, maxTtlSeconds, idleTimeoutSeconds: number|null, stoppedRetentionDays: number|null, errorRetentionDays, recoverMinIntervalSeconds, defaultTemplate}`, `interface ConfigReader` (§5.11). `StaticConfigReader.fromFile(path)`, `StaticConfigReader.fromObject(obj)`; `topology(): TopologyConfig` (decision 14: `providers[{name, clusterMacId, vmidMin, vmidMax, apiUrl, tlsName, secretRef, nodes[{name, ramCapMb, cloneConcurrency, nodeAgentRef, storages[{name, driver, dataMaxPct, metaMaxPct}]}]}]`, `templateBuilds[{templateSlug, version, os, node, storage, pveVmid, bootTimeoutS, agentVersion, diskLayout, hw}]`). zod validation; an unknown team → `quotas.default`. The defaults of §5.11 and the PoC quota of S8 (3, 6144, 10).

- [ ] **Step 1: tests** — parsing `poc.yaml`; invalid YAML → an error with the field path; `defaultSize ∉ allowedSizes` → error; `teamQuota("unknown")` = default.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `config: ConfigReader and static YAML reader`.

### Task 5: `packages/core` — pure modules

**Files:** Create `packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `src/errors.ts`, `src/ids.ts`, `src/slug.ts`, `src/slug-words.ts`, `src/label.ts`, `src/canonical.ts`, `src/secrets.ts`, `src/states.ts`, `src/principal.ts`, `src/index.ts`; Test `test/{errors,ids,slug,label,canonical,secrets,states}.test.ts`

**Interfaces:**
- Produces:
  - `class SbxError extends Error {code: ErrorCode; retryable: boolean; details: Record<string, unknown>}`; `ErrorCode` — the codes of §14.1 plus `slug_taken`, `snapshot_name_taken`, `agent_unavailable`, `retries_exhausted`; factories `notFound()`, `invalidState(state)`, `operationInProgress(op)`, `outOfCapacity(retryAfterSeconds)`, `poolExhausted(retryAfterSeconds)`, `quotaExceeded(quota, limit, current)`, `validation(issues)`.
  - `uuidv7(): string`; `uuidv5(name: string, namespace = SBX_NAMESPACE): string`; `stepRequestId(operationId, step): string` (UUIDv5 of `"<operationId>:<step>"`, §7.1 item 4).
  - `validateSlug(s): void` (S4 §4.2: `[a-z0-9]+(-[a-z0-9]+)*`, 3–40, not `-<digits>` at the end, not the reserved suffix `-desktop`, not one of `api, app, www, ssh, tunnel, admin, static, sbx`); `generateSlug(words = 3, rnd?): string`; `RESERVED_SLUG_SUFFIXES`, `RESERVED_SLUGS`.
  - `parseLabel(label): {slug, port} | null`; `portLabel(slug, port)`.
  - `canonicalJson(v): string` (keys sorted, `undefined` dropped), `requestHash(scope, body): Buffer` (sha256 of `scope + "\n" + canonicalJson(body)`).
  - `interface SecretSets {env: Record<string,string>; secrets: Record<string,string>; secretFiles: SecretFile[]}`, `SecretFile {name, contentBase64, mode?, linkPath?}`, `SecretPatch {env?: Record<string,string|null>; secrets?: …; secretFiles?: Record<string, Omit<SecretFile,"name"> | null>}`; `applySecretPatch(base, patch): SecretSets`; `validateSecretSets(s): void` (limits of S7 §8.3, `SBX_` except `SBX_API_KEY|SBX_API_URL|SBX_TEAM|SBX_PROFILE`); `class KeyRing {static fromFile(path); static fromObject({current, keys}); encrypt(sandboxId, sets): {keyVersion, nonce, ciphertext}; decrypt(sandboxId, row): SecretSets; currentVersion}` — AES-256-GCM, 12-byte nonce, the tag at the end of the ciphertext, AAD `sandbox:<id>:v<ver>`; `encryptFor(aadPrefix, id, …)` for S8 environments.
  - `states.ts`: `SANDBOX_STATES`, `MACHINE_STATES`, `OPERATION_STATES`, types; `sandboxNext(from: SandboxState, ev: SandboxEvent): SandboxState` (throws `invalid_state`), `machineNext(from, ev)`, `operationNext(from, ev)`; events are the string names of the §6.1 table (`create`, `create_done`, `create_failed`, `stop`, `stop_done`, `stop_failed`, `unexpected_stop_first`, `unexpected_stop_repeat`, `resume`, `resume_done`, `resume_failed`, `recover`, `delete`, `delete_done`, `machine_lost`) with conditions (`resume` from `error` only with `machineState = stopped`; `recover` from `error` when the machine is not `failed|deleting|deleted`); `RESERVED_MACHINE_STATES`, `POWERED_MACHINE_STATES` (§8.1).
  - `Principal` (S7 §7.5), `idempotencyPrincipal(p): string`.

- [ ] **Step 1: tests** — for each transition table: all allowed pairs give the right state, all other `(state, event)` pairs → `invalid_state`; a fast-check property test: random event sequences from `ready` never leave `deleted`, `deleted` is terminal; the `machine.sandbox_id` invariant "from `claiming` back to `warm` is not allowed"; slug: `quiet-otter-lamp` ok, `ab`, `a--b`, `box-123`, `x-desktop`, `api`, 41 characters — error, `generateSlug()` passes `validateSlug` 1000 times; `parseLabel("my-box-5173")` = `{slug:"my-box", port:5173}`, `"box-0"`/`"box-65536"` → null; encryption: roundtrip; a different AAD (another sandbox) → error; rotation: a record written under v1 is read with current=2; `applySecretPatch` with `null` deletes the key, a file is replaced by name; 101 variables, `SBX_FOO`, the 33rd file → `validation`; `canonicalJson({b:1,a:{d:1,c:2}})` = `{"a":{"c":2,"d":1},"b":1}`; `stepRequestId` is deterministic and differs for different steps.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `core: errors, ids, slug, secrets crypto, state machines`.

### Task 6: `packages/core` — capacity, quotas, slots, placement

**Files:** Create `packages/core/src/capacity.ts`, `src/clone-slots.ts`, `src/placement.ts`, `src/locks.ts`; Test `test/capacity.test.ts`, `test/clone-slots.test.ts`, `test/placement.test.ts`

**Interfaces:**
- Consumes: Task 2 `withTx`, `Tx`; Task 5 errors.
- Produces:
  - `lockTeam(tx, teamId)`, `lockNode(tx, nodeId)` — `pg_advisory_xact_lock(hashtextextended('team:'||id, 0))` / `'node:'`; the order is always team → node.
  - `nodeRam(tx, nodeId): Promise<{capMb, reservedMb, poweredMb}>` — exactly the definitions of §8.1.
  - `admit(tx, {nodeId, needMb, pairKey: string | null, evict: boolean}): Promise<{ok: true; evicted: string[]} | {ok: false}>` — §8.2; evicted machines (`warm`, `pool_key <> pairKey`, oldest first) → `deleting` + a job `machine-op {machineId, action: "delete"}` via `JobSender` (Task 7 `jobs`; before that — the parameter `onEvict(machineIds)`).
  - `tryPoweredStart(tx, {machineId, toState: "booting" | "starting"}): Promise<boolean>` — under `lockNode`: `powered + need ≤ cap` → machine transition (conditional `UPDATE … WHERE state = ANY(from)`) and `true`.
  - `checkQuota(tx, teamId, quota, {addSandboxes, addRamMb}): void` — `quota_exceeded`.
  - `acquireCloneSlot(pool, nodeId, holder, ttlMs = 120_000): Promise<number | null>`, `releaseCloneSlot(pool, nodeId, slot, holder)`, `ensureCloneSlots(tx, nodeId, n)`.
  - `place(tx, {templateSlug, needMb}): Promise<{nodeId, storageId, templateBuildId}[]>` — candidates of §8.4 in descending order of free RAM.

- [ ] **Step 1: tests** — `reserved/powered` for each combination of states (table §8.1, including `stopped` with an active resume and `failed` with `power_observed = running`); `admit` without eviction refuses on shortage; with eviction it picks warm machines of other pairs, oldest first, does not touch its own pair; **concurrency**: 30 parallel transactions (each on its own connection: `lockNode` → `admit` → insert machine `allocating` 2048 MB) with cap 6144 → exactly 3 successes, after each transaction `reserved ≤ cap`; `tryPoweredStart` does not exceed cap with 10 in parallel; quota: the 4th sandbox with `maxActiveSandboxes = 3` → `quota_exceeded`; slots: 5 parallel acquisitions with `clone_concurrency = 4` → 4 slots and `null`; an expired slot is acquired again.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `core: RAM admission, quotas, clone slots, placement`.

### Task 7: `SandboxService` — create, delete, reads; jobs; idempotency

**Files:** Create `packages/core/src/jobs.ts`, `src/queues.ts`, `src/idempotency.ts`, `src/rows.ts` (row to domain type mapping), `src/notifier.ts`, `src/service/index.ts`, `src/service/create.ts`, `src/service/delete.ts`, `src/service/read.ts`, `src/deadlines.ts`; Test `test/service-create.test.ts`, `test/service-delete.test.ts`, `test/service-read.test.ts`, `test/idempotency.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6.
- Produces:
  - `QUEUES` — names and options of §15.1 (`sandbox-op`, `sandbox-op-dlq`, `machine-op`, `snapshot-op`, `machine-events`, `ctl-pool`, `ctl-health`, `ctl-autostop`, `ctl-reconcile`, `ctl-cleanup`, `ctl-idp-sync`); `ensureQueues(boss: PgBoss)`.
  - `interface JobSender { send(tx: Tx, queue: QueueName, data: Record<string, unknown>, opts?: {singletonKey?: string; startAfter?: number}): Promise<void> }`; `PgBossJobSender(boss)` (transactional `send` via `db`); `RecordingJobSender` for tests (`sent: {queue, data, opts}[]`).
  - `Notifier` — one LISTEN connection, `subscribe(channel, fn): () => void`, reconnect.
  - `operationDeadline(kind, os, {fromPool}): number | null` (ms; §7.9).
  - `class SandboxServiceImpl implements SandboxService` — `constructor(deps: {pool; config: ConfigReader; keys: KeyRing; jobs: JobSender; notifier?: Notifier})`. The interface of §14.1 with the `Principal` of S7 §7.5 and `extend(p, id, ttlSeconds?)`. Domain types `Sandbox`, `Operation`, `SavedSnapshot`, `Command`, `HostedPort`, `Page<T> {data, nextCursor: string | null}` — camelCase row fields (`rows.ts`). Inputs: `CreateInput {template?, size?, name?, slug?, labels?, env?, secrets?, secretFiles?: SecretFile[], ttlSeconds?, idleTimeoutSeconds?, from?: {snapshot: string}, failFast?}`.
  - `create` (§7.3): template and size from `ConfigReader` (`template_unavailable`), quota, `place`, claim (§9.5 SQL) → otherwise cold (`admit` with eviction) → otherwise `out_of_capacity` (`retryAfterSeconds: 30`); `failFast`: claim only, otherwise `pool_exhausted` (`retryAfterSeconds: 60`) with a rollback of everything; `failFast` + `from` → `validation`; `from` is a saved snapshot of the team in `ready` (`snapshot_not_found`), the snapshot's node, always cold. In one transaction: `idempotency_keys` (first), sandbox `creating`, `sandbox_secrets`, machine (`claiming` or `allocating`), a `create` operation (`pending`, `request` without secrets, `deadline_at`), `sandbox_events`, a job `sandbox-op {operationId}` with `singletonKey = sandboxId`. Slug collision: a generated one — retry (up to 5 → 4 words), a given one — `slug_taken`.
  - `delete` (§7.2): anything except `deleting/deleted` (there — the current delete operation); an active one → `superseded`, `superseded_by`; sandbox → `deleting`; a `delete` operation without a deadline; the job.
  - `get`, `list(p, {state?: SandboxState[], labels?: Record<string,string>, template?, q?, limit?}, cursor?)` (newest first, cursor base64url `{c: createdAt, id}`, `deleted` only with an explicit filter), `update`, `extend`, `getOperation`, `waitForState`. Another team's resource → `not_found`.

- [ ] **Step 1: tests** (real Postgres, `RecordingJobSender`, `StaticConfigReader`) — create with a `warm` machine of the pair present → machine `claiming`, `sandbox_id`, `pool_key` null, one job, `data = {operationId}`; without warm → machine `allocating` with `sandbox_id`; no RAM → `out_of_capacity` and nothing new in the DB; eviction of a warm machine of another pair → it is `deleting` and a `machine-op delete` job; `failFast` without warm → `pool_exhausted`, no sandbox/secrets/operation/key rows and no jobs; `failFast` + `from` → `validation`; quota; a disabled template and a disallowed size → `template_unavailable`; idempotency: the same key and body → the same sandbox and operation; a different body → `idempotency_key_reused`; two parallel creates with one key → one sandbox; `operations.request` and `idempotency_keys.response` do not contain the secret marker; delete during `create` → create `superseded`, sandbox `deleting`, a delete job; a repeated delete → the same operation; list filters and cursor; another team's resource → `not_found`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `core: SandboxService create, delete, reads, idempotency and jobs`.

### Task 8: `SandboxService` — stop, resume, fork, recover, snapshots, commands, ports, events, routes

**Files:** Create `packages/core/src/service/{lifecycle.ts,fork.ts,snapshots.ts,commands.ts,ports.ts}`, `src/events/ingest.ts`, `src/events/normalize.ts`, `src/routes.ts`; Test `test/service-lifecycle.test.ts`, `test/service-fork.test.ts`, `test/service-snapshots.test.ts`, `test/service-commands-ports.test.ts`, `test/events-ingest.test.ts`, `test/routes.test.ts`

**Interfaces:**
- Consumes: Task 7 (`SandboxServiceImpl`, `JobSender`, `QUEUES`, `rows`).
- Produces:
  - `stop` (§7.5; with an active `stop` — the same one), `resume(p, id, {size?, ttlSeconds?, env?, secrets?, secretFiles?: SecretPatch})` (§7.6: state, quota, `admit` on the sandbox's node with the RAM of the new size, applying secrets in the same transaction; `request = {size, ttlSeconds, bodyHash}`; an active resume with the same hash — the same one), `recover` (§7.8, `recover_rate_limited` by `last_recover_at` and `recoverMinIntervalSeconds`; an active recover — the same one), `fork(p, id, ForkInput, idemKey?)` → `{sandbox, operation, sourceOperation}` (§7.7: target `creating`, source secrets + patch, target AAD, target machine `allocating` on the source's node, `admit` with eviction, a fork operation on the source `pending` with a job, a target create `pending` without a job with `parent_operation_id`; inheriting `template_slug`, `size`, `labels`, `exclude_owner_secrets`), `saveSnapshot(p, id, name, idemKey?)`, `deleteSavedSnapshot`, `listSavedSnapshots`.
  - `resolveAgentTarget` (`sandbox_not_ready` if not `ready`; capabilities from `tunnel_sessions`), `createCommand` (ULID, `starting`, first 64 KiB of `cmd`, `env_keys`), `completeCommand` (a terminal one is not overwritten), `touchApiActivity` (`UPDATE … WHERE last_api_call_at IS NULL OR < now() - 30 s`), `hostPort(p, id, port, mode)` (port 22 and reserved ones → `validation`; `token` → `sbxp_` + 32 bytes base64url, sha256 stored), `unhostPort`, `rotatePortToken` (`auth_epoch + 1`).
  - `normalizeAgentEvent(e): AgentEvent | null` (decision 13), `ingestAgentEvents(pool, jobs, batch: {machineId, events: {seq, bootId, type, time, payload}[], synthetic: {epoch, type, instanceId, time}[]}): Promise<{ackedSeq: number | null}>` — §10.1, a job `machine-events {machineId}` (`singletonKey = machineId`).
  - `routes.lookup(label)` → `{sandboxId, slug, machineId, port, mode, tokenHash, authEpoch, state} | null`; `sshTarget(sandboxIdOrSlug)` → `{sandboxId, machineId, state} | null`.

- [ ] **Step 1: tests** — stop from `ready` → `stopping` and an operation; a second stop → the same operation; resume from `stopped`, from `error` with machine `stopped`, from `error` with machine `failed` → `invalid_state`; resume with `env {A: null, B: "2"}` saves the merged blob in the same transaction as the operation; on `out_of_capacity` the transaction rolls back entirely and the blob is unchanged ("the result stays even if resume failed" refers to an execution error in the worker); a repeated resume with the same body → the same operation, with a different one → `operation_in_progress`; fork: target `creating`, its secrets = source ⊕ patch (decryption with the target's key), the source unchanged; a fork operation with a job, the target create without a job; fork of a source in `stopping` → `invalid_state`; recover more often than 600 s → `recover_rate_limited`; saveSnapshot at `maxSavedSnapshots` → `quota_exceeded`; deleteSavedSnapshot → the snapshot `deleting`, the name is free, a `snapshot-op` job; ingest: a duplicate seq is not inserted, `ackedSeq` = max, one `machine-events` job; synthetic events are deduplicated by `(machineId, epoch, type)`; `routes.lookup("my-box-5173")`; createCommand/completeCommand; hostPort token stores only the hash.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `core: lifecycle, fork, snapshots, commands, ports, agent events, routes`.

### Task 9: `apps/worker` — ports, fakes, step engine, machine preparation, `machine-op`, `snapshot-op`

**Files:** Create `apps/worker/{package.json,tsconfig.json,vitest.config.ts}`, `src/ports.ts`, `src/context.ts`, `src/steps.ts`, `src/machine-prep.ts`, `src/handlers/machine-op.ts`, `src/handlers/snapshot-op.ts`, `src/wait.ts`; `test/fakes/{infra.ts,agent.ts,gateway.ts,crash.ts,world.ts}`; Test `test/machine-prep.test.ts`, `test/machine-op.test.ts`, `test/snapshot-op.test.ts`, `test/fencing.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `ports.ts`:
    - `interface NodeInfra { create(p: {machineId; templateVmid: number; size: {vcpu; memoryMb}; smbios: {uuid; serial}}): Promise<{vmid; mac; disks: InfraDisk[]}>; fork(p: {machineId; snapshot: InfraSnapshotRef; size?; smbios}): Promise<…>; start(vmid); shutdown(vmid, timeoutS): Promise<"stopped" | "timeout">; stop(vmid); status(vmid): Promise<"running" | "stopped" | "paused" | "missing">; configure(vmid, {vcpu, memoryMb}); delete(vmid): Promise<void>; leaseOf(machineId): Promise<{vmid; mac} | undefined>; snapshot(vmid, {lvId: string; hook?: QuiesceHook}): Promise<{disks: InfraDisk[]; hw: Record<string,string>; consistency: "quiesced" | "powered_off"}>; deleteSnapshot(ref: InfraSnapshotRef): Promise<void>; listVms(): Promise<{vmid; status; pool?; tags: string[]}[]>; listLvs(): Promise<{name; tags: string[]}[]>; removeLvs(names: string[]); qgaPing(vmid): Promise<boolean>; qgaExec(vmid, argv: string[]): Promise<{exitCode}>; vmidRange: {min; max}; templateVmids: number[] }`; `InfraDisk {slot, volume, sizeBytes?, options}`; `InfraSnapshotRef {lvId, sourceVmid, disks, hw}`.
    - `interface InfraRegistry { forNode(nodeId: string): Promise<NodeInfra> }`.
    - `interface AgentPort { claim(machineId, req: ClaimRequest, requestId): Promise<void>; updateEnv(machineId, env, requestId); updateSecrets(machineId, {secretEnv, secretFiles}, requestId); prepareStop(machineId): Promise<void>; quiesceHook(machineId, leaseMs): QuiesceHook; activity(machineId): Promise<{runningCommands; openPtys; tcpStreams}> }` (agent restart is `NodeInfra.qgaExec`); errors: `AgentUnavailable` (retryable), `AgentRejected` (permanent).
    - `interface GatewayPort { rotateToken(machineId): Promise<void> }`.
  - `context.ts`: `interface WorkerCtx { pool; db; jobs: JobSender; config: ConfigReader; keys: KeyRing; infra: InfraRegistry; agent: AgentPort; gateway: GatewayPort; timing: Timing; log: pino.Logger; metrics: Metrics }`; `Timing {pollMs: 1000; supersedeCheckMs: 2000; ramWaitPollMs: 1000; agentConnectTimeoutMs?: …}` — tests substitute milliseconds.
  - `steps.ts`: `class Fenced { static begin(ctx, operationId): Promise<Fenced | null> }` (`pending → running`, `attempt + 1`; terminal → `null`; the parent not `succeeded` → `null` or `failed fork_failed`), `recordStep(step, progress?)` (0 rows → `throw new FencedOut()`), `check()` (re-read: `superseded` or another `attempt` → `FencedOut`), `finish(state, error?)`; `runSteps(fenced, steps: {name; skipIf?; run}[])`; `class MachineFence` — the same for `machines.exec_attempt`.
  - `waitUntil(ctx, fence, cond: () => Promise<T | undefined>, {timeoutMs, pollMs}): Promise<T>` — calls `fence.check()` once per `supersedeCheckMs`.
  - `machine-prep.ts`: `prepareMachine(ctx, fence, machineId, source: {kind: "template"} | {kind: "snapshot"; snapshotId}): Promise<void>` — all of §7.4 (a retry from `provisioning`: `leaseOf(machineId)` → `delete(vmid)`; a new 32-byte BS → `tunnel.tunnel_credentials` upsert `bs_hash = sha256(bs)`, `retired_at = null`; clone slot; `create/fork` with `smbios {uuid: machineId, serial: s2SerialPayload(machineId, bs)}`; write `vmid`, `mac`, `disks`; `tryPoweredStart` with waiting; `start`). `waitBooted(ctx, fence, machineId, timeoutMs)` — `ready_boot_id = tunnel_sessions.boot_id` and `connected`.
  - `handlers/machine-op.ts`: `handleMachineOp(ctx, {machineId, action: "provision" | "delete"})` — provision §9.3 (error/timeout → `failed → deleting` + a delete job); delete: `retired_at`, `stop` and `power_observed = stopped`, S1 `delete`, `disks.state = deleted`, machine `deleted`, lease released.
  - `handlers/snapshot-op.ts`: `handleSnapshotOp(ctx, {snapshotId, action: "delete"})` — §7.8 (waits for creates from the snapshot until the `provision` step: throws a retryable `SnapshotInUse` with `startAfter` 30 s).
  - Fakes: `FakeInfra` (in-memory VMs and LVs per node; VMID via the real `Allocator` + `PgAllocatorStore`; `start` "boots" the VM: via `FakeAgentWorld` inserts/updates `tunnel_sessions` with a new `boot_id` and calls `ingestAgentEvents` with `connected` and `phase pool_ready`); `FakeAgent` (call recording, configurable responses: claim refusal, unavailability, activity counters); `FakeGateway`; `crashAfter(target, method, nth)` — a proxy that throws `SimulatedCrash` after the n-th successful call of a method (simulates a pod dying after a side effect).

- [ ] **Step 1: tests** — preparation from a template: machine `booting` → (event) → `warm`, one VM and an active lease in the fake; **preparation failure matrix**: `crashAfter` for each of `create`, `start`, and after writing `booting`; a repeated `handleMachineOp` brings it to `warm`, exactly one VM in the fake, no extra LVs and leases; the BS of the retry differs, after `booting` it does not change; boot timeout → machine `deleting` → `deleted`, no VM and lease; **fencing**: executor A blocks inside `create` (deferred), B starts (attempt+1) and finishes, A after unblocking gets `FencedOut` on the step write and does not call `start`; one VM in the fake; machine delete: `retired_at` is set before `stop`; snapshot-op waits for a create from the snapshot until the provision step.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `worker: ports, fakes, fenced step engine, machine preparation and machine/snapshot ops`.

### Task 10: `sandbox-op` — create, delete, stop, resume, recover, reprovision, fork, save_snapshot

**Files:** Create `apps/worker/src/handlers/sandbox-op.ts`, `src/ops/{create.ts,delete.ts,stop.ts,resume.ts,recover.ts,reprovision.ts,fork.ts,save-snapshot.ts,compensate.ts,claim.ts}`, `src/handlers/dlq.ts`; Test `test/ops-create.test.ts`, `test/ops-delete.test.ts`, `test/ops-stop-resume.test.ts`, `test/ops-fork.test.ts`, `test/ops-snapshot.test.ts`, `test/crash-matrix.test.ts`, `test/secret-leak.test.ts`

**Interfaces:**
- Consumes: Task 9 (`Fenced`, `runSteps`, `prepareMachine`, `waitBooted`, ports), Tasks 7–8.
- Produces: `handleSandboxOp(ctx, {operationId}): Promise<void>` — a dispatcher by `kind`; deadline expired → `compensate(kind)` and `failed`; a transient error → exception (pg-boss will retry); a permanent one → compensation, `failed`. `handleSandboxOpDeadLetter(ctx, {operationId})` (decision 8). The steps and "already done" checks are exactly the tables of §7.3, §7.5, §7.6, §7.7, §7.8, §7.2; the `requestId` to the agent is `stepRequestId(operationId, step)`; `ClaimRequest {reason, sandboxId, hostname: "sbx-" + slug, env, secretEnv, secretFiles, authorizedKeys: []}`. A claim retry from the pool after an agent refusal — once (`progress.claimRetried`), with `failFast` — warm only. A fork target after `finish` — `cleanup_source`. Fork/save snapshot: a `snapshots` row `creating` before the S1 call, `lv_id` = id without dashes, `quiesce_broken` after thaw → `quiesce_failed`.

- [ ] **Step 1: tests** (Task 9 fakes, the handler is called directly) — create from the pool: `rotate_token` → `claim` → `finish`, sandbox `ready`, machine `running`, `provisioned_boot_id`; cold create; create from a saved snapshot; claim rejected by the agent → machine `deleting`, retry with another warm, a second refusal → `error create_failed`; stop: `prepare` best effort (agent unavailable — still `stopped`), `running` commands → `lost`; resume: secrets delivered by `updateEnv` + `updateSecrets`, `provisioned_boot_id` = the new boot; resume with `size` → `configure`; resume error → machine `stopped`, sandbox `error resume_failed`; recover: `stop`+`start`; reprovision; fork of a running one: the agent's `quiesceHook` called, target `ready`, snapshot removed by `cleanup_source`; fork of a stopped one → `powered_off`; `quiesce_broken` → fork `failed`, target `error fork_failed`; delete during a fork target waiting for the parent → the snapshot is removed by the parent; save_snapshot replaces one of the same name; **failure matrix**: for each operation and each step, `crashAfter` on the step's side effect, then a retry — the outcome equals that without a crash, no extra VMs/LVs/leases in the fake; **delete during** create (claim and cold), resume, fork — everything cleaned up; deadline expired → compensation; DLQ create → `failed retries_exhausted`, the machine is deleted; **secret leak**: the secret marker is absent from `operations`, `idempotency_keys`, `pgboss.job`, captured logs.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `worker: sandbox operations with compensation and crash matrix`.

### Task 11: `machine-events` and the pool, health, autostop, cleanup, idp-sync controllers

**Files:** Create `apps/worker/src/handlers/machine-events.ts`, `src/controllers/{pool.ts,health.ts,autostop.ts,cleanup.ts,idp-sync.ts,index.ts}`; Test `test/machine-events.test.ts`, `test/ctl-pool.test.ts`, `test/ctl-health.test.ts`, `test/ctl-autostop.test.ts`, `test/ctl-cleanup.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces: `handleMachineEvents(ctx, {machineId})` — the table of §10.2 (agent events by `seq`, synthetic by `time`, then `processed_at`); `phase pool_ready` → `ready_boot_id`, `agent_phase`, a pool machine `booting → warm`, `warm_at`. `runPool(ctx)` (§9.2 items 1–5, provision via a `machine-op` job), `runHealth(ctx)` (§11.1), `runAutostop(ctx)` (§12, a live `agent.activity` check), `runCleanup(ctx)` (§15.4, including re-encrypting secrets with the old key version), `runIdpSync(ctx, sync: IdpSync)`; `interface IdpSync { run(): Promise<void> }`. `CONTROLLERS` — `{queue, intervalMs, run}`; the self-requeue `startAfter` and a once-a-minute cron are in Task 13.

- [ ] **Step 1: tests** — events: duplicates and reordering do not change the outcome; `rebooted` → commands of the previous boot `lost`, reprovision is enqueued when `boot_id ≠ provisioned_boot_id` and with no active operation, not enqueued for an already provisioned `boot_id`; `connected` clears `degraded`; `quiesce.watchdog_thawed` → `quiesce_broken` on a snapshot in `creating`; pool: filling to target, surplus warm → `deleting`, a new active build → replacement of old ones (on a RAM shortage — delete the old one first), a warm machine with the agent disconnected > 60 s → `deleting`, without RAM — nothing; health: disconnected > 60 s → `degraded` (+ `health_reason` by QGA and VM status), after 2 min — one `qgaExec` restart no more often than every 10 min; autostop: idle does not fire with `runningCommands > 0`, `openPtys > 0`, `tcpStreams > 0`, a fresh `last_api_call_at`, stale `activity`, an unavailable agent, a non-zero live check; fires when all are zero; TTL always fires; cleanup: expired keys, events > 7 days, tombstones > 30 days, `fork_source` > 1 h, re-encryption v1 → v2.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `worker: agent events processing and pool, health, autostop, cleanup controllers`.

### Task 12: the `reconcile` controller

**Files:** Create `apps/worker/src/controllers/reconcile.ts`; Test `test/ctl-reconcile.test.ts`

**Interfaces:**
- Produces: `runReconcile(ctx, {dryRun: boolean}): Promise<ReconcileAction[]>` — the table of §11.2 and §11.3; `ReconcileAction {kind: "orphan_vm" | "orphan_lv" | "machine_lost" | "unexpected_stop" | "power_drift" | "lease_release" | "retire_again" | "requeue_op"; target; applied: boolean}`. Protections: only VMs with pool `sandbox` and tag `sbx`, VMID in the provider's range, not a template; LVs only with tag `sbx`; grace 10 min.

- [ ] **Step 1: tests** — an orphan VM (older than grace) is deleted, a younger one is not; a VM outside the pool and an LV without the tag are not touched; a `releasing` lease is picked up; machine `running` + VM `stopped` → the first time a system resume (`requested_by` null), the second time within an hour → sandbox `stopped unexpected_shutdown`; a machine without a VM → `failed`, sandbox `error machine_lost`; machine `stopped` + VM `running` → `shutdown`; a stuck operation without a job → the job again; `dryRun` changes nothing and returns the same actions.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `worker: reconcile controller with dry run`.

### Task 13: real adapters, the worker process, `sbx-admin`, end-to-end pg-boss tests

**Files:** Create `apps/worker/src/adapters/{pve-infra.ts,gateway-http.ts,agent-unavailable.ts}`, `src/main.ts`, `src/boss.ts`, `src/http.ts` (`/healthz`, `/readyz`, `/metrics`), `src/metrics.ts`, `src/log.ts`, `src/env.ts`, `src/admin/{main.ts,commands.ts}`; Test `test/pve-infra.test.ts`, `test/boss-e2e.test.ts`, `test/admin.test.ts`

**Interfaces:**
- Produces:
  - `PveInfraRegistry(pool, {secretsDir, env})` — builds `Machines` from `@sbx/pve` per node (`PveApi`, `SshNodeOps`, `LvmThinDriver`, `Allocator` with `PgAllocatorStore`, in-memory `SnapshotStore`) from `providers`/`nodes`; `NodeInfra` on top. Secret files: `secret_ref` → a directory with `pve-token`, `pve-root-ca.pem`, `sbx-node_ed25519`, `known_hosts` (like `~/.config/sbx/`).
  - `HttpGatewayPort(pool, serviceToken)` — `POST <internal_url>/v1/machines/{id}/rotate-token` (instance from `tunnel_sessions` ⨝ `gateway_instances`).
  - `startWorker(env): Promise<{stop(): Promise<void>}>` — migrations at startup (`SBX_MIGRATE_ON_START`, default `1`), `PgBoss` on a shared `pg.Pool` (20), `ensureQueues`, `work` with the `localConcurrency` of §15.2, controllers (`exclusive`, self-requeue `startAfter`, `schedule` once a minute), `SIGTERM` → `boss.stop({graceful: true, timeout: 60_000})`. Env: `DATABASE_URL`, `SBX_CONFIG_FILE`, `SBX_DATA_KEYS_FILE`, `SBX_SECRETS_DIR`, `SBX_GATEWAY_SERVICE_TOKEN_FILE`, `SBX_RECONCILE_DRY_RUN` (default `1`), `SBX_HTTP_PORT` (9090), `SBX_IDP_SYNC_INTERVAL`, `SBX_LOG_LEVEL`.
  - Metrics §20 (prom-client): `sbx_pool_machines{pair,state}`, `sbx_operation_duration_seconds{kind,outcome}`, `sbx_operation_errors_total{kind,code}`, `sbx_node_ram_mb{node,kind}`, `sbx_reconcile_actions_total{kind,applied}`, `sbx_degraded_sandboxes`, `sbx_queue_depth{queue}`, `sbx_event_lag_seconds`, `sbx_delete_stuck`, `sbx_unexpected_identity_change_total`, `sbx_quiesce_watchdog_thawed_total`.
  - `sbx-admin` (`node src/admin/main.ts`): `bootstrap` (topology and builds from YAML, idempotent), `providers add`, `nodes add|cordon|uncordon`, `template register|promote`, `pool status`, `reconcile --dry-run`, `op retry <id>`, `machine delete <id>`, `migrate`.

- [ ] **Step 1: tests** — `pve-infra` on top of `@sbx/pve/testing` (`FakePve`, `FakeNode`): create/start/status/snapshot/delete pass and the lease is in Postgres; `boss-e2e`: two `startWorker` instances (fake ports via a parameter) on one DB, 10 creates + deletes run to the end, double delivery (a manual `boss.send` of the same `operationId`) is harmless, an `exclusive` controller does not run in parallel; killing an instance in the middle of an operation (`stop` without graceful) — the second one finishes it after the heartbeat expires (heartbeat 10 s in the test); `sbx-admin bootstrap` twice — no duplicates; `/readyz` 503 before migrations.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `worker: process wiring, pve and gateway adapters, sbx-admin, pg-boss e2e`.

### Task 14: `deploy/compose`

**Files:** Create `deploy/compose/compose.yaml`, `deploy/compose/README.md`, `deploy/compose/config/sbx.yaml`, `deploy/compose/config/data-keys.example.json`, `apps/worker/Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces: services `postgres` (`postgres:18.6-alpine`, volume, healthcheck), `migrate` (worker image, `sbx-admin migrate && sbx-admin bootstrap`, `restart: "no"`), `worker` (`depends_on: migrate: service_completed_successfully`). Worker image: `node:26.13.0-*-slim`, `pnpm install --frozen-lockfile --prod --filter @sbx/worker...`, `CMD ["node", "apps/worker/src/main.ts"]`. pve config: `~/.config/sbx` is mounted read-only at `/run/secrets/sbx` (`SBX_SECRETS_DIR`). Data keys: `deploy/compose/secrets/data-keys.json` is created by the command from the README (`openssl rand -base64 32`), the `secrets/` directory is in `.gitignore`. The pool target in `sbx.yaml` is `0` by default (do not create VMs on `pve` without an explicit decision), `SBX_RECONCILE_DRY_RUN=1`. A shared network and `x-` anchors for the future `api`, `gateway`, `web`, `keycloak`, `oauth2-proxy`.

- [ ] **Step 1:** `docker compose -f deploy/compose/compose.yaml config` is valid.
- [ ] **Step 2:** `docker compose up -d --build`; `migrate` exits with code 0; `worker` `/readyz` → 200; `sbx-admin pool status` works in the container; `docker compose down -v`.
- [ ] **Step 3:** commit `deploy: docker compose stack with postgres and worker`.

### Task 15: S2 merge, final verification

- [ ] **Step 1:** when `s2-impl` is in `main`: `git merge main`; remove the tunnel fixture (decision 16); compare Drizzle `tunnel.*` with `0100_tunnel_init.sql` (drift test); `HttpGatewayPort` — through `PgRegistry` from `@sbx/agent-client`, if more convenient; contract discrepancies go in the report.
- [ ] **Step 2:** `pnpm -r test`, `pnpm lint`, `pnpm build`, `pnpm -r typecheck` — green; `docker compose up` for our part.
- [ ] **Step 3:** update the S6 status in `docs/roadmap.md` ("implementation on branch `s6-impl`"), commit, `git push -u origin s6-impl`.
- [ ] **Step 4 (after master's permission):** E2E on `pve` per §18 within the host rules — separately, once S3/S4/S5 and the permission appear.
