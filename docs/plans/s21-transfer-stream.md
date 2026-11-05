# S21 standard full copies and bounded delta sessions

FULL copies use Proxmox raw+size export/import, zstd level 1 and existing
cluster-root SSH trust. A restricted source node-agent op accepts only an owned
immutable volume and a typed staging destination on an online cluster member.
It derives the IP/known-hosts path from cluster membership. The remote command
is fixed: umiak-node's internal receive helper with encoded typed metadata.
The control plane receives progress and the verified receipt, never data or a
root shell. Umiak snapshot names are not parseable by pvesm; for them the source
emits exactly the same eight-byte size header and raw bytes as pvesm export.

The receiver validates its configured VMID range/storage and uses a uniquely
named PVE-compatible temporary import volume. A durable root-owned intent and
exclusive lock fence cleanup/retry. It renames/tag-owns the result as the normal
Umiak staging LV only after complete import and fsync. Both ends compute SHA-256
of the same raw+size stream. Publication proves the COW origin/config reference,
without another full disk read. The full-copy checksum algorithm is
sha256-pvesm-raw+size-v1; matching base identities still require equal algorithm
and checksum. A cached receipt is reusable only for the same immutable source
UUID and target LV UUID. Partial current disks restart with standard pvesm;
completed disks resume via receipts. Deltas retain byte checkpoints.

Experimental delta copies keep thin_delta changed/zero ranges. Use one long-lived binary
node-agent session per endpoint, up to 8 MiB frames, four in flight, bounded
memory, in-stream canonical 512-KiB hashes and target readback before durable
acknowledgements. Resume revalidates the prefix. No new listener or credential.

Verification: ownership/online-member/path/command guards, import collision and
UUID replay tests, frame bounds/corruption/truncation/resume tests, product cancel
and cleanup. Deploy only to pve/pve2/CT590. Measure full and cold-move transfer
bytes and elapsed time live; then fresh build/copy, checksum identity and
sandbox create/exec/delete on both nodes before fast-forward main.

## Wrap-up decision

Owner stopped further protocol work on 2026-11-05. Template full-copy streaming
is enabled and live-verified. Delta sessions are behind explicit opt-in on both
endpoints plus protocol negotiation; a live crash-resume test failed with
`Invalid delta frame bounds`. Portable full-snapshot streaming is separately
opt-in because its raw+size framing fallback has no live acceptance. Defaults
keep cold moves on the old relay. No production configuration enables either
experimental option. See [measured acceptance and remaining work](../s21-replication-recovery-acceptance.md).
The original fresh-build/Windows/TPM acceptance remains incomplete; wrap-up must
not present it as passed. Further transfer design is a separate task.
