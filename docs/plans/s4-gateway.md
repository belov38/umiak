# S4 Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `services/gateway`, the Go binary `sbx-gateway`, built on `libs/tunnel`. It covers:
- the agent tunnel listener;
- the internal listener;
- the public HTTP proxy for `https://<slug>-<port>.sbx.<domain>`, with access modes `public`, `token` and `sso`;
- cached route lookup against the control plane, with `NOTIFY sbx_routes` invalidation;
- TLS edge with SNI and PROXY v2, and a plain mode behind an ingress;
- the SSH gateway: x/crypto/ssh in front, the VM's sshd behind it through the tunnel;
- rate limits, metrics, access log;
- multi-instance drain under the `terminationGracePeriodSeconds: 960` contract.

**Architecture:** The pod that accepts a connection does all the application work. It needs only a byte stream to `127.0.0.1:port` in the VM. It gets that stream from its own tunnel (`MachineConn.DialTCPWith`) or from the owner pod (`DialRemoteTCP`, h2c peer CONNECT).
- The control plane sits behind one Go interface (`cpapi.Client`). There is an HTTP implementation per S4 §6.1/§8.4/§9.2 and an in-memory fake for tests; S7 is not built yet.
- All Postgres notifications share the one LISTEN connection of `libs/tunnel`: `tunnel_sessions`, `gateway_instances`, `sbx_routes`, `sbx_ssh_revoke`.
- Missing generic pieces go into `libs/tunnel`, not into the binary (spec §16.1):
  - the owner cache;
  - extra LISTEN channels;
  - distinguishable dial errors;
  - a public Postgres test helper.

**Tech Stack:** Go 1.27.3; std `net/http`, `net/http/httputil`, `crypto/tls`. Libraries:

| Library | Version |
|---|---|
| `golang.org/x/crypto/ssh` | v0.58.0 |
| `golang.org/x/time/rate` | v0.16.0 |
| `golang.org/x/sync/singleflight` | v0.24.0 |
| `github.com/pires/go-proxyproto` | v0.16.0 |
| `github.com/prometheus/client_golang` | v1.25.0 |
| `github.com/fsnotify/fsnotify` | v1.10.1 |
| `github.com/jackc/pgx/v5` | v5.11.0 |
| `github.com/oklog/ulid/v2` | v2.1.2 |

All versions were checked on 2026-10-30 with `go list -m -versions`. Postgres 18.6 (`postgres:18.6-alpine`) is used in tests. OpenSSH 10.x (system `ssh`/`sshd`) is used for the real-client SSH e2e.

**Spec:** `docs/specs/s4-gateway.md` (section numbers below refer to it), on top of `docs/specs/s2-tunnel-protocol.md`. Overrides from S7 O1–O3/§12.1, S8 §8 and S10 §10 are listed under Deviations.

## Global Constraints

- Tools only through mise (`mise exec -- <cmd>`). Before adding a dependency not listed above, check the latest stable version.
- New module `services/gateway`, path `github.com/belov38/boat-dev-clone/services/gateway`:
  - `go 1.27`, `toolchain go1.27.3`;
  - `replace` directives for `../../libs/tunnel` and `../../libs/proto`;
  - registered with `go work use ./services/gateway`.
- Binary `services/gateway/cmd/sbx-gateway`. No cgo. Linux is the target. `go vet`, `go test -race` and `golangci-lint run` must pass in both `libs/tunnel` and `services/gateway`. The gateway's `.golangci.yml` is a copy of `libs/tunnel/.golangci.yml`, minus the testpb exclusion.
- `libs/tunnel` changes are additive and keep their existing behaviour and tests green. `GOOS=windows` build and vet of `libs/tunnel` must still pass.
- Serve `gateway.InternalHandler()` unchanged. Keep these existing contracts:
  - a refused agent answer on a Connect stream is a `200` with an end-stream error `bad_agent_response`, not a `502`;
  - `Sbx-Upload-Offset` is the only `Sbx-*` header passed from agents on `/rpc/` and `/files/`;
  - the per-machine limit of 800 TCP streams (`MaxTCPStreamsPerMachine`) is counted by the owner.
- Drain contract (master and S2 acceptance):
  - after `Gateway.Drain` returns, close the internal listener with `http.Server.Shutdown`. That server has `IdleTimeout` set (120 s).
  - `terminationGracePeriodSeconds` is 960 and must cover `EndpointWait + DrainSpread + SSH drain (15 min) + margin`.
- TCP conns from `DialTCPWith`/`DialRemoteTCP` have no deadlines: the setters return `ErrUnsupported`, and only `Close` unblocks them.
  - All idle and drain timeouts on them are timers that call `Close`. `SetDeadline` is never called.
  - When the target closes its write side first, the whole stream ends. SSH and HTTP code must tolerate that.
- `Gateway.Machine()` also returns draining sessions. `OnInstanceChange("")` and the new `OnSessionChange("")` mean "resync everything".
- Moved instances: an instance URL from `MovedError.InstanceURL` or `Sbx-Instance-Url` gets the service token only after `registry.Store.InstanceByURL` confirms a live instance. Otherwise do a fresh owner lookup.
- Peer transport: `gateway.NewPeerTransport()` with `DisableCompression = true` (set after construction). App transports have `DisableCompression: true` too, so the proxy is byte-transparent.
- Tunnel listener: `ReadHeaderTimeout` 10 s, `MaxHeaderBytes` 16 KiB, and an admission token bucket (default 200/s, burst 1000). Over the limit the answer is `503` with `Retry-After: 1`. No per-IP limits on the tunnel (spec §11).
- No public IPs. Cookies are `__Host-` only. Domain default is `sbx.<domain>`. Tests run on localhost only and never touch `pve`.
- Postgres in tests: `SBX_TEST_DATABASE_URL`, else Docker `postgres:18.6-alpine`. With neither, the test fails, unless `SBX_TEST_SKIP_PG=1`.
- OpenSSH e2e: it runs when `ssh` and `sshd` are on PATH (or `/usr/sbin/sshd`). Otherwise `t.Skip` with the reason, and the test is listed in the final report.
- Code comments in English. Commits have no `Claude-Session:` trailer and no session link. Root files (`go.work`, `.github`) get only our own entries.

## Review Focus

1. **Host header vs SNI on a coalesced HTTP/2 connection.** Browsers reuse one connection for every `*.sbx` host under the wildcard. Routing must use `:authority`/`Host` per request and nothing cached per connection. The tunnel SNI must never reach the proxy, and vice versa. Test in Task 10: an h2 connection opened with SNI `a-80` sends a request for `b-80` and reaches b. A request for `tunnel.<domain>` on an sbx connection gets `404 route_not_found`.
2. **A hostile app kills a shared browser connection.** A huge response header block, many or huge trailers, or `Sbx-*`/`Set-Cookie: __Host-sbx_auth`/`Alt-Svc` must not pass. Test in Task 15:
   - header block over 64 KiB → `502 upstream_error`;
   - trailers over the cap are dropped, and the h2 connection stays usable for another label;
   - forbidden headers and trailers are stripped.
3. **API down for long.** Expired cache entries serve up to 10 min and blocked stays blocked. A new label gets `503`, and nothing hangs longer than 3 s. Test in Task 4 (cache, fake clock) and Task 14 (`Fake.SetDown`).
4. **Owner pod drains while the front holds SSH.** The front learns the deadline from `NOTIFY gateway_instances`, warns at once and at T−1 min, and closes at the owner's deadline. A LISTEN reconnect (`""`) recomputes all deadlines. Test in Task 13 (unit, fake clock) and Task 16 (e2e, shrunk timings).
5. **Stale route after rename or move.** No request reaches the old sandbox after `NOTIFY sbx_routes` for the old slug. After a machine moves, a pooled keep-alive to the old epoch is not reused. Test in Task 14:
   - after rename and notify, the old label is `404` within 1 s;
   - after a forced agent reconnect, the next request uses a new synthetic host epoch (the `GotConn` info shows a new conn).

## Deviations from the spec (executor decisions, recorded)

- **Sandbox states (S7 O3 overrides §6.3):**
  - `ready` → proxy; `creating`, `starting` → `503 sandbox_starting`;
  - `stopping`, `stopped` → `503 sandbox_stopped`; `deleting`, `deleted` → `404`;
  - anything else → `503 sandbox_unavailable`.
  - For compatibility with the §6.3 text, `running` is treated as `ready` and `resuming` as `starting`.
- **Route response:** the S4 §6.1 shape plus the optional `kind` (`port` by default; `desktop` per S10 §10.1).
  - The grammar recognises the label `<slug>-desktop` as kind `desktop`. Without a configured desktop handler, which is a seam for S10, it answers `404 route_not_found`.
  - Whole reserved slugs (`api app www ssh tunnel admin static sbx`) give `404` (S7 §5.4).
  - Default reserved ports are `22,47800,47984,47989,47990,48010` (S10).
- **`ssh/authorize` response:** gains `teamId`, the sandbox's team in public format. The §9.5 revoke matching for `member:`/`team:` needs it, and S7 §12.1 lacks it.
  - The gateway fails closed: an allowed answer without `teamId` is treated like an `api` failure (login refused, `Error` log, `sbx_gateway_ssh_auth_total{result="unavailable"}`). Otherwise `member:`/`team:` revocations would silently miss the session.
  - The payload IDs of `sbx_ssh_revoke` are compared as opaque strings with the `userId`/`apiKeyId`/`teamId` that `api` returns. Both must use the same format, the public one.
  - Contract note for S7/S8.
- **Dial errors:**
  - The agent library answers a failed CONNECT dial with `502` and `Sbx-Dial-Error: refused|timeout` (S4 §7.2). The S3 §12 text says `Sbx-Error: connection_refused`; the S4 header wins because CONNECT is served by `libs/tunnel`.
  - The S3 `Dial` must return errors that wrap `syscall.ECONNREFUSED` (Windows: `WSAECONNREFUSED`) or a timeout `net.Error`.
  - Peer CONNECT passes the reason on the same header, values from a closed set.
- **Per-machine stream limit:** the owner answers a peer CONNECT over the limit with `429 too_many_streams` (existing `libs/tunnel` wire), not `503`. The front maps it (`ErrTooManyStreams`) to `503 overloaded` as the spec requires.
- **Owner drain wire:** `Timing.TCPDeadline` is set to 15 min, so `Control/Drain` always carries 15 min (§10.4). HTTP streams are opened with an explicit `DrainDeadline` of 2 min, and SSH streams with 15 min.
- **Service tokens:**
  - The gateway accepts callers from `SBX_GATEWAY_SERVICE_TOKENS_FILE`, JSON `{"api":[..],"worker":[..],"gateway":[..]}`, the same shape as S7's `SBX_API_SERVICE_TOKENS_FILE`. It sends `tokens["gateway"][0]` to peers.
  - It calls `api` with `SBX_GATEWAY_API_TOKEN_FILE`.
  - The cookie keys env is `SBX_GATEWAY_COOKIE_KEYS_FILE` (§16.2; §8.2 says `SBX_GATEWAY_COOKIE_KEYS`).
  - The login CA keys env is `SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE`, a file in authorized_keys format (§9.2 and §16.2 say `SBX_GATEWAY_SSH_LOGIN_CA_KEYS`).
- **Database URL:** `SBX_GATEWAY_DATABASE_URL`, falling back to `DATABASE_URL`, which the compose `*db-env` anchor sets.
- **State cookie:** `__Host-sbx_state_<first 8 chars of state>`, one per login in flight, so parallel SSO logins on one label (tabs, session restore) do not overwrite each other. It uses the auth cookie codec with a distinct version tag `v1s`: an auth cookie can never be accepted as a state cookie, and vice versa. The callback reads the cookie of its own state; a callback without one is `401` and is not counted as an auth failure (only a mismatching state cookie or a failed code exchange is). The strip removes every `__Host-sbx_state*` cookie.
  - At most 8 state cookies per host: an sso redirect that would make more also clears the oldest (`Max-Age=0`, same attributes): first those that do not open as a state of the label, then by the sealed expiry. The `rd` kept in the state is at most 512 bytes (longer becomes `/`). Without both caps, repeated navigations with long paths pushed the Cookie header past 64 KiB and locked the user out of the callback and logout for the state TTL.
