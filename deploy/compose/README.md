# Local stack (docker compose)

> This directory describes the corporate stack with OIDC (Keycloak, oauth2-proxy). A home installation (`owner` mode) is done by the installer on a Proxmox node: `curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh`, see [docs/getting-started.md](../../docs/getting-started.md) and the [operator notes](quickstart/README.md). The root `compose.yaml` only pulls published images; to develop from source: `docker compose --env-file compose.dev.env -f compose.yaml -f compose.dev.yaml up --build`.

The stack currently contains:

| Service | What it does | Host port (127.0.0.1) |
|---|---|---|
| `postgres` | Postgres 18: databases `umiak` and `keycloak` | 5432 |
| `secrets-init` | one-shot: creates missing dev secrets in `secrets/` | — |
| `migrate` | one-shot: `db/migrations` migrations and `umiak-admin bootstrap` (topology from `config/umiak.yaml`) | — |
| `web-migrate` | one-shot (`web` image): Payload migrations, `payload` schema (S8 §12) | — |
| `worker` | S6 worker (+ `ctl-idp-sync` S8) | 9090 (`/readyz`, `/metrics`) |
| `keycloak-db` | one-shot: creates the `keycloak` database if missing | — |
| `keycloak` | IdP, realm `umiak` (architecture §10) | 8180 |
| `api` | public API v1 (S7) | 8080 (public), 9091 (`/readyz`, `/metrics`) |
| `oauth2-proxy` | browser sessions: `/api/*` and `/umiak-auth/*` → `api` proxied listener, the rest → `web` | 4180 |
| `web` | S8: dashboard `/app`, Payload admin `/admin`, Payload REST `/cms-api` | — (only via oauth2-proxy) |
| `mcp` | remote MCP server (S11), `/mcp` over Streamable HTTP (see "MCP (S11)" below) | 8090 (`/mcp`, metadata), 9092 (`/readyz`, `/metrics`) |
| `gateway-secrets` | one-shot (`gateway.yaml`): gateway dev secrets in `secrets/gateway/` | — |
| `gateway` | S4: preview addresses, SSH, agent tunnels (see "Gateway (S4)" below) | 8443 (TLS), 2222 (SSH), 7000, 9190 |

Proxmox is any host reachable from the containers (see "Proxmox").

The stack on `pve` (CT 590, reachable from sandbox VMs): `infra/dev-cp/README.md`.

## Requirements

- Docker with compose v2.
- For the worker: a `~/.config/umiak` directory with the files `pve-token` (mode 600), `pve-root-ca.pem`, `umiak-node_ed25519`,
  `known_hosts` (with the pinned key of the address the worker uses to SSH to the node). A different directory:
  `UMIAK_PVE_SECRETS_DIR`.
- Proxmox reachable from the containers over HTTPS (`:8006`) and SSH (`:22`). The address is set in `deploy/compose/.env`
  (see "Proxmox"). `api`, `keycloak` and `oauth2-proxy` do not depend on Proxmox.
- Linux host (without Docker Desktop): containers run under different uids than the host user. `secrets-init` itself hands the files in
  `deploy/compose/secrets/` to their owners (see "Secrets"). `~/.config/umiak/*` (mode 600)
  belong to the host user, while the worker runs as uid 1000 (`node`). If the host uid is not 1000, the worker cannot
  read them: run as a user with uid 1000, or fix permissions (`chown 1000` on a copy of the directory and point
  `UMIAK_PVE_SECRETS_DIR` to it), or set `user: "<uid>:<gid>"` on `worker` and `migrate` in a local override file.

## Proxmox

Any Proxmox address reachable from the containers works. Copy the example and put in your host:

```sh
cp deploy/compose/.env.example deploy/compose/.env
```

- `UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME` — the Proxmox API address and the name in its TLS certificate. `migrate`
  (`umiak-admin bootstrap`) substitutes them for the provider `apiUrl`/`tlsName` from `config/umiak.yaml`.
- `UMIAK_NODE_SSH_HOST` — the node address for SSH to `umiak-node`.

Without `.env` the stack expects a host named `pve` (`https://pve:8006`, TLS name `pve`). `.env.example` contains
the dev values of Ilia's home lab (the host is reachable from the development machine over Tailscale).

## Secrets

The `deploy/compose/secrets/` directory is in `.gitignore`; no secret is in git. `secrets-init` creates them
(`secrets-init/init.sh`) on every `up`, but only the missing ones: an existing secret is not changed. To keep the directory
yours (on Linux Docker would create it as root), create it beforehand:

```sh
mkdir -p deploy/compose/secrets
```

Files are laid out in per-consumer directories: compose mounts directories, not files (a file must exist
before the container is created, while `secrets-init` writes them later).

