> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# Dashboard UI consistency (2026-11-03)

## Decision and implementation plan

Keep the existing brand and semantic palette. Fix the contracts and composition,
not the meaning of outline. A global recolour would incorrectly promote every
secondary action; page-specific patches would leave the next feature unprotected.
Use shared UI primitives with a fast source-policy test and browser checks.

1. Inventory every rendering source, CSS exception and git origin. Capture the
   unchanged dashboard in an isolated loopback-only compose project.
2. Document hierarchy, accessibility and composition in `apps/web/UI.md`.
   Add shared page/panel/action/navigation and form primitives; migrate callers.
   Remove CSS selectors that duplicate these components. Preserve auth, forms,
   lifecycle confirmations and secret handling.
3. Enforce primitive use, token colours and square radii. Capture and assert the
   main pages in both themes, with stable component screenshots and CSS checks.
4. Run workspace build, lint, typecheck and tests sequentially; run OIDC and
   local Playwright against own stacks. Record failures and evidence honestly.
5. Commit logical changes and push `ui-consistency`; no merge or live deployment.

## Scope boundary

Setup, claim, pairing and owner sessions are served by
`deploy/compose/quickstart`, not Next or `apps/web/src`. Audit those sources and
record the integration debt. The explicit restriction on edits outside
`apps/web` and docs means their implementation cannot be migrated in this branch.

CA/TLS UI and guide content are excluded by the later user instruction; s16-fix4 removes them.
