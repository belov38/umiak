# @sbx/payload

Payload 3 config of the platform (S8 §7): collections `users`, `teams`,
`memberships`, `api-keys`, `team-notices`, `ssh-keys`, `templates`, `sizes`,
`pool-targets`, global `platform-defaults`, all in the Postgres schema
`payload`. `api` and `worker` use it through the Local API (plain Node),
`apps/web` mounts the same config in Next. Nothing here imports React: admin
components are referenced by import-map path strings from `apps/web`.

## API

- `buildSbxConfig(o)` — the sanitized config: `postgresAdapter({schemaName:
  "payload", idType: "uuidv7", push: false})`, GraphQL off, REST at
  `/cms-api`, admin at `/admin`, `csrf: [appOrigin]`, `cookiePrefix:
  "__Host-payload"`, `admin.user: "users"`, telemetry off, a no-op email
  adapter. `o.operatorGroups` is kept in `config.custom.sbx`.
- `getSbxPayload(o)` / `closeSbxPayload(databaseUrl)` — one instance per
  process and database URL (`new BasePayload().init`, not `getPayload`, so no
  Next HMR socket is opened in `api`/`worker`).
- `migrateSbxPayload(p)`, `pendingPayloadMigrations(p)`,
  `assertPayloadMigrated(p)` — see below.
- `isOperatorReq(req)` — `req.user?.isOperator === true`. Every collection
  and the global are operator-only through access; `api-keys.create` is
  refused to everyone.
- `notify(req, channel, payload)` — `pg_notify` in the transaction of the
  Payload request (`txQuery(req, sql)` runs any SQL there).

## Identity (S8 §5)

- `parseAuthHeaders(h)` — the oauth2-proxy headers (§5.2): email lowercased
  and trimmed (none, empty, repeated or comma-joined → `null`: never pick
  one of two emails), `user` = `sub`, groups split by `,`, trimmed,
  without empty names and duplicates, `preferredUsername`. Takes `Headers`
  or a Node header record.
- `resolveSession(payload, h, {operatorGroups, req?})` — JIT of §5.3 in one
  Payload transaction: user rows are locked (`FOR UPDATE`), writes go
  through the Local API with the same `req`, so hooks notify in it.
  Find by `idpSubject`; a changed email is taken over, a stub holding it
  (no `idpSubject`, never logged in, active) gives its memberships to the
  user (create, or raise to `owner`, then delete the stub's, one id at a
  time) and is deleted; any other holder is `identity_conflict`. Else find
  by email: a stub is bound (`idpSubject`, `name` if empty, personal team
  if it owns none); another `idpSubject` is `identity_conflict`. Else
  create user + personal team (`<email>'s team`, the S7 contract name) +
  `owner` membership, `personalTeam` = `defaultTeam`. `active: false` is
  `user_disabled`, no `sub` is `subject_required`. Only changed fields are
  written: `groups` (compared as a set), `isOperator`, `preferredUsername`,
  `lastLoginAt` (at most once per 60 s; bookkeeping, no `sbx_identity`).
  Concurrent first logins collide on the unique email/`idpSubject`; the
  loser retries (3 attempts) and finds the winner's row. With `o.req` that
  already has a transaction the work joins it and is not retried.
- `oauth2ProxyStrategy` — the auth strategy of `users` (§5.4):
  `{user: {...doc, collection: "users", _strategy: "oauth2-proxy"}}` or
  `{user: null}`. A refused login (`subject_required`, `user_disabled`,
  `identity_conflict`) also gets the response header
  `X-Sbx-Auth-Denied: <code>` (Payload copies it to REST responses).
  Operator groups come from `config.custom.sbx.operatorGroups`.
- `authenticateHeaders(payload, headers)` — the same check with the reason,
  for web's own pages: `{kind: "anonymous", status: 401}` (no email),
  `{kind: "denied", status: 401 | 403, reason}` (`subject_required` → 401,
  the others → 403), or `{kind: "session", claims, session}`. Other errors
  (database) are thrown.
- `authenticateRequest(payload, headers)` — `authenticateHeaders` plus the
  `users` document (`user`), through the session cache of the instance when
  one is attached. The strategy uses it too, so `/admin` and `/app` agree.
- Session cache (plan decision 8): `buildSbxConfig({sessionCache: {ttlMs?,
  listen?}})` attaches it in `onInit` (web only): 30 s per claims key
  (`sessionCacheKey`: sha256 of email, sub, sorted groups, names), only
  sessions are cached (refusals and errors are not), concurrent loads of a
  key share one call, a load that spans a flush is not stored. `LISTEN
  sbx_identity` on its own connection (`sbx-session-listener`) flushes it
  on any payload but `sandboxes:`, `api-keys:`, `ssh-keys:` and on every
  (re)connect. `closeSbxPayload` closes it; `attachSessionCache` /
  `detachSessionCache` for an instance from Payload's `getPayload`.
