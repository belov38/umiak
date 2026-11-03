# Dashboard UI investigation and verification — 2026-11-03

## Root cause and evidence

The blue primary token was present in both themes. Templates deliberately selected
`outline` for both Disable and Build/Rebuild. This was a composition failure,
not a missing blue token. Recolouring all outline buttons would promote Cancel,
filters and optional actions incorrectly.

- `d6be89d8` introduced TemplateList with outline at original lines 183 and 207,
  independent card markup and rounded classes. No common action-hierarchy
  guideline or page/card composition API existed.
- `922a287f` introduced the dashboard frame and feature CSS; `37368843` introduced
  the measured 72rem centred container, neutral outline style and extensive
  descendant selectors. S8 explicitly recorded the centred layout; the large
  desktop gap was an intentional reference-layout decision, now changed to
  left alignment in response to this task. It was not a Templates-only margin.
- `cfb552d3` introduced Setup and Owner sessions in the footer. Only
  `.dashboard-nav [data-slot="button"]` set left alignment and full width;
  the footer used Button's default centred alignment. This made location in the
  DOM, rather than component intent, determine the navigation style.
- `9971087f` added the onboarding links. They were already anchors, but only
  acquired underline on hover. They now look like links; Create a sandbox opens
  the actual create form, while install/agent steps retain guide anchors.
- `37368843`, `1c7e2539` and acceptance follow-ups introduced local form/layout
  exceptions. Raw controls, rounded classes and component-targeting CSS survived
  because tests checked behaviour and saved screenshots without enforcing
  primitive ownership, hierarchy or rendered theme properties.
- Quickstart owner pages were built in a separate HTML renderer, not ported
  wholesale into React: `5886dc8c` introduced owner claim/pairing; `ce326fa3`
  added the setup wizard, and `817dea47` shared the dashboard theme preference.
  Shared preference did not create a shared component or typography contract.

Git evidence is reproducible with `git log -- <path>` and
`git blame <base> -- <path>` at base `e673c0eb`. The two complete source inventories
are [before](ui-inventory-before.md) and [after](ui-inventory-after.md). They list
rendering sites, variants, class strings and CSS selectors, including forms,
links, badges, tables, navigation, cards, headers and feedback.

## Census and primitive decisions

Counts are occurrences in TSX outside `components/ui`, not numbers of files.

| Escape | Before | After |
|---|---:|---:|
| Raw button | 10 | 0 |
| Raw select | 9 | 0 |
| Raw input | 16 | 0 |
| Raw textarea | 6 | 0 |
| Hex literals outside UI | 7 | 0 |
| Hex literals in all TSX, including UI | 13 | 0 |
| rounded-sm/md/lg/xl family | 39 | 0 |
| Bare rounded | 12 | 0 |

The original 915-line stylesheet is reduced to 852 lines. Counting class-led
rules, including repeated/media rules, gives 133 → 117; counting unique leading
class names gives 44 → 36. These definitions differ from the request's 119-class
census. The inventories retain all selectors to make the count reviewable.
Layout-specific CSS remains for responsive tables/cards, drawer, forms and guide
TOC. No attempt was made to replace useful layout rules with an equally large
set of cosmetic wrapper components.

