> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S7 Public API v1, SDK, CLI: implementation plan

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, a review by a fresh subagent after each task) and superpowers:test-driven-development. Steps are `- [ ]` checkboxes.

**Goal:** implement the S7 MVP per `docs/specs/s7-public-api.md`: `apps/api` (three listeners, all `/v1` resources, internal gateway endpoints), `packages/auth`, OpenAPI 3.1, `@sbx/sdk` (TS), `sbx-sdk` (Python), the `sbx` CLI on Bun, the services `api`, Keycloak, and oauth2-proxy in `deploy/compose`.

**Architecture:** `apps/api` is Hono + `@hono/zod-openapi` on Node; routes call `SandboxService` from `packages/core` (S6) and the agent through the `AgentApi` interface (a fake until the S3 merge, the file part through `AgentClient.fetch`). Identities (users, teams, keys, SSH keys) are the `IdentityStore` interface from `packages/auth` with a temporary Postgres implementation until S8. OpenAPI is generated from the zod schemas and committed; the TS SDK (`openapi-typescript` + `openapi-fetch`) and the Python one (`openapi-python-client`) are built from it, the CLI runs on the TS SDK.

**Stack:** Node 26.13.0 (type stripping, `.ts` imports), TypeScript 7, vitest 5, biome 2.6.4, Bun 1.4.4 (CLI), Python 3.15.2 + uv 0.13.6 (Python SDK). Libraries (checked with `npm view` / PyPI 2026-10-30): `hono` 4.13.14, `@hono/zod-openapi` 1.6.3, `zod` 4.6.7, `@hono/node-server` 2.1.5, `ws` 8.22.0 / `@types/ws` 8.18.2, `@scalar/hono-api-reference` 0.12.16, `rate-limiter-flexible` 11.2.3, `pino` 10.4.0, `prom-client` 15.1.3, `jose` 6.2.14, `ulid` 3.0.2, `yaml` 2.9.1, `tar-stream` 3.2.2 (tests only), `ajv` 8.20.0 + `ajv-formats` 3.0.1 (tests), `openapi-typescript` 7.13.0, `openapi-fetch` 0.17.0, `commander` 15.0.0; Python: `openapi-python-client` 0.29.1, `httpx` 0.28.1, `attrs` 26.1.0, `websockets` 17.3, `pytest` 9.2.0, `pytest-asyncio` 1.4.1, `ruff` 0.17.3. Keycloak 26.8.1, oauth2-proxy v7.15.5, Postgres 18.6.

**Specification:** `docs/specs/s7-public-api.md` (source of truth; the § below are from it). Related: S6 (`packages/core`, §14), S2 §8.4, §9 (`@sbx/agent-client`), S3 §9–§13 and `proto/sbx/agent/v1` on the branch `s3-impl`, S4 §6.1, §8.4, §9.2 and `services/gateway/internal/cpapi` in `s4-impl`, S8 §5, §10.2, §17.1 (C1–C10), S11 §16.1, `docs/architecture.md` §10.

## Global constraints

