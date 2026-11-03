# S19 Multi-node Implementation Plan

**Goal:** Schedule sandboxes across registered PVE nodes with independent local template builds and safe node removal.

**Architecture:** Retain S6 placement and per-node infra registry. Add durable node build reservations and retirement metadata, serialize placement/build/removal with the existing node advisory lock, then connect operator inventory and S18 installer/bootstrap to those primitives.

**Tech stack:** TypeScript, PostgreSQL 18 migrations, Vitest, Node setup modules; S18 Python stdlib installer. No new dependencies.

**Spec:** `docs/specs/s19-multi-node.md` (approved by Ilia via coordinator 2026-11-04).

## Global constraints

- Automatic placement by free RAM, no public node selector or cross-node disk transfer.
- Node-local LVM-thin templates; one active build per logical template/node.
- Cluster PVE token and forced-command SSH key; per-node SSH endpoint and pinned host key.
- No edits to deploy/compose/quickstart or installer until S18 implementation merges main.
- Idle-node build reservation persists through interruption; no scheduler starts on reserved nodes.
- Preserve topology history; refuse occupied-node removal with blocker IDs.
- Live ms02 permitted including pve2 preparation; total live test RAM <=8 GiB. Coordinate with S18 before host mutations; never touch protected guests, vmbr0 or unrelated firewall rules.
- All tools through mise, English code comments, Russian human communication, no session trailers, dispatch-only CI.

## Review focus

1. A candidate becomes cordoned or its build is replaced while waiting for admission: reject under node lock and try the next candidate.
2. An interrupted build still has local VMs: retain reservation through process/control-plane restart.
3. Retired nodes retain historical FK rows: exclude them from reconcile/client creation without deleting history.
4. Original S18 bootstrap runs after adding pve2: preserve pve2 and its build registrations.
5. Removing one node must not revoke the cluster SSH key or remove common SDN objects.

### Task 1: Durable node maintenance and admission fencing

Files: create `db/migrations/0600_multi_node.sql`, `packages/core/src/node-maintenance.ts`, `packages/core/test/node-maintenance.test.ts`; modify `packages/db/src/schema/runtime.ts`, `packages/core/src/{capacity,placement,index}.ts`, `packages/core/src/service/{create-placement,fork}.ts`, pool admission caller in worker.

Interfaces: `beginNodeBuild(tx,{nodeId,jobId,templateSlug})`; `finishNodeBuild(tx,{nodeId,jobId,status})` called only after verified host cleanup; `interruptNodeBuild(tx,nodeId,jobId)` keeps reservation; `nodeRemovalBlockers(tx,nodeId)`; `retireNode(tx,nodeId)` returns blockers or retired result. `admit` accepts optional `{storageId,templateBuildId}` placement validation in addition to existing RAM arguments. `nodes.retired_at`; `node_build_jobs` keeps history, unique open job per node.

- [x] Write real-Postgres tests for each removal blocker, retirement/re-add history, idle build reservation, interrupted build fencing, and admission of a stale candidate.
- [x] Run `mise exec -- pnpm --filter @umiak/core test`; confirm new assertions fail before implementation.
- [x] Implement migration and primitives under `lockNode`; reject retired/build-reserved nodes in admission and powered-start gates. New-disk callers validate active node/provider/storage/build under admission lock. Resume on ordinary cordoned nodes retains existing behavior.
- [x] Test two-node fallback and build reservation race in real transactions; run core and worker suites and typecheck.
- [x] Commit isolated core change.

### Task 2: Per-node worker clients and builder RAM

Files: `apps/worker/src/adapters/pve-infra.ts`, its tests, `apps/worker/src/controllers/reconcile.ts`; `apps/template-builder/src/context.ts` and tests.

Interfaces: worker DB `node_agent_ref` is authoritative; registry cache detects topology changes and retirement. Builder RamGuard accounts only its selected node.

