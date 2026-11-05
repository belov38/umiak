> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S20 CP consolidation implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation; one fresh acceptance reviewer after verification.

**Goal:** Two published images with existing process isolation.
**Architecture:** A shared multistage CP runtime and separate Next image; explicit commands select roles. One offline bootstrap initializes gateway then service secrets.
**Tech Stack:** Node 26.13.0, pnpm 12.16.1, Go 1.27.3, Docker Compose.
**Spec:** `docs/specs/s20-cp-consolidation.md`

## Global constraints

Keep umiak-quickstart and node-agent extraction path; no live hosts or DB migrations;
MCP separate and secretless; web-internal isolation; manual releases only. Sync main
before compose/release edits; preserve S19 and live-fix changes. Installer changes
only when image/STACK_FILES contract requires them.

## Review focus

- Existing-volume upgrades must retain CA, owner and generated service secrets.
- MCP/web-meta must not inherit the DB-reading ingress entrypoint.
- Explicit COPY must retain Windows/Linux recipe files and signed release assets.
- Corporate roles must retain commands, networks, user and healthchecks.
- Shared runtime must omit dev tools, tests, source credentials and build caches.

### Task 1: shared runtime and offline bootstrap

Files: quickstart Dockerfile; new `init.sh`; compose role contract and bootstrap tests.
Produces: shared image plus offline `init.sh` command.
- [x] Add failing tests for two-image compose, secretless commands and bootstrap idempotency.
- [x] Run tests; expected failure against six-image/current two-bootstrap stack.
- [x] Build explicit manifest/source stages, production closures, CLI assets and compiled proto.
- [x] Implement init.sh chaining gateway-init then bootstrap with fail-fast semantics.
- [x] Run focused tests and image content/role checks; expected PASS; commit.

### Task 2: deployment and release integration

Files: root compose/dev override, corporate compose, release workflow, installer bundle test,
architecture/roadmap and quickstart docs.
Consumes: Task 1 shared runtime and init.sh.
- [x] Update bundle test to require quickstart+web; run pytest and observe expected failure.
- [x] Sync origin/main, merge offline jobs, select explicit role entrypoints and shared builds.
- [x] Reduce release matrix to two; retain extraction digest, tags and dispatch guards.
- [x] Run rendered compose tests and installer suite; expected PASS; commit.

### Task 3: gates, measurement and independent acceptance

Produces: evidence in this plan and reviewable pushed branch.
- [x] Run full pnpm gates, Go gates per workflow and installer tests; investigate failures.
- [x] Run isolated local compose up --build smoke; verify readiness, owner claim, MCP, web-meta,
      restart idempotency and network/secret mounts. Capture platform and memory.
- [x] Export built amd64 OCI layers and compute unique compressed union; record baseline caveats.
- [x] Fresh acceptance review against spec+diff; resolve important findings, rerun relevant gates.
- [x] Push branch, send coordinator evidence; do not merge without confirmation.

## Evidence

Baseline GHCR 0.1.0 linux/amd64: quickstart 761.0, api 239.7, worker 238.9,
mcp 241.2, web 140.0, secrets-init 4.5 MiB compressed; union 1304.7 MiB
(excludes postgres). No baseline runtime RSS was available at analysis time.

### Verification evidence (2026-11-04, before S19 merge)

- Rebased on live fixes through `2bf33549`; release build-arg and final-stage
  `UMIAK_SOURCE_COMMIT` preserved; unified init verifies
  ingress-desktop-key ownership `65532:1000:0640`.
- New rendered-compose contracts: RED 3/3 before consolidation, GREEN 4/4
  including corporate OIDC commands and networks. Existing MCP compose test
  updated to shared image: RED → GREEN 11/11.