- Tools only via mise (`mise exec -- <cmd>`). Before adding a dependency — `npm view <pkg> version`; versions above.
- Packages in the S6 style: `"exports": {".": "./src/index.ts"}`, tsconfig like `apps/worker` (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`), scripts `test` (`vitest run`), `typecheck`, `build` if needed. No `enum`, `namespace`, parameter properties. The process is started with `node src/main.ts`.
- New packages: `packages/auth` (`@sbx/auth`), `apps/api` (`@sbx/api`), `packages/sdk-ts` (`@sbx/sdk`), `apps/cli` (`@sbx/cli`, binary `sbx`), `packages/sdk-py` (`sbx-sdk`). In root files — only your own lines.
- Migrations: S7 — `db/migrations/03NN_*.sql`; changes to S6 tables — in the S6 range (`0204_*`), as §20.2 allows. Plain SQL without `BEGIN/COMMIT`.
- Public IDs — §5.3, only through the `@sbx/auth` codecs. Inside `api` everything is UUID/ULID; encoding is at the HTTP boundary.
- Errors are always `{error:{code,message,retryable,details,requestId}}` + the `Request-Id` header (§5.5), on any listener and status. Internal gateway endpoints additionally put `code` at the top level of the body (S4 `cpapi` reads `{"code": "route_not_found"}`).
- Secrets (env, secrets, secretFiles, an API key secret, a port token, an SSO code, a bearer, the CA private key) do not get into logs, metrics, `GET` responses, URLs. pino `redact`: `req.headers.authorization`, `*.env`, `*.secrets`, `*.secretFiles`, `*.secret`, `*.token`, `*.code`, `*.contentBase64`.
- **`failFast` and `pool_exhausted` are not part of the public contract** (Ilia's decision: no warm pool in the MVP). The create schema does not contain them: `failFast` in the body is `400 validation` (unknown field). There is no `warmAvailable` in `/limits`. The code `pool_exhausted` does not enter the HTTP table (if core throws it — `500 internal`).
- `Operation.request` is never returned outward (it holds `bodyHash`). `reprovision` operations are not returned outward: `activeOperation` is `null`, `GET /operations/{id}` is `404`.
- `waitForState` in core has no access check: `api` always reads the resource first via `get` with the principal.
- Postgres in tests — the global setup `@sbx/db/testing/global-setup` (like S6). Run nothing on `pve`.
- Do not edit S2 code (`libs/tunnel`, `packages/agent-client`). S6 code is edited only to the extent of §20.2 and task 3.
- Code comments in English. Commits without `Claude-Session:` and claude.ai links.

## Implementer's decisions (deviations and spec clarifications)

1. **The warm pool and `failFast` are hidden** (Ilia's decision). The spec is edited in task 23: §5.5 (`pool_exhausted`), §8.2, §13 (`warmAvailable`), §14.2 (`--fail-fast`), §15.4, §16, §17.5 are marked "phase 2".
2. **`IdentityStore` until S8 is `PgIdentityStore`** in `packages/auth` (schema `identity`, migration `0300`) with YAML loading (`SBX_IDENTITY_FILE`: users, teams, members, keys by sha256) at startup, a JIT user with a personal team, and `NOTIFY sbx_identity`. A static read-only implementation is not needed: compose must be able to issue keys. S8 will replace it with `PayloadIdentityStore`; the `IdentityStore` contract test suite lives in `packages/auth/test/contract.ts` and is exported (`@sbx/auth/testing`). Environments are stored in the same place (`identity.environments`) behind the `EnvironmentStore` interface — until S8.
3. **Agent.** There is no Go fake `agentv1fake` and no `tunnelharness -agent fake-v1` (§16): S3 is in progress. Agent RPC goes through the `AgentApi` interface (task 8) with a TS fake that runs real processes. The real `ConnectAgentApi` is wired when master says so (after the S3 merge); until then in the `api` process the RPC methods answer `503 agent_unavailable`, while `/files/*` already go through `AgentClient.fetch`. The stream chaos test (§16) runs at the level of `api` and the SDK: attach breaks of the fake, stopping the `api` process and the SDK reconnecting to a second instance; chaos through the tunnel comes after S3 is wired in.
4. **Agent events** (`/internal/v1/agent-events`): the body is a binary protobuf `AgentEventsRequest` (`@sbx/proto`); the `Any` payload is parsed by a type registry. S3 types are not in `main` yet: a payload of a known JSON-compatible form (`google.protobuf.Struct`/`Value`) is parsed, the rest is saved as `{"@type": typeUrl}`; full parsing comes with S3.
5. **Cursors** are an `api` wrapper over the core cursor: `base64url(JSON{c: <core cursor>}) + "." + HMAC-SHA256(SBX_API_CURSOR_KEY)` truncated to 16 bytes; a forgery → `400 invalid_cursor`.
6. **The slug dictionary** stays the core dictionary (~300 words, 2.7·10⁷ combinations, then four words); replacing it with 1 500 words comes later.
7. **Environment in the Sandbox resource** is always `null`, `excludeOwnerSecrets` is `false`: the columns for them are an S6 S1 change from S8 §10.3. The environments themselves (CRUD and applying on create: environment sets, with request sets on top) work.
8. **S8 C1–C10.** Done here: C1 (environments, see item 7), C2 (`PATCH /env`), C4 (`?team=` on proxied for `GET`/`HEAD`/WebSocket), C6 (`isOperator` only for a session; `ssh/authorize` without an operator exception), C7 (`routes.lookup` reads `publicPortsEnabled`/`ssoPortPolicy`/`ssoPolicyEpoch` from `ConfigReader` without a cache; the sso `authEpoch` = `auth_epoch + ssoPolicyEpoch`), C8 (`user_disabled`), C9 (a registry of open streams and PTYs, closed on `NOTIFY sbx_identity`), C10 (Keycloak JWT, `/meta.oidc`). Not done (S8): C3 (operator endpoints and blocks — the `blocked`/`block_reason` columns exist, the endpoints do not), `PayloadIdentityStore`, `PayloadConfigReader`.
9. **The desktop (S10 §13)** is not here: the `desktop` scope and the endpoints will be added by S10. The `routes.lookup` response contains `kind: "port"`.
10. **SSH certificate** — our own OpenSSH certificate encoder (`ssh-ed25519-cert-v01@openssh.com` and other user key types, ed25519 CA signature via `node:crypto`), without `sshpk`. Checked in tests with `ssh-keygen -L` and our own parsing.
11. **Python SDK in the MVP** (§19 leaves it): a generated client + the `Sbx`/`AsyncSbx` facades with the same set of helpers, except `pty` (WebSocket) and `uploadDir`/`downloadDir` — those come to Python later, recorded in task 23.
12. **`sbx mcp`** is a stub: it prints "implemented by S11" and exits with code `1`; S11 replaces the handler.
13. **Keycloak in compose** — the realm `sbx` imported from `deploy/compose/keycloak/realm-sbx.json` (clients `oauth2-proxy`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker`, the scope `groups`, the lifetimes of architecture §10). The client secrets of `oauth2-proxy`/`sbx-worker`, the cookie secret, service tokens, the cursor key, and the SSH login CA are generated by the one-shot service `secrets-init` on first start in that `deploy/compose/secrets/`. Authentication tests run on our own OIDC server with JWKS (`@sbx/api/testing`), Keycloak is checked by a smoke test under the flag `SBX_KEYCLOAK_TEST=1`. **Implementation result:** the test under `SBX_KEYCLOAK_TEST=1` was not written; the realm, login via oauth2-proxy, and the `sbx-cli` device grant were checked by a manual compose smoke test (`deploy/compose/README.md`, "First login"), see spec §23.12.

## Review Focus

1. **A repeated `POST /commands` with the same `Idempotency-Key` while the first request is still waiting for `Start` or streaming.** Expectation: one command at the agent, the second response is the same command (`replayed: true` in the `started` frame), without `idempotency_key_reused`. Test — task 9.
2. **Another team's command by ID from a different team (IDOR) on every endpoint**, including the `commandId` of a foreign sandbox inside one's own sandbox in the path, `uploadId`, `operationId`, a snapshot name, a port. Expectation: `404 not_found`, nothing changes. Test — task 19 (matrix) and targeted ones in tasks 9, 11.
3. **UTF-8 at chunk boundaries and `encoding: base64`**: a character split between agent frames, a break after the first half, and a reattach with `nextOffset`. Expectation: text byte for byte, `nextOffset` on a character boundary. Test — task 9 (decoder unit + integration with a fake that delivers 1 byte at a time).
4. **A key revoked during an open stream or PTY.** Expectation: the stream gets an `error {code: unauthorized, retryable: false}` frame, the PTY — close `4401`, no later than a second after `NOTIFY sbx_identity`. Test — tasks 9 and 10.
5. **SIGTERM of an `api` pod in the middle of `sync`, `stream`, and PTY.** Expectation: the stream — a `reconnect {reason: server_shutdown}` frame, the PTY — a `reconnect` frame and close `1012`, sync — `503 server_shutting_down` (`retryable` only with `Idempotency-Key`), the process exits ≤ 10 s. Test — task 18.

---

### Task 1: `packages/auth` — IDs, keys, scopes, bearer, the `IdentityStore` interface

**Files:**
- Create: `packages/auth/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/ids.ts`, `src/api-key.ts`, `src/scopes.ts`, `src/bearer.ts`, `src/identity.ts`
- Modify: `packages/core/src/principal.ts` (`SCOPES`, `Scope` are re-exported from `@sbx/auth`), `packages/core/package.json`
- Test: `packages/auth/test/{ids,api-key,scopes,bearer}.test.ts`

**Interfaces:**
- Produces:
  - `ID_PREFIXES = {sandbox:"sb", operation:"op", command:"cmd", snapshot:"snap", apiKey:"key", sshKey:"sshk", environment:"env", user:"usr", team:"team", upload:"upl", request:"req"} as const`; `type IdKind = keyof typeof ID_PREFIXES`.
  - `encodeUuid(kind: IdKind, uuid: string): string` (26 characters of lowercase Crockford base32 of 128 bits; the top 2 bits are zero); `decodeUuid(kind, publicId: unknown): string | null` (a lowercase UUID; any case on input; a wrong prefix/length/alphabet/overflow → `null`).
  - `encodeUlid(kind, ulid: string): string` (`cmd_` + the ulid in lowercase); `decodeUlid(kind, publicId): string | null` (an uppercase ULID); `newPublicUlid(kind): string`.
  - `SCOPES` (14 strings, the order as in `packages/core/src/principal.ts`), `type Scope`, `isScope(s): s is Scope`, `PRESETS: Record<"read-only"|"ci"|"full", readonly Scope[]>` (§7.3), `SANDBOX_SELF_PRESET` (reserved, not issued).
  - `API_KEY_RE = /^sbx_[0-9A-Za-z]{49}$/`; `generateApiKeySecret(): string` — `sbx_` + base62(32 random bytes, left-padded with `0` to 43) + base62(`zlib.crc32("sbx_" + body)`, to 6); `isWellFormedApiKey(s): boolean` (format and CRC); `apiKeyHash(secret): string` (sha256 hex); `apiKeyDisplay(secret): {prefix: string /*8 characters after sbx_*/; last4: string}`.
  - `classifyBearer(token: string): "team_key" | "reserved" | "jwt" | "invalid"` (`sbx_` → team_key, `sbxs_` → reserved, three non-empty base64url parts → jwt).
  - `IdentityStore` types (§17.3) + records: `UserRecord {id, email, name: string|null, active, isOperator, idpSubject: string|null, defaultTeamId: string|null}`, `TeamMembership {teamId, name, role: "owner"|"member"}`, `SessionIdentity {user: UserRecord; teams: TeamMembership[]; defaultTeamId: string|null; isOperator: boolean}`, `SessionHeaders {email, user?, groups: string[], preferredUsername?, name?}`, `ApiKeyCreator {id, email, active, member}`, `ApiKeyRecord {id, kind:"team", sandboxId:null, teamId, name, secretHash, prefix, last4, scopes: Scope[], createdBy: ApiKeyCreator|null, createdVia: "api"|"cli"|"dashboard", createdAt: Date, expiresAt: Date, lastUsedAt: Date|null, revokedAt: Date|null}`, `NewApiKey {teamId, name, scopes, expiresAt, createdByUserId, createdVia, secretHash, prefix, last4}`, `SshKeyRecord {id, userId, name, publicKey, fingerprint, type, createdAt, lastUsedAt}`, `NewSshKey {userId, name, publicKey, fingerprint, type}`. Methods — §17.3 plus `team(teamId): Promise<{id,name}|null>`, `rotateApiKey(id, s: {secretHash, prefix, last4}): Promise<ApiKeyRecord>`, `touchSshKey(id): Promise<void>`. Errors: `class IdentityError extends Error {code: "user_disabled"|"fingerprint_taken"|"not_found"|"name_taken"}`.

- [ ] **Step 1: tests.** `ids.test.ts`: a known vector (`encodeUuid("sandbox","00000000-0000-0000-0000-000000000000") === "sb_" + "0".repeat(26)`, `ffffffff-…` → `"sb_7zzzzzzzzzzzzzzzzzzzzzzzzz"`), a round trip of 1000 random UUIDv7 and time ordering (the `encodeUuid` of two uuidv7 1 ms apart compare as strings), uppercase is accepted, `sb_` with 27 characters/`8zzz…` (overflow)/`i`,`l`,`o`,`u` → `null`, a foreign prefix (`op_` for a sandbox) → `null`. `api-key.test.ts`: `API_KEY_RE` matches 1000 generated ones, length 53, `isWellFormedApiKey` catches a changed last character of the body, `apiKeyDisplay` gives 8 and 4 characters. `scopes.test.ts`: the presets of §7.3 literally, `full` = `SCOPES`, `SCOPES` from `@sbx/core` is identical. `bearer.test.ts`: the four classes.
- [ ] **Step 2: run — FAIL** (`mise exec -- pnpm --filter @sbx/auth test`).
- [ ] **Step 3: implement the modules;** `core/src/principal.ts` re-exports `SCOPES`, `Scope` from `@sbx/auth` (nothing else changes).
- [ ] **Step 4: run auth and core — PASS;** `pnpm --filter @sbx/core typecheck`.
- [ ] **Step 5: commit** `auth: public ids, team key format, scopes, IdentityStore types`.

### Task 2: `packages/auth` — SSH keys and certificates

**Files:**
- Create: `packages/auth/src/ssh.ts`
- Test: `packages/auth/test/ssh.test.ts`

**Interfaces:**
- Produces:
  - `parseSshPublicKey(line: string): {type: SshKeyType; blob: Buffer; comment: string|null; fingerprint: string}` — types `ssh-ed25519`, `ecdsa-sha2-nistp256|384|521`, `ssh-rsa` (modulus ≥ 3072 bits); certificates (`*-cert-v01@openssh.com`), DSA, `sk-*`, short RSA → `SshKeyError {reason}`. `fingerprint` = `"SHA256:" + base64(sha256(blob))` without `=`.
  - `loadSshCa(pemOrOpenSsh: string): SshCa` — a private ed25519 key (PKCS#8 PEM or OpenSSH `-----BEGIN OPENSSH PRIVATE KEY-----` without a password); `SshCa.publicKey: string` (the string `ssh-ed25519 AAAA…`).
  - `signUserCertificate(ca: SshCa, input: {publicKey: string; keyId: string; principals: string[]; validAfter: Date; validBefore: Date; serial?: bigint}): {certificate: string /* "<type>-cert-v01@openssh.com AAAA… keyId" */; serial: bigint}` — the PROTOCOL.certkeys format, `CertType` 1 (user), extensions `permit-X11-forwarding`, `permit-agent-forwarding`, `permit-port-forwarding`, `permit-pty`, `permit-user-rc` in lexicographic order, critical options empty, serial — 8 random bytes.
  - `parseUserCertificate(line): {keyId, principals, serial, validAfter, validBefore, signatureKey: string}` (for tests and `ssh-cert --ensure`).
  - `loadSshHostKeys(text): string[]` — public key lines from `SBX_SSH_HOST_KEYS_FILE` (private ones → an error).

- [ ] **Step 1: tests.** Generate keys with `ssh-keygen -t ed25519|ecdsa -b 384|rsa -b 3072|rsa -b 2048` in a temporary directory (skip if `ssh-keygen` is absent): the fingerprint matches `ssh-keygen -lf`; RSA 2048 is rejected; a certificate string is rejected. A signed certificate: `ssh-keygen -L -f cert.pub` exits 0 and prints `Key ID: "sbx:user:usr_…"`, `Principals: sb_…`, `Valid: from … to …`; an `ssh-keygen -Y`-like check is not needed — our own `parseUserCertificate` verifies the CA signature via `crypto.verify`. Tampering with a byte in the body → the signature check fails.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `auth: ssh public keys and login certificates`.

### Task 3: additions to `packages/core`, `packages/config`, migration `0204` (§20.2)

**Files:**
- Create: `db/migrations/0204_s7_core_additions.sql`, `packages/core/src/service/env.ts`, `packages/core/src/service/rename.ts`, `packages/core/src/usage.ts`
- Modify: `packages/core/src/service/{commands,ports,snapshots,read,index}.ts`, `packages/core/src/{rows,routes}.ts`, `packages/config/src/{types,static}.ts`, `apps/worker/src/controllers/cleanup*.ts` (deleting `runtime.port_auth_codes` older than a day, if the table exists)
- Test: `packages/core/test/s7-additions.test.ts`, `packages/config/test/static.test.ts`

**Interfaces:**
- Migration 0204: `commands` + `user text NOT NULL DEFAULT 'user'`, `tags jsonb NOT NULL DEFAULT '{}'`, `argv jsonb`, `pid int`; `hosted_ports` + `host_rewrite text NOT NULL DEFAULT 'preserve' CHECK (… IN ('preserve','localhost'))`, `app_protocol text NOT NULL DEFAULT 'http1' CHECK (… IN ('http1','h2c'))`, `blocked boolean NOT NULL DEFAULT false`, `block_reason text`; `sandboxes` + `blocked boolean NOT NULL DEFAULT false`, `block_reason text`. Index `commands (sandbox_id, status)`.
- `@sbx/config`: `TemplateConfig` + `name: string` (default the slug), `loginUser: string` (`"user"`), `capabilities: string[]` (`["exec","files","ssh"]`); `PlatformDefaults` + `publicPortsEnabled: boolean` (`true`), `ssoPortPolicy: "any"|"team"` (`"any"`), `ssoPolicyEpoch: number` (`0`).
- `@sbx/core` (`SandboxService` methods and exports):
  - `CommandSpec` + `user?: string` (default `"user"`), `argv?: string[]|null`, `tags?: Record<string,string>`; `Command` + `user`, `argv: string[]|null`, `tags`, `pid: number|null`.
  - `createCommandWithKey(p, idOrSlug, spec: CommandSpec, idemKey: string, requestBody: unknown): Promise<{command: Command; replayed: boolean}>` — scope `commands.create`, hash `requestHash(keys, "commands.create", {sandbox: <uuid>, body: requestBody})`, an `idempotency_keys` row with `response = {"commandId": …}`; a retry on another sandbox or with a different body → `idempotency_key_reused`. A retry when the sandbox is no longer `ready` still returns the command.
  - `markCommandRunning(commandId: string, pid: number|null): Promise<void>` (`starting` → `running`, `started_at`).
  - `listCommands(p, idOrSlug, filter: {status?: CommandStatus[]; mode?: CommandMode; limit?: number}, cursor?: string): Promise<Page<Command>>` (newest first; works in any state except `deleted`); `getCommand(p, idOrSlug, commandId): Promise<Command>` (a foreign sandbox or a command of another sandbox → `not_found`).
  - `hostPort(p, idOrSlug, port, mode: PortMode | HostPortOptions)` where `HostPortOptions = {access: PortMode; hostRewrite?: "preserve"|"localhost"; appProtocol?: "http1"|"h2c"}`; result + `created: boolean`; the same settings → no change; changing only `hostRewrite`/`appProtocol` → `UPDATE` without `auth_epoch+1`. `HostedPort` + `hostRewrite`, `appProtocol`, `blocked`, `blockReason`. `listHostedPorts(p, idOrSlug): Promise<HostedPort[]>`.
  - `rename(p, idOrSlug, slug): Promise<Sandbox>` — `validateSlug`, `deleting`/`deleted` → `invalid_state`, a taken one → `slug_taken`, `hosted_ports.label` of all live ports and `auth_epoch + 1` in the same transaction.
  - `teamUsage(q: Queryable, teamId): Promise<{activeSandboxes: number; ramMb: number; savedSnapshots: number}>` — the `checkQuota` rules.
  - `getSavedSnapshot(p, name): Promise<SavedSnapshot>` (`ready` with `name`, otherwise `creating` with `pending_name`, otherwise `snapshot_not_found`); `listSavedSnapshots` also returns `failed` with `created_at > now() - 1 day`.
  - `getEnv(p, idOrSlug): Promise<SecretSets>`; `replaceEnv(p, idOrSlug, input: {env?; secrets?; secretFiles?: SecretFile[]}): Promise<{sandbox: Sandbox; sets: SecretSets}>` (a passed field replaces the whole set); `patchEnv(p, idOrSlug, patch: SecretPatch): Promise<{sandbox; sets}>`; both — `validateSecretSets` on the result, not in `deleting`/`deleted`.
  - `waitForOperation(id: string, timeoutMs: number): Promise<Operation>` — until a terminal state (`succeeded|failed|superseded`) via `NOTIFY sbx_operations '<id>'` and a fallback poll, like `waitForSandboxState`; without an access check.
  - `RouteTarget` + `teamId`, `hostRewrite`, `appProtocol`, `blocked` (`hosted_ports.blocked OR sandboxes.blocked`), `blockReason`; `SshTarget` + `teamId`, `slug`, `templateSlug`.

- [ ] **Step 1: tests** in `s7-additions.test.ts`, one `it` per method: a repeated `createCommandWithKey` gives the same row and `replayed: true`, a different body → `idempotency_key_reused`, 5 parallel calls with one key → one `commands` row; `rename` changes the port label `old-3000` → `new-3000` and `auth_epoch` +1, `NOTIFY sbx_routes` arrives with the old and new slug; `hostPort` with `{access:"token", hostRewrite:"localhost"}` and a repeat with the same → `created:false`, without a token; `getSavedSnapshot` for `creating`; `listSavedSnapshots` shows a `failed` one from an hour ago yesterday and does not show a two-day-old one; `patchEnv` with `{secrets:{A:null}}` deletes the key; `waitForOperation` returns on an UPDATE to `succeeded` before the timeout; `teamUsage`. `static.test.ts`: the defaults of the new fields.
- [ ] **Step 2: FAIL.** **Step 3: implementation.** **Step 4:** `pnpm --filter @sbx/core --filter @sbx/config --filter @sbx/worker test` — PASS (old S6 tests do not break).
- [ ] **Step 5: commit** `core: S7 additions (command idempotency, ports options, rename, env, usage, snapshots, waitForOperation)`.

### Task 4: `PgIdentityStore`, migrations `0300`/`0301`, contract suite

**Files:**
- Create: `db/migrations/0300_identity_standin.sql`, `db/migrations/0301_port_auth_codes.sql`, `packages/auth/src/pg-store.ts`, `packages/auth/src/seed.ts`, `packages/auth/src/environments.ts`, `packages/auth/test/contract.ts`, `packages/auth/src/testing.ts` (export `"./testing"`)
- Test: `packages/auth/test/pg-store.test.ts`, `packages/auth/test/environments.test.ts`

**Interfaces:**
- 0300: schema `identity`: `users(id uuid pk, email citext-like text unique (lower), name, active bool, is_operator bool, idp_subject text unique null, default_team_id uuid, created_at)`, `teams(id uuid pk, name, created_at)`, `memberships(user_id, team_id, role check owner|member, pk(user_id,team_id))`, `api_keys(id uuid pk, kind text default 'team', sandbox_id uuid null, team_id, name, secret_hash text unique, prefix, last4, scopes text[], created_by uuid null, created_via, created_at, expires_at not null, last_used_at, revoked_at, revoked_by uuid, revoked_by_key uuid)`, `ssh_keys(id, user_id, name, public_key, fingerprint unique, type, created_at, last_used_at)`, `environments(id uuid pk, team_id, name, is_default bool, revision int, key_version, nonce, ciphertext, repositories jsonb, exclude_owner_secrets bool, created_at, updated_at, updated_by uuid, unique(team_id,name))` + a partial unique index of one default per team. Triggers `NOTIFY sbx_identity '<table>:<id>'` on `users`, `memberships`, `api_keys`, `ssh_keys`.
- 0301: `runtime.port_auth_codes` exactly per §12.2 + an index on `created_at`.
- `class PgIdentityStore implements IdentityStore` — `constructor(opts: {pool: pg.Pool; operatorGroups: string[]})`. `resolveSession`: lookup by `idp_subject = user`, otherwise by email (then bind `idp_subject`); none — create a user (`name` from `name ?? preferredUsername`) and a personal team `"<email>'s team"` with the role `owner`; `is_operator` = the intersection of `groups` and `operatorGroups` (updated on every call); `active = false` → `IdentityError("user_disabled")`.
- `seedIdentity(pool, yamlText)` — an idempotent upsert from YAML: `users[{id, email, name?, active?, teams: {<teamId>: owner|member}}]`, `teams[{id, name}]`, `apiKeys[{id, teamId, name, sha256, scopes|preset, expiresAt}]`. The YAML schema is zod strict.
- `interface EnvironmentStore` + `PgEnvironmentStore(pool, keys: KeyRing)`: `list(teamId)`, `get(teamId, idOrName)`, `getDefault(teamId)`, `create(teamId, input, byUserId|null)`, `patch(teamId, idOrName, patch, by)`, `delete(teamId, idOrName)`; a record is `{id, teamId, name, isDefault, revision, sets: SecretSets, repositories, excludeOwnerSecrets, createdAt, updatedAt, updatedBy}`; encryption `keys.encryptFor("environment", id, sets)`; `name_taken` on a duplicate.
- `runIdentityStoreContract(name: string, make: () => Promise<IdentityStore & {seedUser…}>)` — an exported `describe` suite for S8.

- [ ] **Step 1: tests.** Contract: JIT by `sub` creates a user and a personal team, a second call with the same `sub` and a new email — the same user; a deactivated one → `user_disabled`; `findApiKeyByHash` finds it, a revoked one is returned with `revokedAt` (the 401 decision is in api); `addSshKey` with a taken fingerprint → `fingerprint_taken`; `membership` of another team → `null`; `listApiKeys` returns `createdBy.member=false` after the member is removed. Trigger: `LISTEN sbx_identity` receives `api_keys:<id>` on revoke. Seed twice — the same rows. Environments: create/patch (merge, `null` deletes)/the single default/the ciphertext does not contain the value.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `auth: Postgres identity store stand-in, seed, environments, contract suite`.

### Task 5: `apps/api` — skeleton: config, errors, Request-Id, listeners, meta, OpenAPI

**Files:**
- Create: `apps/api/{package.json,tsconfig.json,vitest.config.ts}`, `src/settings.ts`, `src/deps.ts`, `src/app.ts`, `src/http/{errors,request-id,body-limit,logger,metrics}.ts`, `src/routes/meta.ts`, `src/openapi/{registry,document}.ts`, `src/testing/index.ts` (export `"./testing"`), `scripts/openapi.ts`, `openapi/v1.json`
- Test: `apps/api/test/{errors,meta,openapi-drift}.test.ts`, `apps/api/test/helpers/{harness,conformance}.ts`

**Interfaces:**
- `loadSettings(env: NodeJS.ProcessEnv): Settings` (zod): `SBX_API_PUBLIC_PORT=8080`, `SBX_API_PROXIED_PORT=8081`, `SBX_API_INTERNAL_PORT=8082`, `SBX_API_METRICS_PORT=9090`, `DATABASE_URL`, `SBX_CONFIG_FILE`, `SBX_DATA_KEYS_FILE`, `SBX_API_CURSOR_KEY` (≥ 32 bytes base64), `SBX_API_SERVICE_TOKENS_FILE`, `SBX_IDENTITY_FILE?`, `SBX_OPERATOR_GROUPS` (csv), `SBX_OIDC_ISSUER?`, `SBX_OIDC_DISCOVERY_URL?`, `SBX_OIDC_JWKS_URL?` (overrides `jwks_uri` from discovery: in compose `api` reaches Keycloak at `http://keycloak:8080`, while `iss` is the public `http://localhost:8180/realms/sbx`), `SBX_OIDC_AUDIENCE=sbx-api`, `SBX_OIDC_ALLOWED_CLIENTS=sbx-cli,sbx-mcp`, `SBX_APP_ORIGIN`, `SBX_API_URL`, `SBX_APP_URL`, `SBX_SBX_DOMAIN`, `SBX_SSH_HOST=ssh.<domain>`, `SBX_SSH_PORT=22`, `SBX_SSH_HOST_KEYS_FILE?`, `SBX_SSH_LOGIN_CA_KEY_FILE?`, `SBX_API_TRUSTED_PROXY_CIDRS`, `SBX_API_RATE_RPS=20`, `SBX_API_RATE_BURST=100`, `SBX_API_RATE_STARTS_PER_MIN=30`, `SBX_API_MAX_STREAMS=100`, `SBX_MIN_CLI_VERSION`, `SBX_LATEST_CLI_VERSION`, `SBX_BUILD`, `SBX_API_PROXIED_ENABLED` (default `true`).
- `interface ApiDeps {settings; svc: SandboxService & S7 additions; pool; config: ConfigReader; identity: IdentityStore; environments: EnvironmentStore; agent: AgentApi; keys: KeyRing; notifier: Notifier; log: pino.Logger; metrics: ApiMetrics; clock: () => number; sshCa: SshCa | null; hostKeys: string[]; oidc: OidcVerifier | null; streams: StreamRegistry; shutdown: ShutdownState}` — fields appear task by task; tests assemble them through `makeTestDeps(over)` in `src/testing`.
- `createPublicApp(deps)`, `createProxiedApp(deps)`, `createInternalApp(deps)` → `OpenAPIHono`; a shared `mountV1(app, deps)` mounts the resources. `GET /v1/openapi.json`, `GET /v1/docs` (Scalar), `GET /v1/meta` without auth on public and proxied. `/healthz`, `/readyz` (Postgres + LISTEN), `/metrics` — on `:9090` (`createOpsApp`).
- `class ApiError extends Error {status; code; retryable; details; headers?}` + factories; `toHttpError(e: unknown): ApiError` — the table of §5.5 for core codes (`not_found` 404, `invalid_state` 409, `operation_in_progress` 409 r, `out_of_capacity` 503 r, `quota_exceeded` 403, `idempotency_key_reused` 409, `template_unavailable` 422, `snapshot_not_found` 404, `sandbox_not_ready` 409, `recover_rate_limited` 429 r, `validation` 400, `slug_taken` 409, `snapshot_name_taken` 409, `agent_unavailable` 503 r, `machine_state_conflict` 409 `invalid_state`, everything else — 500 `internal` with a log); `Retry-After` and `details.retryAfterSeconds` for 429/503. zod errors (`defaultHook`) → `400 validation` with `details.issues[{path,message}]`; invalid JSON → `400 invalid_json`; an unknown route → `404 not_found`; a method → `405`.
- Request-Id: our own `req_<ulid>` per request; an incoming `Request-Id` (≤128 `[A-Za-z0-9._-]`) goes to the log as `clientRequestId`.
- OpenAPI: `operationId` `<resource>.<action>`, security schemes `keycloak` (openIdConnect) and `teamKey` (bearer, `bearerFormat: "sbx_"`), globally `[{keycloak:[]},{teamKey:[]}]`; response enums with `x-extensible-enum`. `pnpm --filter @sbx/api openapi` writes `openapi/v1.json` (sorted, with `\n` at the end).
- `test/helpers/conformance.ts`: `assertConforms(doc, method, path, status, contentType, body)` (ajv 2020 + formats), and `harness.request(...)` calls it for every JSON response.

