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
| Dashboard `web` (S8) behind oauth2-proxy (S7) | `https://sbx-dev-cp.tail0000.ts.net:8443/` (`/app`, `/admin`; `/api/*`, `/sbx-auth/*` → api) | Tailscale Serve → `127.0.0.1:4180` | Let's Encrypt (Serve) |
| api public listener (S7, CLI, SDK) | `https://sbx-dev-cp.tail0000.ts.net:8443/v1/…` | Tailscale Serve → `127.0.0.1:8080/v1` | Let's Encrypt (Serve) |
| MCP server (S11) | `https://sbx-dev-cp.tail0000.ts.net:8443/mcp` | Tailscale Serve → `127.0.0.1:8090/mcp` (plus `/.well-known/oauth-protected-resource/mcp`) | Let's Encrypt (Serve) |
| Keycloak (S7) | `https://sbx-dev-cp.tail0000.ts.net:10000/` | Tailscale Serve → `127.0.0.1:8180` | Let's Encrypt (Serve) |
| SSH gateway (S4) | `ssh -p 2222 <slug>@sbx-dev-cp.tail0000.ts.net` | tailnet or LAN, port 2222 | gateway host keys |

Why it is split this way:

- Sandboxes use public DNS (1.1.1.1 from `sbx0`), are not on the tailnet, and can reach only `192.168.68.90:443`. The gateway rejects TLS without SNI, so agents need a public name for the LAN address.
- Serve gives a trusted certificate only for the MagicDNS name, without wildcards, and only on ports 443, 8443 and 10000. Previews need a wildcard, so they keep a dev CA certificate on sslip.io.
- The gateway routes a preview only when `Host` has no port or `:443` (S4 §4.2). So 443 of the tailnet address belongs to the gateway, and Serve uses 8443 and 10000: `/` of 8443 goes to oauth2-proxy (web, `/api/*`, `/sbx-auth/*` as on `app.<domain>`), `/v1` of the same port goes to the api public listener (the path is kept), `/mcp` and `/.well-known/oauth-protected-resource/mcp` go to the MCP server (S11, same). Serve intercepts its ports on the tailnet address before Docker sees them; with 443 in Serve, previews would break, so `deploy.sh` refuses it. The gateway publishes 443 on all CT addresses; nothing else listens there.
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
4. On the first S8 deploy (Postgres runs, `identity.users` exists, `payload.payload_migrations` does not) stops `api` and `worker` (`docker compose stop api worker`): the pre-S8 api writes into `identity` while `web-migrate` copies it into `payload`, and rows written after the copy would be lost (S8 §21.2). Later deploys skip this step.
5. `docker compose up -d --build --remove-orphans`, waits until `worker`, `gateway`, `api`, `oauth2-proxy`, `web` and `mcp` are healthy (the first Keycloak start takes a minute or two), prints the worker, gateway, api and mcp `/readyz`, applies the Serve config.
6. From the Mac, with real DNS: the tunnel host and a preview host with the dev CA, each Serve port, the api `/v1/meta` and the MCP protected resource metadata with the system trust store.

`.env`: `COMPOSE_FILE` (the stack plus `compose.dev-cp.yaml`), `SBX_PVE_URL`, `SBX_PVE_TLS_NAME`, `SBX_NODE_SSH_HOST` (host LAN address `192.168.68.116`), `SBX_PVE_SECRETS_DIR`, the names (`SBX_DEVCP_TUNNEL_HOST`, `SBX_TUNNEL_URL`, `SBX_PORT_DOMAIN`, `SBX_DEVCP_SSH_HOST`) and the public URLs (`SBX_DEVCP_TS_NAME`, `SBX_APP_ORIGIN`, `SBX_API_PUBLIC_URL`, `SBX_MCP_PUBLIC_URL`, `SBX_KEYCLOAK_URL`, `SBX_OIDC_ISSUER`, `SBX_GATEWAY_AUTH_URL`, `SBX_OAUTH2_PROXY_REDIRECT_URL`, `SBX_LOGOUT_URL`).

