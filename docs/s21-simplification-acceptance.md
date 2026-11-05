# S21 simplification acceptance — 2026-11-05

Owner-authorized stand: pve/pve2, Umiak CT 590. Baseline main 91ab673c.

## Scope

Removed worker portable.ts and its cold-move tests; per-block relay transfer.ts
and tests; Go/TS delta-stream and tests; transferRead/Write/Map/Digest/Prepare,
thin metadata parsing and VM transferSwitch/Unlock ops and tests; capability
opt-ins and sandbox FULL framing. Template import/publication only accept template
slots. Public moving states are gone from OpenAPI, dashboard, CLI and generated
TS/Python clients. Historical journal rows remain readable.

Migration 0703_defer_cold_moves refuses outstanding cold ownership transfers and
drops move_reservations. Template volume_transfers, source ownership guards,
staging/publication/removal, import receipts, placement RAM admission and the
per-team FIFO start queue remain. Resume/fork/snapshot-create stay on their source
node. Source locks retain queue and snapshot deletion concurrency protection.

## Local gates

Full pnpm test passed: config 27, PVE 201, DB 77, auth 139, agent-client 143,
core 385, payload 176, builder 606, API 1034, worker 433 (7 existing skips),
TS SDK 144, Python SDK 83, web 276, MCP 699 (1 existing skip), CLI 172, bench 44.
Typecheck, lint and build passed. Quickstart node --test: 241 passed.
Installer pytest: 276 passed; ruff passed. Node-agent race tests, vet,
golangci-lint (0 issues), and Linux amd64 cross-build passed. No CI triggers changed.
Regression proves a stopped sandbox stays queued on its full home despite a free
replica node. Removed RPCs reject before host commands; ownership/pool/open-volume
and read-only-template guards have coverage.

## Live capacity queue

The stand was initially empty, both nodes active with 8192 MiB caps. During queue
acceptance only, pve2's admission cap was lowered under the node advisory lock to
4096 MiB, then restored to 8192 MiB. This avoids the team's separate 8192 MiB
quota masking node capacity; all guests were 2048 MiB and stayed within caps.

- pve2 sandbox atlas-gecko-oak created 09:12:12.602Z, ready 09:12:26.783Z:
  14.181 s; exec printed s21-pve2-ok.
- Blockers orbit-pecan-echo and wren-cumin-sparrow became ready in 15.744 s and
  14.503 s. Stopped target and refilled pve2 with two blockers (4096/4096 MiB).
- `start atlas-gecko-oak --wait 10m`: queued 09:13:49.660Z. Dashboard list and
  detail displayed Waiting for capacity. Blocker stopped 09:14:08.049Z; resume
  succeeded 09:14:21.775Z (13.726 s after RAM release), still on pve2.
- `start orbit-pecan-echo --wait 10m`: queued, cancelled by CLI at
  09:15:03.331Z. A separate --wait 5s expired at 09:15:09.761Z with retryable
  out_of_capacity. A third queue was cancelled with the dashboard button; CLI
  reported Queued start cancelled and dashboard returned to stopped.
- Freed capacity again: cancelled sandbox stayed stopped. All three test
  sandboxes were deleted through the CLI. Queue tickets: zero.

## Fresh build and final smoke

Fresh Linux build-once/all-node queue b5382e4ab9580e04aa5f5a64 was submitted through
the product with confirmRebuild=linux. Source builder 381dbc8954b9742e007d2645,
VM 20002, started 09:03:10.696Z. Initial cloud-init and snapshot.ubuntu.com
requests required retries. It failed at 10:12:33.913Z, after 4163.217 s total,
when the 00-base step hit its 3600 s limit. Its apt download logged upstream
HTTP 500/502 from snapshot.ubuntu.com (libx265-215); a separate guest curl probe
received no response within 10 s. The builder removed VM 20002 and released its
reservation. Recovery inspection reported no unfinished build. No fresh template
was published: fresh build-once acceptance did NOT pass.

After deploying final runtime revision 3a804076 to CT590 and both node-agents,
retired only pve2's Linux replica through the installer console product operation,
then requested Linux on all nodes through Setup without confirmRebuild. The product
reused the ready pve source and performed COPY, not a new image build.