- [ ] **Step 1: tests.** `errors.test.ts`: every core code from the table → status/`retryable`; `pool_exhausted` → 500 `internal`; any response (a route 404, a JSON 400, a 500) has `error.code/message/retryable/details/requestId` and the `Request-Id` header; `Retry-After` on the 503 `out_of_capacity`. `meta.test.ts`: `/v1/meta` without auth, the fields of §13 (`oidc.clientId === "sbx-cli"`). `openapi-drift.test.ts`: the generated document equals `openapi/v1.json`; every operation has `operationId`, `summary`, `description`; the document has no strings `failFast`, `pool_exhausted`, `warmAvailable`.
- [ ] **Step 2–4.** **Step 5: commit** `api: skeleton, error envelope, listeners, meta, openapi generation`.

### Task 6: authentication and permissions

**Files:**
- Create: `apps/api/src/auth/{principal,public,proxied,internal,oidc,key-cache,scopes,rate-limit,identity-listener}.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/testing/oidc-server.ts`
- Test: `apps/api/test/auth-{public,jwt,proxied,internal,scopes,ratelimit}.test.ts`

**Interfaces:**
- `type AuthContext = {principal: Principal; user: UserRecord | null; apiKey: ApiKeyRecord | null; teams: TeamMembership[]; tokenExpiresAt: Date | null}` in `c.var.auth`.
- Public: strip `X-Auth-Request-*`, `X-Forwarded-User`, `X-Forwarded-Email` before everything; `classifyBearer`; a key: `isWellFormedApiKey` → `apiKeyHash` → `KeyCache` (positive 30 s, negative 5 s, reset on `NOTIFY sbx_identity 'api_keys:<id>'` and `'*'`) → `revokedAt` → 401 `unauthorized`, `expiresAt` → 401 `api_key_expired`; `touchApiKey` no more often than once per 60 s. The key's principal: `kind:"team_key"`, `userId:null`, `role:null`, `isOperator:false`, the key's `scopes`. `Sbx-Team` on a key: not its team → 403 `team_forbidden`.
- `OidcVerifier` (`jose`): discovery → `jwks_uri`, `createRemoteJWKSet` (`cooldownDuration` 30 s, `cacheMaxAge` 10 min), `jwtVerify` with `issuer`, `audience`, `algorithms: ["RS256","ES256"]`, `clockTolerance: 60`; then `typ === "Bearer"`, `azp ∈ allowedClients`, `email_verified === true`. `JWTExpired` → 401 `token_expired`; anything else → 401 `unauthorized`, `details.reason:"invalid_token"`; always `WWW-Authenticate: Bearer realm="sbx", error="invalid_token"`. Then `identity.resolveSession({email, user: sub, groups, preferredUsername})`; `user_disabled` → 403 `forbidden` `details.reason:"user_disabled"`. The principal `kind:"oidc"`, `isOperator:false`, all scopes, `role` from the team.
- Proxied: `Authorization` → 400 `validation`; without `X-Auth-Request-Email` → 401; `Origin === SBX_APP_ORIGIN` for unsafe methods and upgrade, otherwise 403 `origin_forbidden`; a JSON body only with `Content-Type: application/json` (otherwise 415 → `400 validation`); the team — `Sbx-Team` or `?team=` (only `GET`/`HEAD`/upgrade; a mismatch → 400), otherwise `defaultTeamId`; not in the list and not an operator → 403 `team_forbidden`. The principal `kind:"session"`, `isOperator` from `SessionIdentity`.
- Internal: `Authorization: Bearer` from `SBX_API_SERVICE_TOKENS_FILE` (`{"gateway": [t1, t2]}`), comparison `timingSafeEqual` by sha256; otherwise 401.
- `requireScope(scope: Scope)` → 403 `forbidden` `details.requiredScope`; `requireHuman()` → 403 `details.reason:"user_required"`; `requireOwner()` → 403 `details.reason:"role"`.
- Rate limit (`rate-limiter-flexible` memory): the principal key `apiKeyId ?? userId`, 20/s burst 100 → 429 `rate_limited` with `Retry-After`; `RateLimit-Policy: "req";q=100;w=5`, `RateLimit: "req";r=<left>;t=<s>`; starts (`create`/`fork`/`resume`) 30/min per team.
- `GET /v1/me` (§13).
- `startTestOidcServer(): Promise<{issuer; token(claims?, opts?: {alg?, kid?, expiresIn?, typ?}): Promise<string>; rotateKey(): void; deviceFlow: {approve(userCode, claims), deny(userCode)}; close()}>` — discovery, JWKS, `/protocol/openid-connect/{token,auth/device,revoke}` as in Keycloak (for tasks 20–21).

