# Dev control plane on `pve` (CT 590)

## Create and remove

```
infra/pve/setup.sh cp            # create or update CT 590, Docker, Tailscale package, CT firewall
infra/pve/setup.sh cp-gateway    # CT address into IPSet umiak-gateway (3-minute automatic rollback)
infra/pve/setup.sh cp-tailscale  # tailscale up; prints the login URL until the node is approved
infra/pve/setup.sh revert cp-gateway
infra/pve/setup.sh revert cp
```

Environment: `UMIAK_CP_CTID` (590), `UMIAK_CP_IP`, `UMIAK_CP_GW`, `UMIAK_CP_LAN`, `UMIAK_CP_HOSTNAME`, `UMIAK_CP_SSH_PUBKEY` (`~/.ssh/id_ed25519.pub`, goes to `root` and `umiak`), `UMIAK_CP_LAN_TCP` (ports open to the LAN). `cp` refuses an address that is configured on a guest or answers ARP, and refuses to create the CT if the host would keep less than 4 GB available after the CT and the sandbox budget.

## Firewall

| Path | Allowed |
|---|---|
| sandbox → CT | tcp/443 only: group `umiak-egress` accepts `+umiak-gateway` on tcp/443 before it drops private ranges. Sandboxes arrive SNAT-ed from the host LAN address |
| sandbox → host, router, other LAN guests, other CT ports | nothing (group `umiak-egress`) |
| LAN → CT | tcp 22 (SSH), 443 (gateway TLS), 2222 (gateway SSH), 8080 and 4180 (unused since Serve, see Names and TLS), ping, udp 41641 (Tailscale direct). Policy `DROP` for the rest (`/etc/pve/firewall/590.fw`) |
| tailnet → CT | everything that listens on a non-loopback address, plus Tailscale Serve on 8443 and 10000; tailnet traffic is inside WireGuard and does not pass the Proxmox firewall |
| Postgres, worker 9090, gateway 7000/9190 | loopback of the CT only |

`smoke.sh` checks the sandbox side from a real VM.

## Access

- LAN: `ssh umiak@192.168.68.90` (and `root@`).
- Outside the LAN: after `cp-tailscale` is approved, `ssh umiak@umiak-dev-cp` (MagicDNS name) or the tailnet IP from `tailscale ip -4` in the CT.
- Worker and gateway health on the CT: `ssh -L 9090:127.0.0.1:9090 -L 9190:127.0.0.1:9190 umiak@192.168.68.90`, then `curl 127.0.0.1:9090/readyz`.

## Names and TLS

All names are set in `names.sh`. sslip.io is a public wildcard DNS (`<a-b-c-d>.sslip.io` → `a.b.c.d`); it answers DNS only, traffic goes straight to the CT. Tailscale Serve terminates TLS on the CT itself. No traffic relay is involved.

| Who | URL | Address | Certificate |
|---|---|---|---|
| Agents in sandboxes | `wss://tunnel.192-168-68-90.sslip.io/v1/connect` | LAN `192.168.68.90:443`, gateway | dev CA, pinned by the agent |
| Previews (browser) | `https://<slug>-<port>.umiak.100-64-10-7.sslip.io` | tailnet `100.64.10.7:443`, gateway | dev CA (wildcard) |
| Dashboard `web` (S8) behind oauth2-proxy (S7) | `https://umiak-dev-cp.tail0000.ts.net:8443/` (`/app`, `/admin`; `/api/*`, `/umiak-auth/*` → api) | Tailscale Serve → `127.0.0.1:4180` | Let's Encrypt (Serve) |
| api public listener (S7, CLI, SDK) | `https://umiak-dev-cp.tail0000.ts.net:8443/v1/…` | Tailscale Serve → `127.0.0.1:8080/v1` | Let's Encrypt (Serve) |
| MCP server (S11) | `https://umiak-dev-cp.tail0000.ts.net:8443/mcp` | Tailscale Serve → `127.0.0.1:8090/mcp` (plus `/.well-known/oauth-protected-resource/mcp`) | Let's Encrypt (Serve) |
| Keycloak (S7) | `https://umiak-dev-cp.tail0000.ts.net:10000/` | Tailscale Serve → `127.0.0.1:8180` | Let's Encrypt (Serve) |
| SSH gateway (S4) | `ssh -p 2222 <slug>@umiak-dev-cp.tail0000.ts.net` | tailnet or LAN, port 2222 | gateway host keys |

Why it is split this way:

