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

Follow-up decision by Ilia (2026-11-02): replace CT590 with local mode, preserving
gateway :443 and its certificates/CA; retain one-command OIDC rollback.
Live checks use sequential sandbox VMs in 500–589: Linux 2 GiB from read-only
597, then Linux desktop 4 GiB from read-only 596. Total sandbox RAM cap is
8 GiB. Do not change firewall/SDN or rebuild templates. Remove every created
sandbox; leave CT590 healthy in none mode.

Follow-up: deny CIDRs win over allow, including node SNAT addresses and sandbox subnet.
Empty allowlist fails startup; default bind is loopback; Docker NAT requires host isolation.