| File | Read by | What it is |
|---|---|---|
| `data-keys.json` | source of the copies below | S6 data keys (format: `config/data-keys.example.json`) |
| `api/data-keys.json`, `worker/data-keys.json` | `api`, `worker` | copies of `data-keys.json` |
| `payload-secret` | source of the copies below | `PAYLOAD_SECRET` of the Payload config (S8), one value for all services |
| `web/payload-secret`, `api/payload-secret`, `worker/payload-secret` | `web`, `web-migrate`, `api`, `worker` | copies of `payload-secret`; the service reads the file at start into `PAYLOAD_SECRET` |
| `worker/idp-sync-client-secret` | `worker` | copy of `keycloak/umiak-worker-client-secret` for `ctl-idp-sync` (`UMIAK_IDP_SYNC_CLIENT_SECRET_FILE`) |
| `api/cursor-key` | `api` | `UMIAK_API_CURSOR_KEY`, the cursor HMAC key |
| `api/service-tokens.json` | `api` | `UMIAK_API_SERVICE_TOKENS_FILE`: gateway tokens the internal listener accepts |
| `api/gateway-token` | `api` | `UMIAK_API_GATEWAY_TOKEN_FILE`: `api` token for the gateway internal listener |
| `api/ssh-login-ca` | `api` | `UMIAK_SSH_LOGIN_CA_KEY_FILE`: ed25519 CA for short-lived SSH certificates |
| `api/ssh-host-keys.pub` | `api` | `UMIAK_SSH_HOST_KEYS_FILE`: gateway public host keys for `/v1/meta` |
| `keycloak/oauth2-proxy-client-secret`, `keycloak/umiak-worker-client-secret` | `keycloak` | client secrets of the `umiak` realm |
| `keycloak/admin-password` | `keycloak` | Keycloak administrator password, if `KEYCLOAK_ADMIN_PASSWORD` is not set in `.env` |
| `oauth2-proxy/client-secret`, `oauth2-proxy/cookie-secret` | `oauth2-proxy` | copy of the client secret, cookie key (32 bytes) |

- `secrets-init` starts after `gateway-secrets` (S4, `depends_on` with `service_completed_successfully`), so
  `service-tokens.json`, `gateway-token`, `ssh-login-ca` and `ssh-host-keys.pub` are taken from `secrets/gateway/` and
  rewritten when they drift: `gateway/api-token` → `{"gateway": [...]}`, `gateway/service-tokens.json` →
  `api[0]`, `gateway/ssh_login_ca`, `gateway/ssh_host_*_key.pub`. A stack without `gateway-secrets` will not start
  (`depends_on`); `init.sh` creates its own dev values only for files missing from `secrets/gateway/`
  (for example when `secrets-init` is run on its own, with `--no-deps`).
- The copies (`api/data-keys.json`, `worker/data-keys.json`, `*/payload-secret`, `worker/idp-sync-client-secret`,
  `oauth2-proxy/client-secret`) are also rewritten from the source.
- To regenerate a secret: delete the file and run `up -d`. Then recreate its consumers
  (`up -d --force-recreate api oauth2-proxy ...`). On Linux the files belong to root and the consumer uids
  (`secrets-init` writes them as root): delete them with `sudo rm` or from a container —
  `docker compose -f deploy/compose/compose.yaml run --rm --no-deps --entrypoint rm secrets-init /secrets/<file>`. Keycloak client secrets get into the realm only on its
  import (first start): after changing them you need a clean Keycloak (see "Keycloak").
- A `data-keys.json` from earlier runs (created by hand following the old instructions) stays in place and is used.

## Running

```sh
cp deploy/compose/.env.example deploy/compose/.env   # once; put in your Proxmox
mkdir -p deploy/compose/secrets                       # once
docker compose -f deploy/compose/compose.yaml up -d --build
docker compose -f deploy/compose/compose.yaml ps -a
# gateway-secrets, secrets-init, keycloak-db, migrate, web-migrate: Exited (0)
# postgres, keycloak, api, oauth2-proxy, gateway, worker, web, mcp: healthy
curl -s http://localhost:8080/v1/meta                                     # api: oidc.issuer = Keycloak
curl -s http://localhost:9091/readyz                                      # api: {"ready":true,...}
curl -s http://localhost:8180/realms/umiak/.well-known/openid-configuration # Keycloak
curl -s -d client_id=umiak-cli http://localhost:8180/realms/umiak/protocol/openid-connect/auth/device  # user_code
curl -i http://127.0.0.1:9090/readyz                                      # worker
```

The first Keycloak start takes 20–40 seconds; `api` and `oauth2-proxy` wait until it is healthy. The order of the
one-shots: `migrate` → `web-migrate` → `api`, `worker`, `web`. The `web` image (Next.js build) takes a few
minutes to build.

Pool and node state (umiak-admin inside the container):

```sh
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts pool status
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts reconcile --dry-run
```

Logs and psql:

```sh
docker compose -f deploy/compose/compose.yaml logs -f api worker
docker compose -f deploy/compose/compose.yaml exec postgres psql -U umiak -d umiak
```

Stopping. `-v` deletes the volume with the databases (`umiak` and `keycloak`):

```sh
docker compose -f deploy/compose/compose.yaml down        # data is kept
docker compose -f deploy/compose/compose.yaml down -v     # clean start
```

On SIGTERM `api` closes streams (`reconnect`) and PTYs (1012) and exits within 10 s (`stop_grace_period: 30s`).

## First login

