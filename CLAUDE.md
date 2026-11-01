# Project instructions

Self-hosted platform of API-driven VM sandboxes for AI agents on Proxmox VE. Architecture: `docs/architecture.md`. Scopes and status: `docs/roadmap.md`. Specs: `docs/specs/`.

## Toolchain

- Versions are pinned in `mise.toml` (Node, Go, pnpm, Bun, golangci-lint). Run tools through mise: the shell activates it in this repo; in non-interactive shells use `mise exec -- <cmd>`. Do not use system or nvm versions.
- Use the latest stable versions. Before adding a dependency or a tool, check the current latest (`npm view <pkg> version`, `go list -m -versions <module>`, GitHub releases) and use it. Do not copy versions from memory or old examples.
- When bumping a version in `mise.toml`, run `mise install` and keep the pins in sync:
  - `package.json`: `"packageManager": "pnpm@<version>"`, `"engines": { "node": ">=<version>" }`.
  - `go.mod`: `go 1.27` and `toolchain go<version>`.

## Repo layout

- TS (pnpm workspace, `pnpm-workspace.yaml`): `apps/<name>` for deployables and CLIs (api, worker, web, mcp, cli, bench), `packages/<name>` for libraries (pve, agent-client, ...). Each package extends `tsconfig.base.json`; tests with vitest; lint and format with biome (`pnpm lint`).
- Go (workspace `go.work`, one module per directory, module path `github.com/belov38/umiak/<dir>`): `services/<name>` for binaries (node-agent, guest-agent, gateway), `libs/<name>` for shared Go libraries (tunnel, ...). Add your module to `go.work` with `go work use`. Lint with golangci-lint.
- Protobuf: `proto/umiak/<area>/v1`, generated with buf.
- Specs: `docs/specs/sN-*.md`. Implementation plans: `docs/plans/sN-*.md`.
- Keep root files (`package.json`, `pnpm-workspace.yaml`, `go.work`, `biome.json`) minimal; parallel threads edit them, so add only your own entries.

## Git

- Only real code and `docs/` go to git. `research/`, `sdks/`, `vendor-repos/`, `scripts/` are local research material and stay gitignored.
- Remote: private `github.com/belov38/umiak`. Push your work.
- Never add a `Claude-Session:` trailer or a claude.ai session link to commit messages or PR descriptions.

## CI

- GitHub Actions workflows run only on manual dispatch (`workflow_dispatch`) during development. Do not add `push` or `pull_request` triggers.

## Conventions

- Talk to the user in Russian; code comments in English.
