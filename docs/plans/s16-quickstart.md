# S16 quickstart implementation plan

> Execute task by task with tests before implementation. Technical details are delegated by Ilia; no start/design confirmation is required.

**Goal:** Root docker compose up through claimed owner, guided PVE setup and first sandbox.
**Architecture:** S15 local services isolated behind an HTTPS owner ingress; durable setup state; bundled installer and help.
**Tech stack:** Existing Node/TypeScript, Postgres, Next.js, Docker Compose, Bun CLI, S1/S5 tools.
**Spec:** docs/specs/s16-quickstart.md

## Global constraints

Preserve CT590 gateway :443 and dev CA. Adopt existing pve objects; no template rebuilds.
Sandbox 500–589, sequential, total 8 GiB maximum. Never touch vmbr0, pve2 or ip-hub-pve.
No secrets in git; no new dependencies without checking latest stable. Commit/push s16-fix.

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
   ingress was stopped; host ports8080/8090 are no longer published;4180 serves HTTPS owner ingress.
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
- LAN configured URL: https://192.168.68.90:4180/app (not verified from this Mac).
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

### Final LAN exposure correction

Read-only inspection of CT590's PVE firewall confirmed that8444 is not admitted on
the LAN, while the old S15 port4180 already is. Added a CT-only HTTPS4180 alias to
the same owner ingress, retaining the verified tailnet8444 URL. No firewall or bridge
configuration changed. From PVE over the LAN, the HTTPS request now reaches ingress
and returns403 for the denied node source. From the Mac over tailnet, the4180 alias
returns401 for an unpaired API request; MagicDNS8444 remains healthy. A Mac-on-LAN
check is still deferred per Ilia's instruction to use Tailscale.

## S16 acceptance follow-up — s16-fix (2026-11-03)

Technical decisions are delegated by Ilia; implementation proceeds without a new approval gate.

- [x] Owner ingress: read-only authentication, per-source pairing, short codes, scoped/revocable CLI sessions, __Host cookie.
- [x] TLS: allowlisted pre-issued leaves and constrained CA; adding names explicitly rotates CA. No issuance during handshake.
- [x] Prep/adoption: preflight before writes, complete per-run rollback, idempotent rerun; current firewall checks and fresh reports.
- [x] Isolate service secret mounts with volume subpaths; remove gateway PVE secret mount.
- [x] Dashboard Getting started, all modes, command parity test, empty onboarding; themed owner/setup pages.
- [x] Optional Tailscale Serve sidecar and CT590 existing-daemon Serve, public owner HTTPS with unchanged owner authorization.
- [x] Run full gates, deploy, rotate owner CA and claim code, test sequential sandbox lifecycle, revoke sessions and leave unclaimed.

Ruling: Tailscale Serve is an optional exposure transport, not an authentication
provider. No Tailscale identity headers grant ownership. The sidecar has a fixed
private address solely for metadata indicating public TLS. Previews retain their
separate wildcard gateway certificate. Direct owner LAN HTTPS stays available.

Pre-deploy snapshot: CT590 30GiB disk, 5.9GiB free; existing services healthy.
PVE `qm list` read via pinned HostKeyAlias: no sandbox VMs in 500–589 running;
templates595–598 stopped. Unrelated102/108 remain untouched. Serve config initially
empty, Docker gateway binds0.0.0.0:443; choose Serve8443 to avoid collision.

### Additional single-owner presentation work

- [x] API anonymous tenancy metadata, OpenAPI and both generated SDKs.
- [x] Dashboard uses server metadata; personal Settings/navigation, no team controls/text in single deployments; OIDC preserved.
- [x] CLI stores/refreshes tenancy independently of credential kind, adapts whoami/limits/ls/help and preserves explicit team overrides.
- [x] Rerun affected gates and both Playwright modes; redeploy and leave CT590 unclaimed again.

### Acceptance-follow-up evidence before single-owner presentation addition

