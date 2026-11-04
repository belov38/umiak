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

- [x] Fetch/merge main only after coordinator reports S18 implementation merged; inspect actual interfaces before edits.
- [x] Add failing tests for node selection, node-local ISO, independent promotion, durable interruption, original bootstrap preserving added nodes.
- [x] Implement setup node selection/status and selected-node smoke via operator-only path, build reservation lifecycle and cleanup verification.
- [x] Add failing installer tests for idempotent add/re-add, partial preparation, pinned identity failure, occupied removal, last-node/control-plane-host handling, common SSH authorization preservation and SDN refusal on unrelated pending changes.
- [x] Implement Add/remove menu using S18 checklist, restricted-agent distribution and root-console transport; mark retired under DB lock before scoped host cleanup. Never revert global forwarding/dnsmasq on removal.
- [x] Run Node setup and Python installer suites plus regression tests, commit.

### Task 5: Full verification, live acceptance and integration

Files: spec evidence and roadmap S19 row; architecture locality note.

Integration order changed by Ilia via coordinator: S20 (`cp-consolidate`) merges
into main first. Its two-image compose/Dockerfile layout and unified init are
the baseline for final S19 integration and live validation.

- [x] Wait for the coordinator's S20 merge signal; read the landed S20 spec/plan and merge `origin/main` into `s19-multi-node`. Resolve compose/Dockerfile/installer `stack.py`/release workflow overlap against the actual landed contracts. Preserve the MCP desktop_url compaction cherry-picked by S20 and the separate zero-wait replay fix.
- [x] Verify production dependency closure, migration/bootstrap ordering, node-console commands, node-agent extraction/checksum and per-node secret handling under the consolidated images/unified init. Rebuild the local live overlay for S20; do not use the previously prepared three-service image overlay.

- [ ] Coordinate live window and exact test VMIDs with S18. Prepare pve2 through installer; build Linux on each node sequentially, create modest workloads on both and verify exec/tunnel/locality, removal refusal and successful empty-node retirement/re-add. Delete test sandboxes/artifacts; record exact results.
- [x] Run `mise exec -- pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`; Node setup tests and Python installer tests. Run mise Go build/vet/test(-race)/golangci-lint for all go.work modules, Linux/Windows checks from CI where supported. Report unavailable checks; do not claim them passed.
- [x] Fresh independent acceptance subagent gets the final post-S20 spec/diff, not conclusions; fix blockers and recheck affected tests.
- [ ] Update roadmap and evidence; merge branch into main without squash, push, report SHA/live results/open items to coordinator.

## Implementation notes (2026-11-04)

- Catalog availability is optional in OpenAPI/SDK models to support existing server responses during upgrades; S19 always emits it.
- Node registration is a trusted core primitive, not a public HTTP mutation. It rejects local storage changes (disk migration is out of scope), RAM caps below existing reservations, and changes while a build reservation is open.
- Initial full workspace test caught the new Drizzle table missing from the aggregate schema export; fixed and DB schema-drift checks pass (74 tests).
- Full workspace pnpm test passed: core was 374 at that run; the final affected core suite subsequently passed 377 tests after inventory and promotion-fence additions. API 1073, worker 427 (+7 skipped), template-builder 600, MCP 715 (+1 skipped), CLI 190; both SDK suites passed (TS142/Python83). Full typecheck and lint passed; lint retains one pre-existing informational String.raw diagnostic in MCP test code.
- Full pnpm build passed again after the final inventory addition.
- All five Go modules: build/vet/lint passed. Race tests passed for proto/tunnel/node-agent/gateway. Initial full guest-agent race run failed timing checks TestRecoverNeverAttachedPTY (307ms vs300ms) and TestQuiesceBudget (50ms); isolated packages passed. Full guest-agent race repeat retained QuiesceBudget failure; full `go test -race -p 1 ./...` then passed. No Go code changed.
- Windows builds for proto/tunnel/guest-agent and Windows vet for proto/tunnel passed; Linux guest-agent integration-tag golangci-lint passed. Linux runtime systemd integration was not run on this macOS host.
- S18 implementation merged into this branch from main 0a7b43a6. Setup and installer integration is implemented, including per-node Templates/Smoke, additive bootstrap, root-console node enrollment and guarded retirement.
- First independent acceptance reviewed 0a7b43a6..40e1ee21 and found blockers: SQLite/PG lease collision, reconcile deleting builder artifacts, cleanup of a live runner, re-add host mutation preceding DB validation, missing private Smoke Origin and missing post-SDN verification. Fixes add shared job-scoped PostgreSQL leases (0602), runner/cleanup fencing, reconcile cleanup barrier, durable cordoned preparation and local SDN checks. Regression tests reproduced the allocator, reconcile and Origin failures before changes.
- Build admission takes an exclusive node-build-cleanup barrier under the existing node lock. Destructive reconcile takes its shared side without a node lock while waiting for the existing worker power lock; no transaction lasts across a template build.
- Coordinator/Ilia approved the checklist persistence fix: live forwarding alone is insufficient; require the Umiak persistent sysctl file as well. Added regression coverage.
- No PVE host or guest mutations have been performed. S18 live acceptance currently owns pve; wait for coordinator window before pve2 preparation or control-plane overlay. Live acceptance, final fresh independent review and merge remain outstanding.

