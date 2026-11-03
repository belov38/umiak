# S18 Homelab Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command run as root on a Proxmox node installs Umiak into an LXC control plane reachable only through the user's tailnet over HTTPS, with a working Linux sandbox and an embedded desktop viewer, and removes the legacy install paths.

**Architecture:** A stdlib-only Python installer (`deploy/installer/`) fetched by a tiny `install.sh` prepares PVE objects locally (reusing `setup-prep.py`/`setup-adopt.py` logic), creates an unprivileged Debian 13 LXC with Docker and Tailscale, pushes secrets as files, and runs the published compose stack (GHCR images, pinned release). On start the quickstart service imports the installer's facts into setup state so the browser wizard shows only Templates and Smoke. The owner ingress serves a trusted copy of the moonlight-web frontend under `/desktop/<slug>/` and proxies only its API/WebSocket to the gateway with a signed per-request credential.

**Tech Stack:** Python 3.11+ stdlib (installer, pytest via uv for tests), POSIX sh, Node 26 (`deploy/compose/quickstart/*.mjs`, `node --test`), TypeScript (api/web/cli/sdk, vitest), Go 1.27 (gateway), Docker Compose, GitHub Actions, GHCR.

**Spec:** `docs/specs/s18-onboarding.md`

## Global Constraints

- PVE 9.x; installer runs as root on a cluster node; Python ≥ 3.11 stdlib only on the node (pve has 3.13).
- Tailscale is required and runs inside the control-plane CT, never required on the PVE host. Hostname default `umiak`. Serve: `tailscale serve --bg --https=443 http://127.0.0.1:4181`.
- Secrets reach the CT only as files (`pct push`, mode 0600) into the `pve-secrets` volume; never env vars, image layers, git or logs. The only secret printed is the one-time claim link.
- Never touch `vmbr0`, non-Umiak guests, non-Umiak firewall rules; every host change is listed and confirmed (unless `--yes`).
- No new global worker SSH override (S19 contract); node SSH address lives in `runtime.nodes.node_agent_ref`. Remove the worker `UMIAK_NODE_SSH_HOST` default from `compose.yaml` (S19 removes the env read).
- Bootstrap import is additive and idempotent: upserts only the installer node; never deletes or cordons other `runtime.nodes` rows.
- Auth modes after S18: `oidc` (corporate) and `owner` (trusted owner ingress, single tenancy). `none` is removed everywhere.
- Desktop path prefix is `/desktop/<slug>/`; homelab desktop links default `dataTransport=websocket`.
- Guest moonlight-web config is unchanged (no `url_path_prefix` on the guest); the ingress strips the prefix.
- Images: `ghcr.io/belov38/umiak-{quickstart,api,worker,web,mcp}:<version>`, linux/amd64. CI workflows use `workflow_dispatch` only.
- Port exposure in the CT: 443 (guest tunnel) on all interfaces; 4180, 8085, 2222 only from `tailscale0`, loopback and the installer node's LAN IP (emergency `ssh -L`), enforced in iptables `DOCKER-USER` using `--ctorigdstport`.
- Static CT IPv4 (installer asks; suggests the first DHCP lease); written into CT config.
- Live: cluster `ms02`, node `pve` only; off-limits guests: VMIDs < 500, 9000/9001, CT 110/111, VMs 102/103/108; do not change `pve2`.
- Talk to Ilia in Russian; code comments in English; no Claude-Session trailers.

## Review Focus

1. Installer re-run after a partial failure (CT created, Tailscale not logged in) → menu offers Resume/Repair, not a second install or duplicate PVE objects. Test in Task 6.
2. `curl … | sh` with no TTY available (cron, CI) → installer exits with a clear "run interactively or pass --non-interactive flags" message instead of hanging on a prompt. Test in Task 6.
3. Tailnet without MagicDNS/HTTPS certificates → installer stops at that step with the admin-console link and retries after Enter; never prints a claim link to a non-working origin. Test in Task 7.
4. Guest returns HTML (gateway `desktop_starting` page, error page) on a desktop API path → ingress returns its own JSON/HTML, never forwards guest HTML/JS. Test in Task 10.
5. Bootstrap import after Update with changed facts (new release, same node) → setup steps stay complete, smoke not invalidated, other nodes untouched. Test in Task 4.

---

### Task 1: Rename auth mode `none` → `owner` and delete the S15 deployment flavor

The homelab backend runs behind the owner ingress with `UMIAK_AUTH_MODE: none` (`compose.yaml:6`). Keep its semantics (fixed owner identity `umiak:local`, single tenancy, operator group, trusted `x-umiak-client-ip` check, hidden SSO preview option) under the name `owner`; delete everything that exists only to expose the backend directly on a LAN.

