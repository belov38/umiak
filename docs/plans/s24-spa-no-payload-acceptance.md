# S24 acceptance evidence

Status: implementation and local acceptance complete.
Owner live acceptance remains pending; no live acceptance claimed.

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

## Before/after measurements

The web build uses dedicated cold builders capped at 2 CPUs / 4 GiB on the same
native ARM64 Docker Desktop VM. Peak is the whole builder cgroup, including
BuildKit, dependency installation and page cache. Both completed without an OOM.

| Measurement | Before | S24 |
|---|---:|---:|
| Web compiler/build RUN | Next + image check: 53.3 s | Vite: 1.7 s (Vite reports 1.23 s) |
| Cold web build wall, including downloads | 147.443 s | 192.105 s |
| Whole web builder peak | 4,294,967,296 B (4 GiB cap) | 2,138,648,576 B (1.99 GiB) |
| Cgroup max / oom / oom_kill events | 2960 / 0 / 0 | 0 / 0 / 0 |
| Separate web runtime image, uncompressed | 733,299,626 B | absent |
| Shared quickstart image, uncompressed ARM64 | 2,199,941,887 B | 2,020,969,770 B |
| Sum of product image sizes | 2,933,241,513 B | 2,020,969,770 B |
| Shipped static SPA files | — | 1,712,580 B |
| Steady containers | 9 | 7 |
| One-shot containers | 3 | 2 |
| Product images, excluding PostgreSQL | 2 | 1 |
| Generated logical file credentials | 17 | 16 |

Compiler/build time fell about 97%, observed builder peak about 50%, and summed
uncompressed product-image sizes about 31%. The cold end-to-end build did **not**
get faster in this sample: dependency downloads/supply-chain metadata checks
were slower. Do not present compiler timing as whole-image build time. The target
measurement ends at the web-build stage (no web runtime image to export/load),
whereas the baseline includes export/load. Whole shared-image builds also include
Go agents/gateway and compiled CLI artifacts; those costs remain.

The before shared image was separately built from the same baseline SHA and
platform using an existing builder/cache: 142.843 s wall, recorded for provenance,
not a comparable cold-build timing. Summed image sizes do not deduplicate shared
layers and are not registry transfer bytes. Published AMD64 source image sizes
are deliberately excluded from this ARM64 size comparison.

After commands, through `mise exec --`:

```sh
docker buildx create --name umiak-s24-web-after --driver docker-container --driver-opt memory=4g,cpu-period=100000,cpu-quota=200000 --bootstrap
docker buildx build --builder umiak-s24-web-after --platform linux/arm64 --progress=plain --target web-build --output type=cacheonly -f deploy/compose/quickstart/Dockerfile .
docker exec buildx_buildkit_umiak-s24-web-after0 cat /sys/fs/cgroup/memory.peak
docker exec buildx_buildkit_umiak-s24-web-after0 cat /sys/fs/cgroup/memory.events
docker buildx build --builder umiak-s24-after --platform linux/arm64 --progress=plain --load -t umiak-s24:acceptance-final -f deploy/compose/quickstart/Dockerfile .
docker image inspect umiak-s24:acceptance-final --format '{{.Id}} {{.Size}}'
```

Local logs: `/tmp/s24-web-after-build.log`, `/tmp/s24-web-after-result.json`,
`/tmp/s24-cp-before-build.log`, `/tmp/s24-cp-before-result.json`,
`/tmp/s24-final-image-build.log` (warm-layer wall 28.498 s). Target image config:
`sha256:96c1438cb54074f0d2b11c165900f5bb98e507123803ca1312a82825aa092f94`.
Baseline shared image config:
`sha256:c2382fe7e7bb119d739d5871f77e3d29eeafc74a05be7043ed5e7f5c24a452f4`.
An initial target build failed because the web stage omitted SDK's auth/scopes
source dependency; fixed COPY and rebuilt. Failed and resumed whole-image builds
are not used as a cold timing claim.

## Containers and credentials

Before: api, gateway, gateway-renewal, mcp, postgres, quickstart, web, web-meta,
worker; one-shots migrate, secrets-init, web-migrate. After: the same list minus
web, web-meta and web-migrate. One shared image publishes static files; the API
serves them on its owner/browser listener through the existing ingress/TLS.
Gateway Go code is unchanged. Removed the stand-build CPU/RAM bump; that script
was edited only, never executed against the stand.

Generated credential inventory counts independent random values/private keys,
not filesystem copies or public certificates:

- Gateway CA key, preview TLS key, tunnel TLS key, cookie key, two SSH host keys,
  SSH user CA and SSH login CA: 8.
- Gateway service registry's api/worker/gateway tokens: 3; API inbound gateway
  token: 1; desktop-ingress HMAC key: 1.
- Shared data-encryption key: 1; API cursor HMAC key: 1; PostgreSQL password: 1.
- Payload secret: 1 before, 0 after (formerly root + API/worker/web copies).

Total 17 → 16. Installer-provided PVE API token and restricted SSH private key
add two unchanged credentials when configured (19 → 18). Database owner-session
and pairing records are preserved and excluded from the file-credential count.
On upgraded volumes, old Payload secret files and schema remain unused; new
installs neither generate nor read them. This avoids erasing recovery material
outside the backed-up cutover. No Payload secret environment setting, mount,
reader or migration process remains in the target.

