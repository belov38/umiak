# S24 SPA without Payload implementation plan

> Execute task by task using `superpowers:executing-plans`. Product implementation
> starts after owner spec review in the master thread.

**Goal:** Replace Payload and Next without breaking upgrades.
**Architecture:** API-owned configuration in runtime, shared SQL readers, static
Vite output served by Hono through the existing quickstart ingress.
**Stack:** TypeScript, pg, Hono/zod-openapi, React 19, Vite, TanStack Router/Query.
**Spec:** `docs/specs/s24-spa-no-payload.md`.

## Global constraints

Use `mise exec --`; check registry before dependencies. Secrets only as files.
No live Proxmox/CT590 access. Branch `s24-spa`, reviewable commits and push, no
merge/session trailers. Applied SQL remains unchanged. CI stays manual-only.
Cutover declares `dbCompatible: false`; rollback restores DB/state as well as images.

## Review focus

- Nullable defaults and edited templates survive import rather than reseeding.
- Concurrent first login cannot duplicate owner/personal-team rows.
- All-scope team keys and forged peer/Origin never gain settings authority.
- Revocations/policy changes notify only after commit; bookkeeping stays silent.
- Deep links work; API/assets/traversal never return fallback HTML.

## Task 1: baseline and source fixture

Files: new `docs/plans/s24-spa-no-payload-acceptance.md`,
`apps/api/test/config-upgrade.test.ts`, helpers under `apps/api/test/fixtures/`.
Consumes source Payload migrations/published release; produces reproducible DB
and measurements before product changes.

- [x] Record initial SHA, comparable web image wall/cgroup peak/size, Compose
  steady/one-shot service counts and logical secrets, with exact commands.
- [x] Prepare populated source with owner, personal/shared teams, memberships,
  live/revoked/expired keys, SSH keys, edited/disabled templates, custom size,
  legacy unread pool rows, null retention and nondefault quotas; include revoked
  keys with deleted/NULL teams, nullable audit links and self-revocation links.
- [x] Write failing assertions for IDs/hashes/all fields, rerun no-op, unsupported
  source failure and target conflict rollback. Preserve fixture without requiring
  final production Payload dependency; document its provenance.
- [x] Commit baseline evidence and upgrade assertions.

## Task 2: schema, import, notifications

Files: new `db/migrations/0800_api_configuration.sql`,
`db/migrations/0801_import_payload.sql`,
`db/migrations/0802_pending_catalog_changes.sql`,
`packages/db/src/schema/configuration.ts`, `packages/db/test/configuration.test.ts`;
schema exports. Produces runtime tables/import via existing journal.

- [x] Add failing fresh seed, legacy import, incomplete source, interrupted import
  and conflicting target tests; implement explicit mappings from spec.
- [x] Translate pending Debian deferral into post-import SQL; test published
  source and already-updated source, preserving unrelated template edits.
- [x] Add commit/rollback NOTIFY tests for four channels, bookkeeping silence,
  rotation, user deactivation, membership/team deletion and route policies.
- [x] Implement triggers with existing payload/public-ID formats.
- [x] Run `mise exec -- pnpm --filter @umiak/db test` and import assertions.
- [x] Commit independently of runtime wiring.

## Task 3: shared SQL readers and runtime cutover

Files: `packages/auth/src/pg-store.ts`, seed and exports;
new `packages/config/src/pg-reader.ts`, listener and exports;
`apps/api/src/server.ts`, settings/deps/readiness;
replace worker Payload wiring in `apps/worker/src/payload.ts`, env/main/readiness.
Consumes pg pool; produces unchanged IdentityStore/ConfigReader interfaces.

- [x] Port identity/config contract tests including concurrent login, inactive
  owner, personal team, quota inheritance, reconnect and uncached defaults.
- [x] Implement SQL transactions/locks/seeding without overwriting imported data.
- [x] Wire API/worker to unified migration readiness; remove secret requirements.
- [x] Run auth/config/API/worker Vitest/typecheck and imported key auth check.
- [x] Commit adapter cutover.

## Task 4: settings API and clients

Files: new API settings routes/schemas/services under `apps/api/src/`, app
registration and generated OpenAPI/SDK files. Consumes Task 3 adapters; produces
the documented settings endpoints in the spec using public IDs/API envelopes.

- [x] Write failing owner-success, all-scope key denial, wrong Origin/peer/host,
  no-hash disclosure, bad ID and oversized body tests.
