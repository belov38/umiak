# S26b quickstart migrations implementation plan

Goal: move quickstart schema ownership into the SQL journal, preserving all existing state and S22 image-only rollback compatibility.

1. Reserve 0900–0999 (0800–0899 belongs to S24). Add `0900_quickstart.sql` with the exact historical schema and table definitions using `IF NOT EXISTS`; do not seed or update data in SQL.
2. Remove DDL from owner/setup bootstrap; keep conflict-safe singleton inserts. Keep updates lazy creation and defaults unchanged, with a no-op initialization hook. Add an explicit successful `migrate` dependency for quickstart.
3. Add runtime tests rejecting DDL and checking bootstrap queries/order. Add Postgres-backed journal upgrade tests for empty, owner-only, owner+setup and all-three historical layouts, partial initialization, replay, exact JSON preservation and old bootstrap compatibility.
4. Install/build dependencies, run quickstart and DB tests and Biome, review the diff, fetch/rebase main, commit and push this branch. Report SHA and evidence to master; never merge or touch live hosts.

History audit: `git log --all -p -G 'CREATE TABLE|CREATE SCHEMA|ALTER TABLE' -- deploy/compose/quickstart` found one shape each: owner (`40762650` / `5886dc8c`), setup (`7b96c611` / `ce326fa3`), updates (`b4eb6a23`). No historical ALTERs or alternate column layouts exist, so no speculative ALTERs are necessary. JSON contents evolved inside unchanged JSONB columns and remain opaque.

Compatibility: `dbCompatible: true` for S26b. Same names, columns, constraints and defaults; no row rewriting. Previous runtime can execute its original `CREATE IF NOT EXISTS` and conflict-safe inserts on the migrated DB. This does not declare compatibility for independent S24 changes.

## Validation (2026-11-06)

- Completed steps 1–4. `pnpm install` and `pnpm build` exited 0. The web build logged its existing `build.invalid` database lookup warning but completed.
- `node --test deploy/compose/quickstart/`: 246 passed, zero skipped.
- `pnpm --filter @umiak/db test`: 86 passed across nine files, zero skipped, using disposable local Docker Postgres. New coverage includes all eight table-presence combinations plus an absent-schema/defaults/constraints case.
- `pnpm --filter @umiak/db typecheck`: passed.
- `pnpm exec biome check .`: passed (one existing informational `noUselessStringRaw` diagnostic in `apps/mcp/test/windows-run.ts`).
- `git diff --check`: passed. No live hosts used and no CI workflow dispatched.
