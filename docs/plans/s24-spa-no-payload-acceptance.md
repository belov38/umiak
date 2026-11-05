# S24 acceptance evidence

Status: implementation in progress. No live acceptance claimed.

## Baseline (2026-11-06)

Source SHA: `21c0e169f879fa9418ae2bace119a56f13b83053`.
Docker Desktop 4.97.0, Engine 29.9.2, BuildKit v0.34.0, Linux ARM64 on Mac.
Docker VM: 14 CPUs, 25,159,036,928 bytes RAM, cgroup v2.
Dedicated builder `umiak-s24-baseline`: 2 CPUs, 4 GiB RAM, new/cold cache and
cold dependency downloads. Native ARM64, not the stand's AMD64 platform.

Commands (through `mise exec --`):

```sh
docker buildx create --name umiak-s24-baseline --driver docker-container --driver-opt memory=4g,cpu-period=100000,cpu-quota=200000 --bootstrap
docker buildx build --builder umiak-s24-baseline --platform linux/arm64 --progress=plain --load -t umiak-s24-web:baseline -f apps/web/Dockerfile .
docker exec buildx_buildkit_umiak-s24-baseline0 cat /sys/fs/cgroup/memory.peak
docker exec buildx_buildkit_umiak-s24-baseline0 cat /sys/fs/cgroup/memory.events
docker image inspect umiak-s24-web:baseline --format '{{.Size}}'
```

Wall build including install/download/export/load: **147.443 seconds**, exit 0.
Next build RUN step: **53.3 seconds** (includes image hygiene check).
Dedicated BuildKit cgroup peak: **4,294,967,296 bytes**; memory events max 2960,
oom 0, oom_kill 0. The cgroup includes daemon, concurrent build/migrate stages
and page cache; it reached the cap and reclaimed memory. This is not an
unconstrained RSS measurement or a reproduction of the stand's OOM.
Uncompressed Docker image size: **733,299,626 bytes**.
Image config: `sha256:0177d0b448b6049196e82d0ea98d7aebe255aa190628cddf0507a803ea195623`.
OCI manifest: `sha256:aeafa91044e446e6d791c0404e95ec7f863d98fe5ba16cffbf8585976b66b9dc`.
Compressed transfer size: not measured.

Baseline build emits the existing `build.invalid` Postgres resolution diagnostic
during prerender but completes successfully; no real database or secrets supplied.
Full local build log/result: temporary directory
`/var/folders/11/v77p7v_x1qx3f5r4kc__cc3r0000gn/T/umiak-s24-baseline-zdlxdiy5`.

Compose baseline (`docker compose --env-file compose.dev.env -f compose.yaml config`):
9 steady services: api, gateway, gateway-renewal, mcp, postgres, quickstart, web,
web-meta, worker. 3 one-shots: migrate, secrets-init, web-migrate. Two product
images (quickstart/web) plus PostgreSQL. Logical secret inventory still pending;
Payload alone has one logical secret copied to api/worker/web, plus its root file.

## Updater prerequisite

Approved separate branch `s24-updater-bridge`, head
`ecacd5449ad39784c4bb0676401ec06ceadc19d1`, pushed for master release/installation.
295 installer tests and Biome passed. S24 must declare the actual published
bridge version as minUpdater and dbCompatible false; no compatibility services.
Literal pre-bridge code cannot interpret new minUpdater metadata; both supported
installs must receive the bridge before cutover publication (confirmed by master).

## Remaining acceptance

- Comparable after build wall/cgroup peak, Vite stage/static bytes and whole shared
  image size; disclose cold download differences.
- Final steady/one-shot service and complete logical secret inventory.
- Populated legacy release stack -> S24, hashes/UUIDs/settings/session equivalence,
  restart idempotence, pending Debian deferral and nullable revoked-key audit rows.
- Actual bridge runtime -> target, forced failed health and full DB/state restore.
- TS/Vitest/Biome/SDK/CLI/MCP/quickstart/installer/image/UI gates.
- Owner performs live stand acceptance; no Proxmox/dev-stand access by implementer.

## Migration layer (in progress)

Synthetic source-schema fixture is derived from historical Payload SQL and owner
schema changes, with no dependency on importing Payload in the test. It verifies
row-for-row JSON equality across all nine tables, nullable revoked-key audit,
operator edits and rerun idempotence. Additional tests cover fresh-only seeds,
incomplete-source rejection, FK-failure rollback, and pending Debian deferral.
`mise exec -- pnpm --filter @umiak/db test`: 91 passed (local Postgres Docker).
`mise exec -- pnpm --filter @umiak/db typecheck`: passed.
Runtime adapters/notifications and published-image upgrade acceptance remain pending.

## Shared reader and notification layer

SQL PgConfigReader reads runtime configuration with the former reader's cache,
quota and fresh-default behavior. Copied generic channel listener retains TTL
fallback and reconnect cache invalidation. Registry checked pg/@types/pg 8.23.1
before adding them to packages/config. Notification triggers now live in unified
SQL migrations: commit-only delivery, rollback silence, bookkeeping silence, key
rotation SSH revocation and global policy route invalidation are tested against
local Postgres. Reader integration covers canonical aliases, numeric conversion,
nullable quotas, defensive copies and uncached policy defaults.

Latest gates: db 95 Vitest tests, config 27 tests, both typechecks and Biome pass
(one pre-existing informational MCP lint). These components are not wired into
API/worker yet; no application cutover or full upgrade claim.