- Sandboxes use public DNS (1.1.1.1 from `umiak0`), are not on the tailnet, and can reach only `192.168.68.90:443`. The gateway rejects TLS without SNI, so agents need a public name for the LAN address.
- Serve gives a trusted certificate only for the MagicDNS name, without wildcards, and only on ports 443, 8443 and 10000. Previews need a wildcard, so they keep a dev CA certificate on sslip.io.
- The gateway routes a preview only when `Host` has no port or `:443` (S4 §4.2). So 443 of the tailnet address belongs to the gateway, and Serve uses 8443 and 10000: `/` of 8443 goes to oauth2-proxy (web, `/api/*`, `/umiak-auth/*` as on `app.<domain>`), `/v1` of the same port goes to the api public listener (the path is kept), `/mcp` and `/.well-known/oauth-protected-resource/mcp` go to the MCP server (S11, same). Serve intercepts its ports on the tailnet address before Docker sees them; with 443 in Serve, previews would break, so `deploy.sh` refuses it. The gateway publishes 443 on all CT addresses; nothing else listens there.
- Serve passes `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto: https` and the `Tailscale-User-*` headers. The api never takes an identity from `Tailscale-User-*` (tests in `apps/api`: public and proxied listener, every operation); S8 must not either.

**Dev CA.** `dev-ca.sh` (run by `deploy.sh`) creates `~/.config/umiak/dev-ca/ca.pem` and `ca.key` on the Mac once (ECDSA P-256, 10 years, outside git, 0600). Name constraints limit it to `tunnel.192-168-68-90.sslip.io` and `umiak.100-64-10-7.sslip.io`. `deploy.sh` copies it to `~/.config/umiak/dev-ca/` on the CT (0600) and into `deploy/compose/secrets/gateway/`; the gateway's `dev-secrets` (S4) then issues `tunnel.pem` and `umiak.pem` (`*.umiak.…`, 397 days) with it. A new CA or new names make `deploy.sh` reissue both; it also renews them 30 days before expiry. Other names need a new CA: move `~/.config/umiak/dev-ca` away, run `deploy.sh` and `trust-mac.sh` again, and rebuild agent packages that pin the old one.

**Tailscale Serve.** `infra/pve/setup.sh cp-tailscale` makes `umiak` the Tailscale operator; `deploy.sh` rebuilds the Serve config from `UMIAK_DEVCP_SERVE` (`<https port>:<path>=<target>` words, default in `names.sh`) with `tailscale serve reset` and `tailscale serve --bg`. A target that does not listen answers `502`. HTTPS certificates must be enabled in the tailnet (they are: `tailscale status --json` lists `CertDomains`).

### The Mac

The dashboard, api, CLI and Keycloak need nothing: their certificate is a public Let's Encrypt one. Only previews in a browser need the dev CA:

```
infra/dev-cp/trust-mac.sh            # adds ca.pem to the login keychain (no sudo; macOS asks for the password)
infra/dev-cp/trust-mac.sh --remove
```

curl without the keychain: `curl --cacert ~/.config/umiak/dev-ca/ca.pem https://x-y-z-3000.umiak.100-64-10-7.sslip.io/`. Without api the gateway answers `503 route_lookup_unavailable`, with api `404 route_not_found` for an unknown sandbox.

The `umiak` CLI (S7) talks to the api on the Serve name (`umiak login --api-url https://umiak-dev-cp.tail0000.ts.net:8443`), so it needs no CA option for this stack. A CA option (`--cacert` / `UMIAK_CA_FILE`; `NODE_EXTRA_CA_CERTS` under Node already works) comes later for installations with a private CA.

### How agents get the name and the CA

- **URL:** the smbios `family` field, `umiakt1:wss://tunnel.192-168-68-90.sslip.io/v1/connect` (S5 §14), which wins over `agent.toml`. `deploy.sh` sets `UMIAK_TUNNEL_URL` for the worker, which writes `family` into `smbios1` of every new machine (S5 §17.4 p. 3); `smoke.sh` sets it by hand for its 597 clone.
- **CA:** the agent pins `trust/tunnel-ca.pem` from its signed package. S5 template builds for this stack must pack the dev CA: `umiak-release pack --tunnel-ca ~/.config/umiak/dev-ca/ca.pem …` (on the CT, `~/.config/umiak/dev-ca/ca.pem`); `services/guest-agent/test/linux/run.sh` takes `TUNNEL_CA=<pem>` for the same. `[tunnel] trust_dir` in `agent.toml` also works but is not the template path.

## Deploy

```
infra/dev-cp/deploy.sh [--dry-run]
```