- `PayloadIdentityStore` — `IdentityStore` of `@sbx/auth` over the
  collections, the semantics of `PgIdentityStore`; passes the contract
  suite (`test/identity-contract.test.ts`). Reads are SQL over the
  `payload` schema; writes go through the Local API (NOTIFY from hooks);
  `touchApiKey`/`touchSshKey` are a plain `UPDATE … last_used_at` without
  hooks or NOTIFY.
- `seedPayloadIdentity(payload, yaml)` — `SBX_IDENTITY_FILE` with the
  format and upsert semantics of `seedIdentity` of `@sbx/auth`, in one
  transaction. New teams, users and keys keep the file's ids: the Local API
  cannot create with a given id, so they are inserted by SQL and the
  NOTIFY of the create hooks is sent explicitly; updates and memberships go
  through the Local API. Only differing values are written, so a second
  load writes and sends nothing.
- `@sbx/payload/testing`: `payloadContractSubject(payload)` (store +
  seeding of the contract suite). Its `removeMember` is a plain `DELETE`
  (the suite removes the last owner of a team, which the hook refuses).

## NOTIFY hooks (S8 §8)

Hooks run inside the transaction of the Payload operation: a Local API call
without `req` opens and commits its own, one with `req` uses the caller's
(`initTransaction`/`commitTransaction`). `notify` sends through the adapter
session of `req.transactionID`, so Postgres delivers after commit and a
listener reads the new data; a rolled back write sends nothing. A failing
`pg_notify` fails the hook and Payload rolls the write back. Without a
transaction (a bare `createLocalReq`) the statement is its own transaction;
a `transactionID` whose session is gone (committed or rolled back) throws.

| Channel | Payload | Sent by |
|---|---|---|
| `sbx_identity` | `'<collection>:<uuid>'`, memberships `'memberships:<userUuid>:<teamUuid>'` (S7 §23.10) | `users`, `teams`, `memberships`, `api-keys`, `ssh-keys` after change/delete; updates that only change `lastUsedAt`, `lastLoginAt`, `updatedAt` (or nothing) send nothing |
| `sbx_config` | `'<collection>:<uuid>'`, `'platform-defaults:global'` | `templates`, `sizes`, `pool-targets` (change/delete), `teams` (create, `quota` change, delete), `platform-defaults` |
| `sbx_routes` | `'*'` | `platform-defaults` when `publicPortsEnabled` or `ssoPortPolicy` changed |
| `sbx_ssh_revoke` | `user:usr_…`, `member:team_…:usr_…`, `key:key_…`, `team:team_…` | as the 0302/0303 triggers: a user becomes inactive (or an active one is deleted), a membership is deleted, a key gets `revokedAt` or a new `secretHash` while live (or a live key is deleted), a team is deleted |

`ssoPolicyEpoch` is owned by a `beforeChange` hook of `platform-defaults`:
`ssoPortPolicy` `any` → `team` adds 1, written values are ignored.

## Collection rules

Errors are `APIError(code, 400)` (message = code) or Payload
`ValidationError` (field path):

- `memberships`: the last `owner` of a team cannot be demoted or deleted
  (`last_owner`); the team row is locked (`FOR NO KEY UPDATE`) before the
  count, so concurrent removals serialize. Update and delete through access
  need an `id`: Payload runs the hooks of a bulk `where` operation in
  parallel in one transaction, where the count cannot see the siblings.
  Server code must not bulk-update or bulk-delete memberships through the
  Local API either. `user` and `team` are fixed (read-only through access,
  `membership_immutable` with `overrideAccess`): a membership is replaced by
  delete + create, so the delete closes the old SSH sessions.
- `teams` delete: one team by id only (no bulk delete through access); a
  personal team is refused (`personal_team`); otherwise
  `beforeDelete` deletes the team's memberships and team notices and sets
  `revokedAt` (and `revokedBy` = the request user) on its live keys, all
  through the Local API with `req`, so their hooks notify in the same
  transaction. Revoked keys are kept; the foreign key sets their `team` to
  null when the team row goes.
- `api-keys`: `team` is nullable in the database, required on create
  (validation). Through Payload access (/admin, REST) only `revokedAt` can be
  written, once; the hook sets `revokedBy` to the user of the request. api
  writes with `overrideAccess` and is not limited.
- `users` delete: only stubs (`idpSubject` and `lastLoginAt` empty, no
  memberships), checked in `beforeDelete` inside the transaction
  (`user_not_stub`); collection access only requires an operator.