**Keycloak administrator.** http://localhost:8180/admin, login `KEYCLOAK_ADMIN` from `.env` (default
`admin`). The password is `KEYCLOAK_ADMIN_PASSWORD` from `.env`, and if it is not set, `secrets-init` generates it:

```sh
docker compose -f deploy/compose/compose.yaml exec keycloak cat /run/umiak-secrets/admin-password
# or on the host: deploy/compose/secrets/keycloak/admin-password
```

The account is created only on the first Keycloak start; changing the values later does not affect it. Realm `umiak`.

**Dashboard.** http://localhost:4180/ → Keycloak login → `/app` → the user's personal team
(`/app/t/team_…`). The user and personal team are created on first login (the same way in `web` and `api`).
Sign out (user menu → Sign out): `/oauth2/sign_out?rd=<UMIAK_LOGOUT_URL>` — oauth2-proxy deletes the cookie,
Keycloak shows the sign-out page and returns to http://localhost:4180/app (`/` of `web` also leads to `/app`).

**Test user.** The `umiak` realm already has `dev@example.com` (email verified) with the temporary password
`UMIAK_DEV_PASSWORD` from `.env` (default `dev`). On first login Keycloak asks for a new password.
New users are created in the Keycloak admin console (Users → Add user); for the API they must have
Email verified checked, otherwise `api` rejects their token.

**Operator.** A platform operator is a member of the `umiak-operators` group (`UMIAK_OPERATOR_GROUPS` of `api` and `web`); operator
rights apply only in a browser session. `dev@example.com` is an ordinary user in the realm (this also tests
the non-operator path: `/admin` is 403 "Operators only" from the `web` proxy, `/app/operator` is 403). To make it an
operator: Keycloak admin console → realm `umiak` → Users → `dev@example.com` → Groups → Join group → `umiak-operators`.
The group arrives in the oauth2-proxy cookie at login, so sign out and sign in again (or wait for the session
refresh, `--cookie-refresh=5m`). After that `/admin` and `/app/operator` open.

**API in the browser.** http://localhost:4180/api/v1/me → JSON with the user, their personal team and
`"auth": {"kind": "session"}`.

**CLI.** `umiak` (`apps/cli`) signs in through the Device Authorization Grant. A binary for your platform is built by
`mise exec -- pnpm --filter @umiak/cli build` (`apps/cli/dist/umiak-<os>-<arch>`), from source —
`mise exec -- pnpm --filter @umiak/cli umiak <command>`.

```sh
umiak login --api-url http://localhost:8080
```

The CLI prints a code and the link http://localhost:8180/realms/umiak/device; sign in as the same user and confirm.
The same `sub` gives the same user as in the browser. The access token lives 5 minutes, the session — 24 hours without
activity and no more than 7 days.

**Team key for automation.** Issued by a team `owner`: `POST /v1/api-keys` with a human's token
(`umiak keys create`), or a key from `config/identity.yaml` (by sha256).

## Keycloak

- The `umiak` realm is imported from `keycloak/realm-umiak.json` only on the first start (an existing realm is not
  touched). Clients: `oauth2-proxy`, `umiak-cli`, `umiak-mcp`, `umiak-api`, `umiak-worker`; scope `groups`; lifetimes — per
  architecture §10. Client secrets are substituted from `secrets/keycloak/` through environment variables
  (`${UMIAK_OAUTH2_PROXY_CLIENT_SECRET}`, `${UMIAK_WORKER_CLIENT_SECRET}`, `${UMIAK_DEV_PASSWORD}` in the realm file).
