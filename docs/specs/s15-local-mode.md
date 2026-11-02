# S15: local single-user mode

Status: done-awaiting-acceptance. Decision: Ilia, 2026-11-02.

## Contract

`UMIAK_AUTH_MODE` is `oidc` by default; `none` selects a single fixed local
identity, owner of a personal team and platform operator. Invalid modes fail
startup. Existing OIDC authentication, authorization and infrastructure remain
the default. Team API keys retain their scopes and revocation semantics.

Anyone who reaches a local deployment from an allowed network controls its VMs.
This is an accepted product trade-off. `UMIAK_LOCAL_ALLOWED_CIDRS` defaults to
127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and fc00::/7.
Explicit empty or invalid configuration must fail closed. CIDR decisions use the
socket peer, or the existing trusted proxy resolution, never arbitrary client
headers. Apply this restriction before local authentication, including requests
with keys. Internal service authentication remains required.

API exposes `authMode` in `/v1/meta`, bypasses OIDC discovery in none mode,
logs a prominent startup warning and creates/reuses the fixed local identity.
Worker does not schedule Keycloak user synchronization in none mode.

Web `/app` and `/admin` work directly over HTTP without login or logout links.
A private ingress overwrites the client address header; the Next server must not
be published directly. Origin/CSRF checks remain active. HTTP cookies must not
use Secure or __Host- names. The local identity strategy supplies Payload admin
identity and platform operator privileges.

CLI login discovers meta before OAuth and saves a profile without credentials.
SDKs and stdio MCP accept tokenless profiles. Remote MCP applies the same network
restriction and omits OAuth challenges in none mode.

Token and public previews retain existing behavior. SSO previews are rejected
with HTTP 403 and a clear local-mode explanation: use token or public instead.
Guest tunnel TLS and pinned CA are retained; no image/template rebuild required.

## Deployment and verification

A separate compose override excludes Keycloak, its database initializer and
oauth2-proxy, removes their dependency edges, and exposes an HTTP local ingress.
All public ingress routes enforce the client allowlist. Backend web remains on
private Docker networks. API and MCP retain independent guards.

Acceptance: targeted unit tests, fake-backend local compose + Playwright + CLI
(create/exec/delete and disallowed client), existing OIDC Playwright suite,
sequential TS build/lint/typecheck/tests and all Go build/vet/test/lint.

Live pve check must not replace the OIDC stack. At most one 2 GiB sandbox in
500–589 from read-only template 597; total sandbox budget 8 GiB. No network or
firewall changes. If an independent tunnel cannot be reached, stop at fake E2E.