- [x] Add failing tests with two pinned SSH hosts and a misleading global SSH env, cache invalidation after endpoint change, retired nodes, and unrelated-node running VMs.
- [x] Run worker/template-builder tests to observe failures.
- [x] Implement per-node routing/cache refresh, retirement exclusion in reconciliation, node-local builder accounting.
- [x] Run both suites and typecheck, commit.

### Task 3: Catalog availability and operator inventory

Files: `apps/api/src/routes/catalog.ts`, `apps/api/src/schemas/catalog.ts`, `apps/api/test/catalog-limits.test.ts`; OpenAPI/SDK generated outputs; operator node inventory `packages/core/src/node-inventory.ts` with per-node media storage (`0601_node_media_storage.sql`).

Interfaces: additive template `availability` array with node ID/name, version, VMID, eligible flag; preserve newest active summary fields. Node inventory contains no secrets and is restricted to operator context; member/API-key catalog exposes only scheduling availability, never SSH endpoints.

- [x] Add failing tests for two nodes/different versions, unbuilt node, cordoned/retired nodes and disabled-template operator boundary.
- [x] Run API tests; implement availability from node/build topology and regenerate OpenAPI/SDKs using existing scripts.
- [x] Run API/core/SDK tests and typecheck, commit.

### Task 4: Integrate S18 setup/build and installer (after S18 code merge)

Files: `deploy/compose/quickstart/{setup,setup-build,setup-ui,bootstrap}.mjs` and tests; S18 installer package/checklist/state/menu and tests; compose worker env removal if not already done by S18.

Interfaces: build/register requests carry node ID; trusted DB resolves target storage/SSH/RAM/media. Reserve node before any build host action; on interruption retain reservation until cleanup verified. Registration promotes only selected node and requires matching job/node/VMID verified manifest. Installer uses runtime node inventory as authoritative and preserves cluster secrets/SDN.

- [ ] Fetch/merge main only after coordinator reports S18 implementation merged; inspect actual interfaces before edits.
- [ ] Add failing tests for node selection, node-local ISO, independent promotion, durable interruption, original bootstrap preserving added nodes.
- [ ] Implement setup node selection/status and selected-node smoke via operator-only path, build reservation lifecycle and cleanup verification.
- [ ] Add failing installer tests for idempotent add/re-add, partial preparation, pinned identity failure, occupied removal, last-node/control-plane-host handling, common SSH authorization preservation and SDN refusal on unrelated pending changes.
- [ ] Implement Add/remove menu using S18 checklist, restricted-agent distribution and root-console transport; mark retired under DB lock before scoped host cleanup. Never revert global forwarding/dnsmasq on removal.
- [ ] Run Node setup and Python installer suites plus regression tests, commit.

### Task 5: Full verification, live acceptance and integration

Files: spec evidence and roadmap S19 row; architecture locality note.

- [ ] Coordinate live window and exact test VMIDs with S18. Prepare pve2 through installer; build Linux on each node sequentially, create modest workloads on both and verify exec/tunnel/locality, removal refusal and successful empty-node retirement/re-add. Delete test sandboxes/artifacts; record exact results.
- [ ] Run `mise exec -- pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`; Node setup tests and Python installer tests. Run mise Go build/vet/test(-race)/golangci-lint for all go.work modules, Linux/Windows checks from CI where supported. Report unavailable checks; do not claim them passed.
- [ ] Fresh independent acceptance subagent gets spec and diff, not conclusions; fix blockers and recheck affected tests.
- [ ] Update roadmap and evidence; merge branch into main without squash, push, report SHA/live results/open items to coordinator.

## Implementation notes (2026-11-04)

- Catalog availability is optional in OpenAPI/SDK models to support existing server responses during upgrades; S19 always emits it.
- Node registration is a trusted core primitive, not a public HTTP mutation. It rejects local storage changes (disk migration is out of scope), RAM caps below existing reservations, and changes while a build reservation is open.
- Initial full workspace test caught the new Drizzle table missing from the aggregate schema export; fixed and DB schema-drift checks pass. Full workspace build/typecheck pass; remaining full test run is in progress. Installer integration/live/Go gate/final acceptance remain outstanding until S18 implementation merges.
