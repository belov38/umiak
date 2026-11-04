# @umiak/api

Public API v1 (S7): Hono + `@hono/zod-openapi` on Node. The specification is `docs/specs/s7-public-api.md`; where the
implementation differs, see its §23. Routes call `SandboxService` (`packages/core`, S6) and the agent through the `AgentApi` interface.

## Running

`api` itself is not built: `node src/main.ts` (type stripping). `@umiak/proto` and `@umiak/agent-client` are taken
from `dist` at runtime, so build them once and after changes:

```sh
mise exec -- pnpm --filter "@umiak/agent-client..." run build   # or mise exec -- pnpm build
mise exec -- node apps/api/src/main.ts                         # environment variables — below
```

Identities (users, teams, keys) and config (templates, sizes, quotas, `defaults`) come from Payload
(`@umiak/payload`: `PayloadIdentityStore`, `PayloadConfigReader` with `LISTEN umiak_config`, its own pool of 10 connections).
`api` does not apply the `payload` schema migrations: `node packages/payload/src/migrate.ts` does (in compose,
`web-migrate`) before start; until then `/readyz` answers `503`.

In docker compose this is the `api` service (`deploy/compose/README.md`); the image is `deploy/compose/quickstart/Dockerfile`. An invalid
environment makes it exit with code `1` and a list of all errors. A broken file (keys, tokens, CA, identities) fails the start before the
first Postgres connection. SIGTERM/SIGINT: readiness → false, a `reconnect` frame to streams, `1012` to PTYs,
`503 server_shutting_down` to sync commands, exit within 10 s; a second signal exits with `1` immediately.

## Listeners

| Port (env) | Default | Who | Authentication |
|---|---|---|---|
| `UMIAK_API_PUBLIC_PORT` | 8080 | SDK, CLI, MCP, CI | Keycloak JWT or team key `umiak_`; `X-Auth-Request-*` are stripped |
| `UMIAK_API_PROXIED_PORT` | 8081 | browser via oauth2-proxy | oauth2-proxy headers, `Origin` check; `UMIAK_API_PROXIED_ENABLED=0` — do not start |
| `UMIAK_API_INTERNAL_PORT` | 8082 | gateway (S4) | service token |
| `UMIAK_API_METRICS_PORT` | 9090 | Prometheus, probes | none: `/healthz`, `/readyz`, `/metrics` |

`/readyz` is ready when Postgres and `LISTEN umiak_identity` work, all Payload migrations known to the code are applied, and the
process is not shutting down; otherwise `503 not_ready` with `details.reasons` (`postgres`, `identity_listener`,
`payload_migrations`, `shutting_down`).
OpenAPI is `GET /v1/openapi.json`, documentation is `GET /v1/docs` (no authentication; docs only on public:
the page loads Scalar from jsDelivr, pinned with SRI).

**The ingress in front of public and proxied must rate-limit requests by client IP.** `api` limits are counted per
principal, that is, after authentication; before it, every request with `Bearer umiak_…` is a key lookup (cache 30 s / 5 s for an
unknown hash, then Postgres), and every JWT is a signature check. Request bodies are not read before authentication,
bounded bodies must arrive within 60 s; an upload chunk has no overall deadline but no more than 30 s without new bytes
(`408 request_timeout`, retryable).

## Environment variables

The source of truth is `src/settings.ts`. An empty string counts as "not set".