- Final owner/local Node suite69/69, including real TLS arbitrary-SNI rejection,
  constrained malicious leaf verification, explicit rotation, source pairing,
  short code, read-only auth, legacy credential rejection and network config
  without PVE secret access. Generated prep fake exercises disabled firewall before
  writes, nonempty deletion, full rollback, failed-run recovery and idempotent rerun.
- Full sequential workspace suite4521 passed/8 skipped, Python SDK83 passed.
  OIDC Playwright22/22 (original21 plus guide), local1/1, stacks/volumes removed.
- Go build/vet/test-p1/golangci-lint all five modules passed. Shellcheck passed.
  pnpm build/lint/typecheck passed; lint one pre-existing informational String.raw.
- Independent review found legacy-session scope migration and loss of gateway
  public network config after removing PVE mounts; both fixed with regression tests.
- CT590 redeployed, new constrained owner CA fingerprint
  `7F:3A:CA:91:3B:D1:E6:B3:FA:2C:11:9E:C1:32:A0:0A:09:91:45:13:36:6A:2A:F4:48:E0:E7:85:51:52:20:F5`.
  Guest CA/tunnel/preview leaf checksums unchanged. Public Serve8443 and LAN4180
  retained. Arbitrary Google SNI failed; allowed names issued before handshake.
- Through trusted public Serve: test claim, guide light/dark real URLs, install.sh
  without CA, short-code CLI approval and whoami. Linux sandbox thistle-nimble-cub
 2GiB ready in13.4s, exec uname, rm--yes, deletion confirmed with qm list. Then
  wizard smoke passed sequentially; complete=true. No VM500–589 remained.
- Adopt read cluster enable1 and node host enable0; node flag is host-rule only.
  First fresh read-only report accepted; second Adopt refused stale/used report.
  New report + Adopt/limits/network/templates/smoke succeeded without host mutation.
- Worker now receives only own token/public SSH CA; API/web see only their secret
  subdirectories. New public network volume migrated from legacy data by bootstrap.
  Deploy script builds secrets-init too, so updated secret copies apply on redeploy.
- Test credentials revoked; exposed claim invalidated and ingress restarted with a
  new code. Old installed CLI returned owner_required. Further UI addition below
  requires another deploy/check and unclaimed handoff.

Additional isolation ruling: existing managed sandbox VMs must have inbound DROP,
MAC/IP filtering and an enabled umiak-egress group per NIC, not only firewall=1.
Token and one-use report paths check these settings read-only. Sealed templates
remain excluded; provisioning enables all controls before sandbox boot.

Tenancy review found two integration gaps, now fixed: web/API have disjoint Compose
networks, so a GET-only metadata bridge preserves that boundary; SSH's existing
metadata fetch now updates the tenancy cache. CLI's actual Me response includes
both team and teams[]; regression fixtures now use the generated Me type and verify
all memberships are omitted from single-tenancy output. CLI170/170 and web251/251
passed before the final full gate. No change to MCP tool descriptions/output.

Final NAT ruling: source address alone cannot identify Serve under Docker NAT.
Public-certificate instructions require both the configured Serve socket peer and
its MagicDNS HTTPS port (443 by default,8443 on CT590). Direct8444 remains private
CA even from the same socket peer. This signal never grants authorization. A real
live regression caught the conflation; a new same-peer/direct-port test fails
before the fix and passes after. OIDC guide test now selects the visible switcher,
since desktop and hidden mobile navigation intentionally both render one.


### Final gate and handoff after all additions (2026-11-03)

- pnpm build/lint/typecheck: PASS on final source; lint retains only the existing
  informational String.raw notice in an MCP test. E2E typecheck: PASS.
- Sequential workspace suite:4538 TS tests passed,8 skipped; Python83 passed.
  CLI171/171 (including SSH metadata-cache regression), web251/251.