**Files:**
- Modify: `packages/auth/src/local-mode.ts` → rename to `packages/auth/src/owner-mode.ts`; keep `isLocalClientAllowed`→`isTrustedIngressClient`, CIDR parsing, session headers; drop default allowlist, `localPolicyWarnings`, `warnLocalPolicy`. Update `packages/auth/src/index.ts`.
- Modify (replace `"none"` with `"owner"`, drop LAN-only branches): `apps/api/src/auth/local.ts`, `apps/api/src/app.ts`, `proxied.ts`, `public.ts`, `main.ts`, `settings.ts` (drop `UMIAK_LOCAL_ALLOWED_HOSTS`), `routes/meta.ts` (enum `oidc|owner`, `tenancy:"single"` for `owner`); `apps/mcp/src/http/app.ts`, `apps/mcp/src/settings.ts`; `apps/web/src/lib/env.ts`, `lib/guard.ts`, `instrumentation-node.ts`, `session-context.tsx`, `app-shell.tsx`, `default-team-shell.tsx`, `app/t/[team]/layout.tsx`, `account/page.tsx`, `features/sandbox/desktop.tsx`, `ports.tsx` (keep SSO hiding, rename hook `useLocalMode`→`useOwnerMode`); `packages/payload/src/config.ts`, `identity/strategy.ts`; `apps/worker/src/env.ts`; CLI `commands/login.ts`, `config.ts`, `auth/token.ts`, `commands/auth-token.ts`, `keys.ts`, `mcp.ts`, `context.ts` (`AuthKind "owner"`); SDKs `packages/sdk-ts/src/credentials.ts`, `packages/sdk-py/umiak_sdk/_sync/client.py`, `_async/client.py`; gateway `internal/config/config.go`, `portauth/auth.go` (keep `PreviewScheme=="http"` SSO rejection), `server/server.go`; `compose.yaml` (`UMIAK_AUTH_MODE: owner`, drop `UMIAK_LOCAL_ALLOWED_CIDRS` LAN ranges → `127.0.0.0/8,::1/128,172.29.116.0/24`).
- Regenerate: `apps/api/openapi/v1.json`, `packages/sdk-ts/src/gen/v1.d.ts`, `packages/sdk-py/umiak_sdk/_gen/models/meta_auth_mode.py`, `meta.py`.
- Move: `clientGuard` from `deploy/compose/local/ingress.mjs:18-70` into `deploy/compose/quickstart/client-guard.mjs`; update imports in `server.mjs:7`, `origin.mjs:4`.
- Delete: `deploy/compose/local.yaml`, `local-e2e.yaml`, `README.local.ru.md`, `deploy/compose/local/`, `apps/web/e2e/local/`, `infra/dev-cp/compose.local.yaml`, `apps/web/src/components/admin/local-logout.tsx` (regenerate `importMap.js`), local-mode tests (`apps/{api,cli,mcp,web}/test/local-mode.test.ts`, `packages/auth/test/local-mode.test.ts`, `packages/payload/test/local-mode.test.ts`, `packages/sdk-py/tests/test_local_mode.py`), `docs/specs/s15-local-mode.md`, `docs/plans/s15-local-mode.md`; none-mode bits in `infra/dev-cp/{deploy.sh,names.sh,e2e.sh,README.md}`.
- Test: `packages/auth/test/owner-mode.test.ts`, `apps/api/test/owner-mode.test.ts`, existing tests listed by the inventory (`meta.test.ts`, `login-http.test.ts`, `mcp main.test.ts`, web `strategy/tenancy/deployment-meta/env/getting-started` tests, worker `env.test.ts`, sdk-ts `credentials.test.ts`, gateway `config_test.go`, `portauth/auth_test.go`, `e2e/http_previews_test.go`).

**Interfaces:**
- Produces: `AuthMode = "oidc" | "owner"`; `/v1/meta.auth.mode` enum `oidc|owner`; `isTrustedIngressClient(addr: string, cidrs: CidrSet): boolean`; web hook `useOwnerMode(): boolean`; `deploy/compose/quickstart/client-guard.mjs` exports `clientGuard(options)` with the old signature.

