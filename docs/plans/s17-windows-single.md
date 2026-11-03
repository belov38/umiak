# Windows single implementation plan

Spec: `docs/specs/s17-windows-single.md`.

1. Catalog/API: add idempotent migration preserving exact legacy build references;
   canonicalize alias at API create/list/snapshot boundaries; test seeded/fresh
   migration, alias requests and legacy lifecycle.
2. Recipe/UI/docs: merge desktop files into windows, include desktop verification,
   present three choices with Windows ISO flow; update examples and roadmap.
3. Gateway: test startup HTML contract, implement self-contained branded light/dark
   loading page, preserve JSON/status/headers/HEAD and auto-refresh.
4. Verify: build, lint, typecheck, sequential workspace/Node tests, gateway
   build/vet/test/lint, Python, shellcheck, OIDC/local/quickstart Playwright.
5. Live: read-only inventory and operations check, inspect CT590/origin history,
   integrate main first, deploy preserving sessions; check catalog and alias with
   one 4GB sandbox only if RAM permits; delete only that sandbox with --yes.
6. Commit logical steps and push windows-single, never merge main. Record exact
   validation evidence and screenshot paths; report VM 598 remains reserved.