- Node metadata bridge + quickstart + local:70/70 PASS. Shellcheck PASS, including
  generated preparation shell from fake-PVE tests. Go source unchanged since the
  full five-module build/vet/test-p1/golangci-lint PASS earlier in this follow-up.
- Final OIDC Playwright22/22 PASS (original21 preserved plus Getting started),
  local1/1 PASS with no-team UI/ARIA checks through guide/settings/keys/environment/
  create/legacy redirects. Both isolated stacks, networks and DB volumes removed.
- Final CT590 deployment verified actual web-to-metadata bridge returns single.
  /app stays /app and shows empty onboarding, no team switcher/text; Settings and
  guide have no team wording. Guide uses real8443 URLs and public installer.
- Reinstalled latest bundled CLI over public Serve without CA. Short-code pairing
  succeeded. Actual whoami omitted both team and teams; limits/ls/help omitted
  team details, profile cached tenancy=single. Tested key+single/old-server cases
  in regression tests. CLI explicit --team and UMIAK_TEAM retain their API headers.
- LAN/private direct8444 metadata ownerPrivateCA=true and Serve8443=false verified
  even under shared Docker NAT. Direct constrained CA validates configured DNS;
  arbitrary SNI fails. Guest CA and both leaves remain byte-identical.
- Final recovery revoked all test sessions; old CLI returns owner_required.
  Restart generated a fresh private claim code. Anonymous meta confirms
  ownerClaimed=false, tenancy=single, ownerPrivateCA=false on primary8443.
  No sandbox VM500–589 remains; templates595–598 stopped/read-only. Removed test
  credentials/install directory on the Mac and retired unrestricted owner CA backup.
- Scope gaps: no live fresh-host prep/template rebuild (forbidden on this stand);
  covered by fakes/dry run. LAN4180 reachability remains untested from off-LAN Mac.
  Generic new-node Tailscale enrollment not run; existing-daemon Serve and optional
  sidecar config/internal TLS proxy path were tested. Independent acceptance remains.

Final screenshots (single-owner dashboard, actual CT590):
- Light: /Users/ib/.t3/userdata/browser-artifacts/browser-screenshot-umiak-dev-cp-tail0000-ts-net-mvzzbv8h-0681e7de.png
- Dark: /Users/ib/.t3/userdata/browser-artifacts/browser-screenshot-umiak-dev-cp-tail0000-ts-net-mvzzbvds-571f9c06.png
- Empty onboarding: /Users/ib/.t3/userdata/browser-artifacts/browser-screenshot-umiak-dev-cp-tail0000-ts-net-mvzzd4d1-12ed4007.png

## Round 3 — s16-fix2

Technical rulings: see the round-3 spec section. Preserve claimed CT590 owner state;
no test pairing, session recovery or sandbox lifecycle on this active stand.

- [x] Reproduce compiled Bun IP-constraint failure; DNS-only CA constraints and IP SANs.
- [x] Compile-native CLI TLS regression through actual quickstart ingress.
- [x] Pass initial TLS names, keep serving on expansion, expose rotation warning/action.
- [x] Dedicated Serve network, no upstream access; runtime leaf renewal.
- [x] Prep storage/subnet/media/atexit fixes with generated-script tests.
- [x] Collapsible wizard, consistent network instructions and local template docs.
- [x] gzip installer with archive/final hashes, TTY progress and install-only mode.
- [x] Final gate and state-preserving stand redeploy/live checks (evidence below).

### Round-3 verification evidence

- Bun latest release API returned `bun-v1.4.4`, matching every existing pin.
  Before the fix, the compiled native binary failed GET /v1/meta with
  `unsupported name constraint type (network_error)`, exit75. With DNS-only
  constraints the same compiled binary starts pairing over localhost and127.0.0.1.
- `pnpm build`, lint and typecheck: PASS. Sequential workspace suite:4538 TS
  passed,8 skipped; Python SDK83 passed. Five Go modules build/vet/test-p1/lint:
  PASS. OIDC Playwright22/22 and local1/1 PASS; both stacks/volumes removed.
