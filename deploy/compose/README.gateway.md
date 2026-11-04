# Gateway (S4) in the local stack

`gateway.yaml` adds two services to the stack from `compose.yaml`:

- `gateway-secrets` — one-shot, creates missing dev secrets in `deploy/compose/secrets/gateway/`;
- `gateway` — the `umiak-gateway:dev` image from `services/gateway/Dockerfile`.

It also adds the token for the gateway internal listener to `worker`.

## Wiring

`compose.yaml` includes `gateway.yaml` (`include: [gateway.yaml]` at the top), so the gateway starts with the
usual command:

```sh
docker compose -f deploy/compose/compose.yaml up -d --build
```

`secrets-init` depends on `gateway-secrets`: the `api` tokens, login CA and host keys are taken from
`secrets/gateway/`. The `umiak` network is declared in both files without a conflict: compose merges the declarations.
The addition to the `worker` service is applied too. `gateway.yaml` can also be used on its own, as an `-f` layer
on top of `compose.yaml` without `include`.

```sh
docker compose -f deploy/compose/compose.yaml ps -a
# gateway-secrets: Exited (0), gateway: healthy
curl -i http://127.0.0.1:9190/readyz     # 200 ok
curl -s http://127.0.0.1:9190/metrics | grep '^umiak_gateway' | head
```

## Ports (127.0.0.1 only)

| Host | Container | What | Variable in `deploy/compose/.env` |
|---|---|---|---|
| 8443 | 8443 | TLS: `*.umiak.localhost` and `tunnel.localhost` (by SNI) | `GATEWAY_HTTPS_PORT` |
| 2222 | 2222 | SSH | `GATEWAY_SSH_PORT` |
| 7000 | 7000 | internal listener (peer, worker, api); for debugging | `GATEWAY_INTERNAL_PORT` |
| 9190 | 9090 | `/metrics`, `/healthz`, `/readyz` (host port 9090 is taken by the worker) | `GATEWAY_METRICS_PORT` |

On macOS, port 7000 is listened on by AirPlay Receiver (`*:7000`). Publishing on `127.0.0.1:7000` still works,
but if Docker cannot bind it, change `GATEWAY_INTERNAL_PORT`.

## Secrets

`gateway-secrets` runs `umiak-gateway dev-secrets -dir /secrets`. The `deploy/compose/secrets/` directory
is in `.gitignore`. The command creates only missing files, so it is safe to run on every `up`.
The exception is two derived files: `login-ca-keys` (from `ssh_login_ca`) and `worker-gateway-token`
(from `service-tokens.json`). The command rewrites them if they drift from the source.

| File | Mode | Purpose |
|---|---|---|
| `ca.pem`, `ca.key` | 644 / 600 | dev CA. Limited by name constraints: signs only `umiak.localhost`, `tunnel.localhost`, `ssh.localhost` and their subdomains |
| `umiak.pem`, `umiak.key` | 644 / 600 | certificate for `*.umiak.localhost` and `umiak.localhost` (397 days) |
| `tunnel.pem`, `tunnel.key` | 644 / 600 | certificate for `tunnel.localhost`, used by agents |
| `cookie-keys` | 600 | port cookie key, `k1:<base64 32 bytes>` |
| `ssh_host_ed25519_key`, `ssh_host_ecdsa_key` (+ `.pub`) | 600 / 644 | SSH gateway host keys |
| `ssh_user_ca` (+ `.pub`) | 600 / 644 | CA the gateway uses to sign certificates for sshd in the VM. The VM template needs the `.pub` (`TrustedUserCAKeys`) |
| `ssh_login_ca` (+ `.pub`) | 600 / 644 | CA for short-lived login certificates. The private key is for `api` (S7, `UMIAK_SSH_LOGIN_CA_KEY_FILE`) |
| `login-ca-keys` | 644 | `ssh_login_ca.pub` in authorized_keys format (`UMIAK_GATEWAY_SSH_LOGIN_CA_KEYS_FILE`) |
| `service-tokens.json` | 600 | tokens the gateway accepts: `{"api":[..],"worker":[..],"gateway":[..]}`. The gateway sends `gateway[0]` to peers |
| `api-token` | 600 | token the gateway uses to call `api` (`UMIAK_GATEWAY_API_TOKEN_FILE`) |
| `worker-gateway-token` | 600 | equal to `service-tokens.json` → `worker[0]`. The worker reads it via `UMIAK_GATEWAY_SERVICE_TOKEN_FILE` |

Owners. `gateway-secrets` runs as root and hands the files to the gateway user (distroless `nonroot`, 65532),
and `worker-gateway-token` to the worker user (`node`, 1000). This happens on every start, including for
existing files. Docker Desktop hides this: on the host the files
belong to you. On a Linux host, the private files are then readable only by root. If the directory does not exist, Docker creates it
as root. To keep the directory yours and be able to delete files without `sudo`, create it beforehand:

```sh
mkdir -p deploy/compose/secrets/gateway
```

Regeneration. Delete a file and the next `up` recreates it. Pairs are deleted whole: a certificate with its key,
an SSH private key with its `.pub`. If only one half of a pair is left, `dev-secrets` refuses to run and names the file.
When `ca.*` is new, delete `umiak.*` and `tunnel.*` too. Certificates last 397 days (the browser and macOS limit); when they
expire, delete `umiak.*` and `tunnel.*`. After regeneration run `up -d --force-recreate gateway`
(the gateway reloads certificates by itself; other secrets are read only at start).

