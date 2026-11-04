# S1 Proxmox foundation: implementation plan

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development for independent tasks). Steps are `- [ ]` checkboxes.

**Goal:** implement S1 per `docs/specs/s1-proxmox-foundation.md`: prepare `pve`, write `sbx-node`, `packages/pve`, `sbx-bench`, get a green run of `sbx-bench s1` and record the numbers in §11 of the spec.

**Architecture:** the Go binary `sbx-node` on the host executes a whitelist of LVM/DHCP/inventory operations (JSON over stdin/stdout through SSH with a forced command). The TS package `@sbx/pve` (PVE API via `node:https`, `sbx-node` client via `ssh2`, `lvmthin` driver, machine primitives, allocator on `node:sqlite`). The CLI `sbx-bench` (`apps/bench`) runs the scenario and prints metrics. The runbook `infra/pve/setup.sh` is run from the Mac and executes steps on the host via `ssh pve`.

**Stack:** Go 1.27.3 (+ `github.com/pelletier/go-toml/v2`), Node 26.13.0 with native type stripping (TS without a build), TypeScript 7 (`tsc --noEmit`), vitest 5, biome 2, `ssh2` 1.17.

**Specification:** `docs/specs/s1-proxmox-foundation.md` (source of truth). The smbios interface is S2 §5.2 and §15.

## Global constraints

- VMID 500–599 (allocation 500–598, 599 is the template), RAM of all sandboxes ≤ 8 GB, storage `local-lvm` (VG `pve`, pool `data`).
- Do not touch: existing VMs/LXCs (100–109), `vmbr0`, templates 9000/9001 and their LVs.
- All objects on the host are tagged `boat-dev-clone S1 PoC`.
- Secrets (token, key, BS/serial) — not in git, not in state, not in logs and the stand's JSON.
- Thin pool thresholds: create/snapshot are forbidden at data > 80% or metadata > 70%.
- Freeze budget 10 s; without QGA a snapshot is forbidden (except an explicit `crashConsistent`).
- MAC: `02:<cluster>:<vmid 4 bytes BE>`; `/cluster/nextid` is not used.
- `smbios1` and `vmgenid` of the source are never copied into a fork.
- `sbx-deny-public` is empty in the PoC.
- Dependencies are the latest stable (checked 2026-10-29: `ssh2@1.17.0`, `@types/ssh2@1.15.6`, `go-toml/v2@v2.4.3`).
- Deviation from the specification [implementation decision]: §4 requires a separate "yes" before the firewall — the master session passed on Ilia's consent for the whole runbook, so the steps go without stopping, but strictly with the safe-enable procedure.

## Review Focus

1. **Enabling the firewall breaks existing guests.** After enabling, `bridge-nf-call-iptables=1` sends all `vmbr0` bridge traffic through `PVEFW-FORWARD`, where by default `ctstate INVALID -j DROP`. Add `nf_conntrack_allow_invalid: 1` to `host.fw` (the host is still not filtered) and check guest ping before/after. The check is in the `fw` step of the runbook.
2. **SDN apply reloads the network (`ifreload -a`).** If `/etc/network/interfaces` differs from the live state, apply will change `vmbr0`. Before apply: `ifquery --check -a` without `[fail]`, otherwise stop. Step `sdn`.
3. **Partial failure in the middle of create/fork.** The VM is created, but `lvcreate` or the firewall failed — the config, LVs, and an allocator row remain. Expectation: the error goes outward, the machine layer itself calls the delete path; `cleanup` picks up the rest. Test in task 7.
4. **Reissuing a VMID while traces of it remain.** The allocator must skip a VMID that has LVs `vm-<id>-*` or a VM in `/cluster/resources`, even if it is not in the table. Test in task 5.
5. **The serial leaks into our logs.** `sbx-node` does not write `search` and any `smbios1` fields to the journal; the stand does not write the serial to JSON. Tests in tasks 1 and 8.

---

### Task 1: `sbx-node` (Go, `services/node-agent`)

**Files:**
- Create: `services/node-agent/go.mod` (`go 1.27`, `toolchain go1.27.3`), `cmd/sbx-node/main.go`
- Create: `internal/config/config.go` (+ `_test.go`)
- Create: `internal/lvm/lvm.go` (interface + exec implementation via `lvs --reportformat json --units b --nosuffix`, `lvcreate`, `lvremove`, `lvmconfig`)
- Create: `internal/ops/{dispatch,guards,lv,pool,dhcp,inventory}.go` (+ `_test.go` with a fake LVM and fs)
- Create: `services/node-agent/.golangci.yml`
- Modify: `go.work` (`go work use ./services/node-agent`)