- Node quickstart/local/meta-proxy87/87 PASS, including compiled CLI, one-day leaf
  runtime renewal, first-boot configured names, pending-name restart/rotation,
  sidecar network assertion, browser-vs-JSON unauthorized guide and prep atexit.
  Shellcheck PASS, including generated prep shell. Root and Serve compose config PASS.
- Full Node gate caught an outdated callback fixture lacking newly required
  mediaStorage; updated it. Compiled TLS test uses isolated XDG config/state paths.
- Live CT590 was already claimed. DB owner state MD5 remained identical before/
  after redeployment, with two existing sessions. No claim/recovery/test pairing,
  VM creation/deletion, fresh prep, template rebuild or firewall change occurred.
  PVE had no sandbox500–589; DB had no unfinished operations immediately before
  each short ingress restart. Rebuilt only quickstart and recreated it without
  dependencies; other running services and named volumes were preserved.
- Owner CA explicitly rotated to DNS-only constraints, SHA256
  `3D:9E:7C:CA:2F:C2:A8:78:51:3E:D3:99:80:E3:10:03:F5:1D:B9:02:68:54:A3:95:F2:51:42:70:6E:E2:E6:64`.
  Old trust must be replaced on private paths. Guest CA/tunnel/preview certificates
  remained byte-identical, and guest gateway443 was not restarted.
- Anonymous compiled native CLI refreshed tenancy to single over tailnetIP4180
  with the owner CA, then received expected owner_required from /v1/me. Compiled
  Linux binary did the same on https://192.168.68.90:4180. curl verified the LAN IP
  certificate through a tailnet connection alias. No pairing POST was performed.
- Public Serve https://umiak-dev-cp.tail0000.ts.net:8443 remained available and
  reported ownerClaimed=true. Installer live checks use install-only mode, preserving
  sessions. Native gzip size90,976,226→40,887,362 bytes (55.1% smaller).
- Real Serve check caught missing Content-Length: curl displayed an indeterminate
  animation. Added exact asset size with a failing-then-passing regression, then
  repeated the full Node suite and live TTY/non-TTY installer checks.

Remaining scope limits: owner-only live pairing/lifecycle intentionally omitted on
claimed stand; covered by local compiled-ingress tests and existing lifecycle gates.
Fresh-host prep and template builds remain faked/dry-run (forbidden on this stand).
Independent acceptance/master merge remains outstanding.

## Round 4 — s16-fix3

Technical decisions are delegated by Ilia; see round-4 spec rulings.

- [x] Dashboard Templates catalog, guarded enable/build/rebuild, durable progress,
  template/snapshot explanation and fake build/rebuild tests.
- [x] Separate template VMID range, inventory-based allocation and preserved adoption;
  occupied-ID, overlap and adoption regression tests.
- [x] API lifecycle defaults, regenerated OpenAPI and SDKs, create labels and Playwright.
- [x] PVE HTTPS ISO download, SHA256/security/storage/reuse/progress/permission tests,
  Windows legal notice and checksum guidance; no live download.
- [x] Full gate, light/dark captures, safe CT590 redeploy and read-only checks.
- [x] Commit logical steps and push s16-fix3; independent acceptance/master merge pending.

### Round-4 verification evidence (2026-11-03)

- Dashboard catalog exposes OS/capabilities/default and allowed sizes/enabled/version/
  date/VMID, guarded enable toggle, owner build/rebuild confirmation, serial durable
  progress/logs and per-build media records. OIDC members get a read-only catalog;
  operators can enable/disable and use S5 build instructions (OIDC has no owner
  build service). Snapshots explains and links back to Templates.
