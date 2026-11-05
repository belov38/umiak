> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# Umiak branding completion

Scope: Keycloak login branding, Payload graphics, dashboard access denials and
visible sandbox creators. No sandbox VM allocation or PVE changes.

## Implementation

- Keycloak 26.8.1: `umiak` inherits `keycloak.v2`; CSS replaces the stock header
  text visually with the outlined Inter lockup at 40 px. The header background
  stays dark in both stock modes, so both variants use white ink. Cobalt is
  PatternFly's primary variable. No copied FreeMarker templates.
- Compose mounts the theme and disables theme/template/static-resource caching
  for dev. Realm import selects `umiak`; existing dev realm updated via Admin API
  without touching its database. Operational instructions live with the theme.
- Payload's shared config refers to web graphics through import-map strings,
  preserving React-free use by API/worker. Logo uses fixed-colour surface variants;
  Icon masks the square mark with Payload's text colour. Lockup is also shown
  before nav links. Admin metadata uses the app icon and Umiak title suffix.
  Docker ships `apps/web/public` explicitly (Next standalone does not copy it).
- All Next access boundaries, including the operator override, share AccessPage.
  A layout effect restores appearance when Next replaces the document during an
  auth interrupt. The proxy's standalone HTML uses the same CSS and bootstrap.
  Both honour `umiak-theme`, falling back to the system preference.
- Sandbox Created cells show the existing creator description as a muted second
  line (`you`, named team key, teammate, or unknown).

## Verification

Unit regressions cover guard branding/theme support and Payload config mapping.
Playwright covers the Keycloak lockup during sign-in, dark Next/operator and
proxy refusals, admin icon and SVG HTTP responses, and visible creator text.

Live screenshots were kept outside git and are not part of the record.
The browser uses only `e2e@example.com`; temporary `umiak-operators` membership
is removed after the admin check. Real 401/403 guard and Next boundaries are
checked via an SSH tunnel and the public dashboard. No Ilia account changes.
The e2e user's dev sandbox list is empty; creator-row evidence comes from the
isolated compose E2E backend, which allocates no Proxmox VMs.

Final local checks: `pnpm build`, `pnpm typecheck`, `pnpm lint` (one existing
informational Biome diagnostic in `apps/mcp/test/windows-run.ts`), and web E2E
TypeScript checks pass. Unit tests: Payload 200/200, web 229/229. The existing
Payload config-reader TTL test flaked during parallel builds; the complete
package passes with one worker. No unrelated test changes were made.

Live Playwright: Keycloak 40 px lockup in light/dark modes; Payload lockup and
square icon in light/dark modes, including successful SVG responses; real
401/403 from guard, Next 401 without a subject, Next operator 403 after removing
the temporary group; persisted dark preference overrides system light.

Final `pnpm --filter @umiak/web test:e2e`: 21/21 passed against the rebuilt
compose images. Creator evidence: `e2e/sandboxes.png` under the evidence directory.
The full PNG manifest is `screenshots.txt` there (screenshots are not committed).