- Post-review local gate passed: workspace build/lint/typecheck/tests (DB75, core377, API1079, worker435+7skip, builder602, MCP715+1skip, CLI189, web289, TS SDK141/Python SDK81), quickstart184, installer180 and targeted Python lint. Full Go build/vet/race tests (`-p 1`)/lint passed in all five modules; Windows build/vet and Linux integration-tag lint passed. Linux systemd runtime integration still requires a Linux environment/live window.

- Second fresh acceptance of af1cb0c4 found two artifact identity blockers: a retired VMID matched old DB history, and the shared manifest reader could return an older ready artifact with the same VMID. Reproduced both locally before fixing: internal build registration now matches its version; new manifests carry the durable node job ID and the reader requires exactly one verified match for that job/node/slot. Manual adoption of retired history remains rejected.
- Setup now lists active local template versions and missing Linux templates plus unfinished reservation IDs per node, using runtime inventory.
- Coordinator's S18 0.1.2 SDN contract: comma-separated node membership is initially scoped to the installer host. S19 appends to the existing list, removes only the requested member and retains a nonempty passive final list. Fresh tests cover these transitions.

- Merged S18 live fixes through main 2bf33549. Preserved its firewall prepend/moveto model, explicit CT DNS/ARP probe, source-commit fallback, gateway secret permissions and LAN-only TLS binding. S19 Update skips zone enrollment when the original CP host's sandbox role is retired; regression test covers this integration.
- A repeat full gate exposed a pre-existing MCP zero-wait race: the timer could abort between response headers and the started frame, losing replay metadata. A deterministic SDK event-order test reproduced it; the existing started-frame grace now applies to that order too. No budget or grace constant was raised.

- Third fresh acceptance of e3f835d3 identified active-task query loss in the pinned PVE adapter and retirement recovery after a successful PVE delete followed by failed polling. Regression tests reproduced both. The transport now sends source=active; 0603 persists retirement intent/delete task/request time, retries recover a dead console's running or interrupted job, and generic build cleanup refuses retirement intents. Finalization proves VM/LV/task absence and lease ownership. Lost DELETE responses require a matching operator-identified task rather than guessed completion.
- Retirement claims an absent template lease before deleting, so another node cannot reuse the VMID between PVE deletion and finalization. Worker template refresh rechecks the active build under the same node lock before creating leases; a stale refresh cannot recreate a retired template lease. Both paths have real-PostgreSQL regression coverage.

- Final local gate at runtime revision dc5711e2: pnpm build/lint/typecheck/test passed (core377, DB75, API1079, worker440+7skip, builder605, MCP716+1skip, CLI189, web289, TS SDK141/Python SDK81), quickstart186, installer207 and targeted Python lint passed. Go code is unchanged from the fully passing post-S18 gate (all five modules build/vet/race tests/lint, Windows builds/vet and Linux integration-tag lint); native Linux systemd/Windows runtime integration is not claimed.
- Fresh independent acceptance of dc5711e2154a40532c08ceba8c36b31844de4e9b found no established blockers after 726 targeted local tests. It independently checked cross-component placement/admission/locality, SSH, build/lease/reconcile fencing, promotion, interrupted cleanup, durable retirement and installer/bootstrap lifecycles. No host changes were performed by this stage or its reviewers.
- Pending: coordinator handoff after Ilia's fresh install. Planned live uses the retained pve Linux template/control-plane CT and a fresh local pve2 build; at most two 2 GiB test VMs simultaneously (CP default 4 GiB, <=8 GiB combined). Delete the second sandbox before the fork/locality test. Verify template absence blocks placement before build; verify occupied removal refusal, successful retirement/re-add, source-node locality and tunnel exec. Clean only recorded test artifacts, then merge/push main and report exact SHA/results. No main merge has occurred yet.

- Coordinator update: S20 merges before S19 and cherry-picks MCP desktop_url compaction. S19 remains unmerged until the coordinator signals that main is ready; repeat the full gate against the integrated tree. The clean dc5711e2 review/gate above remains historical evidence, not acceptance of the future S20 integration. Live authorization still starts only after Ilia's fresh install and coordinator handoff; no host changes are authorized by this merge-order update.

## Post-S20 integration evidence