- Addresses: the browser and CLI use the public Keycloak address (`UMIAK_KEYCLOAK_URL` → `KC_HOSTNAME`, default
  http://localhost:8180; issuer `<address>/realms/umiak` is the token `iss`); `api` and `oauth2-proxy` use
  http://keycloak:8080 inside the network (`UMIAK_OIDC_DISCOVERY_URL`, `UMIAK_OIDC_JWKS_URL`, redeem and JWKS of oauth2-proxy).
  `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: backchannel addresses are taken from the request address, while `iss` stays public.
- The redirect URI and web origin of the `oauth2-proxy` client are substituted at import from `${UMIAK_OAUTH2_PROXY_REDIRECT_URL}`
  and `${UMIAK_APP_ORIGIN}` (see "Public addresses").
- To apply a changed `realm-umiak.json` (or new client secrets): delete the Keycloak database and restart.

  ```sh
  docker compose -f deploy/compose/compose.yaml stop keycloak
  docker compose -f deploy/compose/compose.yaml exec postgres dropdb -U umiak keycloak
  docker compose -f deploy/compose/compose.yaml up -d
  ```

## oauth2-proxy

Configuration is `oauth2-proxy/oauth2-proxy.yaml` (alpha config: provider `keycloak-oidc`, routes, headers;
the login address and issuer come from `${UMIAK_OIDC_ISSUER}`, oauth2-proxy substitutes environment variables in this file),
flags in `compose.yaml` and `OAUTH2_PROXY_*` variables (redirect URL, cookie, `reverse_proxy`). Settings
specific to an installation are variables, not flags: a flag cannot be overridden by a compose override file. `/api/*` goes to `api:8081` without the `/api` prefix, `/umiak-auth/*` as is;
upstream timeout 660 s. `X-Auth-Request-User` (`sub`), `-Email`, `-Groups`,
`-Preferred-Username` are added to the request to `api`; the same headers from the client are stripped. They can be trusted because `:8081` is not
published on the host; inside the `umiak` network any container can see it (acceptable for dev, in production closed by the
S12 NetworkPolicy). The `_umiak_session` cookie has no `Secure` and no
`__Host-` prefix: the stack runs over http on localhost (behind TLS it is `__Host-umiak_session` and `Secure`, see "Public
addresses"). The session is refreshed every
5 minutes (`--cookie-refresh=5m`) and lives at most 12 hours (`--cookie-expire=12h`, S8 §5.1), then a new login is needed.
Keycloak roles, which the `keycloak-oidc` provider adds to `X-Auth-Request-Groups` as `role:<name>`, are dropped by `web` and
`api`: the CLI JWT does not have them, and `users.groups` must be the same for browser and CLI login.

## web (S8)

`web` (image `apps/web/Dockerfile`, `umiak-web:dev`) is Next.js + Payload; variables are in `apps/web/README.md`
("Environment"). `web-migrate` is the same image running `node packages/payload/src/migrate.ts`: it applies the migrations of the
`payload` schema (the first one holds the platform defaults, the `linux` template and the `2gb` size, as in
`config/umiak.yaml`, and a copy of the S7 identities from the `identity` schema, if it exists). `api`, `worker` and `web` start
after it; `/readyz` of `api` and `worker` and `/healthz` of `web` are not ready until all Payload migrations are applied.

First S8 start on an existing volume (it already has the `identity` schema from S7): first build the images, then
stop `api` and `worker`, then bring the stack up. Otherwise pre-S8 `api` keeps writing to `identity` while
`web-migrate` copies it into `payload`, and those rows are lost. After that the step is not needed.

```sh
docker compose -f deploy/compose/compose.yaml build
docker compose -f deploy/compose/compose.yaml stop api worker
docker compose -f deploy/compose/compose.yaml up -d
```

- `api` and `worker` take identities and config (templates, sizes, quotas, platform defaults) only from Payload:
  they no longer have `UMIAK_CONFIG_FILE`, and `config/umiak.yaml` is read only by `migrate` (`bootstrap`: topology and template
  builds). Templates and sizes are changed in `/admin` (operator), not in `umiak.yaml`. `api` still loads
  `config/identity.yaml` at start (upsert into Payload).
- `PAYLOAD_SECRET` is one for `web`, `web-migrate`, `api` and `worker` (`secrets/*/payload-secret`, see "Secrets").
- Network. `web` trusts the `X-Auth-Request-*` headers, so only oauth2-proxy must reach `:3000`.
  `web` is connected only to the `web-internal` network (`internal: true`: no outbound access and no published ports), which
  contains only `oauth2-proxy` and `postgres` besides it (`web` needs the database). All other services are only in the
  `umiak` network: the name `web` does not resolve from them, and the `web` address in `web-internal` is unreachable. The `web` port is not
  published on the host. Check:

  ```sh
  docker run --rm --network umiak_umiak busybox:1.38.0-musl wget -T 3 -qO- http://web:3000/healthz        # bad address 'web'
  ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "umiak_web-internal").IPAddress}}' umiak-web-1)
  docker run --rm --network umiak_umiak busybox:1.38.0-musl wget -T 3 -qO- "http://$ip:3000/healthz"   # timeout
  docker compose -f deploy/compose/compose.yaml exec oauth2-proxy /bin/busybox wget -qO- http://web:3000/healthz  # ok
  ```

- Database: `web` (like `web-migrate`, `api`, `worker`) connects to Postgres as the shared superuser `umiak` from
  `*db-env`. Separate Postgres roles from S8 §12 (for `web` — only the `payload` schema, no `INSERT` into `api_keys`/`ssh_keys`)
  are S12 work.
- Postgres: `max_connections=200` (`api` ~36 connections, `worker` ~37, `web` ~11, plus Keycloak and the one-shots).
- `worker` enables `ctl-idp-sync` (S8 §20.1): every 5 minutes it reads the `umiak` realm users through the Keycloak
  Admin API (`http://keycloak:8080`, client `umiak-worker` with the `view-users` role) and deactivates in Payload those who
  are disabled or deleted in Keycloak. `worker` does not wait for Keycloak: on a fresh stack the first pass may fail
  (`idp sync failed … fetch failed`, Keycloak is still starting), the next one is in 5 minutes
  (`umiak_idp_sync_total{result="ok"}` at `:9090/metrics`).
- Sign-out: `UMIAK_LOGOUT_URL` (default `<UMIAK_KEYCLOAK_URL>/realms/umiak/protocol/openid-connect/logout?client_id=oauth2-proxy&post_logout_redirect_uri=<UMIAK_APP_ORIGIN>/app`).
  oauth2-proxy allows `rd` only to hosts from `whitelist_domains`, so the Keycloak address is in it too
  (`UMIAK_OAUTH2_PROXY_WHITELIST_KEYCLOAK`); the realm allows the `oauth2-proxy` client the post-logout redirect
  `<UMIAK_APP_ORIGIN>/*`.
