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
- [x] Write and run failing tests for claim/replay/concurrency/session/pairing/CSRF and denied peers.
- [x] Implement persistent owner state, HTTPS ingress and websocket authorization, strip untrusted headers.
- [x] Implement CLI login pairing and CA handling; test existing login paths.
- [x] Verify focused tests and commit.

### 2. Wizard and help

Files: deploy/compose/quickstart/setup*.mjs; dashboard pages; host preparation script/tests.
- [x] Write failing tests for persistent steps, validation, read-only adoption, callback expiry and dry run.
- [x] Implement wizard APIs/UI and durable Postgres state, PVE fingerprint pinning, host adoption/preparation,
      limits/topology, gateway/preview settings, template registration/build and sequential smoke.
- [x] Render deployment-specific CLI/MCP/SDK/desktop/troubleshooting help and copy controls.
- [x] Verify focused tests and commit.

### 3. Zero-config images and installer

Files: compose.yaml; deploy/compose/quickstart Dockerfile/bootstrap/install and tests.
- [x] Write failing installer tests (OS/arch, checksum, chosen path, login, private CA).
- [x] Build CLI targets into image and serve installer/binaries/checksums.
- [x] Compose generated DB/secrets volumes and isolated services; retain legacy compose paths.
- [x] Verify compose config, shellcheck, focused tests and commit.

### 4. Integration and live verification

Files: infra/dev-cp deployment integration; docs/roadmap.md; runbooks.
- [x] Run all required repository gates sequentially; fix failures.
- [x] Snapshot existing stand state and preserve rollback; check VM usage.
- [x] Redeploy CT590 with gateway/CA preserved, claim and adopt pve without mutation.
- [x] Install CLI on Mac via LAN and tailnet; create/exec/rm --yes; verify help.
- [x] Independent branch review; fix findings; record exact evidence, URLs and fresh-host gap.
- [x] Commit logical steps and push s16-quickstart; do not merge.

## Evidence and rulings

- 2026-11-03: Read project instructions and required architecture/deployment/spec sources.
- 2026-11-03: Ruling: keep legacy compose entry points intact and introduce root quickstart;
  safe rollback and guest trust continuity require separating owner TLS from guest gateway TLS.


## Final verification record (2026-11-03)

- `pnpm build`, `pnpm lint`, `pnpm typecheck`: PASS after the final code changes.
  Biome reports one pre-existing informational String.raw suggestion in an MCP test.
- `pnpm -r --workspace-concurrency=1 test`: PASS, 4516 TS tests passed, 8 skipped;
  Python SDK test script also ran and passed 83 tests. After the deletion fix,
  `@umiak/pve` 197/197 and worker 424 passed / 7 skipped were rechecked.
- Go: build, vet, `go test -p 1 ./...`, golangci-lint for libs/proto, libs/tunnel,
  gateway, guest-agent and node-agent: all PASS. No Go source changed.
- Playwright OIDC 21/21; local 1/1: PASS. Both isolated test stacks were removed.
- `node --test deploy/compose/quickstart/*.test.mjs`: 46/46 PASS. Includes actual
  generated fresh-host Python execution against isolated PVE/filesystem/process
  fakes, dry run, referenced deny-set coverage and ordering, one-time callback
  expiry/replay/asset scope, installer checksum failures and unsupported arch.
- Actual Postgres owner tests: concurrent claim has exactly one winner; restart
  retains claim; concurrent pairing delivers once; revocation persists.
- Installer/bootstrap/deploy/preflight shellcheck and generated host script
  shellcheck: PASS. Root compose config and image build: PASS. Final runtime
  imports verified with production dependencies, including Windows guest-agent.
- Fresh isolated root compose boot: all services running/ready, claim page200,
  unpaired API401, generated secrets in volumes. Mac port443 was occupied, so only
  this isolated test used ports18443/12222/18444. The project, volumes and network
  were deleted after verification.

## Live record: CT590 and pve

Ilia's follow-up: verify over Tailscale. The Mac was off the LAN; no firewall rule
was changed to work around that. No pve2/ip-hub-pve access, template rebuilds,
parallel sandbox VMs, broad cleanup or unrelated PVE modifications occurred.

