# Dev control plane on `pve` (CT 590)

The compose stack from `deploy/compose` runs in a container on `pve`, so that sandbox VMs on `sbx0` can reach the gateway. This is dev infrastructure, not the product: the Tailscale access and Serve, the LAN addresses and the sslip.io names below live only in `infra/`.

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
| LAN → CT | tcp 22 (SSH), 443 (gateway TLS), 2222 (gateway SSH), 8080 and 4180 (unused since Serve, see Names and TLS), ping, udp 41641 (Tailscale direct). Policy `DROP` for the rest (`/etc/pve/firewall/590.fw`) |
| tailnet → CT | everything that listens on a non-loopback address, plus Tailscale Serve on 8443 and 10000; tailnet traffic is inside WireGuard and does not pass the Proxmox firewall |
| Postgres, worker 9090, gateway 7000/9190 | loopback of the CT only |

`smoke.sh` checks the sandbox side from a real VM.

## Access

- LAN: `ssh sbx@192.168.68.90` (and `root@`).
- Outside the LAN: after `cp-tailscale` is approved, `ssh sbx@sbx-dev-cp` (MagicDNS name) or the tailnet IP from `tailscale ip -4` in the CT.
- Worker and gateway health on the CT: `ssh -L 9090:127.0.0.1:9090 -L 9190:127.0.0.1:9190 sbx@192.168.68.90`, then `curl 127.0.0.1:9090/readyz`.

## Names and TLS

All names are set in `names.sh`. sslip.io is a public wildcard DNS (`<a-b-c-d>.sslip.io` → `a.b.c.d`); it answers DNS only, traffic goes straight to the CT. Tailscale Serve terminates TLS on the CT itself. No traffic relay is involved.

| Who | URL | Address | Certificate |
|---|---|---|---|
| Agents in sandboxes | `wss://tunnel.192-168-68-90.sslip.io/v1/connect` | LAN `192.168.68.90:443`, gateway | dev CA, pinned by the agent |
| Previews (browser) | `https://<slug>-<port>.sbx.100-64-10-7.sslip.io` | tailnet `100.64.10.7:443`, gateway | dev CA (wildcard) |
| oauth2-proxy (S7; dashboard S8) | `https://sbx-dev-cp.tail0000.ts.net:8443/` | Tailscale Serve → `127.0.0.1:4180` | Let's Encrypt (Serve) |
| api public listener (S7, CLI, SDK) | `https://sbx-dev-cp.tail0000.ts.net:8443/v1/…` | Tailscale Serve → `127.0.0.1:8080/v1` | Let's Encrypt (Serve) |
| Keycloak (S7) | `https://sbx-dev-cp.tail0000.ts.net:10000/` | Tailscale Serve → `127.0.0.1:8180` | Let's Encrypt (Serve) |
| SSH gateway (S4) | `ssh -p 2222 <slug>@sbx-dev-cp.tail0000.ts.net` | tailnet or LAN, port 2222 | gateway host keys |

Why it is split this way:

- Sandboxes use public DNS (1.1.1.1 from `sbx0`), are not on the tailnet, and can reach only `192.168.68.90:443`. The gateway rejects TLS without SNI, so agents need a public name for the LAN address.
- Serve gives a trusted certificate only for the MagicDNS name, without wildcards, and only on ports 443, 8443 and 10000. Previews need a wildcard, so they keep a dev CA certificate on sslip.io.
- The gateway routes a preview only when `Host` has no port or `:443` (S4 §4.2). So 443 of the tailnet address belongs to the gateway, and Serve uses 8443 and 10000: `/` of 8443 goes to oauth2-proxy (web, `/api/*`, `/sbx-auth/*` as on `app.<domain>`), `/v1` of the same port goes to the api public listener (the path is kept). Serve intercepts its ports on the tailnet address before Docker sees them; with 443 in Serve, previews would break, so `deploy.sh` refuses it. The gateway publishes 443 on all CT addresses; nothing else listens there.
- Serve passes `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto: https` and the `Tailscale-User-*` headers. The api never takes an identity from `Tailscale-User-*` (tests in `apps/api`: public and proxied listener, every operation); S8 must not either.

**Dev CA.** `dev-ca.sh` (run by `deploy.sh`) creates `~/.config/sbx/dev-ca/ca.pem` and `ca.key` on the Mac once (ECDSA P-256, 10 years, outside git, 0600). Name constraints limit it to `tunnel.192-168-68-90.sslip.io` and `sbx.100-64-10-7.sslip.io`. `deploy.sh` copies it to `~/.config/sbx/dev-ca/` on the CT (0600) and into `deploy/compose/secrets/gateway/`; the gateway's `dev-secrets` (S4) then issues `tunnel.pem` and `sbx.pem` (`*.sbx.…`, 397 days) with it. A new CA or new names make `deploy.sh` reissue both; it also renews them 30 days before expiry. Other names need a new CA: move `~/.config/sbx/dev-ca` away, run `deploy.sh` and `trust-mac.sh` again, and rebuild agent packages that pin the old one.

