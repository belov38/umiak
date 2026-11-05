> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S16 dashboard acceptance follow-up

## Rulings

- Focus outlines belong to primitives. Tailwind v4 needs an explicit solid outline
  style in addition to width/colour. Button (including NavItem), Input,
  SelectTrigger, NativeSelect, Textarea and TabsTrigger now set it.
- NavItem only adds muted text for its ghost variant. Selected appearance controls
  retain the secondary variant's cobalt/readable themed text and tinted background.
- NativeSelect and Textarea expose default/sm/xs sizes; Input exposes xs for dense
  terminal controls. Feature call sites select variants and retain only layout or
  content typography. All redundant feature rounded-none classes are removed.
- Checkbox and Radio own their styling, including focus. Checkbox boundaries use
  the input token (already checked at >=3:1 against both backgrounds). The check
  indicator remains native input state with a primitive-owned pseudo element.
- All globals.css data-slot overrides are removed. Drawer geometry lives in the
  DialogContent left placement. Mobile header behavior lives in PageHeader.
- Environment names wrap without enlarging the viewport; selection uses a Button
  variant. Empty Sandboxes keeps the header primary and onboarding text link.
  OIDC template instructions are secondary. Secret removal actions sit beside badges.
- Wrapped labels use native implicit association. Biome recognises the five
  shared control components via inputComponents; separate labels retain their IDs.
- The policy parser tracks JSX braces and quotes so callbacks do not truncate
  Link tags. Tests reject palette colours, arbitrary colours, shadows, radius at
  template endings and CSS primitive overrides, while allowing fragments/prose.
  The quickstart renderers are scanned for token/style escapes; native renderer
  controls are exempt from React-only component composition requirements.

## Verification

- Before fixes, new policy/focus regressions failed (two tests).
- Web Vitest: 274 tests passed after implementation; policy regression suite rerun
  after extending arbitrary-colour fixtures: 6/6 passed.
- Web TypeScript and E2E TypeScript passed. Scoped Biome checks passed.
- Playwright adds real Tab navigation in both themes for Button, Input,
  SelectTrigger and NavItem, mobile 390px with a 60-character name, checkbox
  boundary/indicator checks, and empty Sandboxes primary count. Existing
  09-dashboard captures now use the persisted real theme controls.
- Full build, OIDC/local/browser and screenshot results are recorded by the parent
  task in the S16 plan and UI consistency report. Do not infer their result from
  the local checks above.
