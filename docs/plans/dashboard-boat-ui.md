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
constraint. The reference theme setting was not changed; iteration 2 reads dark colors from
CSSOM without toggling it. Do not claim screenshot parity for unobserved states.

## Feature mapping

| boat.dev page / element | Our implementation and source | Decision |
|---|---|---|
| Sidebar, selected item, organization selector | `AppShell`, team-scoped URLs, existing team switcher | Exists differently: sidebar, keep team vocabulary and permission checks |
| Product mark | Existing `Umiak` wordmark | Keep our name; no boat artwork |
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
| boat Docs / Support links | No corresponding umiak public destinations | Omit; do not send customers to boat support |
| Operator / Admin | Existing privileged routes | Retain operator-only access; Payload admin styling unchanged |

## Visual decisions

Reference measured at 252 px sidebar, 1037 px main content, 43 px controls.
Implement with 90% root rem scale: 17.5rem sidebar, 72rem centered work area,
3rem controls, 2.5rem navigation rows, 2rem Funnel Display headings, Inter body,
white background, thin neutral borders, minimal corner radius, blue `#263fa9`
primary and selected text, selected fill `#f1f3f9`, muted text `#4d4d4d`.
Font packages are open-licensed Fontsource variable distributions (5.3.0; checked
with `npm view`), self-hosted by Next; lucide icons are already in the repo.
No boat logo, icon, image or font assets were copied.

At narrow widths the sidebar becomes a modal navigation drawer with a fixed mobile
header and team selector, matching the measured reference breakpoint. Preserve existing route/query state, API calls, team roles,
JIT auth, secret handling and all confirmations. API and database schema unchanged.

## Verification