- **SSH auth-failure limit:** counted per failed connection (no successful auth before the handshake ends), not per offered key. Clients with many agent keys would otherwise trip it at once.
- **h2c apps:** an HTTP/1.1 client request to an `appProtocol: h2c` route is still proxied over h2c, except `Upgrade` requests, which get `502 upstream_error`.
- **Response header and trailer caps** (not in the spec; protects coalesced browser connections):
  - header block ≤ 64 KiB, else `502 upstream_error`;
  - trailers ≤ 64 KiB and ≤ 100 fields, else dropped and logged.
- **Upgrades:** only `Upgrade: websocket` on `GET` is forwarded (§7.3 names only WebSocket). Other upgrade tokens are stripped and the request is proxied plainly, which closes h2c smuggling. The preflight bypass never applies to upgrades.
- **Rate-limit buckets:** the per-IP bucket is checked before the route lookup, the per-label bucket only after a route is found, so unknown labels cannot grow the bucket map. `Retry-After` is rounded up to at least 1 s.
- **SSH channels:** at most 256 open channels per SSH connection (client- and backend-initiated, all types; `SBX_GATEWAY_SSH_MAX_CHANNELS`). Over the cap the open fails with `ResourceShortage` "sbx: too many open channels". §11 is silent; without a cap one user could pin about 2 MB of gateway memory per channel.
- **TLS handshake budgets** (§5.1 has only the global cap; one IP could fill it and block `*.sbx` and the agent tunnels):
  - per client IP (`ratelimit.Key`: IPv4 /32, IPv6 /64) at most `SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP` (default 64) handshakes in flight, from the accept to the end of the TLS handshake, the wait for the PROXY header and the ClientHello included. Over the cap the conn is closed at once and counted as `sbx_gateway_ratelimited_total{limit="handshakes"}`;
  - the client IP is the transport peer, read in the accept loop without I/O (`proxyproto.Conn.Raw`), unless the peer is a trusted PROXY source: then a general slot is taken in the accept loop and the per-IP check runs in the handshake goroutine once the header is read (bounded by the handshake timeout), keyed by the header address;
  - `SBX_GATEWAY_RATELIMIT_EXEMPT_CIDRS` (node SNAT) skip the per-IP and the general cap and use their own budget of 4096 handshakes. A conn from the trusted PROXY source that finds the general budget full borrows an exempt slot until its header is read; a non-exempt header then needs a general slot or the conn is closed;
  - the general cap (4096) stays as the last resort; conns shed by it or by a full exempt budget count as `sbx_gateway_tls_handshake_errors_total{sni_kind="unknown"}`, as before.
- **SSH re-check:** the re-check of open sessions after a LISTEN reconnect (§9.5) sends `ssh/authorize` with `"recheck": true`. `api` checks the identity as on a login and skips the certificate validity: the gateway validated the certificate at login, and sessions outlive the 10-minute certificates.
- **Owner lookups (§6.4, local first):** the HTTP proxy takes the synthetic host epoch of a machine connected to this instance from the local session (`gateway.MachineConn.Epoch`), without a registry query, so previews of local machines survive a Postgres outage. For other machines the owner lookup for the epoch is bounded by min(`Timeouts.Dial`, 2 s); a failed lookup is logged and the request goes on with epoch 0, and the dial maps its own errors within `Timeouts.Dial` (+ `AgentWait`). Concurrent owner misses of one machine share one registry query (`registry.OwnerCache`, singleflight, 10 s per query).
- **Route cache under a hung `api`:** after a failed refresh an expired route is served stale at once and refreshed in the background (at most once per 1 s backoff), so only the request that found the route expired waits for the lookup timeout.
- **Host case:** an upper-case Host routes to the same label (Host is lower-cased, §4.2). A Host with a port other than `:443` is `404 route_not_found`, also in the local stack (see `deploy/compose/README.gateway.md`).
- **Tests:**
  - 1000 WebSockets through one peer are split across two machines on the owner, because the per-machine limit is 800 streams. One A→C h2 connection is asserted.
  - The refused port in tests is `127.0.0.1:1` (a stable `ECONNREFUSED`).
  - The 512 MiB upload test uses 64 MiB under the race detector.
  - OpenSSH e2e: a missing `ssh`/`sshd` skips the test. A failing sshd start or a failing direct-login preflight skips locally, but fails when `CI` is set: the CI job installs OpenSSH for it.
- **Process (Task 17):**
  - `SBX_GATEWAY_API_URL` is required. `none` is a dev mode: every route lookup is `503 route_lookup_unavailable`, SSH logins fail, and agent events are logged, acknowledged and dropped (`server.Deps.Sink` is nil and no HTTP sink is built). Other values must be `http(s)` URLs and need `SBX_GATEWAY_API_TOKEN_FILE`.
  - `serve` also requires `SBX_GATEWAY_SBX_DOMAIN`, `SBX_GATEWAY_TUNNEL_HOST`, the database URL and an `http(s)` `SBX_GATEWAY_INTERNAL_URL` (`config.ValidateServe`). `check-config` runs the same checks.
  - Two drain knobs for local runs and tests: `SBX_GATEWAY_ENDPOINT_WAIT` (default 5 s, `Timing.EndpointWait`) and `SBX_GATEWAY_DRAIN_TIMEOUT` (default `server.DrainBudget` + 30 s = 950 s). A second SIGTERM/SIGINT cancels the drain and exits with status 1 within 5 s.
  - `sbx-gateway healthcheck [-url]` exists because the distroless image has no shell or curl.
  - `sbx-gateway dev-secrets` creates the local secrets (`internal/devsecrets`): a dev CA name-constrained to the stack's names, and 397-day leaf certificates. The derived `login-ca-keys` and `worker-gateway-token` are rewritten when they differ from their source. `-owner`/`-worker-owner` hand every file of the set, existing ones included, to the container users.
  - A SIGTERM during startup is not lost: `Instance.Drain` before `Run` waits for Run to serve (bounded by its ctx; nil if Run returned without serving), and the tunnel drain waits for the registration. `serve` stops Run when the drain fails. Every wait for Run also listens for a second signal, and is bounded (30 s after a drain, 5 s after a forced stop). A forced exit does not wait for the database pool.
  - Image: `golang:1.27.3-trixie` → `gcr.io/distroless/static-debian13:nonroot` (debian13 is the current distroless base). The build runs with `GOWORK=off` through the module's `replace` directives. `services/gateway/Dockerfile.dockerignore` replaces the root `.dockerignore`, which excludes `services/`.
  - Compose: `deploy/compose/gateway.yaml` works with `-f` or `include:`. It also extends `worker` with `SBX_GATEWAY_SERVICE_TOKEN_FILE` and mounts the secrets directory read-only, not the token file: Docker would create a missing file source as a directory. Host ports are overridable (`GATEWAY_HTTPS_PORT` and others); browsers need `GATEWAY_HTTPS_PORT=443`, since a Host with a port does not route.
- **Not in this thread:**
  - desktop/TURN (S10): seams only — the desktop kind, the cookie mode `d` allowed by the codec, and a nil `httpproxy.Config.Desktop`;
  - the k8s manifests (S12);
  - the real `api` endpoints (S7).

## Contract changes for other scopes

- **S3 (guest agent):** a failed TCP dial must return an error that wraps `syscall.ECONNREFUSED` (Windows: `WSAECONNREFUSED`) or a timeout `net.Error`. `libs/tunnel` turns it into `502` with `Sbx-Dial-Error: refused|timeout`, and the gateway maps that to `502 app_not_listening` / `504 app_timeout`. The S3 §12 header `Sbx-Error: connection_refused` is replaced by it.
- **S6 (control plane):**
  - Sandbox states as in S7 O3: `ready` proxies; `creating`/`starting` → `503 sandbox_starting`; `stopping`/`stopped` → `503 sandbox_stopped`; `deleting`/`deleted` → `404`. `running`/`resuming` are accepted as aliases.
  - `sbx_routes` is a contract S6 must implement, not a change: it is already in spec §6.2. The S6 triggers in main send the slug (old and new on a rename). Nobody sends `*` yet; S8 must send it for the global `public` switch, which flushes every route.
- **S7 (api):**
  - Route response: the optional `kind` (`port` by default, `desktop`).
  - `ssh/authorize` answers `teamId` in public format, and accepts `"recheck": true` (identity check without the certificate validity). Both are hard requirements: an allowed answer without `teamId` fails the SSH login (the gateway fails closed), and re-checks after a LISTEN reconnect depend on `recheck`.
  - `POST /internal/v1/agent-events` (the tunnel event sink, `gateway.NewHTTPSink`) must accept the gateway's `api` token (`SBX_GATEWAY_API_TOKEN_FILE`, under `gateway` in `SBX_API_SERVICE_TOKENS_FILE`).
  - `api` checks the label of a route lookup: the gateway rejects a route whose `label` differs from the requested one.
  - Service tokens: the gateway accepts `{"api":[..],"worker":[..],"gateway":[..]}` from `SBX_GATEWAY_SERVICE_TOKENS_FILE` and calls `api` with `SBX_GATEWAY_API_TOKEN_FILE`, which `api` must accept under `gateway` in `SBX_API_SERVICE_TOKENS_FILE`. In the local stack both come from `deploy/compose/secrets/gateway/` (`api-token`, `service-tokens.json` → `api[0]`).
- **S8 (web):**
  - The IDs in `sbx_ssh_revoke` payloads (`user:`, `member:`, `team:`, `key:`) are compared as opaque strings with `userId`/`apiKeyId`/`teamId` from `ssh/authorize`. Both must be in the public format of the `api` IDs.
  - The global `public` switch must send `pg_notify('sbx_routes', '*')`, which flushes every cached route.
- **S10 (desktop):** seams only. `<slug>-desktop` is parsed as kind `desktop`, the cookie mode `d` is accepted by the codec, and `httpproxy.Config.Desktop` is nil (`404 route_not_found`) until S10 sets a handler. Reserved ports `22,47800,47984,47989,47990,48010`.
  - The desktop handler is called after the host, rate-limit, route and sandbox-state checks, but before the port access check and the upgrade filtering. S10 must do its own authorization and its own upgrade policy (which `Upgrade` tokens on which methods it forwards).
- **S12 (operations):**
  - `terminationGracePeriodSeconds: 960`; the process bounds its drain at 950 s.
  - Ports: 8443 TLS (SNI `*.<sbx domain>` and the tunnel host), 2222 SSH, 7000 internal, 9090 metrics/health.
  - Only PROXY protocol v2 is accepted (`SBX_GATEWAY_PROXY_PROTOCOL=v2`, from `SBX_GATEWAY_PROXY_PROTOCOL_CIDRS`). `v2` requires a non-empty `SBX_GATEWAY_PROXY_PROTOCOL_CIDRS`: `serve` and `check-config` refuse the config otherwise.
  - The internal port 7000 (peer CONNECT, `/rpc/`, admin) must be reachable only from the gateway, worker and `api` pods (NetworkPolicy). Its service tokens are the only other guard.
  - Plain mode (behind an ingress): the gateway applies the sbx-side limits (`ReadHeader`, `MaxHeaderBytes`) to every request of the plain listener, the tunnel host included. The tighter tunnel-listener limits of the TLS edge (10 s header timeout, 16 KiB headers, HTTP/1 only) are not applied there: the ingress must enforce them for the tunnel host.
  - Drain knobs: `SBX_GATEWAY_ENDPOINT_WAIT` (default 5 s: how long a draining instance keeps accepting while the load balancer drops it) and `SBX_GATEWAY_DRAIN_TIMEOUT` (default 950 s). Keep `SBX_GATEWAY_DRAIN_TIMEOUT` below `terminationGracePeriodSeconds` (960 s).
  - Probes for the distroless image: `sbx-gateway healthcheck [-url]` (no shell or curl in the image), e.g. as an exec probe or the compose healthcheck.
  - Env names that differ from the spec text: `SBX_GATEWAY_COOKIE_KEYS_FILE` (§8.2: `SBX_GATEWAY_COOKIE_KEYS`) and `SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE` (§9.2, §16.2: `SBX_GATEWAY_SSH_LOGIN_CA_KEYS`); both name files. `SBX_GATEWAY_API_URL` is required (`none` for the dev mode).
  - TLS handshake budgets: `SBX_GATEWAY_TLS_MAX_HANDSHAKES_PER_IP` (default 64 in flight per client IP); node SNAT in `SBX_GATEWAY_RATELIMIT_EXEMPT_CIDRS` has a separate budget of 4096, the rest shares 4096. Behind the load balancer the per-IP cap needs the PROXY v2 header (otherwise every conn counts against the LB address). Alert on `sbx_gateway_ratelimited_total{limit="handshakes"}`.
  - Readiness: `/readyz` is 200 while the tunnel gateway runs, the instance does not drain and the certificates are loaded; Postgres and `api` health do not count (§12.3). `/healthz` is liveness only.

