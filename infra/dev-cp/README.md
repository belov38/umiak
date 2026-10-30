# Dev control plane on `pve` (CT 590)

The compose stack from `deploy/compose` runs in a container on `pve`, so that sandbox VMs on `sbx0` can reach the gateway. This is dev infrastructure, not the product: the Tailscale access, the LAN addresses and the dev domain below live only in `infra/`.

| | |
|---|---|
| CT | 590 `sbx-dev-cp`, unprivileged, `nesting=1,keyctl=1`, Debian 13 (latest `debian-*-standard` from the Proxmox repo) |
| Resources | 4 cores, 3 GB RAM, swap 0, 30 GB on `local-lvm`, onboot off. The 8 GB sandbox budget is separate |
| Network | `vmbr0`, static `192.168.68.90/24` (outside the router's DHCP pool, which starts at .100), gateway `192.168.68.1` |
| Software | Docker Engine and the compose plugin from Docker's repo, Tailscale from its repo |
| User | `sbx` (uid 1000, group `docker`): the same uid as `node` in the worker image, so the 0600 secrets it owns are readable in the container |

## Create and remove

```
infra/pve/setup.sh cp            # create or update CT 590, Docker, Tailscale package, CT firewall
infra/pve/setup.sh cp-gateway    # CT address into IPSet sbx-gateway (3-minute automatic rollback)
infra/pve/setup.sh cp-tailscale  # tailscale up; prints the login URL until the node is approved
infra/pve/setup.sh revert cp-gateway
infra/pve/setup.sh revert cp
```

Environment: `SBX_CP_CTID` (590), `SBX_CP_IP`, `SBX_CP_GW`, `SBX_CP_LAN`, `SBX_CP_HOSTNAME`, `SBX_CP_SSH_PUBKEY` (`~/.ssh/id_ed25519.pub`, goes to `root` and `sbx`), `SBX_CP_LAN_TCP` (ports open to the LAN). `cp` refuses an address that is configured on a guest or answers ARP, and refuses to create the CT if the host would keep less than 4 GB available after the CT and the sandbox budget.

## Firewall

| Path | Allowed |
|---|---|
| sandbox → CT | tcp/443 only: group `sbx-egress` accepts `+sbx-gateway` on tcp/443 before it drops private ranges. Sandboxes arrive SNAT-ed from the host LAN address |
| sandbox → host, router, other LAN guests, other CT ports | nothing (group `sbx-egress`) |
| LAN → CT | tcp 22 (SSH), 443 (gateway TLS), 2222 (gateway SSH), 8080 (api, S7), 4180 (oauth2-proxy, S8), ping, udp 41641 (Tailscale direct). Policy `DROP` for the rest (`/etc/pve/firewall/590.fw`) |
| tailnet → CT | everything that listens on a non-loopback address; tailnet traffic is inside WireGuard and does not pass the Proxmox firewall |
| Postgres, worker 9090, gateway 7000/9190 | loopback of the CT only |

`smoke.sh` checks the sandbox side from a real VM.

## Access

- LAN: `ssh sbx@192.168.68.90` (and `root@`).
- Outside the LAN: after `cp-tailscale` is approved, `ssh sbx@sbx-dev-cp` (MagicDNS name) or the tailnet IP from `tailscale ip -4` in the CT.
- Worker and gateway health on the CT: `ssh -L 9090:127.0.0.1:9090 -L 9190:127.0.0.1:9190 sbx@192.168.68.90`, then `curl 127.0.0.1:9090/readyz`.

## Deploy

```
infra/dev-cp/deploy.sh [--dry-run]
```

1. Copies the working tree (`git ls-files`, ignored files excluded) to `~/boat-dev-clone` on the CT and removes files that are gone. `deploy/compose/secrets/` and `deploy/compose/.env` stay.
2. Copies `pve-token`, `pve-root-ca.pem`, `sbx-node_ed25519`, `known_hosts` from `~/.config/sbx` to `~/.config/sbx` on the CT (mode 0600). `known_hosts` gets the host key pinned for the host LAN address too.
3. Writes `deploy/compose/.env`: `COMPOSE_FILE` (the stack plus `compose.dev-cp.yaml`), `SBX_PVE_URL`, `SBX_PVE_TLS_NAME`, `SBX_NODE_SSH_HOST` (host LAN address `192.168.68.116`), `SBX_PVE_SECRETS_DIR`, `SBX_DEVCP_DOMAIN`, `SBX_TUNNEL_URL`. Writes `secrets/devcp/sbx.yaml` (the PVE API on the LAN address) and `secrets/data-keys.json` once.
4. `docker compose up -d --build --remove-orphans`, waits until `worker` and `gateway` are healthy, prints both `/readyz`, then checks TLS of `tunnel.<domain>` on the CT address from the Mac with the dev CA.

`compose.dev-cp.yaml` overrides only what the CT needs: the dev domain for `gateway-secrets` and `gateway`, the gateway ports (443 and 2222 on all addresses, the rest on loopback), and the `sbx.yaml` mount.

Environment: `SBX_DEVCP_SSH` (`sbx@192.168.68.90`, or `sbx@sbx-dev-cp` over the tailnet), `SBX_DEVCP_DOMAIN` (`devcp.internal`), `SBX_DEVCP_COMPOSE_FILES` (`compose.yaml:gateway.yaml`), `SBX_DEVCP_ENV` (extra lines for `.env`), `SBX_PVE_LAN_IP`.

On the CT, `cd ~/boat-dev-clone/deploy/compose`; `docker compose ps|logs|exec` pick up `COMPOSE_FILE` from `.env`.

### When S7 (api, Keycloak, oauth2-proxy) lands

If S7 adds its services to `compose.yaml`, run `deploy.sh` again. If it adds a separate file, list it, and point the gateway at the api:

```
SBX_DEVCP_COMPOSE_FILES=compose.yaml:gateway.yaml:api.yaml \
SBX_DEVCP_ENV='SBX_GATEWAY_API_URL=http://api:8082' infra/dev-cp/deploy.sh
```

Publish the api/web ports on all addresses in `compose.dev-cp.yaml` (as the gateway ports are), and if the ports differ from 8080/4180, set `SBX_CP_LAN_TCP` and re-run `infra/pve/setup.sh cp` (it rewrites the CT firewall).

## Names

The gateway serves `tunnel.<domain>`, `*.sbx.<domain>` and `ssh.<domain>`, `<domain>` = `SBX_DEVCP_DOMAIN` (default `devcp.internal`); the dev CA in `secrets/gateway/ca.pem` is limited to these names. Agents need the name: the gateway rejects TLS without SNI, so `wss://192.168.68.90/...` does not work.

- `smoke.sh` adds `192.168.68.90 tunnel.devcp.internal` to `/etc/hosts` of its VM.
- Sandboxes created by the worker use the DNS servers of `sbx0` (1.1.1.1), which do not know `devcp.internal`. For them the tunnel host needs a public DNS name that resolves to `192.168.68.90`: a record in an own domain, or a wildcard IP service (`SBX_DEVCP_DOMAIN=192-168-68-90.sslip.io`). Not decided yet.
- Previews from a browser: resolve `*.sbx.<domain>` to the CT address (or the tailnet IP) and trust `ca.pem` (see `deploy/compose/README.gateway.md`).

## Smoke test

```
infra/dev-cp/smoke.sh [--keep]
```

Builds the dev-signed agent package (`services/guest-agent/test/linux/run.sh`, `BUILD_ONLY`), registers a machine (bootstrap secret hash in `tunnel.tunnel_credentials`), clones one 2 GB VM from template 599 into the free VMID nearest to 598 with the machine's smbios, and checks from the VM that the CT answers on 443 only (not 22, 2222, 5432, 7000, 8080, 9090, 9190, ping), that the host (LAN and `10.88.0.1`), the router and a LAN guest are closed, and that the internet is open. Then it installs the agent as the S3 stand does (`stand-setup.sh install`), points it at `wss://tunnel.<domain>/v1/connect` with the gateway CA, waits for a `connected` row in `tunnel.tunnel_sessions` and calls `System/Info` through `@sbx/agent-client` in the worker container with the worker's service token. The VM and the database rows are removed at the end. About 4 minutes.
