# S21 live acceptance (coordinator only)

Implementation never contacted pve/pve2. Run this after the fresh installation and
upgrade to the reported main commit. Use disposable test sandboxes and retain
logs/DB journal rows until the checks finish. No production guests are needed.

## Inspection helpers

On the original installer host, set the installed control-plane CT ID. These
commands use the existing console; they do not grant the control plane a shell
on a sandbox node. CLI commands below run on an authenticated workstation.

```sh
CTID=<installed-control-plane-ctid>
cpctl() { pct exec "$CTID" -- docker compose --project-directory /opt/umiak -p umiak "$@"; }
sql() {
  cpctl exec -T quickstart node deploy/compose/quickstart/run.mjs node --input-type=module -e '
    import pg from "pg";
    const p = new pg.Pool({connectionString:process.env.DATABASE_URL});
    try { console.log(JSON.stringify((await p.query(process.argv[1])).rows,null,2)); }
    finally { await p.end(); }
  ' "$1"
}
sql "SELECT id,name,state,ram_cap_mb FROM runtime.nodes ORDER BY name"
sql "SELECT tb.id,tb.source_build_id,n.name,tb.template_slug,tb.version,tb.pve_vmid,tb.status,tb.manifest,tb.checksums FROM runtime.template_builds tb JOIN runtime.nodes n ON n.id=tb.node_id ORDER BY template_slug,n.name,tb.created_at"
sql "SELECT id,kind,source_id,phase,progress,result FROM runtime.volume_transfers ORDER BY created_at DESC"
```

For deterministic capacity pressure, cordon the source in this test install under
the scheduler's node lock (replace the name with the recorded home). Restore it
after each scenario. Do not alter VM RAM or raw DB ownership to simulate a move.

```sh
sql "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('node:'||id::text,0)) FROM runtime.nodes WHERE name='pve'; UPDATE runtime.nodes SET state='cordoned' WHERE name='pve'; COMMIT"
# Restore:
sql "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('node:'||id::text,0)) FROM runtime.nodes WHERE name='pve'; UPDATE runtime.nodes SET state='active' WHERE name='pve'; COMMIT"
```

## 1. Build once, replicas, node add

- In Setup build linux on pve. Observe **Building on pve**, then **Copying to
  pve2** and byte progress. Only the first node runs Packer/build/verification
  VM steps. Repeat linux-desktop and windows (Windows includes EFI and TPM).
- Query template rows above: each node has an active replica with the same root
  build identity/version/original manifest and equal per-disk
  `sha256-block-tree-v1` checksums; template VMIDs differ cluster-wide. The
  checksum is a canonical tree of SHA-256 block hashes, not `sha256sum` of a raw
  disk. Independently export/read both immutable bases on operator consoles and
  compare raw SHA-256 if desired; do not use a whole-disk node-agent digest RPC.
- Use Setup Smoke on each node. Create/exec/delete succeeds on both, including
  desktop/Windows boot and TPM persistence.
- On an otherwise empty pve2, retire local replicas through the existing node
  console, remove its sandbox role, then re-add via installer **Add or remove
  sandbox nodes**. Existing templates must copy without a build; no source
  template changes. Never remove a node with test data remaining.
- During a large replica copy run `cpctl kill -s SIGKILL quickstart`, then
  `cpctl up -d quickstart`. Setup resumes the same journal/VMIDs, preserves the
  previous active build until verification, and eventually shows Ready. Inspect
  `node_build_jobs` and transfer rows for absence of unfinished copy reservations.

## 2. Resume changes home and preserves identity/content

On the workstation (JSONL ready event is the final line):

```sh
SB=$(umiak --json create --template linux --wait-ready | tail -n 1 | jq -r '.sandbox.id')
umiak exec "$SB" -- 'printf s21-marker > /root/s21-marker; sha256sum /root/s21-marker'
umiak stop "$SB" --wait
```

Record VMID/MAC/IP, node/storage and disks before pressure:

```sh
sql "SELECT s.slug,n.name,m.id,m.vmid,m.mac,(SELECT jsonb_agg(to_jsonb(d)) FROM runtime.disks d WHERE d.machine_id=m.id) AS disks FROM runtime.sandboxes s JOIN runtime.machines m ON m.id=s.machine_id JOIN runtime.nodes n ON n.id=m.node_id WHERE s.state='stopped' ORDER BY s.created_at DESC"
```

Record guest IP with `umiak exec "$SB" -- 'hostname -I'` before stopping.
Cordon that home, leaving the other node active with enough RAM. Then:

```sh
umiak start "$SB" --wait 100m
umiak exec "$SB" -- 'cat /root/s21-marker; sha256sum /root/s21-marker'
```

Verify API/dashboard **Moving to pve2…**, increasing verified bytes, same
VMID/MAC/IP and content; DB home/storage now target. On operator consoles,
`qm config <VMID>` exists on the target only, has no migrate lock after commit,
and boots there. Source original disks disappear only after verified target +
DB commit; transfer ends done. Restore source eligibility and move back by
cordoning the new home; a second journal must work with the same VMID.

## 3. Fork and saved snapshots

With the home cordoned or filled, repeat:

```sh
umiak stop "$SB" --wait
umiak snapshot save "$SB" s21-saved --wait
umiak fork "$SB" --capacity-wait 100m --wait-ready
umiak create --from s21-saved --capacity-wait 100m --wait-ready
```