---

## File structure

```
go.work                                     + ./services/gateway
.github/workflows/gateway.yml               CI: go test -race, vet, lint for services/gateway
libs/tunnel/
  tunneltest/pgtest/pgtest.go               moved from internal/pgtest (public test helper)
  wire/wire.go                              + HeaderDialError, DialErrorRefused, DialErrorTimeout
  transport/transport.go                    DialError gains Reason
  agent/connect.go, agent/dialerr*.go       classify Dial errors, write Sbx-Dial-Error
  gateway/tcp.go, gateway/machineconn.go    parse/forward the reason
  registry/listen.go                        ListenHandlers.Channels (extra channels)
  registry/owners.go                        OwnerCache (Lookup, Wait, Invalidate)
  gateway/gateway.go, gateway/fence.go      Config.OnSessionChange, Config.ListenChannels
services/gateway/
  go.mod, .golangci.yml, Dockerfile
  cmd/sbx-gateway/main.go                   "serve" (default) and "dev-secrets"
  internal/config/        env → Config; file loaders (tokens, keys, CIDRs)
  internal/obs/           Prometheus metrics (§12.1), access log, SSH log
  internal/sbxerr/        gateway error responses (§7.6): HTML/JSON, Sbx-Error, no-store
  internal/cpapi/         control-plane contract: types, Client, HTTP client
  internal/cpapi/cpapitest/  Fake (in-memory) + NewServer(fake) httptest server
  internal/routes/        label grammar, cache (TTL, singleflight, stale), state decision
  internal/upstream/      owner resolution, local/peer dial, app transports, conn wrapper
  internal/ratelimit/     token buckets and concurrency limits (§11)
  internal/portauth/      cookie codec, token and sso flows, /__sbx/*
  internal/httpproxy/     request pipeline, header policy, stream tracker, access log
  internal/edge/          TLS SNI dispatch, PROXY v2, cert reload, tunnel handler, plain mode
  internal/sshgw/         SSH server, auth, backend, forwarding, revoke, drain
  internal/server/        Instance: assembly, LISTEN wiring, health, Drain orchestration
  internal/devsecrets/    dev PKI and keys for compose
  internal/testenv/       harness: Postgres, memnet, PKI, instances, machines, VM apps
  internal/testenv/sshdtest/  in-process sshd double (user CA, channels, hostkeys-00)
  internal/e2e/           multi-instance scenarios, security suite, OpenSSH e2e
deploy/compose/gateway.yaml                 include-able compose fragment
deploy/compose/README.gateway.md            how to wire it into the S6 stack
```

---

### Task 1: `libs/tunnel`: public Postgres helper and distinguishable dial errors

**Files:**
- Move: `libs/tunnel/internal/pgtest/pgtest.go` → `libs/tunnel/tunneltest/pgtest/pgtest.go`. Update every importer (`registry`, `gateway`, `internal/e2e`, `internal/cmd/tunnelharness`).
- Modify:
  - `libs/tunnel/wire/wire.go`
  - `libs/tunnel/transport/transport.go`
  - `libs/tunnel/agent/connect.go`
  - `libs/tunnel/gateway/machineconn.go` (CONNECT answer parsing)
  - `libs/tunnel/gateway/tcp.go`
- Create: `libs/tunnel/agent/dialerr.go`, `dialerr_windows.go`, `dialerr_other.go`.
- Test: `libs/tunnel/agent/connect_test.go`, `libs/tunnel/gateway/internal_test.go` (peer CONNECT cases).

**Interfaces:**
- Produces:
  - `pgtest.Main(m)`, `pgtest.New(t) (*pgxpool.Pool, string)` and `pgtest.ApplyMigrations` under `github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/pgtest`, with unchanged behaviour.
  - `wire.HeaderDialError = "Sbx-Dial-Error"`, `wire.DialErrorRefused = "refused"`, `wire.DialErrorTimeout = "timeout"`.
  - `transport.DialError{Status int; Reason string}`. `Reason` is `""`, `"refused"` or `"timeout"`, and `Error()` includes it.

- [ ] Step 1: Move pgtest. Run `go test ./...` in `libs/tunnel`: PASS, with the same test count as before the move.
- [ ] Step 2: Write failing tests:
  - `TestConnectDialErrorReason` (agent): `Config.Dial` returns
    - an error wrapping `syscall.ECONNREFUSED` → the CONNECT answer is `502` with `Sbx-Dial-Error: refused`;
    - a `net.Error` with `Timeout()` → `timeout`;
    - `context.DeadlineExceeded` → `timeout`;
    - `errors.New("x")` → `502` with no header.
  - `TestDialTCPReason` (gateway): `DialTCPWith` returns `*transport.DialError{Status:502, Reason:"refused"}`. An agent header value outside the set (`Sbx-Dial-Error: <script>`) gives `Reason ""`.
  - `TestPeerConnectReason`: `DialRemoteTCP` against an internal listener whose machine refuses gets the `DialError` with the same reason. The peer answer carries only the normalised header.
- [ ] Step 3: Run them: FAIL.
- [ ] Step 4: Implement:
  - `classifyDialError(err) string` with build-tagged refused detection (Windows: `syscall.Errno(10061)`);
  - the header write in `serveConnect`;
  - parsing in the gateway's CONNECT answer handling;
  - `serveTCP` writing `Sbx-Dial-Error` on its 502 only from the closed set;
  - `DialRemoteTCP` parsing it.
- [ ] Step 5: Run `go test -race ./...`, `golangci-lint run ./...` and `GOOS=windows go vet ./...` in `libs/tunnel`: PASS.
- [ ] Step 6: Commit `tunnel: public pgtest helper; Sbx-Dial-Error reasons on refused CONNECT dials`.

### Task 2: `libs/tunnel`: extra LISTEN channels, session hook, owner cache

**Files:**
- Modify:
  - `libs/tunnel/registry/listen.go`
  - `libs/tunnel/gateway/gateway.go` (Config)
  - `libs/tunnel/gateway/fence.go` (listenLoop wiring, queued workers)
- Create: `libs/tunnel/registry/owners.go`.
- Test: `libs/tunnel/registry/listen_test.go`, `libs/tunnel/registry/owners_test.go`, `libs/tunnel/gateway/gateway_test.go`.

**Interfaces:**
- Produces:
  - `registry.ListenHandlers.Channels map[string]func(payload string)`. These are extra channels LISTENed on the same connection. Each handler is called with `""` after every (re)LISTEN. Channel names are quoted with `pgx.Identifier`.
  - `gateway.Config.OnSessionChange func(machineID string)`. It is called for every `tunnel_sessions` notification, and with `""` after a reconnect. Calls are sequential, from a gateway goroutine, through a queue like `OnInstanceChange`, so a slow hook never delays fencing.
  - `gateway.Config.ListenChannels map[string]func(payload string)`. It is passed to `ListenHandlers.Channels`. The handlers run on the listener goroutine and must not block; the gateway binary queues its work.
  - `registry.NewOwnerCache(s *Store, staleAfter, ttl time.Duration) *OwnerCache`. `ttl` defaults to 5 s and is a guard against a crashed owner that has not been swept yet.
  - `(*OwnerCache).Lookup(ctx, machineID) (Owner, bool, error)`: positive entries are cached up to `ttl`, negatives are not cached.
  - `(*OwnerCache).Invalidate(machineID string)`: `""` clears everything and wakes waiters.
  - `(*OwnerCache).Wait(ctx, machineID string, timeout time.Duration) (Owner, bool, error)`: a Lookup; if there is no owner, it blocks until `Invalidate(machineID)` or `Invalidate("")`, then looks up again, until the timeout. It returns `false, nil` on timeout.

- [ ] Step 1: Write failing tests:
  - `TestListenExtraChannels`: `pg_notify('sbx_routes','a')` reaches `Channels["sbx_routes"]` with `"a"`. After the connection is killed (`pg_terminate_backend`), every handler, extra ones included, receives `""`.
  - `TestOwnerCacheWait`: Wait on an unknown machine; another goroutine admits a session and calls Invalidate(id); Wait returns the owner in under 1 s. Without Invalidate it returns `false` after the timeout.
  - `TestOwnerCacheTTL`: a cached owner whose instance goes stale is not returned after `ttl`.
  - `TestGatewayOnSessionChange`: admission of a machine calls the hook with its id.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `go test -race ./...` and lint in `libs/tunnel`: PASS.
- [ ] Step 5: Commit `tunnel: extra LISTEN channels, OnSessionChange, OwnerCache`.

### Task 3: Gateway module skeleton: config, observability, error responses

**Files:**
- Create:
  - `services/gateway/go.mod`, `.golangci.yml`
  - `cmd/sbx-gateway/main.go` (only `version` and config validation for now)
  - `internal/config/config.go`, `config_test.go`
  - `internal/obs/metrics.go`, `accesslog.go`, `obs_test.go`
  - `internal/sbxerr/sbxerr.go`, `sbxerr_test.go`
- Modify: `go.work`.

**Interfaces:**
- Produces `config.Config`. Its sections are below; durations are `time.Duration`, CIDRs are `[]netip.Prefix`. `config.FromEnv(getenv func(string) string) (Config, error)` validates and fills the defaults.
  - **Identity and internal listener:** `InstanceID` (default `hostname-<uuid8>`), `DatabaseURL`, `InternalListen` (`:7000`), `InternalURL` (required), `ServiceTokens gateway.TokenSet`, `PeerToken string`.
  - **Listeners:** `TLSListen` (`:8443`), `SSHListen` (`:2222`), `HTTPListen` (`""`), `MetricsListen` (`:9090`).
  - **Names:** `SbxDomain`, `TunnelHost`, `SSHHost`.
  - **TLS files:** `SbxCertFile`, `SbxKeyFile`, `TunnelCertFile`, `TunnelKeyFile`.
  - **Client IP:** `ProxyProtocol bool`, `ProxyProtocolCIDRs`, `TrustedProxyCIDRs`.
  - **API:** `APIURL`, `APIToken`, `AuthURL`.
  - **Cookies:** `CookieKeys []CookieKey{ID string; Key []byte}` (first signs), `CookieCrossSite bool`, `StripCookiePrefixes` (default `_oauth2_proxy,__Host-oauth2_proxy,__Secure-oauth2_proxy`).
  - **SSH keys:** `SSHHostKeys []ssh.Signer`, `SSHUserCA ssh.Signer`, `SSHLoginCAKeys []ssh.PublicKey`.
  - **Reserved names:** `ReservedPorts` (default above), `ReservedSuffixes` (`desktop`), `ReservedSlugs` (`api,app,www,ssh,tunnel,admin,static,sbx`).
  - **Rate limits:** `RateLimit ratelimit.Config` (ratelimit is defined in Task 7; until then a local struct with the same fields, moved in Task 7), `RateLimitExempt`.
  - **Drain:** `HTTPDrainDeadline` (2 m), `SSHDrainDeadline` (15 m).
  - **Timeouts:** `Timeouts{TLSHandshake 10s, ReadHeader 10s, MaxHeaderBytes 64<<10, ClientIdle 120s, RouteLookup 3s, AgentWait 10s, Dial 10s, ResponseHeader 5m, StreamIdle 60m}`.
  - **Tunnel:** `TunnelAdmitRate` (200), `TunnelAdmitBurst` (1000), `MinAgentVersion`.
  - **Logging:** `LogLevel`.