- [ ] **Step 1: Write failing tests.** `owner-mode.test.ts` (auth): `parseAuthMode("owner") === "owner"`, `parseAuthMode("none")` throws `/UMIAK_AUTH_MODE must be oidc or owner/`; api `owner-mode.test.ts`: with `UMIAK_AUTH_MODE=owner` a request from `172.29.116.10` with `x-umiak-client-ip: 100.64.10.20` authenticates as `umiak:local`; a request from `192.168.1.5` is rejected 403 `ingress_required`; `GET /v1/meta` returns `{auth:{mode:"owner"}, tenancy:"single"}`. Gateway: `config_test.go` `TestAuthModeOwner` accepts `owner`, rejects `none`.
- [ ] **Step 2: Run** `mise exec -- pnpm -r test` and `cd services/gateway && mise exec -- go test ./...`. Expected: new tests FAIL.
- [ ] **Step 3: Implement the rename and deletions** listed above. `grep -rn "\"none\"\|'none'\|UMIAK_LOCAL_ALLOWED_HOSTS\|useLocalMode\|README.local" --include=*.ts --include=*.tsx --include=*.go --include=*.mjs --include=*.py --include=*.md` must return no auth-mode hits afterwards.
- [ ] **Step 4: Regenerate** OpenAPI and SDKs with the existing package scripts (`pnpm --filter @umiak/api openapi`, sdk-ts/sdk-py `generate` scripts); run full gate: `mise exec -- pnpm build && pnpm lint && pnpm typecheck && pnpm -r test`, `go vet ./... && golangci-lint run` in `services/gateway`, `uv run pytest` in `packages/sdk-py`, `node --test deploy/compose/quickstart/*.test.mjs deploy/compose/meta-proxy.test.mjs deploy/compose/canonical-fetch.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit** `refactor: replace S15 none mode with owner ingress mode`.

### Task 2: Remove legacy S16 install paths

**Files:**
- Delete: `deploy/compose/quickstart/setup-prep.mjs`, `setup-prep.test.mjs`, `setup-asset.test.mjs`, `compose.tailscale.yaml`, `tailscale/serve.json`, `infra/dev-cp/deploy-quickstart.sh`, `infra/dev-cp/quickstart-preflight.sh`, `infra/dev-cp/compose.quickstart.yaml`.
- Move (git mv, keep history): `deploy/compose/quickstart/setup-prep.py` → `deploy/installer/umiak_installer/prepare_host.py`; `setup-prep-fake.py` → `deploy/installer/tests/fake_pve.py`; `setup-adopt.py` → `deploy/installer/umiak_installer/host_report.py` (Task 5 adapts them).
- Modify `deploy/compose/quickstart/setup.mjs`: `STEPS = ["limits","network","templates","smoke"]` plus internal `connection`/`host` records written only by bootstrap (Task 4); remove browser `steps.connection`/`steps.host` handlers, `preparationScript`, `/pve-setup.sh`, `/quickstart/setup/callback`, `/quickstart/setup/prepare`, the `connection` special case (L239-243) and the build pre-check over old steps (L742). Keep `validateConnection`, `requireRootCA`, `deniedPeer` (re-sourced from `state.steps.connection.data`).
- Modify `setup-ui.mjs`: drop Connect/Prepare sections, Funnel/LAN/Chrome-flag copy, `docker compose` hints, `#prepare` script; header says "Templates and smoke test".
- Modify `server.mjs`: drop non-`__Host` `umiak_owner` cookie branch (L56-68, 266, 366, 374), LAN CIDR allowlist (L115-125), `:4180` Serve warning (L150-156), preparation exemption (L164-178), L289-294; claim page text no longer mentions `docker compose logs`.
- Modify web: `apps/web/src/lib/browser-guidance.ts` (drop LAN HTTP/Chrome flag guidance; keep `certificateExpiryLines` and WebCodecs/WebRTC detection), its callers; `apps/web/src/features/getting-started/content.ts` (drop LAN HTTP and sidecar sections).
- Modify docs: `deploy/compose/quickstart/README.md` (rewrite as operator notes for the in-CT stack), `docs/getting-started.md` (remove `docker compose up`, LAN HTTP, S15 sections; install = installer one-liner).
- Tests: update `setup.test.mjs`, `server.test.mjs`, `serve.test.mjs`, `setup-ui.test.mjs`, `install.test.mjs` (HTTPS origins only), `compiled-cli.test.mjs`, `apps/web/test/browser-guidance.test.ts`, `getting-started.test.ts`, `ui-policy.test.ts`, `apps/web/e2e/quickstart-ui.mjs` (`__Host-umiak_owner`).

**Interfaces:**
- Produces: `SetupWizard` steps `limits|network|templates|smoke`; `state.steps.connection.data` and `state.steps.host.data` keep their current shapes (written by Task 4).

- [ ] **Step 1: Failing tests.** `setup.test.mjs`: `POST /quickstart/setup/connection` → 404; `GET /pve-setup.sh` → 404; `POST /quickstart/setup/prepare` → 404; rendered setup page contains `Templates` and `Smoke test` and not `Connect Proxmox`, `Prepare or adopt`, `chrome://flags`, `Funnel`. `server.test.mjs`: an HTTP request on 4180 from a non-loopback peer gets 403 `use_tailnet_https`; owner cookie set over the trusted HTTPS proxy is `__Host-umiak_owner`; plain `umiak_owner` cookie is ignored.
- [ ] **Step 2: Run** `node --test deploy/compose/quickstart/*.test.mjs`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement deletions/edits** above. 4180 serves loopback (and, for emergency, any peer allowed by the CT firewall) but sets cookies as `__Host-` only when the origin is `localhost` or a trusted HTTPS proxy request.
- [ ] **Step 4: Run** the quickstart tests and `pnpm --filter @umiak/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: remove browser Connect/Prepare, LAN HTTP and sidecar paths`.

### Task 3: Claim link

**Files:**
- Modify: `deploy/compose/quickstart/server.mjs` (new `GET /claim` page), `owner.mjs` (no change to claim semantics).
- Test: `deploy/compose/quickstart/server.test.mjs`.

**Interfaces:**
- Produces: claim URL format `https://<origin>/claim#<code>`; console helper `claimLink(origin: string, code: string): string` in `deploy/compose/quickstart/owner.mjs`.