- [ ] **Step 1: tests.** `auth-public`: `X-Auth-Request-Email` without a bearer → 401; a key ok/revoked (401 within ≤1 s after `NOTIFY`)/expired (`api_key_expired`)/corrupted CRC → 401; `sbxs_` → 401. `auth-jwt` (§16 Keycloak JWT): a foreign `iss`, no `aud`, `alg:none`, `HS256`, expired → `token_expired`, `typ:"ID"`/`"Refresh"`, a foreign `azp`, `email_verified:false` → 401; an unknown `kid` re-reads the JWKS once; the first request creates a user, `sub` = the same user as proxied with `X-Auth-Request-User: sub`; a deactivated one → 403 `user_disabled`; without `SBX_OIDC_ISSUER` a JWT → 401. `auth-proxied`: POST without/with a foreign `Origin` → 403; `Authorization` → 400; `?team=` mismatch → 400. `auth-internal`: without a token/a foreign one → 401, the second token from the list is accepted. `auth-scopes`: `requireScope` on a test route. `auth-ratelimit`: the 101st request in a burst → 429 with headers.
- [ ] **Step 2–4.** **Step 5: commit** `api: authentication (team keys, Keycloak JWT, oauth2-proxy, service tokens), scopes, rate limits, /me`.

### Task 7: sandboxes, operations, env, catalog, limits

**Files:**
- Create: `apps/api/src/routes/{sandboxes,operations,env,catalog,limits}.ts`, `apps/api/src/schemas/{common,sandbox,operation,env,catalog,limits}.ts`, `apps/api/src/map/{sandbox,operation}.ts`, `apps/api/src/http/{cursor,idempotency,confirm-delete,wait}.ts`
- Test: `apps/api/test/{sandboxes,operations,env,catalog-limits}.test.ts`, `apps/api/test/helpers/world.ts`

**Interfaces:**
- `toSandboxResource(s: Sandbox, ctx: {settings; template: TemplateConfig|null}): SandboxResource` — §8.1: IDs via codecs, `origin` `{kind}`/`{kind:"snapshot", snapshot, snapshotId}`/`{kind:"fork", sandboxId}` (the snapshot name need not come from `getSavedSnapshot`: `originSnapshotId` + the name are taken in one query), `error {code,message}|null`, `activeOperation` — `null` for `reprovision`, `endpoints {portUrlTemplate:"https://<slug>-{port>.<sbxDomain>", ssh:"ssh <slug>@<sshHost>"}`, `environment:null`, `excludeOwnerSecrets:false`, `createdByKey` → `key_…`, times in ISO with ms. `toOperationResource(op)` — §8.4, without `request`; `error {code,message,retryable}`.
- `encodeCursor(inner: string, key): string`, `decodeCursor(s, key): string` (→ 400 `invalid_cursor`).
- `idempotencyKeyHeader(c): string | undefined` (`validateIdempotencyKey`), a replay response → `Idempotency-Replayed: true` (comparison: the create result with `operation.createdAt` earlier than the request start).
- `requireConfirmDelete(c, resource: {id: string; aliases: string[]})` → 428 `confirmation_required` `details.reason: missing|mismatch`.
- `resolveSandboxRef(ref: string): string` — `sb_…` → UUID (invalid → 404), otherwise the slug as is.
- The endpoints of §6 (sandboxes, operations, env) with the bodies of §8.2, body limits §5.11. create: `environment` (a name/`null`/none) — `EnvironmentStore` → environment sets, with request sets on top, passed to core without `environment`; the scope `snapshots:read` with `from`, `environments:read` with an explicit `environment`. A retry with an active operation of the same kind (`stop`/`resume`/`recover`/`delete`) → `202` with it (core does this itself; `operation_in_progress` of another kind and `reprovision` → 409). `idleTimeoutSeconds` < 60 → 400. `DELETE` on `deleted` → `200 {sandbox, operation: null}`. `GET ?waitFor=&waitSeconds=` (up to 60): first `get` with the principal, then `waitForState(id, waitFor ∪ {error, deleting, deleted}, …)`; `GET /operations/{id}?waitSeconds=` — `getOperation` with the principal, then `waitForOperation`. `PUT /env` and `PATCH /env` → core `replaceEnv`/`patchEnv`, then delivery to the agent (`agent.updateEnv`, `agent.updateSecrets`) if `ready`; the response `{delivered, env, secretKeys, secretFiles[{name,mode,linkPath,sizeBytes}]}`. `PATCH /sandboxes` with `slug` → `rename`. `/v1/templates`, `/v1/sizes`, `/v1/limits` — §13 without `warmAvailable`; disabled templates are seen only by an operator.
- `test/helpers/world.ts`: `apiWorld(pool)` — the S6 topology (copying `createTopology` from the core tests is not needed: an import of `@sbx/core/test/helpers/*` is not exported — add `"./testing": "./test/helpers/index.ts"` to `packages/core/package.json` with `serviceEnv`, `seedSandbox`, `uniqueSlug`), `markReady(sandboxId)`, `markState(id, state)`, `finishOperation(opId, state)`.