**Tailscale Serve.** `infra/pve/setup.sh cp-tailscale` makes `sbx` the Tailscale operator; `deploy.sh` rebuilds the Serve config from `SBX_DEVCP_SERVE` (`<https port>:<path>=<target>` words, default in `names.sh`) with `tailscale serve reset` and `tailscale serve --bg`. A target that does not listen answers `502`. HTTPS certificates must be enabled in the tailnet (they are: `tailscale status --json` lists `CertDomains`).

### The Mac

The dashboard, api, CLI and Keycloak need nothing: their certificate is a public Let's Encrypt one. Only previews in a browser need the dev CA:

```
infra/dev-cp/trust-mac.sh            # adds ca.pem to the login keychain (no sudo; macOS asks for the password)
infra/dev-cp/trust-mac.sh --remove
```

curl without the keychain: `curl --cacert ~/.config/sbx/dev-ca/ca.pem https://x-y-z-3000.sbx.100-64-10-7.sslip.io/`. Without api the gateway answers `503 route_lookup_unavailable`, with api `404 route_not_found` for an unknown sandbox.

The `sbx` CLI (S7) talks to the api on the Serve name (`sbx login --api-url https://sbx-dev-cp.tail0000.ts.net:8443`), so it needs no CA option for this stack. A CA option (`--cacert` / `SBX_CA_FILE`; `NODE_EXTRA_CA_CERTS` under Node already works) comes later for installations with a private CA.

### How agents get the name and the CA

- **URL:** the smbios `family` field, `sbxt1:wss://tunnel.192-168-68-90.sslip.io/v1/connect` (S5 §14), which wins over `agent.toml`. `deploy.sh` sets `SBX_TUNNEL_URL` for the worker, which writes `family` into `smbios1` of every new machine (S5 §17.4 p. 3); `smoke.sh` sets it by hand for its 599 clone.
- **CA:** the agent pins `trust/tunnel-ca.pem` from its signed package. S5 template builds for this stack must pack the dev CA: `sbx-release pack --tunnel-ca ~/.config/sbx/dev-ca/ca.pem …` (on the CT, `~/.config/sbx/dev-ca/ca.pem`); `services/guest-agent/test/linux/run.sh` takes `TUNNEL_CA=<pem>` for the same. `[tunnel] trust_dir` in `agent.toml` also works but is not the template path.

## Deploy

```
infra/dev-cp/deploy.sh [--dry-run]
```

1. Runs `dev-ca.sh`. Copies the working tree (`git ls-files`, ignored files excluded) to `~/boat-dev-clone` on the CT and removes files that are gone. `deploy/compose/secrets/` and `deploy/compose/.env` stay.
2. Copies `pve-token`, `pve-root-ca.pem`, `sbx-node_ed25519`, `known_hosts` and `dev-ca/ca.{pem,key}` from `~/.config/sbx` to `~/.config/sbx` on the CT (mode 0600). `known_hosts` gets the host key pinned for the host LAN address too.
3. Checks the CT's MagicDNS name against `names.sh`, puts the dev CA into `secrets/gateway` when it changed, writes `deploy/compose/.env` (below), `secrets/devcp/sbx.yaml` (the PVE API on the LAN address) and `secrets/data-keys.json` once.
4. `docker compose up -d --build --remove-orphans`, waits until `worker`, `gateway`, `api` and `oauth2-proxy` are healthy (the first Keycloak start takes a minute or two), prints the worker, gateway and api `/readyz`, applies the Serve config.
5. From the Mac, with real DNS: the tunnel host and a preview host with the dev CA, each Serve port and the api `/v1/meta` with the system trust store.

`.env`: `COMPOSE_FILE` (the stack plus `compose.dev-cp.yaml`), `SBX_PVE_URL`, `SBX_PVE_TLS_NAME`, `SBX_NODE_SSH_HOST` (host LAN address `192.168.68.116`), `SBX_PVE_SECRETS_DIR`, the names (`SBX_DEVCP_TUNNEL_HOST`, `SBX_TUNNEL_URL`, `SBX_PORT_DOMAIN`, `SBX_DEVCP_SSH_HOST`) and the public URLs (`SBX_DEVCP_TS_NAME`, `SBX_APP_ORIGIN`, `SBX_API_PUBLIC_URL`, `SBX_KEYCLOAK_URL`, `SBX_OIDC_ISSUER`, `SBX_GATEWAY_AUTH_URL`, `SBX_OAUTH2_PROXY_REDIRECT_URL`).