**Interfaces:**
- Produces (protocol, consumed by task 4): request `{"op": string, "args": object, "requestId": string}`, response `{"ok": true, "result": …}` or `{"ok": false, "error": {"code": string, "message": string}}`; exit code 0/1. Error codes: `bad_request`, `forbidden`, `not_found`, `exec_failed`.
- Config `/etc/sbx-node.toml`: `vg="pve"`, `thinPool="data"`, `vmidMin=500`, `vmidMax=599`, `templateVmid=599`, `sdnZone="sbx"`, `vnet="sbx0"`, `clusterId=1`, `leaseFile="/var/lib/misc/dnsmasq.sbx.leases"` (path to be refined after the `sdn` step), `storage="local-lvm"`.
- Operations and results:
  - `version` → `{version, config}`.
  - `lv.snapshot {items: [{origin, name, tags: string[], activationSkip: bool}]}` → `{created: string[]}`. Atomic: on error it removes what this call created.
  - `lv.remove {names: string[]}` → `{removed: string[], missing: string[]}`.
  - `lv.list {tags?: string[]}` (all tags must match; without a filter — all LVs of the VG) → `{lvs: [{name, sizeBytes, attr, tags, origin, dataPercent}]}`.
  - `pool.usage` → `{dataPercent, metadataPercent, sizeBytes, ourLvCount, ourLvSizeBytes, ourLvUsedBytes, autoextendThreshold}`.
  - `dhcp.leases` → `{leases: [{expiry, mac, ip, hostname, clientId}]}`.
  - `dhcp.release {mac}` → `{released: bool}` (via `dhcp_release <vnet> <ip> <mac>`).
  - `inventory {sections?: string[], search?: string, since?: number}` → sections `guests` (`qm list`/`pct list` into rows), `lvs` (LVs without the `sbx` tag: name, size, attr), `hashes` (sha256 of `/etc/pve/sdn/**`, `/etc/pve/firewall/*.fw` except VMIDs of the range, `/etc/pve/nodes/<node>/host.fw`, `/etc/network/interfaces*`), `sysctl` (`net.ipv4.ip_forward`, `net.ipv6.conf.all.forwarding`), `sbx0` (the host's link-local address), `vmfiles` (existing `/etc/pve/qemu-server/<id>.conf` and `/etc/pve/firewall/<id>.fw` for VMIDs of the range), `journalReaders` (members of the groups `adm`, `systemd-journal`, `wheel`), `search` (only with `search`: `{journal: bool, tasklog: bool, qemuCmdline: bool}` — a substring in `journalctl -o cat --since @since`, in files `/var/log/pve/tasks/**` newer than `since`, in `/proc/*/cmdline` of `kvm` processes).

- [ ] **Step 1: guards tests** (`internal/ops/guards_test.go`), table-driven:
  - origin allowed: `base-599-disk-0`, `sbx-snap-abc-scsi0`, `vm-500-disk-0`, `vm-598-disk-1`; forbidden: `base-9000-disk-0`, `vm-108-disk-1`, `vm-599-disk-0` (template VMID), `vm-600-disk-0`, `root`, `data`, `../x`, `vm-500-disk-0;rm`.
  - name allowed: `vm-500-disk-0`, `sbx-snap-k3j9x2m4qa-scsi0`; forbidden: `base-599-disk-0`, `vm-599-disk-0`, `vm-108-disk-0`, `vm-500-cloudinit`, names outside `^[a-z0-9][a-z0-9+_.-]{0,126}$`.
  - tags: `sbx` is required; allowed `sbx`, `sbx-vm-<id in range>`, `sbx-snap-<id>`, `sbx-src-<id in range>`; forbidden `sbx-tpl`, arbitrary ones.
  - mac for `dhcp.release`: `02:01:00:00:01:F4` allowed (cluster 1, VMID 500), `02:02:00:00:01:F4` and `02:01:00:00:00:6C` (VMID 108) and `BC:24:11:…` forbidden.
- [ ] **Step 2:** `go test ./...` — FAIL (no code).
- [ ] **Step 3:** implement `guards.go`: `ValidOrigin(cfg, name) error`, `ValidTargetName(cfg, name) error`, `ValidTags(cfg, tags) error`, `ValidMAC(cfg, mac) error`.
- [ ] **Step 4: dispatch and operations tests** with a fake `lvm.LVM`:
  - unknown op → `bad_request`, exit 1; broken JSON → `bad_request`.
  - `lv.snapshot` of two items, the second fails in the fake → the first is removed, error `exec_failed`, `created` is not returned.
  - `lv.remove` of an LV without the `sbx` tag or with `sbx-tpl` → `forbidden`, nothing removed (checked before any removal); a missing name → in `missing`.
  - journal (fake logger): for `inventory {search:"SECRET"}` the entry does not contain `SECRET`; for the other ops the arguments are written.
  - `dhcp.leases` parses the line `1793300000 02:01:00:00:01:f4 10.88.0.100 sbx-500 01:02:01:00:00:01:f4`.
- [ ] **Step 5:** implement `dispatch.go`, the operations, the exec LVM (`lvcreate -s -k{y|n} -n NAME --addtag T… VG/ORIGIN`, `lvremove -y VG/NAME`), logging to the journal via `log/syslog` (tag `sbx-node`: requestId, op, args with `search` redacted, outcome).
- [ ] **Step 6:** `mise exec -- go test ./...` PASS; `mise exec -- golangci-lint run ./...` without remarks; `GOOS=linux GOARCH=amd64 go build -o bin/sbx-node ./cmd/sbx-node`.
- [ ] **Step 7:** commit `node-agent: sbx-node with op whitelist and LV guards`.

### Task 2: runbook `infra/pve/setup.sh` and host preparation

**Files:**
- Create: `infra/pve/setup.sh`, `infra/pve/snippets/sbx-tpl-vendor.yaml`, `infra/pve/sbx-node.toml`, `infra/pve/README.md` (how to run, order of steps, rollback)

**Interfaces:**
- Run from the Mac: `infra/pve/setup.sh [--dry-run] <step>` and `infra/pve/setup.sh revert <step>`. Steps: `user`, `net`, `sdn`, `node`, `fw`, `template`, `status`. Host: `SBX_SETUP_SSH` (default `pve`). `SBX_DENY_PUBLIC_IPS` (default empty).
- Produces: on the Mac `~/.config/sbx/{pve-token (600), pve-root-ca.pem, sbx-node_ed25519, known_hosts}`; on the host the objects of §4.1–4.6.

- [ ] **Step 1:** write `setup.sh`: each step = `check` (already done → exit 0) → `apply` → `verify`; `--dry-run` prints the remote script instead of executing. `shellcheck` clean.
  - `user`: §4.1; the token secret is written only to `~/.config/sbx/pve-token` (via `pvesh create … --output-format json`, without terminal output). CA: `/etc/pve/pve-root-ca.pem` → `~/.config/sbx/pve-root-ca.pem`.
  - `net`: §4.2.
  - `sdn`: §4.3; before apply `ifquery --check -a` without `[fail]` and a snapshot of `ip -d link show vmbr0`, afterwards the same snapshot matches.
  - `node`: §4.5; the key is generated if absent; the binary from task 1 is copied to `/usr/local/bin/sbx-node`, the config to `/etc/sbx-node.toml`; a line in `/etc/pve/priv/authorized_keys`; `ssh-keyscan -t ed25519 pve.tail0000.ts.net > ~/.config/sbx/known_hosts`; verify: `sbx-node version` via the key.
  - `fw`: §4.4 exactly per the procedure. `host.fw`: `enable: 0` and `nf_conntrack_allow_invalid: 1` (Review Focus 1). IPv6: add `OUT DROP -dest ::/0` to the group (if `pve-firewall compile` does not accept it — IPSet `sbx-deny6` with `::/0`). "Before" snapshot from the Mac: `ssh pve true`, `ssh pve-lan true`, `curl --cacert ~/.config/sbx/pve-root-ca.pem` to `:8006` by the Tailscale name and the LAN IP (via `--resolve pve:8006:<ip>`), ping of the LAN IP of each running guest (IP from `ip neigh` by MAC from the configs). Rollback timer 5 min → enable → 30 s → the same checks + `pve-firewall status` + `iptables-save | grep -E 'tap1[0-9]{2}i|veth1[0-9]{2}i'` empty + all guests from `qm list`/`pct list` in the same status. Everything that was green "before" must be green "after" → `systemctl stop sbx-fw-rollback.timer`; otherwise wait for the rollback, exit 1.
  - `template`: §4.6; wait for QGA via `qm agent 599 ping`; inside via `qm guest exec`; firewall 599 the same as for sandboxes.
  - `status`: prints the state of all steps.
- [ ] **Step 2:** `--dry-run` for each step, read the output.
- [ ] **Step 3:** run in order `user`, `net`, `sdn`, `node`, `fw`, `template`. Before `fw` — make sure again that `ssh pve-lan` and guest ping work (the baseline for comparison). On any red `fw` — stop and report to master.
- [ ] **Step 4:** `setup.sh status` — all green; `qm list`/`pct list` as before the start (100, 101, 102, 103, 109, 104, 105 running).
- [ ] **Step 5:** refine the lease file path in `infra/pve/sbx-node.toml`, commit `infra: pve runbook for S1`.

### Task 3: API reconnaissance on the live host (before the machine code)

Manual calls with the token (`curl` with the CA), results go into the "Findings" section at the end of this plan. Tasks 6–7 depend on them.

- [ ] **Step 1:** create VM 598 with the token per §6.3 (POST without disks, `lv.snapshot` via `sbx-node`, PUT config with `scsi0`, firewall). Record: which rights were needed beyond §4.1 (add to the runbook and §4.1 of the spec), when the IP appears in IPAM (after POST or after start), how to read IPAM with the token (`GET /cluster/sdn/ipams/pve/status` or another path).
- [ ] **Step 2:** `ipfilter=1`: fill `ipfilter-net0` with the address from IPAM before start, start, check DHCP and internet. If fragile — `macfilter`-only mode, decision in §11.
- [ ] **Step 3:** serial length: PUT `smbios1` with a serial of 85, 256, 512, 1024 bytes (base64=1) on a stopped VM, then start and `product_serial` via QGA. Record the limit.
- [ ] **Step 4:** delete 598 (`purge=1&destroy-unreferenced-disks=1`): do the lease in `dhcp.leases`, the IPAM entry, `vm-598-cloudinit`, `/etc/pve/firewall/598.fw` remain. If the lease remains — `dhcp.release` is needed (and `dnsmasq-utils` in the `net` step).
- [ ] **Step 5:** lease renewal through the firewall: `iptables-save` for `tap598i0-OUT`/`-IN` (order of the `dhcp` rule relative to the group), `isolate-ports` on `fwpr598p0` (`bridge -d link show`).
- [ ] **Step 6:** commit the findings.

### Task 4: `@sbx/pve` — config, PVE API, `sbx-node` client

**Files:**
- Create: `packages/pve/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/config.ts`, `src/pve-api.ts`, `src/node-client.ts`, `src/errors.ts`, tests `test/config.test.ts`, `test/pve-api.test.ts`, `test/node-client.test.ts`
- Modify: root `.gitignore` (`bench-results/`)

**Interfaces:**
- `package.json`: `"name": "@sbx/pve"`, `"type": "module"`, `"exports": {".": "./src/index.ts"}`, scripts `test` (vitest run), `typecheck` (`tsc --noEmit`). Imports with `.ts`; tsconfig: extends base, `allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly` (Node runs TS directly).
- `loadConfig(env = process.env): Config` — the fields of §6.1 (`pveUrl`, `tokenId`, `tokenSecretFile`, `caFile`, `tlsName`, `nodeSshHost`, `nodeSshKeyFile`, `nodeSshKnownHosts`, `vmidRange: {min, max}`, `clusterId`, `stateDb`, `templateVmid`, plus `node: "pve"`, `storage: "local-lvm"`, `vnet: "sbx0"`); `~` is expanded. The secret is read lazily by `readTokenSecret(cfg)`, the file mode must be 600.
- `class PveApi { constructor(opts: {url, tokenId, tokenSecret, ca, tlsName}); get<T>(path, params?); post<T>(path, params?); put<T>(path, params?); delete<T>(path, params?); waitTask(node, upid, {timeoutMs}): Promise<void> }`. `node:https` with `ca` and `servername: tlsName`; body `application/x-www-form-urlencoded`; the response `.data`. Error `PveApiError {status, message, errors}`. Retry up to 5 times with backoff on responses with `can't lock file` or 503.
- `interface NodeOps { call<T>(op: string, args?: object): Promise<T>; close(): void }`; `class SshNodeOps implements NodeOps` — one `ssh2` SSH connection, an exec channel per call, JSON on stdin, host key checked against our `known_hosts` (`hostVerifier`, comparison of the base64 key). `NodeOpsError {code, message}`. `requestId` = `crypto.randomUUID()`.

- [ ] **Step 1:** tests: `loadConfig` with an empty env gives the defaults of §6.1; `SBX_VMID_RANGE=500-598` → `{min:500,max:598}`, `500-700` with template 599 inside → error; `PveApi` against a local HTTPS server with a self-signed CA and a certificate for `pve`: header `Authorization: PVEAPIToken=sbx@pve!poc=<secret>`, form body, `data` is unwrapped, a 500 `can't lock file` is retried and then passes, the name `pve` is checked (a certificate for another name → error); `waitTask` returns on `exitstatus: OK`, throws with the text otherwise; `parseKnownHosts` + `hostVerifier` (right key → true, another → false).
- [ ] **Step 2:** FAIL → implementation → `pnpm --filter @sbx/pve test` PASS, `typecheck`, `pnpm lint`.
- [ ] **Step 3:** commit `pve: config, API client, sbx-node client`.

### Task 5: VMID/MAC allocator

**Files:** `packages/pve/src/allocator.ts`, `src/state-sqlite.ts`, `test/allocator.test.ts`

**Interfaces:**
- `macFor(clusterId: number, vmid: number): string` — uppercase, `macFor(1, 500) === "02:01:00:00:01:F4"`.
- `type LeaseState = "reserved" | "active" | "releasing"`; `interface VmidLease {cluster, vmid, mac, state, purpose: "machine" | "template", createdAt, updatedAt}`.
- `interface AllocatorStore { tryInsert(l: VmidLease): boolean; get(cluster, vmid); list(cluster): VmidLease[]; setState(cluster, vmid, s): void; remove(cluster, vmid): void }` and `interface SnapshotStore { putSnapshot(s: SnapshotRef); getSnapshot(id); listSnapshots(); removeSnapshot(id) }`.
- `class SqliteStateStore implements AllocatorStore, SnapshotStore` (`node:sqlite` `DatabaseSync`; tables `vmid_lease` with `UNIQUE(cluster, vmid)`, `UNIQUE(cluster, mac)`, and `snapshot(id PK, source_vmid, meta_json, created_at)`; path `:memory:` for tests).
- `class Allocator { constructor({store, clusterId, range, templateVmid, occupied: () => Promise<Set<number>>}); ensureTemplate(): void; allocate(purpose?): Promise<{vmid, mac}>; markActive(vmid); markReleasing(vmid); release(vmid) }`. `occupied` = VMIDs from `/cluster/resources` ∪ VMIDs from LVs `vm-<id>-*` (collected by the machine layer).

- [ ] **Step 1:** tests: the first allocate → 500/`02:01:00:00:01:F4`; 500 in the table → 501; 501 in `occupied` (an LV remained) → 502; `tryInsert` returns false (simulated race: the fake store rejects the first insert) → the next one is taken; range exhausted → error `vmid_exhausted`; 599 (template) is not issued even with the range 500–599; `release` deletes the row, the VMID is issued again; an entry in `releasing` occupies the VMID.
- [ ] **Step 2:** FAIL → implementation → PASS → commit `pve: VMID/MAC allocator on node:sqlite`.

### Task 6: the `lvmthin` driver

**Files:** `packages/pve/src/storage/types.ts`, `src/storage/lvmthin.ts`, `src/storage/disks.ts`, `test/lvmthin.test.ts`, `test/fakes.ts` (fake `NodeOps` with a call log)

**Interfaces:**
- Types as in spec §6.2: `StorageDriver`, `QuiesceHook`. `type DiskSlot = "efidisk0" | "scsi0" | "tpmstate0"`; `interface Disk {slot, volid, lv, sizeBytes?, options: Record<string,string>}`; `type DiskSet = Disk[]` (slot order `efidisk0, scsi0, tpmstate0`); `TemplateRef {vmid, node, disks}`, `VmTarget {vmid, node}`, `MachineRef {vmid, node, disks, running: boolean}`, `MachineDisksRef {kind: "machine", vmid, node}`, `SnapshotRef {kind: "snapshot", id, node, sourceVmid, disks, hardware: Record<string,string>, createdAt}`, `NodeRef {node}`, `StorageUsage {dataPercent, metadataPercent, ourLvCount, ourLvUsedBytes}`.
- `parseDiskSet(config: Record<string,string>, storage): DiskSet` and `formatDisk(d: Disk): string` (`local-lvm:vm-500-disk-0,discard=on,iothread=1,ssd=1`; `size` is not written).
- `class LvmThinDriver implements StorageDriver { constructor({node: NodeOps, vcpu: {suspend(vmid), resume(vmid)}, storage, freezeBudgetMs = 10000, maxDataPercent = 80, maxMetadataPercent = 70, thawRetries = 3, newSnapshotId?: () => string}) }`.
- Errors: `StorageFullError`, `FreezeBudgetExceededError`, `ThawFailedError` (the machine needs attention).

- [ ] **Step 1:** tests (the fake records the call order):
  - `cloneFromTemplate` of a template with `scsi0` (`base-599-disk-0`) → `pool.usage`, then `lv.snapshot` `{origin:"base-599-disk-0", name:"vm-500-disk-0", tags:["sbx","sbx-vm-500"], activationSkip:false}`; returns `volid "local-lvm:vm-500-disk-0"` with the template's options. A Windows template with three slots → `disk-0..2` in slot order.
  - pool data 81% or metadata 71% → `StorageFullError`, `lv.snapshot` was not called.
  - `snapshot` of a running machine with 1 disk: `freeze` → `lv.snapshot` (`sbx-snap-<id>-scsi0`, tags `sbx`,`sbx-snap-<id>`,`sbx-src-500`, `activationSkip:true`) → `thaw`; `suspend` was not called. With 2 disks: `freeze → suspend → lv.snapshot → resume → thaw`.
  - `lv.snapshot` fails → `thaw` is still called (and `resume`, if there was a pause).
  - freeze+snapshot longer than the budget (fake clock) → `lv.remove` of the created ones, `FreezeBudgetExceededError`, `thaw` called.
  - `thaw` fails 3 times → `ThawFailedError`; fails 2 times, then ok → success.
  - a stopped machine → neither `freeze` nor `suspend`.
  - `cloneFromSnapshot` → origin `sbx-snap-<id>-scsi0`, name `vm-501-disk-0`, tags `sbx`,`sbx-vm-501`.
  - `delete({kind:"machine", vmid:500})` → `lv.list {tags:["sbx-vm-500"]}` → `lv.remove` of those names; `delete(snapshotRef)` → by `sbx-snap-<id>`.
- [ ] **Step 2:** FAIL → implementation → PASS → commit `pve: lvmthin storage driver`.

### Task 7: machine primitives

**Files:** `packages/pve/src/machine.ts`, `src/smbios.ts`, `src/qga.ts`, `test/machine.test.ts`, `test/smbios.test.ts`, the fake PVE API in `test/fakes.ts`

**Interfaces:**
- `interface Smbios {uuid: string; serial: string}` (serial is the raw payload); `formatSmbios1(s): string` → `uuid=<uuid>,serial=<base64(serial)>,base64=1`. `s2SerialPayload(machineId, bs: Uint8Array) = "sbx1:" + machineId + ":" + base64url(bs)`.
- `interface MachineSize {cores: number; memoryMb: number}` (default 2 / 2048).
- `class Machines { constructor({api: PveApi-like, node: NodeOps, driver: StorageDriver, allocator: Allocator, snapshots: SnapshotStore, cfg: Config, cloneConcurrency = 4, ipfilter: boolean}) }`:
  - `create(opts: {size?, smbios?}): Promise<MachineInfo>`; `fork(snap: SnapshotRef, opts: {size?, smbios?}): Promise<MachineInfo>`; `MachineInfo {vmid, mac, node, disks}`.
  - `start(vmid)`, `shutdown(vmid, timeoutS)`, `stop(vmid)` — via a UPID task.
  - `waitReady(vmid, {timeoutMs, startedAt}): Promise<{pingAt: number, ipAt: number, ip: string, ifname: string}>` — `agent/ping` until success, then `agent/network-get-interfaces` until an IPv4 in `10.88.0.0/24`.
  - `snapshot(vmid, {crashConsistent?: boolean}): Promise<SnapshotRef>` — a QGA ping is required for running, otherwise `QgaUnavailableError`; hook `QgaQuiesceHook` (`agent/fsfreeze-freeze`/`fsfreeze-thaw`); `hardware` from the config without `smbios1`, `vmgenid`, `net0`, `name`, disks, and `ide2`; saved to `SnapshotStore`.
  - `delete(vmid)`: `markReleasing` → `status/stop` (if it exists and is running) → `DELETE ?purge=1&destroy-unreferenced-disks=1` → `driver.delete` → `verifyGone(vmid, mac)` (config 404; `inventory {sections:["vmfiles"]}` empty for vmid; IPAM without mac; lease without mac, otherwise `dhcp.release` and a repeated check) → `allocator.release`. A check failure → `TracesRemainError`, the row stays `releasing`.
  - `deleteSnapshot(ref)`: `driver.delete(ref)` → `lv.list` empty → `snapshots.removeSnapshot`.
  - `qga.exec(vmid, cmd: string[], {timeoutMs, input?}): Promise<{exitCode, stdout, stderr}>` — `agent/exec` + polling `exec-status`.
- Create order (§6.3): allocate → `POST /nodes/pve/qemu` (template keys by whitelist `machine, cpu, bios, ostype, scsihw, agent, serial0, vga, tablet`; `cores`, `memory`, `balloon=0`, `net0=virtio=<MAC>,bridge=sbx0,firewall=1`, `ide2=local-lvm:cloudinit`, `ipconfig0=ip=dhcp`, `ciuser=sbx`, `vmgenid=1`, `tags=sbx`, `pool=sandbox`, `name=sbx-<vmid>`, `smbios1` if passed) → `driver.cloneFromTemplate` → `PUT config` (disks + `boot=order=scsi0`) → firewall (`PUT …/firewall/options` §4.4; `POST …/firewall/rules type=group action=sbx-egress iface=net0 enable=1`; with `ipfilter` — ipset `ipfilter-net0` with the IP from IPAM, per the findings of task 3) → `markActive`. On an error after POST — `delete(vmid)` and rethrow the original error. A `cloneConcurrency` semaphore around create/fork.

- [ ] **Step 1:** tests: `formatSmbios1({uuid:"u", serial:"sbx1:x"})` = `uuid=u,serial=c2J4MTp4,base64=1`; create call order; the POST contains `pool=sandbox`, `vmgenid=1`, the MAC from the allocator, does not contain `smbios1` when opts are absent and does not contain keys outside the whitelist (for example `sshkeys`, the template's `ciuser`); fork: the POST contains the snapshot's `hardware`, but neither `smbios1` nor the source's `vmgenid` (`vmgenid=1`), disks from `cloneFromSnapshot`; a firewall step failure → the delete path is called, the allocator row removed, the original error rethrown; delete: the row is `releasing` before the check, removed after; the lease remained → `dhcp.release` called; IPAM still has the MAC → `TracesRemainError`, row `releasing`; snapshot without QGA → `QgaUnavailableError`, with `crashConsistent` → passes without freeze; semaphore: 6 parallel creates with a limit of 4 → no more than 4 at once in the fake.
- [ ] **Step 2:** FAIL → implementation → PASS, typecheck, lint → commit `pve: machine primitives (create, fork, snapshot, delete)`.

### Task 8: `sbx-bench` (`apps/bench`)

**Files:** `apps/bench/{package.json,tsconfig.json}`, `src/main.ts` (`#!/usr/bin/env node`, `parseArgs`), `src/context.ts` (assembling dependencies from `loadConfig`), `src/preflight.ts`, `src/s1.ts`, `src/checks.ts` (network checks from inside the VM), `src/cleanup.ts`, `src/world.ts` (inventory diff), `src/stats.ts`, `src/report.ts`, tests `test/stats.test.ts`, `test/world.test.ts`, `test/report.test.ts`

**Interfaces:**
- Run: `mise exec -- node apps/bench/src/main.ts <preflight|s1|cleanup> [flags]`; in `apps/bench/package.json` `"bin": {"sbx-bench": "./src/main.ts"}`.
- `summarize(xs: number[]): {n, median, p95, min, max}` — p95 by nearest rank (`xs[ceil(0.95n)-1]` after sorting), median for even n is the mean of the two.
- `diffWorld(before, after): string[]` — human-readable differences; the `search` section is not compared.
- `class RamGuard {constructor(api, capMb); assertCanStart(memoryMb)}` — the sum of `maxmem` of running VMs in pool `sandbox` + the new one ≤ cap.
- A check = `{name, ok, detail}`; any `ok:false` → final exit 1. Everything written to JSON and stdout goes through `redact()`, which cuts out test serials/uuids.

- [ ] **Step 1:** tests `summarize([1,2,3])` = `{n:3, median:2, p95:3, min:1, max:3}`; `summarize([4,1,3,2])` median 2.5, p95 4; `diffWorld` finds a changed hash, a new VM in `guests`, a new LV and ignores `search`; `redact` removes the serial from a nested object.
- [ ] **Step 2:** FAIL → implementation of stats/world/report → PASS.
- [ ] **Step 3:** `preflight` per §7.1: journalReaders empty; token: `GET /version`, `/pools/sandbox`, `/cluster/sdn/vnets` (or the path from task 3), `/nodes/pve/qemu/599/config`, IPAM; `sbx-node version`; `sbx0` in vnets and `sbx-egress` in groups (via `GET /cluster/firewall/groups` if the token sees it, otherwise `inventory hashes`); sysctl `ip_forward=1`, IPv6 forwarding 0; `pool.usage` below thresholds and `autoextendThreshold=100`; 599 exists and `template=1`; leftovers: VMs in the pool other than 599, `lv.list {tags:["sbx"]}` empty, allocator rows (except template) and snapshots empty.
- [ ] **Step 4:** `s1` per §7.2 (steps 0–5, flags of §7.1, metrics of §7.3, JSON in `bench-results/s1-<ISO>.json` with the PVE/kernel version, storage, template, size, `git rev-parse HEAD`, raw measurements). Network checks — `qga.exec` with `bash -c`, one check per call, each with an expected result; positive control for A↔F isolation: inside F `</dev/tcp/127.0.0.1/22` passes. IPv6 — by the interface `ifname` from `waitReady`. Where the serial is visible: config via the API (`smbios1` contains the base64 serial), `inventory {sections:["search"], search, since}`; result `{config, journal, tasklog, qemuCmdline}` in JSON without the value. Parallelism and clone-only: `Promise.allSettled`, errors and retries (the retry counter from `PveApi`) are recorded. Baseline: `POST /nodes/pve/qemu/599/clone {newid, full:0, pool:"sandbox", name}` → the same config and firewall → delete by the same path.
- [ ] **Step 5:** `cleanup` per §7.1: VMs in the pool other than 599 → `machines.delete`; `lv.list {tags:["sbx"]}` → `lv.remove`; leases of our MACs → `dhcp.release`; allocator and snapshot rows → delete; final summary.
- [ ] **Step 6:** typecheck, lint, commit `bench: sbx-bench preflight, s1, cleanup`.

### Task 9: run on `pve`, fixes, results

- [ ] **Step 1:** `sbx-bench preflight` — all green (add permissions only on an actual denial, recording them in §4.1 of the spec and the runbook).
- [ ] **Step 2:** `sbx-bench s1 --runs 1 --parallel 1 --no-baseline` until green; then the full `sbx-bench s1` (defaults: 3 runs, 1/2/4, clone-only 8, baseline). Each bug goes through superpowers:systematic-debugging, a test for the bug in the corresponding task.
- [ ] **Step 3:** an intentional failure (`--keep` and interruption) → `sbx-bench cleanup` → `preflight` without leftovers; the world diff is empty.
- [ ] **Step 4:** manual checks of §12: lease renewal (`iptables-save` rules for the tap chains and/or a VM with a short lease), isolate-ports with fwbr, ipfilter, lease on delete, serial length.
- [ ] **Step 5:** fill in §11 of the spec: the metrics table (median/p95/min/max/n), parallel 1/2/4, clone-only 8, baseline, decisions on `ipfilter`, lease, the per-node clone limit, where the serial is visible, the serial length limit, deviations. Update the roadmap (S1 — implemented, branch `s1-impl`).
- [ ] **Step 6:** superpowers:verification-before-completion: `go test`, `golangci-lint`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `preflight` green, `setup.sh status` green, Ilia's guests in the same status. Commit, `git push -u origin s1-impl`.

## Findings (filled in task 3)

Checked with the token `sbx@pve!poc` on VM 598 (2026-10-29):

- **Permissions.** The set of §4.1 was enough for create, PUT config with a ready volume, firewall, ipset, start/stop, QGA exec, delete, and reading IPAM (`GET /cluster/sdn/ipams/pve/status`, `PVESDNUser` on `/sdn/zones/sbx` is enough). Limitations: `tags` in `POST /qemu` gives `403 /vms/N VM.Config.Options` in the worker (the tag check goes against `/vms/N` without the pool) — `tags=sbx` is set by a separate `PUT config` together with the disks. Only root can set `vmgenid`; Proxmox itself generates a new `vmgenid` and `smbios1.uuid` on create. After a VM is deleted the token gets `403`, not `404` (the VM is outside the pool) — check for a missing config via `sbx-node inventory vmfiles` and `/cluster/resources`.
- **IPAM.** The IP is allocated on `POST /qemu` (before start), MAC → IP via `mac-cache.json`. On delete the IPAM entry and mac-cache are removed.
- **ipfilter.** With `ipfilter=1` and an empty `ipfilter-net0`, all of the guest's IPv4 except DHCP is dropped. PVE creates the IPSet `guest-ipam-<vmid>` but does not put it into ipfilter. Working scheme: after create read the IP from IPAM and write it into the VM's ipset `ipfilter-net0` before start. Verified: DHCP, DNS, HTTPS work.
- **DHCP lease.** Range `infinite`: the lease is unlimited, no renewal is needed. The rule `-p udp --sport 68 --dport 67` in `tapN-OUT` stands before `GROUP-sbx-egress-OUT` (and before ipfilter), the reply `--sport 67 --dport 68` in `tapN-IN` before the group.
- **Lease on delete.** Proxmox removes neither the lease (dnsmasq file) nor the `MAC,IP` row in `/etc/dnsmasq.d/sbx/ethers`: `PVE::Network::SDN::Dhcp::remove_mapping` is never called, and `del_ip_mapping` is not implemented in the dnsmasq plugin. PVE drops ethers rows without a MAC in mac-cache only on the next `add_ip_mapping` (start of any VM). `sbx-node dhcp.release` is needed: `dhcp_release` + removal of the ethers row under `flock` (as PVE does) only for a MAC that is not in mac-cache, and `reload dnsmasq@sbx`.
- **smbios1.** The PVE limit is 512 characters for the whole string (`value may only be 512 characters long`): a serial up to ~340 bytes raw. The S2 payload is 85 bytes (116 base64, 174 characters per string). A 300-byte serial is fully visible in the guest.
- **QGA exec.** The `exec-status` output contains control characters; parse tolerantly.
- **Template 599 (urgent fix on master's signal).** 9000 is Ilia's personal dev template (Tailscale, keys, tokens, Chrome profile, Claude/Codex). The first build of 599 booted it with `tailscaled` (state empty `{}`, did not join the tailnet: no new nodes). 599 was rebuilt offline (`infra/pve/template-sanitize.sh`, chroot on the host, no boot). `cloud-init clean --machine-id` in the chroot deletes `/etc/machine-id` — without the file networkd does not bring up DHCP; we write `uninitialized`.