- [ ] **Step 1: tests.** create `202 {sandbox, operation}` and `Idempotency-Replayed` on a retry; `failFast` → 400; list with `label=k=v` twice, `state=deleted`, a forged cursor → `invalid_cursor`; the long-poll returns on `markReady` before `waitSeconds`; `DELETE` without the header → 428 `missing`, with a foreign ID → 428 `mismatch`, nothing deleted; a repeated `POST /stop` during `stop` → 202 with the same operation; `operation_in_progress` of another kind → 409 retryable; an active `reprovision` → `activeOperation:null` and `GET /operations/<its id>` → 404; the response never contains `request`/`bodyHash`; env: secret values are not in the response; `PUT /env` with a marker secret — the marker does not appear in captured logs; `idleTimeoutSeconds: 30` → 400; `/limits` without `warmAvailable`.
- [ ] **Step 2–4.** **Step 5: commit** `api: sandboxes, operations, env, catalog, limits`.

### Task 8: agent interface, fake, file adapter

**Files:**
- Create: `apps/api/src/agent/{types,errors,unwired,files-http}.ts`, `apps/api/src/testing/fake-agent.ts`
- Test: `apps/api/test/fake-agent.test.ts`, `apps/api/test/agent-errors.test.ts`

**Interfaces:**
- `interface AgentApi` (fields and semantics — S3 §9–§13, offsets are `number`):
  `capabilities(machineId): Promise<string[]>`; `requireCapability(machineId, cap, signal?)` (throws `AgentOutdatedError`/`AgentUnavailableError` from `@sbx/agent-client`); `start(machineId, {commandId, spec: AgentCommandSpec}, {requestId, signal?}): Promise<{command: AgentCommandInfo; created: boolean}>`; `attach(machineId, {commandId, stdoutOffset, stderrOffset, ptyOffset, tailBytes?, follow?}, signal): AsyncIterable<AgentAttachEvent>`; `sendInput(machineId, {commandId, inputSessionId, seq, data: Uint8Array, closeStdin}, signal?)`; `update(machineId, {commandId, cols, rows})`; `signal(machineId, {commandId, signal})`; `kill(machineId, {commandId, graceMs?})`; `get(machineId, commandId)`; `stat|list|makeDir|move|chmod|remove(machineId, req)`; `listPorts(machineId)`; `updateEnv(machineId, env, requestId)`; `updateSecrets(machineId, {secretEnv, secretFiles}, requestId)`; `files(machineId, path: string, init: AgentFetchInit): Promise<Response>`.
  `AgentCommandSpec {shell?: string; argv?: string[]; cwd: string; env: Record<string,string>; user: string; pty?: {cols, rows, term}; stdin: boolean; timeoutMs: number; tags}`; `AgentCommandInfo {commandId, state: "starting"|"running"|"exited", pid: number|null, exit: {status:"exited"|"killed"|"lost", code, signal, reason}|null, streams: {stdout?, stderr?, pty?: {size, availableFrom, end: number|null}}, startedAt, endedAt}`; `AgentAttachEvent = {type:"data", stream:"stdout"|"stderr"|"pty", offset, data: Uint8Array} | {type:"truncated", stream, availableFrom} | {type:"heartbeat"} | {type:"exit", status, code, signal, reason, stdoutEnd, stderrEnd, ptyEnd, endedAt} | {type:"started", command}`; `reason` — the lowercase S3 values (`none`, `signal`, `timeout`, `oom`, `pty_idle`, `reboot`, `shim_lost`, `start_failed`).
- `class AgentCallError extends Error {code: string /* S3 §11.1: path_not_found, already_exists, not_directory, is_directory, no_space, permission_denied, invalid_path, payload_too_large, cross_device, command_exited, too_many_commands, invalid_argument, not_found, checksum_mismatch, upload_offset_mismatch, upload_not_found, … */; details}`; `agentErrorToHttp(e): ApiError` — `path_not_found` 404, `permission_denied` → 403 `path_forbidden`, `not_directory`/`is_directory`/`cross_device`/`already_exists`/`command_exited` 409, `no_space` 507, `payload_too_large` 413, `invalid_path` 400, `invalid_argument` → 400 `validation`, `too_many_commands` → 409 `invalid_state` `details.reason`, `AgentUnavailableError` → 503 `agent_unavailable` retryable, `AgentOutdatedError` → 409 `agent_outdated` `details.capability`, anything else → 502 `agent_error` `details.agentCode`.
- `UnwiredAgentApi(agentClient: AgentClient)`: RPC → `AgentUnavailableError`; `files` → `agentClient.fetch(machineId, path, init)`; `capabilities` — from `tunnel.tunnel_sessions`.
- `FakeAgent implements AgentApi` (`src/testing/fake-agent.ts`): `machine(machineId)` with a temporary home directory; commands are real `bash -lc` / argv processes (`child_process.spawn`, `cwd` relative to home), output in memory with offsets; `pty` — the same process without a terminal, stdout+stderr into the `pty` stream, `update` writes the size to `ptySizes`; `Start` is idempotent by `commandId` (the counter `startCount(commandId)`); `attach` follows S2 §9.1 (`exit` after all output, `truncated` at `offset < availableFrom`, `retention(bytes)` for the eviction test, `heartbeat` every `heartbeatMs`); `sendInput` deduplicates `seq`; failure injections: `failNextAttach(machineId, afterBytes, kind: "unavailable"|"reset")`, `setUnavailable(machineId, on)`, `chunkSize` (default 64 KiB, 1 for the UTF-8 test), `capabilities` are configurable; files — `/files`, `/files/uploads/*`, `/files/archive` (via system `tar`), `Filesystem` on top of the directory; `listPorts` — a configurable list.

- [ ] **Step 1: fake tests** (the S3 contract that the real adapter must also satisfy): `Start` twice → `created:false`, one process; attach from the middle; `exit` only after all output; `truncated`; `failNextAttach` breaks the stream; files: `Range`, `ETag`, chunked upload with a wrong offset → 409 `upload_offset_mismatch` with `Sbx-Upload-Offset`, archive there and back; `agent-errors.test.ts` — the table.
- [ ] **Step 2–4.** **Step 5: commit** `api: agent interface, fake agent, files adapter over AgentClient.fetch`.

### Task 9: commands — start, NDJSON, attach, output, control, stream registry

**Files:**
- Create: `apps/api/src/commands/{run,frames,utf8,collect,attach,wait-ready,registry}.ts`, `apps/api/src/routes/commands.ts`, `apps/api/src/schemas/command.ts`, `apps/api/src/map/command.ts`
- Test: `apps/api/test/commands-{start,stream,attach,control,idempotency,registry}.test.ts`, `apps/api/test/utf8.test.ts`