Verify both copies' marker checksum and exec. The original sandbox is untouched;
the saved snapshot's home and disks move atomically. Snapshot API/dashboard shows
moving progress. Change one copy's marker and confirm source/other copy/snapshot
stay independent. Repeat creating from the same saved snapshot after a move back.
For Windows repeat with the stopped source and verify OS/EFI/TPM disks and boot.
Delete a saved snapshot while a move/clone is in progress: it must serialize,
never remove blocks still being copied or publish a partial snapshot.

For thin-delta measurement, change a small file plus discard/zero a previously
nonzero region in the guest. Source `thin_delta` extents and transferred payload
must be much smaller than the logical disk; checksums/content must match,
including changed-to-zero data. Temporarily make the matching target base
unavailable in a disposable retired-build scenario: the full sparse path must
preserve content and skip holes. Keep the source template; never delete a live
base LV manually. Missing metadata tools/reservation contention must use the
bounded safe fallback and retain source on errors.

## 4. Crash boundaries and restrictions

Repeat a disposable cold move, inspecting the journal SQL. Kill/restart worker
at each boundary: copying, verified, switching (including after config relocation
but before DB commit), committed/cleanup:

```sh
cpctl kill -s SIGKILL worker
cpctl up -d worker
```

Each replay must converge to one runnable config, keep source until target
verification, preserve identity/content, release move RAM reservation, and remove
staging/temp snapshots after cleanup. Reconcile must retain active transfer LVs.
Supersede during copy with `umiak rm <id> --yes`: no unverified target starts.
After switching intent the worker completes ownership before delete cleanup.
Corrupt one staging block **only in a disposable test** and verify readback fails
closed with source intact; retry cannot silently skip a mismatching checkpoint.

Using only the existing restricted key, test node-agent requests for a foreign
LV, template-base import destination, live sandbox export, invalid range/oversize
payload and arbitrary shell command. All must fail without host/guest changes.
Inspect logs: no block data, secrets or private key contents.

## 5. Capacity queue

Cordon both nodes (or fill their configured RAM caps), leaving stopped test
sandboxes. In separate terminals, queue A then B in team 1, and C in team 2:

```sh
umiak start <A> --wait 100m
umiak start <B> --wait 100m
# Authenticated as team 2:
umiak start <C> --wait 100m
```

Dashboard/API show queued with the original deadline. Query:

```sh
sql "SELECT q.seq,q.team_id,q.operation_id,q.deadline_at,o.progress FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id ORDER BY q.seq"
sql "SELECT * FROM runtime.move_reservations"
```

Restore one node with room for one VM, or stop a blocker. A precedes B; C can
progress independently; there is no RAM overcommit or VMID allocated for an
unadmitted create. Repeat freeing RAM by delete/retention and idle autostop.
Restart worker while queued: order/deadlines do not reset. A smaller B cannot
bypass a larger A; a new fail-fast start cannot bypass either in that team.

```sh
umiak cancel-start <B>
umiak start <stopped-test> --wait 5s
umiak create --template linux --capacity-wait 5s --wait-ready
```

Keep capacity exhausted for short waits: final error is retryable
`out_of_capacity`, resume stays stopped, create has no VM. Cancellation is
repeatable, shows cancelled and never starts when capacity later returns.
Delete a queued create; verify no ticket/orphan VM remains. Repeat fork cancellation
before and after source snapshot hand-off; source remains intact.

Check each public interface (use a capacity-exhausted test team):

- API: `POST /v1/sandboxes` and `POST /v1/sandboxes/<id>/resume|fork` with
  `{"capacityWaitSeconds":6000}`; GET sandbox/operation shows queued/progress;
  `POST /v1/sandboxes/<id>/cancel-start` returns 202, repeat also 202.
- TS: `await umiak.sandboxes.create({capacityWaitSeconds:6000})`, then
  `await sandbox.cancelStart()`. Repeat `resume/fork` with `{wait:true}` and
  confirm client budget includes capacity time.
- Python sync and async: `sandboxes.create(capacity_wait_seconds=6000)`,
  `sb.resume/fork(capacity_wait_seconds=6000, wait=True)`, `sb.cancel_start()`.
- MCP: `sandbox_create/resume/fork(capacity_wait_seconds=6000, wait=false)`,
  `sandbox_get`, `sandbox_cancel_start`. A short `wait_seconds` returns the
  queued handle; it does not shorten/cancel the server ticket.
- Legacy `umiak create --wait` still waits for ready and fails immediately if
  no capacity; `--wait-ready` is its explicit synonym. Client disconnect or
  `--wait-timeout` does not cancel durable queued work.

## 6. Unavailable source and large transfers

Make only the stopped source node-agent temporarily unreachable (keep cluster
quorum). Attempt resume/fork/saved-snapshot create on the other node. No stale
or unverified target starts and source is never removed. Restore the channel;
retry converges. Never simulate this by stopping both cluster nodes.

Use a large sparse Windows/Linux disk and throttle transfer long enough to
exceed the former whole-disk hashing timeout/ordinary operation wall time.
Progress renews the deadline; bounded RPCs complete without a whole-volume
SHA-256 call. Check metadata delta avoids unchanged-disk scans. If metadata
fallback is exercised, measure its local IO/RPC cost and retain it in acceptance
evidence. Finally restore both nodes active, delete test sandboxes/snapshots,
and verify no unfinished transfers/tickets/move reservations/build jobs remain.
