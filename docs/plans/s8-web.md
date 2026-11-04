# S8 Web (Payload): implementation plan

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, a review by a fresh subagent after each task) and superpowers:test-driven-development. Steps are `- [ ]` checkboxes.

**Goal:** implement the S8 MVP per `docs/specs/s8-web.md`: `packages/payload` (collections, `NOTIFY` hooks, JIT, `PayloadIdentityStore`, `PayloadConfigReader`, Keycloak sync), `apps/web` (Next.js 16 + Payload 3: `/admin`, `/cms-api`, the `/app` dashboard, server actions, dev proxy), the C3 operator endpoints in `apps/api`/`packages/core`, switching `api` and `worker` to Payload, `web` in `deploy/compose` and `infra/dev-cp`, Playwright E2E.

**Architecture:** Payload owns the `payload` schema (Postgres, `@payloadcms/db-postgres`, `push: false`, migrations in `packages/payload/src/migrations`). `api`, `worker`, and `web` bring up one config through `getSbxPayload()` (Local API, without Next). Collection hooks send `NOTIFY` in the Payload request transaction. The dashboard is client pages on `@sbx/sdk` (`baseUrl: "/api"`, same origin behind oauth2-proxy) and TanStack Query; teams and members are server actions on the Local API.

**Stack:** Node 26.13.0 (type stripping, `.ts` imports), TypeScript 7.0.2, vitest 5.0.5, biome 2.6.4. Checked with `npm view` 2026-10-31 (matches §16 of the spec): `payload`, `@payloadcms/next`, `@payloadcms/db-postgres`, `@payloadcms/ui` 3.92.1; `next` 16.4.3; `react`/`react-dom` 19.3.1; `tailwindcss`/`@tailwindcss/postcss` 4.3.3; `shadcn` 4.23.0 (CLI); `@tanstack/react-query` 5.105.0; `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-search` 0.16.0; `@playwright/test` 1.64.1; `zod` 4.6.7; `graphql` ^16 (Payload peer). oauth2-proxy v7.15.5, Keycloak 26.8.1, Postgres 18.6.

**Specification:** `docs/specs/s8-web.md` (source of truth; the § below are from it). Related: S7 §7, §17.3, §23 (what is already done from C1–C10), S6 §5.11, §15, S4 §6.1, §9.5, `apps/api/README.md`, `deploy/compose/README.md`, `infra/dev-cp/README.md`.

## Global constraints