**Interfaces:**
- `class Utf8StreamDecoder {push(chunk: Uint8Array): {text: string; consumed: number}; flush(): string}` — holds an incomplete sequence (≤ 3 bytes); `consumed` is how many bytes went into `text` (for `nextOffset`); invalid bytes → U+FFFD.
- `type Frame` — the frames of §9.5 (`started`, `attached`, `stdout|stderr|pty`, `truncated`, `heartbeat`, `reconnect`, `exit`, `error`); `ndjsonResponse(c, frames: AsyncIterable<Frame>, headers): Response` (`application/x-ndjson`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, flush per frame).
- `waitUntilReady(deps, p, ref, signal): Promise<Sandbox>` — §9.1 step 2 (60 s, `sandbox_starting` retryable / `sandbox_not_ready` / 404).
- `startCommand(deps, auth, ref, body, idemKey?)` — §9.1: scope, `touchApiActivity`, readiness, capability `process.v1` (+`process.stdin`, `process.pty`), `createCommandWithKey`/`createCommand`, `agent.start` with `requestId` = UUIDv5(`principal:commands.create:key`) or a new UUID; `Start` errors — §9.1 "If Start failed"; `markCommandRunning`.
- `followCommand(deps, machineId, commandId, offsets, opts: {tailBytes?, follow, encoding, signal, maxDurationMs: 3_600_000, heartbeatMs: 15_000}): AsyncIterable<Frame>` — `resumableAttach` from `@sbx/agent-client` on top of `agent.attach`; `AgentUnavailableError` → an `error {code:"agent_unavailable", retryable:true, …offsets}` frame; on `exit` — `completeCommand` (status: `TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`, otherwise `exited|killed|lost`); `maxDurationMs` → `reconnect {reason:"max_duration"}`; shutdown → `reconnect {reason:"server_shutdown"}`.
- `collectSync(frames): SyncResult` — a tail ≤ 4 MiB per stream, `stdoutFrom`, `stdoutTruncated`.
- `StreamRegistry` — `register({userId, apiKeyId, teamId}, abort: (frame) => void): () => void`; `revoke(match)`; a subscription to `NOTIFY sbx_identity` re-checks principals (key revoked/expired, member removed, user disabled) → `error {code:"unauthorized", retryable:false}`; a limit of 100 open per principal → 429 `rate_limited`; `closeAll(reason)` for shutdown.
- Endpoints §6/§9: `POST /commands` (`sync` 200, `stream` 200 NDJSON + `Sbx-Command-Id`, `detached` 201; a retry: sync — waits for the same command's exit, stream — with offset 0 and `replayed:true`, detached — 200), `GET /commands` (core `listCommands`, HMAC cursor), `GET /commands/{cmd}` (live fields from `agent.get` if `ready`), `/stream`, `/output` (headers `Sbx-Offset`, `Sbx-Next-Offset`, `Sbx-Available-From`, `Sbx-Stream-End`, `Sbx-Truncated`; `limit` ≤ 4 MiB), `/input` (204; without `sessionId` — a new one per request), `/kill` (`graceMs` 10 000), `/signal` (the list of §9.4) — 200 `Command`. The Command resource is §9.6 (`streams` from the agent or `stdout_bytes`/`stderr_bytes`).

- [ ] **Step 1: tests.** `utf8.test.ts`: all cuts of 1–4-byte characters, invalid bytes, a reattach with `nextOffset` joins the same text (a `fast-check` property test). `commands-start`: three modes, `timeoutSeconds` sync > 600 → 400, `command`+`argv` → 400, `stdin:true` without `process.stdin` → 409 `agent_outdated`, sandbox `starting` → waits and starts after `markReady`, 60 s expired → 409 `sandbox_starting` (the timeout is reduced via deps). `commands-stream`: 3000 lines × 512 B — the sha256 of stdout matches; `failNextAttach` in the middle — the same sha256, a pause; the agent unavailable beyond the budget → the last frame is a retryable `error` with offsets. `commands-attach`: `tailBytes`, `follow=false`, `truncated`, `/output` with `offset < availableFrom`. `commands-control`: input with a repeated `seq`, kill → `killed`, an unknown signal → 400, input to a finished one → 409 `command_exited`, a command of a foreign sandbox → 404. `commands-idempotency` (Review Focus 1): a retry during the stream and after — `startCount === 1`, the frame `started.replayed === true`; without a key and `AgentUnavailableError` from `start` → 503 `retryable:false`, `details.outcome:"unknown"`, `details.commandId`. `commands-registry` (Review Focus 4): key revocation → an `error unauthorized` frame ≤ 1 s.
- [ ] **Step 2–4.** **Step 5: commit** `api: commands (sync, stream, detached, attach, output, input, kill, signal) and stream registry`.

### Task 10: PTY over WebSocket

**Files:**
- Create: `apps/api/src/routes/ptys.ts`, `apps/api/src/commands/pty-socket.ts`
- Test: `apps/api/test/pty.test.ts`

**Interfaces:**
- `POST /ptys` (`Idempotency-Key`, `{cols, rows, command, cwd, env, user, term}`, capability `process.pty`) → 201 Command `mode:"pty"`; `POST /ptys/{cmd}/resize` → 204.
- `GET /ptys/{cmd}/connect?offset=&tailBytes=` — upgrade via `upgradeWebSocket` of `@hono/node-server` 2.x (if `bufferedAmount` is needed — `ws` itself), the subprotocol `sbx.pty.v1` is mandatory. Server: binary output frames, text `attached {offset}` first, `truncated`, `exit`, `error`, `reconnect {offset, reason}`. Client: binary — input (5 ms coalescing, `inputSessionId` per connection, `seq` in order), text `{type:"resize", cols, rows}`. Backpressure: `bufferedAmount > 1 MiB` — pause reading attach. Ping every 15 s. Close: 1000 after `exit`, 1012 on shutdown (after `reconnect`), 4401/4403/4404/4409/4503. Auth — the same layer as HTTP (on proxied — Origin and `?team=`). Registered in `StreamRegistry` (revocation → 4401).
- OpenAPI: `GET` with a `101` response and `x-sbx-websocket: {subprotocol: "sbx.pty.v1"}`.

- [ ] **Step 1: tests** (the client is `ws`): `cat` echo, resize reaches `fake.ptySizes`, a socket break and reconnect with `offset` = the received one — output without loss or duplicates; without the subprotocol → refusal; proxied with a foreign `Origin` → upgrade refused 403; a foreign command → 4404; key revocation → 4401.
- [ ] **Step 2–4.** **Step 5: commit** `api: PTY over WebSocket (sbx.pty.v1)`.

### Task 11: files

**Files:**
- Create: `apps/api/src/routes/files.ts`, `apps/api/src/schemas/files.ts`
- Test: `apps/api/test/files-{content,uploads,ops,archive}.test.ts`

**Interfaces:**
- The endpoints of §11.1. Sandbox state — `waitUntilReady`; capabilities `files.v1`, `files.upload.v1`, `files.archive.v1`. `GET/HEAD /files/content` → `agent.files(m, "?path=&user=", {headers: Range/If-Range})`, the response streamed (`readBodyCapped` nowhere except JSON errors from the agent), headers `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<name>`, `X-Content-Type-Options: nosniff`, `ETag`, `Last-Modified`, `Accept-Ranges`, `Content-Range`; JSON errors from the agent → `agentErrorToHttp` (`is_directory` 409, 416 → `range_not_satisfiable`). `PUT /files/content` — the body `c.req.raw.body` as a stream (`duplex:"half"`, no retry). Uploads: `POST` → `{uploadId: newPublicUlid("upload"), chunkSizeBytes: 4194304, maxChunkSizeBytes: 8388608, expiresAt: +24h}`; `PUT ?offset=&path=` — a chunk up to 8 MiB is buffered (an inbound `readBodyCapped` analog, > 8 MiB → 413), passed to the agent as a buffer (repeatable); an agent `409` → `upload_offset_mismatch` with `Sbx-Upload-Offset` from `parseUploadOffset`; `HEAD` → `Sbx-Upload-Offset`; `commit` → `FileInfo`, `422 checksum_mismatch`; `DELETE`. The rest is `Filesystem` RPC. `FileInfo` §11.1 (`modifiedAt` ISO). `GET /files/list` — the HMAC cursor wraps `page_token`. Archive: `GET` a stream, `Content-Type` by `format`; `PUT` a stream → `{path, entries, sizeBytes}`.

- [ ] **Step 1: tests:** a 100 MiB upload in chunks with a break after the 3rd chunk and resumption via `HEAD` (sha256 matches); `Range: bytes=10-19` → 206 and 10 bytes; `If-Range` with a foreign ETag → 200 the whole file; `checksum_mismatch`; a directory → 409 `is_directory`; `../`, an absolute path, and a symlink in the archive → 400 `invalid_path`; a directory archive there and back — the file sha256 values match; the `uploadId` of another sandbox of the same team is not visible to this one's agent (404 `upload_not_found`); a 5 MiB `PUT /content` is not held in memory entirely (check: the stream is read by the agent until the end of the request — the fake counts the maximum buffer size < 1 MiB).
- [ ] **Step 2–4.** **Step 5: commit** `api: files (content, uploads, fs ops, archive)`.

### Task 12: ports, snapshots, environments

**Files:**
- Create: `apps/api/src/routes/{ports,snapshots,environments}.ts`, `apps/api/src/schemas/{port,snapshot,environment}.ts`
- Test: `apps/api/test/{ports,snapshots,environments}.test.ts`

**Interfaces:**
- Ports §11.2: `GET /ports` → `{hosted, listening, listeningObservedAt}` (`listening` — `agent.listPorts` if `ready` and the agent answered, otherwise `sandbox.listeningPorts`); `PUT /ports/{port}` → 201/200 `HostedPort` (`url`, `label`; `token`/`urlWithToken` only in the call that issued it); `public` with `publicPortsEnabled=false` → 403 `forbidden` `details.reason:"public_disabled"`; `rotate-token`; `DELETE` → 204; port 22, 0, 65536 → 400; the 51st → 400.
- Snapshots §13: `POST /v1/snapshots {sandbox, name}` (`Idempotency-Key`) → 202 `{snapshot, operation}`; `GET` list/by name; `DELETE /v1/snapshots/{name}` with `Sbx-Confirm-Delete` (`snap_…` or the name) → 204. The resource `{id: snap_, name: name ?? pendingName, state, sourceSandboxId, template, templateVersion, size, consistency, error, createdAt, readyAt}`.
- Environments S8 §10.2: `GET/POST /v1/environments`, `GET/PATCH/DELETE /v1/environments/{environment}`; writes — scope `environments:write` and the `owner` role for people (`member` → 403 `details.reason:"role"`); secret values are not returned.

- [ ] **Step 1: tests:** the token in the response once and not in `GET /ports`; a repeated `PUT` with the same settings → 200 without a token; `rotate-token` changes the hash in the DB; snapshot `DELETE` without the header → 428; create with the default environment and `environment:null`; a `member` does not change an environment.
- [ ] **Step 2–4.** **Step 5: commit** `api: ports, saved snapshots, environments`.

### Task 13: SSH, SSH keys, API keys

**Files:**
- Create: `apps/api/src/routes/{ssh,ssh-keys,api-keys}.ts`, `apps/api/src/schemas/{ssh,api-key}.ts`
- Test: `apps/api/test/{ssh,ssh-keys,api-keys}.test.ts`

**Interfaces:**
- `GET /sandboxes/{sb}/ssh` (§11.3; `loginUser` from the template, `knownHosts` = `"<sshHost> <key>"`, `hasKeys`). `POST /sandboxes/{sb}/ssh/certificate {publicKey}` → `signUserCertificate` (`principals: [sb_…]`, `keyId: sbx:user:<usr_…>` | `sbx:key:<key_…>`, `validAfter = now − 60 s`, `validBefore = now + 10 min`) → `{certificate, principal, validAfter, validBefore, host, port, username, knownHosts}`; without `SBX_SSH_LOGIN_CA_KEY_FILE` → 500 `internal` with the message "SSH login CA is not configured". The sandbox state is not checked.
- `/v1/ssh-keys` — a person only (`user_required`), the types of §11.3, `409 ssh_key_in_use`.
- `/v1/api-keys` §13: `GET` (a member or a key with `keys:admin`), `POST {name, scopes?|preset?, expiresInSeconds?, kind?}` (only a human `owner`; by default 90 days, maximum 365; `kind:"sandbox"` → 400; `sandbox-self` → 400; an unknown scope → 400) → 201 `{apiKey, secret}`; `rotate` → 200 `{apiKey, secret}`; `DELETE /{key}` (an `owner`, an operator session, or a key with `keys:admin` of its own team) → 204; `DELETE /self` → 204. Revocation/rotation send `NOTIFY sbx_identity` (trigger) — the cache of all pods is reset. `createdVia`: `cli` if the `User-Agent` starts with `sbx-cli/`, `dashboard` for a session, otherwise `api`.

- [ ] **Step 1: tests** (§16 "Team keys", "SSH certificates"): a `member` and a key do not issue keys (403 `role`/`user_required`); a key works after its creator is removed from the team and deactivated; an `owner` revokes — the next request 401; a key with `keys:admin` revokes another key of its team but not of another team (404); the secret in the response only for `POST`/`rotate`, not in `GET`; certificate: `parseUserCertificate` gives principal `sb_…`, `keyId sbx:key:key_…`, 10 min lifetime; RSA 2048 → 400.
- [ ] **Step 2–4.** **Step 5: commit** `api: ssh certificates, ssh keys, team api keys`.

### Task 14: internal gateway endpoints, agent events, SSO for ports

**Files:**
- Create: `apps/api/src/routes/internal/{routes,ssh-authorize,port-auth,agent-events}.ts`, `apps/api/src/routes/sbx-auth.ts`, `apps/api/src/agent/event-decode.ts`
- Test: `apps/api/test/internal-{routes,ssh,port-auth,events}.test.ts`

**Interfaces:**
- `GET /internal/v1/gateway/routes/{label}` → a body exactly per S4 §6.1 + `kind:"port"`; `sandboxId`/`teamId` in public format; `authEpoch` for `sso` = `auth_epoch + ssoPolicyEpoch`; `blocked:true, blockReason:"public_disabled"` for `public` when the flag is off; `404 {"code":"route_not_found", "error":{…}}` (a label outside the grammar, a port not published, `deleted`).
- `POST /internal/v1/gateway/ssh/authorize` — §12.1 (C6: without an operator) → `{allowed:true, actor, userId, email, sandboxId, machineId, sandboxState, loginUser, teamId}` or `{allowed:false}`; `touchSshKey`/`touchApiKey`.
- `POST /internal/v1/gateway/port-auth/exchange {code, label}` — the atomic `UPDATE … RETURNING` of §12.1 → `{userId: usr_…, email, label, authEpoch}` or `400 {"code":"invalid_code", "error":{…}}`.
- `POST /internal/v1/agent-events` (`Content-Type: application/proto`, up to 16 MiB) → `fromBinary(AgentEventsRequestSchema)` → `ingestAgentEvents` → `AgentEventsResponse {ackedSeq}` in the same format as the request (proto or protojson).
- `GET /sbx-auth/authorize?label=&state=` (proxied only) — §7.7: the label per the grammar, an `sso` route and not `blocked`, the policy `any|team`; a 32-byte base64url code, `sha256` in `port_auth_codes` (60 s); `302` to `https://<label>.<sbxDomain>/__sbx/auth/callback?code=&state=`; otherwise a minimal HTML error page (no external resources) with status 400/403/404.

- [ ] **Step 1: tests:** a `public` route with `publicPortsEnabled=false` → `blocked`; a `deleted` sandbox → 404 with a top-level `code`; ssh: a certificate with the principal of another sandbox → `allowed:false`; a revoked key, a deactivated user, a non-member of the team (even an operator) → `allowed:false`; a registered key with a mismatched `publicKey` → `false`; port-auth: a second exchange of the same code and a foreign `label` → `invalid_code`; expired (shifted `expires_at`) → `invalid_code`; agent-events: a batch of 3 events → `ackedSeq = 3`, a repeated batch — the same row in `agent_events`; sbx-auth: the label `x-3000` with `access=token` → an error page without a redirect; the redirect is built from the label, not from `Host`.
- [ ] **Step 2–4.** **Step 5: commit** `api: internal gateway endpoints, agent events, port SSO authorize`.

### Task 15: the `api` process, shutdown, Dockerfile, compose with Keycloak and oauth2-proxy

**Files:**
- Create: `apps/api/src/main.ts`, `apps/api/src/server.ts`, `apps/api/src/shutdown.ts`, `apps/api/Dockerfile`, `deploy/compose/keycloak/realm-sbx.json`, `deploy/compose/secrets-init/init.sh`, `deploy/compose/config/identity.yaml`
- Modify: `deploy/compose/compose.yaml`, `deploy/compose/README.md`, `apps/worker/Dockerfile` (the `COPY` lines of the manifests of the new packages), `.dockerignore` if needed
- Test: `apps/api/test/{shutdown,main}.test.ts`

**Interfaces:**
- `startApi(settings, deps?): Promise<{close(): Promise<void>; ports}>` — four `serve()` calls; `SIGTERM`: `/readyz` → 503, new requests → 503 `server_shutting_down`, `streams.closeAll("server_shutdown")` (streams — `reconnect`, PTY — `reconnect` + 1012), an in-flight sync → 503 (`retryable` only with `Idempotency-Key`, otherwise `details {commandId, outcome:"running"}`), waiting up to 10 s, exit.
- Compose: services `secrets-init` (alpine, once: generates in `secrets/` `service-tokens.json`, `cursor-key`, `ssh-login-ca` (ed25519, `ssh-keygen`), `ssh-host-keys.pub` (dev gateway keys until S4), `oauth2-proxy-client-secret`, `oauth2-proxy-cookie-secret`, `sbx-worker-client-secret`, `data-keys.json` — only if the files do not exist yet), `keycloak` (`quay.io/keycloak/keycloak:26.8.1`, `start-dev --import-realm`, the `keycloak` DB in the same Postgres via an init script or a separate schema; admin from `.env`; port `127.0.0.1:8180`; hostname `http://localhost:8180`), `oauth2-proxy` (`quay.io/oauth2-proxy/oauth2-proxy:v7.15.5`, provider `keycloak-oidc`, upstream `/api/` → `http://api:8081/` with `/api` stripped, `/sbx-auth/` → `api:8081`, `--upstream-timeout=660s`, `--cookie-name=__Host-sbx_session`… for http-dev — `_sbx_session` without `Secure`, port `127.0.0.1:4180`), `api` (image `apps/api/Dockerfile`, ports `127.0.0.1:8080`, `:8082` is not published outside, `:9091→9090`, `depends_on: migrate, keycloak(healthy), secrets-init(completed)`). The realm: clients and lifetimes of architecture §10; the test user `dev@example.com` (email verified) with the temporary password `SBX_DEV_PASSWORD` from `deploy/compose/.env` (default `dev`) and the required action `UPDATE_PASSWORD`; the README explains the first login.
- Keycloak addresses: public `http://localhost:8180` (`KC_HOSTNAME`) for the browser and CLI, internal `http://keycloak:8080` for `api` (`SBX_OIDC_JWKS_URL`) and oauth2-proxy (`--skip-oidc-discovery` with explicit `--login-url` to localhost and `--redeem-url`/`--oidc-jwks-url` to `keycloak:8080`).
- README: running, `sbx login --api-url http://localhost:8080`, no dashboard yet (S8), browser login is checked via `http://localhost:4180/api/v1/me`.

- [ ] **Step 1: tests:** `shutdown.test.ts` — Review Focus 5 (the stream gets `reconnect`, the PTY — 1012, sync with a key → 503 retryable, without a key → `outcome:"running"`, `close()` ≤ 10 s with a hanging stream); `main.test.ts` — `startApi` brings up 4 ports, `/readyz` 200, `/v1/meta` 200.
- [ ] **Step 2–4.**
- [ ] **Step 5: compose smoke** (manual, output goes in the report): `docker compose -f deploy/compose/compose.yaml up -d --build`; `ps -a` — `api`, `worker`, `postgres`, `keycloak`, `oauth2-proxy` healthy, `migrate`/`secrets-init` Exited (0); `curl -s localhost:8080/v1/meta`; `curl -s localhost:8180/realms/sbx/.well-known/openid-configuration`; device grant `curl -d client_id=sbx-cli localhost:8180/realms/sbx/protocol/openid-connect/auth/device` → `user_code`.
- [ ] **Step 6: commit** `api: process, graceful shutdown, Dockerfile; compose: api, keycloak, oauth2-proxy`.

### Task 16: TS SDK — generation, transport, retries, credentials

**Files:**
- Create: `packages/sdk-ts/{package.json,tsconfig.json,vitest.config.ts}`, `src/gen/v1.d.ts` (generated by `openapi-typescript ../../apps/api/openapi/v1.json`), `src/{index,client,errors,retry,credentials,ids}.ts`
- Test: `packages/sdk-ts/test/{retry,credentials,client}.test.ts`

**Interfaces:**
- `class SbxError extends Error {status: number; code: string; retryable: boolean; details: Record<string, unknown>; requestId: string|null}`; `SandboxFailedError extends SbxError`.
- `interface CallOptions {signal?: AbortSignal; retryBudgetMs?: number /* default 60_000 */; idempotencyKey?: string}`.
- `interface SbxOptions {baseUrl?: string; team?: string; apiKey?: string; accessToken?: string; tokenProvider?: () => Promise<string>; fetch?: typeof fetch; userAgent?: string; env?: Record<string,string|undefined>; authCommand?: string[] /* default ["sbx","auth","token","--json"] */}`.
- `resolveCredentials(opts): Promise<{baseUrl; team?; getToken(force?: boolean): Promise<string>}>` — the chain of §7.6: explicit → `SBX_API_KEY` → `SBX_ACCESS_TOKEN` → `sbx auth token --json` (`{kind, token, expiresAt, apiUrl, team}`; the token is not sent to another `apiUrl`; cached until `exp − 60 s`).
- `createRawClient(opts): RawClient` — `openapi-fetch` `createClient<paths>` + middleware: `Authorization`, `Sbx-Team`, `User-Agent: sbx-sdk-ts/<version>`; `Idempotency-Key` UUIDv4 for `POST /v1/sandboxes`, `/fork`, `/commands`, `/ptys`, `/v1/snapshots` if not set, and the same on all retries; errors → `SbxError`; `401 token_expired` → one `getToken(true)` and a retry.
- `withRetry(fn, {method, idempotent, signal, budgetMs})` — §15.4: `GET/HEAD/PUT/DELETE` on network errors, 502/503/504/429; `POST` — with `Idempotency-Key` or `retryable:true`; `retryable:false` — never; backoff 0.5 s × 2 up to 8 s with full jitter, `Retry-After` takes priority, a total budget `retryBudgetMs`, `signal` interrupts the wait.
- `package.json` `scripts.gen` + a freshness test of `v1.d.ts`.

- [ ] **Step 1: tests** on a fake `fetch`: 503 → a retry with the same `Idempotency-Key`; `POST` without a key and 503 `retryable:false` → no retry; `Retry-After: 2`; a 1 s budget exhausted → the last error; `signal.abort()` during backoff → `AbortError` immediately; the credential chain with a substituted `sbx` (a script in `PATH`), a foreign `apiUrl` is not used; `token_expired` → exactly one retry; `v1.d.ts` is fresh.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-ts: generated types, transport, retries, credential chain`.

### Task 17: TS SDK — facade and helpers

**Files:**
- Create: `packages/sdk-ts/src/{sbx,sandbox,commands,ndjson,files,pty,pages}.ts`
- Test: `packages/sdk-ts/test/facade.test.ts` (against `apps/api` with `FakeAgent` and Postgres, `@sbx/api/testing`)

**Interfaces:**
- `class Sbx {constructor(opts?: SbxOptions); raw: RawClient; sandboxes: {create(input, opts?: CallOptions & {wait?: boolean; waitTimeoutMs?}): Promise<Sandbox>; get(ref, opts?); list(filter?, opts?): AsyncIterable<SandboxData>}; snapshots: {...}; me(); limits(); templates(); sizes()}`.
- `class Sandbox {data; id; slug; refresh(); waitUntilReady({timeoutMs: 300_000, signal}); waitForOperation(op); exec(cmd: string|string[], opts?: ExecOptions): Promise<ExecResult>; run(cmd, opts?): AsyncIterable<RunEvent>; start(cmd, opts?): Promise<Command>; command(id): Command; files: Files; ports: {host(port, {access, hostRewrite, appProtocol}); list(); unhost(port); rotateToken(port)}; pty(opts): Promise<Pty>; stop(); resume(); fork(); delete(); stopAndDelete()}`.
- `ExecResult {command, stdout: string, stderr: string, exitCode: number|null, stdoutTruncated, stderrTruncated}` — `exec` sends `mode:"stream"` and collects a 4 MiB tail per stream. `RunEvent = {type:"stdout"|"stderr"|"pty", data: string|Uint8Array, offset} | {type:"truncated", …} | {type:"exit", status, exitCode, signal, reason}`; `heartbeat`/`reconnect`/`attached`/`started` are hidden; a break, 45 s without lines, `error{retryable}`, `reconnect` → `/stream` with the last offsets; 20 failures in a row without new bytes → an error; an early `break` does not kill the command.
- `Command.follow({from: "start"|"end"|{stdoutOffset, stderrOffset}})`, `kill()`, `signal()`, `input()`, `output(stream, offset, limit)`.
- `Files {readText, writeText, readBytes, writeBytes, stat, list, mkdir, move, chmod, remove, upload(path, src: Uint8Array|Blob|ReadableStream|string /*local path, Node*/, {chunkSize}), download(path, dest), uploadDir(localDir, path) /* tar.gz via the system tar (Node/Bun) */, downloadDir(path, localDir)}`.
- `Pty {onData(cb), write(data), resize(cols, rows), close(), exited: Promise<ExitInfo>}` — the global `WebSocket(url, {protocols:["sbx.pty.v1"], headers})` (undici in Node, Bun), reconnect with an offset.
- All methods accept `CallOptions`.

- [ ] **Step 1: tests** (one §16 "SDK" scenario): create(wait) → exec → run with `failNextAttach` (the output matches) → start + follow → files write/read/upload 20 MiB/uploadDir → ports.host → pty echo → delete; `exec` is retried after a 503 on the first `POST` and the command runs once; `signal` interrupts `waitUntilReady`.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-ts: facade and helpers (wait, exec, run, follow, files, upload, pty)`.

### Task 18: stream chaos and `api` shutdown

**Files:**
- Test: `apps/api/test/chaos.test.ts`

- [ ] **Step 1: test** (the main §16 scenario within decision 3): two `api` instances (`startApi` on one DB and one `FakeAgent`) behind a test load balancer (a TCP proxy that can be switched); SDK `run()` of 3000 lines × 512 B on stdout and stderr; every 100–400 ms at random: `failNextAttach`, a client connection break in the proxy, stopping the current `api` instance (the SIGTERM path `close()`) and bringing up a new one. Result: the sha256 of both streams matches, the exit code is right, `fake.startCount === 1`.
- [ ] **Step 2: PASS** (if it fails — fix the code of tasks 9, 15, 17, not the test).
- [ ] **Step 3: commit** `test: stream chaos across api restarts`.

### Task 19: security matrices and OpenAPI conformance

**Files:**
- Create: `apps/api/test/security-{idor,scopes,leaks,headers}.test.ts`, `apps/api/test/helpers/route-table.ts`

- [ ] **Step 1: tests.** `route-table.ts` — a table of all operations from `openapi/v1.json` (`operationId` → method, path, required scope, human/owner, a body example); a test checks that the table covers **all** operations of the document. `security-scopes`: for each operation a key without its scope → 403 `requiredScope`, `me/limits/templates/sizes/api-keys/self` — any key. `security-idor`: for each operation with a resource in the path — team B's resource with team A's key → 404, B's state unchanged (command, upload, operation, snapshot, port, user B's ssh-key, api-key B). `security-leaks`: a marker in env/secrets/secretFiles/a key secret/a port token/a bearer is searched for in all captured logs, in `operations.request`, `idempotency_keys.response`, `pgboss.job.data`. `security-headers`: `X-Auth-Request-*` on public are ignored; a proxied WebSocket upgrade with a foreign `Origin` → refusal. Conformance: `harness` validates every JSON response of all `apps/api` tests against the document (enabled since task 5); here — a check that every operation had at least one response validated during the run (a counter in global teardown).
- [ ] **Step 2: PASS** (what is found is fixed in the code).
- [ ] **Step 3: commit** `test: authz, IDOR and secret-leak matrices; OpenAPI conformance coverage`.

