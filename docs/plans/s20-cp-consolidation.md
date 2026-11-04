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
- [ ] Add failing tests for two-image compose, secretless commands and bootstrap idempotency.
- [ ] Run tests; expected failure against six-image/current two-bootstrap stack.
- [ ] Build explicit manifest/source stages, production closures, CLI assets and compiled proto.
- [ ] Implement init.sh chaining gateway-init then bootstrap with fail-fast semantics.
- [ ] Run focused tests and image content/role checks; expected PASS; commit.

### Task 2: deployment and release integration

Files: root compose/dev override, corporate compose, release workflow, installer bundle test,
architecture/roadmap and quickstart docs.
Consumes: Task 1 shared runtime and init.sh.
- [ ] Update bundle test to require quickstart+web; run pytest and observe expected failure.
- [ ] Sync origin/main, merge offline jobs, select explicit role entrypoints and shared builds.
- [ ] Reduce release matrix to two; retain extraction digest, tags and dispatch guards.
- [ ] Run rendered compose tests and installer suite; expected PASS; commit.

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