- [ ] **Step 1: Failing tests.** `GET /claim` on an unclaimed deployment returns 200 HTML with a script that reads `location.hash`, POSTs `{code}` to `/owner/claim` with exact Origin, clears the hash (`history.replaceState`) and redirects to `/setup`; on a claimed deployment `GET /claim` redirects 302 to the Sign in page. `claimLink("https://umiak.tail0000.ts.net","abc") === "https://umiak.tail0000.ts.net/claim#abc"`.
- [ ] **Step 2: Run** `node --test deploy/compose/quickstart/server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Page uses the existing `ui.mjs` wrapper, no external assets; manual code entry remains as fallback when the hash is empty.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(quickstart): one-click claim link`.

### Task 4: Bootstrap import of installer facts

**Files:**
- Create: `deploy/compose/quickstart/bootstrap.mjs`.
- Modify: `deploy/compose/quickstart/run.mjs` or the quickstart service start-up (call `bootstrapFromInstall` before listening), `setup.mjs` (export the limits/network step implementations for reuse).
- Test: `deploy/compose/quickstart/bootstrap.test.mjs`.

**Interfaces:**
- Consumes: files in `UMIAK_SECRETS_DIR` (`/pve-secrets`) written by the installer: `install.json`, `pve-token`, `pve-token-id`, `pve-root-ca.pem`, `umiak-node_ed25519`, `known_hosts`, `host-report.json`.
- `install.json` schema (version 1):
  ```json
  {"version":1,"release":"0.2.0","connection":{"apiUrl":"https://192.168.68.116:8006","node":"pve","tokenId":"umiak@pve!umiak","fingerprint":"<sha256 hex>","tlsName":"pve","sshHost":"192.168.68.116"},
   "limits":{"storage":"local-lvm","vmidMin":500,"vmidMax":589,"ramCapMb":8192,"templateVmidMin":600,"templateVmidMax":699},
   "network":{"gatewayAddress":"192.168.68.50","guestDns":"1.1.1.1","previewDomain":"umiak.100-64-10-20.sslip.io","sshHost":"100.64.10.20"},
   "publicUrl":"https://umiak.tail0000.ts.net"}
  ```
- Produces: `bootstrapFromInstall({store, secretsDir, steps, now}): Promise<"imported"|"unchanged"|"absent">`; setup state fields `state.bootstrap = {digest, importedAt, release}`.

- [ ] **Step 1: Failing tests** (`bootstrap.test.mjs`, fake store + fake PVE as in `setup-vmids.test.mjs`):
  - absent `install.json` → `"absent"`, state untouched;
  - first import → `"imported"`; `steps.connection/host/limits/network.status === "ready"`; `runtime.nodes` upsert called once for node `pve` with `node_agent_ref = "192.168.68.116"`;
  - second call with identical file → `"unchanged"`, no writes;
  - changed `release` only (Update) → `"imported"`, `state.complete` and `steps.smoke` unchanged;
  - existing extra node row `pve2` in the fake DB is not deleted or modified;
  - `connection.fingerprint` mismatch with the live PVE leaf → throws `/fingerprint mismatch/`, state untouched;
  - host report failing `verifyIsolation` → throws, state untouched.
- [ ] **Step 2: Run** `node --test deploy/compose/quickstart/bootstrap.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** using `validateConnection`, `pinnedPve` (`/version` check), `verifyIsolation(report.rules, report.ipset, network.gatewayAddress, report.denySets)`, `checkNode`, then the existing limits and network step functions under `store.exclusive`. Digest = SHA256 of `install.json` + `host-report.json`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(quickstart): import installer facts on start`.

### Task 5: Installer core library (PVE preparation, local)

**Files:**
- Create: `deploy/installer/pyproject.toml` (pytest only, `requires-python >=3.11`), `deploy/installer/umiak_installer/__init__.py`, `pve.py` (thin `pvesh`/`pveum`/`pct` runner, injectable), `checklist.py`, `prepare_host.py` (adapted), `host_report.py` (adapted), `state.py`.
- Test: `deploy/installer/tests/test_checklist.py`, `test_prepare_host.py`, `test_state.py`, `fake_pve.py`.