`compose.dev-cp.yaml` overrides only what the CT needs: the names for `gateway-secrets`, `gateway` and `worker` (`SBX_TUNNEL_URL`, `SBX_PORT_DOMAIN`), the gateway ports (443 and 2222 on all addresses, the rest on loopback), the `sbx.yaml` mount of `migrate` (api and worker read the config from Payload since S8), and the S7/S8 services behind Serve (below). Each value it takes from `.env` is required (`${VAR:?set by deploy.sh}`), so a stale `.env` fails `docker compose config` instead of falling back to localhost.

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
| oauth2-proxy | `127.0.0.1:4180:4180` | `OAUTH2_PROXY_REDIRECT_URL=${SBX_OAUTH2_PROXY_REDIRECT_URL}`, issuer and login URL from `SBX_OIDC_ISSUER` (alpha config, `skipDiscovery`; redeem, JWKS and profile on `http://keycloak:8080/realms/sbx/…`), `OAUTH2_PROXY_REVERSE_PROXY=true`, cookie `__Host-sbx_session` with `Secure`, whitelist `<TS name>:8443` (post-login) and `<TS name>:10000` (sign-out to Keycloak); upstreams `/api/` → api `:8081` (prefix stripped), `/sbx-auth/` → api `:8081`, `/` → web `:3000` |
| api | `127.0.0.1:8080:8080`, ops `127.0.0.1:9091` | `SBX_OIDC_ISSUER=${SBX_OIDC_ISSUER}` (discovery and JWKS on `http://keycloak:8080` from the base), `SBX_APP_ORIGIN`/`SBX_APP_URL=${SBX_APP_ORIGIN}`, `SBX_API_URL=${SBX_API_PUBLIC_URL}`, `SBX_SBX_DOMAIN=${SBX_PORT_DOMAIN}`, `SBX_SSH_HOST=${SBX_DEVCP_SSH_HOST}` port 2222, `SBX_API_TRUSTED_PROXY_CIDRS=172.16.0.0/12,127.0.0.1/32` |
| Keycloak | `127.0.0.1:8180:8080` | `KC_HOSTNAME=${SBX_KEYCLOAK_URL}` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` from the base), `KC_HTTP_ENABLED=true`, `SBX_KEYCLOAK_PROXY_HEADERS=xforwarded` and `SBX_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` as the api (→ `KC_PROXY_HEADERS`, `KC_PROXY_TRUSTED_ADDRESSES`); realm `sbx` with the Serve redirect URI and web origin |
| gateway | as before | `SBX_GATEWAY_AUTH_URL=${SBX_GATEWAY_AUTH_URL}` (`https://<TS name>:8443/sbx-auth/authorize`), `SBX_GATEWAY_COOKIE_CROSS_SITE=true` (the preview domain and the dashboard are different sites) |
| web (S8) | not published; only on the `web-internal` network (oauth2-proxy, postgres) | `/` upstream of oauth2-proxy; `SBX_APP_ORIGIN=${SBX_APP_ORIGIN}`, `SBX_SBX_DOMAIN=${SBX_PORT_DOMAIN}` (CSP `frame-src https://*.<port domain>`), `SBX_API_PUBLIC_URL=${SBX_API_PUBLIC_URL}`, `SBX_LOGOUT_URL=${SBX_LOGOUT_URL}` (`names.sh` `LOGOUT_URL`: Keycloak end-session on `:10000`, `client_id=oauth2-proxy`, back to `https://<TS name>:8443/app`) |
| web-migrate, worker (S8) | — | `web-migrate` applies the Payload migrations before api, worker and web; the worker runs `ctl-idp-sync` against `http://keycloak:8080` (client `sbx-worker`) from the base compose |

