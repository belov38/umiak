# S1. Proxmox foundation: specification

Status: agreed (the master session on Ilia's behalf), 2026-10-29. Implemented on branch `s1-impl`, results in §11. Architecture: `docs/architecture.md` (§5 storage, §7 network, §10 deployment). Roadmap: `docs/roadmap.md`. Supplemented with the MVP recommendations R6 (an entry in §12 only) (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29).

The mark **[S1 decision]** means a decision made in this session without separate agreement with Ilia; it can be revisited during planning if there is a reason.

## 1. Why

This is the bottom layer of the platform: how to get an isolated VM from a template on Proxmox, take a snapshot of a running VM, fork from it, and delete everything without a trace. Plus numbers: how much this costs in time on real hardware. The worker (S6), templates (S5), and Windows (S9) are built on this layer.

## 2. Goals, non-goals, anti-goals

**Goals**
- The host `pve` is prepared for the PoC: a user and token with minimal rights, a pool, a sandbox SDN network with SNAT and DHCP, a firewall.
- The `lvmthin` storage driver behind the interface from architecture §5.
- Machine primitives: create from a template, fork from a snapshot, start/stop, delete; our own VMID and MAC allocator.
- The node operation executor `umiak-node` (Go).
- The `umiak-bench` stand: one command checks everything and prints measurements.

**Non-goals (other areas)**
- The guest agent, identity change inside the guest (S3). In S1 quiesce is done through the QEMU guest agent.
- The tunnel protocol and gateway (S2, S4). From S2 only the SMBIOS interface (§6.4) comes into S1.
- State machines, warm pool, Postgres (S6).
- The template build pipeline (S5). Template 599 in S1 is built manually per the runbook.
- Windows, except for the disk layout (`efidisk0`, `tpmstate0`) in the driver interface (S9).
- The `umiak-node` daemon with mTLS (later, the same interface).

**Anti-goals (a failure even if everything works)**
- Any change to existing VMs, LXCs, `vmbr0`, templates 9000/9001, their LVs, and network access to the host and guests.
- A sandbox sees the LAN, the host, or another sandbox (over IPv4 or IPv6).
- After delete, LVs, configs, lease entries, or occupied VMIDs remain.
- Secrets (token, SSH key, the bootstrap secret from SMBIOS) end up in the repository or in our state.

## 3. Constraints

- Host `pve`: Proxmox VE 9.2.21, a single node, kernel 7.0. LAN `192.168.68.0/24`, host `192.168.68.116`, Tailscale `100.64.10.2` (`pve.tail0000.ts.net`). Ilia's live VMs and LXCs are on the host.
- PoC: VMIDs from 500 (range 500–599, configurable), the RAM of all sandboxes together no more than 8 GB, storage `local-lvm` (VG `pve`, thin pool `data`, a QLC disk Crucial P310).
- Template 9000 (`ubuntu-2604-dev-tpl`) is only read: one thin snapshot of its disk for our template 599.
- Tools via mise (`mise.toml`): Go 1.27.3, Node 26.13.0, pnpm 12.16.1. Dependencies are the latest stable versions at the time of implementation, to be checked (`npm view`, `go list -m -versions`), not taken from memory.
- In production (`docs/architecture.md` §10) `packages/pve` runs in the `worker` pod in Kubernetes: the PVE token and the `umiak-node` SSH key come from a Kubernetes Secret, the worker reaches `:8006` and the nodes' SSH from the cluster network. Therefore config and secrets are given through env and file paths; `~/.config/umiak/` is only the default for the Mac in the PoC.

## 4. Host preparation (runbook)

Everything below is agreed (Ilia gave general consent to `pve` changes for the PoC; the details were approved by the master session). Executed as root via `ssh pve` only after the specification is agreed. The runbook is written as an idempotent script `infra/pve/setup.sh` with a `--dry-run` mode and separate steps; each step has a check and a rollback. Running the runbook is part of the implementation and requires an explicit "yes" in the implementation thread; before step 4.4 (firewall) the implementer stops and waits for separate confirmation [S1 decision]. All created objects are marked with the comment `umiak S1 PoC`.

### 4.1 User, token, pool

- User `umiak@pve` (no password), token `umiak@pve!dev` with `privsep=1`.
- Role `UmiakPoC`: `VM.Allocate`, `VM.Audit`, `VM.Clone`, `VM.Config.CDROM`, `VM.Config.CPU`, `VM.Config.Cloudinit`, `VM.Config.Disk`, `VM.Config.HWType`, `VM.Config.Memory`, `VM.Config.Network`, `VM.Config.Options`, `VM.PowerMgmt`, `VM.GuestAgent.Audit`, `VM.GuestAgent.FileRead`, `VM.GuestAgent.FileWrite`, `VM.GuestAgent.FileSystemMgmt`, `VM.GuestAgent.Unrestricted`, `Pool.Audit`.
- Pool `sandbox`.
- ACL (on the user and on the token, because of privsep):
  - `/pool/umiak` → `UmiakPoC`;
  - `/storage/local-lvm` → `PVEDatastoreUser` (`Datastore.AllocateSpace`, `Datastore.Audit`);
  - `/sdn/zones/umiak` → `PVESDNUser` (`SDN.Use`, `SDN.Audit`); if reading IPAM requires another path, add `SDN.Audit` on it.
- The final list of rights is confirmed by `umiak-bench preflight`: every stand operation is executed with the token, a permission denial is a red check. Add rights only on an actual denial and record them in this section.
- Rollback: `pveum user delete umiak@pve`, `pveum role delete UmiakPoC`, `pveum pool delete sandbox` (after removing the VMs from the pool).
- Implementation result: the set of rights above was enough, no additional rights were added. Token limitations: `tags` in `POST /qemu` gives 403 (the tag check goes against `/vms/N` without the pool), so `tags=umiak` is set together with the disks via `PUT config`; `vmgenid` can only be set by root, Proxmox generates a new one itself; after a VM is deleted the token gets 403, not 404.

### 4.2 dnsmasq and IPv4 forwarding

- `apt install dnsmasq`, then `systemctl disable --now dnsmasq` (the system service is not needed; SDN runs its own instance per zone). If `dhcp_release` is needed (§6.3), the package `dnsmasq-utils` is covered by the same agreement.
- `/etc/sysctl.d/90-umiak-poc.conf`:
  ```
  # umiak S1 PoC: IPv4 forwarding for SNAT of SDN zone "umiak". Remove this file to revert.
  net.ipv4.ip_forward = 1
  ```
  `sysctl --system`. IPv6 forwarding stays 0.
- Rollback: delete the file, `sysctl -w net.ipv4.ip_forward=0`; `apt purge dnsmasq`.

### 4.3 SDN

- Zone `umiak`: type `simple`, IPAM `pve`, DHCP `dnsmasq`.
- VNet `umiak0` in the zone `umiak`, `isolate-ports=1`.
- Subnet `10.88.0.0/24`: gateway `10.88.0.1`, SNAT enabled, DHCP range `10.88.0.100–10.88.0.250`, DNS for DHCP `1.1.1.1` (and `9.9.9.9` if the field accepts a list). If DNS cannot be set through DHCP, the VM gets `nameserver` through cloud-init. A sandbox does not reach the host even for DNS. No IPv6 subnet.
- `pvesh set /cluster/sdn` (apply). Check: the bridge `umiak0` is up, the SNAT rule is present, the dnsmasq instance for `umiak` is running, `vmbr0` has not changed.
- The subnet `10.88.0.0/24` was chosen so as not to overlap with the LAN, Tailscale `100.64/10`, and Docker `172.17/16` [S1 decision].
- Rollback: delete the subnet, vnet, zone, apply.

### 4.4 Firewall

Backend: the regular `pve-firewall` (iptables). We do not enable `proxmox-firewall` (nftables) [S1 decision].

`/etc/pve/firewall/cluster.fw` (target content):

```
[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: ACCEPT

[IPSET umiak-gateway] # umiak S1 PoC: allowed tunnel endpoint(s); empty in S1

[IPSET umiak-deny] # umiak S1 PoC: private and special ranges
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
100.64.0.0/10
169.254.0.0/16
224.0.0.0/4

[IPSET umiak-deny-public] # umiak S1 PoC: own public egress IPs (hairpin NAT), empty in the PoC

[group umiak-egress] # umiak S1 PoC
OUT DROP -dest +umiak-deny-public
OUT ACCEPT -dest +umiak-gateway -p tcp -dport 443
OUT DROP -dest +umiak-deny
# plus: drop all outbound IPv6 (NDP stays allowed by the ndp option)
```

`/etc/pve/nodes/pve/host.fw`:

```
[OPTIONS]
enable: 0
```

The host is not filtered. The host is protected from sandboxes by rules on the sandboxes' own NICs (the VM's outgoing traffic is filtered before it reaches the host).