**Interfaces:**
- Produces:
  - `class Runner: run(argv: list[str], input: str|None=None) -> str` (raises `CommandError`); `FakeRunner` in tests.
  - `checklist.inspect(runner) -> list[Check]`, `Check(name: str, ok: bool, fix: Fix|None, detail: str)`; `Fix(description: str, commands: list[list[str]])`. Checks: root, PVE major 9, quorate cluster, python ≥3.11, lvmthin storage exists, directory storage with `iso,import`, dnsmasq present (fix: `apt-get install -y dnsmasq dnsmasq-utils` + `systemctl disable --now dnsmasq`), `net.ipv4.ip_forward=1` (fix: `/etc/sysctl.d/99-umiak.conf` + `sysctl --system`), cluster firewall enabled (fix: `pvesh set /cluster/firewall/options --enable 1` with warning text), no pending SDN, free VMIDs in ranges.
  - `prepare_host.prepare(runner, cfg: PrepareConfig, out_dir: Path) -> PrepareResult` — no network download, no callback; writes `pve-token`, `pve-token-id`, `pve-root-ca.pem`, `umiak-node_ed25519`(+`.pub`), `known_hosts` into `out_dir` (0600) and installs node-agent from a given binary path; keeps the existing rollback journal/timer behaviour. `PrepareConfig(node, storage, gateway_ip, guest_dns, vmid_min, vmid_max, tpl_min, tpl_max, node_agent_binary: Path, node_agent_sha256: str)`.
  - `host_report.collect(runner, node) -> dict` writing the same JSON shape `verifyIsolation` consumes.
  - `state.load() / save(InstallState)`; file `/etc/pve/umiak/install-state.json`; `InstallState(version, ct_id, ct_ip, node, release, tailnet_host, phase: "prepared"|"ct-created"|"stack-up"|"tailnet-up"|"complete")`.

- [ ] **Step 1: Failing tests.** `test_checklist.py`: fake host without dnsmasq and with `ip_forward=0` yields two failed checks with exact fix commands above; a host matching `pve` today yields all ok. `test_prepare_host.py`: on an empty fake PVE `prepare` creates `umiak@pve`, token `umiak@pve!umiak`, pool `umiak`, zone `umiak`, vnet `umiak0`, subnet `10.88.0.0/24`, IPSet `umiak-gateway` containing `gateway_ip`, group `umiak-egress`; writes the five secret files with mode 0600; re-running on the prepared fake is a no-op that still yields a usable token (token secret is rotated via `pveum user token remove/add` only when the stored secret file is missing — record this as the fix for the old "token exists" dead end); a foreign pending SDN change aborts before any write. `test_state.py`: round-trip and atomic replace.
- [ ] **Step 2: Run** `cd deploy/installer && mise exec -- uv run pytest`. Expected: FAIL.
- [ ] **Step 3: Implement** by adapting the moved scripts: replace `urllib` download of node-agent with a local path + SHA256 check; replace callback POST with writing files; keep argv-list commands only (no shell strings).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(installer): local PVE preparation library`.

### Task 6: Installer entry, menu and install flow up to stack start

**Files:**
- Create: `install.sh` (repo root), `deploy/installer/umiak_installer/main.py` (argparse + menu), `ct.py` (LXC lifecycle), `stack.py` (compose files, `.env`, pull/up), `release.py` (resolve version, download + verify bundle).
- Test: `deploy/installer/tests/test_menu.py`, `test_ct.py`, `test_stack.py`, `test_release.py`, `deploy/installer/tests/install_sh_test.sh` (shellcheck + dry-run).

**Interfaces:**
- Consumes: Task 5 `Runner`, `checklist`, `prepare_host`, `host_report`, `state`.
- Produces:
  - `install.sh`: `curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh`. Resolves `UMIAK_VERSION` (default: latest GitHub release), downloads `umiak-installer-<ver>.tar.gz` and `SHA256SUMS` from the release over HTTPS, verifies, unpacks to `/var/lib/umiak-installer/<ver>`, runs `exec python3 -m umiak_installer "$@" </dev/tty`. Without `/dev/tty` and without `--non-interactive`: prints `Run this in an interactive shell or pass --non-interactive with flags (see --help)` and exits 2.
  - `main.py` menu by detected state: none → Install; `phase != complete` → Resume install / Uninstall; complete → Update / Sign in a new browser / Reset owner access / Uninstall. Flags: `--non-interactive --yes --storage --ct-id --ct-ip --gateway-cidr --vmid-range 500-589 --template-range 600-699 --ram-cap-mb --hostname umiak`.
  - `ct.create(runner, CtSpec) -> None`: `pveam download local debian-13-standard_13.6-1_amd64.tar.zst` if absent; `pct create <id> local:vztmpl/... --unprivileged 1 --features nesting=1,keyctl=1 --dev0 /dev/net/tun --memory 4096 --cores 2 --rootfs <storage>:32 --net0 name=eth0,bridge=vmbr0,ip=<ip>/<cidr>,gw=<gw> --onboot 1 --tags umiak --hostname umiak-cp`; start; install Docker Engine + compose plugin from Docker's Debian apt repo; install `tailscale` from pkgs.tailscale.com.
  - `stack.write(runner, ct_id, release, env: dict)` writes `/opt/umiak/compose.yaml` (from the bundle) and `/opt/umiak/.env` (non-secret: `UMIAK_VERSION`, `UMIAK_PUBLIC_URL`, `UMIAK_PREVIEW_DOMAIN`, `UMIAK_SSH_HOST`); `stack.push_secrets(runner, ct_id, files: dict[str, Path])` uses `pct push --perms 0600` into a staging dir then `docker run --rm -v umiak_pve-secrets:/s ...` copy; `stack.up(runner, ct_id)` = `docker compose pull && docker compose up -d` with health wait (≤ 5 min).
  - Network firewall: `stack.write_firewall(runner, ct_id, node_lan_ip)` installs a systemd unit adding `DOCKER-USER` rules: drop `--ctorigdstport 4180,8085,2222` from `eth0` except source `node_lan_ip`.

- [ ] **Step 1: Failing tests.** `test_menu.py`: no state → options `["Install"]`; state phase `ct-created` → `["Resume install","Uninstall"]`; complete → `["Update","Sign in a new browser","Reset owner access","Uninstall"]`. `test_ct.py`: `create` emits the exact `pct create` argv above for `CtSpec(id=591, ip="192.168.68.50", cidr=22, gw="192.168.68.1", storage="local-lvm")`; refuses an existing CT id not tagged `umiak`. `test_stack.py`: secrets never appear in any argv or `.env`; `.env` contains exactly the four keys. `test_release.py`: SHA mismatch aborts. `install_sh_test.sh`: `sh install.sh </dev/null` without tty exits 2 with the message; `shellcheck install.sh` clean.
- [ ] **Step 2: Run** `uv run pytest` and `sh deploy/installer/tests/install_sh_test.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Install flow order: checklist (confirm fixes) → questions → `prepare_host.prepare` + `host_report.collect` → `ct.create` → Tailscale (Task 7) → extract node-agent from the pulled quickstart image (`docker create` + `docker cp /app/quickstart-assets/umiak-node-linux-amd64`, `pct pull`) for `prepare_host` (so order is: CT + pull before node-agent install; adjust `prepare` to accept the binary afterwards via `install_node_agent(runner, path, sha256)`) → write `install.json`, push secrets → `stack.up` → print claim link (Task 7). Persist `state.phase` after each step.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(installer): install.sh entry, menu and CT/stack setup`.

### Task 7: Tailscale in the CT, origin wiring and finish

**Files:**
- Create: `deploy/installer/umiak_installer/tailnet.py`.
- Modify: `compose.yaml` (app env uses `${UMIAK_PUBLIC_URL}` for `UMIAK_APP_ORIGIN/APP_URL/API_URL/API_PUBLIC_URL`, `${UMIAK_PREVIEW_DOMAIN}`, `UMIAK_SSH_HOST: ${UMIAK_SSH_HOST}`; quickstart 4180 published on `0.0.0.0` but filtered by Task 6 rules; remove worker `UMIAK_NODE_SSH_HOST` default).
- Test: `deploy/installer/tests/test_tailnet.py`.

**Interfaces:**
- Produces: `tailnet.up(runner, ct_id, hostname) -> TailnetInfo(dns_name: str, ipv4: str)`: runs `tailscale up --hostname=<h>` in the CT, prints the login URL line, polls `tailscale status --json` until `BackendState == "Running"`; `tailnet.require_https(info_json) -> None` raises `TailnetNotReady("Enable MagicDNS and HTTPS certificates: https://login.tailscale.com/admin/dns")` when `CertDomains` is empty; `tailnet.serve(runner, ct_id)` runs `tailscale serve --bg --https=443 http://127.0.0.1:4181`.
- Finish line: `Open https://<dns_name>/claim#<code>` where code comes from `docker compose logs quickstart` parsing `Umiak one-time setup code: (\S+)`.

