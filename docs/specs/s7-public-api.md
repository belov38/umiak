# S7. Public API v1, SDK, CLI: specification

Status: agreed (the master session on Ilia's behalf), 2026-10-29. Supplemented with the MVP recommendations R1, R2, R4, R7, R9–R11 (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29). Area S7 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§2, §9, §10, §11). Relies on `docs/specs/s6-control-plane.md` (`SandboxService`, states, idempotency), `docs/specs/s2-tunnel-protocol.md` (§8.4 `agent-client`, §9 resumability), `docs/specs/s3-guest-agent.md` (agent RPC), `docs/specs/s4-gateway.md` (internal endpoints for the gateway).

The MVP implementation is the branch `s7-impl` (plan `docs/plans/s7-public-api.md`). What was done differently or in more detail is in §23; places in the text below are marked with a reference to §23. The warm pool (`failFast`, `pool_exhausted`, `warmAvailable`, `--fail-fast`) is phase 2, outside the public MVP contract (Ilia's decision 2026-10-29).

The answers to Q1–Q4 and the way to close the gaps between specs were agreed with the master session on Ilia's behalf (2026-10-29). The mark **[S7 decision]** is a decision of the spec author within the brief; it can be changed during planning if the reason is recorded. The mark **[overrides S4]** / **[overrides S6]** marks a place where S7 changes an already agreed spec. The S4 and S6 implementers must take such places into account; the summary is §20.

## 1. Why

S7 is the platform's external interface. It is used by AI agents (through the SDK, CLI, and MCP), CI, and people (the CLI and the S8 dashboard). It turns HTTP calls into S6 operations and agent RPCs (S2/S3), and is responsible for authentication, permissions, errors, and data shape.

What counts as success:
1. An agent creates a sandbox, starts a 40-minute build, and gets its output **byte for byte** with the right exit code, even if during that time the tunnel dropped, the gateway was redeployed, and the `api` pod restarted. Repeating a request with the same `Idempotency-Key` does not start the command a second time.
2. A typical scenario (create → wait for ready → exec → files → delete) takes 5–10 lines in TS and in Python, with no manual NDJSON parsing and no manual retries.
3. `umiak login` (Keycloak device grant) signs in with one confirmation in the browser, including from a machine without a browser; people have no long-lived personal keys, and a person disabled in Keycloak loses access within minutes (§7.6, §7.10).
4. From the response to any error the client (and an LLM) understands what happened and whether it is safe to repeat the request.
5. OpenAPI is the single source of truth: the SDK, CLI, MCP, and docs are built from it, and CI catches a breaking change of `v1`.

## 2. Goals, non-goals, anti-goals

**Goals**
- `apps/api` on Hono + `@hono/zod-openapi`: the public v1 resources, NDJSON streams, PTY over WebSocket, internal endpoints for the gateway and for receiving agent events.
- Uniform conventions: IDs, errors, pagination, idempotency, limits, versions.
- Authentication: Keycloak JWT for people in the CLI, SDK, and MCP; team API keys with scopes for automation; browser calls through oauth2-proxy; `umiak login`; the contract with S8.
- A resumable stream from the agent to the client.
- OpenAPI 3.1, the TS and Python SDKs (generation and handwritten facades with helpers).
- `apps/cli` (`umiak`) on Bun compile.
- The S11 (MCP) requirements for the API.

**Non-goals (other areas)**
- Payload, UI, creating JIT users, roles from IdP groups, the key and SSH key collections (S8). S7 sets only the contract (§17.3).
- State machines, admission, operations, secret storage (S6).
- The gateway, public URLs, the SSH proxy (S4). The agent (S3). The MCP server (S11). The desktop (S10).
- Webhooks, command output history outside the VM, signed file URLs, built-in coding agents (later, §19).

**Anti-goals (a failure even if everything works)**
- A command ran twice because of a retry the SDK made itself.
- The output the client received after reconnecting differs from the real one by even a byte, and the client did not learn of it (the `truncated` event did not arrive).
- The value of an env, a secret, an API key secret, a port token, or a login code ended up in a log, a metric, a `GET` response, or a URL.
- A request to the public host passed authentication by an `X-Auth-Request-*` header.
- A team key was issued by someone other than the team's `owner`, or received rights wider than the scopes they chose; a JWT not from the Keycloak realm `umiak` or not for `umiak-api` was accepted.
- `retryable: true` in a response after which repeating the same request creates a second resource or starts a second command.

## 3. Constraints

- The toolchain from `mise.toml` (Node 26.13.0, pnpm 12.16.1, Bun 1.4.4). For the Python SDK `python` and `uv` are added to `mise.toml` (§18). The library versions are in §18, checked 2026-10-29; re-check during implementation (`CLAUDE.md`).
- Layout per `CLAUDE.md`: `apps/api`, `apps/cli`, `packages/sdk-ts`, `packages/sdk-py`, `packages/auth`. Tests with vitest (TS) and pytest (Python), lint with biome and ruff.
- Not wire-compatible with boat (a decision before S7). The semantics are close to boat (`research/03-api-sdk-surface.md`), the format is our own.
- An internal company platform: the SDK and CLI are not published to public npm and PyPI (§15.5).
- PoC before S8: users, teams, and keys come from a static YAML (§7.9).

## 4. Overview

```
 agents / CI / CLI / SDK                     browser (dashboard S8, terminal)
   |  https://api.<domain>/v1/*                 |  https://app.<domain>/api/v1/*, /umiak-auth/*
   |  Bearer <Keycloak JWT> | umiak_... (team)    v
   |                                     +--------------+
   |                                     | oauth2-proxy |  OIDC, X-Auth-Request-Email/-User/-Groups
   |                                     +------+-------+
   v                                            v
 +----------------------------- apps/api (one process, one Deployment) --------------------------+
 | :8080 public   - Keycloak JWT or team keys, X-Auth-Request-* stripped                          |
 | :8081 proxied  - trusts oauth2-proxy headers, Origin checks, JIT user via IdentityStore (S8)   |
 | :8082 internal - service tokens: /internal/v1/agent-events, /internal/v1/gateway/*             |
 | :9090 metrics, /healthz, /readyz                                                               |
 |                                                                                                |
 |  routes (zod-openapi) -> auth/scopes -> packages/core SandboxService (S6) -> Postgres, pg-boss |
 |                                      -> @umiak/agent-client (S2) -> gateway internal -> agent    |
 +------------------------------------------------------------------------------------------------+
        ^ gateway (S4): routes, ssh/authorize, port-auth/exchange, agent-events
```

`api` does not go to Proxmox and does not execute operations: it enqueues them through `SandboxService` (S6 §7.1), and the worker executes them. `api` talks to the agent directly only for commands, PTY, files, ports, and env (S6 §4.1).

### 4.1 Packages and applications

| Path | Name | What |
|---|---|---|
| `apps/api` | `@umiak/api` | A Hono application, three listeners, routes, zod schemas, OpenAPI generation into `apps/api/openapi/v1.json` (committed) |
| `packages/auth` | `@umiak/auth` | API key format and hash, scopes and presets, the `IdentityStore` interface and its static implementation (in the implementation — `PgIdentityStore`, §23.10). Used by `api` and S8 (so there is one key format) |
| `packages/sdk-ts` | `@umiak/sdk` | Generated types + `openapi-fetch` + the `Umiak` facade and helpers |
| `packages/sdk-py` | `umiak-sdk` (import `umiak_sdk`) | A Python project (uv); the generated client + the `Umiak`/`AsyncUmiak` facades |
| `apps/cli` | `umiak` | A CLI on `@umiak/sdk`, built with `bun build --compile` |
| `packages/core`, `packages/db`, `packages/config` | S6 | Service layer, migrations, configuration |
| `packages/agent-client` | S2 | The agent's Connect client with routing and resumption |

## 5. General conventions

### 5.1 Hosts and paths

| Host and path | Listener | Who |
|---|---|---|
| `https://api.<domain>/v1/*` | public `:8080` | SDK, CLI, MCP, CI, agents |
| `https://app.<domain>/api/v1/*` (the ingress strips the `/api` prefix) | proxied `:8081` | the browser (S8 dashboard, terminal) |
| `https://app.<domain>/umiak-auth/*` | proxied `:8081` | SSO for ports (S4 §8.4) |
| `http://api.<ns>.svc:8082/internal/v1/*` | internal `:8082` | gateway |
| `GET /v1/openapi.json`, `GET /v1/docs` | public and proxied (`/v1/docs` — public only, §23.3) | no authentication |

The resources on the public and proxied listeners are the same, only authentication differs (§7).

### 5.2 Data format

- JSON, `camelCase` fields. Time is ISO 8601 UTC with milliseconds (`2026-10-29T12:00:00.000Z`). Durations are `...Seconds` (integers), sizes are `...Bytes`, offsets are integer bytes (JSON number, up to 2^53).
- A successful response is the resource itself without a wrapper. Action responses are an object with named fields (`{sandbox, operation}`).
- Lists are `{ "data": [...], "nextCursor": "..." | null }`.
- Unknown fields in a request body are `400 validation` (a typo must not silently change behavior, especially in scopes). The client must ignore unknown fields in a response: v1 only grows.
- `null` and an absent field in a response mean the same thing; the SDK normalizes to `null`/`None`.

### 5.3 Identifiers [decision Q1]

A public ID is a prefix + 26 characters of Crockford base32 in lowercase from 128 bits. A UUIDv7 from the DB (S6) and a ULID are encoded the same way, so IDs sort by creation time.

| Resource | Prefix | Source |
|---|---|---|
| Sandbox | `sb_` | `sandboxes.id` (UUIDv7) |
| Operation | `op_` | `operations.id` |
| Command (and PTY) | `cmd_` | `commands.id` (ULID, S2 §9.1) |
| Saved snapshot | `snap_` | `snapshots.id` |
| API key (id, not the secret) | `key_` | Payload |
| SSH key | `sshk_` | Payload |
| Environment | `env_` | `environments.id` (S8 §10) |
| User / Team | `usr_` / `team_` | Payload |
| Upload | `upl_` | ULID, generated by `api` |
| Request | `req_` | a ULID per request |

- An API key secret is the only value with the prefix `umiak_` (§7.2). The prefix `umiaks_` is reserved for the secret of a `sandbox`-type key (§7.2, not issued in the MVP). A port token is `umiakp_` (S4 §8.3).
- The decoder accepts an ID in any case. A format error is `404 not_found` (not `400`): the client does not care whether the ID is "bad" or nonexistent.
- In the path `{sandbox}` you can pass an ID (`sb_...`) or a slug. A string with the prefix `sb_` is always an ID, otherwise a slug.

### 5.4 Slug [overrides S6 §5.6]

A slug is the human-readable name of a sandbox in port URLs (`<slug>-<port>.umiak.<domain>`), in SSH (`ssh <slug>@ssh.<domain>`), and in the guest hostname (`umiak-<slug>`).

- The grammar is S4 §4.2: `[a-z0-9]+(-[a-z0-9]+)*`, 3–40 characters, no `--`, not ending in `-<digits>` (otherwise label parsing is ambiguous), not ending in a reserved suffix (`-desktop`, a constant shared with the gateway). Reserved in full: `api`, `app`, `www`, `ssh`, `tunnel`, `admin`, `static`, `umiak`.
- By default `api` generates **three words** (`quiet-otter-lamp`) from a built-in dictionary of roughly 1,500 short (3–7 letters) neutral English words, about 3.4 · 10⁹ combinations. On a collision — up to 5 new attempts, then a fourth word is added. (In the MVP — the core dictionary, about 300 words, §23.3.)
- A user can set a slug on create/fork and change it with `PATCH` (`slug_taken` if taken). Changing a slug changes the labels of all published ports: the old URLs and cookies stop working immediately (S4 §8.2).
- A slug is taken while the sandbox row lives, including the `deleted` tombstone (30 days, S6 §5.6).
- S6 §5.6 and §14.2 are aligned with this grammar (MVP rec. R10); the `text unique` column fits unchanged.

### 5.5 Errors

```json
{
  "error": {
    "code": "operation_in_progress",
    "message": "Sandbox quiet-otter-lamp already has a running 'resume' operation. Retry after it finishes.",
    "retryable": true,
    "details": { "operationId": "op_01jbx...", "kind": "resume" },
    "requestId": "req_01jbx..."
  }
}
```

- Every error body has `code`, `message`, `retryable`, and `requestId`, on any listener and with any status, including `401`, `404`, and errors before authentication; `details` is an object (may be empty). The client, SDK, and CLI rely on this without checks.
- `code` is a stable `snake_case` string, part of the v1 contract: new codes may be added, existing ones may not be changed. The HTTP status duplicates the error class.
- `message` is in English, written for a human and an LLM: what happened and what to do next.
- **`retryable: true` means repeating the same request is safe and may succeed later**: either nothing happened, or the request is idempotent (method `GET`, natural idempotency, or `Idempotency-Key`). If the outcome is unknown (the command may have started), `retryable: false` and `details.outcome: "unknown"` are set.
- On `429` and `503` there is a `Retry-After` header (seconds) and `details.retryAfterSeconds`.
- The header `Request-Id: req_...` is in every response; the client may send its own `Request-Id` (up to 128 characters `[A-Za-z0-9._-]`) — it will appear in logs next to ours.

| HTTP | `code` | `retryable` | When |
|---|---|---|---|
| 400 | `validation` | no | body or query schema; `details.issues[] {path, message}` |
| 400 | `invalid_json`, `invalid_cursor`, `invalid_path` | no | |
| 401 | `unauthorized` | no | no bearer, the key is unknown or revoked, the JWT failed verification (`details.reason: "invalid_token"`, §7.10) |
| 401 | `token_expired` | no | the Keycloak access token expired: refresh the token and repeat (§7.6) |
| 401 | `api_key_expired` | no | |
| 403 | `forbidden` | no | a scope (`details.requiredScope`) or role is missing; `details.reason`: `role`, `user_required` (an endpoint for humans only), `user_disabled` (the user is deactivated, S8 §20.1) |
| 403 | `team_forbidden` | no | `Umiak-Team` is not among the user's teams or does not match the key's team |
| 403 | `origin_forbidden` | no | the Origin check on the proxied listener (§7.4) |
| 403 | `quota_exceeded` | no | team quota (S6 §8.5); `details {quota, limit, current}` |
| 403 | `path_forbidden` | no | `EACCES` in a file operation |
| 404 | `not_found` | no | the resource does not exist or belongs to someone else (someone else's is indistinguishable from nonexistent) |
| 404 | `snapshot_not_found`, `path_not_found`, `upload_not_found` | no | |
| 408 | `request_timeout` | yes | added in the implementation (§23.2): an upload chunk stalled (§23.3) |
| 409 | `invalid_state` | no | the operation is not allowed in the current state; `details.state` |
| 409 | `sandbox_not_ready` | no | the sandbox is not `ready` for commands, files, PTY; `details.state` |
| 409 | `sandbox_starting` | yes | the sandbox is in `creating`/`starting` longer than the 60 s wait (§8.1) |
| 409 | `operation_in_progress` | yes | another operation is active; `details {operationId, kind}` |
| 409 | `idempotency_key_reused` | no | the same key, a different body |
| 409 | `snapshot_requires_stop` | no | fork or saved snapshot of a running Windows sandbox without `forceStop` (S9 §24.8); `details {reason: "windows_running", retryWith: {forceStop: true}, cli: "--force-stop"}`, the message suggests retrying with `forceStop: true` |
| 409 | `slug_taken`, `snapshot_name_taken`, `ssh_key_in_use`, `already_exists` | no | |
| 409 | `agent_outdated` | no | the agent lacks a capability; `details.capability` |
| 409 | `command_exited` | no | input/resize for a finished command |
| 409 | `upload_offset_mismatch` | no | `details.offset`, header `Umiak-Upload-Offset` |
| 409 | `not_directory`, `is_directory`, `cross_device` | no | files (S3 §11.1) |
| 413 | `payload_too_large` | no | |
| 416 | `range_not_satisfiable` | no | |
| 422 | `template_unavailable` | no | the template is off or the size is not allowed |
| 422 | `checksum_mismatch` | no | upload commit |
| 428 | `confirmation_required` | no | `Umiak-Confirm-Delete` is missing or does not match the resource being deleted (§5.12); `details.reason: missing \| mismatch` |
| 429 | `rate_limited` | yes | §5.8 |
| 429 | `recover_rate_limited` | yes | S6 §7.8 |
| 500 | `internal` | no | |
| 502 | `agent_error` | no | the agent returned an unexpected error; `details.agentCode` |
| 503 | `agent_unavailable` | yes | the agent has been absent longer than 30 s (S2 §8.4) |
| 503 | `out_of_capacity` | yes | no RAM on the node (S6 §8.2) |
| 503 | `pool_exhausted` | yes | **phase 2, outside the public MVP contract (Ilia's decision 2026-10-29)**: create with `failFast` and no warm machine (§8.2); nothing was created |
| 503 | `server_shutting_down` | yes* | the `api` pod is stopping; *only for requests that are safe to repeat (§9.4) |
| 507 | `no_space` | no | `ENOSPC`/`EDQUOT` in the guest |
| 405 | `method_not_allowed` | no | added in the implementation (§23.2): the path exists, the method does not; header `Allow` |
| 426 | `upgrade_required` | no | added in the implementation (§23.2): `GET .../connect` without a WebSocket upgrade |
| 503 | `idp_unavailable` | yes | added in the implementation (§23.2): Keycloak discovery or JWKS is unavailable and there are no keys in the cache |
| 503 | `not_ready` | yes | added in the implementation (§23.2): `/readyz`, `details.reasons` |

The S6 domain errors (`UmiakError{code, retryable, details}`) map per this table; S6 `validation` is `400`, `not_found` is `404`, and so on. Connect errors from the agent follow S3 §11.1 and S2 §10.1.

### 5.6 Pagination

- `GET` of lists: `limit` (1–200, default 50), `cursor` (opaque, from `nextCursor`). The order is fixed for each list (by default newest first).
- The cursor is base64url of JSON `{k: <sort key>, id}` with an HMAC (key `UMIAK_API_CURSOR_KEY`), so the client does not build it itself (in the implementation — a wrapper over the core cursor, §23.3). A forged one is `400 invalid_cursor`. The cursor lives as long as the key.
- For lists served by the agent (`files/list`), the cursor wraps the agent's `page_token`.

### 5.7 Idempotency

- The header `Idempotency-Key` (1–255 printable ASCII) is accepted by: `POST /sandboxes`, `POST /sandboxes/{sandbox}/fork`, `POST /sandboxes/{sandbox}/commands`, `POST /sandboxes/{sandbox}/ptys`, `POST /snapshots`.
- Storage is the S6 table `idempotency_keys`: `(principal, scope, key)`, a hash of the canonical body, 24 h. The same key and body → the stored result (the same resource), header `Idempotency-Replayed: true`. A different body → `409 idempotency_key_reused`. A parallel duplicate waits for the first (S6 §14.1). The principal for a key is a team API key or a user (a session or a Keycloak JWT — the same `userId`).
- For commands the key becomes a `commandId`; the agent's `Process/Start` is idempotent by it (S2 §9.1). So repeating `POST /commands` with the same key **never** starts the command a second time, but attaches to the already running one (§9.3).
- Mutating agent calls without a public key get `Umiak-Request-Id` = a new UUID per HTTP request (retries inside `agent-client` keep it). With a public key — a UUIDv5 of `(principal, scope, key)`.
- Other actions are naturally idempotent: `stop`, `recover`, `delete` with an active operation of the same kind return it, `resume` — if the body also matches (§8.2); `PUT /ports/{port}` with the same settings changes nothing; `DELETE` is repeatable.
- **The SDK generates `Idempotency-Key` itself** (UUIDv4) for all endpoints in the list if the caller did not pass its own, and keeps it for all its retries.

### 5.8 Rate limits

- A token bucket in pod memory per principal (API key or user) [S7 decision; in the implementation — a fixed window of 100 requests per 5 s, §23.3]: by default 20 requests/s, burst 100; for creation (`create`, `fork`, `resume`) — 30 per minute per team. An open stream (NDJSON or WebSocket) counts as one request; no more than 100 concurrent streams per principal per pod. The values are in the config.
- With two or more pods the limit effectively multiplies by the number of pods. This is acceptable: quotas and S6 admission protect the nodes from overload, and the limits protect `api` itself.
- Headers (IETF draft `RateLimit` / `RateLimit-Policy`): `RateLimit-Policy: "req";q=100;w=5`, `RateLimit: "req";r=37;t=2`. Exceeding is `429 rate_limited` with `Retry-After`.
- The library is `rate-limiter-flexible` (memory backend); if needed later, the Postgres backend of the same library.

### 5.9 Versions

- The version is in the URL: `/v1`. Within v1 only additions: new endpoints, response fields, optional request fields, enum values (clients must accept unknown enum values; SDKs are generated with open enums, §15). A breaking change is `/v2` next to `/v1`.
- Deprecation: the headers `Deprecation` and `Sunset` (RFC 9745, RFC 8594) on an endpoint, the mark `deprecated: true` in OpenAPI.
- CI: `apps/api/openapi/v1.json` is regenerated and compared with the committed one (a mismatch is an error); `oasdiff breaking` against `main` (a breaking change is an error).
- `GET /v1/meta` returns `minCliVersion`; a CLI below the minimum warns and keeps working.

### 5.10 Long operations and waiting

- Actions that start an S6 operation (`create`, `fork`, `stop`, `resume`, `recover`, `delete`, `snapshots`) answer `202` with the operation and the current sandbox state.
- **Long-poll**:
  - `GET /v1/sandboxes/{sandbox}?waitFor=ready,stopped&waitSeconds=30` (up to 60 s): the response comes as soon as the state enters `waitFor` or becomes `error`/`deleting`/`deleted`, otherwise on timeout — the current state, `200` in both cases. Implementation — `SandboxService.waitForState` (`LISTEN umiak_sandboxes`, S6 §14.1).
  - `GET /v1/operations/{operation}?waitSeconds=30` — until the operation's terminal state (`LISTEN umiak_operations`, §20.2).
- SDK helpers wait by long-poll, not by frequent polling.

### 5.11 Body sizes

| Endpoint | Limit |
|---|---|
| JSON by default | 1 MiB |
| `POST /sandboxes`, `fork`, `resume`, `PUT /env` | 12 MiB (env and secrets + base64 secret files, §8.3) |
| `PUT /files/content` | no limit (stream) |
| `PUT /files/archive` | no limit on the body; extraction limits — §11.1 |
| `PUT /files/uploads/{upload}` | 8 MiB per chunk |
| `POST /commands` | 1 MiB (the command itself up to 256 KiB) |
| `POST /internal/v1/agent-events` | 16 MiB |

### 5.12 Delete confirmation

- `DELETE /v1/sandboxes/{sandbox}` and `DELETE /v1/snapshots/{name}` require the header `Umiak-Confirm-Delete: <id>`. The value is the ID of the resource being deleted (`sb_...`, `snap_...`) or its slug / name; it must point to the same resource as the path. A missing header or one pointing to another resource → `428 confirmation_required`, nothing is deleted.
- The header protects against mistakes of agents and scripts (the wrong slug, an empty variable substituted), not against an attacker: they already have `sandboxes:delete`.
- The SDK (`sb.delete()`, `stopAndDelete()`, `snapshots.delete()`) sets the header itself from the ID of the already obtained resource. The CLI `umiak rm` sets it after confirmation in a TTY or with `--yes`. Repeating a delete (`deleted`, §8.2) also requires the header.

## 6. Resources and endpoints: summary

Permissions are the scopes from §7.3. Phase is §19 (P = PoC, M = MVP).

| Method and path | What | Scope | S6 / agent | Phase |
|---|---|---|---|---|
| `POST /v1/sandboxes` | create | `sandboxes:write` (+`snapshots:read` with `from`, +`environments:read` with an explicit `environment`; the default environment is applied without it, S8 §10.1) | `create` | P |
| `GET /v1/sandboxes` | list | `sandboxes:read` | `list` | P |
| `GET /v1/sandboxes/{sandbox}` | get, long-poll | `sandboxes:read` | `get`, `waitForState` | P |
| `PATCH /v1/sandboxes/{sandbox}` | name, slug, labels, ttl, idle | `sandboxes:write` | `update`, `rename` | P (slug — M) |
| `DELETE /v1/sandboxes/{sandbox}` | delete (header `Umiak-Confirm-Delete`, §5.12) | `sandboxes:delete` | `delete` | P |
| `POST /v1/sandboxes/{sandbox}/stop` | stop | `sandboxes:write` | `stop` | M |
| `POST /v1/sandboxes/{sandbox}/resume` | resume | `sandboxes:write` | `resume` | M |
| `POST /v1/sandboxes/{sandbox}/fork` | fork | `sandboxes:write` | `fork` | M |
| `POST /v1/sandboxes/{sandbox}/recover` | recover | `sandboxes:write` | `recover` | M |
| `POST /v1/sandboxes/{sandbox}/extend` | extend TTL | `sandboxes:write` | `extend` | M |
| `GET /v1/sandboxes/{sandbox}/env` | env and secret names | `sandboxes:read` | `getEnv` | M |
| `PUT /v1/sandboxes/{sandbox}/env` | replace env/secrets | `sandboxes:write` | `updateEnv` | M |
| `GET /v1/operations/{operation}` | operation, long-poll | `sandboxes:read` | `getOperation` | P |
| `POST /v1/sandboxes/{sandbox}/commands` | sync / stream / detached | `commands:exec` | `createCommand`; `Process/Start`, `Attach` | P |
| `GET /v1/sandboxes/{sandbox}/commands` | list | `commands:read` | `listCommands` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}` | status | `commands:read` | `getCommand`; `Process/Get` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}/stream` | attach NDJSON | `commands:read` | `Process/Attach` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}/output` | a piece of output by offset | `commands:read` | `Process/Attach{follow:false}` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/input` | stdin | `commands:exec` | `Process/SendInput` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/kill` | kill | `commands:exec` | `Process/Kill` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/signal` | signal | `commands:exec` | `Process/Signal` | P |
| `POST /v1/sandboxes/{sandbox}/ptys` | create a PTY | `commands:exec` | `createCommand`; `Process/Start{pty}` | M |
| `GET /v1/sandboxes/{sandbox}/ptys/{command}/connect` | WebSocket | `commands:exec` | `Attach`, `SendInput`, `Update` | M |
| `POST /v1/sandboxes/{sandbox}/ptys/{command}/resize` | window size | `commands:exec` | `Process/Update` | M |
| `GET/HEAD /v1/sandboxes/{sandbox}/files/content` | read, Range | `files:read` | `GET /files` | P |
| `PUT /v1/sandboxes/{sandbox}/files/content` | write as a stream | `files:write` | `PUT /files` | P |
| `POST /v1/sandboxes/{sandbox}/files/uploads` | start an upload | `files:write` | — | M |
| `PUT/HEAD/DELETE /v1/sandboxes/{sandbox}/files/uploads/{upload}` | chunk / offset / cancel | `files:write` | `/files/uploads/*` | M |
| `POST /v1/sandboxes/{sandbox}/files/uploads/{upload}/commit` | finish | `files:write` | `/files/uploads/*/commit` | M |
| `GET /v1/sandboxes/{sandbox}/files/stat` | stat | `files:read` | `Filesystem/Stat` | P |
| `GET /v1/sandboxes/{sandbox}/files/list` | list | `files:read` | `Filesystem/List` | P |
| `POST /v1/sandboxes/{sandbox}/files/mkdir` | mkdir | `files:write` | `Filesystem/MakeDir` | P |
| `POST /v1/sandboxes/{sandbox}/files/move` | move | `files:write` | `Filesystem/Move` | P |
| `POST /v1/sandboxes/{sandbox}/files/chmod` | chmod/chown | `files:write` | `Filesystem/Chmod` | M |
| `GET /v1/sandboxes/{sandbox}/files/archive` | a directory as one tar stream | `files:read` | `GET /files/archive` | M |
| `PUT /v1/sandboxes/{sandbox}/files/archive` | extract a tar stream into a directory | `files:write` | `PUT /files/archive` | M |
| `DELETE /v1/sandboxes/{sandbox}/files` | delete | `files:write` | `Filesystem/Remove` | P |
| `GET /v1/sandboxes/{sandbox}/ports` | published and listening | `sandboxes:read` | `listHostedPorts`, `System/ListPorts` | M |
| `PUT /v1/sandboxes/{sandbox}/ports/{port}` | publish / change mode | `ports:write` | `hostPort` | M |
| `POST /v1/sandboxes/{sandbox}/ports/{port}/rotate-token` | a new token | `ports:write` | `rotatePortToken` | M |
| `DELETE /v1/sandboxes/{sandbox}/ports/{port}` | unpublish | `ports:write` | `unhostPort` | M |
| `GET /v1/sandboxes/{sandbox}/ssh` | how to connect | `ssh:connect` | — | M |
| `POST /v1/sandboxes/{sandbox}/ssh/certificate` | a short-lived SSH certificate (§11.3) | `ssh:connect` | — | M |
| `GET/POST /v1/ssh-keys`, `DELETE /v1/ssh-keys/{key}` | the user's SSH keys (humans only, §7.10) | `ssh:connect` | `IdentityStore` (S8) | M |
| `GET /v1/snapshots`, `GET /v1/snapshots/{name}` | saved snapshots | `snapshots:read` | `listSavedSnapshots`, `getSavedSnapshot` | M |
| `POST /v1/snapshots` | save | `snapshots:write` | `saveSnapshot` | M |
| `DELETE /v1/snapshots/{name}` | delete (`Umiak-Confirm-Delete`, §5.12) | `snapshots:write` | `deleteSavedSnapshot` | M |
| `GET /v1/templates`, `GET /v1/sizes` | catalog | any key | `ConfigReader`, `template_builds` | P |
| `GET /v1/api-keys` | team keys (§7.2) | any member; a key — `keys:admin` | `IdentityStore` | M |
| `POST /v1/api-keys`, `POST /v1/api-keys/{key}/rotate` | issue, rotate | team `owner`, humans only (§7.2) | `IdentityStore` | M |
| `DELETE /v1/api-keys/{key}` | revoke | `owner`, operator; a key — `keys:admin` | `IdentityStore` | M |
| `DELETE /v1/api-keys/self` | a key revokes itself (`umiak logout --revoke`) | any key | `IdentityStore` | M |
| `GET /v1/me` | who am I | any | — | P |
| `GET /v1/limits` | quotas, remainder, allowed templates and sizes | any | `usage` | M |
| `/v1/environments` (S8 §10.2) | team environments | `environments:read` / `environments:write` | `EnvironmentService` (S8) | M |
| `GET /v1/meta` | platform: domains, SSH host keys, versions | no auth | — | P |

## 7. Authentication and permissions [decision Q2; the login model — Ilia's decision 2026-10-29: Keycloak, offboarding option A]

Two kinds of bearer on the public listener: a **Keycloak JWT** — people in the CLI, SDK, and local MCP (§7.6, §7.10), people have no long-lived personal keys; a **team key `umiak_`** — automation and CI (§7.2). The browser goes through oauth2-proxy (§7.4). The IdP is Keycloak, realm `umiak` (architecture §10).

### 7.1 Three listeners

| Listener | Accepts | Does not accept |
|---|---|---|
| public `:8080` (`api.<domain>`) | `Authorization: Bearer <Keycloak access token>` (§7.10) or `Authorization: Bearer umiak_...` (§7.2); without auth — only `/v1/meta`, `/v1/openapi.json`, `/v1/docs` | The headers `X-Auth-Request-*`, `X-Forwarded-User`, `X-Forwarded-Email` are stripped before any processing. Cookies are ignored |
| proxied `:8081` (`app.<domain>` through oauth2-proxy) | The oauth2-proxy headers `X-Auth-Request-Email` (required), `-User`, `-Groups`, `-Preferred-Username` | `Authorization: Bearer` (not needed on this host, `400`). A request without `X-Auth-Request-Email` is `401` |
| internal `:8082` (ClusterIP) | the gateway's `Authorization: Bearer <service-token>` | Everything else |

- The oauth2-proxy headers can be trusted only because only oauth2-proxy is allowed to reach `:8081` (NetworkPolicy S12), and on `:8080` they are stripped. This is anti-goal #4, with a separate test (§16).
- The client IP for logs and limits comes from `X-Forwarded-For` only from addresses in `UMIAK_API_TRUSTED_PROXY_CIDRS` (ingress), otherwise the connection address. (In the implementation — for the log only, limits are counted by principal, §23.3.)

### 7.2 Team API keys (`umiak_`)

- **Secret format:** `umiak_` + 43 base62 characters (32 random bytes) + 6 base62 characters of CRC32 of the preceding part. The CRC lets secret scanners (GitHub secret scanning with its own pattern, gitleaks) tell a key from a random string without contacting the server. The regular expression for scanners: `\bumiak_[0-9A-Za-z]{49}\b`.
- **Storage:** only `sha256(secret)` in hex (a unique index); high entropy, a slow hash is not needed. For display — `prefix` (the first 8 characters after `umiak_`) and `last4`. The `api-keys` collection in Payload (S8, fields — §17.3).
- **Verification:** `sha256` → the pod's in-memory cache (positive 30 s, negative 5 s) → `IdentityStore.findApiKeyByHash`. The cache is reset by `LISTEN umiak_identity` (S8 sends `NOTIFY` when a key changes; `api` sends it itself on revocation). A revoked key stops working on all pods within 30 s at most, usually immediately.
- **Lifetime:** 90 days by default, maximum 365 [S7 decision]; there are no keys without expiry. Once `expiresAt` has passed — `401 api_key_expired`.
- `lastUsedAt` is updated no more than once per 60 s per key.
- **A key belongs to a team, not a person.** It is issued and rotated by the team's `owner` — a person in a browser session (the dashboard) or with a Keycloak JWT (`umiak keys create`, the same API) (otherwise `403 forbidden`, `details.reason: "role"` or `"user_required"`); a key does not issue keys. The creator is recorded in `createdBy` for audit only. The creator leaving the team or being deactivated (S8 §20.1) does **not** disable the key: it is revoked by the team's `owner`s, an operator (revoke only), a key with `keys:admin`, or the key itself (`DELETE /v1/api-keys/self`). Deleting a team revokes all its keys (S8 §6.4).
- The secret is shown once: in the response of `POST /api-keys` and `rotate`.
- **Key type** (`kind`): `team` — a team key, everything above; `sandbox` — **reserved, not implemented in the MVP**. A `sandbox` key will be bound to one sandbox (`sandboxId`), with the secret `umiaks_` + the same format (the regular expression for scanners — `\bumiaks?_[0-9A-Za-z]{49}\b`), and is meant for the CLI inside a VM: it sees only its own sandbox, with scopes no wider than the `sandbox-self` preset (§7.3) and no wider than the creator's rights. In the MVP the schema has the fields `kind` (always `team`) and `sandboxId` (always `null`); `POST /api-keys` with `kind: "sandbox"` → `400 validation`. Issuing, delivery into the VM, and revocation on sandbox delete are phase 2 (S24).

### 7.3 Scopes and presets

A scope is a "resource × action" pair of the form `<resource>:<action>`. The set of scopes is part of the v1 contract: new ones may be added, existing ones are not renamed and not widened in meaning.

| Scope | What it allows |
|---|---|
| `sandboxes:read` | get, list, long-poll, operations, env (env values and secret names), ports list |
| `sandboxes:write` | create, update, stop, resume, fork, recover, extend, `PUT /env` |
| `sandboxes:delete` | delete |
| `commands:read` | list and status of commands, attach, output by offset |
| `commands:exec` | start commands and PTYs, input, kill, signal, resize |
| `files:read` / `files:write` | read / change files, directory archive (§11.1) |
| `ports:write` | publishing ports, modes, tokens |
| `ssh:connect` | the SSH certificate (§11.3), the user's SSH keys, and `GET /sandboxes/{sandbox}/ssh` |
| `snapshots:read` / `snapshots:write` | saved snapshots: list and create from them / saving and deleting |
| `environments:read` / `environments:write` | team environments (S8 §10.2): list and env values / create, change, delete |
| `keys:admin` | team keys only: list the team's keys and revoke them. For people there is a role instead of a scope: all members see the list, `owner` and operator revoke, only `owner` issues and rotates (§7.2) |

`/me`, `/limits`, `/templates`, `/sizes`, `DELETE /api-keys/self` are available to any valid key.

| Preset | Scopes |
|---|---|
| `read-only` | `sandboxes:read`, `commands:read`, `files:read`, `snapshots:read`, `environments:read` |
| `ci` | `sandboxes:read`, `sandboxes:write`, `sandboxes:delete`, `commands:read`, `commands:exec`, `files:read`, `files:write`, `ports:write`, `snapshots:read`, `environments:read` |
| `full` | all scopes |
| `sandbox-self` | reserved for `sandbox` keys (§7.2): `sandboxes:read`, `commands:read`, `commands:exec`, `files:read`, `files:write`, `ports:write` within its own sandbox |

- A person (a browser session or a Keycloak JWT) has all scopes within their role (§7.5). A key's scopes are chosen by the `owner` at issue time; a key cannot issue keys, so a subset rule is not needed.
- A missing scope is `403 forbidden`, `details.requiredScope`.
- An unknown scope is `400 validation`. Every key has an expiry (§7.2).
- Restricting a team key to specific sandboxes, environments, or labels comes later (§19); the "one sandbox" case is covered by the `sandbox` type (§7.2).

### 7.4 Browser: the proxied listener

- `IdentityStore.resolveSession(headers)` (implemented by S8): from the oauth2-proxy headers it finds or creates a JIT user, and returns the user, their teams with roles, and the operator flag (from IdP groups). The result is cached in the pod for 30 s by email; reset by `LISTEN umiak_identity`.
- The request's team is the header `Umiak-Team: team_...`; without it — the user's default team (S8). A team not in the user's list is `403 team_forbidden`. An operator may specify any team.
- A session has all scopes. Role restrictions inside a team belong to S8 (S7 passes the role in `Principal`).
- **CSRF.** For unsafe methods and for WebSocket upgrade the `Origin` header is required and equals `UMIAK_APP_ORIGIN` (`https://app.<domain>`), otherwise `403 origin_forbidden`. JSON bodies are accepted only with `Content-Type: application/json` (a plain HTML form will not send it).
- The oauth2-proxy cookie is `__Host-` on `app.<domain>` (architecture §10, S4 §14.1); `api` sets no cookies of its own.

### 7.5 Principal

`api` passes to `SandboxService` (S6 §5.11):

```ts
interface Principal {
  kind: "session" | "oidc" | "team_key" // browser, Keycloak JWT (§7.10), team key (§7.2)
  userId: string | null    // Payload user id; null for team keys
  teamId: string
  role: "owner" | "member" | null // team role from S8; null for team keys
  isOperator: boolean     // platform operator (IdP group, S8); browser sessions only
  apiKeyId?: string       // team keys only
  scopes: Scope[]
}
```

Access to a sandbox: a sandbox belongs to a team; any team member and any team key have access to it within scopes [S7 decision, as S4 §9.2 recommends]. A sandbox of another team is `404 not_found`. The S8 `owner` role checks (for example, `environments:write`) are replaced for a team key by the presence of the scope: the key is issued by an `owner`, who chooses the scopes. Endpoints that need a human (the user's SSH keys, issuing keys) answer a team key with `403 forbidden` and `details.reason: "user_required"`.

### 7.6 `umiak login`

**People: OAuth 2.0 Device Authorization Grant (RFC 8628) in Keycloak** [Ilia's decision 2026-10-29]. `api` has no login pages of its own.
1. The CLI takes the block `oidc {issuer, clientId: "umiak-cli", audience: "umiak-api"}` from `GET /v1/meta` and calls `POST {issuer}/protocol/openid-connect/auth/device` (`client_id=umiak-cli`, `scope=openid`; a public client, no secret). The response: `device_code`, `user_code`, `verification_uri` (`{issuer}/device`), `verification_uri_complete`, `expires_in` (600), `interval` (5).
2. The CLI prints the code and the link and, if there is a browser, opens `verification_uri_complete` (`--no-browser` — only print). The person signs in to Keycloak (or is already signed in) and confirms.
3. The CLI polls the token endpoint (`grant_type=urn:ietf:params:oauth:grant-type:device_code`), handling `authorization_pending`, `slow_down`, `expired_token`, `access_denied`. The result is an access token (5 min), a refresh token, an ID token (the CLI does not store it).
4. The CLI calls `GET /v1/me` (JIT of the user by JWT, §7.10), shows the user and the default team; `--team` or `UMIAK_TEAM` choose another.

**Storage.** The refresh token and the current access token are in the OS store through `Bun.secrets` (macOS Keychain, libsecret, Windows Credential Manager with `persist: "local"`), an entry `service: "umiak"`, `name: "<profile>@<issuer>"`. If the store is unavailable (Linux without a secret service, a container), a file `$XDG_CONFIG_HOME/umiak/credentials.json` with permissions `0600` and a warning; `--credential-store keychain|file` chooses explicitly. There are no secrets in `config.json`.

**Refresh.** The access token is used until `exp − 30 s` (in the implementation `exp − 90 s`, §23.7), then `grant_type=refresh_token`. Parallel processes refresh under a file lock (`$XDG_CONFIG_HOME/umiak/.lock`), the second reads the already refreshed token. The refresh is bound to the Keycloak SSO session (lifetimes — architecture §10): if the session ended or the user is disabled or deleted, Keycloak answers `invalid_grant`, the CLI prints "sign in again: `umiak login`" and exits with code `4`. So a person disabled in Keycloak loses the CLI, SDK, and MCP no later than the access token lifetime (5 min), and after the S8 §20.1 sync `api` also rejects not-yet-expired tokens.

**The SDK and local MCP use the CLI credentials.** `umiak auth token [--json]` prints the current profile's active bearer — an access token (refreshing it if needed) or the key saved by `--key-stdin` — or exits with code `4`. `--json` → `{kind: "oidc" | "key", token, expiresAt, apiUrl, team}`: the SDK takes the profile's `apiUrl` and `team` if they are not set explicitly, and will not send the token to another API. The chain in the TS and Python SDKs (§15.2): explicit `apiKey` / `accessToken` / `tokenProvider` → `UMIAK_API_KEY` → `UMIAK_ACCESS_TOKEN` → `umiak auth token --json` (if `umiak` is in `PATH`); the token is cached in the process until `exp − 60 s`, on `401 token_expired` the SDK gets a new one once and repeats the request. The local stdio MCP (S11) works through the SDK and gets the same. The SDK does no refresh of its own: the CLI owns storage and refresh.

**Automation: `--key-stdin`.** `echo "$UMIAK_API_KEY" | umiak login --key-stdin` verifies the team key through `/v1/me` and puts it into the same store. `UMIAK_API_KEY` in env takes priority over the saved login. This is the login for agents, CI, and the CLI inside a VM.

`umiak logout` for a Keycloak login revokes the refresh token (`POST {issuer}/protocol/openid-connect/revoke`, `token_type_hint=refresh_token`) and erases the entry; for a key it only erases the entry, and `--revoke` also calls `DELETE /v1/api-keys/self` (the key is shared by the team, so we do not revoke it by default).

### 7.7 SSO for ports (S4 §8.4)

`GET https://app.<domain>/umiak-auth/authorize?label=&state=` on the proxied listener:
1. `label` passes the S4 §4.2 grammar; the route exists, `access = sso`, not `blocked` (otherwise — an HTML error page, no redirect).
2. Policy: let in any signed-in platform user (as agreed in S4). The switch `PlatformDefaults.ssoPortPolicy = any | team` (S8) [S7 decision]; `team` lets in only members of the sandbox's team and operators.
3. The code: 32 random bytes, in `port_auth_codes` (§12.2) — `sha256`, `label`, `userId`, `email`, `authEpoch`, lifetime 60 s.
4. `302` to `https://<label>.<umiak-domain>/__umiak/auth/callback?code=…&state=…`; the host is built from the label, not taken from the request.

The code exchange is §12.1.

### 7.8 Internal calls

Service tokens per S2 §5.5: the file `UMIAK_API_SERVICE_TOKENS_FILE` — `{ "gateway": ["<t1>", "<t2>"] }` (accepted ones) and the token with which `api` itself calls the gateway's internal listener (`agent-client`). Comparison is constant-time.

### 7.9 PoC before S8

`IdentityStore` has a static implementation `StaticIdentityStore` (`packages/auth`) from YAML (`UMIAK_IDENTITY_FILE`): users, teams, API keys (`sha256` only), SSH keys. The proxied listener is off in the PoC. (In the implementation, instead — `PgIdentityStore` loading the same YAML, the proxied listener on, §23.10.) Without `UMIAK_OIDC_ISSUER` JWTs are not accepted: Keycloak is optional in the PoC. `umiak-admin` (S6 §15.3) gets the command `api-key hash` to generate a key and the YAML line.

### 7.10 Keycloak JWT

- **Which bearer.** If it starts with `umiak_` it is a team key (§7.2); `umiaks_` is reserved; otherwise it must be a compact JWS (three base64url parts), otherwise `401 unauthorized`.
- **Verification in `api`, with no introspection per request:** the signature with a key from JWKS (`jwks_uri` from `{issuer}/.well-known/openid-configuration`), the algorithm from the list `RS256`, `ES256` (`none` and `HS*` are refused); `iss` equals `UMIAK_OIDC_ISSUER` (`https://<keycloak>/realms/umiak`); `aud` contains `umiak-api` (`UMIAK_OIDC_AUDIENCE`); `exp`, `nbf`, `iat` with a tolerance of 60 s; the claim `typ` = `Bearer` (so ID tokens and refresh tokens do not pass); `azp` from `UMIAK_OIDC_ALLOWED_CLIENTS` (by default `umiak-cli`, `umiak-mcp` — login to the remote MCP through the browser, S11 §6.4); `email_verified = true`. The library is `jose` (`createRemoteJWKSet`, `jwtVerify`).
- **Addresses.** `iss` is compared with the public `UMIAK_OIDC_ISSUER`; `api` may fetch discovery and JWKS from an internal address (`UMIAK_OIDC_DISCOVERY_URL`, by default derived from the issuer) if the public Keycloak name is unreachable from the cluster.
- **JWKS** is cached in the pod: refreshed every 10 min and on an unknown `kid` (no more than once per 30 s). If Keycloak is unavailable, the key cache keeps working, and tokens are verified offline.
- **The same identity as in the browser.** The token's `sub` is the same claim that oauth2-proxy sends in `X-Auth-Request-User` (S8 §5.1). `api` calls `IdentityStore.resolveSession({email, user: sub, groups, preferredUsername})` from the claims `email`, `sub`, `groups`, `preferred_username`: JIT, binding to `idpSubject`, a 30 s cache — as for the browser (S8 §5.3). A deactivated user (`active: false`, including by the S8 §20.1 sync) gets `403 forbidden` with `details.reason: "user_disabled"`, even if the token has not expired.
- **Principal:** `kind: "oidc"`, all scopes within the role, the team is `Umiak-Team` or the default team (`403 team_forbidden`, as in §7.4), `isOperator: false` (operator rights only in the browser, S8 §5.5).
- **Errors:** an expired token is `401 token_expired` (the client refreshes the token and repeats); a failed signature, `iss`, `aud`, `typ`, `azp`, algorithm, or format is `401 unauthorized` with `details.reason: "invalid_token"`. Always the header `WWW-Authenticate: Bearer realm="umiak", error="invalid_token"` (RFC 6750).
- **Long connections.** An NDJSON stream and a PTY WebSocket check the bearer on open and live beyond the token's or key's `exp`; they are closed by the open-connection registry on user deactivation, removal from the team, and key revocation (S8 C9). This is an accepted assumption: streams reconnect every 60 min anyway (§9.7), and a reconnect requires a valid bearer; a PTY without a client closes after 10 min. A Keycloak logout without deactivation does not close open connections.

## 8. Sandboxes and operations

### 8.1 The Sandbox resource

```json
{
  "id": "sb_01jbx4q3m7f8r2t6v9w0y1z2a3",
  "slug": "quiet-otter-lamp",
  "name": "ci-run-42",
  "teamId": "team_...",
  "createdBy": "usr_...",
  "createdByKey": null,
  "template": "linux",
  "templateVersion": "2026.10.29-1",
  "size": "2gb",
  "vcpu": 2,
  "memoryMb": 2048,
  "state": "ready",
  "health": "ok",
  "healthReason": null,
  "degradedSince": null,
  "activity": "busy",
  "lastActivityAt": "2026-10-29T12:03:11.000Z",
  "stopReason": null,
  "error": null,
  "origin": { "kind": "template" },
  "labels": { "session": "42" },
  "ttlSeconds": null,
  "deadlineAt": null,
  "idleTimeoutSeconds": 900,
  "activeOperation": null,
  "endpoints": {
    "portUrlTemplate": "https://quiet-otter-lamp-{port}.umiak.example.com",
    "ssh": "ssh quiet-otter-lamp@ssh.example.com"
  },
  "createdAt": "...", "readyAt": "...", "stoppedAt": null, "deletedAt": null, "updatedAt": "..."
}
```

- `state` — the S6 states as is: `creating`, `ready`, `stopping`, `stopped`, `starting`, `error`, `deleting`, `deleted`. "Can work" = `state == "ready"`; with `health == "degraded"` agent calls wait up to 30 s and give `503 agent_unavailable`.
- `origin`: `{kind: "template"}` | `{kind: "snapshot", snapshot: "<name>", snapshotId}` | `{kind: "fork", sandboxId}`.
- `error`: `{code, message}` from S6 (`create_failed`, `resume_failed`, `machine_lost`, ...).
- `activeOperation` — an operation (§8.4) or `null`.
- `createdBy` — a user (session or JWT), or `null` if a team key created it; then `createdByKey: "key_..."`. The same for Command (§9.6).
- `environment` (`{id, name, revision}` or `null`) and `excludeOwnerSecrets` — S8 §10. (In the MVP `environment` is always `null`, `excludeOwnerSecrets` is `false`, §23.6.)
- The `deleted` tombstone is served by `GET` for 30 days (S6 §5.6), then `404`. In a list `deleted` appears only with an explicit `state=deleted`.

### 8.2 Endpoints

**`POST /v1/sandboxes`** (`Idempotency-Key`):

```json
{
  "template": "linux",
  "size": "2gb",
  "name": "ci-run-42",
  "slug": "my-box",
  "labels": { "session": "42" },
  "env": { "NODE_ENV": "test" },
  "secrets": { "ANTHROPIC_API_KEY": "sk-..." },
  "secretFiles": [{ "name": "gcp.json", "contentBase64": "...", "mode": 288, "linkPath": "/home/user/.config/gcloud/key.json" }],
  "ttlSeconds": 3600,
  "idleTimeoutSeconds": 900,
  "from": { "snapshot": "web-stack" },
  "environment": "base",
  "excludeOwnerSecrets": false,
  "failFast": false
}
```

All fields are optional. `template` defaults to `PlatformDefaults` (S8; in the PoC `linux`), `size` to the template's `defaultSize`. With `from` the `template` field is ignored (taken from the snapshot). `environment` and `excludeOwnerSecrets` — S8 §10. The response is `202 {sandbox, operation}`.

The `failFast` field in the example is **phase 2, outside the public MVP contract (Ilia's decision 2026-10-29)**: it is not in the MVP schema, and `failFast` in the body is `400 validation` (an unknown field). `excludeOwnerSecrets: true` in the MVP is `400 validation` (§23.6).

**`failFast: true`** (phase 2, outside the public MVP contract, Ilia's decision 2026-10-29) — the warm pool only (S6 §7.3). If a `warm` machine of the (template, size) pair exists — an ordinary claim. If not — `503 pool_exhausted` (`retryable: true`, `Retry-After` and `details.retryAfterSeconds` are an estimate of pool replenishment): no sandbox, operation, or `Idempotency-Key` record is created, and repeating with the same key is safe. A cold start and evicting warm machines of other pairs do not apply. With `from` → `400 validation` (create from a snapshot is always cold, S6 §7.3). The template and quota checks come earlier, so `quota_exceeded` and `template_unavailable` are returned as usual. How many warm machines exist now is in `GET /v1/limits` (§13); it is a hint, not a reservation.

**`GET /v1/sandboxes`**: filters `state` (comma-separated), `label=k=v` (repeatable, AND), `template`, `q` (prefix of name or slug); newest first.

**`PATCH /v1/sandboxes/{sandbox}`**: `name`, `slug` (M), `labels` (full replacement), `ttlSeconds` (`deadlineAt = now + ttl`, `null` removes the TTL), `idleTimeoutSeconds`. The response is `200 Sandbox`.

**Actions** (the response is `202 {sandbox, operation}`):
- `POST /stop`;
- `POST /resume {size?, ttlSeconds?, env?, secrets?, secretFiles?}`;
- `POST /fork {name?, slug?, labels?, ttlSeconds?, idleTimeoutSeconds?, size?, forceStop?, env?, secrets?, secretFiles?}` (`Idempotency-Key`): the response is `{sandbox: <new>, operation: <create of the target>, sourceOperation: <fork on the source>}`. A running Windows sandbox is forked only from a stopped VM (S9 §24.8): without `forceStop: true` — `409 snapshot_requires_stop` with a hint; with it, the fork on the source stops it (an ordinary stop: PrepareStop, erasing secret files; commands, PTYs, and sessions are interrupted), takes the snapshot (`consistency: powered_off`), starts the source again, and only then hands the snapshot to the target. `sourceOperation.forceStop` reports the restart outcome (§8.4). Linux is snapshotted live and ignores the flag; a stopped source too;
- `POST /recover`;
- `DELETE /v1/sandboxes/{sandbox}` → `202 {sandbox, operation}`; on `deleted` → `200 {sandbox, operation: null}`.
- `POST /extend {ttlSeconds?}` → `200 Sandbox` (without an operation, S6 §7.8).

**Repeat during an active operation.** If S6 returned `operation_in_progress` and the active operation is of the same kind (`stop`, `resume`, `recover`, `delete`), `api` answers `202` with that operation. A different kind is `409 operation_in_progress`. For `resume` and `recover` this is an addition to S6 (§20.2). `resume` returns the active `resume` only if the hash of the canonical body matches (an empty body is also a body; S6 §7.6); otherwise `409 operation_in_progress`.

**Env and secrets on fork and resume.** `env`, `secrets`, `secretFiles` follow the same rules, limits, and encryption as create (§8.3), but the shape is as in `PATCH /env` (S8 C2): `env` and `secrets` are `{K: v | null}`, `secretFiles` is `{<name>: {contentBase64, mode?, linkPath?} | null}`; the OpenAPI schema is shared with `PATCH /env`. The sets are layered by key over the inherited ones (fork — a copy of the source's sets, resume — the sandbox's own sets): the same key — the request wins, secret files — by name, `null` removes the key. Limits are checked on the result. For resume the result is saved in the sandbox (like `PUT /env`), even if the resume then failed; for fork only the target changes, the source is untouched.

### 8.3 Env and secrets

Three sets, with different fates in the guest (S3 §8.1–8.2):

| API field | In S3 | Where it lives in the guest | Fork | Create from a saved snapshot |
|---|---|---|---|---|
| `env` | `ClaimRequest.env` | `/etc/umiak/env` and `state.db` (disk) | yes (S6 copies the source's set) | no |
| `secrets` | `secret_env` | tmpfs, anew after each boot | yes (S6 re-encrypts) | no |
| `secretFiles` | `secret_files` | tmpfs, `linkPath` is a symlink on disk | yes | no |

- **Create from a saved snapshot** carries over only the source's disk (files, packages, shell history). The source's env, secrets, and secret files are not carried over: on first boot the agent sees a new identity and erases `state.db` with the claim and `/etc/umiak/env` (S3 §7.2), and the new sandbox's sets come from the create request and the environment (S8 §10), as for create from a template. A snapshot is a disk image, not a copy of a sandbox; secrets are not stored on disk, and a snapshot shared in a team must not hand out someone else's secrets. Decision 2026-10-31 (branch `fix-resume-sshca`): this is by design. If you need the source's sets — fork, or explicit `env`/`secrets` in create.

- The sets are accepted by create, fork and resume (§8.2), `PUT /env`, and environments (S8 §10).
- Limits: up to 100 variables per set; key `[A-Za-z_][A-Za-z0-9_]{0,127}`; value up to 32 KiB with no NUL; up to 256 KiB total per set. The prefix `UMIAK_` is reserved (`400 validation`), except for the `umiak` CLI variables (§14.1): `UMIAK_API_KEY`, `UMIAK_API_URL`, `UMIAK_TEAM`, `UMIAK_PROFILE` — this is how the CLI inside a VM gets its key as a sandbox secret (S5 §8.9). Values with a newline are not visible in SSH sessions (S3 §8.2) — this is stated in the field description.
- `secretFiles`: up to 32 files, each up to 1 MiB, up to 8 MiB total (S3), name `[A-Za-z0-9._-]{1,128}`, `mode` defaults to `0440`, `linkPath` is an absolute path.
- **`GET /env`** → `{env: {k: v}, secretKeys: [...], secretFiles: [{name, mode, linkPath, sizeBytes}]}`. Secret values are never returned.
- **`PATCH /env`** (S8 C2, merge: `{K: v | null}`, `null` removes) — exists in the implementation next to `PUT` (§23.6).
- **`PUT /env {env?, secrets?, secretFiles?}`** — each passed field replaces its set entirely, a field not passed is unchanged. The response is `200 {delivered: bool}` + the same as `GET`. New commands see the new values; already running ones do not. `delivered: false` means the sandbox is not `ready` or the agent is unavailable: S6 will deliver the set on the next resume/reprovision. The S6 method `updateEnv` is an addition (§20.2).
- Env and secret values go into the idempotency hash but are stored nowhere except `sandbox_secrets` (S6 §13.1). The `api` logger strips the fields `env`, `secrets`, `secretFiles`.

### 8.4 The Operation resource

```json
{
  "id": "op_...", "sandboxId": "sb_...",
  "kind": "create",
  "state": "running",
  "step": "claim",
  "error": null,
  "createdAt": "...", "startedAt": "...", "finishedAt": null
}
```

`kind`: `create | fork | stop | resume | recover | delete | save_snapshot` (internal `reprovision` is not exposed; in `activeOperation` it appears as `null`). `state`: `pending | running | succeeded | failed | superseded`. `error`: `{code, message, retryable}`. `step` is for debugging, its values are not part of the contract.

`forceStop` (S9 §24.8): `null`, except for fork and save_snapshot accepted with `forceStop: true` for a running Windows sandbox: `{sourceStopped, sourceRestarted, restartError}`. `sourceStopped` — the source was stopped by this operation; `sourceRestarted` — `true` after the start, `null` until it gets there, `false` — the start failed: the operation is still `succeeded` (the snapshot is intact, the fork continues), and the source is in `error` with `resume_failed` (`restartError {code, message}`), to be brought up with an ordinary `resume`. If the operation failed before the snapshot, the source is started again by its compensation; a guest that did not shut down within 300 s gives `error {code: "shutdown_timeout", retryable: true}` without a snapshot (S9 §24.9).

## 9. Commands

### 9.1 Starting: `POST /v1/sandboxes/{sandbox}/commands`

```json
{
  "command": "npm test",
  "argv": null,
  "mode": "sync",
  "cwd": "my-app",
  "env": { "CI": "1" },
  "user": "user",
  "stdin": false,
  "timeoutSeconds": 600,
  "encoding": "utf8",
  "tags": { "step": "test" }
}
```

- Exactly one of `command` (a string for `bash -lc`, on Windows — PowerShell, S9) or `argv` (an array, no shell).
- `mode`: `sync` (default) | `stream` | `detached`.
- `timeoutSeconds` — the **process** timeout, enforced by the agent's shim (status `timed_out`). For `sync` the default is 60, the maximum 600: a sync request always finishes. For `stream` and `detached` the default is `null` (no timeout).
- `cwd` defaults to the user's home directory; a relative path is from it. `user` defaults to `user`; `root` is allowed (the trust boundary is the VM, S2 §16).
- The command's `env` is not stored (S6 stores only the names).
- `encoding` — how to return output: `utf8` (default) or `base64` (§9.5).
- `Idempotency-Key` — §5.7. The SDK always passes it.

**Order in `api`:**
1. Check the scope and body. `touchApiActivity`.
2. Resolve the sandbox. If `creating`/`starting` — wait for `ready` up to 60 s (`waitForState`), then `409 sandbox_starting` (retryable). If `stopping`/`stopped`/`error`/`deleting` — `409 sandbox_not_ready` with `details.state`; `deleted` — `404`.
3. `resolveAgentTarget` → `machineId`, capabilities. `process.v1` is needed (and `process.stdin` with `stdin: true`), otherwise `409 agent_outdated`.
4. Idempotency: by `Idempotency-Key` find an already created command (§9.3) or create a `commands` row (`createCommand`, ULID, status `starting`).
5. `Process/Start(commandId, spec)` through `agent-client` (retries and waiting for the agent up to 30 s are inside the client). After the response the status is `running`.
6. Then by `mode` (§9.2).

**If `Start` did not succeed.** `agent-client` returned `agent_unavailable` — so it is unknown whether `Start` reached the agent. With an `Idempotency-Key` the response is `503 agent_unavailable` (`retryable: true`, `details.commandId`): repeating with the same key starts the command at most once. Without a key — `503 agent_unavailable` with `retryable: false`, `details {commandId, outcome: "unknown"}`; the client can check `GET /commands/{commandId}`. Agent `invalid_argument` errors → `400 validation`; `too_many_commands` → `409 invalid_state` (`details.reason`).

### 9.2 Modes

**`sync`** → `200`:

```json
{
  "command": { "...": "Command resource, §9.6" },
  "stdout": "...", "stderr": "...",
  "stdoutTruncated": false, "stderrTruncated": false,
  "stdoutFrom": 0, "stderrFrom": 0
}
```

`api` reads `Attach` until `exit` and collects the output. The response carries the **tail** of at most 4 MiB per stream [S7 decision]: usually the error is visible at the end. `stdoutFrom` is the offset of the start of the returned piece; if `stdoutTruncated`, the start is read through `/output` (§9.4). If the HTTP client disconnected earlier, the command keeps running (its timeout is at most 600 s).

**Silence in sync** [S7 decision]. Until the process exits, a sync response sends nothing, and proxies on the way (ingress, oauth2-proxy, the client's corporate proxies) may cut a silent connection. So:
- S12 sets the ingress read timeouts and oauth2-proxy `--upstream-timeout` to no less than 660 s (§17.6);
- The SDK, CLI, and MCP **do not use** a long raw sync: the `exec()` helper sends `mode: stream` and assembles the result itself into the same shape as sync (`run` without iteration). Raw `mode: sync` remains for curl and simple clients, and its OpenAPI description warns about proxies.

**`stream`** → `200`, `Content-Type: application/x-ndjson`, headers `Umiak-Command-Id`, `Cache-Control: no-store`, `X-Accel-Buffering: no`. The frames are in §9.5. Status `200` is fixed only after a successful `Start`; anything that happens later arrives as frames.

**`detached`** → `201 Command` right after `Start`. Output goes through `/stream` or `/output`.

### 9.3 Repeat with `Idempotency-Key`

The key is matched to a `commandId` (scope `commands.create`, S6 `idempotency_keys`). A repeat with the same body:
- `sync` — attaches to the same command and waits for its exit (if the output is still on the agent, the same result);
- `stream` — the stream of the same command from offset 0, in the `started` frame the field `replayed: true`;
- `detached` — `200 Command`.

So the SDK can repeat any `POST /commands` after a network break, a `503`, or an `api` pod stop, and the command starts once.

### 9.4 Attach, output, control

- **`GET .../commands/{command}/stream?stdoutOffset=&stderrOffset=&ptyOffset=&tailBytes=&follow=true&encoding=utf8`** — NDJSON, the first frame is `attached`. `tailBytes` starts each stream at `max(availableFrom, size − tailBytes)`. `follow=false` returns what exists and closes the stream (`exit`, if the command has finished).
- **`GET .../commands/{command}/output?stream=stdout&offset=0&limit=1048576`** — raw bytes of one stream (`application/octet-stream`, `limit` up to 4 MiB), headers `Umiak-Offset`, `Umiak-Next-Offset`, `Umiak-Available-From`, `Umiak-Stream-End` (only if the stream has ended). If `offset < availableFrom`, reading starts at `availableFrom` with the header `Umiak-Truncated: true`. This is the endpoint for polling without streams (MCP, simple scripts).
- **`POST .../input {data, encoding: "utf8"|"base64", closeStdin?, sessionId?, seq?}`** → `204`. With `sessionId` + `seq` a repeat is deduplicated by the agent (S2 §9.3); without them `api` uses a new `sessionId` per request. For a PTY `closeStdin` does not apply (EOF is the byte `^D`).
- **`POST .../kill {graceMs?}`** (default 10 000) → `200 Command`. **`POST .../signal {signal}`** (`SIGINT`, `SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGUSR1`, `SIGUSR2`, `SIGQUIT`) → `200 Command`. Both are idempotent.
- **`GET .../commands/{command}`** → `Command`; if the sandbox is `ready`, the live fields (`pid`, stream sizes) come from `Process/Get`, otherwise from the DB.
- **`GET .../commands?status=running&mode=&limit=&cursor=`** → a list from `commands` (S6, kept 90 days), works with a stopped sandbox too. The output of a stopped sandbox is unavailable (it is in the VM) — `409 sandbox_not_ready`.

### 9.5 NDJSON frames

One JSON object per line, `\n`, flush after each frame.

| `type` | Fields | When |
|---|---|---|
| `started` | `commandId`, `pid`, `encoding`, `replayed?` | the first frame in `mode: stream` |
| `attached` | `commandId`, `stdoutOffset`, `stderrOffset`, `ptyOffset?`, `encoding` | the first frame in `/stream` |
| `stdout` / `stderr` / `pty` | `offset`, `nextOffset`, `data` | output |
| `truncated` | `stream`, `availableFrom` | the requested offset was evicted by the agent's retention (S3 §10) |
| `heartbeat` | — | after 15 s of silence |
| `reconnect` | `stdoutOffset`, `stderrOffset`, `ptyOffset?`, `reason: "max_duration" \| "server_shutdown"` | the last frame; the client immediately opens `/stream` with these offsets |
| `exit` | `status`, `exitCode`, `signal`, `reason`, `stdoutOffset`, `stderrOffset`, `ptyOffset?` | the last frame; arrives only after all output up to these offsets |
| `error` | `code`, `message`, `retryable`, `requestId`, `stdoutOffset`, `stderrOffset`, `ptyOffset?` | the last frame; with `retryable` the client opens `/stream` with these offsets |

- `status` in `exit`: `exited | killed | timed_out | lost | failed_to_start` (S6 §5.8; S3 `reason TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`). `reason` is the S3 value in lowercase (`none`, `signal`, `timeout`, `oom`, `pty_idle`, `reboot`, `shim_lost`, `start_failed`).
- **Encoding.** `base64`: `data` is base64 of exactly the bytes `[offset, nextOffset)`. `utf8`: `api` decodes each stream with a streaming UTF-8 decoder; an incomplete multibyte sequence at the end of a chunk (up to 3 bytes) is held back until the next chunk, so `nextOffset` always sits on a character boundary and a repeated attach from `nextOffset` does not split a character. Invalid bytes are replaced with U+FFFD, and offsets are counted over the original bytes. Use `base64` for binary output.
- Empty chunks are not sent. A frame's `offset` equals the previous frame's `nextOffset` of the same stream, except right after `truncated`.

### 9.6 The Command resource

```json
{
  "id": "cmd_01jbx...", "sandboxId": "sb_...",
  "mode": "stream",
  "command": "npm test", "argv": null,
  "cwd": "/home/user/my-app", "user": "user",
  "envKeys": ["CI"], "tags": { "step": "test" },
  "timeoutSeconds": 600,
  "status": "running",
  "exitCode": null, "signal": null, "reason": null,
  "pid": 4242,
  "streams": {
    "stdout": { "sizeBytes": 18234, "availableFromBytes": 0, "endBytes": null },
    "stderr": { "sizeBytes": 120, "availableFromBytes": 0, "endBytes": null }
  },
  "createdBy": "usr_...",
  "createdAt": "...", "startedAt": "...", "endedAt": null
}
```

`mode`: `sync | stream | detached | pty`. `status`: `starting | running | exited | killed | timed_out | lost | failed_to_start`. The terminal status in the DB is written by `api` on the `exit` frame (`completeCommand`) or by the S6 event handler on `command.exited` — whichever comes first.

### 9.7 Resumability from the agent to the client

Three segments, each with its own protection:

1. **Agent → `api`.** `api` reads `Process/Attach` through `resumableAttach` from `@umiak/agent-client` (S2 §9.1): a tunnel break, `421` on gateway drain, an agent restart — a repeated attach from the expected offset; the caller sees a pause. If the agent is absent longer than 30 s, `api` gives the client an `error` frame with `code: agent_unavailable`, `retryable: true` and the offsets.
2. **`api` → client.** Offsets in every data frame, `heartbeat` after every 15 s of silence. The SDK considers the connection dead after 45 s without lines and reopens `/stream` with the last offsets. A stream lives no longer than 60 min, then `reconnect` [S7 decision] — this limits long-lived connections through the ingress and gives balancing between pods.
3. **The `api` pod stops.** On SIGTERM the pod stops accepting new requests (readiness → false), sends `reconnect` (`reason: server_shutdown`) to all open streams, a control frame `reconnect` and close `1012` to PTY sockets, waits up to 10 s, and exits. In-flight sync requests get `503 server_shutting_down`: `retryable: true` only with an `Idempotency-Key` (a repeat attaches to the same command), without a key — `retryable: false`, `details {commandId, outcome: "running"}`. `terminationGracePeriodSeconds: 30`.

The result for the client: a start exactly once (with a key), output byte for byte by offsets (or an explicit `truncated`), `exit` only after all output.

## 10. PTY (terminal)

### 10.1 Creation

`POST /v1/sandboxes/{sandbox}/ptys` (`Idempotency-Key`):

```json
{ "cols": 120, "rows": 32, "command": null, "cwd": null, "env": {}, "user": "user", "term": "xterm-256color" }
```

`command: null` — the user's login shell. The response is `201 Command` (`mode: pty`; a repeat with the same key — `200` and `Idempotency-Replayed: true`, §23.4). The capability `process.pty` is needed. A PTY without a connected client is closed by the agent after 10 min (S2 §9.3, `reason: pty_idle`).

### 10.2 WebSocket

`GET /v1/sandboxes/{sandbox}/ptys/{command}/connect?offset=&tailBytes=` with an upgrade, subprotocol `umiak.pty.v1`.

- Authentication: `Authorization: Bearer` (CLI, SDK on Node/Bun/Python) or an oauth2-proxy session (browser, with the Origin check, §7.4). A browser `WebSocket` cannot set headers, so from the browser a PTY is available only through `app.<domain>`.
- **Server → client:**
  - a binary frame — consecutive bytes of PTY output;
  - a text frame — JSON: `{"type":"attached","offset":N}` (first), `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (as in NDJSON), `{"type":"error","code","message","retryable","details","requestId"}`, `{"type":"reconnect","offset":N,"reason"}`.
  - The client counts the offset itself: `attached.offset` (or `availableFrom` after `truncated`) plus the number of bytes received.
- **Client → server:** a binary frame — input; a text frame — `{"type":"resize","cols":N,"rows":N}`.
- **Input.** `api` assigns an `inputSessionId` to each WebSocket connection and numbers `seq`; `api` → agent retries are deduplicated (S2 §9.3). Bytes the client sent at the moment the WebSocket broke may be lost: a keystroke is lost but never repeated twice. Keystrokes are coalesced over 5 ms.
- **Backpressure.** If the socket's `bufferedAmount` exceeds 1 MiB, `api` stops reading `Attach` (the agent stream waits via HTTP/2 flow control).
- **Closing:** `1000` after `exit`; `1012` on pod stop (preceded by a `reconnect` frame); `4401` unauthorized, `4403` no rights, `4404` no command, `4409` the sandbox is not `ready`, `4503` the agent is unavailable (reconnect later). The implementation also has `1008`, `1011`, and `4416` (§23.4). A WebSocket ping from `api` every 15 s.
- The client (SDK, CLI) reconnects itself with the current offset; scrollback after reconnect is `tailBytes` (CLI: 64 KiB).
- `POST .../ptys/{command}/resize {cols, rows}` — the same without a WebSocket. PTY output can also be read through the NDJSON endpoint `/commands/{command}/stream?ptyOffset=`, and input through `/input`; so a PTY is available to clients without WebSocket.

## 11. Files, ports, SSH

### 11.1 Files

Paths: absolute or relative to the `user`'s home directory (S3 §11.1). The query `user` (default `user`) sets on whose behalf paths are resolved and who owns new files. There are no directory restrictions: the trust boundary is the VM.

- **`GET /files/content?path=`** — the file bytes, proxied as a stream from the agent (`/files` through the gateway, no buffering). `Range` (one range), `If-Range`, `ETag`, `Last-Modified`, `Accept-Ranges`; `HEAD` too. Always `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`: a file from a sandbox must not be executed in the browser on `app.<domain>`. A directory is `409 is_directory`.
- **`PUT /files/content?path=&mode=&makeParents=true&overwrite=true`** — the body as a stream of any size, an atomic write (S3 §11.2). The response is `200 FileInfo`. Not resumable; for files over 64 MiB the SDK and CLI use chunked upload.
- **Resumable upload:**
  1. `POST /files/uploads {path}` → `{uploadId: "upl_...", chunkSizeBytes: 4194304, maxChunkSizeBytes: 8388608, expiresAt}`. `api` stores nothing: `uploadId` is a new ULID, the temporary file lives at the agent for 24 h.
  2. `PUT /files/uploads/{upload}?offset=N` — a chunk up to 8 MiB; `offset` must equal the current size, otherwise `409 upload_offset_mismatch` with `Umiak-Upload-Offset`. The response is `{offset}`. In the first chunk `api` passes the agent the `path` from `POST` as a hint (S3 §11.3), so the client sends it in `PUT` too (`?path=`).
  3. `HEAD /files/uploads/{upload}` → `Umiak-Upload-Offset`; `404 upload_not_found`. (An unknown or foreign `uploadId` in `PUT` with `offset > 0` — `409 upload_offset_mismatch` with offset `0`, §23.5.)
  4. `POST /files/uploads/{upload}/commit {path, sha256?, mode?, owner?, overwrite?, makeParents?}` → `FileInfo`; idempotent by `uploadId` (S3). A `sha256` mismatch is `422 checksum_mismatch`.
  5. `DELETE /files/uploads/{upload}` — cancel.
  `api` buffers a chunk in memory (up to 8 MiB) so that `agent-client` can repeat it if the tunnel breaks.
- **`GET /files/stat?path=&noFollow=false`**, **`GET /files/list?path=&depth=1&includeHidden=true&limit=&cursor=`**, **`POST /files/mkdir {path, parents?, mode?}`**, **`POST /files/move {from, to, overwrite?}`**, **`POST /files/chmod {path, mode?, owner?, group?, recursive?}`**, **`DELETE /files?path=&recursive=false`** → `200 {existed}`.
- **Directory archive** (the agent — S3 §11.2, the path and error rules are the same as for the other `/files` endpoints):
  - **`GET /files/archive?path=&format=tar|tar.gz`** — the directory `path` as one tar stream (default `tar`, POSIX pax), proxied from the agent without buffering; `Content-Type: application/x-tar` or `application/gzip`, `Content-Disposition: attachment`. Names in the archive are relative to `path`. Not a directory → `409 not_directory`. No `Range` and no resume; an error mid-stream cuts the response without the closing tar blocks, and the client sees an incomplete archive.
  - **`PUT /files/archive?path=&format=tar|tar.gz&overwrite=true&makeParents=true`** (default `format=tar`) — the body as a stream, extraction into the directory `path` → `200 {path, entries, sizeBytes}`. The owner is the request's `user`; uid/gid from the archive are ignored. Limits (agent, S3 §11.2): up to 200,000 entries, up to 16 GiB of extracted data, an entry path up to 4,096 bytes, otherwise `413 payload_too_large`. An entry with an absolute path or `..`, a hardlink to a path outside the archive, and special files (devices, FIFOs) — `400 invalid_path`. Symlinks are created as is, but extraction does not pass through a symlink inside `path` (neither from the archive nor one already on disk; such an entry is `400 invalid_path`), so a write does not escape `path`. Extraction is not atomic: on error what was written stays (`details.entriesWritten`); whoever needs atomicity extracts into a new directory and does a `move`. Not resumable: the SDK repeats the whole archive (with `overwrite=true` a repeat is safe).
- `FileInfo`: `{path, name, type: "file"|"dir"|"symlink"|"other", sizeBytes, mode, owner, group, uid, gid, modifiedAt, symlinkTarget}`.
- Capabilities `files.v1`, for uploads `files.upload.v1`, for archives `files.archive.v1`. The sandbox state is as for commands (§9.1, step 2).
- Agent errors follow S3 §11.1 and the §5.5 table.
- Not in v1: directory watching, search, signed URLs (§19).

### 11.2 Ports

- **`GET /ports`** → `{hosted: [HostedPort], listening: [{port, addresses, process, user}], listeningObservedAt}`. `listening` is a live `System/ListPorts` if the sandbox is `ready`; otherwise the last `ports.changed` (S6 §10.2).
- **`PUT /ports/{port}`** `{access?: "token"|"sso"|"public", hostRewrite?: "preserve"|"localhost", appProtocol?: "http1"|"h2c"}`; defaults `token`, `preserve`, `http1` (S4 §8.1). The response is `201` (new) or `200`:

```json
{
  "port": 3000,
  "label": "quiet-otter-lamp-3000",
  "url": "https://quiet-otter-lamp-3000.umiak.example.com",
  "access": "token",
  "hostRewrite": "preserve",
  "appProtocol": "http1",
  "blocked": false,
  "blockReason": null,
  "createdAt": "...",
  "token": "umiakp_...",
  "urlWithToken": "https://quiet-otter-lamp-3000.umiak.example.com/?_token=umiakp_..."
}
```

  `token` and `urlWithToken` are present only when the token was issued by this call: a new port in `token` mode or a switch to `token`. S6 stores only the hash, so a repeated `PUT` does not return the token — a lost token is replaced through `rotate-token`. Any mode change raises `authEpoch` (S4 §8.2).
- **`POST /ports/{port}/rotate-token`** → `{token, urlWithToken}`; the old token and cookie stop working immediately.
- **`DELETE /ports/{port}`** → `204`.
- Checks: port 1–65535; not `22` and not from the list reserved by the platform (a config shared with the gateway); no more than 50 ports per sandbox (S4); `public` is forbidden if the operator turned it off globally (`403 forbidden`, `details.reason: "public_disabled"`).
- Publishing is possible in any state except `deleting`/`deleted`: the gateway itself shows the "stopped" page (S4 §6.3).

### 11.3 SSH

- **The user's SSH keys** (user level, not team): `GET /v1/ssh-keys`, `POST /v1/ssh-keys {name, publicKey}` → `201 {id: "sshk_...", name, fingerprint: "SHA256:...", type, createdAt, lastUsedAt}`, `DELETE /v1/ssh-keys/{key}`. Types: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `ssh-rsa` of at least 3072 bits; certificates are not accepted. The fingerprint is unique across the whole platform (`409 ssh_key_in_use`): the gateway uses it to find the user unambiguously. Storage is an S8 collection (§17.3).
- **`GET /v1/sandboxes/{sandbox}/ssh`** → `{host: "ssh.example.com", port: 22, username: "quiet-otter-lamp", loginUser: "user", command: "ssh quiet-otter-lamp@ssh.example.com", knownHosts: ["ssh.example.com ssh-ed25519 AAAA...", "ssh.example.com ecdsa-sha2-nistp256 AAAA..."], hasKeys: true}`; `hasKeys` — whether the person has registered SSH keys (always `false` for a team key). `knownHosts` are the gateway's host keys from the config (`UMIAK_SSH_HOST_KEYS_FILE`, public only), the same for all sandboxes (S4 §9.2).
- **`POST /v1/sandboxes/{sandbox}/ssh/certificate {publicKey}`** (`ssh:connect`; a person with a JWT or a session, and a team key) → `{certificate, principal, validAfter, validBefore, host, port, username, knownHosts}` [Ilia's decision 2026-10-29: short-lived certificates for the same identity]. `api` signs a user certificate with the **SSH login CA** (ed25519, the private key only at `api`: `UMIAK_SSH_LOGIN_CA_KEY_FILE`; the public one at the gateway, S4 §9.2): `ValidPrincipals: [<sb_… sandbox id>]`, `KeyId: umiak:user:<usr_…>` or `umiak:key:<key_…>`, `ValidAfter` = now − 60 s, `ValidBefore` = now + 10 min (checked only at login, the session lives longer), a random serial, extensions `permit-pty`, `permit-port-forwarding`, `permit-agent-forwarding`, `permit-X11-forwarding`, `permit-user-rc`. Key types are as for the SSH keys above. The sandbox state is not checked (the gateway itself explains a stopped sandbox, S4 §9.3). This is the main path for the CLI and the only one for team keys; registered SSH keys remain for people with plain `ssh`.
- The login right is checked by `ssh/authorize` (§12.1) on every connection, so user deactivation, removal from a team, and key revocation take effect immediately, not when the certificate expires.

## 12. Internal endpoints and own tables

### 12.1 Internal listener

All use the gateway service token (§7.8).

**`POST /internal/v1/agent-events`** — the body `AgentEventsRequest` (protojson, plan `s2-impl`; in the implementation — binary protobuf, §23.3), calls `core.events.ingest`, the response is `{ackedSeq}` (S6 §10.1). A thin wrapper.

**`GET /internal/v1/gateway/routes/{label}`** [overrides S6 §14.2: the path is from S4] — the response is exactly per S4 §6.1:

```json
{
  "label": "quiet-otter-lamp-5173", "sandboxId": "sb_...", "slug": "quiet-otter-lamp", "port": 5173,
  "machineId": "0192..." , "sandboxState": "ready",
  "access": "token", "tokenHash": "<hex>", "authEpoch": 7,
  "blocked": false, "blockReason": null,
  "hostRewrite": "preserve", "appProtocol": "http1", "teamId": "team_..."
}
```

- `sandboxState` — the S6 state as is [overrides S4 §6.3]: the gateway gets only `creating`, `ready`, `stopping`, `stopped`, `starting`, `error`, `deleting`, `deleted`. The values `running` and `resuming` never occur. The mapping for the gateway: `ready` → proxy; `creating`, `starting` → `503 sandbox_starting`; `stopping`, `stopped` → `503 sandbox_stopped`; `deleting`, `deleted` → `404 route_not_found`; `error` and unknown → `503 sandbox_unavailable`.
- `blocked`: the port or sandbox is blocked by an operator (S8) or `access = public` with `public` turned off (`blockReason: "public_disabled"`).
- `404 {"code": "route_not_found"}` — no sandbox with the slug, the port is not published, the sandbox is `deleted`, the label is outside the grammar or has a reserved suffix.
- The IDs in this response are in the public format (`sb_`, `team_`), `machineId` is a UUID (S2).

**`POST /internal/v1/gateway/ssh/authorize`** [overrides S6 §14.2: the path and shape are from S4 §9.2] — `{sandbox, publicKey, fingerprint}` (a registered key) or `{sandbox, certificate: {keyId, serial, principal, validBefore}}` (a certificate whose signature and lifetime the gateway has already checked, S4 §9.2):
1. Key: find the SSH key by `fingerprint`, check that `publicKey` matches the stored one. Certificate: parse `keyId` (`umiak:user:<id>` or `umiak:key:<id>`); `principal` equals the sandbox ID from the request.
2. User (`umiak:user`, a registered key): active and a member of the sandbox's team (S8 C6, no operator exception). Team key (`umiak:key`): not revoked, not expired, its team is the sandbox's team, has the scope `ssh:connect`.
3. The sandbox exists and is not `deleted`.
→ `200 {allowed: true, actor: {kind: "user", userId, email} | {kind: "team_key", apiKeyId}, userId, email, sandboxId, machineId, sandboxState, loginUser}` (`userId` and `email` are `null` for a team key) or `200 {allowed: false}` (no reason: the gateway does not show it). `loginUser` comes from the template (S8 `Template.loginUser`, default `user`). Update the key's `lastUsedAt` (no more than once per 60 s).

**`POST /internal/v1/gateway/port-auth/exchange`** `{code, label}` — atomically: `UPDATE port_auth_codes SET used_at = now() WHERE code_hash = $1 AND label = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email, auth_epoch`. The response is `{userId, email, label, authEpoch}` or `400 {"code": "invalid_code"}`.

### 12.2 S7 tables

Schema `runtime`, migrations in `db/migrations/` numbered **0300–0399** [overrides S6 §5.12: the S6 range is 0200–0299]:

```
port_auth_codes(
  code_hash bytea pk,           -- sha256 of the 32-byte code
  label text, user_id text, email text, auth_epoch int,
  expires_at timestamptz,       -- now() + 60 s
  used_at timestamptz null, created_at timestamptz)
```

S6 cleanup (S6 §15.4) deletes rows older than a day; S7 adds this table to it. There is no `cli_logins` table: the CLI login is the Keycloak device grant (§7.6).

## 13. Catalog, account, snapshots, keys

- **`GET /v1/templates`** → `{data: [{slug, name, os, enabled, defaultSize, allowedSizes, loginUser, capabilities: ["exec","files","ssh","desktop"], version}]}`. `version` is the active build (S6 `template_builds`). Disabled templates are seen only by operators.
- **`GET /v1/sizes`** → `{data: [{slug, vcpu, memoryMb}]}`.
- **`GET /v1/me`** → `{user: {id, email, name} | null, team: {id, name, role}, teams: [{id, name, role}], isOperator, auth: {kind: "session" | "oidc" | "team_key", apiKeyId?, scopes, expiresAt?, createdBy?}}`. For a team key `user: null`, `teams` is only its team, `role: null`.
- **`GET /v1/limits`** → `{quota: {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}, usage: {activeSandboxes, ramMb, savedSnapshots}, remaining: {activeSandboxes, ramMb, savedSnapshots}, canCreate, templates: [{slug, enabled, defaultSize, sizes: [{slug, vcpu, memoryMb, allowed, reason, warmAvailable}]}], rateLimits: {requestsPerSecond, burst, startsPerMinute}}`. For the request's team; `usage` and `remaining` are counted by the S6 §8.5 quota rules.
  - `canCreate` — whether a sandbox of at least one allowed size can be created right now.
  - `sizes` — all sizes from the template's `allowedSizes`; `allowed: false` with `reason`: `template_disabled`, `quota_active_sandboxes`, `quota_ram`. Disabled templates are seen only by operators (as in `/templates`).
  - `warmAvailable` — **phase 2, outside the public MVP contract (Ilia's decision 2026-10-29)**, the field is absent in the MVP response: the number of `warm` machines of the pair right now (a hint for `failFast`, §8.2; not a reservation). Node capacity (`out_of_capacity`) is not promised in advance.
  - `usage` and the pool counters are an S6 method (an addition, §20.2; the pool counters are phase 2).
- **`GET /v1/meta`** (no auth) → `{apiVersion: "v1", build, appUrl, apiUrl, umiakDomain, oidc: {issuer, clientId: "umiak-cli", audience: "umiak-api"}, ssh: {host, port, hostKeys}, minCliVersion, latestCliVersion}`.
- **Saved snapshots** (addressed by name within a team; name `^[a-z0-9][a-z0-9-]{0,62}$`):
  - `POST /v1/snapshots {sandbox, name, forceStop?}` (`Idempotency-Key`) → `202 {snapshot, operation}`. An existing snapshot with the same name is replaced when the new one becomes `ready` (S6 §7.8). A running Windows sandbox is saved only from a stopped VM: without `forceStop: true` — `409 snapshot_requires_stop` (the message "Windows snapshots are saved from a stopped VM; …"), with it — stop → snapshot → start, as for fork (§8.2, S9 §24.8). Linux and a stopped source ignore the flag.
  - `GET /v1/snapshots` → a list, including `creating` (their `name` is the expected name) and `failed` from the last day; `GET /v1/snapshots/{name}` → the ready snapshot or one being created with this name.
  - `DELETE /v1/snapshots/{name}` → `204` (S6 frees the name immediately).
  - The resource: `{id: "snap_...", name, state: "creating"|"ready"|"failed"|"deleting", sourceSandboxId, template, templateVersion, size, consistency: "quiesced"|"powered_off"|"crash", error, createdAt, readyAt}`. Linux snapshotted live is `quiesced`; a source stopped by a clean shutdown (`clean_stop`) and any Windows are `powered_off`. Linux stopped without a clean shutdown (hard stop, VM crash) is `crash` (S6 §7.9, S9 §24.9). Windows without a clean shutdown is not snapshotted: `409 snapshot_requires_clean_stop`.
  - Create from a snapshot — `POST /v1/sandboxes {from: {snapshot: name}}`.
- **API keys:**
  - `GET /v1/api-keys` — all keys of the request's team; seen by all members and a key with `keys:admin`;
  - `POST /v1/api-keys {name, scopes? | preset?, expiresInSeconds?, kind?}` → `201 {apiKey, secret}` — only a human `owner` (§7.2); `expiresInSeconds` defaults to 90 days, maximum 365; `kind` is only `team` (default), the `sandbox-self` preset is not issued to team keys;
  - `POST /v1/api-keys/{key}/rotate` → `200 {apiKey, secret}` — only a human `owner`: a new secret, the old one stops working immediately;
  - `DELETE /v1/api-keys/{key}` → `204` (`owner`, operator, or a key with `keys:admin`); `DELETE /v1/api-keys/self` → `204`.
  - The resource: `{id: "key_...", kind: "team", sandboxId: null, teamId, name, prefix, last4, scopes, createdBy: {id, email, active, member}, createdVia: "api"|"cli"|"dashboard", createdAt, expiresAt, lastUsedAt, revokedAt}`; `createdBy.active` and `member` show that the creator is deactivated or left the team (the key keeps working, S8 §9.8); `kind: "sandbox"` is reserved (§7.2).

## 14. CLI `umiak`

### 14.1 Build and configuration

- `apps/cli` on `@umiak/sdk`, argument parsing with `commander`. Built with `bun build --compile --target=bun-<os>-<arch>` for `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64`. Binaries and `SHA256SUMS` go to GitHub Releases (§15.5).
- Config `$XDG_CONFIG_HOME/umiak/config.json` (default `~/.config/umiak/`, Windows — `%APPDATA%\umiak\`), permissions `0600`: profiles `{name: {apiUrl, team, auth: "oidc" | "key"}}`, the current profile; secrets (Keycloak tokens, the team key) are in the OS store or `credentials.json` (§7.6). Order: flags > env (`UMIAK_API_URL`, `UMIAK_API_KEY`, `UMIAK_TEAM`, `UMIAK_PROFILE`) > profile > system `/etc/umiak/config.json` (`apiUrl` only; the template puts it there, S5 §8.9).
- The `known_hosts` cache for SSH is `~/.config/umiak/known_hosts`, updated from `/v1/meta`.

### 14.2 Commands

| Command | What it does |
|---|---|
| `umiak login [--no-browser] [--key-stdin] [--api-url] [--credential-store]`, `logout [--revoke]`, `whoami`, `auth token [--json]` | §7.6; `whoami` = `/me`; `auth token` — for the SDK and MCP |
| `umiak create [--template] [--size] [--name] [--slug] [--label k=v] [--env K=V] [--secret K=V] [--env-file f] [--ttl] [--idle] [--from snap] [--fail-fast] [--wait]` | create; `--wait` waits for `ready` and prints it; `--fail-fast` — §8.2, **phase 2, outside the public MVP contract (Ilia's decision 2026-10-29)**, the MVP CLI has no such flag |
| `umiak list [--state] [--label]`, `umiak info <sb>` | |
| `umiak stop\|resume\|recover <sb> [--wait]`, `umiak fork <sb> [--name] [--force-stop] [--wait]`, `umiak rm <sb>... [--yes]` | `resume` and `fork` accept `--env K=V`, `--secret K=V`, `--env-file f` (§8.2); `fork --force-stop` and `snapshot save --force-stop` send `forceStop: true` (a running Windows sandbox, S9 §24.8); on `409 snapshot_requires_stop` the CLI prints the API message and the hint `use --force-stop`; `rm` asks for confirmation in a TTY without `--yes` and sends `Umiak-Confirm-Delete` (§5.12); without a TTY and without `--yes` — an argument error |
| `umiak current [<sb> \| --clear]` | prints this shell's current sandbox; with `<sb>` makes it current |
| `umiak rename <sb> <slug>`, `umiak extend <sb> [--ttl]`, `umiak label <sb> k=v...` | |
| `umiak env <sb> [--set K=V] [--secret K=V] [--unset K]` | `GET`/`PUT /env` (in the implementation `GET`/`PATCH /env`: the flags are a merge, §23.7) |
| `umiak exec <sb> [--cwd] [--env] [--user] [--timeout] [--detach] [--stdin] -- <cmd...>` | by default streams the output live (stdout to stdout, stderr to stderr), the `umiak` exit code = the command's code. Automatic reattach. `--detach` prints the `commandId` |
| `umiak logs <sb> <cmd> [-f] [--tail N]`, `umiak kill <sb> <cmd> [--signal]`, `umiak ps <sb>` | attach, kill, list commands (`--tail` — bytes per stream, §23.7); `logs -f` waits for the command to end and exits with its code, like `exec`; `logs` without `-f` exits with `0` |
| `umiak shell <sb> [-- <cmd>]` | a PTY over WebSocket in raw TTY mode; size by `SIGWINCH`; reconnects itself |
| `umiak ssh <sb> [-- ssh args]`, `umiak ssh-config <sb>` | `ssh`: an ephemeral ed25519 in a `0700` directory, a certificate via `POST /ssh/certificate` (§11.3), the system `ssh` with `-i`, `CertificateFile`, and `-o UserKnownHostsFile=<cache>` to `<slug>@ssh.<domain>`; the files are deleted after exit. `ssh-config` prints a `Host` block with `Match exec "umiak ssh-cert <sb> --ensure"` (in the implementation `Match originalhost <alias> exec ...`, §23.7) so that plain `ssh` and VS Code Remote-SSH get a fresh certificate themselves. Works with a team key too |
| `umiak ssh-cert <sb> [--ensure]` | issues or refreshes the certificate for `ssh-config` (a new one if less than 2 min remain) |
| `umiak ssh-keys list\|add [file]\|rm` | default `~/.ssh/id_ed25519.pub` |
| `umiak cp [-r] <src> <dst>` | `sb:path` on either side; files over 64 MiB — chunked upload with resume, download — with `Range`; `-r` — a directory through `/files/archive` (§11.1) |
| `umiak push [dir] <sb>:<path>` | in a git repository — the files from `git ls-files -co --exclude-standard`, otherwise the whole directory; tar.gz as a stream into `PUT /files/archive` |
| `umiak port <sb> <port> [--public\|--sso\|--token]`, `umiak ports <sb>`, `umiak unport <sb> <port>`, `umiak port-token <sb> <port>` | prints the URL (with the token, if issued) |
| `umiak snapshot save <sb> <name> [--force-stop] [--wait]`, `snapshot list\|rm` | `--force-stop` — as for `fork`; `save --wait` waits until the snapshot is `ready` (limit `--wait-timeout`, default 5 min) and prints it; a save error is code `1`, a wait timeout or a transient error (`retryable`) is `75` |
| `umiak templates`, `umiak sizes`, `umiak limits` | |
| `umiak keys list\|create [--preset] [--scope]...\|rotate\|rm` | team keys; `create`, `rotate` — only an `owner` logged in through Keycloak |
| `umiak run [create flags] [--push dir] [--keep] -- <cmd...>` | create → push → exec → delete; the exit code is the command's code |
| `umiak mcp [--toolsets] [--read-only] [--sandbox]` | an MCP server over stdio on the CLI credentials (S11 §6.1); in S7 a stub, §23.1 |
| `umiak completion bash\|zsh\|fish\|powershell`, `umiak version` | |

Flags and commands beyond the table, closed stdout (code `141`), `--cacert` — §23.7.

`<sb>` is an ID or slug. If not given, `UMIAK_SANDBOX` is used, then the shell's current sandbox, then (inside a VM) `UMIAK_SANDBOX_ID` from the platform env (S3 §8.2; it is the S6 UUID, and the CLI converts it to `sb_…` itself, §5.3).

**Current sandbox** [MVP rec. R1]. `create`, `fork`, and any command with an explicit `<sb>` make this sandbox current for the shell. The shell key is `UMIAK_SESSION` if set, otherwise the parent process PID and its start time; the state is in `$XDG_STATE_HOME/umiak/current/<key>` (on Windows `%LOCALAPPDATA%\umiak\`), deleted after 7 days. `umiak current` prints `{sandbox}` (the §8.1 resource) or exits with code `3` if there is no current one or it was deleted.

### 14.3 Output and exit codes

- **JSON when stdout is not a TTY** [MVP rec. R1]. In a TTY — tables and lines for humans; if stdout is not a TTY — JSON, as with `--json`. `--json` (or `UMIAK_OUTPUT=json`) turns on JSON in a TTY too, `--human` (`UMIAK_OUTPUT=human`) — text even without a TTY. (Commands with raw output switch to NDJSON only on an explicit `--json`, not on `UMIAK_OUTPUT`, §23.7.) The exception is commands whose stdout is data: `exec`, `run`, `logs`, `shell`, `ssh`, `cp`/`push` write raw output to stdout for any stdout (`umiak exec sb -- cat f > out` writes the file's bytes); for `exec`, `run`, `logs` with an explicit `--json` — NDJSON frames as in the API.
- **JSON shape.** Ordinary commands print one JSON structure (the API resource as is). Waiting commands (`create --wait`, `fork --wait`, `resume --wait`, `recover --wait`, `stop --wait`) print JSON Lines: `{"event":"accepted","sandbox":{...},"operation":{...}}`, `{"event":"state",...}` on a state change, and last `{"event":"ready","sandbox":{...}}` (for `stop --wait` — `{"event":"stopped",...}`). `snapshot save --wait` is the same: `{"event":"accepted","snapshot":{...},"operation":{...}}`, last `{"event":"ready","snapshot":{...}}` (a snapshot has no intermediate states, so there are no `state` lines). The discriminator field of the CLI's JSONL lines is always `event`: the API frames (§9.5) in `exec`/`run`/`logs --json` are printed with `event` instead of `type`.
- **An error is the last stdout line** in JSON mode: `{"event":"error","code","message","retryable","details","requestId"}` (fields from §5.5; a CLI error without an API response has the same fields, `requestId: null`), for any command, including after JSONL lines. The human-readable text goes to stderr. For commands with raw output (`exec`, `run`, `logs`, `cp`, `push`) without an explicit `--json`, stdout is occupied by data, so this line goes to stderr.
- Exit codes (the same in a TTY and in JSON): `0` — success; `1` — an API or CLI error; `2` — an argument error; `3` — not found; `4` — no rights or not logged in; `75` — a transient error (retryable, retries exhausted); for `exec`/`run`/`logs -f` — the command's code (`128 + n` for a signal, `124` for `timed_out`, `125` for `lost`/`failed_to_start`).

## 15. OpenAPI and SDK [decision Q4]

### 15.1 OpenAPI

- Routes are described through `createRoute` from `@hono/zod-openapi`; the zod schemas are the source of truth for validation and the document. OpenAPI 3.1.
- `operationId` is `<resource>.<action>` (`sandboxes.create`, `commands.attach`); every operation has a `summary` and `description` written for a human and an LLM (S11 uses them).
- NDJSON endpoints: `content: application/x-ndjson` with a frame schema (`oneOf` with `discriminator: type`). WebSocket is not described in OpenAPI 3.1: the `connect` endpoint is described as a `GET` with a `101` response and the extension `x-umiak-websocket: {subprotocol: "umiak.pty.v1"}`, the protocol is in the documentation.
- **Security schemes:** `keycloak` — `type: openIdConnect`, `openIdConnectUrl: {issuer}/.well-known/openid-configuration` (Keycloak JWT, §7.10); `teamKey` — `type: http`, `scheme: bearer`, `bearerFormat: "umiak_"` (§7.2). Globally `security: [{keycloak: []}, {teamKey: []}]`; endpoints for humans only (SSH keys, issuing and rotating keys) — `[{keycloak: []}]`; `/v1/meta`, `/v1/openapi.json`, `/v1/docs` — `security: []`. The browser session (proxied listener) is not described in the document: it is for the dashboard of the same origin.
- Response enums are marked `x-extensible-enum`; the generators are configured so that an unknown value does not crash the client (§15.2, §15.3).
- `pnpm --filter @umiak/api openapi` writes `apps/api/openapi/v1.json` (committed). CI: regeneration with no differences, `oasdiff breaking` against `main`.
- Documentation is `GET /v1/docs` (Scalar) over the same document; the public listener only, the version pinned with SRI (§23.3).

### 15.2 TypeScript: `@umiak/sdk`

- `openapi-typescript` generates `src/gen/v1.d.ts` (committed, CI checks freshness); the transport is `openapi-fetch`. Works on Node ≥ 22, Bun, Deno, and in the browser (without PTY via Bearer, §10.2).
- The facade:

```ts
const umiak = new Umiak({ baseUrl: "https://api.example.com", team?: "team_..." }) // credentials: apiKey | accessToken | tokenProvider, else chain §7.6

const sb = await umiak.sandboxes.create({ template: "linux", secrets: { TOKEN: "..." } }, { wait: true })
const r = await sb.exec("npm test", { cwd: "app", timeoutSeconds: 600 })        // sync result
for await (const ev of sb.run("npm run build")) { /* stdout/stderr/exit, auto-reattach */ }
const cmd = await sb.start("python3 -m http.server 8000")                     // detached
for await (const ev of cmd.follow({ from: "start" })) { /* ... */ }
await sb.files.writeText("notes.txt", "hi"); const s = await sb.files.readText("notes.txt")
await sb.files.upload("big.tar", fileOrStream)                                // chunked, resumable
const port = await sb.ports.host(8000, { access: "public" })
const pty = await sb.pty({ cols: 120, rows: 32 }); pty.onData(b => ...); pty.write("ls\n"); pty.resize(100, 30)
for await (const s of umiak.sandboxes.list({ label: { session: "42" } })) { /* all pages */ }
await sb.delete()
```

- The low-level client (`umiak.raw`) is `openapi-fetch` itself with all operations.
- Credentials follow the §7.6 chain (explicit parameters → `UMIAK_API_KEY` → `UMIAK_ACCESS_TOKEN` → `umiak auth token --json`); on `401 token_expired` the SDK gets a new token once and repeats the request.
- Errors are the class `UmiakError {status, code, message, retryable, details, requestId}`.
- Every facade method and `umiak.raw` accepts `signal: AbortSignal` (it aborts the request, long-poll, stream read, and retries) and `retryBudgetMs` (the total retry time for this call instead of 60 s, §15.4). MCP needs this for the tool call deadline (S11 §7.5).

### 15.3 Python: `umiak-sdk`

- `openapi-python-client` generates `umiak_sdk/_gen` (httpx + attrs, sync and async), the generator config with `literal_enums: false` and parsing of unknown values; the generated code is committed. Python ≥ 3.11. A uv project (`pyproject.toml`), pytest tests, ruff lint.
- The `Umiak` and `AsyncUmiak` facades with the same methods in `snake_case` (`sb.exec`, `sb.run`, `cmd.follow`, `sb.files.read_text`, `sb.files.upload`, `sb.pty`, `umiak.sandboxes.list` as an iterator). NDJSON — `httpx` `stream()` + `iter_lines()`; PTY — `websockets` (sync and asyncio API).
- `UmiakError` with the same fields.
- In the MVP implementation: no `pty` and no `upload_dir`/`download_dir`; `timeout` and `retry_budget` instead of `signal`; the sync facade is generated from the async one (§23.8).

### 15.4 Helpers and retry policy (the same in TS and Python)

| Helper | What it does | Difference from boat (`research/03` §5) |
|---|---|---|
| `waitUntilReady(timeout=300 s)` | long-poll `GET ?waitFor=ready`; the error `SandboxFailedError` if `error`/`deleting`/`deleted`/`stopped` | long-poll instead of polling every 2 s |
| `waitForOperation(op)` | long-poll of the operation | boat has none |
| `exec(cmd, opts)` | `mode: stream` with `Idempotency-Key`, the output is collected into a sync-shaped result (4 MiB tail per stream); reattach and retries as for `run` | boat retries sync without a key and may run twice; proxies cut a silent sync |
| `run(cmd, opts)` | `mode: stream`, an iterator of `stdout/stderr/exit` frames; on a break or `error{retryable}` — reattach with offsets; `heartbeat`/`reconnect`/`attached` are hidden; leaving the loop early does not kill the command | boat: the stream is not resumable, long ones go through detached |
| `start(cmd)` + `follow(from)` | detached + attach with auto-reconnect (45 s without lines = a break) | like boat's `run_command` + `follow_command`, but with a `start` retry by key |
| `readText`/`writeText`, `readBytes`/`writeBytes` | `/files/content` | boat uses JSON with base64 up to 5 MiB |
| `upload(path, src)`, `download(path, dest)` | 4 MiB chunks with resume via `HEAD`; download with `Range` and `If-Range` | boat uses a signed URL without resume |
| `uploadDir(local, path)`, `downloadDir(path, local)` | a directory as one tar stream through `/files/archive` | boat has it only in the CLI |
| `pty(opts)` | WebSocket with auto-reconnect by offset | boat has none |
| `stopAndDelete()` | delete with `Umiak-Confirm-Delete` (§5.12; no stop needed) | |
| `sandboxes.list()` | an iterator over all pages | |

**SDK transport retry policy** [S7 decision]:
- Retried: `GET`/`HEAD`/`PUT`/`DELETE` on network errors, `502`, `503`, `504`, `429`; `POST` — only if the request has an `Idempotency-Key` (the SDK sets it itself for the §5.7 endpoints) or the response has `retryable: true`. The exception (**phase 2, outside the public MVP contract, Ilia's decision 2026-10-29**) is `503 pool_exhausted`: the SDK and CLI do not retry it but return it to the caller at once (otherwise `failFast` loses its meaning; the CLI exits with code `75`).
- Backoff: 0.5 s × 2 up to 8 s with full jitter, `Retry-After` takes priority, up to 60 s in total (configurable). `retryable: false` is never retried.
- Streams (`run`, `follow`, PTY) reconnect with offsets without an overall time limit while there is progress; 20 failed attempts in a row without new bytes is an error.

### 15.5 Distribution

- In the monorepo `apps/web` (S8), `apps/mcp` (S11), `apps/cli` use `@umiak/sdk` as a workspace package.
- A release by tag `sdk-v<semver>` / `cli-v<semver>` (GitHub Actions in the private repository): GitHub Releases get the wheel and sdist of `umiak-sdk`, the `npm pack` archive of `@umiak/sdk`, the CLI binaries, and `SHA256SUMS`. Install: `pip install <wheel url>` / `npm install <tgz url>` with a GitHub token, the CLI — a binary download. GitHub Packages (npm under the owner's scope) — later if needed.
- The SDK version is independent of the API version; the SDK supports all of `/v1`.

## 16. Tests and acceptance

**Unit (vitest, pytest):**
- the ID codec (UUID ↔ `sb_...`, ULID ↔ `cmd_...`), the slug parser and generator (S4 grammar, suffixes, reserved), the key format and CRC, bearer parsing (key or JWT, §7.10);
- the "endpoint × scope" matrix: every endpoint from §6 rejects a key without the needed scope;
- the S6/agent errors → HTTP table (§5.5);
- the frame UTF-8 decoder: cuts inside multibyte characters, invalid bytes, reattach with `nextOffset` gives the same text;
- cursors (HMAC, forgery), body canonicalization for idempotency.

**Integration** (Postgres 18, S6 `packages/core` with a fake worker, the real gateway library and tunnel from the `s2-impl` `tunnelharness`).

(In the implementation there is no Go fake: the tests run on the TS fake `FakeAgent` with real processes, decision 3, §23.9.) The S2 double `umiak.testing.v1.Process` does not fit these tests: it has no `pty_offset`, `SendInput`, `Kill`, `Get`, `Filesystem`, `/files/*`, or `ListPorts`. So [S7 decision, per the S6 §16 precedent]: the S7 implementer adds to Go a fake agent `umiak.agent.v1` (`libs/tunnel/tunneltest/agentv1fake`) and the flag `tunnelharness -agent fake-v1`, coordinating with `s2-impl` (an addition, existing S2 tests are untouched). The fake:
- runs real child processes and writes their output to files with offsets;
- implements `Process` (including PTY via `creack/pty`, `SendInput`, `Update`, `Kill`, `Get`, `Attach` with `tail_bytes`/`follow`), `Filesystem` and `/files/*` over a temporary directory, `System/ListPorts`;
- observes the S2 §9 and S3 §9–§11 contracts: `Start` idempotency, `Umiak-Request-Id`, `exit` after all output, `truncated`.
The generated TS code `umiak.agent.v1` comes from `proto/umiak/agent/v1` (S3). If `s3-impl` has not yet put the proto in place, S7 starts from the protocol in S3 §9–§13 and reconciles at merge. The real agent's behavior is checked by E2E on `pve`.

Scenarios:
- **Stream chaos (the main one).** SDK `run()` of a command of 3000 lines × 512 B; every 100–400 ms a random failure: a tunnel break, gateway drain, agent restart, **stopping the `api` process** (a second `api` instance takes over). The sha256 of stdout and stderr match the expected, the exit code is right, the agent's `Start` ran once.
- **Command idempotency.** Repeating `POST /commands` with the same key after a break at each point (before `Start`, after `Start` before the response, mid-stream) — one command at the agent.
- **Security:** `X-Auth-Request-Email` on the public listener is ignored; a request to the proxied listener without `Origin` or with a foreign `Origin` — `403`; a WebSocket upgrade with a foreign `Origin` — refused; a `port-auth` code a second time and with a foreign `label` — `invalid_code`; secrets do not end up in logs (logger interception in the create, `PUT /env`, `POST /api-keys` tests).
- **Keycloak JWT** (a test Keycloak 26.8 in a container, or tokens signed with a test JWKS): a foreign `iss`, no `aud=umiak-api`, `alg: none` and `HS256`, expired (`token_expired`), an ID token and a refresh token instead of an access token, a foreign `azp` → `401`; an unknown `kid` → JWKS is re-read once; the first request with a JWT creates the user the same way as the browser, and `sub` matches `X-Auth-Request-User`; a deactivated user with a live token → `403 user_disabled`; device grant: `umiak login` → `umiak auth token` → the SDK uses the same token; a user disabled in Keycloak cannot refresh the token.
- **Team keys:** a `member` and a key cannot issue a key (`403`); a key works after its creator is removed from the team and after their deactivation; an `owner` revokes a key; a key does not call human endpoints (`user_required`).
- **SSH certificates:** a certificate from a foreign CA, expired, with another sandbox's principal, for a revoked key or a deactivated user → login refused; `KeyId` in the VM's sshd log (S4 §9.3).
- **Files:** uploading 100 MiB with a break in the middle and resuming via `HEAD`; `Range` and `If-Range`; `checksum_mismatch`; a directory archive there and back (file sha256 match), refusal on `..`, an absolute path, and a write through a symlink, the `413` limits.
- **CLI and error contract:** without a TTY the CLI prints JSON, `create --wait` gives JSONL with the last line `ready`, an error is the last line `{"event":"error",…}`; every API error has `retryable` and `requestId`; `DELETE` without `Umiak-Confirm-Delete` or with a foreign ID — `428`, nothing deleted; `failFast` with an empty pool — `503 pool_exhausted`, the DB has no new sandbox, operation, or idempotency key (**phase 2, outside the public MVP contract, Ilia's decision 2026-10-29**; in the MVP the tests check that these words are absent from OpenAPI and that `failFast` in the body is `400 validation`).
- **PTY:** echo, resize, a WebSocket break and reconnect with an offset without losing output; close `1012` on pod stop.
- **Long-poll:** `waitFor=ready` returns on `NOTIFY` before the timeout.
- **Contract:** the requests and responses of all integration tests are validated against `openapi/v1.json`.

**SDK:** TS and Python tests against a running `api` with fakes (one scenario set: create/wait/exec/run/follow/files/upload/pty/errors), including retries on `503` and reattach.

**E2E on `pve`** (after S3–S6): the scenario `umiak-bench s7` in `apps/bench` through the CLI: `login --key-stdin` → `create --wait` → `exec` stream for 10 min with a restart of the `api` pod and the agent in the middle → `cp` 200 MiB there and back with a break → `port --public` and `--token` through the gateway (curl) → `ssh` → `shell` → `snapshot save` → `create --from` → `rm`. Measurements: create-to-ready through the API, `exec` first-byte latency, p99 PTY echo.

**S7 readiness criterion:** unit, integration, and SDK tests pass; OpenAPI with no differences and no breaking changes; E2E on `pve` passes, and afterwards there are no leftovers (S1 `inventory`).

## 17. Interfaces and requirements for other areas

### 17.1 S2 (`@umiak/agent-client`, `s2-impl`)

- **Routing HTTP `fetch`** (handed to `s2-impl` by the master session): `AgentClient.fetch(machineId, path, init)` to `/v1/machines/{id}/files/*` of the gateway's internal listener with the same rules as the Connect transport: instance lookup, `421` → another instance, `503 agent_unavailable` and connection errors → wait up to 30 s. A retry is possible while the request body has not started sending or if the body is a buffer (upload chunks); a streaming body (`PUT /files/content`) is not retried after sending begins. The response is streamed, without buffering.
- `resumableAttach` (S2 plan, Task 11) is used as is, together with `pty_offset` (S3).

### 17.2 S3

No separate requirements: it uses `Process` (§9), `Filesystem` and `/files/*` (§11.1, including `/files/archive` with the capability `files.archive.v1`), `System/ListPorts`, `UpdateEnv`/`UpdateSecrets` (through S6), the capabilities from S3 §13.

### 17.3 S8 (Payload)

`IdentityStore` (the interface in `packages/auth`, the implementation on the Payload Local API — S8; implementation additions — §23.10):

```ts
interface IdentityStore {
  resolveSession(h: { email: string; user?: string; groups: string[]; preferredUsername?: string }): Promise<SessionIdentity> // JIT upsert
  findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null>
  createApiKey(input: NewApiKey): Promise<ApiKeyRecord>          // secretHash computed by packages/auth
  revokeApiKey(id: string, by: { userId?: string; apiKeyId?: string }): Promise<void> // revokedBy / revokedByKey
  listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]>       // team keys, with creator status
  touchApiKey(id: string): Promise<void>
  listSshKeys(userId: string): Promise<SshKeyRecord[]>
  addSshKey(input: NewSshKey): Promise<SshKeyRecord>             // unique fingerprint
  removeSshKey(userId: string, id: string): Promise<void>
  findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null>
  membership(userId: string, teamId: string): Promise<{ role: "owner" | "member" } | null>
  user(userId: string): Promise<UserRecord | null>               // active flag, isOperator
}
```

- **IDs in Payload are UUIDs** (`idType: 'uuid'` of the Postgres adapter): S6 stores `team_id`, `created_by`, `principal_id` as `uuid`, and the codecs `usr_`/`team_`/`key_`/`sshk_` (§5.3) are designed for 128 bits. This is a requirement on S8.
- Collections: `users` (email, name, active, isOperator from IdP groups, defaultTeam), `teams`, `memberships` (user, team, role), `api-keys` (`name`, `team`, `createdBy` (audit, does not affect the key's operation, §7.2), `kind` (`team`; `sandbox` is reserved, §7.2), `sandbox` (uuid, null), `secretHash` unique, `prefix`, `last4`, `scopes[]` (§7.3 names), `expiresAt` (required), `revokedAt`, `lastUsedAt`, `createdVia`), `ssh-keys` (`user`, `name`, `publicKey`, `fingerprint` unique, `type`, `lastUsedAt`).
- `Template`: + `loginUser` (default `user`), `capabilities`. `PlatformDefaults`: + `defaultTemplate`, `publicPortsEnabled`, `ssoPortPolicy (any | team)`, rate limits. Port and sandbox blocks by an operator are fields that `routes.lookup` reads.
- The `afterChange` hooks of the collections `users`, `memberships`, `api-keys`, `ssh-keys` send `NOTIFY umiak_identity '<collection>:<id>'`.
- Keys are created only through `packages/auth` (the §7.2 format). The keys UI in the dashboard calls the S7 API and does not write to the collection directly.
- The dashboard works through `@umiak/sdk` on `app.<domain>/api/v1` (the same origin, the oauth2-proxy cookie), the team is the header `Umiak-Team`.

### 17.4 S4

- Paths and shapes of the internal endpoints are in §12.1 (S4 §6.1, §8.4, §9.2). SSH certificate login (S7 §11.3, S4 §9.2) and session teardown via `NOTIFY umiak_ssh_revoke` (S4 §9.5) are agreed with S4 by Ilia's decision 2026-10-29.
- **[overrides S4 §6.3]** `sandboxState` is the S6 states; the gateway handles `starting` as `creating`. The values `running` and `resuming` do not arrive.
- `sandboxId` and `teamId` in responses are in the public format (`sb_...`, `team_...`), not `umiak_...` as in the S4 example.
- The slug is the S4 §4.2 grammar, generated by S7 (§5.4). The list of reserved suffixes and ports is a shared constant (`packages/auth` exports it for Go too as a JSON file in `docs/`/the config; the implementers agree on the place).

### 17.5 S11 (MCP): what it needs from the API

- **Tools** are built on top of `@umiak/sdk`: create (with `failFast` — **phase 2, outside the public MVP contract, Ilia's decision 2026-10-29**)/list/get/stop/resume/fork/delete (with `Umiak-Confirm-Delete`, §5.12), `limits`, `exec` (sync with a timeout, output tail, `commandId`), `start` + reading output by offset (`/output` — for polling without streams), `kill`, files (read text with a size limit, write, list, stat, mkdir, move, delete), ports (host, list), snapshots, templates/sizes.
- **Descriptions:** the `summary`/`description` of operations and fields in OpenAPI are written so that tool descriptions can be derived from them (§15.1).
- **Safe retries:** `Idempotency-Key` for create/fork/commands, so that retrying a tool call does not create a second resource and does not run a command twice.
- **Responses for an LLM:** errors with a clear `message` and `retryable`; large outputs with truncation flags and offsets, not huge bodies; `waitFor` long-poll instead of polling.
- **Authentication:** stdio MCP uses the SDK chain (§7.6): a person's login through `umiak auth token` or the team key `UMIAK_API_KEY`; remote MCP over HTTP is decided by S11 (probably OAuth through Keycloak with `aud=umiak-api`). Keys restricted to a sandbox come later (§19), if S11 asks for them.
- What is not in v1 and S11 may need: screenshots and computer-use (S10), file search (through exec).
- Decided in S11 (`docs/specs/s11-mcp.md`): no new MCP endpoints are needed; the remote MCP accepts the same bearers and verifies them through `GET /v1/me`; the Keycloak client `umiak-mcp` (§7.10) and the command `umiak mcp` (§14.2) were added.

### 17.6 S12

- Ingress: `api.<domain>` → `:8080`; `app.<domain>` paths `/api/*` (stripping `/api`), `/umiak-auth/*` → oauth2-proxy → `:8081`. WebSocket upgrade support on both hosts; response buffering off for `application/x-ndjson`; ingress read timeout and oauth2-proxy `--upstream-timeout` ≥ 660 s (sync commands up to 600 s are silent, §9.2; streams are covered by a heartbeat every 15 s); no request body limit for `/files/*`, 16 MiB for the rest.
- NetworkPolicy: `:8081` — only from oauth2-proxy; `:8082` — only from the gateway; `:9090` — from Prometheus.
- Deployment `api`: 2 replicas, `terminationGracePeriodSeconds: 30`, readiness `/readyz` (Postgres, Payload, `LISTEN` connections).
- Secrets: service tokens (`UMIAK_API_SERVICE_TOKENS_FILE`), `UMIAK_API_CURSOR_KEY`, the S6 data keys (`UMIAK_DATA_KEYS_FILE`), the gateway's public SSH host keys, the SSH login CA private key (`UMIAK_SSH_LOGIN_CA_KEY_FILE`, §11.3).
- Keycloak (realm `umiak`, clients and lifetimes — architecture §10): `UMIAK_OIDC_ISSUER`, `UMIAK_OIDC_AUDIENCE=umiak-api`, `UMIAK_OIDC_ALLOWED_CLIENTS=umiak-cli,umiak-mcp`; `api` goes to Keycloak only for discovery and JWKS.

## 18. Libraries and tools

Checked 2026-10-29 (`npm view`, PyPI, GitHub releases); re-check during implementation and take the latest stable.

| Purpose | Library | Version |
|---|---|---|
| HTTP framework | `hono` | 4.13.14 |
| Routes + OpenAPI from zod | `@hono/zod-openapi` (peer `zod ^4`, `hono >=4.10`) | 1.6.3 |
| Validation | `zod` | 4.6.7 |
| Node adapter; built-in `upgradeWebSocket` over `ws` | `@hono/node-server` | 2.1.5 |
| WebSocket | `ws` / `@types/ws` | 8.22.0 / 8.18.2 |
| API documentation | `@scalar/hono-api-reference` | 0.12.16 |
| Rate limits | `rate-limiter-flexible` | 11.2.3 |
| Logs / metrics | `pino` / `prom-client` | 10.4.0 / 15.1.3 |
| Keycloak JWT verification | `jose` | 6.2.13 |
| CLI: OS store | `Bun.secrets` (Bun ≥ 1.3) | Bun from `mise.toml` |
| IdP | Keycloak (S12) / oauth2-proxy | 26.8.1 / v7.15.5 |
| ULID | `ulid` | 3.0.2 |
| Agent | `@umiak/agent-client` (S2: `@connectrpc/connect`, `-node` 2.3.0) | workspace |
| TS SDK: types / client | `openapi-typescript` / `openapi-fetch` | 7.13.0 / 0.17.0 |
| CLI: arguments | `commander` | 15.0.0 |
| CLI: build | Bun (`mise.toml`) | 1.4.4 |
| Python SDK: generator | `openapi-python-client` | 0.29.1 |
| Python SDK: HTTP / models / WebSocket | `httpx` / `attrs` / `websockets` | 0.28.1 / 26.1.0 / 17.3 |
| Python: toolchain | `python` / `uv` in `mise.toml` | 3.15.2 / 0.13.6 |
| Python: tests, lint | `pytest` / `ruff` | 9.2.0 / 0.17.3 |
| OpenAPI comparison in CI | `oasdiff` (Go, via mise) | v1.35.0 |

Rejected:
- `@hono/node-ws` 1.3.1 — requires `@hono/node-server ^1.19`; in 2.x WebSocket is built in. If direct access to `bufferedAmount` is needed, `ws` is used under the adapter.
- `@hey-api/openapi-ts` 0.99 (0.x versions often break the generated code), `orval` (oriented to react-query), `openapi-generator` 7.26 (Java; the Python client is sync only on urllib3). Stainless, Speakeasy, Fern are paid.
- tus for uploads: we would have to translate the protocol into agent chunks; our own protocol repeats S3 one to one and is simpler.
- SSE instead of NDJSON: event ids and `Last-Event-ID` are not needed, offsets already give resumption, and NDJSON is easier to read from `fetch` and `httpx`.

## 19. Phases [decision Q3]

| Phase | What is included |
|---|---|
| **PoC** | The public and internal listeners; `StaticIdentityStore` and keys from YAML; create/get/list/patch (without slug)/delete, operations, long-poll; commands: sync, stream, detached, attach, output, input, kill, signal, list; files: content (read with `Range`, write as a stream), stat, list, mkdir, move, delete; templates, sizes, `/me`, `/meta`; `agent-events`; errors, pagination, idempotency, limits; OpenAPI + CI; CLI: `login --key-stdin`, `create`, `list`, `info`, `rm`, `exec`, `logs`, `kill`, `cp` (without resume) |
| **MVP** | stop/resume/fork/recover/extend; slug rename; `GET`/`PUT /env`; PTY over WebSocket; chunked upload; chmod; ports and access modes, the gateway endpoints (routes, port-auth, SSO authorize); SSH keys, `/ssh`, `ssh/authorize`; saved snapshots; API keys; the proxied listener (the Payload `IdentityStore` implementation — S8); `umiak login` (Keycloak device grant), JWT verification, team keys, SSH certificates; `/limits`; the TS and Python SDKs with helpers; the full CLI; releases. Per the MVP recommendations: the directory archive (`/files/archive`), `failFast` (moved to phase 2, Ilia's decision 2026-10-29), env and secrets on fork and resume, `Umiak-Confirm-Delete`, "resource × action" scopes, the CLI output contract and `umiak current` |
| **Boundary with S8** | The S7 MVP is considered ready against `StaticIdentityStore` (with header-based sessions to test the proxied listener) and `StaticConfigReader` extended with the fields from §17.3 (`loginUser`, `capabilities`, `defaultTemplate`, `publicPortsEnabled`, `ssoPortPolicy`). The Payload implementation of `IdentityStore` and these fields is S8's work; S7 does not wait for it |
| **Later** | Signed file URLs; command output history outside the VM; webhooks; `ps`; desktop and computer-use (S10); `sandbox`-type keys (§7.2) and team keys restricted by sandbox, environments, or labels (S24); programmatic access to `sso` ports (S4 §17); CLI self-update; publishing to GitHub Packages |

## 20. Summary of changes in other specs

### 20.1 Overrides (the S4 and S6 implementers must take them into account)

| # | Where | Was | Now |
|---|---|---|---|
| O1 | S6 §14.2, §4 (schema) | `/internal/v1/routes/{label}`, `/internal/v1/ssh/authorize` | `/internal/v1/gateway/routes/{label}`, `/internal/v1/gateway/ssh/authorize`, `/internal/v1/gateway/port-auth/exchange` (S4 paths) |
| O2 | S6 §14.2 | `ssh/authorize {sandbox, user, publicKeyFingerprint}` → `{allowed, machineId, state}` | the S4 §9.2 shape: `{sandbox, publicKey, fingerprint}` or `{sandbox, certificate: {keyId, serial, principal, validBefore}}` → `{allowed, actor, userId, email, sandboxId, machineId, sandboxState, loginUser}` (§12.1) |
| O3 | S4 §6.3 | `sandboxState` may be `running`, `resuming` | only the S6 states; `starting` is handled as `creating` (§12.1) |
| O4 | S4 §6.1 (example) | `sandboxId: "umiak_..."` | `sb_...`; `teamId: "team_..."` |
| O5 | S6 §5.6 | slug — 10 characters `[a-z0-9]` | the S4 §4.2 grammar, three words by default, generated by S7 (§5.4) |
| O6 | S6 §5.12 | `runtime` — 0200+ | S6 — 0200–0299, S7 — 0300–0399 |
| O7 | S6 §14.2 | `NOTIFY umiak_routes '<label>'`, one per label | the payload is the **slug** (S4 §6.2): the gateway evicts all entries with the slug; `'*'` clears the whole cache. Triggers on `sandboxes` and `hosted_ports` are in the S6 migrations (0200–0299): a change of `state`, `machine_id`, slug (two notifications: old and new), any change to a `hosted_ports` row (mode, token, block). `'*'` is sent by the S8 hook when `publicPortsEnabled` changes |

### 20.2 Additions to S6 (`packages/core`)

**Who does it** [S7 decision, per the S6 §16 precedent with `packages/pve`]: the S7 implementer makes these small additions to `packages/core` and `db/migrations` themselves (the S6 range for changes to S6 tables), coordinating with the `s6-impl` track. Until `packages/core` appears, S7 writes against the `SandboxService` interface with a fake; the interface from S6 §14.1 together with this list is considered frozen.

1. `updateEnv(p, id, {env?, secrets?, secretFiles?})` → `{delivered}` and `getEnv(p, id)`; the `sandbox_secrets` blob stores three sets (`env`, `secrets` → S3 `secret_env`, `secretFiles`); create and fork accept `secrets` separately from `env`.
2. `createCommand(p, id, spec, idemKey?)` — by key returns the existing command (scope `commands.create`); add `user`, `tags jsonb`, `argv jsonb null` to `commands`. `listCommands`, `getCommand`.
3. `hostPort(p, id, port, {access, hostRewrite, appProtocol})`; in `hosted_ports` — `host_rewrite`, `app_protocol`, `blocked`, `block_reason`; `listHostedPorts`; sandbox block by an operator. `routes.lookup` returns the S4 §6.1 fields.
4. `rename(p, id, slug)` — changes `hosted_ports.label` of all ports, `authEpoch+1`, `NOTIFY umiak_routes` with the old and new slug.
5. `usage(teamId)` for `/limits` and the number of `warm` machines per (template, size) pair (the `warm` count is phase 2).
6. `listSavedSnapshots` returns both `creating` (by `pending_name`) and `failed` from the last day; `getSavedSnapshot(p, name)`.
7. `resume` and `recover` with an active operation of the same kind return it (like `stop`).
8. The last `ports.changed` snapshot per sandbox (`listeningPorts(id)`).
9. `Principal` with `kind`, `role`, and `isOperator` (§7.5); `userId` may be `null` (a team key): then `sandboxes.created_by`, `commands.created_by`, and `operations.requested_by` are `null`, and the key is written to the new columns `created_by_key` / `requested_by_key uuid null` (for S6 system operations both columns are `null`); `idempotency_keys.principal_id` is the key id (as before).
10. Cleanup deletes `port_auth_codes` older than a day.
11. A scope-based idempotency mechanism shared by `api` and `core` (`sandboxes.create`, `sandboxes.fork`, `commands.create`, `snapshots.create`); `saveSnapshot` accepts `idemKey`. The hash also includes the sandbox from the path.
12. `extend(p, id, ttlSeconds?)`.
13. `NOTIFY umiak_operations '<operationId>'` when an operation moves to a terminal state (a trigger) — for `GET /operations/{id}?waitSeconds` (`save_snapshot` and fork on the source do not change the sandbox `state`, so `umiak_sandboxes` does not cover them).

What from the list is done and how it was supplemented — §23.11.

The MVP recommendations R2 and R11 (2026-10-29) went directly into S6 and are done in `s6-impl`, not by this list: `failFast` and `pool_exhausted` (S6 §7.3, §14.1), env and secrets on fork and resume (S6 §7.6, §7.7).

### 20.3 Additions to S2

`AgentClient.fetch` — §17.1 (handed to `s2-impl`).

### 20.4 `docs/architecture.md`

§9 was rewritten briefly per this spec (resources, IDs, errors, listeners, SDK and CLI); §2 — `packages/sdk-ts`, `packages/sdk-py`, `packages/auth`.

## 21. Left to the implementer

- The file layout in `apps/api`, `packages/auth`, the SDK and CLI; generating the slug dictionary (word source, filter).
- The canonical body form for the idempotency hash (together with S6).
- The layout of the SSO error pages (minimal HTML without external resources).
- The rate limit values from the results of a load test.
- Where the shared list of reserved slug suffixes and ports for TS and Go lives.
- Metrics (minimum): requests by route, method, and status; duration; open streams and WebSockets; reattach by segment; agent calls by method and outcome; authentication failures by reason; `429`.

## 22. Answers to open questions (master session, 2026-10-29)

- **SSO ports:** by default any signed-in platform user is let in; the switch `ssoPortPolicy = team` remains (§7.7).
- **Key lifetime:** 90 days by default, 365 maximum, none without expiry (§7.2).
- **Keycloak and offboarding** (Ilia's decision, 2026-10-29): the IdP is Keycloak; people in the CLI, SDK, and MCP use device grant and JWT (§7.6, §7.10), without long-lived personal keys; automation uses team keys (§7.2); deactivation is the sync with Keycloak (S8 §20.1).
- **Roles in a team** (`owner`/`member`): decided by S8; until then the §7.5 assumption applies (any team member has access to its sandboxes within scopes).

## 23. MVP implementation (`s7-impl`)

> Historical report predating R1; current names — `docs/specs/rename-umiak.md`.

Added after implementation (branch `s7-impl`, 2026-10-30). This records what was done differently or in more detail than in the sections above; such places above are marked with a reference to §23. "Decision N" is the list "Implementer decisions" in `docs/plans/s7-public-api.md`; the rest was decided during implementation. Sections 1–22 remain the history of the agreement.

### 23.1 Not in the MVP

- **Warm pool** (decision 1, Ilia's decision 2026-10-29): `failFast`, `pool_exhausted`, `warmAvailable`, `--fail-fast` are phase 2, outside the public MVP contract. The create schema has no such field: `failFast` in the body is `400 validation` (an unknown field). `warmAvailable` is not in `/limits`. If core still throws `pool_exhausted`, the response is `500 internal`.
- **`sbx mcp`** is a stub: it prints "implemented by S11" and exits with code `1` (decision 12).
- **The desktop** (S10 §13): the scope `desktop` and the endpoints will be added by S10. `routes.lookup` returns `kind: "port"`; labels `<slug>-desktop` are `404 route_not_found` for now (decision 9).
- **S8:** C3 (operator block endpoints; the `blocked`/`block_reason` columns already exist), `PayloadIdentityStore`, `PayloadConfigReader`.
- The `/v1/snapshots` and `/v1/environments` lists are one page, without `limit`/`cursor`.
- Reserved ports are only `22` (a constant in `api`); a shared list with the gateway and S10 comes later.
- **Python SDK:** without `pty` and `upload_dir`/`download_dir` (decision 11).
- **The Go agent fake** `agentv1fake` and `tunnelharness -agent fake-v1` (§16) were not built (decision 3): the tests run on the TS fake `FakeAgent`, and stream chaos is at the level of `api` and the SDK (fake attach breaks, connection breaks, stopping the `api` process, a second instance). Chaos through the tunnel comes after the S3 agent is connected (§23.9).

### 23.2 Error codes

Added (v1 allows new codes):

| HTTP | `code` | `retryable` | When |
|---|---|---|---|
| 405 | `method_not_allowed` | no | the path exists, the method does not; header `Allow`, `details.allow` |
| 408 | `request_timeout` | yes | `PUT /files/uploads/{upload}`: the handler waited 30 s for chunk bytes and there are none (`details.idleTimeoutSeconds`), or the chunk has been going longer than 10 min since the first read (`details.timeoutSeconds`) (§23.3); `Connection: close`. Nothing was sent to the agent, `offset` protects the retry: the SDK continues from the offset from `HEAD` |
| 426 | `upgrade_required` | no | `GET .../ptys/{command}/connect` without a WebSocket upgrade |
| 503 | `idp_unavailable` | yes | Keycloak discovery or JWKS is unavailable and there are no keys in the cache. Not `401`, so the CLI does not go into a repeated login |
| 503 | `not_ready` | yes | `/readyz`: `details.reasons`, `Retry-After`; the same error envelope as on the other listeners |

Clarifications of existing codes:
- `409 invalid_state` with `details.reason: "machine_replaced"` — the command was started on a previous machine (after reprovision); agent calls to it are not made. A repeat with a key for such a finished command is also `409 machine_replaced`, not the stored result.
- `409 invalid_state` with `details.agentCode` — other agent `failed_precondition` errors, instead of `502 agent_error`.
- `403 forbidden` with `details.reason: "identity_conflict"` — the email is already bound to another `sub` (S8 §5.3); `401 unauthorized` — the IdP did not send `sub`. These are the `IdentityError` codes `identity_conflict` and `subject_required` (§23.10).

SDK codes (not coming from the API, `SbxError.status = 0`): `network_error` (the request did not arrive or the connection broke), `unexpected_response` (a response without the envelope, e.g. a proxy page), `no_credentials` (CLI — exit code `4`), `no_api_url`, `auth_command_failed`, `token_provider_failed`, `wait_timeout`, `unsupported_runtime` (a helper for Node/Bun only), `pty_input_overflow` (PTY input during reconnect exceeds 1 MiB; nothing was dropped, the caller retries later). Errors inside a stream (an `error` frame, a PTY close) are also `SbxError` with status `0`.

### 23.3 HTTP

- **Limits** (§5.8): a fixed window — `SBX_API_RATE_BURST` requests per `burst / SBX_API_RATE_RPS` seconds per principal (by default 100 per 5 s, exactly `RateLimit-Policy: "req";q=100;w=5`), not a token bucket. Headers as in §5.8. Starts (create, fork, resume) — `SBX_API_RATE_STARTS_PER_MIN` (30) per minute per team; repeats with the same `Idempotency-Key` count too. Streams — up to `SBX_API_MAX_STREAMS` (100) per principal; sync commands are in the stream registry (for revocation and shutdown) but do not count toward this limit.
- **`503 server_shutting_down`** — with `Connection: close` and `Retry-After: 1`.
- **Request bodies** (§5.11) are not read before authentication: the limit is counted in the stream that the handler itself reads (after authentication); exceeding it is `413` during reading. A bounded body (everything except `PUT /files/content|archive` and upload chunks) must arrive within 60 s, otherwise `400 validation` (`path: body`). A `PUT /files/uploads/{upload}` chunk (up to 8 MiB) has no overall deadline: a slow but continuous client (4 MiB in 60 s is ~0.55 Mbit/s) would otherwise not upload a single chunk; instead there is an idle timeout — 30 s without new bytes while the handler waits for them (the time spent waiting for the sandbox to become ready does not count), → `408 request_timeout`, `retryable: true` (§23.2). So that a client does not hold a chunk open at one byte per 29 s, the chunk also has a ceiling — 10 min from the first body read (the same `408`, `details.timeoutSeconds: 600`); 8 MiB in 10 min is ~0.11 Mbit/s. `PUT /files/content|archive` has no deadline, and the server has no overall `requestTimeout` either (only `headersTimeout` is limited). The ingress in front of `api` must rate-limit requests by IP: the key lookup before authentication happens on every request (`apps/api/README.md`).
- **`GET /v1/docs`** — on the public listener only: on the proxied one (an origin with the oauth2-proxy cookie) it is `404`, and no third-party script runs there (§15.1). The page loads a fixed version of Scalar (`@scalar/api-reference@1.76.3`, `standalone.js`) from jsDelivr with SRI (`integrity`, `crossorigin`), with no inline scripts, with the CSP `default-src 'none'; script-src <this file>; style-src 'unsafe-inline'; connect-src 'self'; …`. Self-hosting from `node_modules` was not done: the package pulls in Vue and ~30 dependencies (+2700 lockfile lines, build scripts) for a single file.
- The error page of `/sbx-auth/authorize` with `429`/`503` sets `Retry-After`, like the JSON errors.
- `POST /v1/sandboxes` with `environment` as a bare UUID — `404 not_found`, like the `/v1/environments/{environment}` endpoints (a UUID is not a name; an id is only `env_…`).
- An error parsing `SBX_API_SERVICE_TOKENS_FILE` does not quote the file's contents (the `JSON.parse` message contains the beginning of the input — a token). A Keycloak JWKS unavailable before the first successful key load does not trigger the 30-second pause: the next request goes to Keycloak again.
- **Cursors** (§5.6): `base64url(JSON {c: <core cursor>}) + "." + HMAC-SHA256(SBX_API_CURSOR_KEY)`, truncated to 16 bytes; a forgery is `400 invalid_cursor` (decision 5).
- **Slug** (§5.4): the core dictionary, about 300 words (2.7 · 10⁷ combinations of three, then four words); a 1,500-word dictionary comes later (decision 6).
- **Client IP** (§7.1): `X-Forwarded-For` is taken only from addresses in `SBX_API_TRUSTED_PROXY_CIDRS` (right to left, up to the first untrusted address) and goes only into the `clientIp` field of the request log; limits are counted by principal. Identity headers, except the oauth2-proxy headers on the proxied listener, are trusted nowhere (e.g. `Tailscale-User-*` in front of `api`); there are tests for this, as for `X-Auth-Request-*` on the public one.
- **`POST /commands`** `200` is either `application/json` (sync) or `application/x-ndjson` (stream). `GET /commands/{command}` may itself write the terminal status to the DB from the agent's response.
- **`agent-events`** (§12.1): the body is the binary protobuf `AgentEventsRequest` (`@sbx/proto`), not protojson (decision 4). The `Any` payload is parsed by a type registry: S3 messages (`sbx.agent.v1`, `events.proto` and `common.proto`) and JSON-compatible ones (`Struct`/`Value`/`ListValue`) — in protojson with zero fields (exit code `0`, zero commands are data); unknown and corrupt ones are stored as `{"@type": typeUrl}` (otherwise the gateway would repeat the packet forever). `normalizeAgentEvent` (core) maps `CommandExited.reason` the same way as attach: `TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`; for a PTY command `pty_end` goes into `stdout_bytes`.
- **Stream size after exit.** On Linux, processes left after a command exits may keep writing to its stream beyond `end` (S3 §10): the file `size` grows, `end` does not, and the agent's attach does not return bytes beyond `end`. So for a finished command `api` computes the stream size everywhere as `min(size, end)`: the `sizeBytes` of the Command resource (`endBytes` as is), the offset checks of `/stream`, PTY, and `/output` (an offset in `(end, size]` → `416`), `tailBytes` (counted from `end`), the `/output` boundary (`Sbx-Stream-End`). Previously `tailBytes` for such a command started beyond `end`, and the stream reopened attach until it gave up.
- **`GET .../stream`** with an offset larger than the stream size → `416 range_not_satisfiable` (`details.stream`, `details.size`), like `/output`; a nonzero offset of a stream the command does not have (`ptyOffset` for a non-PTY, `stdoutOffset`/`stderrOffset` for a PTY) → `400 validation`. Previously such a stream of a finished command reopened attach until it gave up and ended with `agent_unavailable`.
- **`POST .../input`**: `seq` starts at `1` (schema `minimum: 1`): the shim drops `seq <= last`, a new session has `last = 0`, so `seq: 0` would never be applied.
- **`outputTruncated`** (proto `output_truncated`): `"disk_full"` if the agent lost output because the disk was full (stream ends count only written bytes), otherwise `null`. Present in the `exit` frame, in the Command resource, and in the `command` of the sync response. A string, not a boolean, as in the proto: a reason may be added.
- **Stored `outputTruncated` and `reason` of a command** (migration `0304_command_output.sql`, columns `runtime.commands.output_truncated` and `reason`; an S6 table, but the migration is in the S7 range by the master's decision, see `docs/roadmap.md`). They are written when a command completes (`completeCommand`: the `exit` frame of a stream and sync, the `Process/Get` response for `GET /commands/{command}`, the `command.exited` and `pty.closed` events in the worker) and by the S3 event `output.truncated` (in any status). For a finished command the status and `reason` do not change, and `output_truncated` is filled in if it was not there yet (the agent may learn of the output loss later). `reason` is the S3 value in lowercase (`EXIT_REASON_UNSPECIFIED` — `null`, both in `api` and in the worker); `failCommandStart` writes `start_failed`. For commands the platform itself marked `lost` (decision R32): `reboot` only when the platform knows the guest rebooted (the boot id changed, the `rebooted` event); after stop, with a missing or unexpectedly stopped VM — `null` (the reason is unknown). The Command resource takes the agent's live values while the sandbox is `ready`, otherwise the stored ones; for a finished row the stored `reason` takes precedence over the agent's value (the agent only fills an empty one). An `outputTruncated` from the agent that cannot be stored (empty, longer than 64 characters, with control characters) is returned neither in `GET` nor in the sync response. If `reason` is not known, it is derived from the status (`exited` → `none`, `killed` → `signal`, …; for `lost` — `null`). The CHECK on `reason` was added `NOT VALID` and verified by a separate `VALIDATE`.
- **`GET /commands/{command}`** and `/output` ask the agent (`Process/Get`) with a 5 s budget: on expiry `GET` returns the row from the DB, `/output` returns `503 agent_unavailable` (retryable).

### 23.4 PTY

- A repeat of `POST /ptys` with the same key and body is `200` (not `201`), the same command, `Idempotency-Replayed: true`.
- Close codes beyond §10.2: `1008` — an invalid control frame (preceded by an `error` frame with `code: validation`), `1011` — an unexpected server error (reconnect with backoff), `4416` — `offset` beyond the end of PTY output (preceded by an `error` frame with `code: range_not_satisfiable`, `retryable: false`, `details {stream: "pty", size}`), like `416` on `/stream` (§23.3); checked before attach, the SDK and CLI do not reconnect. `tailBytes` takes precedence over `offset` and does not go beyond the end. Unknown `type`s of text frames are ignored.
- A PTY has no 60-minute `max_duration` (NDJSON streams have it, §9.7): the terminal stays open while it is in use. It is closed by a pod stop (`1012`) and access revocation (`4401`).
- Refusals before the upgrade (`400`, `401`, `403`, `426`, `429`, `503`) arrive as an ordinary HTTP response with the error envelope.

### 23.5 Files

- An unknown or foreign `uploadId` in `PUT /files/uploads/{upload}` with `offset > 0` → `409 upload_offset_mismatch` with `details.offset: 0` and `Sbx-Upload-Offset: 0`, not `404`. `api` does not store uploads: their ids live at the agent of their machine (§11.1). Someone else's upload is indistinguishable from a nonexistent one.

### 23.6 Sandbox, env, environments

- **Environments** (S8 C1): CRUD `/v1/environments` and applying on create (the environment's sets, with the request's sets layered on top). The create idempotency hash is computed over the client body, and the environment is resolved after the key is captured: a repeat with the same key after an environment edit returns the stored result.
- In the Sandbox resource `environment` is always `null`, `excludeOwnerSecrets` is `false`: S6 has no columns for them (decision 7). `excludeOwnerSecrets: true` in create → `400 validation` while the field is not stored.
- **`PATCH /v1/sandboxes/{sandbox}/env`** (S8 C2): a merge, `{K: v | null}`, `null` removes; next to `PUT /env`.
- The rest of S8 C1–C10 done here: C4 (`?team=` on the proxied listener for `GET`/`HEAD`/WebSocket), C6 (`isOperator` only for a session; `ssh/authorize` without an operator exception), C7 (`routes.lookup` reads `publicPortsEnabled`/`ssoPortPolicy`/`ssoPolicyEpoch` from `ConfigReader` without a cache; the sso port's `authEpoch` = `auth_epoch + ssoPolicyEpoch`), C8 (`user_disabled`), C9 (a registry of open streams and PTYs, closing on `NOTIFY sbx_identity`), C10 (Keycloak JWT, `/meta.oidc`) (decision 8).

### 23.7 CLI

- `sbx env` sends `PATCH /env` (`--set`, `--secret`, `--unset` — a merge), not `PUT`: `PUT` would replace the whole set.
- `logs --tail N` is bytes per stream (`tailBytes`), not lines.
- `ssh-config` prints `Match originalhost <alias> exec "sbx ssh-cert <sb> --ensure"`: a bare `Match exec` would run `sbx` on every ssh connection to any host. The certificate lines sit inside `Match`. `SBX_API_KEY` from env is not carried into `Match exec` — a profile is needed. `sbx ssh` adds `-o IdentitiesOnly=yes`.
- A closed stdout (`sbx exec … | head -1`) → exit with code `141`; `exec`, `run`, and `shell` kill the remote command in this case.
- Commands with raw output (`exec`, `run`, `logs`) switch to NDJSON frames only on an explicit `--json`; `SBX_OUTPUT=json` does not: a script with redirected output must get bytes.
- The access token is refreshed at `exp − 90 s`, not `exp − 30 s`: the SDK considers a token stale at `exp − 60 s`, and a token from `sbx auth token` must not go stale at once.
- `--cacert <file>` / `SBX_CA_FILE` — a private CA for the API, Keycloak, and PTY WebSocket; trust is the built-in Node/Bun roots plus this file (the OS certificate store is not used).
- `exec`, `run`: SIGTERM and SIGHUP act like Ctrl-C: the stream is dropped, `run` deletes the sandbox (without `--keep`), exit `143`/`129` (Ctrl-C — `130`); the remote `exec` command keeps running. An undelivered Ctrl-C (`signal` did not arrive) is a warning on stderr.
- An argument parsing error of commands with raw output (`exec`, `run`, `logs`, `cp`, …) goes to stderr only, in JSON mode too: the command is known before its flags are parsed, and stdout (data) stays empty.
- `sbx rm a b` in JSON mode prints one document — an array of `{sandbox, operation}` responses (for one sandbox — an object, as before).
- `exec --stdin` sends `seq` starting at `1` (the shim drops `seq <= last`, §23.3).
- `SBX_RETRY_BUDGET_MS` — the SDK retry budget for CLI commands.
- `snapshot rm` asks for confirmation, like `rm` (`--yes` without a TTY).
- `login --key-stdin`: the key is the only non-empty stdin line (spaces and `\r` at the edges are trimmed); a second non-empty line or a key with a wrong format or CRC (§7.2) is an argument error (code `2`) before any request; the message does not quote the key.
- `login` prints JSONL: `device_code` (device grant only), then `logged_in {profile, apiUrl, me}`. The profile stores `credentialStore` — where the secrets are kept.
- `exec sb -- 'npm test'` (one argument) goes through `bash -lc`, `exec sb -- npm test` (several) — argv without a shell.
- Flags and commands beyond §14.2: `--wait-timeout` on waiting commands; `create --environment <name>` / `--no-environment`; `exec --tag k=v`; `kill --grace`; `ps --status`, `--limit`; `list --template`, `--q`, `--limit`; `label --unset`; `keys create --expires`; `run --cwd`, `--user`, `--timeout`; `run --push` works by default in `~/<directory name>`; `shell --attach <cmd>`; `port --host-rewrite`, `--app-protocol`; `ssh-keys add --name`, `ssh-keys rm` by name or fingerprint; `cp` with `:path` (the current sandbox) and `-` (stdin/stdout); `sbx env-sets list|show|create|set|unset|rm` (environments, §23.6); the alias `ls` for `list`, `snapshot list`, `keys list`, and `env-sets list`.

### 23.8 SDK

- **TS:** the raw client throws `SbxError` on any non-2xx (and does not return openapi-fetch's `{error}`). `tokenProvider` receives `{force}` (after `401 token_expired` — `force: true`). The SDK sends `Idempotency-Key` on the upload commit (`<uploadId>`) and on `input` with `sessionId` + `seq` (`<sessionId>:<seq>`) so the transport can retry them; `api` ignores the header on these endpoints, their idempotency is their own. A PTY refusal before the WebSocket upgrade is seen by the client as `1006` and counted as a failed attempt.
- **TS timeouts:** the response (headers) — 60 s per attempt (`CallOptions.timeoutMs`, `0` disables), then `network_error` and a retry by the usual rules; for binary and streaming bodies (uploads) there is no deadline. Starting a command and a PTY — 75 s (`api` waits for sandbox readiness up to 60 s). A response body with no data for 60 s (not less than `streamIdleTimeoutMs`) — `network_error`. As in Python (`httpx.Timeout(60, connect=10)`; command start — `read` 75 s until headers, then the stream idle limit).
- **Redirects** are not followed by TS (`redirect: "manual"`) nor by Python (`follow_redirects=False`): `3xx` is `SbxError`.
- **`download` to a path** writes `<dest>.tmp` and renames it at the end: a failed download leaves the previous `dest` (TS and Python).
- **`ExecResult`** (TS and Python) + `stdoutFrom`/`stderrFrom` (the offset of the tail's first byte) and `outputTruncated`; `ExitEvent` + `outputTruncated` (§23.3). Python: `Command.wait(timeout=)` and `follow(timeout=)` — `wait_timeout` (the command keeps running). TS `Pty.onTruncated(cb)` — terminal output loss (`availableFrom`). `readText` (TS) does not strip the BOM, as in Python.
- **API URL in the SDK:** `baseUrl`, `SBX_API_URL`, then the profile's `apiUrl` from `sbx auth token`; the SDK does not read the system `/etc/sbx/config.json` (the CLI does). Inside a sandbox with only `SBX_API_KEY`, `SBX_API_URL` (or `baseUrl`) is needed too.
- **Python:** the facade is written once (`sbx_sdk/_async/`), the sync one (`sbx_sdk/_sync/`) is generated by `scripts/gen.py`, and tests check freshness, as for `_gen`. There is no `AbortSignal`: waits accept `timeout`, calls accept `retry_budget` (seconds); cancellation by asyncio means. An unknown value of an open enum is the member `UNKNOWN`. Without `pty`, `upload_dir`/`download_dir` (§23.1).

### 23.9 Agent

- The agent RPC is the interface `AgentApi` (`apps/api/src/agent/types.ts`): `capabilities`, `requireCapability`, `start`, `attach`, `sendInput`, `update`, `signal`, `kill`, `get`, `stat`, `list`, `makeDir`, `move`, `chmod`, `remove`, `listPorts`, `updateEnv`, `updateSecrets`, `files`.
- In tests — `FakeAgent` (`@sbx/api/testing`): real child processes, a PTY without a terminal, files in a temporary directory.
- In the `api` process — `ConnectAgentApi` (`apps/api/src/agent/connect.ts`): the `proto/sbx/agent/v1` clients over `AgentClient.transport` (S2), `/files/*` through `AgentClient.fetch`, capabilities from `tunnel.tunnel_sessions`; the adapter rules are in `apps/api/README.md` (the section "Wiring S3"). Without `SBX_API_GATEWAY_TOKEN_FILE` all calls are `503 agent_unavailable`. The `api` integration tests against a real agent (the S2 gateway and the S3 agent in one process, `services/guest-agent/cmd/sbx-agent-harness`) are `apps/api/test/agent-real.test.ts`. FakeAgent is aligned with it: `timeout_ms` is SIGTERM, then SIGKILL after 10 s (like the shim).
- **Real agent codes** (`services/guest-agent/internal/errs`), the table is in the doc comment of `agentErrorToHttp`: `user_not_found` → `400 validation` (for `Start` the command row becomes `failed_to_start`); `shim_outdated`, `unimplemented` → `409 agent_outdated` (`details.agentCode`); `command_running` → `409 invalid_state`; `not_claimed` → `409 sandbox_not_ready`; `request_id_reused` → `409 idempotency_key_reused` (the requestId is derived from the key). Connect `Unavailable` with any detail (`quiesced`, `shim_unavailable`, `store_busy`, `identity_not_ready`) means the agent is unavailable: `503 agent_unavailable`, and for `Start`/`signal`/`input` without a session and the file operations `mkdir`/`move`/`chmod`/`delete` the outcome is unknown (`details.outcome: "unknown"` without a key), not `502`. `DeadlineExceeded` likewise: for mutations the outcome is unknown, for reads `503` retryable.
- **The outcome of `Process/Start`.** The command row is moved to `failed_to_start` only by a refusal the agent gives before the process starts (S3 §9.2, `internal/process/start.go`, the claim interceptor): `invalid_argument`, `user_not_found`, `already_exists`, `too_many_commands`, `not_claimed`, `failed_precondition`, `shim_outdated`, `unimplemented` (and `AgentOutdatedError`); `request_id_reused` is also considered a refusal, but the real agent does not send it for `Start`: `Start` is excluded from the agent's request id cache (`internal/reqcache`), it is idempotent by `commandId`. A repeat with a key (the row already exists) sends the agent the spec from the stored row (`user` is the stored one, not the template's current `loginUser`), and `already_exists` on such a repeat is not a refusal: `api` reads the agent's command (`Process/Get`) and attaches to it; if it cannot be read, the outcome is unknown. The agent sends `internal` after the start too (a storage error in `markRunning`, a systemd error in `settle`), so `internal`, Connect `Unknown`, and any unfamiliar code mean an unknown outcome, like an unavailable agent (§9.1): `503 agent_unavailable`, the row stays `starting`; with a key — `retryable: true`, `details.commandId` (a repeat with the same key will not start the process a second time), without a key — `retryable: false`, `details {commandId, outcome: "unknown"}`.
- **`Process/Signal` may arrive twice.** `AgentClient` (S2) retries unary calls at the transport level (a tunnel break, `421`, an unavailable agent) with the same `Sbx-Request-Id`, relying on the agent's response cache; but the agent's cache (S3, `internal/reqcache`) skips methods with `idempotency_level = IDEMPOTENT`, and `Signal` is marked that way. If `Signal` reached the agent and the response was lost, a retry will deliver the signal once more. For `SIGTERM`/`SIGKILL`/`SIGINT` this is harmless, for counting signals (e.g. `SIGUSR1` with a counting handler) it is not. A known MVP limitation, `api` does not work around it; to be fixed in S2 (do not retry `Signal` after sending) or in S3 (remove `IDEMPOTENT` from `Signal` or cache its response by request id).
- **Default `user`** (§9.1): if the request (`POST /commands`, `POST /ptys`) does not set `user`, the command runs as the sandbox template's `loginUser` (the same user as in `GET /ssh`), and if the template is not in the config — as `user` (the default templates have `loginUser: user`). The value is written explicitly into the command row and the agent spec, so the Command resource shows the real user, not an empty string.
- The capability `system.activity.v1` is in the `AGENT_CAPABILITIES` list (as with the real agent). `FakeAgent` computes the exit code for a signal from the Linux table (`SIGUSR1` = 10 → `138`), not from the host OS.

### 23.10 Identities and config before S8

- `IdentityStore` is `PgIdentityStore` (`packages/auth`) instead of `StaticIdentityStore` (§7.9, decision 2): the `identity` schema (migrations `0300_identity_standin.sql`, `0302_ssh_revoke_notify.sql`), loading `SBX_IDENTITY_FILE` at every start (upsert only), a JIT user with a personal team, key issuing through the API. The proxied listener is on. S8 will replace it with `PayloadIdentityStore`; the shared contract test suite is `@sbx/auth/testing`.
- `NOTIFY sbx_identity '<collection>:<id>'` is sent by the `0300` triggers; the collections `users`, `memberships` (id `<userId>:<teamId>`, opaque to consumers), `api-keys`, `ssh-keys` are S8's names.
- `NOTIFY sbx_ssh_revoke` (S4 §9.5) is sent by the `0302` triggers in the change's transaction, whoever makes it: `user:usr_…` (deactivation, deletion), `member:team_…:usr_…`, `key:key_…`, `team:team_…`. S8 sends the same payloads from hooks.
- `IdentityError` is extended with the codes `identity_conflict` (→ `403`) and `subject_required` (→ `401`); the S8 implementation must produce the same ones (contract tests).
- **Additions to `IdentityStore`** beyond §17.3 (contract tests `@sbx/auth/testing`, S8 must implement them): `rotateApiKey(id, {secretHash, prefix, last4})` (revoked or unknown — `not_found`; sets `rotatedAt`); `apiKey(id)` — a key by id, revoked and expired too, `null` for unknown (instead of scanning `listApiKeys`); `touchSshKey(id)`; `team(teamId)` → `{id, name} | null`; `SessionHeaders.name` (the name from the IdP). `ApiKeyRecord` + `rotatedAt: Date | null`.
- **Key rotation** cuts SSH: `UPDATE OF secret_hash` of a live key sends `NOTIFY sbx_ssh_revoke 'key:<key_…>'` (migration `0303_api_key_rotation.sql`, column `identity.api_keys.rotated_at`), and `ssh/authorize` (login and `recheck`) refuses a key's login certificate issued before the rotation (`validBefore − 10 min < rotatedAt`; with no readable `validBefore` — refused). S8 sends the same payload from a hook and stores `rotatedAt`.
- Environments live in the same place (`identity.environments`, the interface `EnvironmentStore`).
- `ConfigReader` is extended with the methods `templates()` and `sizes()`: `/templates`, `/sizes`, and `/limits` are built from the config catalog. `PayloadConfigReader` (S8) must implement them.

### 23.11 Additions to S6 (§20.2)

Done in `packages/core`, `packages/config`, `apps/worker`, and the migrations `0204_s7_core_additions.sql`, `0205_sandboxes_updated_at.sql` (the S6 range):
- item 1 — `getEnv`, `replaceEnv`, `patchEnv` (instead of the single `updateEnv`), with limits checked on the result;
- item 2 — `createCommandWithKey`, `markCommandRunning`, `listCommands`, `getCommand`; in `commands` — `user`, `tags`, `argv`, `pid`, `created_by_key` (`0204`);
- item 3 — `hostPort(p, id, port, {access, hostRewrite, appProtocol})` with `PUT` semantics (options not passed are defaults; changing only options does not raise `authEpoch`), `listHostedPorts`; in `hosted_ports` — `host_rewrite`, `app_protocol`, `blocked`, `block_reason`; in `sandboxes` — `blocked`, `block_reason`, and `NOTIFY sbx_routes` on a block change (`0204`); `RouteTarget`/`SshTarget` with the S4 fields;
- item 4 — `rename`: port labels, `authEpoch + 1`; a revoked row stays under the old label so that the epoch of the same label does not repeat;
- item 5 — `teamUsage` (without the `warm` counter, §23.1);
- item 6 — `getSavedSnapshot`, `listSavedSnapshots` with `creating` and `failed` from the last day;
- item 9 — `Principal` with `kind`, `role`, `isOperator`;
- item 10 — the worker cleanup deletes `port_auth_codes` older than a day (the table is `0301`);
- item 11 — `claimIdempotencyKey` stores `response` (for commands — `{commandId}`); create accepts `{hashBody, resolveSets}`;
- the `updatedAt` of the Sandbox resource is the column `sandboxes.updated_at` with a trigger (`0205`);
- `failCommandStart(commandId)` — `starting` → `failed_to_start` with one conditional UPDATE (the first writer wins); `waitForState(..., signal)` — cancelling the wait (removes LISTEN and polling);
- `parseLabel` accepts `<slug>-desktop` (`kind: desktop`) for S4; `TemplateConfig` + `name`, `loginUser`, `capabilities`; `PlatformDefaults` + `publicPortsEnabled`, `ssoPortPolicy`, `ssoPolicyEpoch`.

Items 7, 8, 12, and 13 were already in S6. The numbers `0204`–`0205` are taken by S7 in the runtime range (`0200–0299`: S6 and runtime table changes from S7, the ranges are in `docs/roadmap.md`). The columns `reason` and `output_truncated` in `commands` are an exception, `0304` (§23.3).

### 23.12 Local stack

`deploy/compose` (decision 13): Keycloak 26.8.1 with the realm `sbx` from `keycloak/realm-sbx.json` (clients `oauth2-proxy`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker`), oauth2-proxy (alpha config), one-shot `secrets-init` and `keycloak-db`, `api`, and the S4 gateway via `include`. Host ports are fixed (8080, 9091, 8180, 4180). In the dev realm `verifyEmail` is off and the test user is verified; `api` still requires `email_verified`. There is no automated test with a real Keycloak (decision 13: a smoke under `SBX_KEYCLOAK_TEST=1`): the authentication tests run on its own OIDC server (`@sbx/api/testing`), and the realm, login through oauth2-proxy, and the `sbx-cli` device grant were checked by a manual compose smoke test. Connecting S7 to the dev control plane (CT 590, `infra/dev-cp`) was not run on the CT — only verified locally; what to check is in `infra/dev-cp/README.md`. `SBX_SSH_PORT` follows `GATEWAY_SSH_PORT` by default; changing `SBX_SBX_DOMAIN`/`SBX_SSH_HOST` requires the same value in the gateway override (`SBX_GATEWAY_SBX_DOMAIN`, `SBX_GATEWAY_SSH_HOST`). The template capabilities in the config are a closed set `exec`, `files`, `ssh`, `desktop` (a typo is a load error). The descriptions in OpenAPI do not reference spec sections. Details — `deploy/compose/README.md`, running `api` without Docker and the variables — `apps/api/README.md`.