- Containers on the CT cannot reach the Serve address (checked: `ECONNREFUSED` from the worker container to `100.64.10.7:10000`; the CT itself can). So every service talks to Keycloak as `http://keycloak:8080` while tokens keep the public issuer `https://<TS name>:10000/realms/sbx` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC`).
- Keycloak clients: `oauth2-proxy` redirect URI `https://sbx-dev-cp.tail0000.ts.net:8443/oauth2/callback`, web origin `https://sbx-dev-cp.tail0000.ts.net:8443`; `sbx-cli` is a public device-flow client without redirect URIs. The realm is imported into an empty Keycloak only: after changing the names, drop the `keycloak` database (`deploy/compose/README.md`, «Keycloak»).
- Client addresses: Serve connects to the published loopback ports, and Docker hands the connection to the container from the bridge gateway (`172.x.0.1`); oauth2-proxy calls the api from its container address. Both are in `172.16.0.0/12` (Docker's default bridge pools), so `X-Forwarded-For` from them gives the tailnet client in the api log (`clientIp`). Any container in the `sbx` network can forge it too; it only affects logs.
- Keycloak admin: `https://sbx-dev-cp.tail0000.ts.net:10000/admin`, password on the CT in `~/boat-dev-clone/deploy/compose/secrets/keycloak/admin-password`. Dev user `dev@example.com`, temporary password `dev`. Ilia and the e2e user: `dev-users.sh` (below).
- The LAN firewall still admits 8080/4180, which are now unused; nothing listens there on the LAN.

### S8 dashboard (web)

> **Не проверено на CT.** Checked locally only (`docker compose config` with the dev-cp files as `deploy.sh` layers them, and the base stack on the Mac). After the next deploy, verify on the CT:
> - `docker compose ps -a`: `web-migrate` and `migrate` `Exited (0)`, `web` healthy; `docker compose logs web-migrate` lists the applied migrations (an existing S7 volume: the identity rows are copied into `payload` by the first one). api `/readyz` 200 (it checks the Payload migrations).
> - Browser `https://<TS name>:8443/` → Keycloak (`:10000`) → `/app` → the personal team; `/api/v1/me` 200 with `"auth": {"kind": "session"}` and the same user and team ids as the dashboard.
> - `/admin`: 403 "Operators only" for `dev@example.com`; after joining `sbx-operators` in Keycloak and signing in again: the admin and `/app/operator`.
> - Sign out (user menu): `/oauth2/sign_out?rd=…` → Keycloak `:10000` logout page → back on `https://<TS name>:8443/app` and a new login. A Keycloak database imported before S8 already has `post.logout.redirect.uris` `<app origin>/*` (S7 realm); if Keycloak answers `Invalid redirect uri`, add it to the client `oauth2-proxy` or drop the `keycloak` database.
> - A preview of a published `sso` port opens in the dashboard's sandbox page (frame from `*.sbx.100-64-10-7.sslip.io` with the cross-site port cookie); no CSP errors in the browser console.
> - `web:3000` is not reachable from a container on the `sbx` network (`deploy/compose/README.md`, «web (S8)»), and nothing listens on 3000 on the CT.
> - `worker` log: `ctl-idp-sync` passes without `KeycloakError` (the service account `sbx-worker` has `view-users`).
> - Postgres `SHOW max_connections` is 200.

**First S8 deploy onto an S7 volume.** Stop `api` and `worker` before it (`docker compose stop api worker` on the CT, in `deploy/compose`): the old api writes into `identity` while the first Payload migration copies it, and rows written after the copy are not moved (S8 §21.2). `deploy.sh` does this itself when Postgres runs with `identity.users` and without `payload.payload_migrations` (step 4 of «Deploy»); by hand, do it before `docker compose up`.

`deploy.sh` writes `SBX_LOGOUT_URL` from `names.sh` and waits for `web` too. The api and worker take templates, sizes and quotas from Payload now; `secrets/devcp/sbx.yaml` is read only by `migrate` (topology and template builds).

### S11 MCP behind Tailscale Serve

> **Not checked on the CT.** The wiring was checked locally only (`docker compose config` with the dev-cp files, a local image build and container smoke); `deploy.sh` has not been run with the `mcp` service, and nothing was run on CT 590. To verify after the master allows a deploy:
> - `docker compose ps` on the CT: `mcp` healthy; `curl http://127.0.0.1:9092/readyz` answers 200.
> - Which `Host` Serve passes to the target: the MagicDNS name with `:8443` or `127.0.0.1:8090`. Both are in `SBX_MCP_ALLOWED_HOSTS` (`compose.dev-cp.yaml`); a `421 this Host is not served here` from `/mcp` through Serve means a third form, add it there.
> - `curl -i https://<TS name>:8443/mcp -X POST -H 'content-type: application/json' -d '{}'` answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://<TS name>:8443/.well-known/oauth-protected-resource/mcp"`; that metadata names `authorization_servers: ["https://<TS name>:10000/realms/sbx"]`.
> - Two Serve paths on one port (`/mcp` and the dot-prefixed `/.well-known/...`) next to `/` and `/v1`: `tailscale serve status` lists all four mappings of 8443.
> - A team key (`Authorization: Bearer sbx_...`) and the browser sign-in of the `sbx-mcp` client with each client from `apps/mcp/README.md`.

`compose.dev-cp.yaml` gives the `mcp` service the public URL `SBX_MCP_PUBLIC_URL=https://<TS name>:8443/mcp` (from `.env`, required), the issuer `SBX_OIDC_ISSUER` (the protected resource metadata names it; Keycloak tokens carry the public issuer) and the Host allowlist `<TS name>:8443,<TS name>,127.0.0.1:8090`. The service reaches the api inside the network (`http://api:8080`) with the caller's own bearer; it cannot reach the Serve address and does not need to. `names.sh` has `MCP_URL` and the two Serve mappings (`8443:/mcp` and `8443:/.well-known/oauth-protected-resource/mcp`, both to `127.0.0.1:8090`); `deploy.sh` writes `SBX_MCP_PUBLIC_URL` into `.env`.

The tokens come from the realm client `sbx-mcp` (redirect URIs `http://127.0.0.1:33418/*`, `http://localhost:33418/*`, in the base realm; nothing dev-specific). Clients are configured in `apps/mcp/README.md` with the Serve URL.

## People, e2e and the quick start

- `dev-users.sh` creates `ilia@example.com` (temporary password in `~/.config/sbx/dev-cp/ilia-initial-password` on the Mac, 0600) and `e2e@example.com` (permanent password in `~/.config/sbx/dev-cp/e2e-password`). The realm takes the email as the username; Keycloak 26 needs first and last name, or the login stops at the profile form. Each gets a personal team with the owner role at the first login.
- `e2e.sh [--keep-going]` runs the whole scenario from the Mac with the real CLI and both SDKs, prints a PASS/FAIL table and checks that nothing is left on `pve`. It uses its own CLI config (mktemp), `kc-browser.py` for the Keycloak pages and `e2e-pty.py` for `sbx shell`. About 5 minutes, at most two 2 GB sandboxes at once. The work dir (tokens, SSH key) is deleted at the end; `SBX_E2E_KEEP_WORKDIR=1` keeps it.
- `QUICKSTART.md`: the short guide for Ilia (Russian).

## Smoke test

```
infra/dev-cp/smoke.sh [--keep]
```

Builds the dev-signed agent package (`services/guest-agent/test/linux/run.sh`, `BUILD_ONLY`, `TUNNEL_CA` = the dev CA), registers a machine (bootstrap secret hash in `tunnel.tunnel_credentials`), clones one 2 GB VM from template 599 into the free VMID nearest to 589 with the machine's smbios, and checks from the VM that the CT answers on 443 only (not 22, 2222, 5432, 7000, 8080, 9090, 9190, ping), that the host (LAN and `10.88.0.1`), the router and a LAN guest are closed, and that the internet is open. Then it checks that the tunnel host resolves to the CT through the VM's own DNS (not `/etc/hosts`), installs the agent as the S3 stand does (`stand-setup.sh install`, a package that pins the dev CA) with the tunnel URL in the smbios `family`, checks `sbx-agent doctor` (URL from `smbios`), waits for a `connected` row in `tunnel.tunnel_sessions` and calls `System/Info` through `@sbx/agent-client` in the worker container with the worker's service token. The VM and the database rows are removed at the end. About 4 minutes.

### S10: host access and template slots

S10 runs tools against the host IP, with TLS SNI kept separate:

```sh
export SBX_PVE_URL=https://100.64.10.2:8006
export SBX_PVE_TLS_NAME=pve
export SBX_NODE_SSH_HOST=100.64.10.2
export SBX_TEMPLATE_VMID_RANGE=595-596
export SBX_VMID_RANGE=580-589
# Reuse the existing verified host key when connecting by IP; do not disable verification.
ssh -o BatchMode=yes -o HostKeyAlias=pve.tail0000.ts.net root@100.64.10.2 qm list
```

Desktop template slots: **596** `linux-desktop`, **595** `windows-desktop` (one slot each,
like `windows` in 598); sandbox clones use **500–589**.
CT 590 remains unchanged. Do not modify templates 597/598/599/9000/9001.
Before starting any VM, inspect `qm list`. Master allocated S9 up to 4 GiB and
S10 up to 4 GiB concurrently; all running 500–599 VMs together may use at most 8 GiB.
S10 verification stops the source before booting its fork. Never stop an S9 VM.

After building with `--no-verify`, run `mise exec -- node infra/dev-cp/verify-desktop.ts <buildId>`
and `mise exec -- node infra/dev-cp/spike-desktop.ts <buildId>` with the host environment above.
Both check `qm list` before every start and remove their disposable clones. The spike
uses a private debug socket only on its clone; it does not verify public gateway media.

The dev config is generated by `deploy.sh` from `deploy/compose/config/sbx.yaml`;
it includes `linux-desktop` (default 4gb, allowed 4gb/8gb) and no pool target.
The checked builds are `linux-desktop 20261101.2` (VMID 596, agent 0.1.0+20261101.fabc0b94, s10-fix), `windows-desktop 20261101.6` (VMID 595, agent 0.1.0+20261101.b84f61b8, patched moonlight-web, s10-followups) and `windows 20261101.1` (VMID 598, agent 0.1.0+20261101.767aace0, win598-rebuild).
Before a `windows-desktop` build run `infra/templates/windows-desktop/moonlight-web/build.sh`.
`deploy.sh` generates the dev topology from this same config. A rebuild of a one-slot
recipe needs its old template retired first. Always limit cleanup/retire to the one slot
being rebuilt with `SBX_TEMPLATE_VMID_RANGE` (`595-596` for S10, `598-598` for the
`windows` rebuild in S9 §24.10); never run it across the other template slots.

`verify-desktop.ts` passed the Linux baseline, restart and fork checks. The direct
`spike-desktop.ts` passed1920x1080 capture, mouse/Unicode keyboard proof, clipboard,
Sunshine/Moon pairing, fresh credentials after fork and stop/resume. It uses one4GiB
VM at a time and deletes its clones/snapshot. A replacement signed agent package may
be supplied via `SBX_SPIKE_AGENT_PACKAGE` for diagnosis; this is not needed for596.

Public acceptance is `infra/dev-cp/e2e-desktop.sh` after branch deploy and TURN setup.
It checks qm list before create/fork/resume, stops the source before fork, and uses
pinned Playwright Chromium for websocket/webrtc frame diffs plus live streamer state.
Install the browser with `mise exec -- pnpm --filter @sbx/web exec playwright install chromium`
if absent. Artifacts are0600 in a private temp dir; ticket URLs/credentials are not printed.

Still required for CT590: a dedicated reachable TURN address for TLS443 and its
certificate/key under compose secrets/turn, worker TURN URLs and the desktop compose
profile. The current dev gateway already occupies443; assigning the TURN listener
and firewall rules is a separate network change (notify master and use auto rollback).
CT590 was not redeployed for S10 in this pass. Public create/media/TURN and long-idle
viewer checks have not run; direct pairing and HTML alone do not prove video transport.

Dev TURN runs in the desktop compose profile on CT590's existing address: UDP/TCP3478 and
TLS5349 are published from its own network namespace (the address is on `lo` inside it);
the UDP relay range 61000–61040 lies above the CT's ephemeral ports (32768–60999), is
reserved in that namespace and is not published (s10-fix2; was 49160–49200 on the host
network). deploy.sh writes `SBX_TURN_*` into `.env`. The PVE firewall of 590 accepts only
UDP 3478 and TCP 3478/5349 from the LAN for TURN; the old `udp 49160:49200` accept was
removed on 2026-11-01 (with a rollback timer, `verify-turn.py` green afterwards).

CT590's `/etc/nftables.conf` (s10-fix2, also written by `infra/pve/setup.sh cp`) manages
only `table inet filter`; Debian's `flush ruleset` would also drop Docker's iptables-nft
rules, so a `systemctl reload nftables` cut every published port. The original file is
kept as `/etc/nftables.conf.before-s10-fix2` in the CT. The TURN relay table lives in the
TURN namespace and is untouched by host reloads; the TURN entrypoint watches it every 2 s
and exits (compose restarts it with a fresh table) when it is removed or changed, or when the TURN address leaves `lo` (s10-followups; the healthcheck checks both). The entrypoint is bind-mounted; deploy.sh puts its hash into `.env` and turn.yaml into a label, so a changed entrypoint recreates the container. `turn-cert.sh` issues a leaf below the existing
CA's permitted tunnel namespace (`turn.$TUNNEL_HOST`), preserving the CA trusted by
images. CT memory remains6GiB. Production TLS443/dedicatedIP/SNI is a follow-up.

Firewall changes use `turn-firewall.py apply` **only after telling master and arming
an automatic rollback timer**. `rollback` removes only tagged S10 rules and preserves
concurrent edits. Compile/check gateway and SSH before cancelling the timer.
`mise exec -- python infra/dev-cp/verify-turn.py` tests actual UDP/TCP/TLS allocation,
peer restrictions, relay-to-relay media, the relay port filter (host sockets on the TURN
address — `:40123`, tailscaled `:41641` and a listener inside the relay range — unreachable)
and expiry on Refresh without logging the REST secret. `SBX_TURN_PROBE_GUARD=1` adds the
fail-closed probe: delete the table with `docker exec` (relaying must stop within seconds and
recover with the table), then `systemctl reload nftables` in the CT via `pct exec` (TURN must
keep relaying, its table intact).
`desktop-block-probe.ts` (operator block) and `desktop-cache-probe.ts` (no screenshots in
the agent `state.db`) are separate live probes; both need the logged-in CLI on PATH. Upstream
coturn keeps an allocation's password after the REST timestamp expires, so the product
image builds pinned 4.18.0 source with `refresh-auth.patch`, which revalidates Refresh
through the existing credential callback. The source URL and hash, upstream license and
patch are kept in the image.

For long-idle media acceptance use `SBX_DESKTOP_IDLE_HOLD_MS=1800000` with
`e2e-desktop.sh`. It checks real MCP tools, forces relay-only WebRTC, verifies the
selected relay-to-relay pair and watches DB activity without API calls that would
refresh the idle timer. Diagnostics, screenshots and observations are written only
to its private temporary output directory. The branch may stay deployed after this
run; master restores main after merges.

Set `SBX_DESKTOP_TURN_TRANSPORTS=udp,tcp,tls` to run a separate relay-only media check
per client-to-TURN transport. Each check filters the browser's ICE URLs, verifies the
selected relay protocol and requires a changed live frame. UDP is the default; the long
idle hold applies to the first selected transport only, and that transport is closed
naturally (no EndStreams) so idle-stop is measured from a real page close.

VM egress to TURN is UDP 3478 only. The E2E checks STUN reachability and blocked TCP/TLS
from the guest before media; browser TCP/TLS access is checked separately.

`SBX_DESKTOP_TEST_AGENT_PACKAGE` (optional, diagnostics only) installs a signed agent
update on the disposable clone; acceptance runs leave it unset and test the template's
own agent.

Linux acceptance (2026-11-01, build 20261031.6 in 596, agent 0.1.0+20261031.4865e13):
109-check profile, public create 14.4–18.4 s, real MCP tools, WebSocket and relay-only
UDP/TCP/TLS frame diffs, 30 min viewer hold without API calls. With a 60 s idle timeout
the sandbox stopped 78.1 s after EndStreams and 98.8 s after a natural page close. Fork
credentials, resume, old-cookie 401 and deletion passed.

Windows acceptance (2026-11-01, `windows-desktop 20261101.2` in 595): run
`SBX_E2E_TEMPLATE=windows-desktop infra/dev-cp/e2e-desktop.sh`. The Windows variant types into
the Run dialog (opened by a one-shot interactive task, since exec runs in session 0), reads
agent state through QGA as SYSTEM and retries `503 desktop_starting` with a fresh ticket.
Create 139–146 s, first stream open ~22 s. `SBX_E2E_SANDBOX=<slug>` reuses an existing sandbox
for diagnostics (it is not deleted; idle observation needs the `e2e=desktop` label).