- [ ] **Step 1: Failing tests.** Status JSON without `CertDomains` → `TailnetNotReady` with the admin URL; with `CertDomains:["umiak.tail0000.ts.net"]` and `TailscaleIPs:["100.64.10.20"]` → `TailnetInfo("umiak.tail0000.ts.net","100.64.10.20")`; `install.json.network.previewDomain == "umiak.100-64-10-20.sslip.io"`, `sshHost == "100.64.10.20"`, `publicUrl == "https://umiak.tail0000.ts.net"`; claim-code parser returns the code from a sample log line and ignores other lines.
- [ ] **Step 2: Run** `uv run pytest tests/test_tailnet.py`. Expected: FAIL.
- [ ] **Step 3: Implement**; interactive mode waits on Enter and re-checks after `TailnetNotReady`; non-interactive exits 3.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(installer): tailnet login, HTTPS serve and claim link`.

### Task 8: Day-2 actions

**Files:**
- Create: `deploy/installer/umiak_installer/day2.py`.
- Test: `deploy/installer/tests/test_day2.py`.

**Interfaces:**
- Produces: `update(runner, state, release)`: download new bundle, rewrite compose/.env, `pull && up -d`, re-extract node-agent and reinstall on the installer node only if SHA changed, re-verify CT IP in IPSet/tunnel URL; `signin(runner, state) -> str` runs `docker compose exec -T quickstart umiak-signin --link` and prints `https://<host>/signin#<code>`; `reset_owner(runner, state)` asks for typed `RESET` then runs `recover.mjs` and prints a new claim link; `uninstall(runner, state, remove_pve_objects: bool, remove_guests: bool)`: stop/destroy CT; if `remove_guests` destroy VMs in pool `umiak` (refuse VMIDs outside Umiak ranges); if `remove_pve_objects` delete Umiak SDN/IPSet/group/pool/roles/user/token and `/usr/local/bin/umiak-node`, `/etc/pve/umiak`, the forced-command line; apply SDN.
- Modify: `deploy/compose/quickstart/signin-code.mjs` + `umiak-signin` (`--link` prints the path form `/signin#<code>`), `server.mjs` (`/signin` page reads hash like `/claim`).