1. Runs `dev-ca.sh`. Copies the working tree (`git ls-files`, ignored files excluded) to `~/umiak` on the CT and removes files that are gone. `deploy/compose/secrets/` and `deploy/compose/.env` stay.
2. Copies `pve-token`, `pve-root-ca.pem`, `umiak-node_ed25519`, `known_hosts` and `dev-ca/ca.{pem,key}` from `~/.config/umiak` to `~/.config/umiak` on the CT (mode 0600). `known_hosts` gets the host key pinned for the host LAN address too.
3. Checks the CT's MagicDNS name against `names.sh`, puts the dev CA into `secrets/gateway` when it changed, writes `deploy/compose/.env` (below), `secrets/devcp/umiak.yaml` (the PVE API on the LAN address) and `secrets/data-keys.json` once. Stand-only random DB/dev-user passwords are stored in `secrets/devcp/{postgres-password,dev-user-password}` and the private `.env` (0600); local compose defaults are unchanged.
4. On the first S8 deploy (Postgres runs, `identity.users` exists, `payload.payload_migrations` does not) stops `api` and `worker` (`docker compose stop api worker`): the pre-S8 api writes into `identity` while `web-migrate` copies it into `payload`, and rows written after the copy would be lost (S8 §21.2). Later deploys skip this step.
5. `docker compose up -d --build --remove-orphans`, waits until `worker`, `gateway`, `api`, `oauth2-proxy`, `web` and `mcp` are healthy (the first Keycloak start takes a minute or two), prints the worker, gateway, api and mcp `/readyz`, applies the Serve config.
6. From the Mac, with real DNS: the tunnel host and a preview host with the dev CA, each Serve port, the api `/v1/meta` and the MCP protected resource metadata with the system trust store.

`.env`: `COMPOSE_FILE` (the stack plus `compose.dev-cp.yaml`), `UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME`, `UMIAK_NODE_SSH_HOST` (host LAN address `192.168.68.116`), `UMIAK_PVE_SECRETS_DIR`, the names (`UMIAK_DEVCP_TUNNEL_HOST`, `UMIAK_TUNNEL_URL`, `UMIAK_PORT_DOMAIN`, `UMIAK_DEVCP_SSH_HOST`) and the public URLs (`UMIAK_DEVCP_TS_NAME`, `UMIAK_APP_ORIGIN`, `UMIAK_API_PUBLIC_URL`, `UMIAK_MCP_PUBLIC_URL`, `UMIAK_KEYCLOAK_URL`, `UMIAK_OIDC_ISSUER`, `UMIAK_GATEWAY_AUTH_URL`, `UMIAK_OAUTH2_PROXY_REDIRECT_URL`, `UMIAK_LOGOUT_URL`).

`compose.dev-cp.yaml` overrides only what the CT needs: the names for `gateway-secrets`, `gateway` and `worker` (`UMIAK_TUNNEL_URL`, `UMIAK_PORT_DOMAIN`), the gateway ports (443 and 2222 on all addresses, the rest on loopback), the `umiak.yaml` mount of `migrate` (api and worker read the config from Payload since S8), and the S7/S8 services behind Serve (below). Each value it takes from `.env` is required (`${VAR:?set by deploy.sh}`), so a stale `.env` fails `docker compose config` instead of falling back to localhost.

Environment: `UMIAK_DEVCP_SSH` (`umiak@192.168.68.90`, or `umiak@umiak-dev-cp` over the tailnet), `UMIAK_DEVCP_COMPOSE_FILES` (`compose.yaml:gateway.yaml`), `UMIAK_DEVCP_ENV` (extra lines for `.env`), `UMIAK_PVE_LAN_IP`; names: `UMIAK_CP_IP`, `UMIAK_CP_TAILNET_IP`, `UMIAK_DEVCP_TS_NAME`, `UMIAK_DEVCP_TUNNEL_HOST`, `UMIAK_DEVCP_PORT_DOMAIN`, `UMIAK_DEVCP_SERVE`, `UMIAK_DEVCP_CA_DIR`.

On the CT, `cd ~/umiak/deploy/compose`; `docker compose ps|logs|exec` pick up `COMPOSE_FILE` from `.env`.

### S7 behind Tailscale Serve (api, Keycloak, oauth2-proxy)

Checked on CT 590 by `e2e.sh` (`docs/plans/e2e-devcp.md`): every service healthy, Serve on `:8443` and `:10000`, discovery keeps the public issuer with `:10000` while containers use `http://keycloak:8080`, `umiak login` (device grant), browser login through oauth2-proxy, token and SSO ports, SSH through the gateway.

- A Keycloak database left from an earlier import keeps old redirect URIs: drop the `keycloak` database if the browser login ends in `redirect_uri` mismatch.
- Keycloak runs with a fixed heap (`-Xmx512m`, `mem_limit: 1200m`): without a limit of its own the JVM sizes its heap from the host's RAM and starves the 3 GB CT.
- The single gateway drains for 20 s (`UMIAK_GATEWAY_DRAIN_TIMEOUT`, `stop_grace_period: 30s`) instead of the product 950 s: there is no peer to drain to, and a recreated gateway would keep the stack down for 16 minutes.

`compose.yaml` has the S7 services and includes `gateway.yaml`; `compose.dev-cp.yaml` publishes them on loopback for Serve and feeds them the `.env` values. The product compose takes the same public URLs as generic variables with localhost defaults (`deploy/compose/README.md`, "Public addresses"); the override repeats the ones from `.env` as required values (`${VAR:?}`) so the CT never runs with a localhost default, and adds what the base leaves neutral (Keycloak proxy headers, trusted proxies, the `__Host-` cookie, cross-site port cookies).