| Primitive | Decision |
|---|---|
| Button, links | Keep CVA variants; document hierarchy. Build/Rebuild and environment creation primary; Disable secondary. Use Button asChild for action links. |
| Input/textarea | Extend Input, add Textarea. Shared focus/disabled/invalid states; hidden file Input suppresses visible geometry. |
| Select | Keep Radix Select for existing menus; add NativeSelect for native form/toolbar semantics. Both consume field state. |
| Checkbox/radio | Add Checkbox/Radio with native semantics and existing token styling; circular native radio indicators remain conventional. |
| Labels/help/errors | FieldContext sends required/invalid/described-by state to actual controls, including nested NoteInput and Radix triggers. Required marks supported by Field. Existing composite create rows retain explicit accessible names. |
| Dialog/confirmation | Keep Radix Dialog, FormDialog, ConfirmButton and typed slug confirmation; square corners. Permissions/busy guards unchanged. |
| Dropdown/tooltip | Keep Radix keyboard/focus behaviour; remove radius and hard-coded disabled colours. |
| Toast | Existing MutationObserver already tracks root class; add rendered light/dark assertions. |
| Badge/status | Add success/warning variants, semantic ready/building/failed states; neutral stopped. Shared StatusDot owns the round status indicator. |
| Tables/lists/tabs | Keep shared Table/Tabs; preserve responsive data and PTY tab behaviour. Remove raw button escapes, retain semantic lists. |
| Code/copy | Add CodeBlock, migrate pre blocks; keep CopyButton/CopyLine and guide command copy. |
| Header/card/actions | Add PageHeader (including compact detail title), Panel and ActionBar; remove duplicated dashboard-card and action styles. |
| Empty/loading/error | Reuse EmptyState with owned geometry; add LoadingState with polite status; preserve QueryError and branded AccessPage boundaries. |
| Sidebar/mobile | Shared NavItem for navigation, footer and appearance; explicit aria-current=page styling. Existing modal drawer and skip-link remain. |
| Typography/spacing | Retain Inter, display font, logo, root scaling and spacing vocabulary; shared shell left-aligns 72rem work area. |

The guideline is [apps/web/UI.md](../../apps/web/UI.md). Brand cobalt is unchanged.
Tokens changed only for identified issues: input/outline boundaries now target
3:1; dark status hues are distinct; dark muted text has a real secondary level;
inline links use a readable dark token. Terminal canvas colours moved to tokens
and intentionally remain dark in both modes. The standalone proxy refusal HTML
in `lib/access-style.ts` retains its self-contained palette because it must render
without the Next stylesheet; static brand SVG assets are also outside TSX policy.

## Page-by-page disposition

- Sandboxes: PageHeader owns title/quota/action; onboarding anchors visible and
  correctly routed; responsive table/cards and row menu remain functional.
- Sandbox detail: compact PageHeader, ActionBar, primary Resume, existing Stop,
  Fork, Recover and delete confirmations; all Overview/Terminal/Commands/Files/
  Ports/SSH/Env/Desktop primitive escapes migrated. Terminal colours are tokens.
- Create: shared radios/input and header; hidden file input regression caught by
  the existing dialog overflow test and fixed in Input rather than a page patch.
- Snapshots: Panel and EmptyState; create/delete behaviour unchanged.
- Environments: primary create, shared selector and ghost selection controls,
  shared dialog/fields and confirmation; existing list/selected details preserved.
- API keys/settings/account/new team: Panel/PageHeader, shared choices/textareas,
  field feedback and existing owner/member permission/secret lifecycle intact.
- Templates: Panel/ActionBar; primary Build/Rebuild (or build instructions outside
  quickstart), secondary Enable/Disable, semantic status badges. Rebuild dialog
  and approval acknowledgement preserved; no VM build was started for UI checks.
- Getting started: shared header/code/copy, visible links and existing responsive
  TOC. **CA/TLS content and `content.ts` are unchanged**, per the later scope note.
- Operator: shared header, empty state, controls and error treatment; all
  authorization, block and destructive confirmation behaviour retained.
- 401/403: PageHeader within existing AccessPage; standalone proxy guard untouched.
- Setup/claim/pairing/owner sessions: audited in
  `deploy/compose/quickstart/{setup-ui,server}.mjs`. They have separate embedded
  styles (system font, 8/12px rounding, their own palette); claim/pairing inputs
  and Revoke buttons are raw HTML, and owner session revoke lacks the dashboard's
  confirmation component. These are **remaining external-renderer debt**: editing
  their implementation would violate the explicit apps/web/docs-only scope.
  Their dashboard entry points are fixed. CA rotation, TLS names, CA download/
  fingerprint instructions and `/owner/tls` are expressly excluded for s16-fix4.

## Regression prevention

`test/ui-policy.test.ts`: fast dependency-free lexical checks, including multiline
JSX, prohibit raw button/select/input/textarea and action-styled links outside
UI; prohibit hex in every source TSX; prohibit all radius classes including bare,
full, directional and arbitrary radii outside UI. Dedicated negative fixtures
prove the rule rejects representative escapes. It is part of normal web tests.
This is not an AST or a complete style analyser; it does not prove arbitrary
class expressions or stylesheet overrides safe.

