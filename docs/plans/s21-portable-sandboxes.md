# S21 implementation plan

**Goal:** Build templates once, cold-move stopped data, queue capacity waits.
**Spec:** `docs/specs/s21-portable-sandboxes.md`.
**Architecture:** Bounded node-agent transfer RPCs, replica metadata, fenced
worker journal, transactional per-team queue. Existing PVE/node-agent channels.
**Constraints:** No live host access; mise toolchain; no CI trigger changes;
English comments; no session trailers; phase commits rebased and pushed to main
only after their relevant gate passes. Implement inline without delegates.

## Phases

- [x] 1. Add restricted, bounded, checksummed block export and staged import to
  `services/node-agent/internal/ops`, with Go fakes and adversarial tests.
  Add a retryable base-relative sparse relay to `packages/pve/src/storage` with
  fake-node tests. Verify corruption, zero changes, offsets, live/foreign volumes.
- [x] 2. Add replica/journal migrations and DB types, build-once replication in
  `deploy/compose/quickstart/setup-build.mjs`, per-node progress, installer node
  activation copies templates. Preserve per-node previous build on failure.
- [ ] 3. Extend placement/admission and worker resume/fork/snapshot steps with
  durable cold-move fencing/config switch/cleanup. Test every crash boundary,
  unavailable source, same VMID/MAC, multi-disk and snapshot delete races.
- [ ] 4. Add durable FIFO capacity tickets, cancellation and wakeup/reconcile.
  Extend API schema, SDK, MCP, CLI duration options and dashboard progress.
  Test team FIFO, deadline persistence, cancellation, idempotency and quotas.
- [ ] 5. Run full local gate, review diff, rebase origin/main and fast-forward
  push `git push origin HEAD:main`; record final SHA and remaining live checks.

## Review focus

Never mutate a running or foreign disk. Never publish an unverified replica.
Never delete source on an ambiguous config switch. Never reserve RAM twice.
Never log guest blocks or queue plaintext secrets. No live-host verification.

## Required live acceptance (coordinator only)

1. Fresh setup: build linux once, copy to pve2; compare manifest and every disk
   SHA-256, verify separate cluster-unique template VMIDs and create/exec on both.
   Repeat linux-desktop and windows including EFI/TPM. UI shows build then copy.
2. Add/re-add a node: copy active templates without running a build. Interrupt a
   copy and restart control plane; resume safely and preserve old active build.
3. Create sandbox, write a file, stop it (`umiak stop <id>`); fill or cordon its
   home node, then `umiak start <id> --wait 100m`. Verify moving progress, same
   VMID/MAC/IP, file checksum and exec; only target config can run afterward.
4. Fork and create from a saved snapshot under home-node capacity pressure;
   verify content, source independence, all disks, delta-byte savings. Repeat
   without matching base to verify full sparse fallback and zeroed blocks.
5. Interrupt during copy, after verification, during config switch and cleanup;
   restart worker and retry. Verify single ownership and retained source until
   target verified, no leaked leases/staging volumes, idempotent cancellation.
6. Exhaust RAM everywhere; queue two starts in one team and one in another.
   Stop/delete/autostop another sandbox, verify FIFO per team and no overcommit.
   Cancel queued work and expire a short wait; verify out_of_capacity and no VM
   started later. Repeat for create via CLI/API/SDK/MCP and worker restart.
7. Unreachable source: never start stale target or delete source. Restore source
   and retry; verify restricted key cannot execute shell or read/write foreign LVs.

## Implementation ledger

Phase 1 implements `lv.transferPrepare`, `lv.transferRead`, `lv.transferWrite`
and `lv.transferDigest`, exported `relayVolume`, and local adversarial/fake tests.
Source exports accept tagged template bases and immutable snapshots only; a VM
must first be snapshotted under lifecycle fencing. Writes accept only staging
snapshot LVs with a transfer owner tag, correct pool and no open device consumer.
512 KiB block limit keeps base64 requests below the 1 MiB forced-command limit.
Block contents are redacted. Relay compares hashes before fetching data, includes
changed-to-zero blocks, checks readback before checkpoints, and compares full
node-local SHA-256 digests after replay. Full sparse copy skips matching zeros.

Ruling: template replica VMIDs must differ across nodes because PVE's VMID
namespace is cluster-wide. Replica content identity remains shared.
Ruling: no thin metadata parsing in phase 1; logical block comparison costs
whole-volume local reads but transfers only differing block payloads.

Not implemented by phase 1: replica registration/promotion and setup/installer
integration, durable DB journal and VM config switch, placement fallback, capacity
queue, public API/SDK/MCP/CLI and dashboard changes. S19 runtime remains local.
Do not run the end-to-end acceptance above as if those features were available.
The transport primitives alone never publish a VM or delete the source.

Operational risk: full disk digest may exceed the default SSH RPC timeout on slow
or very large volumes. Integration must configure a suitable call deadline and
retain source/staging on timeout. Full-volume scan cost needs live measurement.

Phase 1 local verification (2026-11-05): pnpm test PASS (worker: 7 skipped;
MCP: 1 skipped), pnpm typecheck PASS, pnpm build PASS (Next build logs the
configured build.invalid Postgres placeholder), pnpm lint PASS (one existing
informational String.raw diagnostic). After final relay cancellation tests,
@umiak/pve: 208 tests PASS and typecheck PASS. Node-agent tests/vet/golangci-lint
PASS; native race tests PASS; Linux amd64 cross-build PASS. Installer: 247
pytest tests PASS with mise Python 3.15.2; ruff PASS. No live hosts contacted.


Phase 2: added source build identity, original manifest and per-disk block-tree
checksums; journaled template copies with provider VMID leases; setup registration
builds once and copies to other active nodes, node registration copies existing
active templates. Setup records manifest before copy and polls durable replication
progress. Startup retries unfinished copies. Commit precedes staging cleanup;
previous active destination build survives any pre-commit failure. Retirement and
node removal include unfinished transfer blockers. Native thin_dump/thin_delta
metadata limits reads to allocated/changed extents; legacy metadata failures use
safe block comparison. Relay no longer invokes whole-disk digest RPC; legacy
lv.transferDigest refuses disks above 8 MiB. Checksums explicitly identify their
sha256-block-tree-v1 algorithm. Full-copy verification includes target allocations
to catch unexpected target data. Published template bases are verified again.