| Service | Publish (base compose) | Settings |
|---|---|---|
| oauth2-proxy | `127.0.0.1:4180:4180` | `OAUTH2_PROXY_REDIRECT_URL=${UMIAK_OAUTH2_PROXY_REDIRECT_URL}`, issuer and login URL from `UMIAK_OIDC_ISSUER` (alpha config, `skipDiscovery`; redeem, JWKS and profile on `http://keycloak:8080/realms/umiak/…`), `OAUTH2_PROXY_REVERSE_PROXY=true`, cookie `__Host-umiak_session` with `Secure`, whitelist `<TS name>:8443` (post-login) and `<TS name>:10000` (sign-out to Keycloak); upstreams `/api/` → api `:8081` (prefix stripped), `/umiak-auth/` → api `:8081`, `/` → web `:3000` |
| api | `127.0.0.1:8080:8080`, ops `127.0.0.1:9091` | `UMIAK_OIDC_ISSUER=${UMIAK_OIDC_ISSUER}` (discovery and JWKS on `http://keycloak:8080` from the base), `UMIAK_APP_ORIGIN`/`UMIAK_APP_URL=${UMIAK_APP_ORIGIN}`, `UMIAK_API_URL=${UMIAK_API_PUBLIC_URL}`, `UMIAK_PREVIEW_DOMAIN=${UMIAK_PORT_DOMAIN}`, `UMIAK_SSH_HOST=${UMIAK_DEVCP_SSH_HOST}` port 2222, `UMIAK_API_TRUSTED_PROXY_CIDRS=172.16.0.0/12,127.0.0.1/32` |
| Keycloak | `127.0.0.1:8180:8080` | `KC_HOSTNAME=${UMIAK_KEYCLOAK_URL}` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` from the base), `KC_HTTP_ENABLED=true`, `UMIAK_KEYCLOAK_PROXY_HEADERS=xforwarded` and `UMIAK_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` as the api (→ `KC_PROXY_HEADERS`, `KC_PROXY_TRUSTED_ADDRESSES`); realm `umiak` with the Serve redirect URI and web origin |
| gateway | as before | `UMIAK_GATEWAY_AUTH_URL=${UMIAK_GATEWAY_AUTH_URL}` (`https://<TS name>:8443/umiak-auth/authorize`), `UMIAK_GATEWAY_COOKIE_CROSS_SITE=true` (the preview domain and the dashboard are different sites) |
| web (S8) | not published; only on the `web-internal` network (oauth2-proxy, postgres) | `/` upstream of oauth2-proxy; `UMIAK_APP_ORIGIN=${UMIAK_APP_ORIGIN}`, `UMIAK_PREVIEW_DOMAIN=${UMIAK_PORT_DOMAIN}` (CSP `frame-src https://*.<port domain>`), `UMIAK_API_PUBLIC_URL=${UMIAK_API_PUBLIC_URL}`, `UMIAK_LOGOUT_URL=${UMIAK_LOGOUT_URL}` (`names.sh` `LOGOUT_URL`: Keycloak end-session on `:10000`, `client_id=oauth2-proxy`, back to `https://<TS name>:8443/app`) |
| web-migrate, worker (S8) | — | `web-migrate` applies the Payload migrations before api, worker and web; the worker runs `ctl-idp-sync` against `http://keycloak:8080` (client `umiak-worker`) from the base compose |

