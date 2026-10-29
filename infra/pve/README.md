# Proxmox host runbook (S1 PoC)

`setup.sh` prepares the host `pve` for sandboxes as described in `docs/specs/s1-proxmox-foundation.md` §4. It runs on the operator Mac and executes every step on the host as root over `ssh pve`.

```
infra/pve/setup.sh [--dry-run] <step>
infra/pve/setup.sh [--dry-run] revert <step>
infra/pve/setup.sh status
```

Order of steps: `user` → `net` → `sdn` → `node` → `fw` → `template`. Each step checks whether it is already done, applies and verifies. `--dry-run` prints the remote scripts.

| Step | What |
|---|---|
| `user` | role `SbxPoC`, pool `sandbox`, user `sbx@pve`, token `sbx@pve!poc` (secret → `~/.config/sbx/pve-token`), ACLs, host CA → `~/.config/sbx/pve-root-ca.pem` |
| `net` | `dnsmasq` + `dnsmasq-utils` (system service disabled), `/etc/sysctl.d/90-sbx-poc.conf` with `net.ipv4.ip_forward = 1` |
| `sdn` | zone `sbx`, VNet `sbx0` (isolate-ports), subnet `10.88.0.0/24` with SNAT and DHCP. Refuses to apply if `ifquery --check -a` fails; keeps `vmbr0` `mcast_hash_max` (the SDN reload resets it) |
| `node` | builds `sbx-node`, installs `/usr/local/bin/sbx-node` and `/etc/sbx-node.toml`, adds the restricted key, pins the host key in `~/.config/sbx/known_hosts` |
| `fw` | `cluster.fw` (IPSets, group `sbx-egress`) and `host.fw` (`enable: 0`), then enables the datacenter firewall with a 5-minute automatic rollback. Cancels the rollback only if every check that passed before still passes |
| `template` | template 599 from a thin snapshot of `base-9000-disk-0` |

Environment: `SBX_SETUP_SSH` (default `pve`), `SBX_DENY_PUBLIC_IPS` (empty in the PoC), `SBX_FW_TS_PEERS` (Tailscale addresses of existing guests used by the `fw` checks, because the Mac is not on the host LAN).
