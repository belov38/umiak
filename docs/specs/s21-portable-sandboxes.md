# S21: Build-once templates and capacity waits

Owner decision, 2026-11-05: template replication and the start queue are shipped.
Cross-node cold moves of stopped sandboxes, forks and saved snapshots are deferred.

## Template replication

Build linux, linux-desktop and windows once on an eligible node, then copy all
base disks (including EFI/TPM) to other eligible nodes. Replicas share immutable
build identity, version, manifest and per-disk checksums, with cluster-unique VMIDs.
The only transport is node-agent `volume.sendTo`: `pvesm export raw+size | zstd |
ssh <cluster node> … pvesm import`. It is enabled by default. Source and target
compute streaming SHA-256 (`sha256-pvesm-raw+size-v1`, including the size header).
UUID-bound durable import receipts allow reuse of completed disks; partial imports
restart. Ownership, read-only source, cluster membership, storage and staging guards
remain mandatory. Publication follows verified import; failure preserves the old
active build. Copy journals, cancellation and import cleanup remain.

Measured Linux template copy on 1 GbE: 44–76 seconds for approximately 7.4 GB
allocated / 64 GiB logical. See `../s21-replication-recovery-acceptance.md` for
historical evidence and `../operations-s21-acceptance.md` for current acceptance.

## Placement

Resume and automatic restart run on the node holding the machine's disks. Fork
and create-from-saved-snapshot run on the source snapshot's node. Insufficient
capacity waits there when requested; free RAM on another node cannot relocate data.
Ordinary template creates may still select any eligible node with a local replica.

There is no public `moving` state. Historical transfer journal rows remain readable.
Block relay RPCs, thin metadata parsing, block-tree checkpoints, binary delta
sessions and experimental sandbox FULL copies have been deleted.

## Deferred cold moves

Future design may use standard full copy via pvesm, rsync over a base snapshot,
or a ZFS storage driver with `zfs send -i`. No current product path moves sandbox
or saved-snapshot data between nodes.

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

Public `queued` derives from the active operation. Internal lifecycle states
remain creating/starting. Queue timeout returns retryable `out_of_capacity`;
resume remains stopped, while an unadmitted create has no VM. Cancelled work
never starts later. Existing FIFO, reservations, quotas and deadlines remain.