- Containers on the CT cannot reach the Serve address (checked: `ECONNREFUSED` from the worker container to `100.64.10.7:10000`; the CT itself can). So every service talks to Keycloak as `http://keycloak:8080` while tokens keep the public issuer `https://<TS name>:10000/realms/umiak` (`KC_HOSTNAME_BACKCHANNEL_DYNAMIC`).
- Keycloak clients: `oauth2-proxy` redirect URI `https://umiak-dev-cp.tail0000.ts.net:8443/oauth2/callback`, web origin `https://umiak-dev-cp.tail0000.ts.net:8443`; `umiak-cli` is a public device-flow client without redirect URIs. The realm is imported into an empty Keycloak only: after changing the names, drop the `keycloak` database (`deploy/compose/README.md`, «Keycloak»).
- Client addresses: Serve connects to the published loopback ports, and Docker hands the connection to the container from the bridge gateway (`172.x.0.1`); oauth2-proxy calls the api from its container address. Both are in `172.16.0.0/12` (Docker's default bridge pools), so `X-Forwarded-For` from them gives the tailnet client in the api log (`clientIp`). Any container in the `umiak` network can forge it too; it only affects logs.
- Keycloak admin: `https://umiak-dev-cp.tail0000.ts.net:10000/admin`, password on the CT in `~/umiak/deploy/compose/secrets/keycloak/admin-password`. Dev user `dev@example.com`, temporary password `dev`. Ilia and the e2e user: `dev-users.sh` (below).
- The LAN firewall still admits 8080/4180, which are now unused; nothing listens there on the LAN.

### S8 dashboard (web)

> **R1 live acceptance complete.** The fresh Umiak deployment on CT 590 has nine healthy services. E2E login, personal team, normal-user 403 and temporary-operator 200 gates, full proxy/Keycloak logout, and the live desktop iframe/CSP passed. Linux and Windows desktop acceptance also passed relay-only UDP/TCP/TLS and a full 30-minute idle hold. Operational checklist for later deployments:
> - `docker compose ps -a`: `web-migrate` and `migrate` `Exited (0)`, `web` healthy; `docker compose logs web-migrate` lists the applied migrations (an existing S7 volume: the identity rows are copied into `payload` by the first one). api `/readyz` 200 (it checks the Payload migrations).
> - Browser `https://<TS name>:8443/` → Keycloak (`:10000`) → `/app` → the personal team; `/api/v1/me` 200 with `"auth": {"kind": "session"}` and the same user and team ids as the dashboard.
> - `/admin`: 403 "Operators only" for `dev@example.com`; after joining `umiak-operators` in Keycloak and signing in again: the admin and `/app/operator`.
> - Sign out (user menu): `/oauth2/sign_out?rd=…` → Keycloak `:10000` logout page → back on `https://<TS name>:8443/app` and a new login. A Keycloak database imported before S8 already has `post.logout.redirect.uris` `<app origin>/*` (S7 realm); if Keycloak answers `Invalid redirect uri`, add it to the client `oauth2-proxy` or drop the `keycloak` database.
> - A preview of a published `sso` port opens in the dashboard's sandbox page (frame from `*.umiak.100-64-10-7.sslip.io` with the cross-site port cookie); no CSP errors in the browser console.
> - `web:3000` is not reachable from a container on the `umiak` network (`deploy/compose/README.md`, «web (S8)»), and nothing listens on 3000 on the CT.
> - `worker` log: `ctl-idp-sync` passes without `KeycloakError` (the service account `umiak-worker` has `view-users`).
> - Postgres `SHOW max_connections` is 200.

**First S8 deploy onto an S7 volume.** Stop `api` and `worker` before it (`docker compose stop api worker` on the CT, in `deploy/compose`): the old api writes into `identity` while the first Payload migration copies it, and rows written after the copy are not moved (S8 §21.2). `deploy.sh` does this itself when Postgres runs with `identity.users` and without `payload.payload_migrations` (step 4 of «Deploy»); by hand, do it before `docker compose up`.

`deploy.sh` writes `UMIAK_LOGOUT_URL` from `names.sh` and waits for `web` too. The api and worker take templates, sizes and quotas from Payload now; `secrets/devcp/umiak.yaml` is read only by `migrate` (topology and template builds).

### S11 MCP behind Tailscale Serve

> **R1 live acceptance complete.** MCP is healthy behind Serve. The new realm/client passed authorization code + PKCE, issuer/audience/azp checks, 38 tools, a live limits call, refresh and a repeated call. A new read-only team key exposed 11 scoped tools; the test key was revoked. Compiled `umiak mcp` stdio also passed initialize/list/call and exited on EOF. Operational checklist for later deployments:
> - `docker compose ps` on the CT: `mcp` healthy; `curl http://127.0.0.1:9092/readyz` answers 200.
> - Which `Host` Serve passes to the target: the MagicDNS name with `:8443` or `127.0.0.1:8090`. Both are in `UMIAK_MCP_ALLOWED_HOSTS` (`compose.dev-cp.yaml`); a `421 this Host is not served here` from `/mcp` through Serve means a third form, add it there.
> - `curl -i https://<TS name>:8443/mcp -X POST -H 'content-type: application/json' -d '{}'` answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://<TS name>:8443/.well-known/oauth-protected-resource/mcp"`; that metadata names `authorization_servers: ["https://<TS name>:10000/realms/umiak"]`.
> - Two Serve paths on one port (`/mcp` and the dot-prefixed `/.well-known/...`) next to `/` and `/v1`: `tailscale serve status` lists all four mappings of 8443.
> - A team key (`Authorization: Bearer umiak_...`) and the browser sign-in of the `umiak-mcp` client with each client from `apps/mcp/README.md`.

`compose.dev-cp.yaml` gives the `mcp` service the public URL `UMIAK_MCP_PUBLIC_URL=https://<TS name>:8443/mcp` (from `.env`, required), the issuer `UMIAK_OIDC_ISSUER` (the protected resource metadata names it; Keycloak tokens carry the public issuer) and the Host allowlist `<TS name>:8443,<TS name>,127.0.0.1:8090`. The service reaches the api inside the network (`http://api:8080`) with the caller's own bearer; it cannot reach the Serve address and does not need to. `names.sh` has `MCP_URL` and the two Serve mappings (`8443:/mcp` and `8443:/.well-known/oauth-protected-resource/mcp`, both to `127.0.0.1:8090`); `deploy.sh` writes `UMIAK_MCP_PUBLIC_URL` into `.env`.

The tokens come from the realm client `umiak-mcp` (redirect URIs `http://127.0.0.1:33418/*`, `http://localhost:33418/*`, in the base realm; nothing dev-specific). Clients are configured in `apps/mcp/README.md` with the Serve URL.

## People, e2e and the quick start

- `dev-users.sh` creates `ilia@example.com` (temporary password in `~/.config/umiak/dev-cp/ilia-initial-password` on the Mac, 0600) and `e2e@example.com` (permanent password in `~/.config/umiak/dev-cp/e2e-password`). The realm takes the email as the username; Keycloak 26 needs first and last name, or the login stops at the profile form. Each gets a personal team with the owner role at the first login.
- `e2e.sh [--keep-going]` runs the whole scenario from the Mac with the real CLI and both SDKs, prints a PASS/FAIL table and checks that nothing is left on `pve`. It uses its own CLI config (mktemp), `kc-browser.py` for the Keycloak pages and `e2e-pty.py` for `umiak shell`. About 5 minutes, at most two 2 GB sandboxes at once. The work dir (tokens, SSH key) is deleted at the end; `UMIAK_E2E_KEEP_WORKDIR=1` keeps it.
- Fresh dev Payload default team quota and new shared-team quota: RAM 8192 MB, equal to the sandbox node cap. This is stand data; the product default stays 6144 MB. Pool targets are empty.

## Smoke test

```
infra/dev-cp/smoke.sh [--keep]
```

Clones one 2 GB VM from the verified Linux template 597 into the free VMID nearest to 589,
registers its bootstrap secret hash in `tunnel.tunnel_credentials`, and configures only its
own firewall group and assigned DHCP IPv4 filter (sealed templates clear their build firewall).
Checks CT/host/router/LAN isolation plus Internet/DNS, then compares the baked agent's pinned
CA with the gateway CA and checks its active units and `umiak-agent doctor` (URL source smbios).
Calls `System/Info` through `@umiak/agent-client` in the worker with its service token.
It installs no diagnostic agent and never changes the baked update trust root. The disposable
VM and exact tunnel rows are deleted afterwards. Use a host rollback timer for firewall work;
about three minutes.

### S10: host access and template slots

S10 runs tools against the host IP, with TLS SNI kept separate:

```sh
export UMIAK_PVE_URL=https://100.64.10.2:8006
export UMIAK_PVE_TLS_NAME=pve
export UMIAK_NODE_SSH_HOST=100.64.10.2
export UMIAK_TEMPLATE_VMID_RANGE=595-596
export UMIAK_VMID_RANGE=580-589
# Reuse the existing verified host key when connecting by IP; do not disable verification.
ssh -o BatchMode=yes -o HostKeyAlias=pve.tail0000.ts.net root@100.64.10.2 qm list
```

Current template slots (S17): **597** `linux`, **596** `linux-desktop`, **595** `windows` (Windows 11 with desktop). VM **598** (the old headless Windows build) was deleted on 2026-11-04 with Ilia's approval; its catalog build stays `retired`. Slots 598 and 599 are free. The three template VMs are read-only on the active stand: no rebuilds or deletes. Sandbox clones use **500–589**, with at most 8 GiB RAM total. Never touch 9000/9001 or VMs below 500; never stop another user's VM to make room.

The build/verification notes below are historical R1 evidence, not authorization to rebuild the live stand.

After a Linux desktop build with `--no-verify`, run
`mise exec -- node infra/dev-cp/verify-desktop.ts <buildId>` and
`mise exec -- node infra/dev-cp/spike-desktop.ts <buildId>` with the host environment above.
For Windows desktop use the standard `umiak-tpl verify <buildId>`: it selects the Windows
verifier and QGA/VSS operations; the two desktop helper scripts above are Linux-only.
Both check `qm list` before every start and remove their disposable clones. The spike
uses a private debug socket only on its clone; it does not verify public gateway media.

The dev config is generated by `deploy.sh` from `deploy/compose/config/umiak.yaml`;
it includes `linux-desktop` (default 4gb, allowed 4gb/8gb) and no pool target.
The R1 checked builds all pin the new dev CA and agent `0.1.0+20261101.087b3f3a`:

| Recipe | VMID | Version | Builder manifest | Connected build verify PASS / INFO / FAIL |
|---|---|---|---|---|
| `linux` | 597 | `20261101.1` | `01a1991c-0aa8-77af-94fa-6e4ec1e9a24f` | 99 / 2 / 0 |
| `linux-desktop` | 596 | `20261101.3` | `01a1992c-8cdc-7036-802a-fa52d23f7056` | 107 / 2 / 0 |
| `windows` (desktop; formerly `windows-desktop`) | 595 | `20261101.7` | `01a1993d-3986-7c3e-ab41-4408207656c4` | 112 / 5 / 0 |
| retired headless `windows` (VM deleted 2026-11-04) | 598 | `20261101.2` | `01a19983-d967-7ea4-bd34-233e58dbce4d` | 101 / 5 / 0 |

For future builds on a fresh installation, run `infra/templates/windows/moonlight-web/build.sh` before `umiak-tpl build windows`. Rebuilds require a new empty template slot. Do not rebuild or delete any current stand template.

`verify-desktop.ts` passed the Linux baseline, restart and fork checks. The direct
`spike-desktop.ts` passed1920x1080 capture, mouse/Unicode keyboard proof, clipboard,
Sunshine/Moon pairing, fresh credentials after fork and stop/resume. It uses one4GiB
VM at a time and deletes its clones/snapshot. A replacement signed agent package may
be supplied via `UMIAK_SPIKE_AGENT_PACKAGE` for diagnosis; this is not needed for596.

Public acceptance is `infra/dev-cp/e2e-desktop.sh` after branch deploy and TURN setup.
It checks qm list before create/fork/resume, stops the source before fork, and uses
pinned Playwright Chromium for websocket/webrtc frame diffs plus live streamer state.
Install the browser with `mise exec -- pnpm --filter @umiak/web exec playwright install chromium`
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
network). deploy.sh writes `UMIAK_TURN_*` into `.env`. The PVE firewall of 590 accepts only
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
and expiry on Refresh without logging the REST secret. `UMIAK_TURN_PROBE_GUARD=1` adds the
fail-closed probe: delete the table with `docker exec` (relaying must stop within seconds and
recover with the table), then `systemctl reload nftables` in the CT via `pct exec` (TURN must
keep relaying, its table intact).
`desktop-block-probe.ts` (operator block) and `desktop-cache-probe.ts` (no screenshots in
the agent `state.db`) are separate live probes; both need the logged-in CLI on PATH. Upstream
coturn keeps an allocation's password after the REST timestamp expires, so the product
image builds pinned 4.18.0 source with `refresh-auth.patch`, which revalidates Refresh
through the existing credential callback. The source URL and hash, upstream license and
patch are kept in the image.

