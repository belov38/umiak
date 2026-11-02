# S16 quickstart implementation plan

> Execute task by task with tests before implementation. Technical details are delegated by Ilia; no start/design confirmation is required.

**Goal:** Root docker compose up through claimed owner, guided PVE setup and first sandbox.
**Architecture:** S15 local services isolated behind an HTTPS owner ingress; durable setup state; bundled installer and help.
**Tech stack:** Existing Node/TypeScript, Postgres, Next.js, Docker Compose, Bun CLI, S1/S5 tools.
**Spec:** docs/specs/s16-quickstart.md

## Global constraints

Preserve CT590 gateway :443 and dev CA. Adopt existing pve objects; no template rebuilds.
Sandbox 500–589, sequential, total 8 GiB maximum. Never touch vmbr0, pve2 or ip-hub-pve.
No secrets in git; no new dependencies without checking latest stable. Commit/push s16-quickstart.

## Review focus

- Concurrent claims and restarts must not admit two owners or reopen claim.
- Direct upstream ports and WebSocket upgrades must not bypass ownership.
- Cross-origin requests and forged identity/forwarding headers must be rejected.
- A failed host verification must not mark setup complete or mutate existing PVE.
- Installer checksum failure must leave an existing binary intact.

## Tasks

### 1. Owner ingress and pairing

Files: deploy/compose/quickstart/{owner,server}.mjs and tests; apps/cli login/profile integration.
- [ ] Write and run failing tests for claim/replay/concurrency/session/pairing/CSRF and denied peers.
- [ ] Implement persistent owner state, HTTPS ingress and websocket authorization, strip untrusted headers.
- [ ] Implement CLI login pairing and CA handling; test existing login paths.
- [ ] Verify focused tests and commit.

### 2. Wizard and help

Files: deploy/compose/quickstart/setup*.mjs; dashboard pages; host preparation script/tests.
- [ ] Write failing tests for persistent steps, validation, read-only adoption, callback expiry and dry run.
- [ ] Implement wizard APIs/UI and durable Postgres state, PVE fingerprint pinning, host adoption/preparation,
      limits/topology, gateway/preview settings, template registration/build and sequential smoke.
- [ ] Render deployment-specific CLI/MCP/SDK/desktop/troubleshooting help and copy controls.
- [ ] Verify focused tests and commit.

### 3. Zero-config images and installer

Files: compose.yaml; deploy/compose/quickstart Dockerfile/bootstrap/install and tests.
- [ ] Write failing installer tests (OS/arch, checksum, chosen path, login, private CA).
- [ ] Build CLI targets into image and serve installer/binaries/checksums.
- [ ] Compose generated DB/secrets volumes and isolated services; retain legacy compose paths.
- [ ] Verify compose config, shellcheck, focused tests and commit.

### 4. Integration and live verification

Files: infra/dev-cp deployment integration; docs/roadmap.md; runbooks.
- [ ] Run all required repository gates sequentially; fix failures.
- [ ] Snapshot existing stand state and preserve rollback; check VM usage.
- [ ] Redeploy CT590 with gateway/CA preserved, claim and adopt pve without mutation.
- [ ] Install CLI on Mac via LAN and tailnet; create/exec/rm --yes; verify help.
- [ ] Independent branch review; fix findings; record exact evidence, URLs and fresh-host gap.
- [ ] Commit logical steps and push s16-quickstart; do not merge.

## Evidence and rulings

- 2026-11-03: Read project instructions and required architecture/deployment/spec sources.
- 2026-11-03: Ruling: keep legacy compose entry points intact and introduce root quickstart;
  safe rollback and guest trust continuity require separating owner TLS from guest gateway TLS.