`compose.dev-cp.yaml` overrides only what the CT needs: the names for `gateway-secrets`, `gateway` and `worker` (`SBX_TUNNEL_URL`, `SBX_PORT_DOMAIN`), the gateway ports (443 and 2222 on all addresses, the rest on loopback), the `sbx.yaml` mount, and the S7 services behind Serve (below). Each value it takes from `.env` is required (`${VAR:?set by deploy.sh}`), so a stale `.env` fails `docker compose config` instead of falling back to localhost.

Environment: `SBX_DEVCP_SSH` (`sbx@192.168.68.90`, or `sbx@sbx-dev-cp` over the tailnet), `SBX_DEVCP_COMPOSE_FILES` (`compose.yaml:gateway.yaml`), `SBX_DEVCP_ENV` (extra lines for `.env`), `SBX_PVE_LAN_IP`; names: `SBX_CP_IP`, `SBX_CP_TAILNET_IP`, `SBX_DEVCP_TS_NAME`, `SBX_DEVCP_TUNNEL_HOST`, `SBX_DEVCP_PORT_DOMAIN`, `SBX_DEVCP_SERVE`, `SBX_DEVCP_CA_DIR`.

On the CT, `cd ~/boat-dev-clone/deploy/compose`; `docker compose ps|logs|exec` pick up `COMPOSE_FILE` from `.env`.

### S7 behind Tailscale Serve (api, Keycloak, oauth2-proxy)

Checked on CT 590 by `e2e.sh` (`docs/plans/e2e-devcp.md`): every service healthy, Serve on `:8443` and `:10000`, discovery keeps the public issuer with `:10000` while containers use `http://keycloak:8080`, `sbx login` (device grant), browser login through oauth2-proxy, token and SSO ports, SSH through the gateway.

- A Keycloak database left from an earlier import keeps old redirect URIs: drop the `keycloak` database if the browser login ends in `redirect_uri` mismatch.
- Keycloak runs with a fixed heap (`-Xmx512m`, `mem_limit: 1200m`): without a limit of its own the JVM sizes its heap from the host's RAM and starves the 3 GB CT.
- The single gateway drains for 20 s (`SBX_GATEWAY_DRAIN_TIMEOUT`, `stop_grace_period: 30s`) instead of the product 950 s: there is no peer to drain to, and a recreated gateway would keep the stack down for 16 minutes.

`compose.yaml` has the S7 services and includes `gateway.yaml`; `compose.dev-cp.yaml` publishes them on loopback for Serve and feeds them the `.env` values. The product compose takes the same public URLs as generic variables with localhost defaults (`deploy/compose/README.md`, «Публичные адреса»); the override repeats the ones from `.env` as required values (`${VAR:?}`) so the CT never runs with a localhost default, and adds what the base leaves neutral (Keycloak proxy headers, trusted proxies, the `__Host-` cookie, cross-site port cookies).

| Service | Publish (base compose) | Settings |
|---|---|---|
| oauth2-proxy | `127.0.0.1:4180:4180` | `OAUTH2_PROXY_REDIRECT_URL=${SBX_OAUTH2_PROXY_REDIRECT_URL}`, issuer and login URL from `SBX_OIDC_ISSUER` (alpha config, `skipDiscovery`; redeem, JWKS and profile on `http://keycloak:8080/realms/sbx/…`), `OAUTH2_PROXY_REVERSE_PROXY=true`, cookie `__Host-sbx_session` with `Secure`, whitelist `<TS name>:8443`; upstreams `/api/` → api `:8081` (prefix stripped), `/sbx-auth/` → api `:8081` |
| api | `127.0.0.1:8080:8080`, ops `127.0.0.1:9091` | `SBX_OIDC_ISSUER=${SBX_OIDC_ISSUER}` (discovery and JWKS on `http://keycloak:8080` from the base), `SBX_APP_ORIGIN`/`SBX_APP_URL=${SBX_APP_ORIGIN}`, `SBX_API_URL=${SBX_API_PUBLIC_URL}`, `SBX_SBX_DOMAIN=${SBX_PORT_DOMAIN}`, `SBX_SSH_HOST=${SBX_DEVCP_SSH_HOST}` port 2222, `SBX_API_TRUSTED_PROXY_CIDRS=172.16.0.0/12,127.0.0.1/32` |
| Keycloak | `127.0.0.1:8180:8080` | `KC_HOSTNAME=${SBX_KEYCLOAK_URL}` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` from the base), `KC_HTTP_ENABLED=true`, `SBX_KEYCLOAK_PROXY_HEADERS=xforwarded` and `SBX_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` as the api (→ `KC_PROXY_HEADERS`, `KC_PROXY_TRUSTED_ADDRESSES`); realm `sbx` with the Serve redirect URI and web origin |
| gateway | as before | `SBX_GATEWAY_AUTH_URL=${SBX_GATEWAY_AUTH_URL}` (`https://<TS name>:8443/sbx-auth/authorize`), `SBX_GATEWAY_COOKIE_CROSS_SITE=true` (the preview domain and the dashboard are different sites) |
| web (S8) | not published | to add: `/` upstream of oauth2-proxy, `SBX_APP_ORIGIN`, `SBX_SBX_DOMAIN=${SBX_PORT_DOMAIN}`, `SBX_API_PUBLIC_URL` |