For long-idle media acceptance use `UMIAK_DESKTOP_IDLE_HOLD_MS=1800000` with
`e2e-desktop.sh`. It checks real MCP tools, forces relay-only WebRTC, verifies the
selected relay-to-relay pair and watches DB activity without API calls that would
refresh the idle timer. Diagnostics, screenshots and observations are written only
to its private temporary output directory. The branch may stay deployed after this
run; master restores main after merges.

Set `UMIAK_DESKTOP_TURN_TRANSPORTS=udp,tcp,tls` to run a separate relay-only media check
per client-to-TURN transport. Each check filters the browser's ICE URLs, verifies the
selected relay protocol and requires a changed live frame. UDP is the default; the long
idle hold applies to the first selected transport only. When a hold is requested, the last
selected transport is closed naturally (no EndStreams), so idle-stop is measured from a real
page close; with UDP/TCP/TLS that final viewer uses TLS.

VM egress to TURN is UDP 3478 only. The E2E checks STUN reachability and blocked TCP/TLS
from the guest before media; browser TCP/TLS access is checked separately.

`UMIAK_DESKTOP_TEST_AGENT_PACKAGE` (optional, diagnostics only) installs a signed agent
update on the disposable clone; acceptance runs leave it unset and test the template's
own agent.

Historical S10 Linux acceptance (before R1, 2026-11-01, build 20261031.6 in 596, agent 0.1.0+20261031.4865e13):
109-check profile, public create 14.4–18.4 s, real MCP tools, WebSocket and relay-only
UDP/TCP/TLS frame diffs, 30 min viewer hold without API calls. With a 60 s idle timeout
the sandbox stopped 78.1 s after EndStreams and 98.8 s after a natural page close. Fork
credentials, resume, old-cookie 401 and deletion passed.

