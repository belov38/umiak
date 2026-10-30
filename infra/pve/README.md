# Proxmox host runbook (S1 PoC)

`setup.sh` prepares the host `pve` for sandboxes as described in `docs/specs/s1-proxmox-foundation.md` §4. It runs on the operator Mac and executes every step on the host as root over `ssh pve`.

```
infra/pve/setup.sh [--dry-run] <step>
infra/pve/setup.sh [--dry-run] revert <step>
infra/pve/setup.sh status
```

Order of steps: `user` → `net` → `sdn` → `node` → `fw` → `template` (then, for the dev control plane, `cp` → `cp-gateway` → `cp-tailscale`); `media` (S5) and `console` (S9) are independent (run after `user`). Each step checks whether it is already done, applies and verifies. `--dry-run` prints the remote scripts.

| Step | What |
|---|---|
| `user` | role `SbxPoC`, pool `sandbox`, user `sbx@pve`, token `sbx@pve!poc` (secret → `~/.config/sbx/pve-token`), ACLs, host CA → `~/.config/sbx/pve-root-ca.pem` |
| `net` | `dnsmasq` + `dnsmasq-utils` (system service disabled), `/etc/sysctl.d/90-sbx-poc.conf` with `net.ipv4.ip_forward = 1` |
| `sdn` | zone `sbx`, VNet `sbx0` (isolate-ports), subnet `10.88.0.0/24` with SNAT and DHCP. Refuses to apply if `ifquery --check -a` fails; keeps `vmbr0` `mcast_hash_max` (the SDN reload resets it) |
| `node` | builds `sbx-node`, installs `/usr/local/bin/sbx-node` and `/etc/sbx-node.toml`, adds the restricted key, pins the host key in `~/.config/sbx/known_hosts` for the Tailscale name and IP |
| `fw` | `cluster.fw` (IPSets, group `sbx-egress`) and `host.fw` (`enable: 0`), then enables the datacenter firewall with a 5-minute automatic rollback. Cancels the rollback only if every check that passed before still passes |
| `template` | template 599 from a thin snapshot of `base-9000-disk-0`, sanitized offline by `template-sanitize.sh` before it ever boots (no Tailscale, no personal credentials, clean cloud-init and machine-id, MAC-independent DHCP) |
| `media` | role `SbxTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) on `/storage/local` for `sbx@pve` and its token, so the template builder can upload seed ISOs and import images. Verified through `GET /access/permissions` with the token. `revert media` removes the ACLs and the role |
| `console` | role `SbxConsole` (`VM.Console`) on `/pool/sandbox` for `sbx@pve` and its token, so the Windows template builder can `sendkey` at the "Press any key to boot from CD" prompt. Verified through `GET /access/permissions` with the token. `revert console` removes the ACLs and the role |
| `cp` | dev only: CT 590 `sbx-dev-cp` for the compose stack (unprivileged Debian, Docker, Tailscale package, own firewall). See `infra/dev-cp/README.md` |
| `cp-gateway` | dev only: the CT address into IPSet `sbx-gateway`, with a 3-minute automatic rollback and the same checks as `fw` |
| `cp-tailscale` | dev only: joins the CT to the tailnet; prints the login URL until it is approved |

`sbx-node` also serves `media.list` (files `sbx-{seed,build,offline}-*.iso` and `sbx-virtio-win-<x.y.z>.iso` in `/var/lib/vz/template/iso`, `sbx-*.{qcow2,img,raw}` in `/var/lib/vz/import`) and `media.remove {"names": [...]}`, which deletes only such regular files (no symlinks, no paths). `media.sha256 {"name": "<file>.iso"}` is read-only: it hashes any regular `.iso` directly in `isoDir` (the user's own Windows ISO included; no `/`, `..` or symlinks) and caches the digest by name, size and mtime in `<stateDir>/media-sha256.json`. Directories come from `isoDir`, `importDir` and `stateDir` (default `/var/lib/sbx-node`) in `/etc/sbx-node.toml`. Snapshots (clones) are allowed from any `base-<id>-*` disk with `id` in the VMID range; a template's VMID cannot be reused for a sandbox disk. `templateVmid = 599` stays in the config so the legacy template remains protected; new templates need no config change.

## VMID layout on `pve`

| VMIDs | What |
|---|---|
| 500–589 | sandboxes: the allocator range of the worker, `sbx-bench` and `deploy/compose` (`SBX_VMID_RANGE`, topology `vmidMin`/`vmidMax`) |
| 590–596 | dev infrastructure, never allocated: CT 590 is the dev control plane (`infra/dev-cp`) |
| 597–599 | templates: S5 builds take 598, 597 (`sbx-tpl`, `SBX_TEMPLATE_VMID_RANGE`, default `597-598`); 599 is the PoC template |

`sbx-node` keeps 500–599 as its own range: it clones from the `base-<id>-*` volumes of the templates.

Environment: `SBX_SETUP_SSH` (default `pve`), `SBX_DENY_PUBLIC_IPS` (empty in the PoC), `SBX_FW_TS_PEERS` (Tailscale addresses of existing guests used by the `fw` checks, because the Mac is not on the host LAN).

## Client configuration without MagicDNS

`packages/pve` (and `sbx-bench`) reach the host by its Tailscale name by default. To avoid MagicDNS lookups, use the Tailscale IP; the TLS certificate is still checked against `pve`, and the SSH host key is pinned for the IP by the `node` step:

```
export SBX_PVE_URL=https://100.64.10.2:8006
export SBX_PVE_TLS_NAME=pve
export SBX_NODE_SSH_HOST=100.64.10.2
```