The firewall of each sandbox (via the API on create/fork):
- options: `enable=1`, `policy_in=DROP`, `policy_out=ACCEPT`, `dhcp=1`, `ndp=1`, `radv=0`, `macfilter=1`, `ipfilter=1`;
- rules: `GROUP umiak-egress -i net0`.
- `ipfilter` requires `ipfilter-net0` to contain an IP from IPAM (or the guest's IPAM-generated IPSet, if PVE provides it). If this turns out to be fragile, in S1 it is acceptable to keep only `macfilter`: the egress rules filter by destination address, and spoofing the source does not give access to the LAN. Record the decision in the results section.
- Outgoing IPv6 is closed entirely (except NDP): otherwise the VM could reach the host's link-local address on `umiak0`, and the host's sshd listens on `::`. The exact form of the rule (an IPSet `::/0` or a separate rule) is at the builder's discretion, verified by the stand.

IPSet `umiak-deny-public` — our own public egress addresses (protection against hairpin NAT to forwarded ports and the router). **Empty in the PoC** (Ilia's decision, 2026-10-29): the platform works locally, tests go through Tailscale, no external IP is used. Filled in when going to production together with the choice of cluster (S12).
- The list is set by the runbook config (`UMIAK_DENY_PUBLIC_IPS`, empty by default); updating the IPSet is a separate runbook step.
- If the list is not empty, the stand checks from inside a VM that TCP 22, 80, 443 on each of its addresses are closed.
- If the address of the tunnel ingress ever coincides with an address from this list, a targeted exception before DROP is needed; this is solved together with S4/S12.

IPSet `umiak-gateway` — a place for the future address of the ingress `tunnel.<domain>:443` in Kubernetes (architecture §10). In S1 it is empty.

Dev control plane (2026-10-30): CT 590 on `pve` with a compose stack, its LAN address `192.168.68.90` was added to `umiak-gateway` by the step `infra/pve/setup.sh cp-gateway` (rollback `revert cp-gateway`). The group rule did not change: a sandbox reaches the CT only on tcp/443. Details: `infra/dev-cp/README.md`.

**Safe enabling (the main firewall switch is the riskiest change):**

1. Write `host.fw` with `enable: 0`. Write the IPSet and the group in `cluster.fw` with `enable: 0`. Check the syntax with `pve-firewall compile`.
2. Take the "before world": the list of running guests and their LAN IPs (`ip neigh` on the host by the MAC from the guest configs).
3. Arm an automatic rollback: `systemd-run --unit=umiak-fw-rollback --on-active=5min pvesh set /cluster/firewall/options --enable 0`.
4. `pvesh set /cluster/firewall/options --enable 1`. Wait 30 s (the `pve-firewall` refresh cycle).
5. Check from the Mac: `ssh pve true` (Tailscale), `ssh pve-lan true` (LAN), HTTPS `:8006` on both addresses, ping each running guest by the LAN IP from step 2; on the host `pve-firewall status` and no rules on the tap/veth of existing guests.
6. Only if everything is green: `systemctl stop umiak-fw-rollback.timer`. Otherwise wait for the rollback or trigger it immediately.

Manual rollback: `pvesh set /cluster/firewall/options --enable 0`; delete the group `umiak-egress`, the IPSets `umiak-deny-public`, `umiak-deny`, and `umiak-gateway`; delete `host.fw`.

Implementation result (`infra/pve/setup.sh fw`):
- `nf_conntrack_allow_invalid: 1` was added to `host.fw`. After the firewall is enabled, `bridge-nf-call-iptables=1`, and all `vmbr0` bridge traffic goes through `PVEFW-FORWARD`, where by default `ctstate INVALID -j DROP` stands. The host is still not filtered; the sandbox rules work as before.
- IPv6 is closed by the IPSet `umiak-deny6` of `::/1` and `8000::/1` (`ipset hash:net` does not accept `/0`) and the rule `OUT DROP -dest +umiak-deny6` in the group.
- When enabling, the operator's Mac was outside the host's LAN, so the checks went over Tailscale: `ssh pve`, HTTPS `:8006`, ping of 7 guests by their Tailscale addresses (their traffic goes through the bridge `vmbr0`) and ping of 4 guests from the host. After the Mac moved to the LAN, `ssh pve-lan`, HTTPS `:8006` on the LAN IP, and ping of guests 100, 102, 103, 109 from the LAN were checked — everything works.

### 4.5 SSH key for `umiak-node`

- On the Mac a separate key `~/.config/umiak/umiak-node_ed25519`, comment `umiak S1 umiak-node`.
- On `pve` in `/root/.ssh/authorized_keys`: `restrict,command="/usr/local/bin/umiak-node --stdio" ssh-ed25519 … umiak S1 umiak-node` (no pty, no forwarding).
- The client pins the host key of `pve` (its own known_hosts file).
- Rollback: delete the line from `authorized_keys`, delete `/usr/local/bin/umiak-node` and `/etc/umiak-node.toml`.

### 4.6 Template 599 `umiak-ubuntu-poc`

Built once as root (a runbook step, not with the token):

1. `lvcreate -s -kn -n vm-599-disk-0 --addtag umiak-tpl pve/base-9000-disk-0`. `qm clone` is not used so that Proxmox does not link 599 to 9000; in dm-thin a snapshot does not depend on the source volume.
2. `qm create 599` in the pool `umiak`: hardware like 9000 (q35, `cpu host`, `virtio-scsi-single`, `scsi0` with `discard=on,iothread=1,ssd=1`, `agent=1`, `serial0`, `vga std`), 2 vCPU / 2 GB, `net0` in `umiak0` with the firewall, a cloud-init disk, `ipconfig0=ip=dhcp`, `cicustom vendor=local:snippets/umiak-tpl-vendor.yaml` (a new snippet installs and enables `qemu-guest-agent`).
3. Boot, wait for the QGA to answer. Inside: `cloud-init clean --logs --machine-id`, `apt clean`, `fstrim -a`. Shut down.
4. Remove `cicustom`, `qm template 599`. The LV becomes `base-599-disk-0`, the tag `umiak-tpl` is kept.

The tag `umiak-tpl` is not equal to `umiak`, so `umiak-node` cannot delete the template's LV. Template 9000 and its LV are not changed. Rollback: `qm destroy 599`, delete the snippet.

**Deviation during implementation (on master's security signal).** 9000 is Ilia's personal dev template (user `ib`, Tailscale, keys, Claude/Codex tokens, a Chrome profile, snapd, docker). The first build of 599 per steps 2–3 booted it with `tailscaled` (the state was empty `{}`, the node did not join the tailnet, there are no new nodes in the tailnet). Therefore 599 is built **offline, without booting** (`infra/pve/setup.sh template` + `infra/pve/template-sanitize.sh`):
1. A thin snapshot `base-9000-disk-0` → `vm-599-disk-0` (tag `umiak-tpl`); the root partition is attached on the host via dm-linear (not loop) so that discard reaches the thin LV.
2. In a chroot: purge all `tailscale*` packages (`tailscale`, `tailscale-archive-keyring`) and their state; deletion of the user `ib` with `/home/ib`, its sudoers, `/opt/agent-desktop`, everything in `/root` except `.bashrc`/`.profile`, crontab, logs and journal; `cloud-init clean --logs --machine-id --seed`, `/etc/machine-id` = `uninitialized` (in a chroot cloud-init deletes the file, and without it networkd does not get DHCP), deletion of SSH host keys; the netplan file with the MAC of the build VM replaced by a fallback file `en*` + DHCP; `systemd-networkd-wait-online`, `unattended-upgrades`, `apt-daily*.timer` masked. `qemu-guest-agent` is already in 9000, no snippet is needed.
3. `fstrim` (33.5 GiB), then zeroing the free blocks of the filesystem that still contain data (dm-thin frees only whole chunks of 64 KiB): 6297 blocks. Check: 64 bytes from a deleted personal file (stored only on the host, not printed) are not found on the raw partition.
4. `qm create 599` without cicustom and with `ciupgrade 0`, the disk, the firewall, `qm template 599`.

599 is the PoC template; S5 will replace it with a clean Ubuntu 26.04 minimal build.


### 4.7 VMID layout on `pve`

Decision of the master session, 2026-10-30:

| VMID | What |
|---|---|
| 500–589 | sandboxes: the range of the worker allocator, `umiak-bench`, and `deploy/compose` (`UMIAK_VMID_RANGE`, `vmidMin`/`vmidMax` in topology) |
| 590–596 | dev infrastructure, not part of allocation; CT 590 is the dev control plane (`infra/dev-cp`) |
| 597–599 | templates (`umiak-tpl`, `UMIAK_TEMPLATE_VMID_RANGE`): Linux (S5) — 597 and 599 (599 is still the PoC template), Windows (S9) — 598; the slots are set by the recipe (`vmids`) |

`umiak-node` has the same layout: `vmidMin`/`vmidMax` 500–589 and `templateVmidMin`/`templateVmidMax` 597–599; it clones only from the volumes `base-<slot>-*` with the tag `umiak-tpl`, 590–596 are in neither range. The token sees only the VMs of its pool, so a guest outside the pool within the sandbox range (like CT 590 before this layout) is invisible to the allocator; the `umiak-bench` preflight catches such cases.

## 5. How operations are executed

| What | Through what |
|---|---|
| VM config, start/stop/shutdown, delete, pool | PVE API (token) |
| QEMU guest agent: ping, exec, `network-get-interfaces`, fsfreeze | PVE API (token) |
| VM firewall (options, rules, ipset) | PVE API (token) |
| IPAM (read) | PVE API (token) |
| `lvcreate -s`, `lvremove`, `lvs`, thin pool usage, the dnsmasq lease file, host inventory | `umiak-node` over SSH |
| Host preparation and template 599 | runbook as root, once |

Why not only the PVE API: on LVM-thin Proxmox makes a linked clone only from a template, while a fork from a snapshot of a running VM through the API is a full clone (copying the whole disk). Why not `qm clone` for create too: lock contention on parallel clones and the `/cluster/nextid` race (research/05 §1.3); the stand compares our path with `qm clone` by numbers (§7.3).

### 5.1 `umiak-node` (`services/node-agent`, Go)

- Go module: `go 1.27`, `toolchain go1.27.3`. The binary `umiak-node`, `GOOS=linux GOARCH=amd64`, installed to `/usr/local/bin/umiak-node` by a runbook step.
- Mode `--stdio`: one request per SSH call (or several exec channels over one SSH connection): JSON on stdin `{op, args, requestId}`, JSON on stdout `{ok, result | error}`, a non-zero exit code on error. Each operation is written to the journal (`requestId`, op, arguments, result).
- Config `/etc/umiak-node.toml`: VG (`pve`), thin pool (`data`), the sandbox VMID range (`500–589`), template slots (`597–599`), the template VMID (`599`), the SDN zone name (`umiak`).
- Whitelist of operations:

| op | What it does | Protection |
|---|---|---|
| `version` | binary version and config | — |
| `lv.snapshot` | a batch of `lvcreate -s` (`origin`, `name`, `tags`, `activationSkip`); on error it removes what this call created | origin only `base-<template slot>-*` with the tag `umiak-tpl`, `umiak-snap-*`, `vm-<id in range>-*`; name only `vm-<id in range>-disk-<k>` or `umiak-snap-*` |
| `lv.remove` | `lvremove` by names | only LVs with the tag `umiak` |
| `lv.list` | LVs by tags | read only |
| `lv.tagTemplate` (S5) | the tag `umiak-tpl` on `base-<vmid>-disk-N` | only a template slot, a VM config with `template: 1` and the tag `umiak-tpl` |
| `lv.scan`, `lv.usage` (S5) | counting patterns on the disk, LV fill; an inactive LV is activated for the duration of the read | only `base-<slot>-*` with the tag `umiak-tpl` and `vm-<id in range>-disk-N` with the tags `umiak`, `umiak-vm-<id>` |
| `pool.usage` | data% and metadata% of the thin pool, the size and occupancy of our LVs | read only |
| `dhcp.leases` | the content of the dnsmasq lease file of the zone `umiak` | read only |
| `dhcp.release` | release a lease by MAC (if needed, §6.3) | only a MAC from the range of our allocator |
| `inventory` | presence of a given string in the journal and task log (yes/no only; the string itself is not logged), `qm list` (without VMs in the template slots 597–599: builds and templates are ours), `pct list`, all LVs without the tags `umiak` and `umiak-tpl` and not volumes of template slots (`vm-`/`base-<slot>-…`, during a build they have no tag yet) (name, size, attributes), hashes of `/etc/pve/sdn/*`, `cluster.fw`, `host.fw`, `/etc/network/interfaces*`, forwarding sysctl values, the host's link-local address on `umiak0` | read only |

- Tests: unit tests for request parsing, the whitelist, and protection by tags and names (LVM behind an interface, a fake in tests). `golangci-lint` check.
- Later the same code becomes a daemon with the same set of operations (S12). LVM itself locks the VG metadata, so parallel `umiak-node` calls and Proxmox operations on the same VG are safe; our names are unique thanks to the allocator.

## 6. `packages/pve` (TypeScript)

The package is used by the stand in the PoC and by `apps/worker` in S6. Contents: the PVE API client, the `umiak-node` client, the `lvmthin` driver, machine primitives, the allocator.

### 6.1 Configuration

Everything is injected through env and file paths (in Kubernetes — a Secret mounted as files). Defaults for the Mac:

| Variable | Purpose | PoC default |
|---|---|---|
| `UMIAK_PVE_URL` | Proxmox API | `https://pve:8006` (your own Proxmox address via env, in compose — `deploy/compose/.env`) |
| `UMIAK_PVE_TOKEN_ID` | token id | `umiak@pve!dev` |
| `UMIAK_PVE_TOKEN_SECRET_FILE` | token secret | `~/.config/umiak/pve-token` (mode 600) |
| `UMIAK_PVE_CA_FILE` | the host's CA (`pve-root-ca.pem`), TLS is verified | `~/.config/umiak/pve-root-ca.pem` |
| `UMIAK_PVE_TLS_NAME` | the name against which the `:8006` certificate is verified | `pve` |
| `UMIAK_NODE_SSH_HOST`, `UMIAK_NODE_SSH_KEY_FILE`, `UMIAK_NODE_SSH_KNOWN_HOSTS` | access to `umiak-node` | `pve`, `~/.config/umiak/umiak-node_ed25519`, `~/.config/umiak/known_hosts` |
| `UMIAK_VMID_RANGE` | the sandbox VMID range | `500-589` (layout §4.7) |
| `UMIAK_TEMPLATE_VMID_RANGE` | the boundary of template slots (`umiak-tpl`); the recipe picks the slots | `597-599` |
| `UMIAK_CLUSTER_ID` | cluster number for the MAC (1 byte) | `1` |
| `UMIAK_STATE_DB` | the allocator's SQLite (PoC) | `~/.local/state/umiak/poc.db` |
| `UMIAK_TEMPLATE_VMID` | the template | `599` |

The `pveproxy` certificate is issued by the host's CA for `pve`, `pve.local`, `192.168.68.116`, and has no `*.ts.net` name. Therefore the client connects by `UMIAK_PVE_URL` and verifies the certificate against `UMIAK_PVE_CA_FILE` and the name `UMIAK_PVE_TLS_NAME` (SNI and name verification). The certificate on the host is not changed [S1 decision]. The same mechanism suits the worker in Kubernetes, whatever path it uses to reach `:8006`.

The builder picks the libraries (HTTP client, SSH client, test framework); versions are the latest stable at the time of implementation.

### 6.2 Storage driver

The interface from architecture §5, a second driver (ZFS, Ceph) later behind the same one:

```ts
interface StorageDriver {
  cloneFromTemplate(tpl: TemplateRef, target: VmTarget): Promise<DiskSet>
  snapshot(m: MachineRef, hook: QuiesceHook): Promise<SnapshotRef>
  cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet>
  delete(ref: MachineDisksRef | SnapshotRef): Promise<void>
  usage(node: NodeRef): Promise<StorageUsage>
}

interface QuiesceHook {
  freeze(): Promise<void>
  thaw(): Promise<void>
}
```

- `DiskSet`: slots `scsi0`, `efidisk0`, `tpmstate0` (the last two for Windows; in S1 only `scsi0` is checked) with volid, size, and disk options (`discard`, `iothread`, `ssd`, `efitype`, `version`, etc.). The cloud-init disk is not part of `DiskSet`: Proxmox creates it for every VM.
- **`cloneFromTemplate`**: for each template disk `lvcreate -s -kn -n vm-<vmid>-disk-<k> --addtag umiak --addtag umiak-vm-<vmid> pve/base-599-disk-<k>`. The name `vm-N-…` is so that Proxmox considers the volume as belonging to VM N (permissions, purge).
- **`snapshot`** of a running machine:
  1. `hook.freeze()` (in S1: `agent/fsfreeze-freeze` through the PVE API).
  2. If there is more than one disk: a vCPU pause (`status/suspend` without `todisk`) for consistency of all disks.
  3. One `umiak-node lv.snapshot` call: `lvcreate -s -ky -n umiak-snap-<snapId>-<slot> --addtag umiak --addtag umiak-snap-<snapId>` for all disks.
  4. `status/resume` if there was a pause. `hook.thaw()` in `finally`, with retries.
  - Freeze budget 10 s: if exceeded, the snapshot is cancelled, the created LVs are deleted, an error. If `thaw` failed after retries, the machine is marked "needs attention" (an error to the caller, in the PoC a red check).
  - Without a QGA response the snapshot is forbidden (an error), the crash-consistent mode only with an explicit flag.
  - For a stopped machine freeze and pause are skipped.
  - Snapshot metadata: id, source VM, slots with LV names and disk options, the source's hardware config (without `smbios1`, `vmgenid`, the `net0` MAC, `name`). Stored in our state; key fields are duplicated by LV tags so that `cleanup` finds snapshots without state.
  - Names `umiak-snap-*` are not recognized by Proxmox and are ignored.
- **`cloneFromSnapshot`**: `lvcreate -s -kn -n vm-<new>-disk-<k> --addtag umiak --addtag umiak-vm-<new>` from `umiak-snap-*`. In dm-thin snapshots are independent: the original and the snapshot are deleted in any order.
- **`delete`**: `lvremove` by the tag `umiak-vm-N` or `umiak-snap-<id>`.
- **`usage`**: pool data% and metadata%, the volume of our LVs. Create and snapshot are forbidden at data > 80% or metadata > 70% [S1 decision]; automatic pool extension on the host is off (`thin_pool_autoextend_threshold=100`).

### 6.3 Machine primitives

- **create(template, size, opts)**:
  1. Allocate a VMID and MAC (§6.5).
  2. `POST /nodes/pve/qemu` without disks: `vmid`, `pool=umiak`, `name=umiak-<vmid>`, `tags=umiak`; the hardware is copied from the template config by a whitelist of keys (`machine`, `cpu`, `bios`, `ostype`, `scsihw`, `agent`, `serial0`, `vga`, `tablet`); the default size 2 vCPU / 2 GB, `balloon=0`; `net0=virtio=<MAC>,bridge=umiak0,firewall=1`; `ide2=local-lvm:cloudinit`, `ipconfig0=ip=dhcp`, `ciuser=umiak` without keys and a password (in S1 access to the guest is only through QGA); `ciupgrade=0` (the Proxmox default is 1: cloud-init does `apt upgrade` on first boot and after ~2 minutes restarts `qemu-guest-agent`, which forgets the PIDs of running execs); a new `vmgenid`; `smbios1` from the caller or a new one from Proxmox (§6.4).
  3. `driver.cloneFromTemplate`.
  4. `PUT config`: attach the disks with options, `boot=order=scsi0`.
  5. Firewall: options and `GROUP umiak-egress` (§4.4).

  The order "first the VM in the pool, then the disks" works around the permissions problem: by the time the volume is attached the VM is already in the pool and the token has `VM.Config.Disk` on it.
- **fork(snapshot, size?, opts)**: the same path, disks from `cloneFromSnapshot`, hardware from the snapshot metadata. New VMID, MAC, `vmgenid`; `smbios1` from the caller or a new one. `smbios1` and `vmgenid` are never copied from the snapshot and the source VM.
- **start / shutdown(timeout) / stop** — via the API, waiting for the task by UPID.
- **waitReady(timeout)** — polling `agent/ping`; the IP from `agent/network-get-interfaces` (IPv4 in `10.88.0.0/24`).
- **delete(vmid)**:
  1. `status/stop` (hard, a sandbox is disposable).
  2. `umiak-node dhcp.release` — before destroy, while the IP, the ethers row, and the lease still belong to this VM: after destroy the IP in IPAM is free, a new VM may take it, and dnsmasq moves the lease to its MAC.
  3. `DELETE /nodes/pve/qemu/<vmid>?purge=1&destroy-unreferenced-disks=1`, wait for the task.
  4. `umiak-node lv.remove` of the remaining LVs with the tag `umiak-vm-<vmid>`.
  5. Check: no config (404), no VM firewall file, no IPAM entry with the MAC, no MAC in the lease file; a repeated `dhcp.release` removes the ethers row (the MAC is no longer in `mac-cache.json`).
  6. Release the VMID and MAC in the allocator. Only after a successful check; otherwise the entry stays in the state `releasing` and `cleanup` picks it up.
- **Owner check** (S6 addition, 2026-10-30). `start`, `stop`, `shutdown`, and `delete` accept an optional `expectedOwner` (the lease owner id, in S6 `machineId`; `delete` also accepts `null` — a VM without a lease). Right before the action the VMID lease is read: if it does not belong to this owner (for `start` also if it is `releasing`), an `OwnerMismatchError` is thrown (code `owner_mismatch`, a retry does not help) and Proxmox is not touched; a delete that has neither the owner's lease nor a VM does nothing. A delete of a VMID without a lease (an orphan VM) before step 1 occupies the VMID with a `releasing` row without an owner (`reserveForDelete`) so that create does not take it in the middle of the delete; step 6 deletes only the `releasing` row of its owner (`null` for such a reservation). Without `expectedOwner` the behavior is as before. The create/fork rollback runs under the `powerLock` wrapper if the caller passed one (S6 serializes node power under it, S6 §15.1).
- The limit of parallel clones per node is configurable (default 4) [S1 decision]; the stand provides data for the choice.

### 6.4 SMBIOS (the interface for S2)

- `create` and `fork` accept `smbios1` from the caller: at minimum `uuid` and `serial`. The serial carries the base64 `machineId` and the bootstrap secret, written with `base64=1`. If nothing is passed, Proxmox generates values.
- A machine's identity is one-time: a VMID can be issued again after a verified delete, but `smbios1` and `vmgenid` never. A fork always gets a new identity.
- `smbios1` does not get into the snapshot metadata, the allocator state, our logs, or the stand's JSON.
- The format is set by S2 (`docs/specs/s2-tunnel-protocol.md` §5.2): `smbios1: uuid=<machineId>,serial=<base64("umiak1:" + machineId + ":" + base64url(BS))>,base64=1`. The bootstrap secret (BS) is reusable: valid for the whole lifetime of the machine, because the machine token lives only in agent memory, and after every restart of the agent or the VM the agent presents the BS again.
- Proxmox itself writes the parameters of a config change into the host's journal (`pvedaemon: <user> update VM N: -memory …`, verified on `pve`), and the VM config `/etc/pve/qemu-server/N.conf` is readable by anyone with `VM.Audit`. So the BS is visible in the journal and the config. This is accepted (option A): it falls under the assumption already accepted by Ilia that "Proxmox operators see the BS", the journal has the same audience. Measures:
  - `VM.Audit` on the pool `umiak` is held only by the platform token and root;
  - the node journal is read only by root and the group `adm` (checked in `preflight`);
  - the stand records where the serial is visible (config, journal, task log) and writes it to §11.
- The serial length limit in Proxmox/QEMU is checked by the stand (a test value of the size of the real S2 payload: base64 of machineId + 32 bytes of the secret).

### 6.5 VMID and MAC allocator

- State behind the `AllocatorStore` interface. In the PoC SQLite via the built-in `node:sqlite` (the file `UMIAK_STATE_DB`), in S6 Postgres.
- Table `vmid_lease`: `cluster`, `vmid`, `mac`, `state` (`reserved` / `active` / `releasing`), `purpose` (machine, template), `created_at`, `updated_at`. Uniqueness of `(cluster, vmid)` and `(cluster, mac)`.
- Allocation: the smallest VMID from `UMIAK_VMID_RANGE` that is not in the table, not in `/cluster/resources` (only pool VMs are visible, which is enough for our range), and not among the LVs `vm-<id>-*` (`umiak-node lv.list`/`inventory`). Inserting the row is the lock: on a uniqueness conflict the next one is taken. `/cluster/nextid` is not used.
- The MAC is deterministic: `02:<cluster>:<vmid, 4 bytes big-endian>`, for example `02:01:00:00:01:F4` for cluster 1 and VMID 500. A locally administered unicast, unique within the cluster; our L2 is local to the node, which is enough.
- VMID 599 is occupied by the template (`purpose=template`), not part of allocation. S5 templates get a VMID through `allocateTemplate(<recipe vmids>)` — the first free recipe slot inside `UMIAK_TEMPLATE_VMID_RANGE` (597–599), outside the sandbox range (§4.7); `UMIAK_TEMPLATE_VMID` is not issued.

## 7. The `umiak-bench` stand (`apps/bench`, TypeScript)

Run from the Mac through Tailscale. Uses `packages/pve`.

### 7.1 Commands

- `umiak-bench preflight` — read only: the node journal is read by nobody except root and `adm`; the token answers and has rights for every stand operation (checked with "empty" calls where possible), `umiak-node version`, `umiak0` and the firewall groups in place, `ip_forward=1`, IPv6 forwarding 0, the thin pool below thresholds, template 599 exists and is a template, no leftovers of previous runs (VMs in the pool other than 599, LVs with the tag `umiak`, allocator rows).
- `umiak-bench s1 [--runs 3] [--size 2g] [--parallel 1,2,4] [--clone-only 8] [--ram-cap 8g] [--no-baseline] [--keep]` — the full run. A table in stdout, JSON in `bench-results/s1-<timestamp>.json` (the directory is in `.gitignore`).
- `umiak-bench cleanup --all-sandbox-resources` — global cleanup after a failure: VMs in the pool `umiak` other than 599, LVs with the tag `umiak`, allocator rows, lease entries of our MACs. Requires an explicit flag since it deletes the resources of all runs. It does not touch template 599 and LVs with the tag `umiak-tpl`.

### 7.2 Scenario `s1`

0. `preflight`. "World before": `umiak-node inventory`.
1. Repeat N times (`--runs`, default 3):
   1. **Create A** with a test `smbios1` (a random uuid, a serial of the size of the S2 payload). Start, `waitReady`, IP.
   2. **Network from inside A** (QGA exec; TCP checks via `timeout 3 bash -c '</dev/tcp/<ip>/<port>'`, ping `-c1 -W2`):
      - works: `getent hosts example.com`; `curl -fsS --max-time 10 https://example.com`;
      - does not respond: ping and TCP 80 of `192.168.68.1`; TCP 22, 80, 443 of each address from `umiak-deny-public` (if the list is not empty); TCP `192.168.68.116:22`, `:8006`; TCP `100.64.10.2:22`, `:8006`; TCP `10.88.0.1:22`, `:8006`, `:53`;
      - IPv6: no global address, no IPv6 default route; ping6 and TCP `:22` to the host's link-local address on `umiak0` (from `inventory`) do not pass;
      - `/sys/class/dmi/id/product_serial` and `product_uuid` match those passed.
   3. Write `/root/marker1` (random content), `sync`. **Snapshot** A. Write `/root/marker2`.
   4. **Fork F** from the snapshot (its own test `smbios1`). Start, `waitReady`.
   5. **Checks of F**: `marker1` is present and matches in content, `marker2` is absent; the VMID, MAC, `vmgenid`, `smbios1` uuid and serial differ from A (by config and from inside the guest); the IPs of A and F differ; A ↔ F: ping and TCP `:22` do not pass in either direction.
   6. **Delete** A, F, and the snapshot. Check for the absence of traces (§6.3 delete, plus the LV `umiak-snap-<id>`).
2. **Parallelism**: for k from `--parallel` (default 1, 2, 4) k simultaneous `create → start → waitReady`, then delete all. By default 4 × 2 GB = exactly the limit.
3. **`--clone-only 8`**: 8 simultaneous creates without start (no RAM spent), then delete. The goal is contention for LVM and pmxcfs locks; errors and retries are recorded.
4. **Baseline** (turned off by `--no-baseline`): create via `POST /qemu/599/clone` (`full=0`, `pool=umiak`, the same VMID from the allocator), then the same config and firewall; N times, plus in parallel k=4 without start. Delete by the same path.
5. "World after": `umiak-node inventory`, comparison with the "world before". The difference must be empty.

Where the serial is visible: after create the stand looks for the test serial in the VM config (via the API), in the host journal, and in the task log (via `umiak-node inventory`, only the found/not found fact, without printing the value) and writes the result to the JSON and §11.

Safeguards: before every start the sum of `memory` of the running VMs in the pool plus the new VM ≤ `--ram-cap`, otherwise refusal. On any red check the stand still cleans up after itself (unless `--keep`) and exits with a non-zero code.

### 7.3 Metrics

For each: median, p95 (nearest-rank), min, max, number of measurements. With N=3, p95 equals max; the report notes this.

| Metric | What is measured |
|---|---|
| `clone` | from the allocate call to a VM ready to start (disks attached, firewall configured) |
| `clone_baseline` | the same via `qm clone` (API clone) |
| `boot` | from the start call to the first successful `agent/ping` |
| `ip` | from the start call to an IPv4 in `10.88.0.0/24` in `network-get-interfaces` |
| `snapshot` | the whole snapshot |
| `freeze` | from the start of freeze to the end of thaw |
| `fork_clone` | from the fork call to a VM ready to start |
| `fork` | from the fork call to the first `agent/ping` in the fork |
| `delete` | from the delete call to a successful check for the absence of traces |
| `parallel_k` | for each k: total time, the time of each VM, errors |
| `clone_only_8` | total time, the time of each create, errors and retries |

The JSON also contains: the Proxmox and kernel versions, storage, the template VMID, the VM size, the git commit, the start time, and all raw measurements.

## 8. Code structure

```
services/node-agent/      Go, umiak-node (go.mod: go 1.27, toolchain go1.27.3)
packages/pve/             TS: PVE client, umiak-node client, lvmthin driver, machine primitives, allocator
apps/bench/               TS: umiak-bench CLI
infra/pve/setup.sh        runbook (idempotent, --dry-run, step-by-step, revert per step)
infra/pve/snippets/       umiak-tpl-vendor.yaml
```

Tests: unit tests for `umiak-node` (whitelist, protection); unit tests for `packages/pve` with fake PVE API and `umiak-node` (call order of create/fork/delete, snapshot rollback on exceeding the budget, `thaw` in `finally`, the allocator on conflicts, fork does not copy `smbios1`/`vmgenid`). The integration test is the stand itself on `pve`.

## 9. Readiness criterion

`umiak-bench s1` on `pve` passes all checks:
1. Create from template 599: VMID ≥ 500 on `local-lvm` in `umiak0`, an IP by DHCP; from inside the VM DNS and HTTPS work, while `192.168.68.1`, the host (LAN, Tailscale, the address on `umiak0`, management ports), the IPv6 path to the host, and another sandbox are unreachable.
2. A snapshot of a running VM with quiesce through QGA fsfreeze and a fork: the fork has a new VMID, MAC, `vmgenid`, SMBIOS; the fork boots; `marker1` is present, `marker2` is absent.
3. Deleting the original, the fork, and the snapshot leaves no traces: VM configs, thin LVs, IPAM and lease entries, allocator rows. The stand checks this itself.
4. Measurements: clone, boot, snapshot (with freeze), fork, delete — N times (default 3), median and p95; parallel runs 1/2/4 within 8 GB; `--clone-only 8`; the `qm clone` baseline.
5. The comparison of the "world before" and "world after" (`qm list`, `pct list`, LVs outside our pool, SDN/firewall/network configs) is empty.

The numbers are recorded in §11.

## 10. Assumptions about other areas

- **S2 (tunnel):** the agent authenticates by the `smbios1` serial (the S2 §5.2 format, the BS is reusable for the whole lifetime of the machine). The IPSet `umiak-gateway` will get the address of the ingress `tunnel.<domain>:443`.
- **S3 (guest agent):** provides its own `QuiesceHook` implementation (Docker pause, fsfreeze, an auto-thaw watchdog) instead of QGA fsfreeze. Identity change after a fork (hostname, machine-id, SSH host keys) is its job; in S1 a fork keeps the source's machine-id.
- **S5 (templates):** the build pipeline will replace the manual template 599; the template must contain qemu-guest-agent and a cleaned machine-id.
- **S6 (worker):** uses `packages/pve` as is, substitutes a Postgres implementation of `AllocatorStore`, manages the per-node parallelism limits. Secrets from a Kubernetes Secret through the same variables (§6.1).
- **S9 (Windows):** the slots `efidisk0` and `tpmstate0` are already in `DiskSet`, the vCPU pause for consistency of several disks is already in `snapshot`. VSS through its own `QuiesceHook`. The consistency of the swtpm write into `tpmstate0` during a snapshot is to be checked there.
- **S12 (operations):** `umiak-node` as a daemon with mTLS, several nodes.

## 11. Results

> A historical report predating R1; current names are in `docs/specs/rename-umiak.md`.

The run of `sbx-bench s1` (defaults: 3 runs, 2 vCPU / 2 GB, parallel 1/2/4, `--clone-only 8`, baseline) on 2026-10-29 04:41–04:47 UTC, commit `ef2809c`. Proxmox VE 9.2.21, kernel 7.0.14-25-pve, `local-lvm` (VG `pve`, thin pool `data`, chunk 64 KiB, Crucial P310 QLC), template 599 (an offline-cleaned snapshot of 9000, see §4.6). **126/126 checks green**, the comparison of the "world before" and "world after" is empty. JSON: `bench-results/s1-2026-10-29T04-41-38-016Z.json` (not in git).

### Metrics, seconds

p95 is computed by nearest rank; at n = 3 it equals max.

| Metric | n | median | p95 | min | max |
|---|---|---|---|---|---|
| `clone` (allocate → ready to start) | 3 | 1.27 | 1.45 | 1.25 | 1.45 |
| `clone_baseline` (`POST /qemu/599/clone`, the same config and firewall) | 3 | 1.32 | 1.32 | 1.28 | 1.32 |
| `boot` (start → first `agent/ping`) | 3 | 11.04 | 11.14 | 10.99 | 11.14 |
| `ip` (start → IPv4 in `10.88.0.0/24`) | 3 | 11.24 | 11.34 | 11.10 | 11.34 |
| `snapshot` (whole, with QGA fsfreeze) | 3 | 1.08 | 1.08 | 0.98 | 1.08 |
| `freeze` (start of freeze → end of thaw) | 3 | 0.69 | 0.69 | 0.68 | 0.69 |
| `fork_clone` (fork → ready to start) | 3 | 1.20 | 1.47 | 1.16 | 1.47 |
| `fork` (fork → first `agent/ping`) | 3 | 11.74 | 12.50 | 11.33 | 12.50 |
| `delete` (up to the check for the absence of traces) | 6 | 1.95 | 1.98 | 1.94 | 1.98 |

`clone` ~1.3 s is made up of `POST /qemu` with waiting for the task, `lvcreate -s` through `sbx-node`, `PUT config`, the firewall (options, rule, ipset), and reading IPAM. Boot ~11 s is the Ubuntu template with the first cloud-init run; QGA answers before `cloud-final` finishes.

### Parallelism and contention

| Batch | Total, s | Per VM: median / max, s | Errors | API retries |
|---|---|---|---|---|
| k = 1, create → start → ready | 12.63 | 12.63 / 12.63 | 0 | 0 |
| k = 2 | 14.32 | 14.07 / 14.32 | 0 | 0 |
| k = 4 (4 × 2 GB = the 8 GB limit) | 15.89 | 15.46 / 15.89 | 0 | 0 |
| `--clone-only 8` (without start) | 3.00 | 2.25 / 3.00 | 0 | 0 |
| `qm clone` baseline, k = 4 without start | 2.44 | 2.06 / 2.44 | 0 | 0 |

- 8 simultaneous creates produced no errors and no retries due to locks (`can't lock file`): LVM serializes its metadata, our names are unique, `/cluster/nextid` is not used. The time of one create grows from 1.3 s to 2.2–3.0 s.
- **The default per-node parallel clone limit stays 4** [S1 decision confirmed]: at 4 the boot of one VM grows by ~25% (12.6 → 15.5 s), at 8 simultaneous clones without boot there is no lock contention. The stand does not apply the limit itself, in order to measure contention.
- **Comparison with `qm clone`:** on this Proxmox version a linked clone through the API is almost as fast (1.32 s vs 1.27 s) and without errors at k = 4. Our path is needed not for clone speed but for fork: from a snapshot of a running VM the API makes only a full clone, while `cloneFromSnapshot` takes 1.2 s. The stand did not measure `qm clone` contention at k = 8.

### Decisions on the "check during implementation" items (§12)

- **`ipfilter`: left on.** With `ipfilter=1` and an empty `ipfilter-net0`, all of the guest's IPv4 except DHCP is dropped; PVE creates the IPSet `guest-ipam-<vmid>` but does not put it into ipfilter. IPAM issues the IP already at `POST /qemu`, so create, after the firewall options, reads the IP from IPAM and puts it into the ipset `ipfilter-net0` before start. The stand checks DNS and HTTPS from A and F.
- **Lease on delete.** Proxmox removes neither the lease in the dnsmasq file nor the `MAC,IP` row in `/etc/dnsmasq.d/sbx/ethers`: `PVE::Network::SDN::Dhcp::remove_mapping` is never called, and `del_ip_mapping` is not implemented in the dnsmasq plugin. PVE drops rows without a MAC in IPAM only on the next start of any VM. Therefore delete calls `sbx-node dhcp.release` before destroy and once more at the check after it: `dhcp_release` and removal of the ethers row under `flock` (as PVE does), only for our MAC and only if it is no longer in `mac-cache.json`, then `reload dnsmasq@sbx`. Proxmox cleans IPAM and mac-cache itself.
- **Lease renewal through the firewall.** The subnet range is created as `infinite`: the lease is unlimited, there is no renewal. Besides, in `tapN-OUT` the rule `-p udp --sport 68 --dport 67` stands before ipfilter and before `GROUP-sbx-egress-OUT`, the reply `--sport 67 --dport 68` in `tapN-IN` before the group. The option `dhcp=1` likewise lets the DHCPv6 client through (546 → 547); dnsmasq has no IPv6 range.
- **`isolate-ports` with the firewall bridge.** The port `fwprNp0` in `sbx0` has `isolated on`. The stand checks ping and TCP 22 A ↔ F in both directions with a positive control (sshd listens locally in A and F).
- **Different IPs for A and F:** yes, IPAM binds the IP to the MAC (checked in every run).
- **`smbios1` length.** The PVE limit is 512 characters for the whole string (`value may only be 512 characters long`), i.e. a serial up to ~340 bytes raw. The S2 payload is 85 bytes (116 base64, 174 characters per string). A 300-byte serial is fully visible in the guest.
- **Where the serial is visible** (a test value of the size of the S2 payload; base64 and raw forms are searched): the VM config via the API — yes; the host journal — no (the serial is passed in `POST /qemu`, and pvedaemon logs parameters only for `update VM`); the task log — no; **the QEMU command line — yes**, in raw form (`/proc/<pid>/cmdline` on the host is readable by any local user). This is the same "host operators" audience accepted in §6.4; the host has no unprivileged users with a login shell (checked). For production (S12) this should be taken into account.
- **The node journal** is read only by root and `adm` (the groups `adm`, `systemd-journal`, `wheel` are empty; checked in preflight).

### Template 599 and Tailscale

See §4.6: 599 was built offline from a cleaned snapshot of 9000 (Tailscale removed, the user `ib` and their data removed, freed blocks discarded and checked on the raw partition). In every sandbox the stand checks that there is no `tailscaled` process and no `tailscale0` interface. 599 is the PoC template; S5 replaces it with a clean Ubuntu 26.04 minimal build.

### Deviations from the specification

- The runbook was executed without stopping before the firewall: master passed on Ilia's consent for the whole runbook (§4). The safe-enable procedure was followed; on a regression the script turns the firewall off at once, the timer stays as insurance.
- §4.2: only `sysctl -p` of its own file is applied, not `sysctl --system` (so as not to reapply others' values). `dnsmasq-utils` is installed right away (needed for `dhcp_release`).
- §4.3: the SDN apply (`ifreload -a`) reset `mcast_hash_max` of `vmbr0` from 4096 to 512 (the ifupdown2 default). The value was restored, the `sdn` step saves and restores it.
- §4.4: `nf_conntrack_allow_invalid: 1` in `host.fw`; IPv6 closed via `::/1` + `8000::/1`.
- §4.6: the template is built offline, without booting and without a snippet.
- §5.1: `dhcp.release` also removes the ethers row; `inventory search` accepts only a string of the S2 serial form (otherwise a restricted key would become an oracle over the journal, task log, and cmdline); `lv.snapshot` accepts `vm-*` as origin only with the tags `sbx` and `sbx-vm-N`; the `lvs` section in inventory does not include LVs with the tag `sbx-tpl` (our template), PVE JSON files are hashed in canonical form (Proxmox writes them with a random key order).
- §6.3: `tags=sbx` is set via `PUT config`, `vmgenid` is not passed (Proxmox generates it itself); on any error create rolls back via delete.
- §7.2: the baseline is implemented in the package (`Machines.createViaQmClone`) to use the same firewall step.

## 12. Risks and what to check during implementation

- Whether Proxmox deletes the dnsmasq lease when deleting a VM (otherwise `dhcp.release`).
- DHCP lease renewal through the sandbox firewall (`dhcp=1` must stand before the DROP on RFC1918). A run is shorter than half the lease term, so the stand does not catch it: check manually on one VM with a short lease term or by the iptables rules.
- `isolate-ports` together with the firewall bridge (`fwbr`/`fwpr`) for a VM with `firewall=1`. The A ↔ F isolation is duplicated by a DROP on `10.0.0.0/8`, the stand checks the outcome.
- `ipfilter` with an address from DHCP/IPAM (§4.4).
- Different IPs for A and F with the same machine-id (DHCP client-id). Expected yes: IPAM binds the IP to the MAC. The stand checks.
- The QLC disk of `local-lvm` understates the numbers under long writes; fine for a functional PoC, state the storage in the report.
- The `smbios1` serial length.
- Outgoing sandbox traffic goes to the internet from Ilia's home public IP. Accepted for the PoC; the egress policy for production is in S12/phase 2.
- **Writing ethers on parallel starts (a risk for S6).** Proxmox (`PVE::Network::SDN::Dhcp::Dnsmasq::add_ip_mapping`) takes a `flock` on the `ethers` file itself, writes `ethers.tmp`, and does a `rename` on top. A waiting writer may get the lock on an already replaced inode, and then two writers work at once: in an emulation with two concurrent Proxmox writers ~47% of additions were lost. `mac-cache.json` is read outside the lock. A lost static binding gives the VM a dynamic IP not from IPAM, and `ipfilter` blocks it. `umiak-node` checks the inode before its own `rename` and its change after it (`hostfs.ReplaceLocked`), but a Proxmox write that lands between the check and our `rename` is lost. **S6 serializes start and delete on a node** (at least the steps that write ethers). Delete order: stop → `dhcp.release` → destroy → trace check; release goes before destroy while the IP still belongs to the VM.
- **`cpu host` and nested KVM** (MVP rec. R6, master's decision 2026-10-29). Nested virtualization is not guaranteed in the MVP: `/dev/kvm` exists in the guest only if `kvm_intel`/`kvm_amd` is loaded on the host with `nested=1` (check on `pve`: `cat /sys/module/kvm_*/parameters/nested`); the S1 runbook and code do not change this, the S5 template only provides access (S5 §8.6, §10 item 19). `cpu host` stays while there is one node. Live migration between nodes with different CPUs is impossible with `cpu host`: such a cluster needs a named CPU model (for example `x86-64-v3`) in the template — a decision for S12 / phase 2.


### Windows snapshot fallback (S9 follow-ups, 2026-11-01)

For `ostype=win*` `Machines.snapshot` by default selects the crash-consistent
mode without QGA freeze/thaw: pause all vCPUs, snapshot all disk LVs, resume.
The reason is a reproducible QGA/VSS hang on both 109.1.0 and 110.2.3, even with a
freeze→thaw interval under 10 s (S9 §24.7). Linux keeps the previous quiesce.
`SnapshotRef.consistency` of new snapshots is explicitly `crash`, `quiesced`, or
`powered_off`; the field is optional only for compatibility with old state.
The external hook is applied in crash mode too (the worker clears secret files),
but the absence of a filesystem freeze does not raise consistency to quiesced.
`crashConsistent:false` is kept as a diagnostic VSS opt-in; do not apply
it to Windows in the regular worker. The thaw timeouts and cleanup on error are kept.