- `templates`: `allowedSizes` is a non-empty list of existing size slugs,
  `defaultSize` is one of them; `slug` cannot change.
- `sizes`: `slug` cannot change; a size named by a template (`defaultSize`,
  `allowedSizes`) or a pool target cannot be deleted (`size_in_use`).

## ConfigReader (S8 §7, §8)

- `PayloadConfigReader({payload, listen?: {databaseUrl, reconnectDelayMs?}, ttlMs = 5000})`
  — `ConfigReader` of `@sbx/config` over `templates`, `sizes`, `pool-targets`,
  `teams.quota` and the global `platform-defaults`. `start()` opens a
  dedicated connection with `LISTEN sbx_config` (application name
  `sbx-config-listener`; rejects if the first connect fails, reconnects by
  itself with a growing delay); any notification and every (re)established
  LISTEN drops the cache. Without `listen` only `ttlMs` applies. `close()`.
- `templates()`/`sizes()`: `sortOrder`, then slug. Template defaults as in
  `StaticConfigReader` (`name` = slug, `loginUser` `user`, capabilities
  `exec, files, ssh`).
- `teamQuota(id)`: empty team fields take `platform-defaults.defaultQuota`
  (an empty default field takes the PoC quota 3 / 6144 / 10); a zero is a
  value. An unknown or deleted team, or an id that is not a UUID, gets zeros.
- `defaults()` is never cached (C7: `routes.lookup`).
- The contract suite is `runConfigReaderContract` of `@sbx/config/testing`
  (`test/config-reader.test.ts`).

## IdP sync (S8 §20.1)

`ctl-idp-sync` of `apps/worker` runs `KeycloakIdpSync` (offboarding variant
A).

- `KeycloakAdminClient({baseUrl, realm, clientId, clientSecret, fetch?,
  pageSize = 100, timeoutMs = 10000})` — client credentials token at
  `<baseUrl>/realms/<realm>/protocol/openid-connect/token` (cached until
  30 s before `expires_in`; a `401` of the admin API renews it once).
  `listUsers()` pages `GET <baseUrl>/admin/realms/<realm>/users?briefRepresentation=true&first=&max=`
  until an empty page and returns `{id, enabled}[]`; any non-2xx, timeout
  or malformed page throws `KeycloakError` (never a partial list).
  `userExists(id)`: `404` → `false`, other non-2xx throw. Errors carry
  status and path, never the secret or the token. The realm client
  `sbx-worker` needs the service account role `view-users` of
  `realm-management` (`deploy/compose/keycloak/realm-sbx.json` has it).
- `KeycloakIdpSync({payload, keycloak, onAbort?, log?, now?}).run()` →
  `{deactivated, reactivated, aborted, abort?}` (Payload user uuids). One
  pass: the full list, then the plan over users with an `idpSubject`
  (stubs are never touched):
  - active, `enabled: false` → `idp_disabled`;
  - active, missing from the list → `idp_deleted` only if `userExists` is
    `false`;
  - inactive with `deactivatedReason` `idp_*` and `enabled: true` →
    reactivated (`active: true`, reason and `deactivatedAt` cleared).
    `operator` (or no reason) is never lifted.
  - Guard: `n` planned deactivations, `a` active users with an
    `idpSubject`; `n > 5 && n > 0.2·a` → nothing changes, `onAbort({reason:
    "mass_deactivation", wouldDeactivate: n, active: a})`, result
    `aborted: true` (the worker turns it into `sbx_idp_sync_aborted_total`,
    gauge `sbx_idp_sync_aborted` = 1 and `log.error`).
- Writes: one Payload transaction per user; the row is locked
  (`FOR UPDATE`) and checked again (same `idpSubject`, still active / still
  `idp_*`), so a concurrent operator deactivation wins. The update goes
  through the Local API with `req`: the `users` hooks send
  `sbx_identity users:<uuid>` and `sbx_ssh_revoke user:usr_…`. A failed
  change is logged and the others continue; the pass then throws (pg-boss
  retries, the next pass is idempotent).