- [ ] **Step 1: Failing tests.** `update` with unchanged node-agent SHA does not touch the node; with changed SHA reinstalls; `uninstall(remove_pve_objects=False)` never calls `pveum`/`pvesh delete`; `uninstall(remove_guests=True)` refuses a pool member with VMID 102; `reset_owner` without typed `RESET` does nothing. Node test: `umiak-signin --link` output matches `/^\/signin#[A-Z2-7-]+$/`; `GET /signin` page posts the hash code.
- [ ] **Step 2: Run** pytest and `node --test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(installer): update, sign-in, reset and uninstall`.

### Task 9: Gateway signed ingress credential for path-addressed desktop

**Files:**
- Modify: `services/gateway/internal/config/config.go` (new `UMIAK_GATEWAY_INGRESS_DESKTOP_KEY_FILE`), `internal/portauth/desktop.go` (accept credential), `internal/httpproxy/proxy.go` (strip header before forwarding), `services/gateway/internal/devsecrets/devsecrets.go` and `deploy/compose/quickstart/gateway-init.mjs` (generate 32-byte key file `ingress-desktop-key` shared with quickstart).
- Test: `services/gateway/internal/portauth/desktop_ingress_test.go`.

**Interfaces:**
- Produces: header `Umiak-Ingress-Desktop: <label>.<expUnix>.<base64url(HMAC-SHA256(key, label+"."+expUnix))>`; valid when label equals the routed `l.Raw`, `exp` within 60 s from now and not past; then no cookie/ticket/Origin check is required. Node helper `signDesktop(key: Buffer, label: string, now: number): string` in `deploy/compose/quickstart/desktop-proxy.mjs` (Task 10) must produce the same format.

- [ ] **Step 1: Failing tests.** valid header for `brave-otter-lake-desktop` passes `CheckDesktop` for a WebSocket upgrade with foreign Origin; wrong label → 403; expired (`exp = now-1`) → 403; bad MAC → 403; header absent → old behaviour unchanged; forwarded upstream request has no `Umiak-Ingress-Desktop` header; `X-Umiak-Desktop-User` still injected.
- [ ] **Step 2: Run** `cd services/gateway && mise exec -- go test ./internal/portauth/...`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto/hmac` constant-time compare.
- [ ] **Step 4: Run** `go test ./... && go vet ./... && golangci-lint run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): signed ingress credential for desktop`.

### Task 10: Owner ingress serves trusted desktop viewer under `/desktop/<slug>/`

**Files:**
- Create: `deploy/compose/quickstart/desktop-proxy.mjs`.
- Modify: `deploy/compose/quickstart/server.mjs` (route + upgrade), `deploy/compose/quickstart/Dockerfile` (stage `moonlight-assets`: download `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` v3.0.1, verify the SHA256 from `infra/templates/linux-desktop/versions.toml`, extract `package/static` minus `index.html`/`admin.html` into `/app/quickstart-assets/moonlight-web/`), add a test that the Dockerfile ARG hash equals `versions.toml`.
- Test: `deploy/compose/quickstart/desktop-proxy.test.mjs`.

**Interfaces:**
- Consumes: Task 9 header format; gateway at `http://gateway:8085`, preview domain from network config.
- Produces: `handleDesktop(req, res, {owner, assetsDir, key, gatewayUrl, previewDomain}) -> boolean` and `handleDesktopUpgrade(req, socket, head, ctx) -> boolean`.
  - `GET /desktop/<slug>/config.js` → `window.__CONFIG_JS__ = {"path_prefix":"/desktop/<slug>"}`.
  - `GET /desktop/<slug>/` → proxied gateway `GET /` (opens streamer, timeout 45 s); on 302 to `/stream.html?...` respond 302 `/desktop/<slug>/stream.html?...`; on 503 `desktop_starting` respond with own "Starting the desktop…" page (S17 copy, auto-refresh 5 s).
  - Static files (`stream.html`, `*.js`, `*.wasm`, `*.svg`, `*.png`, `manifest.json`) served from `assetsDir` only.
  - `/desktop/<slug>/api/*` (all methods) and WebSocket `/desktop/<slug>/api/host/stream/web_socket` → gateway with `Host: <slug>-desktop.<previewDomain>:8085`, prefix stripped, `Umiak-Ingress-Desktop` added, client cookies/auth stripped; response allowed only for content types `application/json`, `application/sdp`, `application/trickle-ice-sdpfrag`, `application/x-ndjson`, `application/octet-stream` or empty body; `Set-Cookie` removed; anything else → 502 JSON `{"error":"desktop_upstream_rejected"}`; upgrade relays only after reading an upstream `101`.
  - `/desktop/<slug>/` (stream end navigation) after stream → own "Stream ended" page with a Reconnect button.
  - Only browser owner sessions (`store.canApprove`); CLI bearer → 403. Exact Origin check on non-GET and upgrades. `x-frame-options: SAMEORIGIN` for `/desktop/` responses.
