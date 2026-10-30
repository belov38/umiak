# Proxmox host runbook (S1 PoC)

`setup.sh` prepares the host `pve` for sandboxes as described in `docs/specs/s1-proxmox-foundation.md` §4. It runs on the operator Mac and executes every step on the host as root over `ssh pve`.

```
infra/pve/setup.sh [--dry-run] <step>
infra/pve/setup.sh [--dry-run] revert <step>
infra/pve/setup.sh status
```

Order of steps: `user` → `net` → `sdn` → `node` → `fw` → `template` (then, for the dev control plane, `cp` → `cp-gateway` → `cp-tailscale`). Each step checks whether it is already done, applies and verifies. `--dry-run` prints the remote scripts.

| Step | What |
|---|---|
| `user` | role `SbxPoC`, pool `sandbox`, user `sbx@pve`, token `sbx@pve!poc` (secret → `~/.config/sbx/pve-token`), ACLs, host CA → `~/.config/sbx/pve-root-ca.pem` |
| `net` | `dnsmasq` + `dnsmasq-utils` (system service disabled), `/etc/sysctl.d/90-sbx-poc.conf` with `net.ipv4.ip_forward = 1` |
| `sdn` | zone `sbx`, VNet `sbx0` (isolate-ports), subnet `10.88.0.0/24` with SNAT and DHCP. Refuses to apply if `ifquery --check -a` fails; keeps `vmbr0` `mcast_hash_max` (the SDN reload resets it) |
| `node` | builds `sbx-node`, installs `/usr/local/bin/sbx-node` and `/etc/sbx-node.toml`, adds the restricted key, pins the host key in `~/.config/sbx/known_hosts` for the Tailscale name and IP |
| `fw` | `cluster.fw` (IPSets, group `sbx-egress`) and `host.fw` (`enable: 0`), then enables the datacenter firewall with a 5-minute automatic rollback. Cancels the rollback only if every check that passed before still passes |
| `template` | template 599 from a thin snapshot of `base-9000-disk-0`, sanitized offline by `template-sanitize.sh` before it ever boots (no Tailscale, no personal credentials, clean cloud-init and machine-id, MAC-independent DHCP) |
| `cp` | dev only: CT 590 `sbx-dev-cp` for the compose stack (unprivileged Debian, Docker, Tailscale package, own firewall). See `infra/dev-cp/README.md` |
| `cp-gateway` | dev only: the CT address into IPSet `sbx-gateway`, with a 3-minute automatic rollback and the same checks as `fw` |
| `cp-tailscale` | dev only: joins the CT to the tailnet; prints the login URL until it is approved |

Environment: `SBX_SETUP_SSH` (default `pve`), `SBX_DENY_PUBLIC_IPS` (empty in the PoC), `SBX_FW_TS_PEERS` (Tailscale addresses of existing guests used by the `fw` checks, because the Mac is not on the host LAN).

## Client configuration without MagicDNS

`packages/pve` (and `sbx-bench`) reach the host by its Tailscale name by default. To avoid MagicDNS lookups, use the Tailscale IP; the TLS certificate is still checked against `pve`, and the SSH host key is pinned for the IP by the `node` step:

```
export SBX_PVE_URL=https://100.64.10.2:8006
export SBX_PVE_TLS_NAME=pve
export SBX_NODE_SSH_HOST=100.64.10.2
```