## Worker token

`gateway.yaml` mounts the secrets directory into the worker (`/run/umiak-gateway`, read-only) and sets
`UMIAK_GATEWAY_SERVICE_TOKEN_FILE=/run/umiak-gateway/worker-gateway-token`. A directory is mounted, not a file: Docker
would create a directory in place of a not-yet-existing file before `gateway-secrets` runs. The worker finds the
gateway through the registry (`tunnel.gateway_instances`, `internal_url = http://gateway:7000`) and calls `rotate-token` on it.

## api

By default `UMIAK_GATEWAY_API_URL=http://api:8082` (the `api` internal listener, S7). Through it the gateway
looks up preview address routes, checks SSH keys and certificates, and sends agent events.
`secrets-init` takes the tokens from `secrets/gateway/`: `api-token` goes into `api/service-tokens.json` under
the `gateway` key, and `service-tokens.json` → `api[0]` becomes the `api` token for the gateway internal listener
(`api/gateway-token`). If the `gateway-secrets` files were regenerated, restart `api` and `gateway`
(`up -d --force-recreate api gateway`).

Stack without `api`: set `UMIAK_GATEWAY_API_URL=none` in `deploy/compose/.env`. All preview addresses then
answer `503 route_lookup_unavailable`, SSH logins are rejected, and agent events are logged and
dropped. Agent tunnels, the registry and the internal listener work.

## HTTPS: trusting the dev CA and names

Browsers resolve `*.localhost` to loopback themselves; the system resolver and curl do not always. The gateway parses the
label only from a Host without a port (or with `:443`, spec §4.2), so `https://demo-3000.umiak.localhost:8443/`
answers `404 route_not_found`.

curl, port 8443: `--connect-to` substitutes the address and leaves Host and SNI as they are:

```sh
curl --cacert deploy/compose/secrets/gateway/ca.pem \
  --connect-to demo-3000.umiak.localhost:443:127.0.0.1:8443 \
  https://demo-3000.umiak.localhost/
# 404 {"error":{"code":"route_not_found",...}} from api (without api: 503 route_lookup_unavailable)
```

Browser: set `GATEWAY_HTTPS_PORT=443` in `deploy/compose/.env` (Docker Desktop and Linux Docker can
publish port 443) and add `ca.pem` to the trusted certificates:

```sh
# macOS
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db deploy/compose/secrets/gateway/ca.pem
# Linux (Debian/Ubuntu); Firefox and Chrome on Linux keep their own store (certutil from libnss3-tools)
sudo cp deploy/compose/secrets/gateway/ca.pem /usr/local/share/ca-certificates/umiak-dev-ca.crt && sudo update-ca-certificates
```

The CA name constraints keep it from signing foreign names even if `ca.key` leaks. To remove trust:
`security delete-certificate -c "umiak dev CA <id>"` (`openssl x509 -in ca.pem -noout -subject` shows the exact name).

With `GATEWAY_HTTPS_PORT=443`, `--resolve demo-3000.umiak.localhost:443:127.0.0.1` is enough for curl (or a line in `/etc/hosts`).

## SSH

```sh
printf '[127.0.0.1]:2222 %s\n' "$(cut -d' ' -f1,2 deploy/compose/secrets/gateway/ssh_host_ed25519_key.pub)" > /tmp/umiak_known_hosts
ssh -p 2222 -o UserKnownHostsFile=/tmp/umiak_known_hosts <slug>@127.0.0.1
```

Key and certificate authorization goes through `api` (the internal listener); without `api` an SSH login is always rejected.

## Stop and drain

`stop_grace_period: 960s`, like a pod's `terminationGracePeriodSeconds` (spec §10.5). On SIGTERM the gateway
immediately returns `/readyz 503`, keeps accepting connections for another 5 s, then drains. HTTP streams get 2 min, SSH sessions
15 min; the whole drain is capped at 950 s. With no open sessions, `docker compose stop gateway` takes about 5 s.
A second signal (Ctrl-C twice during `up` without `-d`) stops the process immediately.

For local runs the gateway has two environment variables (in the service `environment:` or via an override):

- `UMIAK_GATEWAY_ENDPOINT_WAIT` — pause before closing the listeners (default 5s);
- `UMIAK_GATEWAY_DRAIN_TIMEOUT` — overall drain limit (default is the drain budget + 30 s = 950 s; values above 950 s are not accepted).

`docker compose stop -t 10 gateway` interrupts a long drain after 10 s (SIGKILL).

## Image

```sh
docker build -f services/gateway/Dockerfile -t umiak-gateway:dev --build-arg VERSION=$(git rev-parse --short HEAD) .
docker run --rm umiak-gateway:dev version
```

The build runs from the repository root. `services/gateway/Dockerfile.dockerignore` replaces the root `.dockerignore`
and leaves only `libs/proto`, `libs/tunnel`, `services/gateway` in the context. The module is built with `GOWORK=off`
through its own `replace` directives. The final image is `gcr.io/distroless/static-debian13:nonroot`. It has no shell, so
the healthcheck calls `umiak-gateway healthcheck`.