- Notices: for every team the deactivated user is a member of, one
  `team-notices` row `{team, kind: "member_deactivated", user, apiKeys}`
  unless an unacknowledged one for (team, user) exists. `apiKeys` lists the
  team's non-revoked keys the user created: `[{id, publicId, name,
  prefix}]`, `id` the Payload uuid, `publicId` the `key_…` id of `/api/v1`
  (revoke through `DELETE /v1/api-keys/{publicId}` or the dashboard). Keys
  are not revoked.

## Migrations

- Apply: `DATABASE_URL=… PAYLOAD_SECRET=… node packages/payload/src/migrate.ts`
  (exit 0/1). It is our own runner, not `payload migrate` / `payload.db.migrate()`:
  Payload's runner calls `process.exit(1)` on a failed migration, prompts on
  dev-pushed batches and takes no lock. Ours runs each migration in a Payload
  transaction, records it in `payload.payload_migrations`, throws on failure
  and holds `pg_advisory_lock(727003)` for the run.
- Readiness: `assertPayloadMigrated` throws while a migration known to the
  code is not applied; applied migrations unknown to the code are fine.
- Create: change the config, then
  `node packages/payload/src/create-migration.ts <name>` and
  `pnpm exec biome check --write packages/payload`. It uses
  `payload.db.createMigration` without a database (diff against the latest
  `.json` snapshot), then rewrites the generated type imports and `index.ts`
  for Node type stripping (Payload writes imports without `.ts`). Nothing
  changed → no file. If Payload's import line is not the expected one, it
  exits 1 and names the file to fix by hand. The `payload migrate:create`
  CLI is not used: it loads the config through its own loader, and there is
  no `payload.config.ts` in this package.
- Drift: `test/schema.test.ts` runs `createMigration({skipEmpty: true})` on a
  copy of `src/migrations`; any schema change without a migration fails it.
- `src/migrations/index.ts` lists the migrations; commit the `.ts` and the
  `.json` snapshot of every migration.

The initial migration creates the schema and tables (generated), seeds
`platform-defaults` (S6/S7/S8 defaults), template `linux` and size `2gb`, and
copies `identity.teams/users/memberships/api_keys/
ssh_keys` with the same UUIDs when `identity.users` exists (plan decision 1).
No pool target is seeded (deviation from S8 §12, controller ruling): warm
pools are not in the MVP, as in `deploy/compose/config/sbx.yaml` (`pools: []`).
Copy rules: memberships get new ids; a user with an `idp_subject` gets
`lastLoginAt = createdAt` (so it is not a stub); `personalTeam` is the user's
personal team where they are `owner`; `createdBy` is set for personal teams
only; `rotated_at` is copied when 0303 is applied.

## Notes and deviations

- `idType: "uuidv7"` works in `@payloadcms/db-postgres` 3.92.1, but the id is
  generated in the app (`uuid` v7 `$defaultFn`): the `id` columns have **no
  database default**. Raw SQL inserts must pass `id` (`uuidv7()` of
  Postgres 18).
- `cookiePrefix: "__Host-payload"` is accepted by the config (cookie names
  `__Host-payload-token`, `-lng`, `-theme`). Payload has no login cookie here
  (local strategy off). Whether the admin UI sets its `-lng`/`-theme` cookies
  with `Secure; Path=/` (required by browsers for `__Host-`) can only be
  checked in `apps/web`; if not, those cookies are dropped, which only loses
  the admin language/theme preference.
- The adapter keeps one pool client checked out for good (`connect`), so the
  pool needs at least 3 connections for `migrateSbxPayload` (lock + migration
  transaction); it refuses smaller pools. `closeSbxPayload` does not wait for
  `pool.end()` for the same reason.
- Required relationships get `NOT NULL` with `ON DELETE SET NULL` foreign
  keys (Payload has no per-field `onDelete`). Deleting a team with
  memberships or team notices would fail in Postgres, so the team delete
  hook removes them first; `api-keys.team` is not required in the schema
  (migration `api_keys_team_nullable`) so keys survive the team.
- `pool-targets` is unique on (`template`, `size`, `providerId`) with
  `NULLS NOT DISTINCT` (Postgres 18), so a second target without a provider
  for the same template and size is rejected. Payload cannot express it: the
  clause is a hand edit of the initial migration and is not in the `.json`
  snapshot, so a later migration that recreates this index must add it again.
- Multi-valued fields (`groups`, `scopes`, `allowedSizes`, `capabilities`,
  `apiKeys`) are `json`: `select hasMany` would create extra tables.
- `api-keys.secretHash` has field read access `false` and is hidden in the
  admin: access-checked reads never return it; the Local API with
  `overrideAccess` (api) does.
- `esbuild` (via `drizzle-kit`) build scripts are disabled in
  `pnpm-workspace.yaml`; the platform binary comes from its optional package.

## Admin components

Components live in `apps/web` and are referenced by import-map path
(`src/admin-components.ts`, relative to the apps/web directory). JSON
fields use `JSON_FIELD_COMPONENT` (a textarea): Payload's Monaco editor
loads from a CDN, which web's CSP blocks. `admin.avatar` is `"default"`
(no Gravatar requests).