- [x] Move account/team/template action logic to transactional API services;
  implement catalog/default settings and runtime deletion guards.
- [x] Test immutable slugs, default-size membership, size-in-use, personal-team
  deletion, malformed quotas and concurrent owner/team mutation.
- [x] Generate OpenAPI with `mise exec -- pnpm --filter @umiak/api openapi`;
  regenerate both SDKs using package scripts; test/typecheck CLI and MCP.
- [x] Commit API and generated clients together.

## Task 5: SPA transition

Files: web package/config, new Vite config/index/main/router/routes, current
features/components/session/API helpers. Consumes SDK/settings; produces dist.

- [x] Recheck registry versions and replace Next scripts/config with Vite.
- [x] Port shell/session/team routes, navigation, lazy loading and fonts; retain
  visual components and existing sandbox/key/environment/snapshot URLs.
- [x] Replace server actions/loaders with SDK queries/mutations. Add owner
  settings catalog/defaults/keys/quotas pages and admin redirects.
- [x] Remove obsolete multi-user/operator screens; preserve owner workspaces.
- [x] Test team query isolation, mutation errors, one-time secret clearing,
  deep links, 401/403, terminal reconnect and desktop links.
- [x] Run web Vitest/typecheck/build and UI regression; commit SPA transition.

## Task 6: static delivery and deployment cleanup

Files: new `apps/api/src/http/spa.ts`, listener wiring; quickstart server/Dockerfile,
root/dev Compose, secret/init/run scripts, installer stack health/bundle tests,
release/promotion workflow, lockfile. Remove web runtime and packages/payload.

- [x] Write static fallback/HEAD/MIME/cache/CSP/API-404/missing-asset/traversal tests.
- [x] Copy dist to shared image; serve on browser listener, change ingress app
  upstream; remove web/web-migrate/image publication and Payload secret consumers.
- [x] Update installer service/image inventories and health checks; remove
  web-meta if its sole purpose disappears. Verify setup/claim/recovery still work.
- [x] Resolve owner question 3 before service/image removal: implement approved
  prerequisite updater bridge/minimum-version gate or direct transition. Execute
  the SOURCE updater runtime against target bundle, not only new updater tests.
- [x] Prevent compatible cutover declaration; test pre-pull, backup failure,
  migration/health failure and complete DB/state restore with fake hosts.
- [x] Regenerate lockfile; verify forbidden CMS/Next deps absent from graph/images.
  Update architecture and S8/deployment docs to point to S24.
- [x] Run Biome, affected TS tests/typechecks, quickstart Node tests, installer
  tests and local image/Compose smoke. Commit deployment cleanup.

## Task 7: acceptance and handoff

- [x] Run populated source stack locally, record published digest/source provenance.
- [x] Exercise released source transaction/backup modules locally against real
  Docker source/target stacks, including DB/state rollback with no legacy services.
- [ ] Owner live installed updater/PVE transport/fence -> S24 and forced rollback.
- [x] Upgrade with the unified migration; verify field equality, old owner/key
  auth, revocation, SSH lookup, CLI/MCP and restart behavior.
- [x] Fail target health; restore source DB/state/images and verify old health.
- [x] Repeat comparable wall/whole-build peak/size measurements; include Vite
  stage/static bytes and total shared image cost, service/secret counts/limits.
- [x] Complete acceptance doc with actual commands/results, commit and push.
- [x] Post head SHA, test gates, measurements and exact upgrade exercise in the
  master thread; owner performs live acceptance and merges.

Bridge prerequisite confirmed by owner: `0.4.0-edge.20261105.5` is released
and installed on the sole supported CT590. S24 release must set
`minUpdater: "0.4.0-edge.20261105.5"` and `dbCompatible: false`. The branch was
rebased on main after bridge merge. Live upgrade/forced rollback is owner-run
when requested; no implementer access to the stand.


Implementation ledger (2026-11-06): Tasks 1–6 committed in reviewable layers;
Task 7 local published-stack import/full rollback passed. S26a merged into main
and rebased; pool targets are excluded. A final fresh whole-branch review could
not start due to the requested model's usage limit; earlier migration/bridge and
backend reviews were fixed and author verification completed. Detailed evidence,
measurement limits and pending owner-only live acceptance are in
`s24-spa-no-payload-acceptance.md`.