Historical S10 Windows acceptance (before R1, 2026-11-01, `windows-desktop 20261101.2` in 595): run
`UMIAK_E2E_TEMPLATE=windows-desktop infra/dev-cp/e2e-desktop.sh`. The Windows variant types into
the Run dialog (opened by a one-shot interactive task, since exec runs in session 0), reads
agent state through QGA as SYSTEM and retries `503 desktop_starting` with a fresh ticket.
Create 139–146 s, first stream open ~22 s. `UMIAK_E2E_SANDBOX=<slug>` reuses an existing sandbox
for diagnostics (it is not deleted; idle observation needs the `e2e=desktop` label).

## S16 HTTP quickstart stand (2026-11-03, s16-fix4)

Recommended owner URL: **https://umiak-dev-cp.tail0000.ts.net:8443/app**.
The existing host Tailscale Serve terminates public TLS and forwards to
`http://localhost:4180`. LAN: **http://192.168.68.90:4180/app**.
Direct tailnet: **http://100.64.10.7:4180/app**. No private owner CA exists.
The ingress publishes one HTTP port for dashboard/API/MCP/install/downloads.

CT590 is claimed by Ilia and active. Preserve owner state, sessions and sandboxes.
Never recover/reclaim, log in as ilia@example.com or start a pairing to verify a
redeploy. Existing Serve `__Host-umiak_owner` and CLI bearer sessions remain valid;
plain HTTP uses a separate non-Secure cookie and therefore requires its own login.
Anonymous access gets the owner gate, never an upstream identity bypass.