## Published-stack upgrade and forced rollback

Actual published source product images `0.4.0-edge.20261105.6`, AMD64 under
Docker Desktop emulation (the published source has no ARM64 manifest):

- quickstart digest `sha256:98709b0eb635834dc980817c1600e5e6dc88380792d2686e4945c3e01a52e9c8`;
- web digest `sha256:8f59b330375b4c043c7a3ac60ecda41f158a5361d65ec95c89f0041370bd2994`;
- PostgreSQL `18.6-alpine`, native ARM64.

Full source Compose was started locally with isolated project/network/ports and
its actual secrets-init, unified migrate and Payload migrate jobs. Claimed owner
through HTTP, paired a CLI session, issued a scoped API key and registered an
actual generated SSH public key. SQL applied operator edits/custom size/nullable
defaults and added an orphaned revoked audit key. Source counts: users 1, teams 1,
memberships 1, API keys 2, SSH keys 1, templates 3, sizes 4, defaults 1.
The synthetic historical-DDL fixture additionally covers shared teams, inactive
users, expired keys, nullable/self-referential audit relationships, pending
Debian deferral and malformed/interrupted source imports.

Executed **unmodified released bridge modules** from `ecacd544` with its VERSION
set to `0.4.0-edge.20261105.5`. The local Docker backend replaces Proxmox command
transport/fencing and stores checkpoints locally. The real bridge `transaction`
and `backup.py` perform stop/start discovery against each Compose, `pg_dump`,
validated custom dump, root-only state/config tar+checksums, target application,
forced failed health, `pg_restore`, state/config restoration and old-stack health.
This is not a claim that Proxmox transport or the installed host service ran here.
Target release pre-pull/minUpdater behavior is covered by installer tests; the
unpublished branch image is local. Owner must run the installed updater live.

Results:

- Source → target: exact JSON field equality across all eight imported tables
  before post-upgrade login bookkeeping, including UUIDs, hashes, nullable values,
  SSH fingerprints, edits, ordering and timestamps. Legacy pool rows are unread.
- Existing browser cookie, paired CLI owner settings authority, scoped key on
  the API public listener, SSH listing and SPA deep links work after import.
- Forced failure after target health inserts a target-only DB table and state
  file. Bridge reports `rolled_back`, `dataLoss: true`, clears checkpoint only
  after old-stack health/auth checks. Original source fields match the snapshot;
  both probes disappear; old browser/paired CLI/key still work.
- Then successful upgrade to the S26a-rebased target reports `updated` and passes
  the same import/auth/deep-link checks. This is a new transaction/backup.

Reproducer: `deploy/compose/s24-upgrade-test.py` (docstring includes helper image).
The fixture lives under a private temporary directory and contains credentials;
never upload it or dump quickstart logs. The temporary acceptance harness initially
had incorrect project aliases, a Host-header test using fetch, and incomplete
readiness checks; corrected those and reran the actual migration/rollback paths.
The successful rollback history entry is `20261106114254-d17e0c20d9cf`.
Success log: `/tmp/s24-upgrade-success.log` (no secrets).

## Release and verification gates

S24 release builder hard-pins `minUpdater: "0.4.0-edge.20261105.5"` and
`dbCompatible: false`; compatible cutover metadata is rejected. The bridge-aware
old-runtime gate refuses before side effects; a literal pre-bridge snapshot
regression explicitly documents that it cannot understand this new gate.
The owner installed the bridge before S24 publication. No temporary compatibility
service/image is added. Legacy payload schema stays unread for this release.

Post-rebase typechecks and Biome pass (one pre-existing informational MCP lint).
Full sequential `pnpm -r --workspace-concurrency=1 test` passes (4,342 TS tests
and 83 Python SDK tests) after the S26a
rebase. Verified gates: API 1045, worker 429 + 7 skipped,
core 374, db 103, config 25, auth 168, web 189, CLI 172, TS SDK 144, Python SDK 83;
quickstart Node 245, installer pytest 299, built-image tests 2. Existing skipped
live-agent cases remain skipped; no real sandbox VM was created locally. Full workspace run also includes PVE
201, agent-client 143, template-builder 606, bench 44 and MCP 699 + 1 skipped.
Playwright browser acceptance passed on the actual upgraded stack: imported
template display/edit/reload, nullable numeric defaults save/reload, navigation,
workspace create/switch with scoped-key isolation, and failed workspace save
shown as an error. No page errors or failed static resources. Browser harness:
`apps/web/test/s24-browser.mjs`; result `/tmp/s24-browser.log`.

Prior fresh reviews covered migration/bridge/backend; their important findings
were fixed with regressions. A final whole-branch fresh review was attempted but
the requested model hit its usage limit before reviewing. Author review and
verification continue; this is an explicit handoff limitation, not a clean fresh
review claim. Owner live acceptance/merge remains pending. No live Proxmox/dev
stand commands were run by this scope.

Final image recreation reruns unified migrations and starts API/worker without
changing any configuration row, including settings edited in the browser.
Imported scoped key still authenticates. The final image also passes the static
asset/forbidden-dependency/secret-bootstrap checks. Final warm-layer whole-image
build took 28.498 s; this is not a cold-build comparison.
