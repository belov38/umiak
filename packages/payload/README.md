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

## NOTIFY hooks (S8 §8)

Hooks run inside the transaction of the Payload operation: a Local API call
without `req` opens and commits its own, one with `req` uses the caller's
(`initTransaction`/`commitTransaction`). `notify` sends through the adapter
session of `req.transactionID`, so Postgres delivers after commit and a
listener reads the new data; a rolled back write sends nothing. A failing
`pg_notify` fails the hook and Payload rolls the write back. Without a
transaction (a bare `createLocalReq`) the statement is its own transaction.

| Channel | Payload | Sent by |
|---|---|---|
| `sbx_identity` | `'<collection>:<uuid>'` | `users`, `teams`, `memberships` (id of the membership), `api-keys`, `ssh-keys` after change/delete; updates that only change `lastUsedAt`, `lastLoginAt`, `updatedAt` (or nothing) send nothing |
| `sbx_config` | `'<collection>:<uuid>'`, `'platform-defaults:global'` | `templates`, `sizes`, `pool-targets` (change/delete), `teams` (create, `quota` change, delete), `platform-defaults` |
| `sbx_routes` | `'*'` | `platform-defaults` when `publicPortsEnabled` or `ssoPortPolicy` changed |
| `sbx_ssh_revoke` | `user:usr_…`, `member:team_…:usr_…`, `key:key_…`, `team:team_…` | as the 0302/0303 triggers: a user becomes inactive (or an active one is deleted), a membership is deleted, a key gets `revokedAt` or a new `secretHash` while live (or a live key is deleted), a team is deleted |

`ssoPolicyEpoch` is owned by a `beforeChange` hook of `platform-defaults`:
`ssoPortPolicy` `any` → `team` adds 1, written values are ignored.

## Collection rules

Errors are `APIError(code, 400)` (message = code) or Payload
`ValidationError` (field path):

- `memberships`: the last `owner` of a team cannot be demoted, moved to
  another team or deleted (`last_owner`); the team row is locked
  (`FOR NO KEY UPDATE`) before the count, so concurrent removals serialize.
- `teams` delete: a personal team is refused (`personal_team`); otherwise
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