- Logs: `docker compose -f deploy/compose/compose.yaml logs -f web web-migrate`.

## Dashboard E2E stack (S8 §15)

`e2e.yaml` is an overlay for the Playwright tests in `apps/web/e2e` (decision 10 of the S8 plan): real `postgres`, `keycloak`,
`oauth2-proxy`, `web`, `web-migrate`, `migrate`, but no Proxmox, gateway or guest. `api` and `worker` are off
(profiles); in their place is a single `e2e-backend` (`apps/web/e2e/backend`, image `umiak-e2e-backend:dev`): the `api` and
`worker` code in one process on Payload, with a fake agent (`apps/api/src/testing`) and a fake PVE world
(`apps/worker/test/fakes`). In the `umiak` network it has the alias `api`, so the oauth2-proxy routes are the same. The test control
endpoint (an `ctl-idp-sync` pass, an "empty" Keycloak, `routes.lookup`, what the fake guest received) is only on
`127.0.0.1:19099` and is not in production code.

```sh
pnpm --filter @umiak/web test:e2e          # up --build --wait, playwright, down -v
UMIAK_E2E_KEEP=1 pnpm --filter @umiak/web test:e2e   # the stack stays; to rerun: cd apps/web && pnpm exec playwright test -c e2e
docker compose --env-file deploy/compose/e2e.env -f deploy/compose/compose.yaml -f deploy/compose/e2e.yaml down -v
```

- Project `umiak-e2e` (its own volumes), host ports from `e2e.env` (`14180` app, `18180` Keycloak, `18080` public
  API, `15432` Postgres, `19099` control endpoint): it can run next to the dev stack. `e2e.env` is passed with `--env-file`, so
  the dev stack's `deploy/compose/.env` is not mixed in. The `secrets/` directory is shared with the dev stack.
- Test users (`alice`, `bob`, `op` in `umiak-operators`, `dave`, five "filler" users) are created by global setup through the
  Keycloak Admin API (the administrator password is `KEYCLOAK_ADMIN_PASSWORD` from `e2e.env`), with a run suffix: a repeated
  run on a live stack does not collide with the previous one.
- `e2e-backend` raises the node's `ram_cap_mb` from `config/umiak.yaml` (fake VMs cost nothing).

## Gateway (S4)

`compose.yaml` includes `gateway.yaml` (`include`), so `up -d --build` brings up `gateway-secrets` and
`gateway`. The gateway calls the `api` internal listener (`UMIAK_GATEWAY_API_URL=http://api:8082`, tokens are
reconciled by `secrets-init`). Details, ports and trusting the dev CA are in `README.gateway.md`.

What works locally, without a VM:

- Route lookup: `curl -sk --connect-to x-3000.umiak.localhost:443:127.0.0.1:8443 https://x-3000.umiak.localhost/`
  reaches `api` and answers `404 route_not_found`. For an existing machine with a published port,
  the route is found the same way.
- SSH authorization through `api`: the gateway listens on `ssh.localhost:2222` and checks a key or login certificate
  (signed by the CA from `secrets/gateway/ssh_login_ca`, issued by `api`) by calling `api`. `/v1/meta` returns
  `ssh.localhost:2222` and the gateway host keys, and `umiak ssh` takes them from there. The port domain is `umiak.localhost`.
- The gateway registry in Postgres, the internal listener (the worker calls `rotate-token`), metrics on 9190.

What is missing without a real VM: the agent tunnel (`umiak-guest-agent` inside the VM connects to `tunnel.localhost`), so
there is no proxying of preview traffic and SSH sessions into the VM, no agent RPC and files, and a sandbox never reaches `ready`.
That needs a VM on Proxmox with a template that contains the agent.

Check:

```sh
docker compose -f deploy/compose/compose.yaml ps -a   # gateway, api, keycloak, oauth2-proxy, postgres: healthy
curl -sk --connect-to x-3000.umiak.localhost:443:127.0.0.1:8443 https://x-3000.umiak.localhost/   # 404 route_not_found
```

Stack without `api`: `UMIAK_GATEWAY_API_URL=none` in `deploy/compose/.env`.

## Public addresses

By default the stack lives on fixed localhost ports. Behind a TLS proxy (ingress, Tailscale Serve, etc.)
the public addresses are set in `deploy/compose/.env`: they are written into the realm, oauth2-proxy and `/v1/meta`. Dependent
values (issuer, redirect URL, gateway SSO address) are derived by default from `UMIAK_KEYCLOAK_URL` and
`UMIAK_APP_ORIGIN`, so usually `UMIAK_API_PUBLIC_URL`, `UMIAK_APP_ORIGIN`, `UMIAK_KEYCLOAK_URL`,
`UMIAK_OAUTH2_PROXY_WHITELIST_DOMAIN`, and the cookie and proxy settings are enough.