- Env names follow §16.2: `SBX_GATEWAY_<NAME>`, `_FILE` for files, and `SBX_GATEWAY_TIMEOUT_<NAME>` for the timeouts. Lists are comma-separated. The service tokens and the cookie keys are files (JSON and `kid:base64` lines).
- Produces `obs.Metrics`. `obs.NewMetrics(reg prometheus.Registerer) *Metrics` creates every metric of §12.1 with the exact names and labels, plus `sbx_gateway_dependency_up{dep}` and `sbx_gateway_tunnel_admit_limited_total`. The fields are typed counters and histograms, e.g. `HTTPRequests *prometheus.CounterVec`.
- Produces `obs.AccessLog`:
  - `obs.NewAccessLog(w io.Writer) *AccessLog`;
  - `(*AccessLog).HTTP(e HTTPEntry)` writes one JSON line with exactly the §12.2 fields;
  - `(*AccessLog).SSH(e SSHEntry)`.
- Produces `sbxerr`:
  - `sbxerr.Write(w http.ResponseWriter, r *http.Request, e Error)`, where `Error{Status int; Code string; Message string; Retryable bool; RetryAfter int; RequestID string; Refresh bool}`;
  - the constants `sbxerr.CodeRouteNotFound`, … for every code of §7.6, plus `token_invalid`, `auth_required`, `rate_limited`.

- [ ] Step 1: Write failing tests:
  - `TestFromEnvDefaults`: a minimal env gives the defaults listed above.
  - `TestFromEnvFiles`: tokens JSON, cookie keys with two kids, SSH keys in OpenSSH format, all from temp files.
  - `TestFromEnvErrors`: a missing `SBX_GATEWAY_INTERNAL_URL`, a cookie key that is not 32 bytes, a bad CIDR, `PROXY_PROTOCOL=v3` → error naming the variable.
  - `TestAccessLogFields`: the JSON keys are exactly the §12.2 list, and the path has no query.
  - `TestSbxerrHTML`/`TestSbxerrJSON`:
    - `Accept: text/html` gives an HTML body with no external resources (no `src=`/`href=http`), plus `Sbx-Error`, `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`;
    - otherwise JSON `{"error":{"code","message","retryable","requestId"}}`;
    - `Refresh` adds `<meta http-equiv="refresh" content="5">`.
  - `TestMetricsNames`: a gather lists every §12.1 name.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement. Add the module to `go.work`.
- [ ] Step 4: `cd services/gateway && go test -race ./... && go vet ./... && golangci-lint run ./...`: PASS.
- [ ] Step 5: Commit `gateway: module skeleton, config, metrics, access log, error pages`.

### Task 4: Control-plane contract and route cache

**Files:**
- Create:
  - `internal/cpapi/cpapi.go`, `http.go`, `http_test.go`
  - `internal/cpapi/cpapitest/fake.go`, `server.go`
  - `internal/routes/label.go`, `cache.go`, `decide.go`, plus tests.

**Interfaces:**
- Produces in `cpapi`:
  - `Route{Label, SandboxID, Slug string; Port uint16; MachineID string; SandboxState, Access, TokenHash string; AuthEpoch int64; Blocked bool; BlockReason, HostRewrite, AppProtocol, TeamID, Kind string}`. JSON tags follow §6.1, `machineId` null maps to `""`, and `kind` defaults to `port`.
  - `PortAuthGrant{UserID, Email, Label string; AuthEpoch int64}`.
  - `SSHAuthorizeRequest{Sandbox, PublicKey, Fingerprint string; Certificate *SSHCertInfo}`.
  - `SSHCertInfo{KeyID, Serial, Principal string; ValidBefore time.Time}`.
  - `SSHActor{Kind, UserID, Email, APIKeyID string}`.
  - `SSHAuthorization{Allowed bool; Actor SSHActor; UserID, Email, SandboxID, MachineID, SandboxState, LoginUser, TeamID string}`.
  - The interface:
    ```go
    type Client interface {
        LookupRoute(ctx context.Context, label string) (Route, error)
        ExchangePortAuthCode(ctx context.Context, code, label string) (PortAuthGrant, error)
        AuthorizeSSH(ctx context.Context, req SSHAuthorizeRequest) (SSHAuthorization, error)
    }
    ```
  - `ErrRouteNotFound`, `ErrInvalidCode`, `ErrUnavailable` (network error, 5xx, timeout).
  - `NewHTTPClient(baseURL, token string, hc *http.Client) Client`. It uses these paths with `Authorization: Bearer`:
    - `GET /internal/v1/gateway/routes/{label}`
    - `POST /internal/v1/gateway/port-auth/exchange`
    - `POST /internal/v1/gateway/ssh/authorize`

    It never follows redirects. Response bodies are capped at 64 KiB.
- Produces `cpapitest.Fake`, which implements `Client`:
  - `NewFake() *Fake`
  - `SetRoute(r Route)`, `DeleteRoute(label)`, `SetDown(bool)`
  - `IssueCode(label string, g PortAuthGrant) string`: single use, 60 s TTL
  - `SetSSH(match func(SSHAuthorizeRequest) bool, a SSHAuthorization)`
  - `Calls(method string) int`

  `cpapitest.NewServer(f *Fake, token string) *httptest.Server` serves the same three paths.
- Produces in `routes`:
  - `Label{Raw, Slug string; Port uint16; Kind string}`.
  - `Grammar{ReservedPorts map[uint16]bool; ReservedSuffixes, ReservedSlugs []string}`.
  - `ParseHost(host, sbxDomain string, g Grammar) (Label, bool)`: lower-cases, drops `:443`, needs exactly one label, applies the §4.2 grammar, and keeps slugs to 3..40 chars.
  - `NewCache(api cpapi.Client, cfg CacheConfig, m *obs.Metrics) *Cache`, where `CacheConfig{TTL 30s, NegativeTTL 5s, StaleFor 10m, Timeout 3s, Now func() time.Time}`.
  - `(*Cache).Get(ctx, label Label) (cpapi.Route, error)`: errors `cpapi.ErrRouteNotFound` or `ErrLookupUnavailable`.
  - `(*Cache).InvalidateSlug(slug string)`: `"*"` flushes everything.
  - `(*Cache).Flush()`.
  - `Decide(r cpapi.Route) (ok bool, e sbxerr.Error)`: the table under Deviations, plus `blocked` → `403 route_blocked` with a message per `blockReason`, and a `ready` route with an empty `machineId` → `503 sandbox_unavailable`.

- [ ] Step 1: Write failing tests:
  - `TestParseHost` (table):
    - valid: `quiet-otter-lamp-5173.sbx.example.com`, `QUIET-otter-lamp-5173.SBX.example.com:443`, and the desktop kind;
    - invalid: the apex, nested labels, `a--b-80`, `ab-80` (too short), the leading zero `x-y-z-080`, port `0`, `65536`, `api-3000`, reserved port `22`, a slug ending in `-123` followed by a port, a non-sbx domain, `:8443`.
  - `TestCacheTTLAndSingleflight`: 50 concurrent Gets cause one API call. After 30 s (fake clock) it calls again. A 404 is cached for 5 s.
  - `TestCacheStaleIfError`: after expiry with the API down, the stale route is returned for up to 10 min, then `ErrLookupUnavailable`. A miss with the API down → `ErrLookupUnavailable` within 3 s. A stale blocked route stays blocked.
  - `TestInvalidateSlug`: entries for `foo-80` and `foo-3000` go, `foobar-80` stays, and `"*"` clears all.
  - `TestDecide`: every state row.
  - `TestHTTPClient` against `cpapitest.NewServer`:
    - a wrong token gives a 401 → `ErrUnavailable`;
    - 404 → `ErrRouteNotFound`;
    - a `302` from the server is not followed;
    - a 1 MiB body → error.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: control-plane contract, fake, route grammar and cache`.

### Task 5: Server instance skeleton and test harness

**Files:**
- Create:
  - `internal/server/server.go` (Instance), `health.go`
  - `internal/testenv/env.go`, `pki.go`, `machine.go`, `apps.go`
  - `internal/server/server_test.go`

**Interfaces:**
- Produces `server.Deps{Pool *pgxpool.Pool; API cpapi.Client; Logger *slog.Logger; AccessLog io.Writer; Now func() time.Time; Timing gateway.Timing}`. Tests shrink the timing.
- Produces `server.New(cfg config.Config, deps Deps) (*Instance, error)`. It builds:
  - `gateway.New`, with `ServiceTokens`, `MaxTCPStreamsPerMachine: 800`, and `Timing.TCPDeadline = cfg.SSHDrainDeadline`;
  - `OnSessionChange`, which invalidates the owner cache;
  - `OnInstanceChange`, a hook list;
  - `ListenChannels`: `sbx_routes` → `routes.Cache.InvalidateSlug`, or `Flush` on `""`; `sbx_ssh_revoke` → a hook, set in Task 13;
  - the route cache, the owner cache and the metrics registry.
- Produces these `Instance` methods:
  - `Run(ctx, ls Listeners) error`, where `Listeners{Internal, Metrics, TLS, Plain, SSH net.Listener}` and a nil listener is not served;
  - `Ready() bool`;
  - `Tunnel() *gateway.Gateway`;
  - `Drain(ctx) error` (Task 13 completes it);
  - `Metrics() *obs.Metrics`.
- The internal server is `gateway.NewInternalServer(g.InternalHandler())` with `IdleTimeout` 120 s.
- The metrics listener serves `/metrics`, `/healthz` (always 200) and `/readyz` (200 only when `Ready()`: certs loaded, not draining, tunnel ready).
- `sbx_gateway_dependency_up` is updated as follows:
  - `{dep="postgres"}`: a pool ping every 10 s;
  - `{dep="api"}`: the route cache reports the success or failure of the last lookup.
  - Neither affects `/readyz` (§12.3).
- Produces `testenv.New(t, opts Options) *Env`. `Env` has:
  - `Pool`, `Net *memnet.Network`, `API *cpapitest.Fake`, `PKI *PKI`;
  - `PKI`: CA, sbx wildcard cert, tunnel cert, and `Roots *x509.CertPool`;
  - `Keys`: cookie key, SSH host key, user CA, login CA.
- Produces these `Env` methods:
  - `StartInstance(mod func(*config.Config)) *Inst`. `Inst` has `{*server.Instance; Name, InternalURL, HTTPSAddr, PlainAddr, SSHAddr, MetricsURL string}`, listening on `127.0.0.1:0`. The instance is registered in memnet under its `InstanceID`, gated by `Ready`.
  - `StopInstance(i *Inst, graceful bool)`.
  - `NewMachine() *Machine`: it puts credentials with `registry.Store.PutCredentials`, starts an `agent.Client` over `Env.Net.Dialer()`, and waits until it is connected. `agent.Config.Dial` maps port P to the machine's app address. A port with no app dials a closed `127.0.0.1` port, which gives a real ECONNREFUSED. `Machine.Blackhole(port)` makes the dial block until ctx ends.
  - `Machine.ServeHTTP(port uint16, h http.Handler)`, `ServeH2C(port, h)`, `ServeTCP(port uint16, fn func(net.Conn))`, `Restart()` (new agent process, same credentials), `ID string`.
  - `Env.Route(m *Machine, port uint16, mod func(*cpapi.Route)) cpapi.Route`: the defaults are a random slug, `access public`, `ready`, `hostRewrite preserve` and `http1`. It registers the route in the fake and returns it.
  - `Env.NotifyRoutes(payload string)`, which runs `pg_notify`.
  - `Env.HTTPClient(i *Inst, h2 bool) *http.Client`: it trusts `PKI.Roots`, and every dial goes to `i.HTTPSAddr` whatever the host. No cookie jar by default; `Env.Jar()` provides one.
- `fastTiming()` mirrors `libs/tunnel/internal/e2e` (heartbeat 200 ms, stale 1 s, endpoint wait 100 ms, spread 100 ms).

- [ ] Step 1: Write failing tests:
  - `TestInstanceRunReady`: `/readyz` goes 503 → 200 after Run. `/healthz` is 200.
  - `TestInstanceInternalListener`: a peer CONNECT from instance B to A for a machine on A works, through `gateway.DialRemoteTCP`, an echo over `ServeTCP`, and B's `PeerToken`.
  - `TestRoutesNotifyInvalidates`: Get caches; `Env.NotifyRoutes(slug)` → the next Get calls the fake again within 1 s.
  - `TestRoutesFlushOnListenReconnect`: kill the LISTEN backend → the cache is flushed.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: server instance skeleton and test harness`.