> S18: `deploy-quickstart.sh`, `quickstart-preflight.sh` and `compose.quickstart.yaml` were removed with the
> legacy S16 install paths. The commands below are historical.

Private operator procedure (no credentials in transcripts):

```sh
ssh umiak@100.64.10.7
cd ~/umiak
docker compose --env-file deploy/compose/.env -f compose.yaml -f infra/dev-cp/compose.quickstart.yaml ps
```

Build while services keep running, verify no unfinished runtime operations or
sandbox activity immediately before the short replacement. Deploy with
`infra/dev-cp/deploy-quickstart.sh`. It keeps guest trust unchanged and sets:

```sh
tailscale serve --bg --https=8443 http://localhost:4180
```

Do not reset Serve or enable Funnel during deployment. **If you use Funnel, this
is public Internet exposure and the owner gate is the only protection.** Prefer
Serve. For your own Caddy/nginx proxy, set `UMIAK_PUBLIC_URL` and the proxy's exact
`UMIAK_TRUSTED_PROXY_CIDRS`; reject unknown Hosts. Only trusted peers can supply
X-Forwarded-Proto/Host/For. Root Compose trusts its host NAT peer for host-run
Serve, and the optional sidecar trusts only its dedicated peer. This does not
trust Tailscale identity headers. Direct DNS names use
`UMIAK_QUICKSTART_ALLOWED_HOSTS`; literal LAN/tailnet IPs work by default.

Getting started: `/app/getting-started`; wizard `/setup`; installer `/install.sh`;
remote MCP `/mcp`. Install-only verification preserves existing CLI profiles:

```sh
curl -fsSL https://umiak-dev-cp.tail0000.ts.net:8443/install.sh |
  UMIAK_INSTALL_SKIP_LOGIN=1 sh
```

HTTP installer checks SHA256 but warns that both binary and manifest use the
same unencrypted channel. Generic CLI `--cacert`/`UMIAK_CA_FILE` remains available
only when an operator's own HTTPS proxy needs private trust.

Previews use HTTP on LAN/tailnet IP-derived sslip.io names at configurable8085,
with unchanged token/public modes. Serve cannot issue wildcard preview names.
Do not put wildcard previews behind the owner's Serve origin. HTTPS previews are
available to operators with a wildcard certificate. Guest tunnel:443 stays TLS,
uses its existing CA and is independent of owner HTTP. No PVE firewall/network
change is part of this migration. LAN8085 reachability may depend on existing CT
firewall rules; if blocked, report it rather than adding a firewall rule.

Guest CA lasts10 years. A networkless `gateway-renewal` sidecar checks on startup
and daily, reissuing leaves within30 days from the same CA and retaining leaf
keys. Atomic certificate replacement is hot-reloaded by gateway. Templates need
no rebuild for leaf renewal. Setup/settings show CA/tunnel/preview expiry; metrics
include the same expiry timestamps. The CA warning begins one year before expiry:
CA rotation requires rebuilding agent packages and templates. Legacy dev-cp
`deploy.sh` also runs a renewal sidecar, independent of redeployment.

At a non-localhost HTTP origin, browser secure-context restrictions can remove
Clipboard API and WebCodecs; desktop decoding may be unavailable. Clipboard uses
execCommand fallback. Use Serve (recommended), `ssh -L 4180:localhost:4180
<docker-host>` and `http://localhost:4180`, your own HTTPS proxy, or for a quick
Chrome test `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for the exact
origin. The flag weakens browser protection for that origin.

Rollback remains `infra/dev-cp/deploy.sh` (OIDC). It reuses
S15 DB and guest secrets. Never use `down -v` or broad cleanup on the active stand.

### Quickstart: new browser or hostname (CT 590)

From a signed-in browser use **Owner sessions → Sign in another browser**.
Alternatively, run this on CT 590; it preserves all current owner sessions:

```sh
docker compose -p umiak exec quickstart umiak-signin
```

The explicit project name works from any directory; no `-f` or `--env-file`
is needed for exec. Use `umiak-signin --help` for a read-only check.

Enter the printed one-time code at the deployment's Sign in page within ten
minutes. Use the same hostname thereafter. Never run `recover.mjs` for ordinary
sign-in: it revokes all browsers and CLI credentials. Before redeploying, inspect
`qm list` and `qm config <vmid>` for locks on 500–589 read-only on `pve`; wait if
any sandbox operation is in progress. Coordinate file uploads: `~/umiak` has no
Git checkout, so a later deployment must include all preceding feature commits.