| Variable | Default | Where it goes |
|---|---|---|
| `UMIAK_API_PUBLIC_URL` | `http://localhost:8080` | `api` `UMIAK_API_URL` (`/v1/meta` `apiUrl`), `web` (CLI and SDK hints) |
| `UMIAK_MCP_PUBLIC_URL` | `http://localhost:8090/mcp` | `mcp` `UMIAK_MCP_PUBLIC_URL`: the address MCP clients use to reach the server; its host is the only allowed `Host` (plus `UMIAK_MCP_ALLOWED_HOSTS`), and the address itself is the `resource` in the protected resource metadata |
| `UMIAK_APP_ORIGIN` | `http://localhost:4180` | `api` `UMIAK_APP_URL` and `UMIAK_APP_ORIGIN` (Origin for unsafe methods on the proxied listener); `web` `UMIAK_APP_ORIGIN`; web origin and post-logout redirect of the `oauth2-proxy` client in the realm |
| `UMIAK_KEYCLOAK_URL` | `http://localhost:8180` | Keycloak `KC_HOSTNAME` |
| `UMIAK_OIDC_ISSUER` | `<UMIAK_KEYCLOAK_URL>/realms/umiak` | `api` and oauth2-proxy (issuer, login address) |
| `UMIAK_OAUTH2_PROXY_REDIRECT_URL` | `<UMIAK_APP_ORIGIN>/oauth2/callback` | oauth2-proxy `redirect_url`, client redirect URI in the realm |
| `UMIAK_OAUTH2_PROXY_WHITELIST_DOMAIN` | `localhost:4180` | oauth2-proxy `whitelist_domains` — host:port from `UMIAK_APP_ORIGIN`; set separately (compose cannot strip the scheme) |
| `UMIAK_OAUTH2_PROXY_WHITELIST_KEYCLOAK` | `localhost:8180` | the second `whitelist_domains` entry — host:port from `UMIAK_KEYCLOAK_URL` (redirect to the Keycloak sign-out page) |
| `UMIAK_LOGOUT_URL` | `<UMIAK_KEYCLOAK_URL>/realms/umiak/protocol/openid-connect/logout?client_id=oauth2-proxy&post_logout_redirect_uri=<UMIAK_APP_ORIGIN>/app` | `web`: where oauth2-proxy sends the user after sign-out |
| `UMIAK_GATEWAY_AUTH_URL` | `<UMIAK_APP_ORIGIN>/umiak-auth/authorize` | gateway: where to send the browser for a port in `sso` mode |
| `UMIAK_KEYCLOAK_PROXY_HEADERS` | empty | Keycloak `KC_PROXY_HEADERS`: `xforwarded` (or `forwarded`) behind a TLS proxy |
| `UMIAK_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` | empty | Keycloak `KC_PROXY_TRUSTED_ADDRESSES`: proxy addresses (comma-separated CIDRs) |
| `UMIAK_OAUTH2_PROXY_COOKIE_NAME` | `_umiak_session` | session cookie name; behind TLS — `__Host-umiak_session` |
| `UMIAK_OAUTH2_PROXY_COOKIE_SECURE` | `false` | `true` behind TLS (required for `__Host-`) |
| `UMIAK_OAUTH2_PROXY_REVERSE_PROXY` | `false` | `true` if a proxy with `X-Forwarded-*` sits in front of oauth2-proxy |
| `UMIAK_PREVIEW_DOMAIN` | `umiak.localhost` | `api` `/v1/meta` `umiakDomain` (port domain), `web` (CSP `frame-src`). The gateway has its own `UMIAK_GATEWAY_PREVIEW_DOMAIN` in `gateway.yaml`: when changing it you also need a gateway override with the same value |
| `UMIAK_SSH_HOST`, `UMIAK_SSH_PORT` | `ssh.localhost`, `${GATEWAY_SSH_PORT:-2222}` | `/v1/meta` `ssh` and `umiak ssh`. The gateway host has its own `UMIAK_GATEWAY_SSH_HOST` in `gateway.yaml`: when changing `UMIAK_SSH_HOST` you also need a gateway override; the default port follows the published `GATEWAY_SSH_PORT` |
| `UMIAK_API_TRUSTED_PROXY_CIDRS` | empty | `X-Forwarded-For` goes into the `api` log `clientIp` only from these addresses, otherwise the connection address |

- The realm is imported only into an empty Keycloak: after changing `UMIAK_APP_ORIGIN` or `UMIAK_OAUTH2_PROXY_REDIRECT_URL`
  you need a clean Keycloak (see "Keycloak").
- `api` never trusts the `Tailscale-User-*`, `X-Auth-Request-*` and `X-Forwarded-User/Email` headers on the public
  listener: there identity is only `Authorization: Bearer`. `X-Forwarded-For` from `UMIAK_API_TRUSTED_PROXY_CIDRS`
  goes only into the log `clientIp`.
- An example of such a layout is the dev control plane on CT 590 (`infra/dev-cp/compose.dev-cp.yaml`).
- CLI with a private CA: `umiak --cacert <file>` or `UMIAK_CA_FILE` (added to the built-in Node/Bun roots, the OS store is not
  used; applies to both Keycloak and the `umiak shell` WebSocket). Not needed for the dev control plane: Tailscale Serve has a Let's Encrypt certificate.