`test/ui-field.test.tsx` verifies that error IDs/invalid state reach nested custom
textareas and Radix triggers. Vitest now includes TSX tests.

Playwright `12-ui-consistency` captures 17 main views/tabs in both themes plus
operator pages. It checks column origin/width, square geometry, active nav colour,
cobalt primary, text/control/focus token contrast and Sonner appearance sync.
Existing `09-dashboard` now captures both themes at every capture point and keeps
mobile overflow/focus/drawer checks. Local coverage adds all main single-owner
pages; a quickstart-mode fixture checks Build and footer NavItems without issuing
any build POST. Build metadata responses in that fixture are UI-only test data.
These are screenshot-producing visual tests with explicit style assertions,
not a claim of exhaustive WCAG certification or pixel-perfect snapshot diffs.

## Verification and evidence

Final results and persistent screenshot manifest are recorded below after the
last run. Raw early failed runs stay in the local working evidence directory
`/tmp/umiak-ui-R0UQg0`; only final selected evidence is delivered.

Final validation:

- `pnpm build`, `pnpm lint`, `pnpm typecheck`: pass, run in sequence through mise.
  The first build/typecheck attempt lacked several workspace links after a
  filtered install; full frozen-lockfile install resolved that without dependency
  changes. Final lint retains one pre-existing informational diagnostic in
  `apps/mcp/test/windows-run.ts` (no errors).
- `pnpm -r --workspace-concurrency=1 test`: pass, 4,547 Vitest tests, 8 skipped,
  plus 83 Python tests. After the final field/radius fixes the changed web package
  was rerun: **260/260**, including 5 UI-policy/field regression tests. Unchanged
  packages were not needlessly repeated. E2E TypeScript: pass.
- Clean isolated OIDC Playwright: **24/24** (23 existing + 1 new), `oidc-final.log`.
  Final visual recapture after correcting theme-state capture: **1/1**.
- Local Playwright in auth-none mode: **2/2**, `local-final.log`.
- Additional local quickstart-mode UI fixture: **1/1**, Build/Rebuild primary and
  Setup/Owner sessions NavItems verified. Baseline visual runs also pass.
- Existing mobile form check exposed a hidden-file-input width regression during
  migration; Input now keeps sr-only geometry. Review exposed missing bare-radius
  detection, a selector mismatch for aria-current=page and lost field attributes
  through composite controls; all were corrected and given regression coverage.

Persistent evidence (outside git):
`/Users/ib/.t3/userdata/ui-consistency-2026-11-03/`.

- `screenshots.txt`: every absolute PNG path (278 captures including supplementary
  desktop/tablet/mobile/form evidence and the two supplied live screenshots).
- `before/ui-{0..16}-{light,dark}.png` and
  `after/ui-{0..16}-{light,dark}.png`: main page/tab pairs.
  `view-map.json` maps index to view: 0 sandboxes, 1 snapshots, 2 environments,
  3 keys, 4 team settings, 5 account, 6 new team, 7 templates, 8 guide, 9 create,
  10–16 Overview/Terminal/Commands/Files/Ports/SSH/Env.
- `before/{templates,operator}-operator-{light,dark}.png` and matching `after/`:
  privileged views. Desktop stopped frame is in
  `{before,after}/sandbox-desktop-stopped-{light,dark}.png` (test-only capability
  override; no claim of a live TURN/video session).
- `before-local/{sandboxes,settings,templates,getting-started,keys,environments,snapshots,create}-{light,dark}.png`
  and matching `after-local/`: single-owner quickstart UI, including footer and
  actual blue Rebuild buttons. Capture uses real appearance-button handlers so
  the selected theme control matches the document theme.
- `logs/`: successful gate/test logs and visual baseline/recapture logs. No
  compose environment dump, generated secrets or private keys are delivered.
- `ilia-live-before-{templates,sandboxes}-dark.png`: copies of the user-provided
  originals; local captures are not presented as screenshots from CT 590.

