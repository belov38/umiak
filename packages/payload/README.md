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
  refused to everyone; `users.delete` only matches stubs without
  `lastLoginAt` and without memberships.

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
  changed → no file. The `payload migrate:create` CLI is not used: it loads
  the config through its own loader, and there is no `payload.config.ts` in
  this package.
- Drift: `test/schema.test.ts` runs `createMigration({skipEmpty: true})` on a
  copy of `src/migrations`; any schema change without a migration fails it.
- `src/migrations/index.ts` lists the migrations; commit the `.ts` and the
  `.json` snapshot of every migration.

The initial migration creates the schema and tables (generated), seeds
`platform-defaults` (S6/S7/S8 defaults), template `linux`, size `2gb`, pool
target `linux/2gb = 1`, and copies `identity.teams/users/memberships/api_keys/
ssh_keys` with the same UUIDs when `identity.users` exists (plan decision 1).
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
  keys (Payload has no per-field `onDelete`). Deleting a team that still has
  memberships, team notices or API keys fails in Postgres: the team delete
  hook (S8 §6.4) has to remove or reassign those rows first.
- `pool-targets` is unique on (`template`, `size`, `providerId`); Postgres
  treats null `providerId` values as distinct, so two targets without a
  provider are not rejected by the index.
- Multi-valued fields (`groups`, `scopes`, `allowedSizes`, `capabilities`,
  `apiKeys`) are `json`: `select hasMany` would create extra tables.
- `api-keys.secretHash` has field read access `false` and is hidden in the
  admin: access-checked reads never return it; the Local API with
  `overrideAccess` (api) does.
- `esbuild` (via `drizzle-kit`) build scripts are disabled in
  `pnpm-workspace.yaml`; the platform binary comes from its optional package.
