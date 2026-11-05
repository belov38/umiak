# S21: Portable templates, cold moves and capacity waits

Status: phases 1–2 implemented; cold moves and capacity waits in progress. Supersedes S19 locality only when the S21
transfer and admission paths are enabled; existing paths remain local until then.

## Decisions

Build linux, linux-desktop and windows once on a selected eligible node. Replicate
all base disks, including EFI and TPM, to each other eligible node. A replica has
the same immutable build identity, version, manifest and SHA-256 per logical disk;
node, storage, LV names and template VMID are replica-specific. Template VMIDs
remain cluster-unique: the same template VMID cannot be registered twice in PVE.
Adding a node replicates active builds before enabling cold placement there.

Use existing pinned SSH forced-command node-agent RPCs for bounded block reads
and writes. No shell, arbitrary path, host-to-host SSH credentials or new listener.
Compare fixed-size logical blocks with the local base, transmit only changed
blocks (including changed-to-zero blocks), and verify hashes at destination.
Without an identical base copy nonzero blocks to a fresh zero-filled thin LV.
Use reserved live-pool metadata snapshots with thin_dump (allocated extents) or
thin_delta (source versus identical base, including unmapped/discarded ranges).
Fall back to logical block comparison when metadata tooling is unavailable.
Checksums use sha256-block-tree-v1: hash the domain, logical size, block size,
base checksum (empty for full copies), then ordered offset/length/block SHA-256
records; omit all-zero blocks for full copies. Verification uses bounded block
RPCs and progress checkpoints, never a whole-volume hashing RPC.

PVE export/import was considered: useful for full images, but not sufficient for
base-relative deltas and per-block retry. Direct host-to-host copying adds a
second trust/credential path. Bounded RPCs retain the existing security boundary
and bound memory independently of disk size, at the cost of RPC overhead.

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
switch. Cleanup retries independently. Cancellation before commit removes staging
only; after commit complete cleanup. Coordinate PVE VM-config relocation under
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

Persist queue tickets, arrival order per team, deadline, sanitized request and
idempotency identity; never persist raw secrets in a ticket. Queued work consumes
no node RAM, but enforce current quota again at admission. Team FIFO uses a team
lock: later tickets cannot bypass a blocked head. Different teams make progress
independently. Stop/cleanup/autostop wake the scheduler; periodic reconciliation
recovers lost wakeups. Queued sandbox/operation status is visible, cancellation
and delete are idempotent. Restart never resets a deadline or creates a duplicate
sandbox. Admission reservation and ticket completion are one transaction.

## Verification and rollout

Unit/fake coverage: ownership/range guards, live-volume refusal, bounded payloads,
zero deltas, replay, corrupt block, every journal crash boundary, FIFO/timeout/
cancel, concurrent reservations and stale template replicas. Run mise pnpm
build/test/lint/typecheck, node-agent Go tests/vet/lint, installer pytest/ruff.
No access to live hosts during implementation. Live acceptance belongs to the
coordinator after fresh installation; the plan lists required scenarios.