## Settings

- `config/umiak.yaml` — the topology (node `pve`, storage `local-lvm`) and the builds of templates 599 and 597 from S5; `umiak-admin bootstrap`
  in `migrate` loads them into the database. `api` and `worker` take templates, sizes, quotas and pools from Payload
  (S8; edited in `/admin`) and do not read the file's `templates`/`sizes`/`quotas`/`pools` sections (the initial Payload
  values match them; pools are the `pool-targets` collection in `/admin`). After editing the topology or builds
  it is enough to restart `migrate` (bootstrap is idempotent, `api` and `worker` read them from the database):

  ```sh
  docker compose -f deploy/compose/compose.yaml up -d --force-recreate migrate
  ```

  After editing `deploy/compose/.env` and secret files: recreate their consumers (`up -d --force-recreate <services>`).
- `config/identity.yaml` — the `api` identity file (`UMIAK_IDENTITY_FILE`): teams, users, team keys by
  sha256. Loaded on every `api` start (upsert only). Empty in dev: people appear on first login.
- `deploy/compose/.env` (git-ignored, example — `.env.example`): Proxmox (`UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME`,
  `UMIAK_NODE_SSH_HOST`, `UMIAK_PVE_TOKEN_ID`, `UMIAK_PVE_SECRETS_DIR`), `UMIAK_RECONCILE_DRY_RUN`, Keycloak
  (`KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, `UMIAK_DEV_PASSWORD`), public addresses (see "Public addresses"),
  `UMIAK_GATEWAY_API_URL`, `UMIAK_API_LOG_LEVEL`.
- Host ports are fixed: 8080 (api), 9091 (ops api), 8090 (mcp), 9092 (ops mcp), 8180 (Keycloak), 4180 (oauth2-proxy), plus 5432
  and 9090. The public addresses point to them by default (`http://localhost:8180`, `http://localhost:4180`);
  a different port means different public addresses, which must be set together (see "Public addresses").
- The Postgres credentials `umiak/umiak/umiak` are for development only; the port is published on `127.0.0.1:5432`.
- `UMIAK_DB_POOL_MAX` (default 30) is the worker connection pool size. The power lock (`power:<nodeId>`, S6 §15.1) holds one connection per node in each process and takes one more under it, plus pg-boss and operation connections. The value must comfortably exceed the number of nodes.

## What worker and api do on their own, and what they do not

- Reconcile runs in dry-run (`UMIAK_RECONCILE_DRY_RUN=1`): it reads the VM list on Proxmox (read-only) and logs what it would do.
- There are no pool target sizes (the Payload `pool-targets` collection is empty, like `pools: []` in `umiak.yaml`, decision 17), so the worker does not create VMs on its own.
- The gateway (S4) is in the stack and the worker gets `UMIAK_GATEWAY_SERVICE_TOKEN_FILE` from `gateway.yaml`, but without a VM with the agent (S3) there is no tunnel: the agent port is unreachable, and sandbox creation does not reach `ready`.
- Agent RPCs in `api` answer `503 agent_unavailable` until `ConnectAgentApi` is wired in (S3 is already in `main`, wiring is on the master session's command; S7 plan decision 3, `apps/api/README.md`); files go through the gateway.
- The `tunnel` schema is created by the S2 migration `db/migrations/0100_tunnel_init.sql` (`migrate` applies it together with the S6 migrations). A volume created earlier by the temporary `tunnel` schema fixture (before this migration) is incompatible with it: recreate it with `down -v`, then `up -d --build`.
- With `UMIAK_GATEWAY_SERVICE_TOKEN_FILE` the worker finds the gateway that holds the machine's tunnel through `PgRegistry` from `@umiak/agent-client` (its own small Postgres connection and LISTEN on `tunnel_sessions`) and calls `rotate-token` on it.
- The worker passes `UMIAK_PORT_DOMAIN` (the domain of published ports, for example `umiak.example.com`) and `UMIAK_SSH_USER_CA_KEYS_FILE` (a file with SSH user CA public keys, one per line) to the agent in every Claim (`port_domain`, `ssh_user_ca_keys`); it also sends the CA keys with `System/UpdateSshCa` on every resume, recover and reprovision. `gateway.yaml` sets `UMIAK_SSH_USER_CA_KEYS_FILE` = the gateway's `ssh_user_ca.pub`: without it sshd in the VM does not accept gateway logins and SSH does not work. The worker reads the file at start: after changing the CA restart the worker, and existing sandboxes get the new keys on the next resume (running ones — after stop/resume).

## Smoke test of the real Proxmox adapter

`apps/worker/test/pve-smoke.test.ts` runs `PveInfraRegistry` against the `pve` host: create/start/shutdown,
snapshot and fork, two parallel starts (power lock), reconcile in dry-run, then deletes everything it created
and compares the umiak-node inventory before and after. Without `UMIAK_PVE_SMOKE=1` the test is skipped, so
`pnpm -r test` stays offline. The topology is taken from `config/umiak.yaml` (via `umiak-admin bootstrap`)
in a fresh test database (a local docker Postgres from global setup).

```sh
UMIAK_PVE_SMOKE=1 mise exec -- pnpm --filter @umiak/worker exec vitest run test/pve-smoke.test.ts
```

- Secrets: `~/.config/umiak` (or `UMIAK_SECRETS_DIR`); umiak-node SSH host: `UMIAK_NODE_SSH_HOST` (by default the dev address from `.env.example`).
- It creates VMs only in the range 500–589 (590–596 are dev infrastructure, 597–599 are templates) from template 599, 2 vCPU / 2 GB each, at most two running at once.
  There must be no VMs in this range before the run: the test checks this at the start.
- It takes about 90 seconds, most of it spent on `shutdown` (the template guest needs more than 60 s, then `stop` follows).

## MCP (S11)

The `mcp` service (image `umiak-quickstart:dev`, `deploy/compose/quickstart/Dockerfile`) exposes the public API as MCP tools over Streamable HTTP. It has no state or secrets: it checks the bearer by calling `GET /v1/me` on `api` (`http://api:8080`) and passes the same bearer in all SDK calls, so `api` decides permissions.

```sh
curl -s http://localhost:9092/readyz                                      # mcp: {"ready":true,...}
curl -si -X POST http://localhost:8090/mcp -H 'content-type: application/json' -d '{}'
# 401 with WWW-Authenticate: Bearer resource_metadata="http://localhost:8090/.well-known/oauth-protected-resource/mcp"
curl -s http://localhost:8090/.well-known/oauth-protected-resource/mcp    # authorization_servers: [Keycloak issuer]
```

Connecting clients (Claude Code, Codex, OpenCode, Gemini CLI, Inspector) is covered in `apps/mcp/README.md`. In short: a team key `umiak_…` (`umiak keys create`) in `Authorization: Bearer`, or browser sign-in with the Keycloak client `umiak-mcp` (public, authorization code + PKCE, redirects `http://127.0.0.1:33418/*`, `http://localhost:33418/*` and `http://127.0.0.1:19876/*` for OpenCode; it is already in the realm).

- `Host` check: the host and hostname from `UMIAK_MCP_PUBLIC_URL` (default `localhost:8090`) and the comma-separated values of `UMIAK_MCP_ALLOWED_HOSTS` (by default `127.0.0.1:8090` in the stack) are allowed. Any other `Host` gets `421`. A request with `Origin` is rejected (`403`) unless the origin is in `UMIAK_MCP_ALLOWED_ORIGINS` (empty in the stack: MCP clients are not browsers).
- Behind a TLS proxy set `UMIAK_MCP_PUBLIC_URL` (`https://…/mcp`); the proxy forwards `/mcp` and `/.well-known/oauth-protected-resource/mcp` to the service (in production `api.<domain>` has the same paths, S11 §6.2). An example is in `infra/dev-cp/README.md`, "S11 MCP behind Tailscale Serve".
- Logs: `UMIAK_MCP_LOG_LEVEL` (default `info`). Stops on SIGTERM within 25 s (`stop_grace_period: 30s`).

## Adding a service

1. Add a block to `services:` in `compose.yaml`; take `<<: *service-defaults` (logging and the `umiak` network) and `<<: *db-env` for `DATABASE_URL`.
2. If the service needs the DB schema, set `depends_on: migrate: condition: service_completed_successfully`.
3. Generate secrets in `secrets-init/init.sh` into the service's own directory `deploy/compose/secrets/<service>/` (git-ignored) and mount the directory, not a file; only `*.example` goes to git. The service sets `depends_on: secrets-init: condition: service_completed_successfully`.
4. Build the image from the repository root (`context: ../..`, `dockerfile: apps/<name>/Dockerfile`); `.dockerignore` is in the root.
5. For a new workspace package (`packages/<name>` or `apps/<name>`), add a `COPY <dir>/package.json <dir>/` line to the manifest block of the `base` stage in the Dockerfile of the shared CP and web (`deploy/compose/quickstart/Dockerfile`, `apps/web/Dockerfile`), otherwise `pnpm install --frozen-lockfile` will not match the lockfile. If the package is among the service's dependencies, also add `COPY <dir>/src <dir>/src`; if it is built into `dist` (like `@umiak/proto` and `@umiak/agent-client`), build it in the `build` stage and copy `dist` into the final image.
   A new Dockerfile for a workspace package copies the root `.pnpmfile.cjs` (the `readPackage` hook for `openapi-typescript`) in the `base` stage along with `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`: without it `pnpm install --frozen-lockfile` does not match the pnpmfile checksum in the lockfile.

## Running worker and api without Docker

The S6 and S7 packages run from source (`node src/main.ts`), while `@umiak/proto` and `@umiak/agent-client` are taken from `dist` at runtime. Build them before the first run and after changes to them:

```sh
mise exec -- pnpm build        # or only what you need: pnpm --filter "@umiak/agent-client..." run build
mise exec -- pnpm --filter @umiak/worker start
mise exec -- node apps/api/src/main.ts   # environment variables — apps/api/src/settings.ts
```

Tests (`vitest`) and `typecheck` do not depend on this: vitest takes sources through the `source` condition, and `typecheck` builds `dist` itself.