- Configurable template range defaults600–699 for fresh hosts; legacy state derives
  595–598. Inventory includes cluster-wide occupied QEMU/LXC IDs, nextid, overlap and
  exhausted-range checks. Fake adoption preserves existing IDs; rebuild dry-run
  makes no writes. Review caught missing node-agent propagation: fresh preparation
  now emits the selected range, fake verifies700–704; a real build checks the node
  range before downloading/creating. On adopted hosts an administrator must update
  the node-agent range before expansion; no automatic host writes.
- Windows and VirtIO URLs accept optional SHA256. With a checksum PVE verifies it;
  without one UI warns, node-agent computes actual SHA256, and source stays marked
  unverified in active template metadata and durable build records. Fake tests cover
  private/credential/non-HTTPS URLs and redirect targets, mismatch, reuse by checksum
  or filename+size, and missing scoped download permissions. No media shipped.
- Full `pnpm build`, `pnpm lint`, `pnpm typecheck`, e2e TypeScript checks PASS.
  Lint retains the pre-existing informational String.raw notice in an MCP test.
  Sequential workspace tests:4545 TS passed,8 skipped; Python83 passed (ruff passed).
  Go build/vet/test-p1/golangci-lint passed for all five modules; changed node-agent
  repeated after selected-storage SHA support. Scoped shellcheck passes with sourced
  files resolved; broad historical desktop probe scripts retain pre-existing warnings.
- Node quickstart/local/meta-proxy final gate127/127 PASS, including compiled native CLI TLS,
  optional checksum media tests, pending SDN fake, signals/HEAD, short-lived CA cap/
  expiry warning, atomic generation recovery and external rotation reload.
- Playwright OIDC23/23 PASS (prior22 plus Templates), local1/1 PASS. New checks assert
  real lifecycle defaults, template size and environment defaults. Targeted visual
  scenario1/1 PASS after scrolling the dialog to show TTL/idle. Isolated stacks and
  volumes removed. Initial runs collided with the other acceptance's standard
  Compose name and then with local trace output; final runs used a separate
  project, ports and artifact directories. No production failures were hidden.
- Live CT590: RAM inventory0 sandbox bytes; no VMs created. Built API/web/quickstart
  while old services kept running, verified zero pending/running operations before
  short replacement. Owner state MD5 remained bb3490bc78b21dcafbb04378d0e03729;
  ownerClaimed=true, tenancy=single; sessions preserved. Guest CA/tunnel/preview
  checksums unchanged; gateway/worker not restarted. API/web healthy.
- Live read-only API checks return Linux20261101.1/597, Windows20261101.2/598,
  Linux desktop20261101.3/596 and Windows desktop20261101.7/595 with build dates.
  Templates SSR200 contains explanation; limits defaults null/900; Setup range
  derives595–598. Validation function on deployed code rejects HTTP/loopback and
  accepts public HTTPS without a checksum, with no download or build invocation.
  No owner browser login, recovery, pairing, ISO download, rebuild, host prep,
  firewall/network change or sandbox mutation. Full claimed-owner browser check is
  left to Ilia; screenshots use the isolated fake-backend stack.
- Round-3 acceptance S1/S2 and lows1–5 incorporated: ten-year new CA with capped
  leaves and30-day warning, atomic credential generations, running reload after
  console rotation, real pending=1 SDN reads/fake fidelity, signal exits, public HEAD,
  accurate Serve published-port wording. Existing live CA was not rotated.

Screenshots (isolated backend, light/dark):
- /Users/ib/.t3/userdata/s16-fix3/templates-light.png
- /Users/ib/.t3/userdata/s16-fix3/templates-dark.png
- /Users/ib/.t3/userdata/s16-fix3/create-light.png
- /Users/ib/.t3/userdata/s16-fix3/create-dark.png

Remaining: master independent acceptance and merge; no live fresh-host preparation,
Windows build, ISO download or rebuild on this stand. Native PVE GET performs its
own DNS resolution after validated HEAD preflight; source/DNS changes between those
requests cannot be controlled without proxying the download. See quickstart README.
