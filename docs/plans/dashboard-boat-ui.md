# Dashboard: boat.dev UI mapping

Reference inspected read-only in Ilia's logged-in Chrome on 2026-11-02.
Local evidence (never committed): `research/boat-dashboard/*.jpg`, DOM snapshots
`*.txt`; local stack captures and comparisons: `research/boat-dashboard/compare/`.
Sources: `CLAUDE.md`, `docs/roadmap.md`, S8 §9–10/§21, S7 resource summary
§6/§23, S10 §14.1, and the actual dashboard/API implementations.

## Scope and observed constraints

The account has one stopped sandbox (`research-a`) and no organization. Desktop
and Browser are disabled while stopped. No Resume, New (quick-create), Fork,
Create, save, reveal-secret, key issuance, or account changes were performed.
Advanced create opens a form without creating a VM and was inspected. Organization
members and running terminal/desktop states cannot be observed under the read-only
constraint. The reference theme setting was not changed; dark reference colors
are not verified. Do not claim pixel parity for these unobserved states.

## Feature mapping

| boat.dev page / element | Our implementation and source | Decision |
|---|---|---|
| Sidebar, selected item, organization selector | `AppShell`, team-scoped URLs, existing team switcher | Exists differently: sidebar, keep team vocabulary and permission checks |
| Product mark | Existing `sbx` wordmark | Keep our name; no boat artwork |
| Sandboxes, search, state filter | `SandboxList`, GET `/v1/sandboxes` | Exists: match frame, filters, table, primary action |
| Name / Subdomain, ID | Name / slug and public ID in detail | Exists differently: preserve slug semantics |
| Type | Template + size catalog | Exists differently: keep both genuine API fields |
| Snapshot filter, type filter | No corresponding current list query filters | Omit; retain supported label filter |
| Cost, Usage charges, billed-to text | No billing API or charge model | Omit everywhere |
| Stops in | Idle timeout / TTL in sandbox detail | Exists differently: keep separate semantics, no invented countdown |
| Live CPU/RAM/disk/IO charts and history processes | No metrics/history API matching boat | Omit charts/process history; keep Commands API |
| New / Advanced create | Real create page, templates/sizes/snapshot/environment/env/secrets/TTL | Exists differently: keep full form and API idempotency; do not make New one-click destructive |
| Share code, Monitoring off, Snapshots off, setup script | No corresponding create contract | Omit |
| Detail, rename, Stop/Resume/Fork/Recover/Delete | `SandboxHeader`, existing lifecycle handlers | Exists: restyle, preserve confirmations including Windows force-stop |
| Terminal | Existing PTY/xterm/WebSocket API | Exists differently: retain Terminal tab; reference running state unavailable |
| Desktop | Existing S10 desktop session/viewer API | Exists: capability-gated tab, no placeholder |
| Browser | No dedicated browser-view API | Omit |
| Prompt, AI usage | No agent credential/prompt/cost API | Omit |
| Files, ports, SSH, env | Existing S7 files/ports/ssh/env APIs | Keep actual functional tabs with shared visual treatment |
| Saved snapshots | GET/POST/DELETE `/v1/snapshots`, restore via create | Exists: Snapshots heading, Saved snapshots section |
| Automatic snapshot history / file browser / sharing | No matching public API | Omit |
| Environment | Named team environments, GET/POST/PATCH/DELETE `/v1/environments` | Exists differently: retain list of named environments, safe edit dialog |
| Environment versions / upgrade running sandboxes | No version/upgrade API | Omit |
| GitHub App permission flow, provider credentials, automatic boat credentials | S13 deferred; no credential integration API | Omit; preserve existing repository metadata fields, no claim that cloning is implemented |
| API keys | Team keys, GET/POST/rotate/DELETE `/v1/api-keys` | Exists differently: only owner mutates; never expose secret twice |
| Key scopes / expiration | Existing API scopes and presets | Keep actual scopes, not boat-specific permissions |
| Organization / members | Team settings with owner/member roles and Payload server actions | Exists differently: retain team, invitation, leave/delete rules |
| Account | JIT IdP profile, default team, SSH keys, sign-out | Exists differently: no alternate login providers or close-account flow |
| Light / Dark control | Existing theme tokens plus local appearance selection | Implement local preference, no account/DB change |
| Billing, plans, payment methods, included credits | Absent | Omit entire navigation and content |
| Alerts | No notification preferences API | Omit |
| Webhooks & OTel | No customer endpoint/exporter management API | Omit |
| Agents & Proxying | No provider credential/proxy API | Omit |
| CI on Boat VMs | No CI integration API | Omit |
| boat Docs / Support links | No corresponding sbx public destinations | Omit; do not send customers to boat support |
| Operator / Admin | Existing privileged routes | Retain operator-only access; Payload admin styling unchanged |

## Visual decisions

Reference at 90% browser zoom: 252 px sidebar, 1037 px main content, 43 px
controls. Implement at CSS scale: 280 px sidebar, 1152 px centered work area,
48 px controls, 40 px navigation rows, 32 px Funnel Display headings, Inter body,
white background, thin neutral borders, minimal corner radius, blue `#263fa9`
primary and selected text, selected fill `#f1f3f9`, muted text `#4d4d4d`.
Font packages are open-licensed Fontsource variable distributions (5.3.0; checked
with `npm view`), self-hosted by Next; lucide icons are already in the repo.
No boat logo, icon, image or font assets were copied.

At narrow widths the sidebar becomes a wrapping top navigation so every implemented
page remains reachable. Preserve existing route/query state, API calls, team roles,
JIT auth, secret handling and all confirmations. API and database schema unchanged.

## Verification

Run in order: `mise exec -- pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
Use `deploy/compose/e2e.yaml` over `compose.yaml` with `e2e.env`: real Postgres,
Keycloak/oauth2-proxy, Payload/Next and the test-only fake PVE/guest backend.
This is the repository-supported local stack for exercising sandboxes without
accessing the shared `pve` host. No production mocks or remote deployment.
`09-dashboard.spec.ts` additionally checks sidebar selection, absence of unsupported
navigation, persisted appearance and mobile overflow and captures the real pages.