1. Snapshot: no active sandbox VMs; templates595–598 stopped; original S15 services
   healthy. Saved gateway CA/tunnel/preview certificate SHA256 checksums.
2. First quickstart build failed before switching services because CT590's30GiB
   disk ran out of unpack space. Reduced runtime dependencies and avoided duplicate
   image exports; retry succeeded without resizing disk or deleting rollback images.
3. Root compose plus `infra/dev-cp/compose.quickstart.yaml` reused the existing
   Postgres volume and gateway/PVE secret directories. Legacy unauthenticated
   ingress was stopped; host ports8080/4180/8090 are no longer published.
4. Verified TLS using CA obtained through SSH. Claimed over MagicDNS; unpaired API
   returned401. Wizard pinned the existing PVE leaf fingerprint, preserved the
   existing root CA and used a generated read-only root report to verify the
   least-privilege setup. Existing provider/node/storage IDs and four builds were
   reused, not duplicated. Guest address/domain/tunnel stayed unchanged.
5. First smoke create/exec passed but cleanup exposed a pre-existing global storage
   scan: unrelated storage vmdata references a missing VG. Added a regression test
   and changed Machines.delete to disable destroy-unreferenced-disks scanning;
   known attached/tagged disks still get removed. Explicitly retried only our
   operation. VM500 was removed without changing vmdata or any foreign object.
6. Retried wizard smoke: PASS, expected exec output, deletion verified, setup
   complete in DB. Separate CLI create/exec/rm --yes: PASS; Linux ready in about
   12s, uname returned Linux. All runs were sequential, each2GiB.
7. Installer and checksum verification ran on the Mac through both MagicDNS and
   tailnet IP; both pairings were approved in the owner browser. For a different
   origin the same pairing path/ID was opened on the already claimed DNS origin
   (cookies deliberately remain host-only). whoami succeeded for both profiles.
8. Browser checked wizard, dashboard and help; sidebar Help/Setup links work and
   real URLs/copy controls render. Shared preview could not load the private-CA
   page (empty chrome-error result twice), so agent-browser was used. Browser TLS
   errors were ignored only in that isolated test browser after independent CA
   verification; no system trust setting was changed. Clipboard readback was denied
   by the test browser's read permission; no OS clipboard-read claim is made.
9. Authenticated remote MCP initialize:200. Anonymous API from a tailnet peer:401.
   Userspace tailnet/Docker NAT may mask the original socket IP; CIDRs remain a
   secondary barrier, owner authorization is mandatory regardless of NAT.
10. Final: original gateway CA and both leaf certificates byte-identical; no live
    sandboxes or their tagged LVs; API/worker/web/gateway/Postgres ready; MCP readyz200;
    TURN healthy. Removed the temporary CA copy from PVE. Closed test browser and
    revoked ALL test browser/CLI owner credentials through console recovery, then
    restarted owner ingress to print a new one-time claim code for Ilia. DB setup
    remains complete; handoff /v1/meta says owner and ownerClaimed=false, API401.

## Handoff and gaps

- Dashboard: https://umiak-dev-cp.tail0000.ts.net:8444/app
- Tailnet IP: https://100.64.10.7:8444/app
- LAN configured URL: https://192.168.68.90:8444/app (not verified from this Mac).
- Help/setup/install/MCP share the same origin at /app/help, /setup, /install.sh, /mcp.
- Exact CA retrieval, newest log claim and pairing steps: infra/dev-cp/README.md,
  section S16. No claim code or owner credential is stored in git.
- Rollback: `UMIAK_DEVCP_AUTH_MODE=none|oidc infra/dev-cp/deploy.sh`; when off-LAN,
  use `UMIAK_DEVCP_SSH=umiak@100.64.10.7`. This path was retained, not executed
  after S16 verification so the requested owner-gated stand remains deployed.
- Real fresh-host preparation and from-scratch Linux/optional template builds were
  not run, as requested; clean-host prerequisites and fakes are recorded in the spec
  and roadmap. Shared global firewall activation is deliberately not automated.
- Raw-IP-only bootstrap requires localhost/DNS first, then /owner/tls; this is a
  Docker NAT discovery limit, not a handwritten environment-file requirement.
- Master independent acceptance and merge remain outstanding. No merge performed.
