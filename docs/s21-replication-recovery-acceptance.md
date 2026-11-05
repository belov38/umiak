> Historical report from before the owner’s simplification decision. The block
> relay, experimental delta stream and sandbox FULL path described below have
> since been deleted. Cold moves are deferred; only standard pvesm template copy
> and the local FIFO start queue remain. Current runbook: operations-s21-acceptance.md.

# S21 recovery and transfer acceptance — 2026-11-05

Owner requested wrap-up before further transfer-protocol work. This report
separates live results from tests and unfinished acceptance. Test stand: owner's
authorized disposable installation, CT 590, cluster nodes pve/pve2. Only Umiak
objects were touched. Job/VM ownership recovery used product APIs, not manual DB
edits. The documented advisory-locked cordon procedure was used for cold-move
pressure; both nodes were restored active.

## All changes and root causes

1. **Reservation release.** Successful source registration previously waited for
   replication and retained its build reservation after a target failure.
   Registration, source completion and copy phases are separate; mark the source
   succeeded/Ready before copying. Copy jobs reserve their target only. Restart
   interruption cannot overwrite an already completed reservation. Legacy recovery
   verifies the registered stopped owned template still exists before completing
   its source reservation, retaining its active template and lease.
2. **Replica cleanup.** PVE checks creation tags before pool membership. The
   upstream main fix creates the exact replica name first and sets tags after
   pool admission; it was verified live here. Recovery now proves ownership via
   exact name plus lease or durable copy journal, including an old orphan whose
   lease was already lost. It removes owned untagged empty configs and unpublished
   converted replicas, while refusing foreign disks/names, active published
   templates and live runners. Cleanup holds the copy lock and cancels its journal.
3. **Copy retry.** A failed copy previously started a full builder and exhausted
   its only template VMID. Retry selects a ready active source and queues COPY.
   An explicitly confirmed fresh all-node rebuild builds once, then copies.
4. **`lv.list` contract.** Node-agent returns `{lvs: [...]}`, not a bare array.
   Fixed replication, all four portable worker consumers and their fakes.
5. **Races/restart.** Recheck publication under the copy lock after waiting,
   preventing duplicate allocation by a second runner. Preserve source completion
   across restarts, reconcile copy progress against its own journal, resume the
   same copy ID/VMID, and report Ready after committed-copy recovery. A failed
   target no longer changes the successful source job to failed/interrupted.
6. **UI states.** Show `pve: Ready`, `pve2: Copy failed`, and explain that Linux is
   ready on the source. Refresh recovery cards while polling, bind their actions
   without reload, keep step 3 open on failure even after setup completion, and
   show retry activity despite an older historical builder error. Explain
   build-once/copy sequencing and expected time; wrap long technical lines.
7. **Cancel/recovery.** Owner-only `POST /quickstart/setup/build/cancel-copy`
   persists cancel intent, checked at transfer checkpoints. It stops the queue;
   explicit recovery then removes owned staging/VM objects. Recovery inspection
   can prove a standard import through a durable root-owned marker. Failed and
   cancelled journals remain as audit history and no longer reserve nodes.
8. **Standard FULL template transfer.** Restricted `volume.sendTo` uses Proxmox
   raw+size export/import, zstd -1 and existing cluster-root SSH trust. Validate
   ownership/immutability, storage alias bound to the exact VG/thin pool, online
   member/IP and narrow staging name. Use a fixed receive command and pinned
   cluster node known-hosts; the control plane never receives a root shell.
   Both ends hash in flight; destination fsync precedes its receipt. Target tags
   and rename follow successful import. COW origin/config-reference checks prove
   publication without a second full read. UUID-bound immutable receipts support
   completed-disk reuse; partial disks restart the standard import. Durable
   intent/locks and `volume.cleanupImport` handle partial imports and retire
   receipts. The new checksum is `sha256-pvesm-raw+size-v1`; metadata transitions
   require compatible verified old proof and reject unexpected disk/checksum
   changes. Ordinary cold-move snapshot names have a unit-tested raw+size framing
   fallback, but that path is separately disabled by default pending live testing.
9. **Experimental delta transfer (not enabled by default).** Prototype uses one
   held binary node-agent session per endpoint, bounded 8 MiB frames/four in
   flight, source-read/target-write overlap, sparse/zero frames, in-stream
   canonical block hashes, synced readback acknowledgements and prefix-validated
   checkpoints. Fixed EOF/half-close drain, backpressure and malformed-frame
   handling. Live crash-resume still failed (see below). Both endpoints must opt
   in and negotiate `delta-stream-v1`; default cold moves keep the existing block
   relay. Neither experimental delta nor portable FULL is enabled by production
   configuration. Further design/polishing is explicitly deferred.

Each fix has unit/fake coverage: registration/restart gaps, ownership refusals,
copy retry/cancel, inventory envelope, lock recheck, queue/UI recovery states,
standard command/storage guards and receipt replay, and stream bounds/corruption/
truncation/checkpoints. Passing fakes do not establish live crash-resume safety.

## Live recovery and final state

- Original source job `967bf044049c3614714a3f2e`, VM 20000: owner recovery API
  returned registered and completed its reservation without deleting template or
  active lease.
- Original failed copy `95c979b8b91d540c5e5a94d247ce462e`: inspection found
  orphan VM 20001 despite a missing lease. Confirmed product cleanup removed it
  and cancelled the journal. Retry copied rather than rebuilding. Live retry
  exposed the inventory envelope bug; that failed journal was also cleaned via
  the product path.
