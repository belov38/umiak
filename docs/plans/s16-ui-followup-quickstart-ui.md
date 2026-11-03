# S16 follow-up: standalone owner and setup design system

## Rulings

- Keep the bootstrap HTML renderer rather than move ownership entry points to
  Next. Claim must remain available before a session exists and when the web
  upstream is unavailable; forwarding it through the owner gate would couple
  recovery to that upstream. No security endpoints, credentials or Origin rules
  move. The accepted alternative is the same tokens and shared components.
- `deploy/compose/quickstart/ui.mjs` now owns the shared page/frame, navigation,
  button/input/textarea/select presentation, theme controls and focus. Both
  `server.mjs` owner pages and `setup-ui.mjs` consume it. It reads the actual
  dashboard `:root` and `.dark` token blocks rather than maintaining another
  palette. Inter and Funnel Display use the dashboard's pinned font packages,
  bundled at image build time; two fixed read-only font paths are public before
  claim. No arbitrary asset paths or upstream access are exposed.
- The same `umiak-theme` preference and root `dark` class restore before paint.
  Explicit Light/Dark controls persist changes and expose selection through
  `aria-pressed`. Both themes retain cobalt primary/white text, neutral auxiliary
  controls, semantic destructive text and solid two-pixel keyboard focus.
- Owner session Revoke asks for confirmation before issuing any request. Build
  and smoke explain their PVE side effects in confirmation. Generating the host
  command, validating media and copying are secondary actions. Setup has one
  expanded step at a time; each step's save remains its primary action.
- The layout uses the brand SVG, fixed 17.5rem sidebar, 72rem work-area maximum,
  Inter/Funnel typography, square corners, a mobile navigation frame, skip link
  and labelled claim field. Security behaviours remain in the owner ingress.

## Evidence

All captures use an isolated in-memory owner store, a synthetic CLI request and
empty setup fields. No real owner identity, approval, sandbox or Proxmox call is
used. Browser fixture: `apps/web/e2e/quickstart-ui.mjs`.

- Before: `/tmp/umiak-s16-evidence-HumwBq/quickstart-before/` (10 PNGs).
- After: `/tmp/umiak-s16-evidence-HumwBq/quickstart-after/` (11 PNGs).
- Both contain `claim`, `pair` (already-claimed anonymous guidance),
  `pair-approve`, `sessions`, `setup`, each in `light` and `dark`.
- After also contains `setup-mobile.png`, viewport 390px. The desktop viewport
  is 1440×1000. The baseline loads source archived from `b2d8b74a`.
- After fixture verifies real theme controls, persistence after reload, loaded
  Inter, keyboard outlines through nine actual Tab stops per page/theme,
  cancellation of session revocation, and no setup overflow at 390px.
- Node server/setup UI regression tests: 18/18 before new shared-renderer tests;
  new shared-renderer tests: 3/3. Baseline and final browser fixture: 1/1 each.