### Task 20: CLI — skeleton, output, login

**Files:**
- Create: `apps/cli/{package.json,tsconfig.json,vitest.config.ts}`, `src/{main,program,output,exit-codes,config,profile,current}.ts`, `src/auth/{store,keychain,file-store,lock,device-grant,token}.ts`, `src/commands/{login,logout,whoami,auth-token,current,version,completion,mcp}.ts`
- Test: `apps/cli/test/{output,login,auth-token,store}.test.ts`, `apps/cli/test/helpers/run-cli.ts`

**Interfaces:**
- Running in tests: `runCli(args, {env, stdin, tty?: boolean}) → {code, stdout, stderr}` — `bun src/main.ts` as a child process against the `api` from `@sbx/api/testing` and `startTestOidcServer`.
- Output §14.3: `Output {json: boolean /* !isTTY || --json || SBX_OUTPUT=json, --human cancels */; result(obj); event(name, obj) /* JSONL with an event field */; error(err) /* the last stdout line {"event":"error",code,message,retryable,details,requestId} in JSON, text goes to stderr; for raw commands without --json — to stderr */}`. Exit codes: 0, 1, 2 (arguments), 3 (not found), 4 (no permission/login), 75 (retryable, retries exhausted); `exec`/`run` — the command's code (`128+n`, `124`, `125`).
- Config `$XDG_CONFIG_HOME/sbx/config.json` (0600): `{current: string, profiles: {name: {apiUrl, team?, auth: "oidc"|"key", issuer?}}}`; order: flags > env (`SBX_API_URL`, `SBX_API_KEY`, `SBX_TEAM`, `SBX_PROFILE`) > profile > `/etc/sbx/config.json` (`apiUrl`).
- Storage: `CredentialStore {get(name), set(name, value), delete(name)}`; `KeychainStore` via `Bun.secrets` (`service:"sbx"`, `name:"<profile>@<issuer|apiUrl>"`), `FileStore` (`credentials.json`, 0600, a warning on stderr); chosen with `--credential-store keychain|file`, `auto` — keychain, on error — a file.
- Device grant §7.6: `meta.oidc` → `auth/device` → print the code and link (+ open the browser, except with `--no-browser`) → poll with `authorization_pending`/`slow_down`/`expired_token`/`access_denied` → `/v1/me`. `--key-stdin`: the key from stdin, check `/v1/me`. `logout`: OIDC — `revoke` the refresh; a key — erase, `--revoke` → `DELETE /v1/api-keys/self`.
- `getBearer(profile): Promise<{kind, token, expiresAt}>` — access until `exp − 30 s`, then `refresh_token` under the file lock `$XDG_CONFIG_HOME/sbx/.lock` (`open(O_CREAT|O_EXCL)` + retry, a stale lock > 30 s is removed); a second process reads the refreshed one; `invalid_grant` → "run: sbx login", code 4. `sbx auth token [--json]` → `{kind, token, expiresAt, apiUrl, team}`.
- `sbx mcp` is a stub (decision 12).

