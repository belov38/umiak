# Proxmox host runbook (S1 PoC)

Current R1 dev stand: CT 590 is retained, and the only active template slots are Linux 597,
Linux desktop 596, Windows desktop 595 and Windows 598. Slot 599 is empty and reserved.
The S1 `template` bootstrap below is historical; current templates come from the four recipes,
without modifying 9000/9001. Rebuild one exact slot at a time, after its consumers are gone.

`setup.sh` prepares the host `pve` for sandboxes as described in `docs/specs/s1-proxmox-foundation.md` §4. It runs on the operator Mac and executes every step on the host as root over `ssh pve`.

```
infra/pve/setup.sh [--dry-run] <step>
infra/pve/setup.sh [--dry-run] revert <step>
infra/pve/setup.sh status
```

Order of steps: `user` → `net` → `sdn` → `node` → `fw` → `template` (then, for the dev control plane, `cp` → `cp-gateway` → `cp-tailscale`); `media` (S5) and `console` (S9) are independent (run after `user`). Each step checks whether it is already done, applies and verifies. `--dry-run` prints the remote scripts.

| Step | What |
|---|---|
| `user` | role `UmiakPoC`, pool `umiak`, user `umiak@pve`, token `umiak@pve!dev` (secret → `~/.config/umiak/pve-token`), ACLs, host CA → `~/.config/umiak/pve-root-ca.pem` |
| `net` | `dnsmasq` + `dnsmasq-utils` (system service disabled), `/etc/sysctl.d/90-umiak-poc.conf` with `net.ipv4.ip_forward = 1` |
| `sdn` | zone `umiak`, VNet `umiak0` (isolate-ports), subnet `10.88.0.0/24` with SNAT and DHCP. Refuses to apply if `ifquery --check -a` fails; keeps `vmbr0` `mcast_hash_max` (the SDN reload resets it) |
| `node` | builds `umiak-node`, installs `/usr/local/bin/umiak-node` and `/etc/umiak-node.toml`, adds the restricted key, pins the host key in `~/.config/umiak/known_hosts` for the Tailscale name and IP |
| `fw` | `cluster.fw` (IPSets, group `umiak-egress`) and `host.fw` (`enable: 0`), then enables the datacenter firewall with a 5-minute automatic rollback. Cancels the rollback only if every check that passed before still passes |
| `template` | template 599 from a thin snapshot of `base-9000-disk-0`, sanitized offline by `template-sanitize.sh` before it ever boots (no Tailscale, no personal credentials, clean cloud-init and machine-id, MAC-independent DHCP) |
| `media` | role `UmiakTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) on `/storage/local` for `umiak@pve` and its token, so the template builder can upload seed ISOs and import images. Verified through `GET /access/permissions` with the token. `revert media` removes the ACLs and the role |
| `console` | role `UmiakConsole` (`VM.Console`) on `/pool/umiak` for `umiak@pve` and its token, so the Windows template builder can `sendkey` at the "Press any key to boot from CD" prompt. Verified through `GET /access/permissions` with the token. `revert console` removes the ACLs and the role |
| `cp` | dev only: CT 590 `umiak-dev-cp` for the compose stack (unprivileged Debian, Docker, Tailscale package, own firewall). See `infra/dev-cp/README.md` |
| `cp-gateway` | dev only: the CT address into IPSet `umiak-gateway`, with a 3-minute automatic rollback and the same checks as `fw` |
| `cp-tailscale` | dev only: joins the CT to the tailnet; prints the login URL until it is approved |

`umiak-node` also serves `media.list` (files `umiak-{seed,build,offline}-*.iso` and `umiak-virtio-win-<x.y.z>.iso` in `/var/lib/vz/template/iso`, `umiak-*.{qcow2,img,raw}` in `/var/lib/vz/import`) and `media.remove {"names": [...]}`, which deletes only such regular files (no symlinks, no paths). `media.sha256 {"name": "<file>.iso"}` is read-only: it hashes any regular `.iso` directly in `isoDir` (the user's own Windows ISO included; no `/`, `..` or symlinks) and caches the digest by name, size and mtime in `<stateDir>/media-sha256.json`. Directories come from `isoDir`, `importDir` and `stateDir` (default `/var/lib/umiak-node`) in `/etc/umiak-node.toml`. Snapshots (clones) are allowed only from `base-<id>-*` disks of a template slot (`templateVmidMin`..`templateVmidMax`, 595–599) that carry the tag `umiak-tpl`; `lv.tagTemplate {"vmid"}` adds that tag to the disks of a slot VM whose Proxmox config has `template: 1` and the tag `umiak-tpl` (the builder calls it). `lv.scan` and `lv.usage` read only such template disks and sandbox disks `vm-<id>-disk-N` tagged `umiak` and `umiak-vm-<id>`; nothing else is activated or opened. `lv.adopt {"vmid"}` tags the disks Proxmox allocated for a sandbox VM (the fresh `tpmstate0` of a Windows clone) with `umiak` and `umiak-vm-<id>`, so `lv.snapshot`, `lv.remove` and the tag-based cleanup accept them: only a VMID in `vmidMin`..`vmidMax` whose config (current section) exists, is not `template: 1` and carries the tag `umiak`, and only `vm-<id>-disk-N` volumes on `storage` that its `efidisk`/`tpmstate`/`scsi`/`sata`/`virtio`/`ide` keys attach (never `unusedN`, base or snapshot LVs, other VMIDs, or an LV tagged `umiak-tpl`). It returns `{"tagged": [...], "already": [...]}`; S1 `Machines.create` calls it after allocating `tpmstate0`. `templateVmid = 599` stays as a protected legacy reservation; it is not an active template.

## VMID layout on `pve`

| VMIDs | What |
|---|---|
| 500–589 | sandboxes: the allocator range of the worker, `umiak-bench` and `deploy/compose` (`UMIAK_VMID_RANGE`, topology `vmidMin`/`vmidMax`) |
| 590–594 | dev infrastructure, never allocated: CT 590 is the dev control plane (`infra/dev-cp`) |
| 595–598 | fixed recipe slots: Windows desktop 595, Linux desktop 596, Linux 597, Windows 598 |
| 599 | empty protected legacy reservation; never a new active R1 build |

Template slots are fixed per recipe (`vmids` in `infra/templates/<slug>/template.yaml`):
Linux `[597]`, Windows `[598]`, Linux desktop `[596]`, Windows desktop `[595]`.
Set `UMIAK_TEMPLATE_VMID_RANGE` to the single target (`595-595`, `596-596`, `597-597` or
`598-598`); its generic legacy default `597-599` is only a bound, not a recipe slot assignment.
With one slot, retire the old build only after backup and removal of all its consumers, then
build and verify the replacement before promoting it. `retire` protects configured and newest
ready builds unless explicitly forced. Keep `UMIAK_TEMPLATE_VMID=599` as the unused legacy
reservation; do not lift the 599 protection to create a fifth active template.

`umiak-node` uses the same layout (`vmidMin`/`vmidMax` = 500–589, `templateVmidMin`/`templateVmidMax` = 595–599 in `/etc/umiak-node.toml`); 590–594 is in neither range.

Environment: `UMIAK_SETUP_SSH` (default `pve`), `UMIAK_DENY_PUBLIC_IPS` (empty in the PoC), `UMIAK_FW_TS_PEERS` (Tailscale addresses of existing guests used by the `fw` checks, because the Mac is not on the host LAN).

## Client configuration without MagicDNS

`packages/pve` (and `umiak-bench`) reach the host by its Tailscale name by default. To avoid MagicDNS lookups, use the Tailscale IP; the TLS certificate is still checked against `pve`, and the SSH host key is pinned for the IP by the `node` step:

```
export UMIAK_PVE_URL=https://100.64.10.2:8006
export UMIAK_PVE_TLS_NAME=pve
export UMIAK_NODE_SSH_HOST=100.64.10.2
```
