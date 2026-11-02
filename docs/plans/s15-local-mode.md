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