| Variable | Default | What |
|---|---|---|
| `DATABASE_URL` | required | Postgres (`postgres://…`) |
| `PAYLOAD_SECRET` | required | Payload config secret (the same as for `web` and `worker`) |
| `UMIAK_DATA_KEYS_FILE` | required | S6 data keys (format of `deploy/compose/config/data-keys.example.json`) |
| `UMIAK_API_CURSOR_KEY` | required | base64, at least 32 bytes: HMAC for cursors |
| `UMIAK_API_SERVICE_TOKENS_FILE` | required | JSON `{"gateway": ["<t1>", "<t2>"]}`: tokens the internal listener accepts |
| `UMIAK_API_GATEWAY_TOKEN_FILE` | — | `api` token for the gateway internal listener (one line). Without it, agent RPC and `/files/*` return `503 agent_unavailable` |
| `UMIAK_IDENTITY_FILE` | — | identity YAML: `teams`, `users`, `apiKeys` by sha256 (format in `packages/auth/src/seed.ts`); upserted into Payload (`seedPayloadIdentity`) on every start; without applied Payload migrations the start fails |
| `UMIAK_OPERATOR_GROUPS` | — | operator IdP groups, comma-separated |
| `UMIAK_OIDC_ISSUER` | — | Keycloak issuer (`https://<keycloak>/realms/umiak`); without it JWTs are not accepted, `/v1/meta` `oidc: null` |
| `UMIAK_OIDC_DISCOVERY_URL` | `<issuer>/.well-known/openid-configuration` | discovery at an internal address |
| `UMIAK_OIDC_JWKS_URL` | `jwks_uri` from discovery | JWKS at an internal address |
| `UMIAK_OIDC_AUDIENCE` | `umiak-api` | required `aud` |
| `UMIAK_OIDC_ALLOWED_CLIENTS` | `umiak-cli,umiak-mcp` | allowed `azp` |
| `UMIAK_API_URL` | required | public API address (`/v1/meta` `apiUrl`) |
| `UMIAK_APP_URL` | required | dashboard address (`/v1/meta` `appUrl`) |
| `UMIAK_APP_ORIGIN` | origin of `UMIAK_APP_URL` | the `Origin` the proxied listener accepts |
| `UMIAK_PREVIEW_DOMAIN` | required | port domain (`<slug>-<port>.<domain>`) |
| `UMIAK_PREVIEW_SCHEME`, `UMIAK_PREVIEW_PORT` | `https`, `443` (for `http`: `80`) | scheme and external port of the preview URL; quickstart uses `http` and `8085` |
| `UMIAK_SSH_HOST`, `UMIAK_SSH_PORT` | `ssh.<UMIAK_PREVIEW_DOMAIN>`, `22` | SSH gateway for `/v1/meta` and `/ssh` |
| `UMIAK_DESKTOP_PATH_PREFIX` | — | owner mode: desktop links look like `<origin>/desktop/<slug>/?dataTransport=websocket` on the owner origin, without a ticket (the browser session authorizes); without it, hostname links `<slug>-desktop.<domain>` with a ticket; compose sets `/desktop` |
| `UMIAK_SSH_HOST_KEYS_FILE` | — | gateway public host keys, one per line |
| `UMIAK_SSH_LOGIN_CA_KEY_FILE` | — | private ed25519 SSH login CA without a passphrase (PKCS#8 PEM or OpenSSH); without it `ssh/certificate` is unavailable |
| `UMIAK_API_TRUSTED_PROXY_CIDRS` | — | comma-separated CIDRs: `X-Forwarded-For` from them goes into the log `clientIp` |
| `UMIAK_API_RATE_RPS`, `UMIAK_API_RATE_BURST` | `20`, `100` | request limit per principal: `burst` per `burst/rps` s |
| `UMIAK_API_RATE_STARTS_PER_MIN` | `30` | create, fork, resume per minute per team |
| `UMIAK_API_MAX_STREAMS` | `100` | open streams and PTYs per principal per process |
| `UMIAK_MIN_CLI_VERSION`, `UMIAK_LATEST_CLI_VERSION` | — | `/v1/meta` |
| `UMIAK_BUILD` | `dev` | `/v1/meta` `build` |
| `UMIAK_LOG_LEVEL` | `info` | pino: `fatal` … `trace`, `silent` |
| listener ports | see above | `0` — any free port (tests) |

## Internal endpoints for the gateway (S4)

All are on the internal listener with `Authorization: Bearer <token from UMIAK_API_SERVICE_TOKENS_FILE>`. Errors put
`code` at the top level of the body too (`{"code": "route_not_found", "error": {...}}`).

| Endpoint | What |
|---|---|
| `GET /internal/v1/gateway/routes/{label}` | port route (S4 §6.1, spec §12.1), `kind: "port"`; no route — `404 route_not_found` |
| `POST /internal/v1/gateway/ssh/authorize` | login by SSH key or login certificate; `recheck: true` — identity check only |
| `POST /internal/v1/gateway/port-auth/exchange` | one-time port SSO code → `{userId, email, label, authEpoch}` or `400 invalid_code` |
| `POST /internal/v1/agent-events` | binary protobuf `AgentEventsRequest` → `{ackedSeq}` |

The gateway learns about route changes from `NOTIFY umiak_routes '<slug>'` (triggers of migrations `0201` and `0204`, including
blocks, `0206`), and about SSH session drops from `NOTIFY umiak_ssh_revoke`: identities, memberships, keys and teams — from Payload
hooks (`@umiak/payload`, the same payloads as the `0302`/`0303` triggers on `identity`), sandbox block —
`''` from `SandboxService.block` (the gateway rechecks all sessions via `ssh/authorize`).

## Agent: `AgentApi`

`src/agent/types.ts` is everything `api` does with the agent: `capabilities`, `requireCapability`, `start`, `attach`,
`sendInput`, `update`, `signal`, `kill`, `get`, `stat`, `list`, `makeDir`, `move`, `chmod`, `remove`, `listPorts`,
`updateEnv`, `updateSecrets`, `files` (the agent's HTTP `/files*`). Errors are `AgentUnavailableError`, `AgentOutdatedError`
(`@umiak/agent-client`) and `AgentCallError` (`src/agent/errors.ts`); the mapping to HTTP is in `src/agent/errors.ts`.

- Tests use `FakeAgent` from `@umiak/api/testing`: real processes, PTY without a terminal, files in a temporary directory.
- The `api` process uses `ConnectAgentApi` (`src/agent/connect.ts`): RPC through `umiak.agent.v1` clients (`@umiak/proto/agent/v1`)
  over `AgentClient.transport(machineId)` (gateway lookup, `421`, waiting for the agent up to 30 s), `files` through
  `AgentClient.fetch`, capabilities from `tunnel.tunnel_sessions`. Without `UMIAK_API_GATEWAY_TOKEN_FILE` all calls return
  `503 agent_unavailable`. `attach` is one `Process/Attach` stream; reconnection is `resumableAttach` in
  `src/commands/attach.ts`.
- Errors follow the table in the doc comment of `agentErrorToHttp` (`src/agent/errors.ts`): Connect
  `Unavailable`/`Canceled`/`DeadlineExceeded` stay `ConnectError` (with any detail), everything else is
  `AgentCallError(<ErrorDetail code>)`, without a detail — the Connect code name (`failed_precondition`). Mutations without
  an idempotency key (`Start` without a key, `input` without a session, `signal`, file `mkdir`/`move`/`chmod`/`delete`)
  with an unknown outcome return `503 agent_unavailable`, `retryable: false`, `details.outcome: "unknown"`
  (`agentMutationErrorToHttp`).
- Integration tests against a real agent are in `test/agent-real.test.ts`: the Go program
  `services/guest-agent/cmd/umiak-agent-harness` (built in global setup via `mise exec -- go build`) runs
  the S2 gateway and the S3 agent in one process with fake OS dependencies; commands are host processes under the current
  user. Without `go` the tests are skipped with the reason in the output. Limitations (no cgroups, no `user` user,
  no claim) are in the file header.
- Not done: stream chaos through the tunnel (spec §16) and E2E `umiak-bench s7` on `pve`.

### S3 wiring: proto ↔ `AgentApi` adapter

- Enums: `*_UNSPECIFIED` is not a value. `CommandState`/`ExitStatus`/`ExitReason`/`Stream` without the prefix, in lower
  case (`EXIT_REASON_PTY_IDLE` → `pty_idle`); `UNSPECIFIED` of `ExitReason` → `none`, of `ExitStatus` with
  `exit` set → adapter error (do not guess), of `Stream` — skip the event.
- Proto zeros → `null` in `AgentApi`: `pid = 0` → `null`, `signal = ""` → `null`, empty `output_truncated` →
  `null`, missing `exit` → `null`, unset `Timestamp` → `null`, unset `StreamInfo.end` → `null`.
  `ExitInfo.code` is always a number (0 is a real code).
- `uint64` (offsets, sizes) arrive as `bigint`: convert to `number` only after checking
  `<= Number.MAX_SAFE_INTEGER`, otherwise an adapter error (do not truncate). Back — `BigInt(n)`.
- `CommandInfo.streams` is a list of `StreamInfo` with a `stream` field; in `AgentApi` it is an object keyed by stream name, only
  the command's streams (a PTY has one, `pty`).
- Set `Umiak-Request-Id` (S2 §9.2) on mutating calls: `Start` (`requestId` from `opts`, UUIDv5 of the idempotency
  key), `MakeDir`/`Move`/`Chmod`/`Remove`, `UpdateEnv`/`UpdateSecrets`. A `request_id_reused` response
  means a different request under the same id → `409 idempotency_key_reused` (`Start` never has it: the agent
  checks `Start` by `commandId`, not by request id).
- `SendInput.seq` starts at 1: the shim drops `seq <= last`, a new session has `last = 0`.
- `Start` errors: `failed_to_start` only for rejections before the process starts (`invalid_argument`, `user_not_found`,
  `already_exists`, `too_many_commands`, `not_claimed`, `failed_precondition`, `shim_outdated`, `unimplemented`).
  `request_id_reused` does not come from `Start`: `Start` is excluded from the agent's request id cache (idempotent by
  `commandId`). A retry with a key sends the spec of the stored row; `already_exists` on a retry means attach to the
  agent's command (`Process/Get`), not a failure. The agent sends `internal` even after the process has started, so
  `internal`, `unknown` and unfamiliar codes mean the outcome is unknown (`503`, the row stays `starting`;
  `commands/run.ts`).
- `StreamInfo.size` is the size of the stream file; after exit, remaining processes may keep writing past `end`
  (S3 §10). Count offsets, `tailBytes` and `sizeBytes` from `streamSize()` = `min(size, end)`.
- Known limitation: `AgentClient` (S2) retries unary calls with the same `Umiak-Request-Id`, while the agent's
  response cache (S3) skips `IDEMPOTENT` methods, `Signal` among them. A lost response means the signal is delivered twice
  (harmless for `TERM`/`KILL`/`INT`, not for counting signals). To be fixed in S2 or S3 (S7 §23.9).

## OpenAPI

`openapi/v1.json` is generated from the zod schemas and committed:

```sh
mise exec -- pnpm --filter @umiak/api openapi
```

The `openapi-drift` test fails if the document is stale. After changing schemas, regenerate the SDKs too
(`packages/sdk-ts`, `packages/sdk-py`).

## Tests

```sh
mise exec -- pnpm --filter @umiak/api test        # vitest; Postgres is a docker container from global setup
mise exec -- pnpm --filter @umiak/api typecheck
```

- Postgres: without Docker, use `UMIAK_TEST_DATABASE_URL`; `UMIAK_TEST_SKIP_PG=1` skips tests that need the database.
- Integration test requests and responses are checked against `openapi/v1.json` (conformance).
- Keycloak in tests is a custom OIDC server with JWKS and device grant (`startTestOidcServer` from `@umiak/api/testing`);
  real Keycloak is checked by the compose smoke check (`deploy/compose/README.md`).