### Task 6: Upstream: owner resolution, local and peer dial, app transports

**Files:**
- Create: `internal/upstream/dialer.go`, `transport.go`, `conn.go`, `dialer_test.go`, `transport_test.go`.
- Modify: `internal/server/server.go` (it builds the `Dialer`).

**Interfaces:**
- Consumes:
  - `registry.OwnerCache`;
  - `registry.Store.InstanceByURL`;
  - `gateway.DialRemoteTCP` and `NewPeerTransport`;
  - `transport.DialError.Reason`;
  - `gateway.ErrTooManyStreams`.
- Produces:
  - `upstream.Config{Self string; Local LocalTunnels; Owners *registry.OwnerCache; Store *registry.Store; PeerToken string; AgentWait, DialTimeout, StaleAfter time.Duration; Metrics *obs.Metrics}`, where `LocalTunnels interface{ Machine(id string) (transport.MachineConn, bool) }`.
  - `upstream.New(cfg Config) *Dialer`.
  - `(*Dialer).Dial(ctx, machineID string, port uint16, drain time.Duration) (*Conn, error)`.
  - `upstream.Conn{net.Conn; Via string /* local|peer */; OwnerInstance string}`.
  - `upstream.Error{Status int; Code string; Reason string; Err error}`. Its `Code` values are `app_not_listening`, `app_timeout`, `agent_unavailable`, `overloaded` and `upstream_error`. `Reason` is the metric label: `refused`, `timeout`, `agent_unavailable`, `moved` or `peer_error`.
- Produces `upstream.NewAppTransports(d *Dialer, cfg TransportConfig) *AppTransports`:
  - `TransportConfig{HTTPDrain time.Duration; ResponseHeaderTimeout, StreamIdle time.Duration; MaxIdlePerHost int /*8*/; IdleConnTimeout time.Duration /*30s*/; MaxResponseHeaderBytes int64 /*64 KiB*/}`;
  - `(*AppTransports).For(appProtocol string) http.RoundTripper`;
  - `upstream.SyntheticHost(machineID string, epoch uint64, port uint16) string`, which returns `m-<id>-e<epoch>-<port>.sbx.internal`;
  - `(*Dialer).Epoch(ctx, machineID) (uint64, bool, error)`, from the owner cache, for building the host.
- Algorithm of `Dial`. The whole dial is bounded by `DialTimeout`, apart from the agent wait.
  1. Local `Machine(id)` exists → `DialTCPWith(ctx, port, {DrainDeadline: drain})`, `Via=local`.
  2. Otherwise `Owners.Lookup`. If the owner is another live instance → `DialRemoteTCP(…, owner.InternalURL, PeerToken, …)`, `Via=peer`.
  3. On `*transport.MovedError`: if `InstanceByURL(url)` finds a live instance, retry once there. Otherwise `Owners.Invalidate(id)` and retry once with a fresh lookup.
  4. No owner, or the owner is self without a local session → `Owners.Wait(ctx, id, AgentWait)`, then step 1. If it still fails → `agent_unavailable`.
  5. Error mapping:
     - `DialError{502, refused}` → `502 app_not_listening`;
     - `DialError{502, timeout}` and ctx timeouts → `504 app_timeout`;
     - other DialErrors (400/403/502) → `502 upstream_error`;
     - `DialError{503}`, `ErrSessionClosed` and tunnel errors → `503 agent_unavailable`;
     - `ErrTooManyStreams` → `503 overloaded`.
- `Conn` closes itself after `StreamIdle` with no bytes either way, using a timer reset on Read/Write. `SetDeadline` and its siblings return nil and do nothing, so `http.Transport` never sees `ErrUnsupported`.

- [ ] Step 1: Write failing tests (testenv, real Postgres):
  - `TestDialLocal`, `TestDialPeer` (machine on A, dial from B, `Via=peer`).
  - `TestDialWaitsForAgent`: dial first, start the agent 1 s later → success.
  - `TestDialAgentTimeout`: no agent → `agent_unavailable` after `AgentWait` (shrunk to 500 ms).
  - `TestDialRefusedTimeout`: an unbound port → `app_not_listening`; a blackholed port → `app_timeout`.
  - `TestDialMovedValidated`: the owner answers 421 with a bogus `Sbx-Instance-Url`, using a fake peer handler. The bogus URL never receives a request (a counting server), and the dial goes to the registry owner.
  - `TestDialOverloaded`: `MaxTCPStreamsPerMachine` is set to 2 on the owner; the third dial via a peer → `overloaded`.
  - `TestTransportPerEpoch`: after `Machine.Restart()`, the next request's `httptrace.GotConn` reports a new conn (no reuse across epochs).
  - `TestStreamIdleCloses`: with `StreamIdle` 200 ms, an idle WebSocket-like conn closes.
  - `TestDisableCompression`: the app sees the client's `Accept-Encoding` unchanged, or none when the client sent none.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: upstream dial (local, peer, moved, wait) and app transports`.

### Task 7: Rate limits

**Files:**
- Create: `internal/ratelimit/ratelimit.go`, `ratelimit_test.go`.
- Modify: `internal/config/config.go` (it uses `ratelimit.Config`).

**Interfaces:**
- Produces:
  - `ratelimit.Config{IPRate float64 /*300*/; IPBurst int /*2000*/; LabelRate float64 /*1000*/; LabelBurst int /*3000*/; AuthFailPerMin int /*20*/; AuthBlock time.Duration /*5m*/; ConnsPerIP int /*512*/; SSHConnPerMin int /*10*/; SSHConnBurst int /*20*/; SSHAuthFailPerMin int /*10*/; SSHSessionsPerUser int /*20*/; Exempt []netip.Prefix; Now func() time.Time}`.
  - `ratelimit.New(cfg) *Limits` and `(*Limits).Run(ctx)`, which garbage-collects buckets idle for 10 min.
  - `Key(ip netip.Addr) netip.Prefix`: IPv4 /32, IPv6 /64, with v4-mapped addresses unmapped.
  - `AllowRequest(ip netip.Addr, label string) (ok bool, limit string, retryAfter time.Duration)`. `limit` is `ip` or `label`; exempt addresses skip the IP bucket.
  - `AuthFailure(ip)`; `AuthBlocked(ip) (bool, time.Duration)`.
  - `AcquireConn(ip) (release func(), ok bool)`.
  - `AllowSSHConn(ip) bool`; `SSHAuthFailure(ip)`; `SSHAuthBlocked(ip) bool`.
  - `AcquireSSHSession(user string) (release func(), ok bool)`.
  - Every refusal increments `sbx_gateway_ratelimited_total{limit}`. The limit names are `ip`, `label`, `auth_fail`, `conns`, `ssh_conn`, `ssh_auth_fail` and `ssh_sessions`.