Infrastructure isolation note: the first rendered Compose JSON retained explicit
old E2E network/volume names despite changing project name. That initial local
startup attached the existing E2E volume; it was detected, the new containers
were stopped, and explicit network/volume names were corrected. No existing
containers were stopped and no shared volume was removed. Final OIDC validation
used a fresh `umiak-ui-r0uqg0` volume/network; local validation used
`umiak-ui-local-r0uqg0`, its own volume/network/subnet and loopback-only ports.
Images and secret directories were also isolated. No remote deployment, Proxmox
mutation, CT 590 interaction or Ilia session access occurred.

## Remaining work

Independent acceptance and integration by the master. The external quickstart
HTML renderer still needs its own scoped component/style convergence work, except
for the CA/TLS pieces being removed by s16-fix4. This branch intentionally does
not modify anything outside apps/web and docs, does not merge main and does not
claim screenshots of external claim/pairing/session screens. The source rule is
lexical and the contrast checks cover semantic tokens, not every possible
composited colour or complete WCAG conformance.


## S16 UI follow-up — 2026-11-03

The external-renderer debt above is superseded by this follow-up. Bootstrap
claim/pair/approval/sessions/setup retain their pre-session server renderer but
share `deploy/compose/quickstart/ui.mjs`: it reads the actual dashboard tokens,
uses bundled Inter/Funnel fonts, the same square layout frame, persisted theme,
focus outlines and action hierarchy. Revoke/build/smoke require confirmation.
Keeping bootstrap rendering independent of Next preserves first claim during
startup; no auth/CSRF capability is moved to the browser.

Dashboard primitives now explicitly set solid focus outlines; NavItem owns its
selected appearance. NativeSelect/Input/Textarea size variants replace local
restyling. Checkbox owns its token border and checkmark. Globals contain no
`[data-slot]` overrides. Wrapping labels no longer need hard-coded ID pairs.
Environment names wrap at 390px; empty Sandboxes has one primary action; OIDC
Build instructions is secondary. Footer operator/admin/setup icons are distinct.
Policy checks cover CSS overrides, template literal radii, palette/arbitrary
colours, shadows and callback-bearing links while allowing anchors/prose.

Per-domain decisions: [dashboard](s16-ui-followup-ui.md),
[bootstrap pages](s16-ui-followup-quickstart-ui.md),
[security](s16-ui-followup-security.md).
Final gates and live evidence are recorded in [the S16 plan](s16-quickstart.md).
Screenshots (outside git): `/tmp/umiak-s16-evidence-HumwBq/{before,after,quickstart-before,quickstart-after}`.


## S16 final polish — 2026-11-03

The independent acceptance follow-up is implemented. Owner headings now match
400/2rem with dashboard tracking, navigation grouping/current-page state and
footer, brand divider and segmented icon appearance controls. Mobile navigation
collapses at the dashboard breakpoint; short desktop sidebars scroll. Setup uses
a square token progress bar with progressbar semantics. Dashboard appearance is
hidden until its persisted state is known. Terminal tabs, theme controls, inline
Buttons and warning Badges use primitive variants; Payload inline colours moved
to its host CSS without changing the host theme.

The policy scans all source CSS for every data-slot selector operator; JSX
arbitrary slot variants, local class bindings and cn/clsx/cva factories; inline
colour/background/border/shadow; variant shadows, dynamic radii and black/white
palette escapes. Quickstart classes/styles/CSS receive applicable checks. Fixtures
cover each reported escape and preserve prose such as Build: #123 and shadow copy.
The rule remains lexical rather than a complete semantic analyser.

Evidence and exact gates: [S16 polish](s16-polish.md). Screenshots are outside git
in `/tmp/umiak-s16-polish-9fDNWP/`: before/after owner pages and fresh baseline/
current dashboard captures, light/dark at 1440/390 px; forty side-by-side PNGs
in `comparisons/`, absolute manifest in `screenshots.txt`. Reviewed visually in
both themes/mobile. The baseline dashboard uses the previously accepted image;
all owner scenes and current dashboard use isolated test stores, not live users.