- [ ] **Step 1: tests:** without a TTY `whoami` prints the `/me` JSON; an error is the last line `{"event":"error",…}` with `requestId`, code 4 on 401; `login` device grant with auto-approval in the OIDC server → `auth token --json` gives the same `sub`; two parallel `auth token` calls with an expired access make exactly one `refresh` (the OIDC server's counter); `invalid_grant` → code 4; `--key-stdin`; `--credential-store file` → a 0600 file; `SBX_API_KEY` in env takes priority over the stored one.
- [ ] **Step 2–4.** **Step 5: commit** `cli: skeleton, output contract, profiles, login (device grant, key-stdin), auth token`.

### Task 21: CLI — commands

**Files:**
- Create: `apps/cli/src/commands/{create,list,info,lifecycle,rm,rename,extend,label,env,exec,logs,kill,ps,shell,ssh,ssh-config,ssh-cert,ssh-keys,cp,push,port,snapshot,catalog,keys,run}.ts`, `apps/cli/scripts/build.ts`
- Test: `apps/cli/test/{lifecycle,exec,files,ports-ssh,keys,build}.test.ts`

**Interfaces:**
- Commands and flags — the table of §14.2 without `--fail-fast`. `<sb>`: argument → `SBX_SANDBOX` → current (`$XDG_STATE_HOME/sbx/current/<SBX_SESSION | ppid-starttime>`, older than 7 days — delete) → `SBX_SANDBOX_ID` (UUID → `sb_…`). `create`, `fork`, and commands with an explicit `<sb>` make it current; `sbx current` without a current one → code 3.
- Waiting (`--wait`) — JSONL `accepted`, `state`, and finally `ready`/`stopped`. `rm`: confirmation in a TTY, without a TTY and without `--yes` → code 2; sets `Sbx-Confirm-Delete`. `exec`: a stream (stdout → stdout, stderr → stderr), automatic reattach (SDK `run`), the exit code is the command's code; `--json` — NDJSON frames with `event` instead of `type`; `--detach` prints the `commandId`. `shell`: a PTY in raw mode, `SIGWINCH` → resize, reconnect, 64 KiB scrollback. `ssh`: an ephemeral ed25519 (`ssh-keygen`) in a 0700 directory + a certificate + the system `ssh -i … -o CertificateFile=… -o UserKnownHostsFile=~/.config/sbx/known_hosts <slug>@<host> -p <port>`; the files are deleted. `ssh-config` — a `Host sbx-<slug>` block with `Match exec "sbx ssh-cert <sb> --ensure"`; `ssh-cert --ensure` — a new certificate if less than 2 min remain. `cp [-r]` — `sb:path` on either side; > 64 MiB — `upload`/`download` with resume; `-r` — an archive. `push` — `git ls-files -co --exclude-standard` or the whole directory, tar.gz as a stream. `keys create` — Keycloak login only. `run` — create → push → exec → delete (except with `--keep`).
- `scripts/build.ts`: `bun build --compile --target=bun-<os>-<arch> src/main.ts --outfile dist/sbx-<os>-<arch>` for the five targets of §14.1 + `SHA256SUMS`; `pnpm --filter @sbx/cli build` builds only the current platform, `build:all` — all of them.

- [ ] **Step 1: tests** (§16 "CLI contract"): without a TTY `create --wait` → JSONL, the last line `ready`; `rm` without `--yes` without a TTY → 2, with `--yes` → `Sbx-Confirm-Delete` arrived (the resource is deleted); `exec -- sh -c 'echo out; echo err >&2; exit 7'` → stdout `out`, stderr `err`, code 7; `exec` with a signal → `128+n`; `cp` there and back of 70 MiB (in chunks) — the sha256 matches; `cp -r`; `port --token` prints the URL with the token; `ssh-config` contains `Match exec`; `ssh-cert` writes a certificate, `--ensure` a second time does not change it; `current` after `create`; the built binary (`build`) answers `sbx version`.
- [ ] **Step 2–4.** **Step 5: commit** `cli: sandbox, exec, files, ports, ssh, snapshots, keys commands; bun compile`.

### Task 22: Python SDK

**Files:**
- Create: `packages/sdk-py/{pyproject.toml,package.json,README.md,openapi-python-client.yaml}`, `packages/sdk-py/sbx_sdk/{__init__,_client,_errors,_retry,_credentials,_ndjson,sandbox,files}.py`, `packages/sdk-py/sbx_sdk/_gen/**` (generated, committed), `packages/sdk-py/tests/{conftest,test_facade,test_retry}.py`, `packages/sdk-py/tests/api_server.ts` (starts `apps/api` with the fake and Postgres for pytest)
- Modify: `mise.toml` (`python = "3.15.2"`, `uv = "0.13.6"`), do not touch `biome.json` (Python uses ruff)

**Interfaces:**
- `Sbx`/`AsyncSbx(base_url=None, team=None, api_key=None, access_token=None, token_provider=None)` — the chain of §7.6 as in TS; `sbx.sandboxes.create(..., wait=True)`, `.get`, `.list()` (an iterator); `Sandbox.wait_until_ready`, `.exec`, `.run` (an iterator of frames with reattach), `.start` + `Command.follow`, `.files.read_text/write_text/read_bytes/write_bytes/upload/download`, `.ports.host`, `.delete()`; `SbxError(status, code, message, retryable, details, request_id)`; the retry policy of §15.4; the generator with `literal_enums: false`. The package's `package.json`: `"test": "uv run --project . pytest"`, `"lint"` is not needed (ruff inside `test`: `uv run ruff check . && uv run pytest`).

- [ ] **Step 1: tests** — the same scenario as task 17, without `pty` and `uploadDir` (decision 11), and retries on 503 with the same `Idempotency-Key`.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-py: generated client and Sbx/AsyncSbx facades`.

### Task 23: documents and final verification

**Files:**
- Modify: `docs/specs/s7-public-api.md` (decision 1: `failFast`/`pool_exhausted`/`warmAvailable` — "phase 2, outside the MVP public contract"; decisions 2–13 — a short section "§23. MVP implementation"), `docs/architecture.md` §9 (only if it diverges), `deploy/compose/README.md`, `apps/api/README.md` (how to run, environment variables, the `AgentApi` interface and what to wire in after S3)

- [ ] **Step 1:** `mise exec -- pnpm install --frozen-lockfile && pnpm -r test && pnpm lint && pnpm build && pnpm -r typecheck` — all green (output in the report).
- [ ] **Step 2:** the compose smoke of task 15 again from scratch (`down -v`, `up -d --build`).
- [ ] **Step 3:** a final review of the whole branch by a fresh subagent (correctness + security), fixes.
- [ ] **Step 4: commit, push `s7-impl`.**