- Slow copy `2c0006ca63cda503d0399aa549bc7710` resumed the same journal/VMID
  after control-plane restart. Cancelled through the new product cancel API,
  then cleaned through recovery, including owned replica/staging.
- Standard FULL copy `091525839dcc739388fcc2cc61d7f206` completed, including
  untagged VM creation followed by tags, verification and publication.
- Setup queue is inactive and reports **Ready on pve and pve2**. Linux version
  `20261105.1`, template VMIDs 20000 and 20001. Both nodes active.
- Both registered scsi0 proofs: logical size 68,719,476,736 bytes, algorithm
  `sha256-pvesm-raw+size-v1`, equal SHA-256:
  `dad137e92cf17265a03858f59f67e93721545b01b5e7f61b13290aaa1b7613db`.
  This hashes the eight-byte size header plus raw bytes; it is not raw-only SHA.
- Source sandbox admission succeeded while its target copy was still running:
  `sb_01m6mye5m8e2f8ec555b9nfqzq`, exec passed, deleted.
- Final installation smoke create/exec/delete passed on both nodes:
  pve `sb_01m6ncyeeffhg9m9adfzy4ywcg` at 08:24:45 UTC;
  pve2 `sb_01m6ncyxzgedrb3hbp7btst80v` at 08:25:02 UTC.
- Final audit: zero running/interrupted build reservations, unfinished transfer
  journals, move reservations, start-queue rows, pending/running operations or
  undeleted sandboxes. Historical failures/cancellations remain for audit.

## Measured throughput

Decimal MB/s below. Useful allocated-byte estimates, transport measurements and
whole-operation timing have different denominators; they are labelled explicitly.

| Scenario | Before | After | Evidence and qualification |
| --- | ---: | ---: | --- |
| pve → pve2 Linux template FULL | about 0.74 MB/s | about 105 MB/s useful allocated bytes | Old target grew from 7.74% to 8.26% of 64 GiB between 06:12 and 06:20:05. Standard FULL journal ran 06:36:30.163–06:37:45.868 UTC: 75.705 s including create/publication. Source allocation 11.56% of 64 GiB ≈ 7.94 GB; dividing by total time gives 104.93 MB/s. This is compressed-copy useful throughput, not measured wire bandwidth. |
| pve → pve2 cold move, old relay | 0.390 MB/s | default still uses old relay | Journal `fb2ee438bd9d706b2ff1a63250f36a8e`: 57 successful 512 KiB writes = 29,884,416 bytes / 76.670 s whole journal. Payload is OS changes; an initial marker command failed permission and is not claimed as copied. |
| pve → pve2 experimental delta | old relay baseline above | 68.5 MB/s transport | Journal `512205d8dfe900068800c076a351c34c`: 1,123,549,184 bytes / 16.413 s transfer; 20.783 s whole journal. Different larger workload; not an apples-to-apples benchmark or a shipped default improvement. |
| pve2 → pve experimental delta | not measured | 83.8 MB/s transport | Journal `3f9a7a0cb9906accf245c2cf07995bd1`: 1,118,306,304 bytes / 13.350 s transfer; 17.868 s whole journal. |

The successful experimental moves preserved a root-created/fsynced 1 GiB random
marker with SHA-256
`99fcdf51980eba2e356cd1702f6e7c05ca1e76598a9d55137214bf50a6813207`.
Those measurements precede the latest source-read/target-write overlap change;
there is no successful live throughput result for that final prototype revision.

## Verification and explicit limits

Final checks all exited zero: repository `pnpm test`, `pnpm typecheck`,
`pnpm lint`; quickstart Node tests (241 passed); Go node-agent race tests, vet
and golangci-lint (0 issues). Repository suites include PVE 217, core 384, worker
444 passed/7 skipped and CLI 172 passed. Lint has one existing
informational `String.raw` suggestion in `apps/mcp/test/windows-run.ts`, no errors.
The worker suite retains seven existing skips. Portable fake integration tests
ran against disposable local PostgreSQL (11 portable tests passed).

**Not passed / not performed:**

- Experimental crash-resume journal `3d48f96ae4c2e76d997d71f7a94b254e`
  failed `Invalid delta frame bounds` after a worker crash/checkpoint and retries.
  Product timeout/compensation cancelled it while preserving the source. The
  test sandbox was subsequently deleted via API. Earlier EOF hang was fixed,
  but neither failure is presented as successful same-journal live resume.
- Delta prototype remains opt-in and negotiated. Cold moves do not depend on it.
  Standard full imports for portable snapshots also remain opt-in and unverified
  live; cold-move defaults therefore retain the old slow relay.
- No new full build-from-image/all-nodes flow after these fixes: live recovery
  copied the already ready Linux source. Confirmed fresh build-once queue
  semantics have unit coverage only.
- No Windows/EFI/TPM or Linux-desktop live acceptance, no new-node acceptance.
- Standard FULL partial-import crash/cancel and receipt replay have unit/fake
  coverage, not live acceptance. Cancellation was live-tested on the old relay.
- UI states/actions have automated coverage and live API state evidence; no
  final visual browser acceptance is claimed.

Further protocol choice belongs to the separate design task. The enabled FULL
Linux template path and both-node sandbox smoke passed; this report does not
claim all S21 acceptance scenarios are complete.