- Integrated main 40cbd82f via merge e777dae1. Kept the shared CP image's production dependency closure and explicit source COPY allowlists, two-image release matrix, unified offline init, stable node-agent extraction path, reduced STACK_FILES and TLS_BIND ENV_KEYS. S20's cherry-picked desktop_url compaction merged without changes to the budget; S19's separate zero-wait replay fix remains.
- Preserved S18 dnsmasq repair/verification on Update only for an active original sandbox host. Remote helper starts with public umask 022, matching the main installer, while private directories/secret files keep explicit modes. A subprocess test inherited umask077 and failed with mode0600 before the fix; it now produces0644.
- Added-node preparation repairs only Umiak's legacy generated dnsmasq files before SDN apply, deferring service restart to PVE until the bridge exists. A real-filesystem installer test reproduced retained private directory/file modes before the fix; full installer216/216 and targeted Python lint passed. The helper's restart option defaults to the original S18 Update behavior.
- Fresh pnpm build/lint/typecheck/tests passed: core377, DB75, API1079, worker440+7skip, template-builder606, MCP716+1skip, CLI189, web289, TS SDK141/Python SDK81. Lint retains only the pre-existing informational String.raw finding. Node compose/quickstart190/190, installer shell checks and buf lint passed.
- Go build/vet/race tests(-p1)/golangci-lint passed in all five modules. Windows amd64 build/vet and arm64 build passed for proto/tunnel/guest-agent; Linux integration-tag lint passed. Native Windows tests and privileged Linux systemd runtime tests were not repeated on this macOS host; no runtime result is claimed for those.
- Built linux/amd64 shared CP image `umiak-s19-cp:integration`; real offline bootstrap/permissions/idempotency and production-image acceptance2/2 passed. Loaded node console, durable retirement, builder context and worker infra from the built image and verified migrations0600–0603. Bundled agent help includes first-install --trust-keys. Only installer Python changed after this image build, outside the CP image source allowlist.
- Replaced the obsolete three-image local overlay with one shared CP overlay applied to all CP roles; web remains the second stock image. Built it atop the local stock S20 image and verified module closure and rendered compose. It adds the existing DB workspace link for template-builder without installing pnpm/dev tools. The package remains local/doNotDeploy until the coordinator's live handoff; use the actual installed release as BASE then, never a guessed tag.
- Fresh independent post-S20 acceptance received only S18/S19/S20 specs and the diff from main40cbd82f through fd782b92 (no implementation conclusions). It reproduced two P2 findings: orphan `umiak-tpl` LVs did not block local removal, and a retired original host still needed its media/storage during Update/bootstrap. No P0/P1 findings were established.
- One regression-driven fix pass covers both findings. Local removal checks both ownership tags; interrupted-build cleanup additionally proves local VM/base disks absent before releasing job leases (real-PostgreSQL RED/GREEN coverage, including a similarly prefixed foreign VMID). Update preserves historical media facts on a retired original host; trusted bootstrap skips only that host's sandbox storage/RAM checks, while ordinary setup and cluster inventory validation remain. Installer218/218, compose/quickstart191/191, console8/8 and targeted Python lint passed.
- Rebuilt the final shared CP image after these JavaScript changes: real offline init/permissions/idempotency and production-image tests2/2 passed. No live PVE/guest changes and no S19 merge into main; live window remains after Ilia's installation.
- After the fix pass, repeated full pnpm build/lint/typecheck/tests successfully (same suite totals above), plus production imports from the rebuilt CP image. Go sources are unchanged from the fully passing post-S20 Go gate. Updated roadmap status to distinguish completed independent review from pending live acceptance.

## S18 0.2.1 integration

- Merged coordinator-requested main a435a204 as db11240d. The only conflict appended independent test groups in installer `test_day2.py`; retained both retired-host media coverage and upstream image-pruning/orphan-container coverage. Update still preserves the retired original node's role and facts before pruning images; other nodes still receive node-agent updates. Bootstrap keeps its additive registration/retirement behavior with the upstream canonical JSON comparison.
- Preserved upstream no-TURN desktop configuration (`iceServers: []`), guest-agent empty-list persistence, ingress WebSocket header handling, gateway security headers, 48 GB default CT rootfs, healthy-Update-only image pruning and compose `--remove-orphans`. No changes to these upstream behaviors were necessary.
- Rebuilt the full linux/amd64 CP image including changed guest-agent/gateway binaries; offline init/production-content tests2/2 and production node-console/builder/worker imports passed. Installer220/220, compose/quickstart192/192, shell checks, targeted Python lint and buf lint (from `proto/`) passed.
- Live ruling: old overlay is invalid after changed Go binaries. Any replacement overlay must use the actual installed release containing a435a204 (0.2.1 or later), or a full image built from this tree. `infra/homelab-dev/stand-build.sh` is available for an explicitly coordinated stand build; it has not been run. Desktop tests must use a template rebuilt with the updated guest agent. No SSH/PVE/guest actions; live still waits for the coordinator after Ilia's fresh installation.
- Full post-merge pnpm build/lint/typecheck/tests passed (worker441+7skip; other suite totals unchanged from the preceding gate). All five Go modules passed build/vet/race tests(-p1)/golangci-lint; Windows amd64 build/vet and arm64 build, plus Linux integration-tag lint passed. Native Windows/privileged Linux runtime results are not claimed. Lint retains only the existing informational String.raw diagnostic. No new S19 implementation or review-fix pass was introduced by this upstream merge.
