# S21 acceptance: templates and local start queue

Use only authorized Umiak objects on pve/pve2 and CT 590. Do not deploy while a
template build runs. Never change host networking or unrelated guests.

1. Through Setup, rebuild Linux on all nodes. One node builds, then copies via
   volume.sendTo/pvesm. Record build/copy seconds. Both nodes must show Ready;
   source_build_id/version/manifest and per-disk sha256-pvesm-raw+size-v1 proofs
   must match (VMIDs must differ). The digest includes the eight-byte size header.
2. Create a small Linux sandbox on each node through the product, execute a
   marker command, then delete. Record boot/exec timing.
3. Fill one node's configured RAM cap with small sandboxes. Stop a sandbox there
   and refill the freed capacity. `umiak start <id> --wait 10m` must queue on its
   home even if another node has space. Dashboard shows Waiting for capacity.
   Stop/delete a blocker: the queued start boots on the same home node.
4. Repeat pressure, queue another start, then `umiak cancel-start <id>`. CLI and
   dashboard must show cancellation; freeing capacity must not start it. A short
   exhausted wait returns retryable out_of_capacity. Team FIFO remains unchanged.
5. Delete all test sandboxes; verify no queue tickets, active operations,
   unfinished template copies or build reservations remain; nodes stay active.

Resume/fork/create-from-snapshot stay on the node holding their disks. Cold moves,
delta measurements and sandbox config relocation are deferred and must not be
run as acceptance of the shipped product. Historical recovery measurements in
`s21-replication-recovery-acceptance.md` describe the pre-simplification prototype.

Inspection (run inside CT590 with /opt/umiak compose): query runtime.nodes,
runtime.template_builds, runtime.volume_transfers (kind=template), runtime.start_queue
and runtime.operations. Preserve historical transfer rows for audit.
