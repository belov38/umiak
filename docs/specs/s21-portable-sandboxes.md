# S21: Portable templates, cold moves and capacity waits

Status: implemented. Partial live acceptance on pve/pve2 is recorded in
[the recovery report](../s21-replication-recovery-acceptance.md); remaining
scenarios are explicit there. Replaces the S19 local-only rule.

## Decisions

Build linux, linux-desktop and windows once on a selected eligible node. Replicate
all base disks, including EFI and TPM, to each other eligible node. A replica has
the same immutable build identity, version, manifest and SHA-256 per logical disk;
node, storage, LV names and template VMID are replica-specific. Template VMIDs
remain cluster-unique: the same template VMID cannot be registered twice in PVE.
Adding a node replicates active builds before enabling cold placement there.

Full template replicas use a restricted source node-agent `volume.sendTo` op:
Proxmox raw+size export/import, zstd level 1, and the cluster's existing root SSH
trust. The op validates the owned immutable source, configured storage/thin pool,
online cluster member and typed staging destination. The remote command is fixed;
the control plane receives progress/receipts and never a root shell or payload.
Both endpoints hash the raw+size stream in flight (`sha256-pvesm-raw+size-v1`);
publication checks the verified staging origin/config reference. A partial disk
restarts its standard import; completed immutable disks can reuse UUID-bound
receipts. No extra credential or network listener is introduced.

Default cold moves retain the existing pinned SSH forced-command block relay.
Compare logical blocks with an identical base, send changed blocks including
changed-to-zero blocks, and verify hashes at destination. Without an identical
base copy nonzero blocks to a fresh zero-filled thin LV. Use thin_dump allocated
extents or thin_delta changes when available; otherwise compare logical blocks.
Relay checksums remain `sha256-block-tree-v1`: domain, logical size, block size,
base checksum and ordered offset/length/block hashes. Equal bases require equal
checksum algorithm and value. Do not compare block-tree and raw+size hashes.

The bounded binary delta-session prototype requires explicit opt-in at both
endpoints and negotiated `delta-stream-v1`. It is disabled by default after a
live crash-resume failure. Standard full imports for portable cold-move snapshots
are also disabled by default: their snapshot framing fallback lacks live
verification. A separate transfer design task decides these paths; cold moves do
not depend on either experimental path.

## Storage protocol and safety

Only configured VG/thin pool, allowed names, correct ownership tags and powered
off Umiak VM disks or immutable snapshots/templates may be transferred. Readers
and writers reject live disks; imports must never write template base LVs or
ordinary sandbox volumes. Import writes go only to dedicated staging LVs owned
by a transfer ID. The destination is unpublished until every logical block is
verified. Payload bytes must never enter logs. Each block is checksummed and a
repeated write is safe; corruption, size changes and invalid offsets fail closed.

A durable transfer journal records source, destination, build identity, all disks,
verified byte offset, expected checksums and phases: preparing, copying,
verified, switching, committed, cleaning, done (or failed). Resume from the last
verified offset after a crash. Fence source lifecycle and destination admission
throughout. Never delete source before verified destination and durable ownership
switch. Cleanup retries independently. Cancellation before switching intent removes staging only. Once switching
intent is durable, complete the verified config/DB switch before applying a
superseding delete; after commit complete cleanup. Coordinate PVE VM-config relocation under
the cluster VM lock, preserve VMID/MAC/IP/firewall, and never allow two runnable
configs. Missing/unreachable source means wait/fail safely: cold move cannot
recover inaccessible local data. Cordoned but reachable sources can export.

## Placement and lifecycle

Prefer home node for resume/fork/saved-snapshot create if eligible with capacity;
otherwise reserve on another node in the same provider with appropriate storage.
Verify a byte-identical base, use a thin clone + delta; otherwise full sparse copy.
Fork preserves its source, while resume changes home ownership. Saved snapshots
have their own transfer ownership and deletion fencing. Live migration, copying
running disks, cross-provider moves and IP renumbering are excluded.

Expose operation phase `moving`, target node, verified bytes and total bytes in
API/dashboard: “Moving to pve2…”. Setup queue reports “Building on pve” followed
by “Copying to pve2” and progress; replica failure preserves the previous active
build on the destination and is retryable independently of build.