Copy 8f3119f7e3a1e24cd90b77b9f26af69b ran 10:16:50.552–10:17:46.200Z:
55.647256 s whole journal; 52.451480602 s stream; 2,396,161,133 compressed wire
bytes; 68,719,476,736 logical bytes. Both nodes returned Ready. Active replicas
are version 20261105.1, VMIDs 20000/20001, with equal manifests and scsi0 proof:
sha256-pvesm-raw+size-v1,
`dad137e92cf17265a03858f59f67e93721545b01b5e7f61b13290aaa1b7613db`.
This verifies current template transport/republication, not a successful fresh build.

Retirement exposed a stale blocker query: historical cancelled cold transfers
prevented deleting a template. The query now considers only unfinished template
transfers; historical cold and cancelled rows remain readable. Quickstart 241
and lint passed after that fix.


Final CLI smoke on the deployed runtime:
- pve, laurel-granite-arch / VM 10000: create-to-ready 13.924 s, exec 0.521 s.
- pve2, valley-reed-zephyr / VM 10001: create-to-ready 16.602 s, exec 0.320 s.
Both execs printed s21-final-exec-ok; both sandboxes were deleted via CLI.

Final audit: zero undeleted sandboxes, active operations, queue tickets,
unfinished transfers and running/interrupted build jobs. Both nodes active with
8192 MiB caps. Failed build and historical transfers remain as audit records.
Temporary test API key was revoked. Existing templates are Ready on both nodes.

## Owner-approved exception and repeat steps

The owner explicitly authorized merging with the fresh-build exception on
2026-11-05. The owner independently verified worldwide Ubuntu snapshot
degradation from six external probes (13–22 s for small files and HTTP 502).
Those probes were supplied by the owner, not performed by this implementation.
Fresh Linux build-from-image acceptance remains NOT PASSED; current pvesm copy,
manifest/checksum identity, both-node smoke and capacity queue passed.

Immediately before merge, independently rechecked: failed job terminal `failed`,
zero running/interrupted build reservations, zero leases for failed job
381dbc8954b9742e007d2645, VM 20002 absent from both node config directories,
and no source LVs matching 20002 or its build identity. Both existing template
VMs are stopped with template=1, and their DB builds are active/Ready. No test
sandboxes, queue tickets or active sandbox operations remain. Product recovery
inspection had already reported no unfinished build, so no additional Clean up
was required; the builder's normal failure cleanup had removed its VM/disks.

Repeat the waived check after Ubuntu snapshot recovers:

1. Sign in to the owner's browser at the stand, open `/setup`, and verify no
   active template build or copy. Do not deploy while it runs.
2. In that authenticated browser console, request a *fresh*, all-node Linux
   rebuild (omitting confirmRebuild would only reuse the current Ready source):

```js
await fetch('/quickstart/setup/build', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    slug: 'linux',
    nodes: [
      '01a1a98f-e973-7062-b078-617c52acb9d2', // pve
      '01a1a997-4a71-7687-9dd4-74ac19a38efe', // pve2
    ],
    confirmRebuild: 'linux',
  }),
}).then(async r => ({status: r.status, body: await r.json()}));
```

3. Expect 202. Observe Building on pve, then Copying to pve2, then Ready on
   both in Setup. Read `/quickstart/setup/state` for buildJob/buildQueue; record
   source start/finish and template journal created_at/updated_at plus stream
   elapsed/wire bytes. If it fails, use the product's Clean up action only after
   inspecting its owned leftovers; do not manually delete unrelated guests.
4. Compare active template_builds: same source build identity, version, manifest,
   and every disk's sha256-pvesm-raw+size-v1 checksum; different cluster VMIDs.
5. With an owner-authenticated CLI, sequentially run:

```sh
umiak --json create --template linux --name s21-recheck-a --wait-ready
umiak exec <first-id> -- printf s21-recheck-ok
umiak --json create --template linux --name s21-recheck-b --wait-ready
umiak exec <second-id> -- printf s21-recheck-ok
umiak rm <first-id> <second-id> --yes
```

Confirm the two sandboxes used different nodes (normal placement selects the
node with more free RAM). If not, use Setup's node-specific installation Smoke
on each node, which creates/executes/deletes through the product. Finally audit
zero test sandboxes, active operations, queue tickets, unfinished copies and
running/interrupted build jobs; leave both nodes active with 8192 MiB caps.
Record the new successful fresh-build evidence without replacing this failed
attempt or its approved exception.