- [ ] Step 1: Write failing tests, all on a fake clock:
  - `TestKeyV6Slash64`: two addresses in the same /64 share a bucket.
  - `TestAllowRequestBurst`: 2000 pass, the 2001st fails, and a refill occurs.
  - `TestExemptSkipsIP`: an exempt address still hits the label limit.
  - `TestAuthBlock`: 20 failures in a minute → blocked for 5 min, then free.
  - `TestConnsPerIP`: 512 acquires pass, the 513th fails, and a release frees one.
  - `TestSSHLimits`: the per-minute rate and burst; 20 sessions per user.
  - `TestGC`: buckets go after 10 min idle.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: rate limits`.

### Task 8: Port auth: cookie codec, `token`, `sso`, `/__sbx/*`

**Files:**
- Create: `internal/portauth/cookie.go`, `auth.go`, `reserved.go`, plus tests.

**Interfaces:**
- Produces:
  - `portauth.NewCodec(keys []config.CookieKey, now func() time.Time) *Codec`.
  - `Session{Label, Mode string /*t|s|d*/; Epoch int64; UserID, Email string; Expiry time.Time}`.
  - `(*Codec).SealSession(Session) string` and `OpenSession(string) (Session, error)`. The format is exactly §8.2: `v1.<kid>.<b64url(payload)>.<b64url(HMAC)>`. The JSON keys are `l, m, e, u, em, x`.
  - `State{State, RD, Label string; Expiry time.Time}`.
  - `SealState`/`OpenState`, which use the `v1s` tag.
- Produces `portauth.Config{Codec *Codec; API cpapi.Client; AuthURL, SbxDomain string; CrossSite bool; TokenTTL time.Duration /*7d*/; SSOTTL /*12h*/; StateTTL /*10m*/; Limits *ratelimit.Limits; Metrics *obs.Metrics}` and `portauth.New(cfg) *Auth`.
- Produces `(*Auth).Check(w http.ResponseWriter, r *http.Request, l routes.Label, rt cpapi.Route, ip netip.Addr, requestID string) Result`. It runs only for `token`/`sso`. When it denies, it writes the response itself (a 302 or an `sbxerr`).
  - `Result{Proceed bool; Email, UserID, AuthResult string /*ok|missing|invalid|redirect*/; SetCookie *http.Cookie}`.
  - Proxied requests get `SetCookie` added to the app response by the proxy.
- Produces `(*Auth).ServeReserved(w, r, l routes.Label, rt *cpapi.Route, ip netip.Addr, requestID string)` for `/__sbx/*`:
  - `/__sbx/auth/callback` checks the state cookie (`subtle.ConstantTimeCompare`) and that the label matches. It exchanges the code, sets the session cookie, clears the state cookie and redirects `302` to `rd`.
  - `/__sbx/auth/logout` clears the cookie and redirects `302 /`.
  - Anything else → `404 route_not_found`.
- Produces `portauth.IsPreflight(r) bool`: `OPTIONS` with `Origin` and `Access-Control-Request-Method`.
- Produces `portauth.StripRequest(h http.Header, url *url.URL, prefixes []string)`. It removes:
  - the cookies `__Host-sbx_auth` and `__Host-sbx_state` and the prefixed cookies, keeping other cookies byte-for-byte;
  - the query `_token`, keeping the order of the other raw params;
  - `Sbx-Port-Token`.
- Cookie attributes:
  - `Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age`, with no `Domain`;
  - with `CrossSite`: `SameSite=None; Partitioned`.
- Token check:
  - the hash is lowercase hex `sha256(token)`, compared in constant time with `tokenHash`;
  - order: `_token` query → `Sbx-Port-Token` → cookie;
  - a browser navigation (`GET`/`HEAD`, `Accept` has `text/html`, no `Upgrade`) with a valid `_token` → `302` to the same URL without `_token`, with `Referrer-Policy: no-referrer`;
  - an invalid token → `401 token_invalid`, plus `Limits.AuthFailure`. While `AuthBlocked` → `429 rate_limited`.
- SSO redirect: `302` to `AuthURL?label=<label>&state=<state>`, where state is 16 random bytes in base64url. A state cookie TTL is 10 min, and `rd` is only a path starting with `/` but not `//` or `/\`; otherwise `/`. Non-navigations get `401 auth_required`.

- [ ] Step 1: Write failing tests:
  - `TestCodecRoundTrip`, `TestCodecRotation`: signed by kid A; the verify set `[B, A]` accepts it, and `[B]` rejects it.
  - `TestCodecTamper`: one flipped byte in the payload or the MAC, a wrong kid, `v2`, or an auth cookie offered as a state cookie → error.
  - `TestTokenQueryNavigationRedirect`: `?a=1&_token=T&b=2` → `302 ?a=1&b=2`, plus `Set-Cookie __Host-sbx_auth` with all the attributes and `Referrer-Policy`.
  - `TestTokenQueryFetchProceeds`: proceeds with `SetCookie`.
  - `TestTokenHeader`: proceeds, no cookie.
  - `TestTokenInvalid`: `401` and an auth-failure count; the 21st attempt → `429`.
  - `TestCookieScope`: a cookie for label A on label B → not valid. A mode or epoch mismatch, or expiry → not valid.
  - `TestSSORedirect`: a navigation → `302` to AuthURL with the label and state, and the state cookie set; an XHR → `401 auth_required`.
  - `TestCallback`:
    - a good state and code → `302 rd` and a session cookie (mode `s`, email);
    - a swapped state → `401`;
    - a reused code → `401` (the fake makes codes single-use);
    - `rd=//evil.com` → redirects to `/`;
    - a code for another label → `401`.
  - `TestLogout`.
  - `TestStripRequest`: cookies and query keep their order.
  - `TestPreflight`.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: port auth (cookie, token, sso, /__sbx)`.

### Task 9: HTTP proxy pipeline

**Files:**
- Create: `internal/httpproxy/proxy.go`, `headers.go`, `streams.go`, `clientip.go`, plus tests.
- Modify: `internal/server/server.go` (it serves the handler on the plain listener; TLS comes in Task 10).

**Interfaces:**
- Consumes: `routes.ParseHost`, `Cache.Get`, `Decide`; `portauth.*`; `ratelimit.Limits`; `upstream.AppTransports`, `Dialer.Epoch`; `sbxerr.Write`; `obs.*`.
- Produces:
  - `httpproxy.Config{SbxDomain string; Grammar routes.Grammar; Routes *routes.Cache; Auth *portauth.Auth; Limits *ratelimit.Limits; Upstream *upstream.Dialer; Transports *upstream.AppTransports; TrustedProxies []netip.Prefix; StripCookiePrefixes []string; Metrics *obs.Metrics; AccessLog *obs.AccessLog; Streams *StreamTracker; Desktop http.Handler /* nil: desktop labels are 404 */}`.
  - `httpproxy.New(cfg) http.Handler`.
  - `httpproxy.NewStreamTracker() *StreamTracker`, with `Track(c io.Closer) (done func())` and `CloseAll()`, which the drain uses. `Count()` feeds `sbx_gateway_drain_open_streams{kind="http"}`.
  - `ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr`. It takes `RemoteAddr`; if that is trusted, it takes the right-most untrusted XFF entry.
- Pipeline:
  1. `Limits.AllowRequest`, otherwise `429`.
  2. `ParseHost`, otherwise `404`.
  3. The `/__sbx/` prefix → `Auth.ServeReserved`.
  4. `Cache.Get` → `404` or `503 route_lookup_unavailable`. Kind desktop with a nil `Desktop` → `404`.
  5. `Decide`.
  6. Auth: `public` passes; a preflight passes; otherwise `Auth.Check`.
  7. `ReverseProxy` with `Rewrite`:
     - out URL `http://<SyntheticHost>/…`;
     - `Host` per `hostRewrite` (`localhost:<port>`);
     - `X-Forwarded-For` set to the single client IP (plain mode with trusted proxies: the trusted chain plus the client), `-Proto https`, `-Host`, `-Port 443`, `Forwarded` (RFC 7239);
     - `X-Request-Id` (the client's if 1–128 printable ASCII, else a new ULID);
     - `X-Sbx-User-Email` for sso;
     - the strip list of §7.4: all `Sbx-*`/`X-Sbx-*` from the client, `X-Auth-Request-*`, the `X-Forwarded-Email/User/Groups/Preferred-Username/Access-Token`, and `X-Real-Ip`.
  8. `ModifyResponse`:
     - strip `Set-Cookie` named `__Host-sbx_auth`/`__Host-sbx_state` (case-insensitive), `Sbx-*` and `Alt-Svc`;
     - add `X-Robots-Tag` and the auth `SetCookie`;
     - wrap the body so that at EOF trailers over 64 KiB or 100 fields, and `Sbx-*` trailers, are deleted.
  9. `ErrorHandler`: maps `*upstream.Error` and the transport errors to `sbxerr`. A response header too large → `502 upstream_error`; a response header timeout → `504 app_timeout`.
  10. `FlushInterval: -1`.
  11. A `101` upgrade and long streams register with `StreamTracker`, through a hijack-aware wrapper for the response writer.
  12. `appProtocol: h2c` with an `Upgrade` → `502 upstream_error`.
  13. An access log line at the end, or when a long stream closes. Metrics with `via` from the `GotConn` of the `upstream.Conn`.

- [ ] Step 1: Write failing tests (testenv with a plain listener and an echo app that dumps the request headers, cookies and query):
  - `TestProxyPublicEcho`: headers per §7.4. A client XFF is replaced. `X-Forwarded-Host` is the original. `X-Robots-Tag` is on the response.
  - `TestStripAll`: the client sends every stripped header and cookie, plus `_token`; the app sees none of them, and its other cookies stay byte-identical.
  - `TestResponseStrip`: the app sets `Set-Cookie: __Host-sbx_auth=x`, `__host-SBX_auth=y`, `Sbx-Error: fake`, `Alt-Svc` and an `Sbx-X` trailer → none of them reach the client.
  - `TestHostRewriteLocalhost`.
  - `TestRequestID`: kept or replaced; the same id appears in the access log and on the error page.
  - `TestSSE`: an event arrives in under 100 ms.
  - `TestWebSocket`: an echo through a hijacked upgrade, counted in the tracker.
  - `TestH2CApp`: gRPC-like bidi streaming with trailers over `ServeH2C`, from an HTTP/2 client.
  - `TestLargeUploadStreams`: a 512 MiB PUT; the gateway heap in use (from `runtime.ReadMemStats` sampling) grows less than 64 MiB, and the sha256 matches. The 5 GB variant runs in Task 14 under `-run Big` with `SBX_E2E_BIG=1`.
  - `TestErrorTable`: every row of §7.6 that is reachable in-process gives its status, `Sbx-Error` and `Retry-After`.
  - `TestPreflightBypass`.
  - `TestNoEnableConnectProtocol`: the h2 SETTINGS frame read with `golang.org/x/net/http2.Framer` from a raw TLS conn (Task 10) or an h2c conn has no `ENABLE_CONNECT_PROTOCOL`.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: HTTP proxy pipeline`.

### Task 10: Edge: TLS with SNI, PROXY v2, cert reload, tunnel listener, plain mode

**Files:**
- Create: `internal/edge/dispatch.go`, `certs.go`, `proxyproto.go`, `tunnel.go`, `plain.go`, `servers.go`, plus tests.
- Modify: `internal/server/server.go`.

**Interfaces:**
- Produces:
  - `edge.NewCertSource(name, certFile, keyFile string, m *obs.Metrics) (*CertSource, error)`, with `Run(ctx)` (polls the mtime every 30 s and watches the directory with fsnotify), `Get() *tls.Certificate` and `Loaded() bool`. It sets `sbx_gateway_cert_expiry_timestamp_seconds{cert}`. A broken reload keeps the old cert and logs.
  - `edge.WrapProxyProtocol(ln net.Listener, trusted []netip.Prefix) net.Listener`. Trusted sources use the header if present. Others: a header → reject (close), no header → accept.
  - `edge.Dispatcher`: `NewDispatcher(ln net.Listener, cfg DispatchConfig) *Dispatcher`, `DispatchConfig{SbxDomain, TunnelHost string; Sbx, Tunnel *CertSource; HandshakeTimeout time.Duration; ConnLimit func(ip netip.Addr) (func(), bool); Metrics *obs.Metrics}`, and `Sbx() net.Listener`, `Tunnel() net.Listener`, `Serve(ctx) error`, `Close() error`.
    - SNI `TunnelHost` → ALPN `http/1.1` only.
    - SNI under `SbxDomain` → `h2, http/1.1`.
    - Anything else → alert `unrecognized_name`.
    - The handshake runs off the accept goroutine with its timeout. `sbx_gateway_tls_handshake_errors_total{sni_kind}` counts failures.
    - The per-IP conn limit applies only to sbx conns.
  - `edge.NewSbxServer(h http.Handler, t config.Timeouts) *http.Server`: HTTP/1 and HTTP/2, `ReadHeaderTimeout`, `IdleTimeout` 120 s, `MaxHeaderBytes` 64 KiB. HTTP/2 SETTINGS have no extended CONNECT; the process never sets `GODEBUG=http2xconnect`.
  - `edge.NewTunnelServer(h http.Handler) *http.Server`: HTTP/1 only, `ReadHeaderTimeout` 10 s, `MaxHeaderBytes` 16 KiB.
  - `edge.TunnelHandler(adm transport.Admitter, lim *rate.Limiter, m *obs.Metrics) http.Handler`: `wstransport.NewHandler` behind the admission bucket (`503` with `Retry-After: 1` over the limit). Only `GET /v1/connect` is served; anything else is `404`.
  - `edge.PlainHandler(sbx, tunnel http.Handler, tunnelHost string) http.Handler`: dispatch by `Host`.
- `server.Instance` gets:
  - TLS: Dispatcher → two servers;
  - plain: `PlainHandler` with an h2c-capable server;
  - `Ready` includes `CertSource.Loaded`.

- [ ] Step 1: Write failing tests:
  - `TestSNIDispatch`:
    - the tunnel SNI with an agent dial through `wstransport` → admitted;
    - the sbx SNI → proxy;
    - an unknown or empty SNI → a handshake error with the alert `unrecognized_name`.
  - `TestCoalescedHost`: Review Focus 1.
  - `TestALPN`: tunnel → `http/1.1`; sbx → `h2`.
  - `TestHandshakeTimeout`: a raw TCP conn that sends nothing closes after the timeout (shrunk to 200 ms).
  - `TestProxyProtoV2`:
    - a trusted source with a v2 header → the access log `clientIp` is the header's address;
    - an untrusted source with a header → the conn closes;
    - an untrusted source without a header → served.
  - `TestCertReload`: rewrite the files → the new cert is served within 1 s (fsnotify) and the expiry metric is updated.
  - `TestTunnelAdmissionLimit`: a bucket of rate 1, burst 2; three quick upgrades → the third gets `503` with `Retry-After: 1`.
  - `TestTunnelReadHeaderTimeout`.
  - `TestPlainMode`: `Host: tunnel` → upgrade handler; `*.sbx` → proxy; XFF from a trusted CIDR is honoured, from others ignored.
  - `TestNoEnableConnectProtocol` over TLS.
  - `TestReadyNeedsCerts`.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: TLS edge, PROXY v2, cert reload, tunnel listener hardening, plain mode`.

### Task 11: SSH gateway: authentication, backend connection, stopped sandbox

**Files:**
- Create:
  - `internal/sshgw/server.go`, `auth.go`, `backend.go`, `session.go`, plus tests
  - `internal/testenv/sshdtest/sshd.go`, the sshd double
- Modify: `internal/server/server.go`, `internal/testenv/machine.go` (`Machine.ServeSSHD`).

**Interfaces:**
- Produces:
  - `sshgw.Config{HostSigners []ssh.Signer; LoginCAKeys []ssh.PublicKey; UserCA ssh.Signer; API cpapi.Client; Dialer *upstream.Dialer; Limits *ratelimit.Limits; Metrics *obs.Metrics; Log *obs.AccessLog; Logger *slog.Logger; DrainDeadline time.Duration /*15m*/; KeepaliveInterval time.Duration /*30s*/; KeepaliveMax int /*3*/; AuthTimeout time.Duration /*20s*/; MaxAuthTries int /*6*/; ClockSkew time.Duration /*60s*/; BackendCertTTL time.Duration /*5m*/; Now func() time.Time; Self string; Instances InstanceSource}`.
  - `InstanceSource interface{ Instance(ctx, id string) (registry.Instance, error) }`.
  - `sshgw.New(cfg) (*Server, error)`, with `Serve(ln net.Listener) error`, `Close() error` and `Sessions() int`.
- Authentication:
  - `NoClientAuth` false, `MaxAuthTries` 6. Only `PublicKeyCallback` is set, so there is no password or keyboard-interactive.
  - A username with `+` is refused.
  - For an `*ssh.Certificate`:
    - `CertType == UserCert`;
    - `IsUserAuthority` against `LoginCAKeys` (marshalled bytes compared);
    - exactly one principal, and `CertChecker.CheckCert(cert.ValidPrincipals[0], cert)` with `Clock = Now + ClockSkew` tolerance on both bounds;
    - `KeyId` matching `^sbx:(user|key):[A-Za-z0-9_]+$`.
    - Only then `AuthorizeSSH` with `Certificate{KeyID, Serial (decimal), Principal, ValidBefore}`.
  - For a plain key: `AuthorizeSSH{Sandbox: user, PublicKey: authorized_keys line, Fingerprint: ssh.FingerprintSHA256}`.
  - `allowed:false`, an error or an unavailable API → reject.
  - The result is returned in `ssh.Permissions.Extensions["sbx-auth"]` as JSON. After the handshake the identity is read only from `ServerConn.Permissions`.
- Connection:
  - `AllowSSHConn` before the handshake;
  - `SSHAuthFailure` when the handshake fails after at least one auth attempt;
  - `SSHAuthBlocked` → close before the handshake.
- Backend:
  - the state is not `ready`/`running`, or `machineId` is empty → stopped mode: the first `session` channel is accepted, stderr gets `sbx: sandbox <user> is stopped; run: sbx resume <user>\r\n` (or `is starting` / `is unavailable`), then `exit-status` 255 and the connection closes. `Dialer` errors after the agent wait behave the same way, with `agent unavailable`;
  - otherwise `Dialer.Dial(ctx, machineId, 22, DrainDeadline)` and an `ssh.NewClientConn` with `User: loginUser` and `PublicKeys(certSigner)`. The cert:
    - an ephemeral ed25519 key;
    - `ValidPrincipals [loginUser]`, `ValidAfter now-60s`, `ValidBefore now+5m`;
    - `KeyId` `sbx:user:<userId>:<sessionId>` or `sbx:key:<apiKeyId>:<sessionId>`;
    - the extensions `permit-pty`, `permit-port-forwarding`, `permit-agent-forwarding`, `permit-X11-forwarding`, `permit-user-rc`;
    - signed by `UserCA`.
  - `HostKeyCallback` accepts and logs `ssh.FingerprintSHA256`.
- Produces in `sshdtest`: `sshdtest.New(t, userCA ssh.PublicKey, loginUser string) *Server`. It is the VM sshd double, served on an app port:
  - it checks certs against `userCA` with principal `loginUser`;
  - it records each `KeyId` (`KeyIDs() []string`);
  - `session`: `exec` echoes the command and the env to stdout, writes `err` to stderr, and sends `exit-status`; `shell` with a pty echoes the input; `subsystem` echoes back;
  - `direct-tcpip` dials the target;
  - `tcpip-forward` listens and opens `forwarded-tcpip`;
  - `auth-agent-req@openssh.com` opens an `auth-agent@openssh.com` channel back;
  - it sends `hostkeys-00@openssh.com` right after auth.

- [ ] Step 1: Write failing tests (testenv plus sshdtest on port 22 of a machine):
  - `TestSSHUserKey`: an allowed key → exec `echo hi` returns `hi`, exit 0. The `KeyId` recorded by the double is `sbx:user:<id>:<session>`.
  - `TestSSHCertLogin`: a cert from the login CA with principal `sb_x` and `KeyId sbx:key:key_1` → allowed, and the fake saw the certificate fields.
  - `TestSSHCertRejects`, one subtest each:
    - a foreign CA;
    - expired, beyond the 60 s skew;
    - two principals;
    - a principal for another sandbox (the fake answers `allowed:false`);
    - a bad `KeyId`;
    - a host cert type.
  - `TestSSHUnknownKey`: refused, and the auth-failure metric counts it.
  - `TestSSHPasswordRefused`.
  - `TestSSHPlusUser`.
  - `TestSSHStopped`: the message on stderr, exit 255.
  - `TestSSHIdentityFromVerifiedKey` (the CVE-2024-45337 shape): the client offers allowed key A without signing (query only), then authenticates with key B, which the API allows for a different user. The session identity is B's user, and the backend `KeyId` names B.
  - `TestSSHConnRateLimit`.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: SSH authentication and backend connection`.

### Task 12: SSH forwarding: channels, requests, global requests, keepalive, session limit

**Files:**
- Create: `internal/sshgw/forward.go`, `global.go`, `keepalive.go`, plus tests.

**Interfaces:**
- Consumes: the Task 11 `session` (it holds both `ssh.Conn` ends).
- Forwarding:
  - Client channels `session`, `direct-tcpip` and `direct-streamlocal@openssh.com` are opened on the backend with the same type and extra data. A backend reject is passed on with its reason and message; other types → `UnknownChannelType`.
  - Backend channels `forwarded-tcpip`, `forwarded-streamlocal@openssh.com`, `auth-agent@openssh.com` and `x11` are opened on the client.
  - Data and stderr (`Stderr()`) are copied both ways. EOF → `CloseWrite`. A channel closes once both copies finish and the peer closed.
  - Channel requests are forwarded both ways with `want-reply`, and the reply is passed back. That includes unknown names.
  - A `pty-req` marks the channel interactive (used for drain warnings).
- Global requests, per the §9.4 table:
  - client → backend: `tcpip-forward`, `cancel-tcpip-forward`, `streamlocal-forward@openssh.com`, `cancel-streamlocal-forward@openssh.com`, `no-more-sessions@openssh.com`, with the reply and payload passed back;
  - `keepalive@openssh.com` from either side → answered locally `false`;
  - `hostkeys-prove-00@openssh.com` → `false`;
  - `hostkeys-00@openssh.com` from the backend → dropped;
  - anything else → `false`.
- Keepalive: `keepalive@openssh.com` to both ends every `KeepaliveInterval`. After `KeepaliveMax` consecutive failures or timeouts, close.
- `AcquireSSHSession(actor)` per connection. Over the limit, every `session` channel is rejected with `ResourceShortage`, "sbx: too many SSH sessions for this user".
- Metrics:
  - `sbx_gateway_ssh_channels_total{type}`;
  - `sbx_gateway_ssh_sessions_total{result}`;
  - `sbx_gateway_ssh_connections_active`.
- SSH log line at close (§12.2).

- [ ] Step 1: Write failing tests (x/crypto client through the gateway to sshdtest):
  - `TestForwardExecStdoutStderrExit`: the stdout and stderr bytes are exact, exit-status 3, and `exit-signal` is passed on.
  - `TestForwardPTYShell`: a `pty-req`, then a shell echo, a `window-change` and the `env` request.
  - `TestForwardSubsystem`.
  - `TestDirectTCPIP` (`-L`): reaches an app in the "VM".
  - `TestRemoteForward` (`-R`): a `tcpip-forward` reply carries the bound port, and a connection to it in the "VM" arrives as `forwarded-tcpip` at the client.
  - `TestAgentForward`: `auth-agent-req`, then the backend opens `auth-agent@openssh.com` and the client handles it.
  - `TestHostkeysDropped`: the client receives no `hostkeys-00@openssh.com`, and `hostkeys-prove-00` → false.
  - `TestUnknownGlobalRefused`.
  - `TestKeepaliveDeadBackend`: the backend stalls; with an interval of 100 ms the client connection closes after 3 misses.
  - `TestSessionLimit`: 2 sessions, then the third session channel is rejected with the message.
  - `TestBackendCloseWriteEndsStream`: the backend half-closes; the session still delivers exit-status and closes cleanly, with no hang.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: SSH channel and request forwarding, keepalive, session limit`.

### Task 13: Revocation, SSH drain deadlines, instance drain orchestration

**Files:**
- Create: `internal/sshgw/revoke.go`, `drain.go`, plus tests; `internal/server/drain.go`, `drain_test.go`.
- Modify: `internal/server/server.go` (it wires the `sbx_ssh_revoke` channel and `OnInstanceChange`/`OnSessionChange` into sshgw).

**Interfaces:**
- Produces `(*sshgw.Server).Revoke(payload string)`. The payload is `user:<id>`, `member:<teamId>:<userId>`, `key:<apiKeyId>` or `team:<teamId>`.
  - Matching sessions get `sbx: access revoked\r\n` on every session channel's stderr, and the connection closes.
  - An unknown form is logged and ignored.
  - It is non-blocking: the work is queued.
- Produces `(*sshgw.Server).Recheck(ctx)`, for a LISTEN reconnect: it re-runs `AuthorizeSSH` with each session's original request and closes the denied ones.
- Produces `(*sshgw.Server).InstanceChanged(ctx, id string)` and `MachineChanged(ctx, machineID string)`.
  - The deadline of a session is `min(own drain start, owner instance drain_started_at) + DrainDeadline`.
  - `""` re-reads every distinct owner.
  - `MachineChanged`: if the registry owner differs from the session's owner instance, that old owner's `drain_started_at` is re-read.
- Produces `(*sshgw.Server).Drain(start time.Time)`: stops accepting and sets its own deadline.
- Warnings:
  - When a deadline is first known and more than 0 is left: `sbx: gateway restarting, this SSH session will close in N min; reconnect to continue\r\n`, with N = ceil(remaining/1min), on the stderr of interactive (pty) session channels.
  - Again at `deadline − 1 min`, if more than 1 min was left at the first warning.
  - At the deadline the connection closes.
- `sbx_gateway_drain_open_streams{kind="ssh"}`.
- Produces `(*server.Instance).Drain(ctx) error`. Its order, with t0 = now:
  1. `ready=false`.
  2. Start `Tunnel().Drain(ctx)` in a goroutine. That drain sets `drain_started_at`, sends NOTIFY, waits `EndpointWait` and sends `Control/Drain` with 15 min.
  3. `sshgw.Drain(t0)`.
  4. After `EndpointWait`: close the edge listeners (dispatcher, plain, SSH).
  5. `Shutdown` the sbx and tunnel servers with a ctx deadline of `t0 + HTTPDrainDeadline`, then `Close`.
  6. `StreamTracker.CloseAll()` at `t0 + HTTPDrainDeadline`.
  7. Wait for the SSH sessions to end, or their deadlines to pass.
  8. After `Tunnel().Drain` returns: `internalServer.Shutdown(ctx)`.
  9. Return.

  Total bound: `EndpointWait + DrainSpread + SSHDrainDeadline + DrainMargin`, which is at most 960 s with the defaults. A unit test asserts this arithmetic on the config defaults.

- [ ] Step 1: Write failing tests:
  - `TestRevokeForms` (unit, fake sessions):
    - each payload form closes exactly the matching sessions;
    - `member:T:U` does not close U's sessions in another team;
    - `key:K` does not touch user sessions.
  - `TestRevokeE2E` (testenv): `pg_notify('sbx_ssh_revoke','user:usr_1')` → the client gets `sbx: access revoked` and EOF within 2 s.
  - `TestRecheckOnReconnect`: the fake flips to deny, the LISTEN backend is killed → the session closes.
  - `TestDrainWarnings` (fake clock): first notice at 15 min → message "15 min", then at T−1 min "1 min", then close at T. A notice with 40 s left → one message.
  - `TestOwnerDrainDeadline`: the owner instance gets `drain_started_at` = now−10 min → the deadline is now+5 min, a message is sent, and the conn closes at it.
  - `TestInstanceDrainOrder` (testenv, shrunk: endpoint 100 ms, HTTP drain 1 s, SSH drain 2 s):
    - `/readyz` goes 503 at once;
    - a new TLS conn after 100 ms is refused;
    - an in-flight 500 ms request completes;
    - a WebSocket is closed no earlier than 1 s after t0;
    - SSH gets its warnings and closes at 2 s;
    - `Drain` returns before `2 s + margins`;
    - the internal server is shut down after the tunnel drain.
  - `TestGraceArithmetic`.
- [ ] Step 2: Run them: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them: PASS. Run race and lint.
- [ ] Step 5: Commit `gateway: SSH revoke, drain deadlines and instance drain orchestration`.

### Task 14: Multi-instance e2e: HTTP proxy, routing, access, drain

**Files:**
- Create: `internal/e2e/main_test.go` (`pgtest.Main`), `http_test.go`, `routing_test.go`, `access_test.go`, `drain_test.go`.

Three instances A, B, C. Machines are connected to C. Clients enter at A or B. Shrunk timings.

- [ ] Step 1: Write the tests:
  - `TestPeerProxy`: the response through A for a machine on C is correct. The access log has `via=peer` and `ownerInstance=C`. 50 sequential requests use one peer HTTP/2 conn: the server-side count of new conns on C's internal listener is 1.
  - `Test1000WebSocketsViaPeer`: all open, so the internal listener is not capped at 250.
  - `TestOverloaded801`: `MaxTCPStreamsPerMachine` at the default 800. 800 WebSockets are held. The 801st request → `503 overloaded`, and an RPC call through `InternalHandler` (`Process` double from `tunneltest/process`) still works.
  - `TestRenameWithin1s`: the old label → `404` within 1 s of `NotifyRoutes(old)`; the new label works.
  - `TestBlockWithin1s`: `blocked` with `public_disabled` → `403 route_blocked` within 1 s, using `NotifyRoutes("*")`.
  - `TestAPIDownStale`: cached routes keep working with `Fake.SetDown(true)`; a new label → `503 route_lookup_unavailable`.
  - `TestTokenFlowE2E`: a browser jar opens `?_token=` → 302 → cookie → page; WebSocket with `?_token=` works; rotation (`authEpoch+1` and notify) → the old cookie gets `401`.
  - `TestSSOFlowE2E`: the fake authorize endpoint mimics `api` with a 302 to the callback with a code. The full cycle ends with the app seeing `X-Sbx-User-Email`. A swapped state, a reused code and `rd=//evil.com` are each covered.
  - `TestMachineMoveMidTraffic`: 20 parallel request loops while the agent is forced to reconnect to B. There are no `5xx` other than `503 agent_unavailable` with `Retry-After`, and they last at most `AgentWait`.
  - `TestRollingDrainHTTP`: 100 parallel 3 s requests while A drains (HTTP drain 5 s). None is cut. The WebSockets close no earlier than 5 s after t0.
  - `TestOwnerDrainKeepsHTTP`: C drains; the machine moves to B. In-flight requests through A finish; new ones go to B.
  - `TestBigTransfer` (`SBX_E2E_BIG=1` only): a 5 GiB PUT and GET through a peer; heap growth < 64 MiB; sha256 equal.
- [ ] Step 2: Run them. Fix whatever they reveal in the owning package, with a regression test there.
- [ ] Step 3: Run `go test -race ./...`: PASS.
- [ ] Step 4: Commit `gateway: multi-instance e2e for proxy, routing, access, drain`.

### Task 15: Security suite at the public proxy layer

**Files:**
- Create: `internal/e2e/security_test.go`, `internal/e2e/hostile_test.go`; `internal/testenv/rawagent.go`, a hostile agent with a raw HTTP/2 server on the memnet link.

**Interfaces:**
- Produces `testenv.Env.NewRawAgent(h http.Handler) *Machine`. It is admitted with valid credentials over memnet and serves `h` directly on the tunnel. CONNECT answers, statuses and headers are fully attacker-controlled.

- [ ] Step 1: Write the tests. Each case states the expected safe behaviour.
  - **Hostile app.** These mirror the S2 hostile-agent attacks (`libs/tunnel/internal/cmd/tunnelharness/hostile.go`) at the public layer:
    - a header block over 64 KiB → `502 upstream_error`;
    - 10,000 small headers → `502`;
    - declared trailers ×1000, trailers over 64 KiB, `Sbx-*` trailers → dropped. Review Focus 2: the same browser h2 conn then serves another label;
    - `Sbx-Error`, `Set-Cookie` with a gateway cookie name in any case, `Alt-Svc`, `Strict-Transport-Security` → only the first three are stripped; HSTS is the app's own business, which the test documents;
    - a `302 Location: http://169.254.169.254/` is passed to the client unchanged and never followed;
    - `Content-Encoding: gzip` with a gzip body → the client gets identical bytes; `br` with garbage → passed through;
    - a `101` without the client asking for an upgrade → `502`;
    - an HTTP/0.9 or garbage response → `502 upstream_error`;
    - `Transfer-Encoding: chunked` combined with `Content-Length` → `502`, no desync on the client conn;
    - the response tries to set `X-Sbx-User-Email` → stripped.
  - **Hostile agent** (raw agent):
    - a CONNECT answer `421` with `Sbx-Instance-Url: http://attacker` → the front never contacts the attacker (counting listener) and answers `502 upstream_error` or `503`;
    - a `401`/`429`/`503` with `Retry-After: 99999` → `502 upstream_error`, and no agent headers are copied;
    - `200` and then immediate EOF → `502 upstream_error`;
    - `Sbx-Dial-Error: <script>` → `502 upstream_error`.
  - **Cross-tenant and spoofing:**
    - `Host: a-80` with `X-Forwarded-Host: b-80` → routed to a; b sees nothing;
    - an absolute-form request `GET https://b-80.sbx.../` sent with `Host: a-80` over HTTP/1.1 → Go makes the URL host win (`r.Host = b-80`). The test pins that one label decides the route and the auth (both b) and that a's cookie is not accepted for b;
    - the uppercase host and trailing-dot host `a-80.sbx.example.com.` are handled as 404, not as a different route;
    - `Host` with port `:8443` → `404`;
    - the slug `api-3000` → `404`;
    - a label for a deleted sandbox and an unpublished port give identical `404` bodies, apart from `requestId`.
  - **Cookie and session scope:**
    - a cookie minted for a-80 is replayed on a-3000 and b-80 → `401`;
    - a cookie with mode `t` on an sso route → `401`;
    - an expired cookie → `401`;
    - a cookie signed with a removed kid → `401`;
    - an `sso` callback on label X with a code issued for Y → `401`;
    - a state cookie from another label → refused.
  - **Platform credentials never reach the app:** the client sends `__Host-oauth2_proxy`, `_oauth2_proxy_csrf`, `__Secure-oauth2_proxy_1`, `X-Auth-Request-Email`, `X-Forwarded-User` and `Sbx-Port-Token`; the echo sees none of them.
  - **SSH principal checks:** these are covered in Task 11. Here, across instances:
    - a cert for sandbox X used with username Y → the API is called with `sandbox: Y` and `principal: sb_X` and denies;
    - the backend sshd double sees principal `loginUser` only;
    - `KeyId` with a newline or `sbx:user:` empty → refused.
- [ ] Step 2: Run them. Fix whatever they reveal in the owning package, with a regression unit test there.
- [ ] Step 3: Run `go test -race ./...`: PASS.
- [ ] Step 4: Commit `gateway: security suite (hostile app and agent, cross-tenant, cookie scope)`.

### Task 16: SSH e2e: real OpenSSH and multi-instance drain

**Files:**
- Create: `internal/e2e/openssh_test.go`, `internal/e2e/ssh_drain_test.go`.

- [ ] Step 1: Write the tests:
  - **OpenSSH.** Skipped with a reason when the binaries are missing. Real `sshd` runs as the current user on `127.0.0.1:<random>`:
    - config: `TrustedUserCAKeys`, `AuthorizedPrincipalsFile none`, `PasswordAuthentication no`, `UsePAM no`, a `HostKey` generated per test, and `StrictModes no`;
    - the machine's port 22 is mapped to it;
    - the client is real `ssh` with `-F none -o UserKnownHostsFile=<file with the gateway host key>` and `StrictHostKeyChecking yes`, entering at instance A while the machine is on C.

    Cases:
    - `ssh slug@127.0.0.1 -p <A ssh port> echo ok`;
    - `ssh -t … 'tty'`;
    - `scp` up and down 10 MiB with a matching sha256;
    - `sftp -b` (put, get, ls);
    - `rsync -e ssh`;
    - `ssh -L` to an app;
    - `ssh -R` with `curl` from the "VM" side;
    - `ssh -A` with `ssh-add -l` in the VM, listing the key from a test `ssh-agent`;
    - the sshd log (`-E file`) contains `sbx:user:` in the accepted-certificate line;
    - `ssh -v` output has no `hostkeys` errors.
  - `TestSSHFrontDrain`: an SSH pty session through A; A drains (SSH drain 3 s) → the client stderr gets the warning at once, then close at about 3 s. `Drain` returns.
  - `TestSSHOwnerDrainOnly`: front A, owner C; C drains → A learns of it through `NOTIFY gateway_instances`, sends the same message and closes at C's deadline. A is not draining.
  - `TestSSHAcrossMove`: a new SSH conn after the machine moved works through the new owner, and the same gateway host key is shown (`known_hosts` keeps working).
- [ ] Step 2: Run them. Fix whatever they reveal in the owning package, with a regression unit test there.
- [ ] Step 3: Run `go test -race ./...`: PASS.
- [ ] Step 4: Commit `gateway: SSH e2e with OpenSSH, drain across instances`.

### Task 17: Binary, container, compose fragment, CI, docs

**Files:**
- Modify: `cmd/sbx-gateway/main.go`.
- Create:
  - `internal/devsecrets/devsecrets.go`, `devsecrets_test.go`
  - `services/gateway/Dockerfile`
  - `deploy/compose/gateway.yaml`
  - `deploy/compose/README.gateway.md`
  - `.github/workflows/gateway.yml`
- Modify: `docs/plans/s4-gateway.md` (deviations found during implementation), `docs/roadmap.md` (S4 status line only).

**Interfaces:**
- `sbx-gateway serve` (the default) runs `config.FromEnv(os.Getenv)`, a `pgxpool`, `cpapi.NewHTTPClient`, `server.New` and `Run`.
  - SIGTERM or SIGINT → `Drain(ctx)` with a ctx bounded at 950 s; a second signal → immediate exit.
  - An unset `SBX_GATEWAY_API_URL` → a startup error, unless `SBX_GATEWAY_API_URL=none`, which gives a dev mode with every lookup failing as `503 route_lookup_unavailable` and the events sink nil.
- `sbx-gateway dev-secrets -dir <dir> [-domain sbx.localhost] [-tunnel-host tunnel.localhost]` creates only the missing files:
  - CA, sbx wildcard cert and key, tunnel cert and key;
  - cookie keys, SSH host keys, user CA, login CA;
  - service tokens JSON and the api token.

  It is idempotent.
- Dockerfile: multi-stage `golang:1.27.3` build from the repo root context, with `go.work` and `libs/*` copied, `CGO_ENABLED=0`. Runtime image `gcr.io/distroless/static-debian12:nonroot`, exposing 8443, 2222, 7000 and 9090.
- `deploy/compose/gateway.yaml` is an include-able fragment:
  - a one-shot service `gateway-secrets` runs `dev-secrets` into `./secrets/gateway`;
  - service `gateway` depends on `migrate` (completed) and `gateway-secrets`;
  - environment: `DATABASE_URL`, `SBX_GATEWAY_INTERNAL_URL=http://gateway:7000`, the domain `sbx.localhost`, and the file paths;
  - ports `127.0.0.1:8443:8443`, `127.0.0.1:2222:2222`, `127.0.0.1:9190:9090` (the worker uses 9090);
  - `stop_grace_period: 960s`, network `sbx`.
  - It is validated with `docker compose -f <tmp compose with postgres+migrate stubs> config`.
- CI `gateway.yml`: same shape as `tunnel.yml`, module `services/gateway`, Postgres service, OpenSSH installed (`openssh-client openssh-server rsync`) so the OpenSSH e2e runs.

- [ ] Step 1: Write failing tests:
  - `TestDevSecretsIdempotent`: a second run changes nothing; the files load through `config.FromEnv`.
  - `TestMainServeSmoke`: build the binary, run it with dev secrets, Postgres and `API_URL=none`; `/healthz` and `/readyz` turn 200; SIGTERM → exit 0 within 3 s (shrunk via env).
- [ ] Step 2: Implement. Run `docker build -f services/gateway/Dockerfile .` and the compose `config` validation.
- [ ] Step 3: Final verification, all green:
  - `pnpm -r test`, `pnpm lint`, `pnpm build`;
  - for `libs/proto`, `libs/tunnel`, `services/node-agent` and `services/gateway`: `go test -race ./...`, `go vet ./...`, `golangci-lint run ./...`;
  - `buf lint` and `buf generate` with no drift (`git diff --exit-code`).
- [ ] Step 4: Commit `gateway: binary, dev secrets, Dockerfile, compose fragment, CI, docs` and push `s4-impl`.