- Tools only via mise (`mise exec -- <cmd>`). Before adding a dependency — `npm view <pkg> version`; versions above.
- Packages in the repository style: `"exports": {".": "./src/index.ts"}`, no `enum`, `namespace`, parameter properties (type stripping); imports with `.ts`. `apps/web` is an exception: it is built by Next (`transpilePackages` for `@sbx/*`).
- New packages: `packages/payload` (`@sbx/payload`), `apps/web` (`@sbx/web`). In root files — only your own lines.
- Runtime migrations: S6 table changes — `db/migrations/02NN_*` (the next free one is `0206`); new S8 tables — `04NN_*` (record the range `0400–0499` in `docs/roadmap.md`). Migrations of the `payload` schema — only Payload (`packages/payload/src/migrations`).
- Public IDs (`usr_`, `team_`, `key_`, `sshk_`) — only the `@sbx/auth` codecs (`encodeUuid`/`decodeUuid`) on top of Payload UUIDs.
- `failFast`/`pool_exhausted`/`warmAvailable` appear nowhere: not in the UI, not in the API, not in the dashboard types.
- Operator rights belong only to a browser session (`Principal.kind === "session"`); neither a team key nor a Keycloak JWT grants them (C6, already in S7). The C3 operator endpoints are `403 forbidden` for everyone else.
- No "dev auth" code in `apps/web/src`, `apps/api`, `packages/*`: headers are set only by oauth2-proxy or by `apps/web/dev/auth-proxy.ts`, which is not part of the image.
- Nothing Tailscale-specific in `apps/` and `packages/`; dev stand addresses only in `infra/dev-cp/`.
- Secret values (env secrets, secret files, a key's secret after display, a port token after display, `secretHash`) do not get into `web`/`/cms-api` responses, logs, `localStorage`, URLs.
- Postgres in tests — `@sbx/db/testing/global-setup` (like S6/S7). Run and touch nothing on `pve` and CT 590.
- Code comments in English. Commits without `Claude-Session:` and claude.ai links.

## Implementer's decisions (deviations and spec clarifications)

1. **The identity store is the `payload` schema, the `identity` data is migrated.** Payload cannot live on top of the S7 tables (its own column names, `updated_at`, service tables, an `id` on memberships), so `identity` is not suitable as a backend. The first Payload migration after creating the tables copies `identity.teams/users/memberships/api_keys/ssh_keys` with the same UUIDs (`INSERT … SELECT … ON CONFLICT DO NOTHING`, if `to_regclass('identity.users')` is not `NULL`). The `identity` schema and `PgIdentityStore` remain (the contract phase is a separate release; `PgIdentityStore` is the reference of the contract suite in the `packages/auth` tests). The move from the stand-in is a one-time step with `api` stopped (the old code writes to `identity`); after that, expand/contract migrations (§12).
2. **Environments move to `runtime.environments`** (`0400_environments_runtime.sql`, §10.3): `identity.environments` has foreign keys to `identity.teams/users`, while teams now live in `payload`. The table has no foreign keys, the data is copied, `PgEnvironmentStore` (`packages/auth`) reads the new table. The columns `sandboxes.environment_*`/`exclude_owner_secrets` (S6 S1) are not added: S7 decision 7 stays (`environment: null`, `excludeOwnerSecrets: true` → `400`).
3. **`NOTIFY` comes from Payload hooks** in the operation transaction (`afterChange`/`afterDelete`; the adapter session by `req.transactionID`; without a transaction — its own short one). One helper `notify(req, channel, payload)`. Payloads: `sbx_identity` — `'<collection>:<uuid>'` (for `memberships` — the membership id), `sbx_ssh_revoke` — like the triggers `0302`/`0303`: `user:usr_…`, `member:team_…:usr_…`, `key:key_…`, `team:team_…`.
4. **`PayloadConfigReader` lives in `@sbx/payload`**, not in `packages/config`: otherwise a cycle `config → payload → config` (the `ConfigReader` types come from `@sbx/config`). The `ConfigReader` contract suite is in `@sbx/config/testing`, passed by `StaticConfigReader` and `PayloadConfigReader`.
5. **In production `api` and `worker` take identities and config only from Payload.** `SBX_CONFIG_FILE` is no longer needed by `api` and `worker` (it stays for `sbx-admin bootstrap` — that is topology). `SBX_IDENTITY_FILE` stays for `api`: the same YAML is loaded by upsert into Payload (`seedPayloadIdentity`). New env: `PAYLOAD_SECRET` (`api`, `worker`, `web`). The `api` tests still assemble dependencies through `makeTestDeps` (Pg store), a separate test uses `buildDeps` with Payload.
6. **Payload migrations** are applied by our own script `node packages/payload/src/migrate.ts` (`getSbxPayload` + `payload.db.migrate()`), not by the `payload migrate` CLI (the CLI loads the config with its own loader). In compose — a one-shot service `web-migrate` (the `web` image) before `api`, `worker`, `web`. `assertPayloadMigrated(payload)` is in `/readyz` of `api` and `worker`, in `/healthz` of `web`.
7. **Payload IDs are `idType: "uuid"`.** If the 3.92.1 adapter supports `uuidv7`, we take it; otherwise `uuid` (v4) and a note in §21: the codecs are 128-bit, time ordering is not needed for keys and teams (sorting by `created_at`).
8. **The `resolveSession` cache in `web`** — 30 s by `sha256(email + groups + user)`, invalidated by `LISTEN sbx_identity` (one connection per process). The cache already exists in `api` (`SessionResolver`).
9. **ctl-idp-sync:** the logic is `KeycloakIdpSync` in `@sbx/payload`, the wiring is `apps/worker` (the controller already exists, registered when `SBX_IDP_SYNC_KEYCLOAK_URL` is set). Env: `SBX_IDP_SYNC_KEYCLOAK_URL` (internal Keycloak address), `SBX_IDP_SYNC_REALM` (`sbx`), `SBX_IDP_SYNC_CLIENT_ID` (`sbx-worker`), `SBX_IDP_SYNC_CLIENT_SECRET_FILE`. The alert is the counter metric `sbx_idp_sync_aborted_total{reason}` and the gauge `sbx_idp_sync_aborted` (1 after an abort, 0 after a successful pass) + `log.error`.
10. **The E2E stack** is the compose overlay `deploy/compose/e2e.yaml`: real Keycloak, oauth2-proxy, Postgres, `web`, `web-migrate`; instead of `api` and `worker` — the container `e2e-backend` (`apps/web/e2e/backend/main.ts`): `api` (`startApi`) with `FakeAgent` and `worker` with a fake PVE world (`apps/worker/test/fakes`) in one process, listening on the same ports as `api`. The gateway is not needed in E2E: the `blocked` route is checked via `GET /internal/v1/gateway/routes/{label}`.
11. **Sign-out** is the link `/oauth2/sign_out?rd=<Keycloak logout>`; the logout address is the env `SBX_LOGOUT_URL` of `web` (set in compose).
12. **Deleting a team** in `/admin` is a custom button on the team page: a check from the operator's browser (`/api/v1/sandboxes?allTeams=true&teamId=…&limit=1`, `/api/v1/snapshots`, `/api/v1/environments` with `Sbx-Team`) and then `DELETE /cms-api/teams/:id`. The `beforeDelete` hook deletes memberships and revokes keys (§6.4).

## Review Focus

1. **Forged `X-Auth-Request-*` from the client.** Expectation: the dev proxy and oauth2-proxy strip them; `web` without headers — `401`; a direct request to `web:3000` from another network is impossible (compose: `web` only on the internal network with oauth2-proxy). Test — tasks 9, 15.
2. **A server action with a foreign `teamId`/`membershipId`** (a team where the user is a `member` or not a member). Expectation: `{error:{code:"forbidden"}}`, nothing changes; the same for `acknowledgeNotice` of a foreign team. Test — task 10 (matrix per §6.2).
3. **A race of first logins and an email change in the IdP** (10 parallel `resolveSession`, the email is taken by a placeholder). Expectation: one user, one personal team, the placeholder's memberships moved. Test — task 3 (contract + own).
4. **Keycloak returned an empty or truncated list** (a configuration error, a break in the middle of pages). Expectation: no deactivations, `sbx_idp_sync_aborted`; a break is an exception, not a partial application. Test — task 8.
5. **A blocked sandbox and bypass paths** (fork, save snapshot, rename slug, `PATCH /env`, removing and re-publishing a blocked port, a call by team key). Expectation: `403 sandbox_blocked`/`port_blocked`; stop, delete, reads work. Test — task 7.

---

### Task 1: `packages/payload` — config, collections, migrations

**Files:**
- Create: `packages/payload/{package.json,tsconfig.json,vitest.config.ts,README.md}`, `src/index.ts`, `src/config.ts`, `src/access.ts`, `src/collections/{users,teams,memberships,api-keys,team-notices,ssh-keys,templates,sizes,pool-targets}.ts`, `src/globals/platform-defaults.ts`, `src/instance.ts`, `src/migrate.ts`, `src/migrations/{index.ts,<ts>_initial.ts}`
- Test: `packages/payload/test/{migrations,schema,access}.test.ts`

**Interfaces:**
- Produces:
  - `interface SbxPayloadOptions { databaseUrl: string; secret: string; operatorGroups: string[]; appOrigin?: string; poolMax?: number }`
  - `buildSbxConfig(o: SbxPayloadOptions): Promise<SanitizedConfig>` — `db: postgresAdapter({schemaName:"payload", idType, push:false, migrationDir, prodMigrations: undefined})`, `graphQL:{disable:true}`, `routes:{api:"/cms-api", admin:"/admin"}`, `csrf:[appOrigin]`, `cookiePrefix:"__Host-payload"`, `admin.user:"users"`; without React imports (admin components are import-map path strings from `apps/web`).
  - `getSbxPayload(o: SbxPayloadOptions): Promise<Payload>` — an instance cache per process (by `databaseUrl`).
  - `migrateSbxPayload(p: Payload): Promise<void>`; `pendingPayloadMigrations(p): Promise<string[]>`; `assertPayloadMigrated(p): Promise<void>` (throws with a list of unapplied ones; applied ones unknown to the code are allowed).
  - `src/migrate.ts` — CLI: `DATABASE_URL`, `PAYLOAD_SECRET` → migrations, exit 0/1.
  - Collections/global (slug and fields — §7 of the spec, literally): `users`, `teams`, `memberships`, `api-keys`, `team-notices`, `ssh-keys`, `templates`, `sizes`, `pool-targets`, global `platform-defaults`. Multi-valued ones are `json` or `select hasMany` without separate tables. `access`: everything is `isOperatorReq(req)`; `api-keys.create` — `() => false` for everyone; `users.delete` — only placeholders without `lastLoginAt` and memberships.
  - `isOperatorReq(req): boolean` (`req.user?.isOperator === true`).
- Migration `<ts>_initial.ts`: the `payload` schema, tables, seeds of `platform-defaults` (S6/S7/S8 defaults of §7: `idleTimeoutSeconds 900`, `errorRetentionDays 7`, `recoverMinIntervalSeconds 600`, `maxTtlSeconds` as in `deploy/compose/config/sbx.yaml`/the `StaticConfigReader` default, `defaultTemplate "linux"`, `publicPortsEnabled true`, `ssoPortPolicy "any"`, `rateLimits {20, 100, 30}`, `defaultQuota {3, 6144, 10}`, `newSharedTeamQuota = defaultQuota`, `maxOwnedTeamsPerUser 3`, `ssoPolicyEpoch 0`), the template `linux` (`defaultSize "2gb"`, `allowedSizes ["2gb"]`, `capabilities ["exec","files","ssh"]`), the size `2gb` (2 vCPU, 2048 MB), the pool target `linux/2gb = 1`; the `identity` data copy (decision 1).

- [ ] **Step 1: tests.** `migrations.test.ts`: a clean DB → `migrateSbxPayload` → `pendingPayloadMigrations` is empty, a second run — no changes; seeds in place; with a populated `identity` schema (apply `db/migrations` up to `0303` and insert 2 users, a team, a membership, a key, an SSH key) — after the migration the same UUIDs in `payload.*`; `assertPayloadMigrated` on an empty DB throws. `schema.test.ts`: after `db/migrations` and the Payload migrations, the intersection of the `payload` table names with (`runtime` ∪ `tunnel` ∪ `pgboss`) is empty; drift — generating a migration from the current config (`payload.db.createMigration` with `skipEmpty`) creates no file. `access.test.ts` (Local API with `overrideAccess:false` and a `user` without `isOperator`): `find`/`create`/`update`/`delete` of each collection and `findGlobal`/`updateGlobal` → `Forbidden`; an operator reads; `create api-keys` is forbidden even for an operator.
- [ ] **Step 2: run — FAIL** (`mise exec -- pnpm --filter @sbx/payload test`).
- [ ] **Step 3: implement;** generate the initial migration (`payload migrate:create` or `payload.db.createMigration`), then add the seeds and the `identity` copy. Check `idType` (decision 7) and `cookiePrefix`; record anything that did not work in the package README.
- [ ] **Step 4: PASS;** `typecheck`, `pnpm lint`.
- [ ] **Step 5: commit** `payload: config, collections, initial migration`.

### Task 2: `NOTIFY` hooks and collection rules

**Files:**
- Create: `packages/payload/src/notify.ts`, `src/hooks/{identity,config,routes,ssh-revoke,rules}.ts`
- Modify: the collections and global from task 1
- Test: `packages/payload/test/{notify,rules}.test.ts`

**Interfaces:**
- Consumes: task 1.
- Produces: `notify(req: PayloadRequest, channel: "sbx_identity"|"sbx_config"|"sbx_routes"|"sbx_ssh_revoke", payload: string): Promise<void>` — `pg_notify` in the `req.transactionID` session; without a transaction — its own short one. An error is thrown (the write rolls back).
- Rules (§8, §6.2, §6.4, §7): `sbx_identity` — `users`, `teams`, `memberships`, `api-keys`, `ssh-keys` (only if something other than `lastUsedAt`/`lastLoginAt`/`updatedAt` changed); `sbx_config` — `templates`, `sizes`, `pool-targets`, `teams` (if `quota` changed or on delete), `platform-defaults` (`'platform-defaults:global'`); `sbx_routes '*'` — `publicPortsEnabled` or `ssoPortPolicy` changed; the transition `ssoPortPolicy any→team` increments `ssoPolicyEpoch` (`beforeChange`), the field is read-only in the admin. `sbx_ssh_revoke` — a `users` record became `active:false` → `user:usr_…`; `memberships` `afterDelete` → `member:team_…:usr_…`; an `api-keys` record got `revokedAt` or the `secretHash` of an unrevoked one changed → `key:key_…`; `teams` `afterDelete` → `team:team_…`. The last-`owner` rule (`memberships` `beforeChange` when removing the role, `beforeDelete`) → `APIError("last_owner", 400)`; `teams.beforeDelete` — forbids deleting a personal team, deletes memberships and sets `revokedAt` on all keys of the team; `templates`: `defaultSize ∈ allowedSizes`, the sizes exist, slug is immutable; `sizes`: slug is immutable, deleting a size from a template or pool target is forbidden; `users`: delete — only placeholders (`idpSubject` null, `lastLoginAt` null, no memberships); `api-keys`: in the admin `update` only `revokedAt` may be changed (sets `revokedBy = req.user`).

- [ ] **Step 1: tests** (`LISTEN` by a separate `pg` client): a change via the Local API with `req` in a transaction — the notification arrives only after `commitTransaction`, the listener in the handler reads the new data; `killTransaction` — no notifications; `updateGlobal publicPortsEnabled:false` → `sbx_config` and `sbx_routes '*'`; `ssoPortPolicy any→team` → `ssoPolicyEpoch +1`; deactivating a user → `sbx_ssh_revoke 'user:usr_…'` (codec); deleting a membership → `member:team_…:usr_…`; revoking a key → `key:key_…`; `touch` (`lastUsedAt`) — without `sbx_identity`. `rules.test.ts`: the last `owner` — the role cannot be removed or deleted (`last_owner`), with two it can; a personal team cannot be deleted; deleting a shared team deletes memberships and revokes keys; a template with `defaultSize` outside `allowedSizes` — a validation error; changing a template/size slug — an error; deleting a size referenced by a template — an error.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `payload: notify hooks and collection rules`.

### Task 3: `resolveSession`, `PayloadIdentityStore`, contract suite

**Files:**
- Create: `packages/payload/src/identity/{headers,resolve-session,store,seed}.ts`, `src/testing.ts` (export `./testing`)
- Test: `packages/payload/test/{headers,resolve-session,identity-contract}.test.ts`

**Interfaces:**
- Consumes: tasks 1–2; `IdentityStore`, `IdentityError`, `SessionHeaders`, `runIdentityStoreContract`, `CONTRACT_OPERATOR_GROUP` from `@sbx/auth`/`@sbx/auth/testing`; `parseIdentityFile` from `@sbx/auth`.
- Produces:
  - `parseAuthHeaders(h: Headers | Record<string, string | string[] | undefined>): SessionHeaders | null` — §5.2 (email lower+trim, `null` without email; `user`; groups split on `,`, trim, no empties and duplicates; `preferredUsername`).
  - `resolveSession(p: Payload, h: SessionHeaders, o: {operatorGroups: string[]; req?: PayloadRequest}): Promise<SessionIdentity>` — the algorithm of §5.3 items 1–6 literally; `IdentityError` errors `subject_required`, `identity_conflict`, `user_disabled`; `lastLoginAt` no more often than 60 s, `groups`/`isOperator` only on change; the personal team and `owner` in one transaction; races — unique indexes, the loser re-reads.
  - `class PayloadIdentityStore implements IdentityStore` — `constructor(o: {payload: Payload; operatorGroups: string[]})`; all methods of `IdentityStore` (§17.3 + S7 §23.10: `rotateApiKey` sets `rotatedAt`, `apiKey`, `touchSshKey`, `team`). `touchApiKey`/`touchSshKey` — a direct `UPDATE` without hooks (they do not send `NOTIFY`).
  - `seedPayloadIdentity(p: Payload, yamlText: string): Promise<SeedResult>` — the same format and upsert semantics as S7's `seedIdentity`.
  - `@sbx/payload/testing`: `payloadContractSubject(p: Payload): IdentityContractSubject`.

- [ ] **Step 1: tests.** `headers.test.ts`: `"A@B.com "` → `a@b.com`; groups `"a, b,,a"` and the array `["a,b","c"]` → `["a","b","c"]`; no email → `null`. `identity-contract.test.ts`: `runIdentityStoreContract("payload", …)`. `resolve-session.test.ts` on top of the contract: 10 parallel first logins → 1 user, 1 team `personal:true`; the email is taken by a placeholder with a membership when a known `sub` changes email → the membership is moved, the placeholder deleted; a repeated login with the same groups does not change the user row's `updatedAt`; removing the operator group → `isOperator:false`.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `payload: resolveSession and PayloadIdentityStore`.

### Task 4: `PayloadConfigReader` and the `ConfigReader` contract suite

**Files:**
- Create: `packages/config/src/testing.ts` (export `./testing`), `packages/config/test/contract.ts`, `packages/payload/src/config-reader.ts`
- Modify: `packages/config/package.json`, `packages/config/test/static.test.ts`
- Test: `packages/payload/test/config-reader.test.ts`

**Interfaces:**
- Produces:
  - `@sbx/config/testing`: `runConfigReaderContract(name: string, make: (fx: ConfigFixture) => Promise<ConfigReader & {close?(): Promise<void>}>): void`; `ConfigFixture` — templates (enabled and disabled, `windows`), sizes (two, with an order), pool targets, the quota of one team with an empty field, `defaults`. Checks: `template`/`size` by slug and `null`; `templates()`/`sizes()` in configuration order (`sortOrder`); `poolTargets`; `teamQuota` with `defaultQuota` substituted for empty fields and zeros for a nonexistent team (§7, S6 S3 — for Static: the default quota, record the difference in the contract via the parameter `unknownTeamQuota: "default" | "zero"`); `defaults()` with all `PlatformDefaults` fields.
  - `class PayloadConfigReader implements ConfigReader` — `constructor(o: {payload: Payload; listen?: {databaseUrl: string}; ttlMs?: number /*5000*/})`, `start(): Promise<void>` (LISTEN `sbx_config`, cache reset on any notification and on reconnect), `close()`. `defaults()` always reads the global without a cache (C7: `routes.lookup`), the rest is cached.
- [ ] **Step 1: tests:** the contract for Static (in `packages/config`) and Payload; a template change via the Local API is visible through `template()` ≤ 1 s after commit (LISTEN), without LISTEN — after `ttlMs`.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `config: ConfigReader contract; payload: PayloadConfigReader`.

### Task 5: environments in `runtime`

**Files:**
- Create: `db/migrations/0400_environments_runtime.sql`
- Modify: `packages/auth/src/environments.ts` (table `runtime.environments`), `packages/db/src/schema/runtime.ts` (if tables are listed there), `docs/roadmap.md` (range `0400–0499` — S8)
- Test: `packages/auth/test/environments.test.ts`, `packages/db/test/*` (if there is a check of the table list)

- [ ] **Step 1:** migration test: rows of `identity.environments` (with `team_id` and `updated_by`) are copied to `runtime.environments` with the same `id`, the ciphertext is decrypted by `PgEnvironmentStore`; inserting an environment for a team that is not in `identity.teams` works.
- [ ] **Step 2–4:** `0400`: `CREATE TABLE runtime.environments (… like identity.environments, without REFERENCES …)`, unique indexes `(team_id, name)` and `(team_id) WHERE is_default`, `INSERT … SELECT` from `identity.environments`. Do not drop the old table (contract — later). All `@sbx/auth` and `@sbx/api` (environments) tests — PASS.
- [ ] **Step 5: commit** `db: environments move to runtime (0400)`.

### Task 6: `api` and `worker` on Payload

**Files:**
- Modify: `apps/api/src/{settings.ts,server.ts}`, `apps/api/src/routes/ops*.ts` (readyz), `apps/api/package.json`, `apps/api/Dockerfile`, `apps/api/README.md`; `apps/worker/src/{env.ts,main.ts}`, `apps/worker/package.json`, `apps/worker/Dockerfile`
- Test: `apps/api/test/payload-deps.test.ts`, `apps/worker/test/env.test.ts`

- [ ] **Step 1: tests.** `payload-deps.test.ts`: `buildDeps` with a real Postgres (runtime and Payload migrations) brings up `PayloadIdentityStore` and `PayloadConfigReader`: `/v1/templates` returns the `linux` seed; `SBX_IDENTITY_FILE` with a key → `GET /v1/me` by that key `200`; without applied Payload migrations `/readyz` → `503` with `details.reasons` containing `payload_migrations`. Worker: `PAYLOAD_SECRET` is mandatory, `SBX_CONFIG_FILE` is not needed.
- [ ] **Step 2–4:** `api`: `PAYLOAD_SECRET` is mandatory, `SBX_CONFIG_FILE` removed, identity/config — Payload, `seedPayloadIdentity` at startup; `worker`: `ConfigReader` — `PayloadConfigReader`, `assertPayloadMigrated` in readiness. Dockerfiles — the `packages/payload` manifest in the install layer. README — the new variables.
- [ ] **Step 5: commit** `api, worker: Payload identity and config`.

### Task 7: C3 — operator endpoints and block semantics

**Files:**
- Create: `db/migrations/0206_sandbox_block_meta.sql` (`sandboxes.blocked_at timestamptz`, `blocked_by uuid`; `hosted_ports.blocked_at`, `blocked_by`; the `sbx_routes` trigger already reacts to `blocked` — check)
- Modify: `packages/core/src/service/*` (`block`, `unblock`, `blockPort`, `unblockPort`, `sandbox_blocked`/`port_blocked` checks, `list` with `allTeams`/`teamId`), `apps/api/src/routes/{sandboxes,ports}.ts`, `apps/api/src/schemas/*`, `apps/api/openapi/v1.json`, `packages/sdk-ts` (gen + facade: `sbx.operator.listSandboxes`, `sb.block`, `sb.unblock`, `sb.ports.block`/`unblock`), `packages/sdk-py` (gen)
- Test: `packages/core/test/service-block.test.ts`, `apps/api/test/operator.test.ts`, route-table/conformance

**Interfaces:**
- Produces (HTTP, §17.1 C3): `GET /v1/sandboxes?allTeams=true[&teamId=team_…]` (resources with `teamId`); `POST /v1/sandboxes/{sandbox}/block {reason:"operator"|"abuse", note?: string ≤ 500}` → Sandbox; `POST …/unblock` → Sandbox; `POST /v1/sandboxes/{sandbox}/ports/{port}/block {reason, note?}` and `/unblock` → HostedPort. Sandbox and HostedPort get `blocked: boolean`, `blockReason: "operator"|"abuse"|null`. All of them only for `principal.kind === "session" && isOperator`, otherwise `403 forbidden`; the operator does not need `Sbx-Team` for block (the sandbox is looked up across all teams). A `sandbox_events` event `blocked`/`unblocked` with `{reason, note, by}`.
- Semantics (§17.1, the paragraph "Block semantics") literally: a blocked sandbox — for a non-operator `403 forbidden {details.reason:"sandbox_blocked"}` on exec/PTY/file writes/publishing and changing ports/`resume`/`fork`/`recover`/`extend`/save snapshot/`PUT`/`PATCH /env`/`PATCH` sandbox; reads, `stop`, `delete` are allowed. A port — `403 port_blocked` on `PUT`/`rotate-token`/`DELETE` of that port.
- [ ] **Step 1: tests.** core: every forbidden action → `sandbox_blocked` for a non-operator and passes for an operator; `stop`/`delete` pass; unblock lifts it immediately; `NOTIFY sbx_routes` on block/unblock. api: a non-operator (session), a team key, an operator's JWT → `403` on all five endpoints; `allTeams` of an operator session sees other teams and the `teamId` filter; `routes.lookup` of a blocked one → `blocked: true, blockReason`. OpenAPI drift and conformance are green, an `oasdiff`-like check (additions only) — compare paths and schemas with `main`.
- [ ] **Step 2–4: FAIL → implementation → PASS;** `pnpm --filter @sbx/sdk gen`, Python generation, their tests.
- [ ] **Step 5: commit** `api, core: operator blocks (S8 C3)`.

### Task 8: `ctl-idp-sync`

**Files:**
- Create: `packages/payload/src/idp-sync/{keycloak,sync}.ts`
- Modify: `apps/worker/src/{env.ts,main.ts,metrics.ts}`, `apps/worker/README.md` (if present)
- Test: `packages/payload/test/idp-sync.test.ts`, `apps/worker/test/idp-sync-wiring.test.ts`

**Interfaces:**
- Produces:
  - `class KeycloakAdminClient` — `constructor(o: {baseUrl: string; realm: string; clientId: string; clientSecret: string; fetch?: typeof fetch; pageSize?: number /*100*/})`; `listUsers(): Promise<{id: string; enabled: boolean}[]>` (client credentials token, `GET /admin/realms/{realm}/users?briefRepresentation=true&first=&max=` until an empty page; any non-2xx is an exception); `userExists(id): Promise<boolean>` (`404` → `false`).
  - `class KeycloakIdpSync implements IdpSync` — `constructor(o: {payload: Payload; keycloak: KeycloakAdminClient; onAbort?(r: {reason: "mass_deactivation"; wouldDeactivate: number; active: number}): void; log?})`; `run(): Promise<IdpSyncResult>` where `IdpSyncResult = {deactivated: string[]; reactivated: string[]; aborted: boolean}`.
- Algorithm (§20.1): a full walk → a plan; `idp_deleted` only after `userExists == false`; placeholders are not touched; a deactivation plan of `n` with `a` active users with an `idpSubject`: `n > 5 && n > 0.2·a` → change nothing, `onAbort`; otherwise via the Local API `active:false, deactivatedReason, deactivatedAt` (hooks send `NOTIFY`), reactivation only for `idp_*`; for each team where the user is a member — `team-notices {kind:"member_deactivated", user, apiKeys:[{id,name,prefix}]` the unrevoked team keys created by them`}`.
- [ ] **Step 1: tests** (a fake Keycloak — `node:http`): disabled → `idp_disabled` and a notice with the list of their keys in each of their teams, keys not revoked; missing + `404` → `idp_deleted`; missing but `GET /users/{id}` `200` → untouched; an operator's deactivation (`operator`) is not lifted; re-enabled (`idp_disabled`) → active; an empty list with 10 active → `aborted`, nobody deactivated; 6 of 20 (30%) → `aborted`; 5 of 10 → applied (not more than 5); `500` on the second page → exception, no changes. Worker: without `SBX_IDP_SYNC_KEYCLOAK_URL` the controller is not registered; with it — `ctl-idp-sync` in the list, the metric `sbx_idp_sync_aborted`.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `payload, worker: ctl-idp-sync`.

### Task 9: `apps/web` — skeleton, authentication, CSRF, admin, dev proxy

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,next.config.ts,postcss.config.mjs,components.json,vitest.config.ts,Dockerfile,.dockerignore,healthcheck.js,README.md}`, `apps/web/src/payload.config.ts` (`buildSbxConfig` from env + the admin import map), `src/proxy.ts`, `src/lib/{env,security-headers,session,api}.ts`, `src/app/(payload)/…` (from the Payload template: `admin/[[...segments]]`, `cms-api/[...slug]/route.ts`, `layout.tsx`, `importMap.js`), `src/app/healthz/route.ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/app/page.tsx` (redirect to `/app/t/<defaultTeam>`), `src/app/(app)/app/t/[team]/layout.tsx` (the frame of §9.3, team switcher, "no access to the team"), `src/components/ui/*` (shadcn: button, input, dialog, table, select, tabs, badge, dropdown-menu, tooltip, sonner), `src/app/globals.css`, `dev/auth-proxy.ts`, `dev/dev.ts`
- Modify: `packages/payload/src/auth-strategy.ts` (the `oauth2-proxy` strategy: `authenticate({headers, payload})` → `resolveSession` with a cache, decision 8), `pnpm-workspace.yaml` (if needed), `biome.json` (ignore `.next`, `importMap.js`)
- Test: `apps/web/test/{proxy,security-headers,auth-proxy,strategy}.test.ts`

**Interfaces:**
- Produces:
  - `web` env (`src/lib/env.ts`, zod, all errors at once): `DATABASE_URL`, `PAYLOAD_SECRET`, `SBX_APP_ORIGIN`, `SBX_OPERATOR_GROUPS`, `SBX_SBX_DOMAIN`, `SBX_API_PUBLIC_URL`, `SBX_LOGOUT_URL?`.
  - `proxy.ts`: for all paths except `/healthz` and Next static files: no `X-Auth-Request-Email` → `401` HTML "not signed in"; an unsafe method with `Origin !== SBX_APP_ORIGIN` → `403`; `securityHeaders(env)` headers on responses.
  - `securityHeaders(o: {sbxDomain: string}): Record<string,string>` — CSP `default-src 'self'; frame-ancestors 'self'; connect-src 'self'; frame-src https://*.<sbxDomain>; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'` (the exact list as Payload admin and Next require; record it in the README), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
  - `getAppSession(): Promise<AppSession>` (`src/lib/session.ts`, server-only) — `payload.auth({headers})`; `type AppSession = {user: {id: string /*usr_*/; email; name}; teams: {id: string /*team_*/; name; role; personal}[]; defaultTeamId: string; isOperator: boolean}`; a deactivated user → a `403` page "account disabled", `identity_conflict` → `403` with the text of §5.3.
  - The client provider `SbxProvider` (`src/lib/api.ts`): `new Sbx({baseUrl: "/api"})` + `QueryClient`; `useSbx(teamId)` returns an SDK with `Sbx-Team`.
  - `dev/auth-proxy.ts` — §13 literally (only `127.0.0.1`, strips `X-Auth-Request-*`, sets them from the cookie `sbx_dev_identity`, `/__dev/login` with user/second user/operator buttons, `/__dev/logout`, routes `/api/*`→`127.0.0.1:8081` without `/api`, `/sbx-auth/*`→`:8081`, the rest →`127.0.0.1:3001`, WebSocket upgrade). `pnpm --filter @sbx/web dev` — `next dev -p 3001` + the proxy.
- [ ] **Step 1: tests.** `proxy.test.ts`: without the header — `401`; `POST` with `Origin: https://evil` — `403`; without `Origin` on `POST` — `403`; `GET /healthz` without headers — `200`. `security-headers.test.ts`: the CSP contains `frame-ancestors 'self'` and `frame-src https://*.sbx.example.com`. `auth-proxy.test.ts`: a client `X-Auth-Request-Email: evil@x` is stripped, without a cookie the upstream gets a request without headers; a WebSocket upgrade reaches the upstream; it refuses to listen on `0.0.0.0`. `strategy.test.ts`: the strategy returns a user with `collection:"users"`, without headers — `{user:null}`.
- [ ] **Step 2–4: FAIL → implementation → PASS;** `next build` passes (`output: "standalone"`); there is no `auth-proxy` in `.next/standalone` (a check in the build test or the script `check:image`). `/admin` opens behind the dev proxy for an operator, a non-operator sees Payload's `unauthorized` page.
- [ ] **Step 5: commit** `web: Next.js + Payload skeleton, auth, CSRF, dev proxy`.

### Task 10: server actions, team, account

**Files:**
- Create: `apps/web/src/actions/{teams,members,account,notices}.ts`, `src/lib/permissions.ts`, pages `src/app/(app)/app/t/[team]/settings/page.tsx`, `src/app/(app)/app/teams/new/page.tsx`, `src/app/(app)/app/account/page.tsx`
- Test: `apps/web/test/{permissions,actions}.test.ts` (actions — with a real Postgres and Payload, without Next: the action functions accept a `ctx` with a session)

**Interfaces:**
- Produces: the actions of §9.11 with signatures `createTeam(name)`, `renameTeam(teamId, name)`, `inviteMember(teamId, email, role)`, `setRole(membershipId, role)`, `removeMember(membershipId)`, `leaveTeam(teamId)`, `setDefaultTeam(teamId)`, `acknowledgeNotice(noticeId)` → `Promise<{ok: true; …} | {error: {code: "forbidden"|"not_found"|"validation"|"last_owner"|"team_limit"|"already_member"; message: string}}>`. Each is a `"use server"` wrapper over `…Impl(ctx: {payload; session: SessionIdentity}, …)`; transaction `initTransaction`, a rights check by `memberships` inside it, zod, Local API `overrideAccess:true` with `req`.
  - `can(session, team, action): boolean` (`src/lib/permissions.ts`) — the table of §6.2.
- Pages: settings — name (rename for `owner`), members (email, name, role, "not signed in yet", last login), invite/setRole/remove/leave, quota and usage (`/v1/limits`), a `team-notices` banner with "revoke selected" (a `DELETE /v1/api-keys/{id}` call via the SDK) and `acknowledgeNotice`; teams/new; account — SSH keys (SDK `GET/POST/DELETE /v1/ssh-keys`, the errors `ssh_key_in_use` and the type — as text), default team, profile read-only, "Sign out" (`/oauth2/sign_out?rd=…` + a hint about `sbx login`).
- [ ] **Step 1: tests.** `permissions.test.ts` — the whole table of §6.2. `actions.test.ts`: `member` → `forbidden` on rename/invite/setRole/remove of another; a non-member → `forbidden` (also for `acknowledgeNotice`); an `owner` cannot remove/delete the last `owner` (`last_owner`); inviting into a personal team → `forbidden`; a 4th shared team → `team_limit`; a repeated invitation → `already_member`; inviting a new email creates a placeholder; `leaveTeam` from the default team → `defaultTeam` = the personal one; an operator can rename/invite/setRole/remove.
- [ ] **Step 2–4: FAIL → implementation → PASS.**
- [ ] **Step 5: commit** `web: team, members, account (server actions)`.

### Task 11: dashboard — sandboxes, create, snapshots, keys

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/{page.tsx,sandboxes/new/page.tsx,snapshots/page.tsx,keys/page.tsx}`, `src/features/{sandboxes,create,snapshots,keys}/*.tsx`, `src/lib/errors.ts` (API code → text)
- Test: `apps/web/test/{errors,create-form}.test.ts` (logic without DOM: parsing labels/env, converting the form into the `POST /v1/sandboxes` body)

- [ ] The list §9.4 (5 s polling while the tab is visible, `nextCursor`, filters, quota from `/v1/limits`, transitional states, the block lock, the actions stop/resume/fork/terminal/delete with slug input); create §9.5 (catalog, `allowedSizes`, from a snapshot, labels, env, secrets `type=password`, secret files, TTL/idle, environment — a list or `none`, the errors `quota_exceeded`/`out_of_capacity`/`slug_taken`/`template_unavailable` as text); snapshots §9.7; keys §9.8 (presets `read-only`/`ci`/`full`, lifetime 90/≤365, the secret once with `export SBX_API_KEY=…` and `sbx login --key-stdin`, rotate, revoke, the mark "creator left/deactivated" by `createdBy.member`/`active`, buttons only for `owner`, revoked ones collapsed, the `sbx login` hint).
- [ ] Tests: `errors.test.ts` — every code of §9.5 has its own text, `out_of_capacity` suggests a retry; `create-form.test.ts` — secrets do not get into `searchParams`, empty labels/env rows are dropped, `environment: null` for "none".
- [ ] **commit** `web: sandboxes list, create, snapshots, keys`.

### Task 12: sandbox page

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/sandboxes/[slug]/page.tsx`, `src/features/sandbox/{header,overview,terminal,commands,output-view,files,ports,ssh,env,desktop}.tsx`, `src/features/sandbox/live.ts` (long-poll `waitFor` + 10 s polling)
- Test: `apps/web/test/{live,files-path}.test.ts`

- [ ] Per §9.6 literally: the header and buttons (Stop/Resume/Fork/Recover/Extend/Save snapshot/Delete/rename slug), the operation strip, the error block. Terminal — the SDK `sb.pty()` + xterm.js 6 (`fit`, `web-links`, `search`), tabs, reconnecting to `GET /commands?mode=pty&status=running` with `tailBytes 65536`, Detach/Close, the "reconnecting…" strip, codes `4409`/`4503`/`4401`. Commands — a table, Run command (`sb.start`), the `cmd.follow` output in xterm read-only, stderr highlighted, `truncated`, Download `/api/v1/…/output?stream=…&offset=…&limit=4194304&team=…`, Kill/Signal. Files — a list with pagination, breadcrumbs, hidden files, text preview ≤ 1 MiB in `<pre>`, download via a link with `?team=`, upload (≤ 64 MiB `PUT`, larger — `sb.files.upload` with progress), mkdir/move/delete. Ports — a list, publish (`token`/`sso`/`public`, `hostRewrite`), the token and `urlWithToken` once in a dialog, rotate, unpublish, the lock, `public_disabled` — a hint. SSH — the command, `known_hosts`, `hasKeys:false` → a link to the account. Env — a table, secrets `•••`, `PATCH /env` per row, `delivered:false` → a hint. Desktop — an S10 stub when the capability is `desktop`.
- [ ] Tests: `live.test.ts` — `waitFor` = all states except the current one, the loop stops on `AbortSignal`; `files-path.test.ts` — breadcrumbs, `..`, the download link encodes the path and adds `team`.
- [ ] **commit** `web: sandbox page (terminal, commands, files, ports, ssh, env)`.

### Task 13: environments and the "Operator" section

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/environments/page.tsx`, `src/features/environments/*`, `src/app/(app)/app/operator/page.tsx` (server: the session's `isOperator`, otherwise `403`; the list of teams from Payload → to the client), `src/features/operator/*`, `apps/web/src/admin/delete-team-button.tsx` (decision 12)
- Test: `apps/web/test/operator-page.test.ts` (a server guard without Next: the function `requireOperator(session)`)

- [ ] Environments §10 (list, create/edit/delete — `owner` only, secret values are not shown, `isDefault`, repositories, `excludeOwnerSecrets`); Operator §9.10 (all sandboxes `allTeams`, filters team/state/q, a team column, Block/Unblock with a reason and a note, ports, Stop, Delete with the `Sbx-Team` of the sandbox's team, a jump to the sandbox page, a `/admin` link). The team delete button in `/admin` (decision 12).
- [ ] **commit** `web: environments, operator section, admin team delete`.

### Task 14: compose and dev-cp

**Files:**
- Modify: `deploy/compose/compose.yaml` (`web-migrate`, `web`; network `web-internal` with `internal: true`, containing only `web` and oauth2-proxy (+ Postgres for `web`); `api`/`worker` — `PAYLOAD_SECRET`, `depends_on web-migrate`, without `SBX_CONFIG_FILE`), `deploy/compose/oauth2-proxy/oauth2-proxy.yaml` (upstream `/` → `http://web:3000`, `/api/` → `api:8081`), `deploy/compose/secrets-init/init.sh` (`payload-secret`), `deploy/compose/README.md`, `infra/dev-cp/{compose.dev-cp.yaml,README.md}` (routes: oauth2-proxy `/` → web, `/api` → api; `SBX_GATEWAY_COOKIE_CROSS_SITE=true` for previews), worker env `SBX_IDP_SYNC_*`
- Test: `docker compose -f deploy/compose/compose.yaml config -q`; the manual smoke below

- [ ] `docker compose up -d --build` locally (not CT 590): login via Keycloak (`dev@example.com`) → `/app` → the personal team; `/api/v1/me` 200; `/admin` — a `403` page for a non-operator. The `web` port is not published outside, from a container in the `sbx` network (not `web-internal`) `web:3000` is unreachable.
- [ ] **commit** `compose: web behind oauth2-proxy, web-migrate; dev-cp routes`.

### Task 15: E2E (Playwright) and security

**Files:**
- Create: `apps/web/e2e/{playwright.config.ts,global-setup.ts,fixtures.ts}`, `apps/web/e2e/backend/{main.ts,Dockerfile}`, `deploy/compose/e2e.yaml`, `apps/web/e2e/*.spec.ts`, `deploy/compose/keycloak/realm-sbx-e2e.json` (if test users are needed: `alice`, `bob`, `op` in the group `sbx-operators`, verified emails, no password change)
- Modify: `apps/web/package.json` (`test:e2e`)

- [ ] The §15 E2E scenarios that are feasible with fakes: login by a new user → personal team → create → `ready` → terminal (echo, resize, reload and reconnect without losing output); commands: run, live output, kill; files: upload (≥ 100 MiB in chunks — under the flag `SBX_E2E_LARGE=1`, 70 MiB by default), download, preview, rename, delete; port: `token` once, rotate, `public` with the switch off (via `/admin`) — a clear error; API key: create → `GET /v1/me` with it on the public listener → revoke → `401`; an owner invites → the second logs in and sees the sandbox; a `member` without buttons and a direct server action → `forbidden`; an operator blocks someone else's sandbox → `routes.lookup` `blocked`, the owner gets `sandbox_blocked` on exec; a non-operator — `403` on `/app/operator`, `/admin`, `allTeams`; revoking a key with an open stream → `error unauthorized`; Keycloak: disable a user via the Admin API → a run of `ctl-idp-sync` (a trigger endpoint in `e2e-backend`) → `active:false`, the owner sees a notice with the list of keys, the keys work; an empty Keycloak response (substituted via a backend flag) → `aborted`, nobody disabled.
- [ ] Security: a request to oauth2-proxy with forged `X-Auth-Request-Email`/`-User`/`-Groups` before login — a redirect to login; after login, forged `X-Auth-Request-Groups: sbx-operators` do not grant `/app/operator`; a server action and `POST /cms-api/users` with `Origin: http://evil` → `403`; no E2E response (intercepting all page responses) contains `secretHash`, secret values, or port tokens after the dialog; the `web` container does not contain `auth-proxy` (`docker run … find /app -name 'auth-proxy*'` is empty).
- [ ] **commit** `web: e2e and security tests`.

### Task 16: documents and final verification

**Files:**
- Modify: `docs/specs/s8-web.md` (a new §21 "MVP implementation (`s8-impl`)": decisions 1–12 and everything that turned out differently), `docs/roadmap.md` (S8 status, range `0400–0499`), `docs/architecture.md` (§17.6 of the spec), `apps/web/README.md`, `packages/payload/README.md`, `apps/api/README.md`, `deploy/compose/README.md`

- [ ] `mise exec -- pnpm -r test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` (including `next build`) — green; E2E — green locally.
- [ ] A review of the whole branch by a fresh subagent, fixes.
- [ ] **commit** `docs: S8 implementation notes`; `git push origin s8-impl`.