- Image acceptance: RED against old local quickstart (missing unified init/assets),
  GREEN 2/2 against built linux/amd64 shared image. Repeated init preserves CA,
  SSH CA, database password, cursor key and Payload secret and compares consumer
  copies/permissions; production image contains no pnpm/Bun/Go, root TS/vitest,
  or quickstart test modules.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`: PASS (lint has an existing
  informational String.raw diagnostic in template-builder).
- Installer pytest: 190 PASS; installer shell tests PASS. Compose/quickstart Node
  tests: 186 PASS, 2 opt-in image tests skipped there and run explicitly above.
- Full pnpm tests initially hit test Postgres max_connections=100; repeated with
  500 connections. Remaining pre-existing failure: MCP tools-desktop proportional
  description budget, 10624 > 10526. Coordinator assigns its fix to S19; do not
  duplicate. CLI separately PASS 189 tests. Rerun full suite after S19 lands.
- Go race/vet/lint across proto, tunnel, node-agent, guest-agent and gateway:
  known gateway TestDialMovedValidated flaked under parallel load, full gateway
  rerun with `-p 1` PASS. Windows amd64 build/vet and arm64 build PASS for
  proto/tunnel/guest-agent (node-agent is Linux-only). Linux integration-tag
  guest lint and buf lint PASS. Guest systemd integration PASS with local-only
  mask of systemd-binfmt.service: the unmodified privileged test otherwise
  clears Docker Desktop's shared binfmt registrations. No live-host tests.
- Docker smoke: `compose.yaml` + `compose.dev.yaml`, isolated project
  `umiak-s20-smoke`, linux/amd64 CP+web+Postgres under Rosetta on ARM Mac. Local
  host port 443 occupied, so used loopback 18443/18085/12222/14180/14181 and
  public URL http://localhost:14180. Nine persistent services running, three
  one-shot jobs complete. Owner claim/signin+CSRF, paired CLI bearer → MCP
  initialize, API /v1/me, setup redirect/page, metadata GET-only bridge, web DNS
  isolation from API, absent MCP secret paths PASS. No installer facts/PVE calls,
  so full sandbox/template/desktop workflow is outside this local smoke.
  Owner browser session survives ingress restart; repeated real-volume init PASS.
- OCI gzip manifests (linux/amd64): CP 660.08 MiB, web 140.03 MiB; unique layer
  union 719.93 MiB excluding Postgres, versus GHCR 0.1.0 baseline 1304.7 MiB:
  reduction 44.8%. Base layers counted once. This measures download bytes, not
  a guaranteed first-install wall time; no comparable cold timing was available.
- Docker stats snapshot after lightweight HTTP smoke: ingress121.9, MCP123.7,
  web-meta49.65, API328.8, worker240.4, web182.2, gateway90.08, renewal31.55,
  Postgres368.3 MiB; total1536.58 MiB. Emulated idle-ish development workload,
  no templates/VMs, 24GiB Docker VM: not a peak-memory/4GiB-LXC guarantee.
- Fresh independent acceptance (GPT-6-astra): no blocking/important regressions.
  One minor found: workspace src/testing helpers copied with production source.
  Fixed via RED image test, Dockerfile-specific exclusions, rebuild and GREEN
  image acceptance 2/2. Root/corporate contracts 4/4 remain PASS.
  Reviewer independently ran those contracts and diff whitespace checks; heavier
  gates use the evidence above. Limits: no full old-release→new-release upgrade,
  corporate OIDC login, real PVE/template/desktop or 4GiB load acceptance.
  Repeated init and local image-recreation smoke preserve existing volumes.
  Final full pnpm suite still waits for coordinator-owned S19 budget fix;
  merge requires coordinator confirmation.

Installer scope: only `umiak_installer/stack.py` STACK_FILES (remove two scripts
now shipped in the image) and the bundle image-set test. No host logic, live
PVE/PVE2 access or DB migrations changed.


### Final merge gate (supersedes the pending S19 gate above)

Ilia/coordinator explicitly authorized merging S20 before S19, 2026-11-04.
Rebased on `680ba0c9`; cherry-picked S19 compaction `40e1ee21` as `40e525a5`.
Preserved all upstream umask/dnsmasq, qmdestroy, pinned rustup and first-install
agent trust-anchor changes. SOURCE_COMMIT ARG/ENV and release build-arg retained;
image provenance checked by executing Node in a release-like build. Bundled agent
install-package help confirms --trust-keys. TLS_BIND controls 443 separately from
preview/SSH; installer ENV_KEYS retains TLS_BIND, and STACK_FILES keeps precisely
its remaining bind-mounted files.

Fresh full gate on this rebased code: pnpm install/build/typecheck/lint PASS;
pnpm test PASS (4643 TS tests, 81 Python SDK tests; documented platform opt-ins
remain skipped). Installer 198 PASS plus install.sh shell tests. Compose/quickstart
Node 186 PASS, two image opt-ins exercised separately: image acceptance 2/2 PASS.
Go race (-p 1), vet and golangci-lint PASS across proto/tunnel/node-agent/guest-agent/
gateway; Windows amd64 build+vet and arm64 build PASS for portable modules;
Linux integration-tag lint, buf lint and privileged guest integration PASS.
Local systemd-binfmt mask used for that integration test as explained above.

Fresh linux/amd64 up --build smoke PASS using the documented isolated loopback
ports: owner claim/sign-in and CSRF, API, setup redirect/page, genuine CLI pairing
and MCP initialize, metadata GET-only bridge, web-to-API isolation, absent MCP
secret paths, session after ingress restart and repeated volume bootstrap.
CP 660.09 MiB, web140.03 MiB, unique compressed OCI layer union719.93 MiB.
No release dispatch or live-host operations. Independent acceptance from the
previous section still applies; its only minor was fixed and retested. Only
upstream fixes and the coordinator-approved MCP description compaction were
added since that review. Main integration is an authorized fast-forward push.

### Deferred: runtime consolidation

Decision: Ilia, 2026-11-04 — the memory footprint is acceptable. Defer all four
options below; no exec-wrapper, renewal or process-merging implementation is
planned as part of S20.

Measured smoke memory: API369.3, worker324.9, MCP140.3, ingress113.9, web201.9,
web-meta46.22, renewal33.52, gateway90.09 and Postgres382.0 MiB; total1702.13 MiB
across nine steady services. Idle Node measured28.54 MiB. These are amd64/Rosetta
measurements on an ARM Mac, not production LXC or peak-load guarantees.

1. **API+worker+MCP in one process:** removes two containers. About90 MiB of
   process overhead is an estimate from the idle Node and wrapper measurements;
   module/Payload/pool savings remain unmeasured. MCP and worker footprints are
   not wholly reclaimable: functionality remains in the merged heap. Cost:
   shared API/PVE secrets, event loop, OOM and restart domain.
2. **web-meta inside ingress:** removes one container; its measured46.22 MiB
   footprint is an upper bound before added listener memory. Keep GET-only
   metadata access and web network isolation. Cost: lose the separate
   secretless/read-only/cap-dropped bridge and its failure isolation.
3. **Offline scheduled renewal:** removes one permanent container and its33.52 MiB
   idle footprint. Preserve scoped root/RW access only during the job. Moving
   renewal into the network-facing gateway instead would widen its current RO
   key/CA access; that alternative is undesirable.
4. **True exec instead of the credential wrapper's spawn:** container count stays
   nine, but five parent Node processes disappear. Their measured private memory
   is153.67 MiB total (API29.88, worker31.82, web29.86, ingress30.04, gateway32.08).
   Preserve UID/GID drop, credentials and signal handling. This is reclaimable
   process footprint, not an implemented before/after saving; secrets and
   network boundaries can remain unchanged.

No merged-process benchmark was implemented. Image consolidation alone does not
remove V8 heaps. S20 is complete; further runtime consolidation remains deferred
until a separate decision from Ilia.