- [ ] **Step 1: Failing tests** (fake gateway): each bullet above as one test, including `text/html` and `application/javascript` upstream responses → 502; `Set-Cookie` stripped; CLI token → 403; upgrade with upstream `200 text/html` → socket closed, no bytes relayed; `config.js` per slug; slug with `..` or `/` → 404.
- [ ] **Step 2: Run** `node --test deploy/compose/quickstart/desktop-proxy.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(quickstart): trusted desktop viewer on the owner origin`.

### Task 11: API mints path-form desktop links in owner mode

**Files:**
- Modify: `apps/api/src/desktop/service.ts` (`desktopUrl`, `issueDesktopLink`), `apps/api/src/settings.ts` (`UMIAK_DESKTOP_PATH_PREFIX`, default unset; compose sets `/desktop`), `compose.yaml`.
- Test: `apps/api/test/desktop-path.test.ts`.

**Interfaces:**
- Produces: when `desktopPathPrefix` is set, `POST /v1/sandboxes/{id}/desktop/links` returns `{url: "<appOrigin>/desktop/<slug>/?dataTransport=websocket[&fps=..&bitrate=..]", expiresAt}` without inserting a ticket; explicit `transport:"webrtc"` is honoured.
- [ ] **Step 1: Failing tests** for default websocket, explicit webrtc, fps/bitrate passthrough, unset prefix → old hostname URL unchanged.
- [ ] **Step 2: Run** `pnpm --filter @umiak/api test -- desktop-path`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): path-form desktop links for owner mode`.

### Task 12: Release workflow and dev override

**Files:**
- Create: `.github/workflows/release.yml` (`workflow_dispatch` with input `version`): build and push the five images to GHCR with `docker/build-push-action`, tags `<version>` and `latest`; build `umiak-installer-<version>.tar.gz` (`deploy/installer/umiak_installer/**`, `compose.yaml` with images pinned to `<version>`, `VERSION`); `SHA256SUMS`; create GitHub release `v<version>` with both assets.
- Create: `compose.dev.yaml` (adds the current `build:` sections back for contributors: `docker compose -f compose.yaml -f compose.dev.yaml up --build`).
- Modify: `compose.yaml` services use `image: ghcr.io/belov38/umiak-<name>:${UMIAK_VERSION:?}` and drop `build:`.
- Test: `deploy/installer/tests/test_bundle.py` (bundle script output contains pinned image tags and no `build:` keys).

- [ ] **Step 1: Failing test** for the bundle builder `deploy/installer/build_bundle.py <version> <out>`.
- [ ] **Step 2: Run** pytest. Expected: FAIL.
- [ ] **Step 3: Implement** workflow (uses `actions/checkout@v7`, `jdx/mise-action@v5` like existing workflows; check latest major of `docker/*` actions before pinning) and bundle builder.
- [ ] **Step 4: Run tests** and `actionlint` if available. Expected: PASS.
- [ ] **Step 5: Commit** `ci: release workflow publishing GHCR images and installer bundle`.
- [ ] **Step 6 (manual, Ilia):** after the first release run, set each `umiak-*` GHCR package to Public in GitHub UI. Record in roadmap.

### Task 13: Docs, roadmap and live acceptance on `pve`

**Files:**
- Modify: `README.md` (install one-liner and prerequisites), `docs/getting-started.md`, `deploy/compose/quickstart/README.md`, `docs/architecture.md` (homelab mode section), `docs/roadmap.md` (S18 row; S15 marked removed).

- [ ] **Step 1:** Delete test VM 590 `umiak-onboard-cp` on `pve` (`qm stop 590 && qm destroy 590 --purge`).
- [ ] **Step 2:** Run the first release (`gh workflow run release.yml -f version=0.2.0`), ask Ilia to make packages public.
- [ ] **Step 3:** On `pve`: `curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh`; record each prompt and timing. Expected: claim link printed; opens over tailnet HTTPS.
- [ ] **Step 4:** Claim, build Linux template, smoke passes; create a Linux sandbox from the Mac CLI installed via `https://umiak.<tailnet>.ts.net/install.sh`; exec; port preview on tailnet IP; SSH via 2222.
- [ ] **Step 5:** Build the Windows template with Ilia's ISO already on `local:iso`, open desktop in the dashboard iframe over `/desktop/<slug>/`; verify in DevTools that no response from the guest is HTML/JS.
- [ ] **Step 6:** Installer re-run → Update (same version) is a no-op; Sign in a new browser works; Uninstall with object removal leaves no Umiak objects (`pveum user list`, SDN, IPSet, pool, LVs `vm-5xx`/`vm-6xx` of Umiak only).
- [ ] **Step 7:** Independent acceptance subagent with spec + diff; fix blockers; merge to main; push; update memory and roadmap.