- Containers on the CT cannot reach the Serve address (checked: `ECONNREFUSED` from the worker container to `100.64.10.7:10000`; the CT itself can). So every service talks to Keycloak as `http://keycloak:8080` while tokens keep the public issuer `https://<TS name>:10000/realms/sbx` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC`).
- Keycloak clients: `oauth2-proxy` redirect URI `https://sbx-dev-cp.tail0000.ts.net:8443/oauth2/callback`, web origin `https://sbx-dev-cp.tail0000.ts.net:8443`; `sbx-cli` is a public device-flow client without redirect URIs. The realm is imported into an empty Keycloak only: after changing the names, drop the `keycloak` database (`deploy/compose/README.md`, «Keycloak»).
- Client addresses: Serve connects to the published loopback ports, and Docker hands the connection to the container from the bridge gateway (`172.x.0.1`); oauth2-proxy calls the api from its container address. Both are in `172.16.0.0/12` (Docker's default bridge pools), so `X-Forwarded-For` from them gives the tailnet client in the api log (`clientIp`). Any container in the `sbx` network can forge it too; it only affects logs.
- Keycloak admin: `https://sbx-dev-cp.tail0000.ts.net:10000/admin`, password on the CT in `~/boat-dev-clone/deploy/compose/secrets/keycloak/admin-password`. Dev user `dev@example.com`, temporary password `dev`. Ilia and the e2e user: `dev-users.sh` (below).
- The LAN firewall still admits 8080/4180, which are now unused; nothing listens there on the LAN.

## People, e2e and the quick start

- `dev-users.sh` creates `ilia@example.com` (temporary password in `~/.config/sbx/dev-cp/ilia-initial-password` on the Mac, 0600) and `e2e@example.com` (permanent password in `~/.config/sbx/dev-cp/e2e-password`). The realm takes the email as the username; Keycloak 26 needs first and last name, or the login stops at the profile form. Each gets a personal team with the owner role at the first login.
- `e2e.sh [--keep-going]` runs the whole scenario from the Mac with the real CLI and both SDKs, prints a PASS/FAIL table and checks that nothing is left on `pve`. It uses its own CLI config (mktemp), `kc-browser.py` for the Keycloak pages and `e2e-pty.py` for `sbx shell`. About 5 minutes, at most two 2 GB sandboxes at once. The work dir (tokens, SSH key) is deleted at the end; `SBX_E2E_KEEP_WORKDIR=1` keeps it.
- `QUICKSTART.md`: the short guide for Ilia (Russian).

## Smoke test

```
infra/dev-cp/smoke.sh [--keep]
```

Builds the dev-signed agent package (`services/guest-agent/test/linux/run.sh`, `BUILD_ONLY`, `TUNNEL_CA` = the dev CA), registers a machine (bootstrap secret hash in `tunnel.tunnel_credentials`), clones one 2 GB VM from template 599 into the free VMID nearest to 589 with the machine's smbios, and checks from the VM that the CT answers on 443 only (not 22, 2222, 5432, 7000, 8080, 9090, 9190, ping), that the host (LAN and `10.88.0.1`), the router and a LAN guest are closed, and that the internet is open. Then it checks that the tunnel host resolves to the CT through the VM's own DNS (not `/etc/hosts`), installs the agent as the S3 stand does (`stand-setup.sh install`, a package that pins the dev CA) with the tunnel URL in the smbios `family`, checks `sbx-agent doctor` (URL from `smbios`), waits for a `connected` row in `tunnel.tunnel_sessions` and calls `System/Info` through `@sbx/agent-client` in the worker container with the worker's service token. The VM and the database rows are removed at the end. About 4 minutes.
