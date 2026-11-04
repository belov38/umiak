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
- [ ] Run full pnpm gates, Go gates per workflow and installer tests; investigate failures.
- [ ] Run isolated local compose up --build smoke; verify readiness, owner claim, MCP, web-meta,
      restart idempotency and network/secret mounts. Capture platform and memory.
- [ ] Export built amd64 OCI layers and compute unique compressed union; record baseline caveats.
- [ ] Fresh acceptance review against spec+diff; resolve important findings, rerun relevant gates.
- [ ] Push branch, send coordinator evidence; do not merge without confirmation.

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