Run in order: `mise exec -- pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
Use `deploy/compose/e2e.yaml` over `compose.yaml` with `e2e.env`: real Postgres,
Keycloak/oauth2-proxy, Payload/Next and the test-only fake PVE/guest backend.
This is the repository-supported local stack for exercising sandboxes without
accessing the shared `pve` host. No production mocks or remote deployment.
`09-dashboard.spec.ts` additionally checks sidebar selection, absence of unsupported
navigation, persisted appearance and mobile overflow and captures the real pages.

### First-pass validation (2026-11-02; superseded below)

- Workspace build, Biome lint and TypeScript checks passed; E2E TypeScript also passed.
- Full local compose Playwright suite: **20/20 passed**, including Keycloak/JIT,
  team switching and roles, API key revocation, secret response audit, files,
  commands, ports and operator authorization.
- Additional visual-only run: **1/1 passed**. Captures include supported sandbox
  tabs, empty list, create form, snapshots, environment and key dialogs, account,
  team settings/new team, light/dark and mobile. Animations are disabled during
  captures so theme transition frames are not mistaken for final colors.
- Fixed a tablet regression discovered by E2E: the taller detail summary pushed
  xterm outside the viewport after reload at 800×600. Compact tablet facts keep
  terminal rendering and scrollback checks working (onboarding passes again).
- Eight side-by-side PNG comparisons and a contact sheet are local in `compare/`.
  API differences explain the intentionally different content and forms; exact
  pixel parity is not asserted for account/provider controls, team organization
  settings, the create page versus original dialog, or unobservable running views.
- Local compose test containers and volumes are removed by the test runner.
  Shared Proxmox and CT 590 were not used. No API/schema changes.

## Iteration 2: measured component parity

The second pass replaces first-pass estimates with CSSOM/computed measurements.
Local, ignored evidence: `research/boat-dashboard/styles/` (JSON, DOM, JPG, notes).
There are 200 resolved custom properties, 78 root declarations and 34 dark
declarations, including palette, typography, spacing, radii, shadows and motion.
Computed measurements cover controls, menus, tables, cards, tabs, forms and layout;
responsive rules and hover/state declarations are saved separately. Original `html` is 90% and zoom is 1, so rem scaling is not browser zoom.

Observed stack: Tailwind v4 + Radix primitives + a custom semantic theme/component
layer. A stock shadcn preset is not confirmed (no data-slot markers); SPA module
entry is consistent with Vite but does not prove the bundler. Our implementation
keeps radix-nova/shadcn components and translates measured values independently.
No original CSS/JS/font/icon/image asset is vendored. IBM Plex Mono is now loaded
from Fontsource as well (5.3.0, npm registry checked before adding).

Measured targets: 17.5rem sidebar, centered 72rem content, p2rem/p1rem mobile;
sidebar breakpoint 1024, table/cards breakpoint 1400, control breakpoint 768;
zero radius/shadows/blur; H1 400 2rem/1.1 Funnel Display with -0.02em tracking; Inter 1rem/1.4 controls, 18px icons,
.875rem/1.4 secondary text, section headings 500 1rem/1.4. Dark background #060606,
foreground #fefefe, border #2e2e2e, selected #0f1634, focus #929fd3; primary #263fa9
in both themes. Dark CSSOM was read without changing the account's preference.

Structural corrections:

- Sandboxes: measured table anatomy/order, public ID with copy, compact open/menu
  actions; Stop/Resume moved into the menu. Real mobile cards replace horizontal
  table scrolling. Existing search/state/label API filters remain.
- Detail: compact title/subdomain/ID, ghost action bar with independent icons,
  separate destructive action, five-column facts, measured underline tabs and
  bordered overview/workspace frames. Auth, lifecycle and Windows confirmations
  are unchanged.
- Snapshots: measured card heading/description and centered empty state using our
  own archive illustration; only saved snapshots, no automatic history section.
- Environment: selected named environment, selector/action toolbar and flat detail
  sections. Version rollout, credential/provider integrations remain omitted.
- API keys: creation form is inline in the team card (matching original placement),
  preset rows use selected tint, own scopes and expiry retained. The secret still
  appears once in a dialog. Owners/members keep existing permissions.
- Account/Team: full-width bordered sections with measured heading scale/padding.
  Only IdP profile/default team/SSH keys and actual team management are present.
- Create: real accessible dialog over the actual sandbox list, with our own fields,
  idempotency/error handling and scrollable body. URL remains directly linkable.

Remaining differences are explicit product/content differences: team key presets
and IdP fields, extra S7 lifecycle/env/files/ports controls, UUID-like public IDs,
no billing or unsupported automation, our product mark and own empty illustration.
Terminal/Desktop content differs by implementation; their original running frames
cannot be observed on the stopped read-only account. Toast geometry is not claimed
as sampled: no toast can be induced without a prohibited mutation. Shared tokens
are applied to our toast. No API/database changes or pve/CT590 access.

The visual E2E saves computed styles alongside same-viewport PNGs. Its isolated
compose test backend seeds a real `base` environment via API and captures both
ready/stopped details, plus empty state, forms, light/dark, mobile and workspace
frames. These test-only records do not enter production code.


### Per-page differences retained in iteration 2

| Page | Remaining difference and reason |
|---|---|
| Sandboxes | Own slug/public IDs, size/template and Health/Activity data; supported label filter replaces absent snapshot/type queries. Billing/countdown columns are omitted. |
| Sandbox detail | Actual lifecycle actions and S7 tabs/facts; no metrics/process history API, Browser or AI controls. Original running Terminal/Desktop cannot be inspected read-only; shared measured frame is used. |
| Snapshots | Only saved snapshots; no automatic history API. Independent Lucide archive empty illustration replaces branded boat artwork. |
| Environment | Named environment selector and actual env/secrets/files/repositories; no provider integrations, versions or rollout API. |
| API keys | Team ownership, our presets/scopes and numeric expiry; original account keys/restricted-environment feature has no equivalent. |
| Account | Keycloak profile, default team and SSH keys; no extra login providers, privacy/monitoring toggles or close-account API. |
| Team | Real name/quota/member controls, rather than the original account's empty Organization creation form. |
| Create dialog | Our template/snapshot/size/env/secret/TTL fields; no unsupported sharing, monitoring, setup-script or auto-snapshot controls. |
| Dark/mobile | Dark tokens verified without changing original preference; own dark screenshots and matching responsive layouts captured. No original dark screenshot is claimed. |

Original toasts cannot be sampled without mutation. Local compose has no TURN
service, so Desktop verification covers the stopped capability/frame with a
**test-only response override**; it does not claim a live video session. Terminal
runs a real PTY through the test backend. No production mocked records were added.

Test adaptations preserve role/secret audits. The xterm reader scrolls its real
viewport into view before inspecting DOM rows (xterm suspends off-screen painting).
Browser pages unload before the response-audit drain to prevent a late Next prefetch
from being disposed during context teardown. Mobile checks exercise close, theme
synchronization and navigation. The drawer uses a separate left placement instead
of inheriting the centered Dialog's translation utilities.

### Iteration 2 validation

- Sequential workspace build, Biome lint, typecheck and test pass; 4,463 Vitest
  assertions and 81 Python tests. E2E TypeScript also passes.
- Full local compose Playwright suite: 20/20 pass, including the visual/navigation
  case, role/JIT/team switching, lifecycle, files, PTY and secret-response auditing.
- After the final 18px icon / -0.02em H1 tracking adjustments, workspace build,
  lint, typecheck and E2E typecheck pass again; the fresh compose visual run is
  1/1 green. Updated PNG/JSON evidence includes these final measured values.
- Comparisons in `research/boat-dashboard/compare/iteration-2/`: eight desktop
  pairs, overlays and difference images, `metrics.json`, `contact-sheet.png`, and
  800×600 / 390×844 responsive pairs/diffs. Both sides use zoom 1 and the same
  viewport; comparisons crop/pad, never stretch one side to conceal differences.
- All eight desktop inner containers measure exactly 1036.8px wide; their x-position
  differs by less than 0.01px (browser layout rounding). Headings use the measured
  font size/weight/line-height and tracking. Raw pixel differences include the
  deliberately different content/branding/features and are not a parity score.
- Reference account remains read-only, theme unchanged, viewport restored and tab
  left open. No API/schema changes, production mocks, remote deploy or PVE access.


## Acceptance fixes (iteration 2)

- Reproduced the create-dialog clipping with a failing Playwright check: inner
  scrollWidth exceeded clientWidth by 90px at the desktop viewport. Grid tracks,
  descendants and selects now shrink; key/value rows share available width.
- All environments remain visible/selectable, and the created ID becomes selected.
  Sidebar/drawer skip navigation, active Operator and blocked Resume explanations
  are restored. Copy SSH reports success; health/activity remain in laptop cards.
- Theme bootstrap runs before paint; Sonner observes the root theme. Warning and
  success colors use semantic light/dark tokens throughout customer/operator views.
- Mobile regression checks cover detail, account, keys, environments, team and
  create, plus internal create-dialog width at 1900px and 390px. Test evidence goes
  to Playwright outputPath by default, optionally UMIAK_VISUAL_DIR.
- Refined brand/divider, list cards/date/actions, detail title/tabs/single frames,
  inline key fields/presets/intro and environment icon actions. S8 sections 9.3,
  9.4 and 9.8 now describe the actual UI. No rename, API or DB changes.

Acceptance validation: sequential workspace build/lint/typecheck/test are green
(4,463 Vitest tests and 81 Python tests); E2E typecheck is green. Fresh local
compose Playwright: **21/21**, including the new acceptance regression case.
It verifies create dialog inner width at 1900/390, all six mobile page widths,
new environment selection and visible list entries, and degraded/activity laptop
cards. Appearance checks cover pre-hydration theme initialization, toaster theme,
Copy SSH feedback, drawer bounds and mobile skip-link focus. Containers/volumes
are removed after the run. A first reused-stack attempt hit the existing fake
RAM-cap reset on re-bootstrap; the final validation uses a clean local stack.
