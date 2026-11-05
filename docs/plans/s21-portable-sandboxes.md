# S21 simplification plan

Owner decision: retain build-once template replication via standard pvesm and the
FIFO start queue; defer sandbox/snapshot cold moves.

- [x] Remove per-block relay, thin_dump/thin_delta parsing, delta-stream and
  experimental portable FULL paths and capability flags.
- [x] Pin resume/fork/saved-snapshot admission to the source node. Retain queue,
  cancellation, deadlines, placement reservations and template selection.
- [x] Remove moving from public contracts and UI; regenerate SDKs. Preserve
  historical journal rows; migration refuses an unfinished ownership transfer
  and drops unused move reservations.
- [x] Complete local gates and deploy to CT 590 while no template build runs.
- [ ] Rebuild Linux once and copy to both nodes, compare checksums and timings.
- [x] Create/exec/delete on both nodes; fill a node cap, queue/release/cancel
  through CLI and dashboard; delete all test sandboxes.
- [ ] Record evidence, rebase origin/main and fast-forward push.

Future cold-move options: pvesm full copy, rsync over a base snapshot, or a ZFS
storage driver with zfs send -i. Current acceptance is in
`../operations-s21-acceptance.md`. Historical protocol experiments and failures
remain in `../s21-replication-recovery-acceptance.md`; they are not shipped paths.

Acceptance: `../s21-simplification-acceptance.md`. Current pvesm copy passed in
55.647 s with equal manifests/checksums, plus both-node CLI smoke and queue
release/cancel/timeout. Fresh Linux build failed after 69m23s on upstream Ubuntu
snapshot HTTP 500/502 and the 60-minute 00-base deadline; it was not published.
No fresh-build success is claimed. Main merge awaits disposition of that gate.
