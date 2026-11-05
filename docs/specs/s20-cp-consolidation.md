# S20: control-plane image consolidation

Approved by the coordinator, 2026-11-04: option A.

## Intent and scope

Reduce first-install downloads and repeated dependency installation without merging
process trust boundaries. Publish only `umiak-quickstart` (shared CP runtime) and
`umiak-web` (Next standalone and Payload migrations). Postgres remains upstream.
The quickstart name and `/app/quickstart-assets/umiak-node-linux-amd64` extraction
contract remain stable. No live-host actions, database migrations or installer
host-policy changes belong to this stage; 0600–0699 remain reserved for S19.

## Alternatives and decision

A (chosen): shared CP image, separate API, worker, MCP, owner ingress, gateway,
web-meta and renewal processes. Merge gateway initialization and secret generation
into one offline job. Keep web separate. Image consolidation alone saves no V8
heaps and should not be advertised as a runtime RAM reduction.

B: additionally embed MCP in API. Saves one V8 runtime but exposes API memory and
secrets to the MCP process and couples shutdown, OOM and event-loop load. Rejected.
C: include Next in the universal image. Little runtime benefit, larger artifacts
for every role and coupled web releases. Rejected.

## Build and runtime contracts

- One shared Node dependency graph installs production closures for API, worker,
  MCP, template-builder and DB; CLI and proto/agent-client compilation are build
  stages. No build tools or dev dependencies are copied into the runtime.
- Use explicit source COPY allowlists, never `COPY . .`. Ship template recipes,
  trusted viewer/license/fonts, CLI and agent assets required by S18. Keep pinned
  mise-compatible versions; no new application dependencies.
- Shared image defaults to owner ingress through the existing credential wrapper.
  Every other role supplies its entrypoint/command explicitly. MCP and web-meta
  must bypass that wrapper and run without database or service secrets.
- One root, network-disabled secrets-init job runs gateway initialization first,
  then the existing idempotent bootstrap. Preserve volumes, generated keys, CA,
  owner IDs and secret subpaths. Do not mount bootstrap's union of secrets into
  ingress. Gateway retains root wrapper → UID65532 execution and RO key mounts.
- Keep web-meta secretless, read-only and GET /v1/meta only. Keep gateway-renewal
  root, offline and scoped to its existing writable key volume.
- Preserve owner ingress published ports, fixed trusted proxy addresses, control
  and web-internal networks, web isolation, readiness and shutdown contracts.
- Root compose uses two pinned published image names; contributor override builds
  those same two Dockerfiles once each. All supported control-plane services use this owner deployment.
- Release remains workflow_dispatch only; bundle tests expect exactly two Umiak
  image names. Installer changes are limited to image/stack-file contracts.

## Acceptance

TDD covers rendered compose role commands and isolation, release/bundle image set,
and real repeated offline bootstrap preserving CA and secrets. Run pnpm build,
lint, typecheck, tests; Go gates in CI workflows; installer pytest and shell tests;
compose smoke with an isolated local project; inspect image content/role startup.
Measure unique compressed layer union for built linux/amd64 images against GHCR
0.1.0 (1304.7 MiB excluding postgres), and record smoke container RAM with platform
and workload limits. Do not turn estimates into measured performance claims.
A fresh independent acceptance reviewer receives this spec and the final diff.
Push the branch and report; merge requires coordinator confirmation.
