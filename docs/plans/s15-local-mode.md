# S15 implementation plan and evidence

Spec: ../specs/s15-local-mode.md. Branch: s15-local-mode. No merge into main.

## Rulings

1. Keep OIDC as the default. Validate the mode at startup; no fallback on typos.
2. Share CIDR parsing and fixed identity between TS services in @umiak/auth.
3. Retain scoped team keys even in none mode; restrict every local client by CIDR.
4. Reject SSO previews clearly (403); token/public previews are unchanged.
5. Expose web through a small private ingress that overwrites client IP headers.
   Never publish the Next.js port. Retain origin/CSRF enforcement over LAN HTTP.
6. Keep WSS and existing CA for guests; browser app can use plain HTTP.
7. Run fake backend E2E on an isolated compose project and distinct host ports.
8. Live check is conditional on existing connectivity, without changing CT590,
   firewall, SDN, templates, unrelated VMs or Ilia's identity.

## Tasks

- [ ] Shared auth mode/CIDR tests, local identity bootstrap, API meta/auth, worker.
- [ ] Web identity, ingress trust contract, HTTP cookies and UI tests.
- [ ] CLI tokenless profiles, SDKs, remote/stdio MCP tests.
- [ ] Gateway SSO rejection tests, compose override, Russian quickstart.
- [ ] Local compose fake backend Playwright/CLI E2E; existing OIDC Playwright.
- [ ] Sequential full TS/Go gate, review, logical commits, push, evidence.

## Evidence log

2026-11-02: clean existing worktree, branch s15-local-mode. Read CLAUDE.md,
architecture auth, roadmap, compose/e2e/dev stand layout.

Live preflight (read-only SSH to pve): host 25513 MiB available; CT590 6144 MiB
limit, 4692 MiB available; no running sandbox VM in 500–589. CT590 listens on
0.0.0.0:443 (existing gateway). Guest firewall permits only CT590 tcp/443,
and templates point at tunnel.192-168-68-90.sslip.io:443 with pinned CA.
A second stack on another port/address cannot accept those tunnels without
network changes or displacing the active gateway. Per scope, live create is
therefore skipped; continue with isolated fake-backend E2E. No VM created,
no stand or firewall changed.

## Integration review rulings

- OIDC `/v1/meta` keeps its previous JSON shape; absence of `authMode` means
  OIDC to older/new clients. Local metadata explicitly sets `authMode: none`.
- SDK discovery happens after the existing credential chain fails. A saved
  profile belonging to another explicit API URL remains a hard refusal before
  any network request (existing credential isolation invariant).
- Ingress overwrites X-Umiak-Client-IP and X-Forwarded-For from the socket.
  It validates the configured app Host. API validates API/app Hosts plus an
  explicit `UMIAK_LOCAL_ALLOWED_HOSTS` list, preventing DNS-rebinding reads.
- MCP uses a fixed private proxy address and forwards only its resolved client
  address. API trusts exactly ingress/MCP addresses plus explicitly configured
  external proxy CIDRs. Direct LAN ingress is the supported compose topology;
  putting an external proxy before ingress requires a separate trust design.
- Public tokenless GET/WebSocket accepts the same validated team query as web;
  conflicting header/query is rejected. This preserves nondefault-team PTY.
- MCP local mode has no OAuth challenge, including invalid keys; malformed
  Authorization never silently falls back to full local authority.

## Verification progress

Initial build passed. Initial lint required formatting new ingress/test files;
rerun passed (one pre-existing informational String.raw diagnostic).
Initial typecheck found a typo in a new API test fixture; fixed, rerun passed.
Initial sequential workspace tests found generated TS SDK metadata drift;
regenerated with `pnpm --filter @umiak/sdk gen`, full rerun in progress.

Local compose fake E2E passed: Playwright dashboard and admin without login,
CLI tokenless login -> create linux/2gb -> exec printf -> rm --yes, disallowed
CIDR returns 403 despite spoofed IP headers. Compose active services exclude
Keycloak/keycloak-db/oauth2-proxy. Local stack and its disposable DB removed.
First E2E attempt exposed an invalid numeric slug in the test; fixed the test
and reran successfully. No production VM was used.

Read-only whole-branch review found team-query and MCP malformed-header/challenge
issues; fixes included, final gates pending. Go build and vet passed for all
five modules. Module lint is being checked separately using its own config.

Additional image verification found the MCP runtime image needed the new
@umiak/auth source directory; Dockerfile corrected and API/MCP images rebuilt.
Local acceptance now includes remote MCP initialize through its built image.
External API trusted proxy CIDRs are appended to fixed private proxy addresses;
MCP has a separately configurable trusted proxy list in the local override.
The web ingress intentionally supports direct socket clients only.
