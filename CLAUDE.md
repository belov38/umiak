# Project instructions

Self-hosted platform of API-driven VM sandboxes for AI agents on Proxmox VE. Architecture: `docs/architecture.md`. Scopes and status: `docs/roadmap.md`. Specs: `docs/specs/`.

## Toolchain

- Versions are pinned in `mise.toml` (Node, Go, pnpm, Bun, golangci-lint). Run tools through mise: the shell activates it in this repo; in non-interactive shells use `mise exec -- <cmd>`. Do not use system or nvm versions.
- Use the latest stable versions. Before adding a dependency or a tool, check the current latest (`npm view <pkg> version`, `go list -m -versions <module>`, GitHub releases) and use it. Do not copy versions from memory or old examples.
- When bumping a version in `mise.toml`, run `mise install` and keep the pins in sync:
  - `package.json`: `"packageManager": "pnpm@<version>"`, `"engines": { "node": ">=<version>" }`.
  - `go.mod`: `go 1.27` and `toolchain go<version>`.

## Git

- Only real code and `docs/` go to git. `research/`, `sdks/`, `vendor-repos/`, `scripts/` are local research material and stay gitignored.
- Remote: private `github.com/belov38/boat-dev-clone`. Push your work.
- Never add a `Claude-Session:` trailer or a claude.ai session link to commit messages or PR descriptions.

## Conventions

- Talk to the user in Russian; code comments in English.