## Capacity queue

Use `capacityWaitSeconds` (integer 0..604800; default 0) on create, resume/start,
fork and snapshot-create in API, SDK and MCP. CLI `start --wait 100m` means
capacity wait; `create --wait` keeps ready-wait compatibility. Both commands also
accept `--capacity-wait 100m` and `--wait-ready` explicitly. Document the legacy
asymmetry in help. Timeout returns existing retryable `out_of_capacity`.

Persist queue tickets with operation/team IDs, arrival order and deadline. The
existing operation and encrypted sandbox secret storage retain the request and
idempotency identity; never persist raw secrets in a ticket. Queued work consumes
no node RAM, but enforce current quota again at admission. Team FIFO uses a team
lock: later tickets cannot bypass a blocked head. Different teams make progress
independently. A one-second controller observes RAM freed by stop/cleanup/autostop; an immediate
queue notification on enqueue and the pg-boss cron recover lost wakeups. Queued sandbox/operation status is visible, cancellation
and delete are idempotent. Restart never resets a deadline or creates a duplicate
sandbox. Admission reservation and ticket completion are one transaction.

## Verification and rollout

Unit/fake coverage: ownership/range guards, live-volume refusal, bounded payloads,
zero deltas, replay, corrupt block, every journal crash boundary, FIFO/timeout/
cancel, concurrent reservations and stale template replicas. Run mise pnpm
build/test/lint/typecheck, node-agent Go tests/vet/lint, installer pytest/ruff.
No access to live hosts during implementation. Live acceptance belongs to the
coordinator after fresh installation; the plan lists required scenarios.

## Client contract

```sh
umiak start <sandbox> --wait 100m
umiak resume <sandbox> --capacity-wait 100m --wait-ready
umiak create --template linux --capacity-wait 100m --wait-ready
umiak create --from <saved-snapshot> --capacity-wait 100m --wait-ready
umiak fork <sandbox> --capacity-wait 100m --wait-ready
umiak cancel-start <sandbox>
```

`create/resume/fork --wait` remains a boolean readiness wait; `start --wait`
requires a capacity duration and waits for ready too. `--wait-ready` and
`--capacity-wait` are explicit on all four commands. `--wait-timeout` overrides
the client timeout; by default capacity wait adds to the five-minute boot budget.
A client timeout/disconnect does not cancel the durable server request.

POST `/v1/sandboxes` and `/v1/sandboxes/{sandbox}/resume|fork` accept
`capacityWaitSeconds`. POST `/v1/sandboxes/{sandbox}/cancel-start` returns
`{sandbox, operation}` (202) and is repeatable for an already cancelled ticket.
After admission cancellation returns `invalid_state`; use stop/delete instead.
TypeScript uses `create/resume/fork({capacityWaitSeconds:6000}, {wait:true})`
and `sandbox.cancelStart()`. Python accepts `capacity_wait_seconds=6000`,
`wait=True`, and `sandbox.cancel_start()` in both sync/async facades. MCP uses
`capacity_wait_seconds` on `sandbox_create/resume/fork`, and
`sandbox_cancel_start`. MCP's `wait_seconds` bounds only the tool call.

Public states `queued` and `moving` derive from the active operation; internal
lifecycle states remain `creating/starting`. Queued work holds no RAM or VMID.
Quotas are checked at submission and admission; quota changes may hold the FIFO
head until expiry. Queue timeout fails the operation with retryable
`out_of_capacity`; a resume returns to stopped, an unadmitted create to error
(with no VM), so it can be inspected/deleted. Cancellation behaves similarly
with `cancelled` and never starts later. A fork's source snapshot may be prepared
while its child waits; cancellation safely cleans the temporary snapshot.

PVE config relocation follows the upstream
[`PVE::AbstractConfig` lock/config move helpers](https://raw.githubusercontent.com/proxmox/pve-guest-common/master/src/PVE/AbstractConfig.pm).
The bounded copy heartbeat uses an inactivity budget; completion restores the
normal OS-specific boot deadline.

Unknown metadata elements (including shared-map references unsupported by the
parser) invalidate the optimization and select safe comparison. Metadata
reservation ownership is kernel-serialized; a busy reservation is never released
by another transfer.
