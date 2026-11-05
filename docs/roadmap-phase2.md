> Historical backlog: Keycloak, oauth2-proxy and OIDC deployments were removed on 2026-11-05. Only the installer-managed homelab owner deployment is supported; older comparisons below are historical.

# Phase 2 roadmap: parity with boat.dev and beyond

Status: draft v0.1, 2026-10-29. For the master session: an inventory of boat's capabilities, reconciliation with the S1–S13 plan, the areas S14+ for brainstorm, MVP recommendations. There is no implementation and no brainstorm with Ilia here.

Sources (local, not in git):
- `docs:` — `research/boat-docs/pages/` (213 pages, index `llms.txt`);
- `cli:` — `research/boat-cli-help/` (help of 120 commands) and `docs:cli-reference.md`;
- `sdk:` — `sdks/` (OpenAPI `boat-v1.yaml`, 121 operations; TS/Python SDKs, helpers `boat_helpers.py`, `boat-helpers.ts`);
- `vr:` — `vendor-repos/` (skills, the kimi plugin, optibox, boat-convex, harbor-box, eve-box, battleships, agent-server-release).

Our plan: `docs/architecture.md`, `docs/roadmap.md`, the specifications S1, S2, S3, S4, S6. S5 and S7 are being written in other threads, their scope is taken from the roadmap; where I write "S7", it is an expectation, not a fact from a specification.

A known debt for the warm pool (S30): with two or more nodes `retryClaim` (`apps/worker/src/ops/claim.ts`) holds the node lock of the rejected machine and calls `admitCold`, so a `40P01` deadlock is possible (S6 acceptance, round 2). Fix before enabling `ctl-pool`.

Update 2026-10-29: the recommendations R1–R11 were incorporated into the MVP specifications. MVP authentication is now on Keycloak: `umiak login` through the device flow, people without long-lived keys, team keys `umiak_`, SSH certificates (S7 §7, §11.3; S4 §9; S8 §20.1). So K6, K8, SH1, and S24 are partly closed in the MVP, and the S24 rule "a child key is no wider than the parent" loses its meaning. The remainder is clarified at the S24 brainstorm.

## 0. In brief

- Boat has about 200 separate capabilities. The MVP (S1–S13) covers the core: lifecycle, fork, saved snapshots, exec/files/ports, SSH, the desktop, keys, MCP. In many places the core is already stronger than boat (§3).
- The main gaps are the **layer on top of the VM**: built-in coding agents (prompt/steer/events), a credentials proxy, environments with versions, skills and plugins for agents, webhooks/OTel, command history outside the VM, CI runners, adapters for eval frameworks.
- I propose 17 areas **S14–S30** (§4). The first wave (P1): S21 skills/plugins, S24 keys v2, S22 CLI/SDK v2, S14 environments, S16 credentials proxy, S15 coding agents.
- 11 recommendations for the MVP (§6). The most important: the JSON/JSONL contract of the CLI and the delete confirmation header (S7), a minimal environment entity (needed by S13), env on fork and resume (S6), the key scope model "action × resource" (S8), coding agents and tools in the template (S5), a single slug format (S4/S6).

## 1. Notation

| Mark | Meaning |
|---|---|
| ✅ | Covered by the plan (the area and section are given) |
| ✅* | Within the scope of an area that has no specification yet (S5, S7, S8, S9, S10, S11): an expectation from the roadmap or `docs/architecture.md` |
| ◐ | Partly: a primitive or part exists, more work is needed |
| ✗ | Not in the plan |
| ⊘ | Skipped: commerce, boat legacy, or inapplicable to our architecture (the reason is in the row) |

The "Decision" column: where the item goes (S14+ or "MVP rec." — see §6) and whether an internal platform needs it. Priorities: P1 — the first wave after the MVP, P2 — the second, P3 — on request.

## 2. Inventory of boat's capabilities and coverage

### 2.1 Lifecycle, sizes, OS

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| L1 | Create: `type`, `name`, `labels`, `env`, `ttlSeconds`, `from` (saved snapshot) | `docs:concepts.md`, `docs:api/reference/sandboxes/create-sandbox.md` | S6 §7.3, S7 | ✅ | — |
| L2 | States `provisioning…ready/idle/running…archived/error`; `idle/running` = whether the agent's prompt is running | `docs:concepts.md` | S6 §6.1; `activity busy/idle` is a separate field | ◐ | The "agent is working" state — S15 |
| L3 | Stop with a final snapshot; stop refused if the snapshot fails, `force`, auto-force after 3 days | `docs:snapshots/stop.md`, `docs:api/reference/sandboxes/stop-and-archive-sandbox.md` | S6 §7.5: OS shutdown, disks stay on the node; a hard stop on timeout | ✅ | A different mechanism: no final snapshot is needed |
| L4 | The hook `~/.boat/pre-stop` (60 s), Docker containers are stopped for 30 s each | `docs:snapshots/stop.md` | S6 §7.5 `PrepareStop`; a graceful OS shutdown itself stops systemd units and Docker | ◐ | A user hook — S30 (cheap) |
| L5 | Resume with the same id on a new machine | `docs:snapshots/resume-and-fork.md` | S6 §7.6 (the same VM on the same node) | ✅ | — |
| L6 | A resume during `stopping` takes the same machine; the machine is held for 10 min after stop | `docs:readiness.md`, `docs:snapshots/stop.md` | Not needed: disks and the VM stay on the node | ⊘ | A consequence of boat's remote snapshots |
| L7 | Fork, including of a running sandbox (from a one-minute snapshot, loses up to 1 min of writes) | `docs:snapshots/resume-and-fork.md` | S6 §7.7: a snapshot with quiesce, an exact copy | ✅ | Better than boat |
| L8 | Size change: `resume --type`, `fork --type`, `type_too_small` | `docs:machines/change-size.md` | S6 §7.6 step `resize` (CPU/RAM); no disk growth | ◐ | Disk by size — S30 |
| L9 | `recover`: a power cycle, no more often than every 10 min; boat refuses a healthy sandbox (`409 sandbox_is_reachable`) | `docs:troubleshooting.md`, `docs:api/reference/sandboxes/recover-sandbox.md` | S6 §7.8 (allowed on a healthy `ready` too) | ✅ | Refusing a healthy one — optional, S7 |
| L10 | Auto-rebuild of an `error` sandbox on a new machine from the latest snapshot | `docs:troubleshooting.md` | No: disks are local | ✗ | With a PBS archive — S18/S12, P3 |
| L11 | Asynchronous delete with an operation `bdop_…`, stages `waiting_for_uploads`, `retrying` | `docs:data-retention/delete.md`, `docs:api/reference/account/get-deletion-operation.md` | The S6 `delete` operation; the public status — S7 | ◐ | S7 (operation status) |
| L12 | `Idempotency-Key` on create and fork, 24 h, `idempotency_in_progress`, `idempotency_key_reused` | `docs:limits.md`, `docs:recipes/parallel-agents.md` | S6 §5.7, §14.1 | ✅ | Add resume — S30, P3 |
| L13 | `failFast`: only from the warm pool, a response in ≈1.5 s or `503 no_ready_machine`, nothing is created; works with `from`, fork, resume too | `docs:machines/fail-fast.md`, `sdk:openapi/boat-v1.yaml` | No; a create from a snapshot is always cold for us (S6 §7.3) | ✗ | MVP rec. R2 (for templates); a warm pool for a saved snapshot — S30 |
| L14 | `count` 1–1000 on create from a snapshot, all or nothing | `docs:api/reference/sandboxes/create-sandbox.md`, `cli:new.txt` | No | ✗ | S30 (evals), P2 |
| L15 | List filters: `state`, `namePrefix`, `label=k=v`, `stoppedBefore`, `dataExpired`, cursor | `docs:api/reference/sandboxes/list-sandboxes.md` | S6 labels, `ListFilter`; the form — S7 | ◐ | S7 |
| L16 | Renaming the subdomain (`PATCH subdomain`, 3–40 characters, not ending in `-desktop` and `-<number>`) | `docs:hosting.md`, `docs:api/reference/sandboxes/update-sandbox.md` | S4 §4.2: the slug grammar is the same, generation and rename — S7; S6 §5.6 describes the slug differently (10 characters `[a-z0-9]`) | ◐ | S7; the slug format — MVP rec. R10 |
| L17 | Sizes `small…xlarge`, `GET /limits.machineTypes` with the reason for unavailability | `docs:machines.md` | Sizes in Payload (S8), S6 quotas §8.5 | ◐ | `/limits` — MVP rec. R9 |
| L18 | A 512 MiB reserve for platform services, OOM → exit 137, `oomKilled` | `docs:troubleshooting.md`, `vr:agent-server-release/install.sh` (`MemoryMin=512M`) | S3 §9.1 `reason: OOM`; §17.2 `MemoryMin=64M` only for the agent | ◐ | The size of the reserve (agent + S15 runner + S10 streamer) — S5/S15 |
| L19 | `--setup-file` on a sandbox: once after ready, `setupStatus`/`setupError` | `docs:setup.md` | No | ✗ | S14, P1 |
| L20 | A repository setup script on every create/resume/fork, `setupBlocking`, logs in `/tmp/routine-logs/` | `docs:setup.md` | S13 (clone at claim), the script is not described | ◐ | S13/S14 |
| L21 | A command during start waits up to 60 s, then `409 sandbox_starting`; `sandbox_restoring` is retryable | `docs:readiness.md` | Architecture §4: waiting for the agent up to 30 s, `503 agent_unavailable retryable` | ◐ | S7 |
| L22 | Lazy disk restore, `hydrated`, progress, `playbook.json` prefetch | `docs:readiness.md` | Not needed: LVM-thin is local | ⊘ | Return to it with PBS live-restore (S18) |
| L23 | Deduplication against the base image: only the difference is stored | `docs:readiness.md` | Thin snapshots share blocks with the template (architecture §5) | ✅ | — |
| L24 | `/dev/kvm` in all sandboxes (QEMU, Firecracker, the Android emulator) | `docs:machines/virtualization.md` | S1 §4.6: `cpu host`; no guarantee | ◐ | MVP rec. R6 |
| L25 | A preinstalled set: Node/bun/deno/pnpm, Python+uv, Go, Rust, JVM, Ruby, PHP, .NET, R, GCC/Clang, Docker+Compose, gh, rg, jq, Chrome, ffmpeg, xdotool | `docs:machines/tools.md` | S5 (brainstorm in progress) | ◐ | MVP rec. R5 |
| L26 | Preinstalled coding agents (`claude`, `codex`, `opencode`, `pi`, `kimi`, `vibe`, …), updated when the machine is prepared | `docs:machines/tools.md` | No | ✗ | MVP rec. R5, S15 |
| L27 | The user `user` with sudo, systemd, Docker without sudo | `docs:machines.md` | S3 §4, S5 | ✅ | — |
| L28 | Always-on services: a systemd unit + no auto-stop | `docs:long-running-tasks/always-on-services.md` | S6 §12: TTL `null` by default, idle-stop is turned off with `null` | ✅ | — |
| L29 | One Ubuntu 24.04 image, no custom images | `docs:machines.md`, `docs:faq.md` | 4 templates, including Windows | ✅ | Better than boat; custom images — S28 |
| L30 | `degraded` on loss of connectivity, an email on a hang; after 3 days without an answer boat itself stops the sandbox | `docs:faq.md`, `docs:troubleshooting.md` | S6 §11.1 health; `degraded` is never stopped automatically; no notifications | ◐ | Notifications — S20; auto-stop of a hung one — decide in S30 |
| L32 | `GET /me`: the current user and the login method | `docs:api/reference/account/get-current-boat-user.md` | Architecture §9 `/me` | ✅* | S7 |
| L31 | A Hetzner reserve when capacity is short, shared vCPUs | `docs:machines/virtualization.md` | Capacity and admission S6 §8 | ⊘ | Specifics of their fleet |

### 2.2 Auto-stop and TTL

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| T1 | TTL: 1 h by default, maximum 30 d, `null` = off, the field `archiveAfter` | `docs:long-running-tasks/auto-stop.md` | S6 §12: TTL `null` by default, idle-stop 900 s | ✅ | — |
| T2 | `extend`: deadline = now + TTL | `cli:extend.txt` | S6 §7.8 | ✅ | — |
| T3 | A running agent prompt extends the TTL | `docs:long-running-tasks/auto-stop.md` | Idle-stop accounts for commands and PTYs | ◐ | A prompt as activity — S15 |
| T4 | A fork does not inherit "no auto-stop" | `docs:long-running-tasks/auto-stop.md` | S6 §7.7: the TTL is not inherited | ✅ | — |
| T5 | There is no idle timer (platforms build their own) | `docs:faq.md`, `vr:optibox/docs/redesign.md` | S6 §12 idle-stop by real activity | ✅ | Better than boat |
| T6 | Wake-up on request (boat has none) | `vr:battleships/research/cards/boat.json` | S4 §17, S6 §21: phase 2 | ✗ | S30, P2 |

### 2.3 Snapshots

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| SN1 | An auto-snapshot every minute and at stop, incremental | `docs:snapshots.md` | S6 §5.5: `kind auto` is reserved | ✗ | S18, P2 (protection from disk loss, rollback) |
| SN2 | Stopped ones kept 14 d, an email on day 11, `snapshot_data_expired` | `docs:snapshots/stop.md`, `docs:data-retention.md` | S6 §15.4 `stoppedRetentionDays` (off) | ◐ | S25 |
| SN3 | A saved snapshot: save, `new --from`, replacement by name, indefinite | `docs:snapshots/templates.md`, `docs:api/reference/snapshots/save-saved-snapshot.md` | S6 §7.8 | ✅ | — |
| SN4 | Team images: the owner is the org, on deploy by a colleague logins, SSH keys, and secret files are scrubbed | `docs:snapshots/templates.md` | S6 §5.5 `team_id` ✅; no scrubbing (secrets are in tmpfs, but logins in `~` will get in) | ◐ | S23 |
| SN5 | Share codes `bsh_…` between accounts (256 bits, the hash is stored, a counter, revocation) | `docs:snapshots/templates.md`, `docs:api/reference/snapshots/create-snapshot-share.md` | No | ✗ | S23, P3 (between teams) |
| SN6 | List, `latest`, a file tree, reading a file or a directory tar from a snapshot without a VM; `snapshot pull` | `docs:snapshots/download-and-delete.md`, `docs:api/reference/snapshots/get-snapshot-tree.md`, `cli:snapshot.pull.txt` | No | ✗ | S18, P2 (useful for a stopped sandbox too) |
| SN7 | A full snapshot export (signed chunks) | `docs:api/reference/snapshots/get-snapshot-download.md` | No | ✗ | S18, P3 (qcow2/raw export) |
| SN8 | Deleting one, all auto-snapshots, saved | `docs:data-retention/delete.md` | Saved ✅ (S6 §7.8); no auto | ◐ | S18 |
| SN9 | Rollback to a point in time (boat has none: only the latest snapshot) | `docs:snapshots/resume-and-fork.md` | No | ✗ | S18 (better than boat) |
| SN10 | What is saved: `/home`, changes to system directories, Docker volumes and images | `docs:snapshots/whats-saved.md` | A block snapshot of the whole disk | ✅ | Better than boat |
| SN11 | `.boatignore` | `docs:snapshots/whats-saved.md` | Inapplicable: block snapshots | ⊘ | — |
| SN12 | Emails at disk 85% and 95%, automatic cache cleanup | `docs:troubleshooting.md` | S3 §13 `Metrics` gives disk fill; `disk.low` (S3 §10) is only for the agent's log retention | ✗ | Notifications — S20, metrics — S19 |
| SN13 | A memory snapshot, hibernation (boat has none) | `vr:battleships/research/cards/boat.json` | No | ✗ | S30, P3 |

### 2.4 Environments, secrets, repositories

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| E1 | Named environments, `base`, default, soft delete | `docs:environments.md`, `docs:environments/manage.md` | `research/07` (a Payload collection "environments and secrets"), S13 "repositories in an environment"; no specification | ◐ | MVP rec. R3; S14 |
| E2 | Immutable versions, a sandbox is pinned to a version, `upgrade` (hot delivery, wiping revoked secrets) | `docs:environments/versions.md` | The S3 primitives `UpdateEnv`/`UpdateSecrets` | ◐ | S14, P1 |
| E3 | Environment variables and secret files; env per sandbox (≤100, 64 KB, reserved names) | `docs:environments/secrets.md` | S6 §13.1 (env and secretFiles per sandbox, AES-GCM) | ◐ | The environment level — S14 |
| E4 | The switches `passGithub`, `passSecrets`, `passSandboxCredentials`, `passAgentsCredentials` | `docs:environments/access.md` | No | ✗ | S14 |
| E5 | `safeForThirdParties` and `--no-env` with snapshot scrubbing (`sandbox_securing`), the field `effective` | `docs:environments/access.md`, `docs:security.md` | No | ✗ | S14 (untrusted code, contractors) |
| E6 | Repositories: a clone into `/home/user/<repo>`, a branch, a list of GitHub App installations | `docs:environments/repositories.md` | S13 | ◐ | S13 |
| E7 | Private registries: npm, pip, uv, Docker via a var + a secret file | `docs:environments/private-registries.md` | S13 | ◐ | S13 |
| E8 | Organization environments, restricting access for members | `docs:environments/manage.md`, `cli:env.access.txt` | No | ✗ | S14/S23 |
| E9 | `credentialProfileId`, `proxyAiCredentials` on an environment | `docs:environments/access.md` | No | ✗ | S16 |
| E11 | Overrides on fork and resume: `env` (replaces the inherited one), `environment` (rebinding to a version), `noEnv`, `type`, `ttlSeconds` | `sdk:openapi/boat-v1.yaml` (`ResumeRequest`, the fork body), `cli:fork.txt`, `cli:resume.txt`, `docs:environments/secrets.md` | S6 §7.7: fork accepts `name, labels, ttlSeconds, size`, env is inherited; §7.6: resume — `size` and TTL | ◐ | MVP rec. R11 (env and secretFiles); `environment` — S14 |
| E10 | Legacy `/secrets`, `/repos` (replace everything at once) | `docs:api/reference/account/update-boat-secrets-setup.md` | — | ⊘ | Boat legacy |

### 2.5 Commands, processes, history

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| C1 | Sync exec: timeout 1–600 s (30 by default), up to 8 MiB per stream, `timedOut`, `oomKilled` | `docs:long-running-tasks/background-commands.md`, `docs:api/reference/agent/execute-sandbox-command.md` | S3 §9.1 (`timeout_ms`, `reason: TIMEOUT/OOM`); the limits and the form of the sync response — S7 | ◐ | S7 |
| C2 | Stream NDJSON `started/stdout/stderr/exit/error` | the same | S2 §9.1, S3 §9.1 `Run` | ✅ | — |
| C3 | Detached + status by offset + attach NDJSON (heartbeat 15 s, `reconnect` after 10 min) | `docs:api/reference/agent/attach-command.md` | S2 §9, S3 §10 | ✅ | — |
| C4 | Kill: SIGTERM to the group, SIGKILL after 5 s | `docs:api/reference/agent/stop-command.md` | S3 §9.5 `Kill(grace_ms)` | ✅ | — |
| C5 | Env and user per command (boat has none) | `vr:harbor-box/sdks/harbor_box_environment.py` | S3 §9.1 `CommandSpec.env`, `user` | ✅ | Better than boat |
| C6 | Command history 90 d, reading output by offset while the sandbox is stopped | `docs:long-running-tasks/command-history.md`, `docs:api/reference/agent/read-command-logs.md` | S6 §5.8 metadata 90 d; output only in the VM (S3 §10, 7 d) | ◐ | S19, P2 (architecture §12: phase 2) |
| C7 | Capturing the output of all processes (tty, pipe, journal), 64 KiB/s, 72 h | `docs:long-running-tasks/command-history.md` | No | ✗ | S19, P3 |
| C8 | `ps`: the top 12 processes every 30 s, kept 7 d, available while stopped | `docs:api/reference/agent/list-sandbox-processes.md`, `cli:ps.txt` | S3 §13 `Metrics` (only the process count) | ◐ | S19 |
| C9 | Processes survive an agent restart, status `lost`, `409 agent_outdated` | `docs:long-running-tasks/background-commands.md` | S3 §9.3 shim, output is kept | ✅ | Better than boat |
| C10 | An output limit of 10 MiB/h per account | `docs:limits.md` | S3 §10 retention by volume | ✅ | A different mechanism |
| C11 | A web terminal (PTY) in the API (boat has SSH only) | — | S3 §9.4, architecture §2 (xterm.js in the dashboard) | ✅ | Better than boat |

### 2.6 Files

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| F1 | Read/write JSON up to 5 MiB, utf8/base64 | `docs:api/reference/agent/read-sandbox-file.md` | S3 §11.2 streamed `/files` of any size, `Range`, resumption | ✅ | Better than boat |
| F2 | delete, list, info, mkdir, move, chmod | `docs:api/reference/agent/*-sandbox-file*.md` | S3 §11.4 | ✅ | — |
| F3 | Search by glob, grep, replacement across several files | `docs:api/reference/agent/search-sandbox-files.md`, `find-in-sandbox-files.md`, `replace-in-sandbox-files.md` | No (done via exec) | ✗ | S22, P3 |
| F4 | Signed upload and download URLs (served by the sandbox itself, without authorization, 15 min–1 h) | `docs:ssh-access.md`, `docs:api/reference/agent/create-upload-url.md` | No | ✗ | S22, P2 (browser, third-party systems) |
| F5 | Artifacts: raw bytes up to 50 MiB | `docs:api/reference/agent/download-sandbox-artifact.md` | S3 `/files` | ✅ | — |
| F6 | Paths only under `/home/user` and `/tmp` | `docs:ssh-access.md` | S3 §11.1: any absolute paths | ✅ | Better than boat (evals) |
| F7 | Uploading and downloading a directory as one tar (boat only in the CLI `push`/`pull`) | `cli:push.txt`, `vr:harbor-box/README.md` | S3 §11.4: "later" | ✗ | MVP rec. R7 |
| F8 | Directory watching | — | S3 §11.4: "later" | ✗ | S22, P3 |

### 2.7 Public URLs, ports, network

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| N1 | `host <port>` → `https://<sub>-<port>.on.boat.dev`, a token by default, `public`, idempotent, up to 50 ports | `docs:hosting.md`, `docs:api/reference/agent/expose-a-port.md` | S4 §8, S6 §5.8 (`token`/`sso`/`public`) | ✅ | The `sso` mode is better than boat |
| N2 | The `--localhost` relay for services on 127.0.0.1/::1 | `docs:hosting/how-it-works.md` | S3 §12: CONNECT itself tries loopback and addresses | ✅ | Without a flag |
| N3 | `host` inside the VM: `host url` waits for a route, `list`, `hide`; the token `ASCII_TOKEN` only for own ports | `docs:hosting/host-cli.md` | No | ✗ | S22 (in-VM CLI) + S24 (sandbox token), P1 |
| N4 | `?_token=` → redirect + cookie; `Cookie: _port_auth` for API clients | `docs:hosting.md` | S4 §8.2–8.3 | ✅ | — |
| N5 | Port token rotation (in boat only via public→private) | `docs:hosting.md` | S6 §14.1 `rotatePortToken` | ✅ | Better than boat |
| N6 | The URL survives stop/resume | `docs:hosting.md` | S6 §5.8 `hosted_ports` | ✅ | — |
| N7 | Custom domains (boat has none either) | `docs:hosting.md` | S4 §17 "later" | ✗ | S17, P3 |
| N8 | Raw TCP/UDP ports through a public IP and `ufw` | `docs:hosting/firewall.md` | No public IPs (decision 5 in `research/07`) | ✗ | S17: TCP through the gateway, P3 |
| N9 | A firewall inside the VM; blocking the tunnel → `degraded` + webhook | `docs:hosting/firewall.md` | The tunnel is outbound (S2), health S6 §11 | ◐ | Webhook — S20 |
| N10 | An egress allowlist, network policies (boat has none, no API) | `docs:faq.md`, `vr:battleships` | S1 §4.4: a static LAN ban; there are no per-sandbox policies | ◐ | S17 (better than boat), P2 |
| N11 | A static egress IP, a private network between sandboxes (boat has none) | `vr:battleships/research/cards/boat.json` | No | ✗ | S17, P3 |
| N12 | The Vite `allowedHosts` hint | `docs:hosting/how-it-works.md` | S4 §7.5 | ✅ | — |
| N13 | A public IPv6 for each sandbox | `docs:machines.md` | Decision 5: no public IPs | ⊘ | Deliberate |

### 2.8 SSH, editors, copying

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| SH1 | `ssh` with a key from the CLI, the host key via the API without TOFU; the host key changes on every resume | `docs:ssh-access.md`, `docs:api/reference/agent/configure-sandbox-ssh-key.md` | S4 §9: the SSH gateway, a permanent gateway host key, user keys from S8 | ✅ | Better than boat |
| SH2 | `POST /sshkey` adds a key to `authorized_keys` | the same | Keys in the user profile (S8), CA certificates (S4) | ✅ | A different mechanism |
| SH3 | `forward` local and reverse, reconnecting | `cli:forward.txt` | S4 §9.4 (`-L`, `-R`) | ◐ | A CLI wrapper — S22 |
| SH4 | `scp` (tar-over-SSH), `push` (git-aware) | `cli:scp.txt`, `cli:push.txt` | S4 SSH (scp/sftp work) | ◐ | S22 |
| SH5 | VS Code / Cursor: a script writes `~/.ssh/boat/<id>.conf` | `docs:ssh-access/editors.md` | Works through S4 | ◐ | `umiak ssh-config` — S22 |
| SH6 | A reverse tunnel to a local MCP or Ollama | `docs:integrated-agents/customize.md` | S4 §9.4 `-R` | ✅ | — |

### 2.9 Desktop, browser, recording, computer use

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| D1 | Moonlight WebRTC 1080p60, a URL with the token in the fragment, open within 10 min, iframe, `overlay=0`, `theme` | `docs:desktop-streaming.md`, `docs:desktop-streaming/urls-and-security.md` | S10; architecture §8 (a URL with a short token, iframe) | ✅* | The token in the fragment and the 10 min window — take into S10 |
| D2 | noVNC (`vnc=1`, `publicAccess`) | `docs:api/reference/agent/get-desktop-streaming-url.md` | No | ✗ | S29, P3 (a fallback without WebRTC) |
| D3 | Browser only: Chrome without a frame, Chrome profiles | `docs:desktop-streaming/browser-only.md`, `cli:browser.txt` | No | ✗ | S29, P2 |
| D4 | Recording the desktop to mp4 | `docs:desktop-streaming/drive-and-record.md` | No | ✗ | S29, P2 (demos, reviewing an agent's work) |
| D5 | The MCP `computer` (cua-driver) registered in all harnesses | `docs:integrated-agents/computer-use.md` | S10 cua-driver; registration in harnesses is absent | ◐ | S15 |
| D6 | Computer-use via the HTTP API (boat only through a harness) | — | S10 §13 (MVP) | ✓ | — |
| D7 | Wallpapers, clipboard | `docs:desktop-streaming/background.md` | S10 (clipboard — per moonlight-web's capabilities) | ◐ | S29, P3 |
| D8 | `lux` (desktop automation with demo recording) | `vr:cloud-sandbox-vm-skills/skills/computer-use-browser-desktop/SKILL.md` | — | ⊘ | A proprietary tool; our way is S15 + cua |
| D9 | An anti-bot Chromium (bypassing CAPTCHA and detection) | `vr:battleships/research/cards/boat.json` | — | ⊘ | Not needed by an internal platform |
| D10 | A Windows desktop (boat has none) | — | S9, S10 | ✅* | Better than boat |

### 2.10 Windows applications

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| W1 | Wine staging, winetricks, installer recipes, 25 verified applications | `docs:windows-apps.md`, `docs:windows-apps/*` | Real Windows guests (S9) | ⊘ | Not needed: there is a `windows` template |
| W2 | An agent installs applications, saved snapshot, fork | `docs:windows-apps/agents-and-forks.md` | S9 + saved snapshot (S6) | ✅* | The skill `windows-sandbox` — S21 |

### 2.11 Built-in coding agents

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| A1 | 7 harnesses: Claude Code, Codex, pi, OpenCode, Prime, Kimi, Mistral Vibe; regular binaries on PATH | `docs:integrated-agents/harnesses-and-models.md` | Architecture §1: not in phase 1 | ✗ | S15, P1 |
| A2 | `POST /prompt`: `provider`, `model`, `reasoningEffort`, `fast`, `new`/`conversationId`, attachments in `~/attachments` (up to 12 files, 25 MB each, 64 MB total) | `docs:api/reference/agent/prompt-sandbox-agent.md`, `docs:limits.md` | — | ✗ | S15 |
| A3 | Prompt run status: `queued → running → finished/interrupted/failed` | `docs:integrated-agents/conversations.md` | — | ✗ | S15 |
| A4 | Events: cursor poll, ETag/304, types `prompt`, `response` (`is_streaming`, `tools`), `steer`, `usage_limit`, `compaction_complete` | `docs:api/reference/agent/list-sandbox-events.md`, `sdk:openapi/boat-v1.yaml` (the last two types) | — | ✗ | S15 (better: a stream and real deltas) |
| A5 | Parallel conversations, a "current" one per shell, a RAM-based limit, a queue, they survive stop and fork | `docs:integrated-agents/conversations.md` | — | ✗ | S15 |
| A6 | Steer with a delivery guarantee: `native`, `native-continued`, `fallback`, `late`; `409 no_running_turn` | `docs:integrated-agents/steering.md` | — | ✗ | S15 |
| A7 | Interrupt one or all conversations | `docs:api/reference/agent/interrupt-running-agent-work.md` | — | ✗ | S15 |
| A8 | Switching the harness mid-conversation (a frozen transcript) | `docs:integrated-agents/conversations.md` | — | ✗ | S15, P3 |
| A9 | A model catalog `GET /provider-models` (reasoning levels, `fastMode`) | `docs:integrated-agents/harnesses-and-models.md` | — | ✗ | S15 |
| A10 | Configuration: rule files, MCP, skills, hooks for each harness | `docs:integrated-agents/customize.md` | — | ✗ | S15 + S14 (bake in via an environment) |
| A11 | A short system prompt and the `boat` skill in the sandbox | `docs:integrated-agents.md`, `docs:ai-tools.md` | — | ✗ | S15/S21 |
| A12 | Subscriptions (Claude Pro/Max, ChatGPT, Kimi, Mistral, Grok) with server-side token refresh | `docs:integrated-agents/keys.md` | — | ✗ | S16 |

### 2.12 AI credentials and proxy

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| AI1 | Credential profiles: named, default, `copyFrom`, an organization profile, `access` | `docs:ai-credentials.md`, `docs:api/reference/ai-credentials/*` | Architecture §1: not in phase 1 | ✗ | S16, P1 |
| AI2 | Provider keys (Anthropic, OpenAI, OpenRouter, DeepSeek, Moonshot, Mistral, xAI, …), Bedrock | `docs:integrated-agents/keys.md` | — | ✗ | S16 |
| AI3 | Several accounts per credential, switching on the fly | `docs:api/reference/ai-credentials/switch-credential-account.md` | — | ✗ | S16, P3 |
| AI4 | Custom API: any HTTPS secret, in the sandbox `NAME` and `NAME_BASE_URL` (a placeholder when proxied) | `docs:api/reference/ai-credentials/set-custom-api.md` | — | ✗ | S16 (the company's internal APIs) |
| AI5 | Proxy: placeholders on every start, the key goes only into a header, binding to the provider's host, server-side refresh | `docs:ai-credentials.md` | — | ✗ | S16 |
| AI6 | Accounting: requests, errors, tokens by day, credential, models, sandbox | `docs:api/reference/ai-credentials/get-ai-usage.md` | — | ✗ | S16 |
| AI7 | Blocking a sandbox's AI access | `docs:api/reference/ai-credentials/block-or-unblock-sandbox-ai-access.md` | — | ✗ | S16 |
| AI8 | An organization may mandate the proxy ("no real keys") | `docs:ai-credentials.md` | — | ✗ | S16 |
| AI9 | A "do it yourself" spend limit (poll usage + block) | `docs:ai-credentials.md` | — | ✗ | S16: a built-in budget (better than boat) |
| AI10 | Proxy price $1/day + $1/1000 requests | `docs:ai-credentials.md` | — | ⊘ | Commerce |

### 2.13 Organizations and shared access

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| O1 | Org: create, invite, roles owner/admin/member, transfer, delete | `docs:organizations.md`, `cli:org.*.txt` | S8: teams and roles from IdP groups | ◐ | Invitations are not needed: members come from the IdP |
| O2 | The active org, `--org`, the header `X-Boat-Org` | `docs:organizations/active-wallet.md` | S8 (a user in several teams) | ◐ | S23 |
| O3 | Shared/private sandbox, access `owner/use/view`, auto-private on the creator's logins | `docs:organizations/shared-sandboxes.md` | No | ✗ | S23, P2 |
| O4 | `share`/`unshare` with irreversible scrubbing of logins | `docs:api/reference/sandboxes/share-sandbox.md` | No | ✗ | S23 |
| O5 | Default visibility for new sandboxes | `docs:api/reference/account/update-organization.md` | No | ✗ | S23 |
| O6 | Per-member limits (concurrency, time) | `docs:organizations/seats-and-limits.md` | S6 §8.5 per-team quotas | ◐ | S23 (per user) |
| O7 | Seats, moving a personal plan into an org (`org migrate`), `org status` (the active wallet) | `docs:organizations/move-personal-plan.md`, `cli:org.migrate.txt`, `cli:org.status.txt` | — | ⊘ | Commerce |

### 2.14 API keys and login

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| K1 | A bearer key with a prefix | `docs:api-keys.md` | S8, architecture §10–11 | ✅* | — |
| K2 | Actions (`sandbox.create/read/update/stop/resume/fork/delete/delete-own`, `exec`, `file.read/write`, `ssh`, `desktop`, `host`, `agent.prompt`, `snapshot.*`, `environment.*`, `account.*`) and the presets `read-only`, `full-sandbox`, `ci`, `admin` | `docs:api-keys/scopes.md` | Architecture §11 "keys with scopes", the list is not set | ◐ | MVP rec. R4 |
| K3 | Restricting a key to a list of sandboxes and environments; a one-sandbox key for an end user | `docs:api-keys/scopes.md`, `docs:security.md` | No | ✗ | MVP rec. R4 (the model), S24 |
| K4 | Lifetime: 90 d by default, maximum 365 d, `never`; a child key is no wider than its parent | `docs:api-keys/create-and-list.md` | Not set | ◐ | MVP rec. R4 |
| K5 | Rotate, revoke, usage (requests over 30 d, created resources) | `docs:api-keys/store-rotate-revoke.md`, `cli:api-key.usage.txt` | Revoke — S8 | ◐ | S24 |
| K6 | Sensitive operations only from a browser session (rotate, revoke, ZDR) | `docs:account.md` | No | ✗ | S24 |
| K7 | A sandbox key inside the VM (only its own sandbox) + a token only for its own ports | `docs:api-keys/create-and-list.md`, `docs:environments/access.md` | No | ✗ | MVP rec. R4 (the key type), S24 |
| K8 | `login --key-stdin`, browser login, `logout` (revoking the device session) | `cli:login.txt`, `cli:logout.txt` | S8 `umiak login` | ◐ | `--key-stdin`, `logout` — S22 |
| K9 | Agent self-registration (`auth.md`, RFC 9728/8414, a claim code by a human), `WWW-Authenticate resource_metadata` | `docs:agent-auth.md` | No | ✗ | S24: a device flow with SSO confirmation, P3 |
| K10 | GitHub/Google/email/AgentID logins, linking, closing the account | `docs:account.md` | The IdP through oauth2-proxy | ⊘ | Accounts are managed by the IdP |

### 2.15 Outbound events and observability

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| EV1 | Webhooks: 6 events, HMAC `v1=` over `delivery.timestamp.body`, 8 attempts, an outbox in the same transaction, rotate, a delivery log, up to 10 endpoints per account | `docs:webhooks.md`, `docs:api/reference/account/create-webhook.md` | S6 §5.6 `sandbox_events` (outbox), webhooks — phase 2 | ◐ | S20, P2 |
| EV2 | OTLP export: sandbox metrics (CPU, RAM, disk, PSI) every 60 s and lifecycle events as logs; a test on save, SSRF protection | `docs:opentelemetry.md` | S12 — the platform's own metrics, no per-team export | ✗ | S20 |
| EV3 | Usage per sandbox: seconds weighted by size, `include=cost` | `docs:api/reference/sandboxes/get-sandbox-usage.md` | No | ✗ | S20 (showback without money) |
| EV4 | Emails: disk, stop failure, retention expiry | `docs:troubleshooting.md` | No | ✗ | S20 (email/Slack) |
| EV5 | An audit log (boat has none) | `vr:battleships/research/cards/boat.json` | S6 `sandbox_events` 90 d | ◐ | S20 (better than boat) |
| EV6 | `GET /limits`: remaining starts, quotas, allowed sizes with a reason | `docs:api/reference/account/get-boat-limits.md` | S6 §8.5 quotas | ◐ | MVP rec. R9 |
| EV7 | The headers `RateLimit-Policy`, `RateLimit`; a limit of starts per minute/hour/day | `docs:limits.md` | S4 §11 gateway limits | ◐ | S7/S12, P3 |
| EV8 | A status page, measured uptime 99.95% (not an SLA) | `docs:compliance.md` | — | ⊘ | S12 operations |

### 2.16 Data retention and deletion

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| DR1 | Periods: stopped 14 d, history 90 d / 72 h, a closed account 30 d | `docs:data-retention.md` | S6 §15.4 (commands 90 d, events 90 d, tombstones 30 d) | ◐ | S25 |
| DR2 | ZDR: deleting data on every stop, only from the browser, a confirmation phrase | `docs:data-retention/zero-data-retention.md` | No | ✗ | S25, P3 |
| DR3 | `snapshots:false` (stop = delete), `monitoring:false` | `docs:data-retention/snapshots-and-monitoring-off.md` | No | ✗ | S25 (ephemeral sandboxes for CI and evals — P2) |
| DR4 | The header `X-Ascii-Confirm-Delete: <id>` on deletes | `docs:data-retention/delete.md` | No | ✗ | MVP rec. R1 |
| DR5 | Closing an account, GDPR | `docs:data-retention/close-account.md` | — | ⊘ | Offboarding — through the IdP and S8 |

### 2.17 CI

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| CI1 | GitHub Actions `runs-on: boat`, labels by size, `/from=<snapshot>`, `/debug` (30 min after a failure), refusing public repos, up to 6 h, 4 GB swap | `docs:ci.md` | No | ✗ | S26, P2/P3 |
| CI2 | API and CLI: overview, repositories, a job, logs `--follow` | `docs:ci.md`, `cli:ci.*.txt` | No | ✗ | S26 |
| CI3 | The CLI in any CI: a static binary, `--key-stdin`, `new --json`, `exec --timeout 0`, `run --push` | `docs:ci.md` | The CLI — S7 | ◐ | S22 |
| CI4 | The "Out of memory" annotation in a run | `docs:ci.md` | No | ✗ | S26 |

### 2.18 Evals, RL, integrations

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| I1 | The evals pattern: a snapshot per task, an idempotent create, backoff on 429/503, fork for branching | `docs:evals.md` | The primitives exist (S6) | ◐ | A guide and a skill — S21/S27 |
| I2 | A Harbor adapter `BaseEnvironment` (refuses Docker images, network policies, GPU) | `docs:integrations/harbor.md`, `vr:harbor-box` | No | ✗ | S27, P3 |
| I3 | An Eve adapter (`spawn` emulated via files) | `docs:integrations/eve.md`, `vr:eve-box` | No | ✗ | S27, P3 |
| I4 | A Convex component | `vr:boat-convex` | — | ⊘ | Convex is not used in the company (to be clarified) |
| I5 | optibox: a consumer chat with a fast shared answer while the VM starts | `vr:optibox`, `docs:platform-guide/patterns.md` | — | ⊘ | A consumer product; lessons taken into S15 |
| I6 | The guide "a platform for your own users": `--no-env`, a tenant tag, a daemon in the VM + `host --private`, estimating the number of sandboxes | `docs:platform-guide.md`, `docs:platform-guide/*`, `docs:security.md` | — | ✗ | The skill `umiak-platform` — S21 |
| I7 | battleships: a comparison of 366 providers, 78 attributes | `vr:battleships` | — | ⊘ | A source of attributes for §3 |
| I8 | The agent server in the VM: systemd, `CPUWeight/IOWeight/MemoryMin=512M`, `/health`, inbound port 8911 | `vr:agent-server-release/install.sh` | S3 §17.2 (`CPUWeight/IOWeight` the same, `MemoryMin=64M`), the tunnel is outbound | ✅ | Memory reserve — see L18 |

### 2.19 SDK

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| SDK1 | TS and Python generation from OpenAPI | `docs:sdks/overview.md` | S7 (roadmap), architecture §2 | ✅* | — |
| SDK2 | 14 helpers: `waitUntilReady/Idle`, `waitForDesktop`, `waitForPrompt(Done)`, `streamEvents`, `streamPrompt`, `stopAndRemove`, `readText`, `writeText`, `execCommand` (retry only when `retryable`), `streamCommand`, `followCommand` (no gaps by offset), `runCommand` | `sdk:python/src/.../boat_helpers.py`, `sdk:typescript/src/package/src/boat-helpers.ts` | No | ✗ | S22 (part — MVP rec. R1) |
| SDK3 | HTTP/2 fetch in TS (one session per origin) | `sdk:typescript/src/package/src/http2-fetch.ts` | No | ✗ | S22, P3 |
| SDK4 | Flat parameters in TS, `AbortSignal` | `sdk:typescript/src/package/src/runtime.ts` | — | ✗ | S7/S22 |
| SDK5 | Python is synchronous only | `docs:sdks/python.md` | — | ✗ | S22: an async client (better than boat) |
| SDK6 | Helpers for uploading and downloading binary files (boat has none) | — | — | ✗ | S22 |

### 2.20 CLI

All boat commands (`cli:*.txt`). The base CLI is S7. Subcommands of domain areas go together with them.

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| CL1 | Global flags `--api-url`, `--org`, `--json`, `--no-update`; env `BOAT_API_URL`, `BOAT_ORG` | `cli:boat.txt`, `docs:cli-reference.md` | S7 | ◐ | S7 |
| CL2 | JSON automatically when stdout is not a TTY; JSONL for `new`, `prompt`, `events`, `conversations` (and `fork --wait`); an error is the last line `{"event":"error",…}`; the command's exit code, 124 on timeout | `docs:cli-reference.md` | Not set | ✗ | MVP rec. R1 |
| CL3 | `current` (the last sandbox in this shell), `self` (inside the VM), the current conversation per shell | `docs:cli-reference.md` | No | ✗ | MVP rec. R1 (`current`), S22 |
| CL4 | `new`: `--file PATH=LOCAL`, `--host PORT[:public]`, `--setup-file`, `--count`, `--fail-fast`, `--visibility` | `cli:new.txt` | S7 partly | ◐ | S14/S22/S30 |
| CL5 | `list --filter rspte`, `info`, `rename`, `extend`, `stop --status`, `resume` with a no-op exec check, `fork --wait`, `delete` with operation tracking | `cli:list.txt` etc. | S7 | ◐ | S7/S22 |
| CL6 | `exec`: `--timeout 0` = detach + attach with reconnecting, `--stream`, `--detach/--status/--kill/--attach`, Ctrl-C kills | `cli:exec.txt` | S7 | ◐ | S7/S22 |
| CL7 | `run`: create → push → exec → the time summary → delete; `--keep`; the sandbox stops itself after 15 min if the CLI died | `cli:run.txt` | No | ✗ | S22, P1 |
| CL8 | `push` (git-aware tar), `scp` (tar-over-SSH), `forward`, `ssh -t` | `cli:push.txt`, `cli:scp.txt`, `cli:forward.txt`, `cli:ssh.txt` | SSH-gateway S4 | ◐ | S22 |
| CL9 | `host`, `desktop`, `browser` | `cli:host.txt`, `cli:desktop.txt`, `cli:browser.txt` | S7/S10 | ◐ | S7, S29 |
| CL10 | `history`, `ps`, `events --follow` | `cli:history.txt`, `cli:ps.txt`, `cli:events.txt` | No | ✗ | S19, S15 |
| CL11 | `prompt`, `steer`, `interrupt`, `conversations` | `cli:prompt.txt` etc. | No | ✗ | S15 |
| CL12 | `snapshot`, `snapshots`, `snapshot latest/tree/pull/delete/rm/share/shares/unshare` | `cli:snapshot.*.txt` | Save/rm — S7 | ◐ | S18, S23 |
| CL13 | `env *` (15 subcommands), `ai *` (11), `api-key *` (5), `org *` (10), `webhook *` (4), `telemetry *` (3), `ci *` (4), `data-retention *`, `deletion status` | `cli:env.*.txt`, `cli:ai.*.txt`, … | Keys — S8 | ◐ | S14, S16, S24, S23, S20, S26, S25 |
| CL14 | `completions` with live ids (cache 15 s), `self-update` by channels, auto-update every 6 h | `cli:completions.txt`, `cli:self-update.txt` | No | ✗ | S22 |
| CL15 | `status --check`, `limits`, `usage`, `dashboard` (a one-time login code) | `cli:status.txt`, `cli:dashboard.txt` | No | ✗ | S22, S20 |
| CL16 | `onboard` (the question "for yourself or for third parties"), `feedback` | `cli:onboard.txt`, `cli:feedback.txt` | — | ⊘ | Onboard is not needed with SSO; feedback is a link to the support channel |
| CL17 | `billing *`, `wallet *` | `cli:billing.*.txt`, `cli:wallet.*.txt` | — | ⊘ | Commerce |

### 2.21 For agents: documentation, skills, plugins, MCP

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| AG1 | The documentation MCP server `docs.boat.dev/mcp` (searching and reading pages) | `docs:ai-tools.md` | No | ✗ | S21, P1 |
| AG2 | `llms.txt` with a "key facts" block and a CLI cheat sheet; `llms-full.txt`; any page as `.md` | `docs:ai-tools.md`, `llms.txt` | No | ✗ | S21 |
| AG3 | A snippet for the project's `AGENTS.md`/`CLAUDE.md`: when to take a sandbox, always pass the id, stop vs delete | `docs:ai-tools.md` | No | ✗ | S21 |
| AG4 | A package of 13 scenario skills (`npx skills add …`) | `vr:cloud-sandbox-vm-skills` | No | ✗ | S21 |
| AG5 | The Kimi plugin: `/box:setup`, `/box:new <task>`, reference skills (CLI, API, SDK TS/Py, platform) | `vr:kimi-box-plugin` | No | ✗ | S21 |
| AG6 | The `boat` skill preinstalled for all harnesses in the sandbox | `docs:ai-tools.md` | No | ✗ | S15/S21 |
| AG7 | A sandbox management MCP server (boat has none) | `vr:battleships/research/cards/boat.json` | S11 | ✅* | Better than boat; the tool list is in §5.2 |
| AG8 | The rule "do not quote prices from memory, call `limits`" | `docs:ai-tools.md` | — | ✗ | An analog: "learn templates and quotas via `umiak limits`" — S21 |
| AG9 | "Open in Claude/ChatGPT/Cursor" buttons on documentation pages | `docs:ai-tools.md` | — | ✗ | S21, P3 |

### 2.22 API conventions

| # | Boat capability | Source | Our plan | Status | Decision |
|---|---|---|---|---|---|
| API1 | The envelope `{ok, type}`, errors `{code, message, details.retryable}`, `requestId` | `docs:api/v1.md` | S6 §14.1 `UmiakError{code, retryable}`; the format — S7 | ◐ | MVP rec. R1 |
| API2 | Cursor pagination `limit/cursor/sort`, `pageInfo` | `docs:api/v1.md` | S7 | ◐ | S7 |
| API3 | Asynchronous operations with 202 and polling | `docs:api/v1.md` | S6 operations | ✅ | — |
| API4 | Id prefixes: `bx_`, `wh_`, `evt_`, `bdop_`, `bsh_` | `docs:api/v1.md` | S7 | ◐ | S7 |
| API5 | The rename Box → boat: aliases of paths, keys, headers, `Deprecation`/`Sunset` | `docs:migrating-from-box.md`, `docs:migrating-from-box/*` | — | ⊘ | We have nothing to migrate; take the `Deprecation` policy into S7 later |
| API6 | Long-poll with ETag/304 for events | `docs:api/reference/agent/list-sandbox-events.md` | S6 `waitForState` (LISTEN) | ◐ | S15 |

### 2.23 Skipped: commerce and other

| What | Source | Why skipped |
|---|---|---|
| Plans $20–$2000, a trial, a credit card | `docs:pricing.md`, `docs:free-trial.md`, `docs:billing.md` | An internal platform without billing |
| Wallet, auto-top-up, bonuses, the Stripe portal, VAT | `docs:billing.md`, `docs:billing/plan-changes.md`, `cli:wallet.*.txt` | The same |
| Paid starts above the limit (×1.5–3) | `docs:limits.md` | Limits are set by the operator (S6/S8 quotas) |
| Seats in an organization, multiplying limits | `docs:organizations/seats-and-limits.md` | Teams come from the IdP |
| Prices by size, the field `dollars`, `deletedCost` | `docs:pricing.md`, `docs:api/reference/sandboxes/get-sandbox-usage.md` | Replaced by resource-second accounting (S20) |
| Paid CI, trial checkout by an agent | `docs:ci.md`, `docs:agent-auth.md` | Commerce |
| Trial restrictions (`trial_*`) | `docs:free-trial.md` | Commerce |
| Support by email/Discord, `feedback` | `docs:support.md` | An internal support channel |
| SOC 2, EU data residency | `docs:compliance.md` | The data is inside the company anyway |
| Competitors' price tables, the battleships pricing engine | `docs:pricing.md`, `vr:battleships/site` | Irrelevant |

## 3. Where we can be better than boat

Boat's weak spots are taken from its own documentation and the card in `vr:battleships/research/cards/boat.json`.

| Topic | Boat | Us | Where |
|---|---|---|---|
| Windows | No guests, Wine only | Windows 11 and Server Core, a desktop, PowerShell, ConPTY, VSS | S9, S10 |
| MCP for managing sandboxes | None (only a documentation MCP) | An MCP server on top of the API, the tools in §5.2 | S11, S21 |
| Git tokens in the VM | A long-lived GitHub token in `~/.git-credentials` and `hosts.yml` | MVP: a short-lived installation token with minimal rights via the agent's credential helper (S13). Phase 2: a git proxy without a token in the VM | S13, S16 |
| Secret proxy | AI keys and custom API | The same mechanism for git, internal APIs, and registries; a built-in budget for AI | S16 |
| Auto-stop | TTL from start; extended only by a running agent prompt | Idle-stop by real activity (commands, PTY, TCP); wake-up on HTTP/SSH | S6 §12, S30 |
| Readiness | `ready` does not wait for Docker and systemd services | `ready` waits for the `docker` phase | S3 §8.5 |
| Resume | A new machine: IP, hostname, SSH host keys change | The same VM on the same node, identity does not change | S6 §7.6 |
| Fork of a running one | From a one-minute snapshot, loses up to 1 min | A snapshot with quiesce, an exact copy | S6 §7.7 |
| Time rollback | Only the latest snapshot | Auto-snapshots with a choice of point | S18 |
| Exec | No env and user per command; files ≤5 MiB; paths only `/home/user` and `/tmp` | Env and user per command; files of any size with resumption; any paths | S3 |
| Terminal | SSH only | PTY through the API and xterm.js in the dashboard | S3, S8 |
| SSH host key | Changes on every resume | A permanent gateway key | S4 |
| Port access | Only a token or public | Also `sso` through a corporate IdP | S4 §8.4 |
| Network | No egress policies, private network, static IP | Per-sandbox policies via the Proxmox firewall/SDN | S17 |
| Custom images | None (only a saved snapshot) | Dockerfile/OCI → a template | S28 |
| Volumes | No volumes | Shared team volumes (our extension, boat has no analog) | S18 |
| Hibernation | Memory is not saved | A QEMU memory snapshot | S30 |
| Audit and SSO | None | An audit log; SSO via oauth2-proxy | S8, S20 |
| Agent events | Polling once a second, partial and final responses with different ids (optibox's pain) | A stream and real deltas | S15 |
| Command output | `/commands` truncates to 512 KB from the end (optibox's pain) | Reading by offset, up to 128 MiB per stream with eviction of the start (`truncated`) | S3 §10 |
| GPU | None | GPU passthrough if the company has the hardware | Outside the plan, an idea |

## 4. Phase 2 plan: areas S14–S30

| # | Area | What we decide | Depends on | Size | Priority |
|---|---|---|---|---|---|
| S14 | Environments v2 and setup | Named environments with versions and `upgrade`; variables, secret files, repositories, pass-through switches (git, secrets, sandbox key, AI); `noEnv` and "without the owner's secrets" with disk scrubbing; a repository setup script and `--setup-file` with a status; access to an environment by members | S6, S7, S8, S13 | M | P1 |
| S15 | Built-in coding agents | Harnesses in the template (Claude Code, Codex, OpenCode, later pi and others); a runner in the VM; `prompt`, `promptRun`, events (stream + cursor), conversations, `steer` with delivery modes, `interrupt`, a model catalog, attachments, switching the harness in a conversation (P3); registration of the MCP `computer` and the skill `umiak` in the harness configs; a prompt as activity for idle-stop | S3, S5, S7, S10, S14, S16 | L | P1 |
| S16 | Credentials proxy | Credential profiles (personal and team), keys and subscriptions, several accounts; binding a profile to an environment; a proxy with placeholders on start, substitution into a header, host binding; custom API for internal services; **a git proxy without a token in the VM** (the deferred part of S13 moves here); token accounting, sandbox blocking, budgets; a mandatory proxy for a team | S4, S8, S13, S14 | L | P1 |
| S17 | Network v2 | Egress policies per sandbox or template (deny-all, a domain and CIDR allowlist); a private network of sandboxes of one team; a static egress IP; TCP ports outward through the gateway; custom domains | S1, S4, S12 | M | P2 |
| S18 | Snapshots v2 | Scheduled auto-snapshots with rollback to a point; snapshot-now; fork from a snapshot by id; a tree and reading snapshot files without a VM (a read-only thin snapshot on the node); `snapshot pull` and export; archiving stopped ones to PBS and restoring on another node (together with S12); shared volumes (our extension) | S1, S6, S12 | L | P2 |
| S19 | History and observability in the sandbox | A copy of command output outside the VM (90 d) and reading it while stopped; `history`; capturing the output of all processes (journal, tty); `ps` with stored samples; CPU/RAM/disk series (disk fill — for the S20 notifications); a History dashboard | S3, S6, S7 | M | P2 |
| S20 | Outbound events | Webhooks (lifecycle events, HMAC, retries, a delivery log) from the S6 outbox; OTLP export of metrics and events per team; usage in resource-seconds for showback; an audit log; email/Slack notifications (disk, errors, retention) | S6, S7, S8 | M | P2 |
| S21 | For agents: skills, plugins, documentation | A skills package (reference + scenario, §5.1; part of the scenario ones ship with S14, S15, S16, S22); a Claude Code plugin with slash commands and `.mcp.json`; manifests for Codex, OpenCode, Cursor, Kimi; the skill `umiak` inside the sandbox; `llms.txt`, `.md` for pages, a documentation MCP server; a snippet for `AGENTS.md`; evals and "a sandbox per task" guides | S7, S11; S14, S15, S16, S22 for some skills | M | P1 |
| S22 | CLI and SDK v2 | `run`, `push`, `scp`, `forward`, `ssh-config`, `ssh -t`; `current`/`self`; `login --key-stdin`, `logout`, `status --check`, `dashboard`; completions with live ids, self-update; the in-VM `umiak` and `host` (on a sandbox key from S24); SDK helpers (waits, `runCommand`, `followCommand`, streams, file upload), flat parameters and HTTP/2 in TS, a Python async client; signed file URLs; search, replace, and directory watching in files | S7, S4, S24 | M | P1 |
| S23 | Teams and shared access | Shared/private, access `owner/use/view`, auto-private on the creator's logins; `share`/`unshare` with scrubbing; scrubbing logins when deploying a team image; share codes between teams; per-user limits; choosing the active team | S8, S14, S16 | M | P2 |
| S24 | API keys v2 and agent login | Keys with resources (sandboxes, environments), lifetimes, a child no wider than its parent; rotate, usage; operations only from a browser session; a sandbox key and a port token inside the VM; a device flow for an agent with SSO confirmation; `WWW-Authenticate` with `resource_metadata` | S8 | S | P1 |
| S25 | Data retention and deletion | Retention periods of stopped ones and of history with warnings; ephemeral sandboxes (stop = delete); turning off monitoring; ZDR per team. The public deletion status is in S7 | S6, S18, S19 | S | P3 |
| S26 | CI runners | Ephemeral GitHub Actions runners (or GitLab — per the S13 answer): size labels, `from=<saved snapshot>`, `debug`, refusing public repos, a time limit; an API and CLI for jobs and logs; an OOM annotation | S13, S22; S28 optionally | M | P2/P3 |
| S27 | Evals and adapters | Harbor `BaseEnvironment`, an Eve backend, on request an E2B-compatible wrapper; an RL/evals guide; uses batch create and the warm pool for a snapshot from S30 | S7, S22, S28, S17, S30 | M | P3 |
| S28 | Custom images and templates v2 | A template from a Dockerfile/OCI or a script (built on the node, cached); user templates of a team; versions and rollback; a template catalog in the admin | S5, S9 | L | P2 |
| S29 | Desktop v2 | The computer-use API is already in the MVP (S10); here: browser-only with Chrome profiles; desktop recording; noVNC; clipboard, wallpapers | S10, S9 | M | P2 |
| S30 | Lifecycle v2 | Waking a stopped sandbox on HTTP/SSH (the gateway holds the request); hibernation via a QEMU memory snapshot; batch create (`count`); a warm pool for a saved snapshot (for `failFast` with `from`); resume idempotency; disk growth on a size change; a user pre-stop hook; a policy for hung `degraded` ones | S1, S4, S6 | L | P2 |

Order of waves:
1. **P1** right after the MVP: S21 (reference skills and the plugin are cheap and immediately useful to agents from the MVP) and S24 → S22 (S22 builds the in-VM CLI on a sandbox key from S24), then S14 → S16 → S15 (S15 depends on the previous two).
2. **P2**: S20, S17, S29, S30, S28, S19, S23, S18.
3. **P3**: S26, S27, S25. Raise S26 to P2 if Ilia confirms demand for CI runners.

### 4.1 Area details

**S14. Environments v2 and setup.**
- Goal: the settings a sandbox receives at start are set once and updated in a controlled way.
- Contents:
  - an environment: variables, secret files (paths from home), repositories (from S13), a credential profile (S16), pass-through switches;
  - immutable versions; a sandbox is pinned to a version; `upgrade` hot via S3 `UpdateEnv`/`UpdateSecrets`, for a stopped one — at resume;
  - `noEnv` and "without the owner's secrets": before the first access scrub from disk the logins, `~/.git-credentials`, `~/.claude`, `~/.codex`, the sandbox key (boat: `sandbox_securing`);
  - a repository setup script on every start and a one-time `--setup-file`; the status `setupStatus`/`setupError`;
  - env limits (100 variables, 64 KB, reserved names);
  - access to a team's environment by members.
- Basis: `docs:environments/*`, `docs:setup.md`.

**S15. Built-in coding agents.**
- Goal: `POST /prompt` starts a harness in the sandbox, the client gets an event stream and can steer or interrupt the agent.
- Contents:
  - the runner in the VM is a separate service or a module of the guest agent (decide in brainstorm), a process per conversation under the S3 shim;
  - a normalized event format (`prompt`, `response` in deltas, `tool_use`, `tool_result`, `steer`, `usage_limit`, `compaction`); a stream (NDJSON/SSE) and cursor polling;
  - conversations survive stop and fork because the history lies on disk;
  - steer: natively (Claude Code, Codex) or interrupt + continue; the delivery mode in the event;
  - a model catalog; attachments; a limit of parallel conversations by RAM;
  - harness configs at start: the MCP `computer` (S10), the skill `umiak` (S21), rule files; merging with the user's;
  - a prompt and waiting for the agent count as activity for idle-stop.
- Lessons from optibox: real deltas, without a double answer; `cwd` always explicit; `prompt` idempotency by key.
- Basis: `docs:integrated-agents/*`, `vr:optibox/docs/*`.

**S16. Credentials proxy.**
- Goal: real keys to AI, git, and internal APIs do not get into the sandbox.
- Contents:
  - credential profiles (personal and team), keys and subscriptions; OAuth/device flow for subscriptions; refresh only on the server;
  - a proxy (a service next to the gateway or in it): a placeholder on every start, verification, substitution into `Authorization`/`x-api-key`, host binding, token accounting from the provider's response;
  - custom API: `NAME` and `NAME_BASE_URL`;
  - a git proxy without a token in the VM on the same mechanism (in the S13 MVP — a short-lived token via a credential helper, the proxy is deferred; the owner is S16);
  - binding a profile to an environment (`credentialProfileId`, S14);
  - sandbox blocking; budgets per sandbox, user, and team with an auto-block;
  - a team can mandate the proxy.
- Questions for brainstorm: where to direct traffic (`*_BASE_URL` or a transparent MITM with a CA in the template); what to do about Bedrock SigV4.
- Basis: `docs:ai-credentials.md`, `docs:integrated-agents/keys.md`.

**S17. Network v2.**
- Contents:
  - egress policies at the PVE firewall level (an IPSet per VM) or SDN; domains via a DNS proxy with an allowlist;
  - a policy API per sandbox and template, inheritance on fork;
  - a team's private VNet;
  - egress through a dedicated NAT IP;
  - TCP ports outward through the gateway (L4 by SNI or by port);
  - custom domains (ACME HTTP-01/DNS-01). Slug rename is S7 (S4 §4.2).
- Basis: `docs:hosting/firewall.md`, `vr:battleships`, S1 §4.4, S4 §17.

**S18. Snapshots v2.**
- Contents:
  - an auto-snapshot controller (`kind auto`): interval, keeping the last N, at stop;
  - rolling a sandbox back to a snapshot and forking from a snapshot by id;
  - reading a snapshot without a VM: node-agent activates a read-only thin snapshot, mounts it, and serves the tree and files via the API;
  - export;
  - archiving stopped ones to PBS and restoring on another node (the junction with S12);
  - volumes: a separate LV attachable to a team's sandbox (boat has none, our extension; simultaneous attachment to several VMs needs a shared FS — decide in brainstorm).
- Risks: LVM locks with frequent snapshots, thin pool space (a metric, a limit).
- Basis: `docs:snapshots/*`, `vr:optibox/docs/scenario-timetravel-design.md` (rollback points are needed by boat users too).

**S19. History and observability in the sandbox.**
- Contents:
  - the agent sends command output to storage (the S3 offsets allow topping up) — object storage or Postgres with compression;
  - reading history from a stopped sandbox;
  - capturing the output of other processes via journald and tty with limits;
  - samples of `ps` and metrics every 30 s, kept 7 d;
  - a History view in the dashboard.
- Basis: `docs:long-running-tasks/command-history.md`.

**S20. Outbound events.**
- Contents:
  - webhooks from `sandbox_events` (S6 §5.6): HMAC signature, retries, a delivery log, secret rotation;
  - the events `ready`, `stopped`, `error`, `degraded`, `recovered` and new ones (`agent.turn_finished` from S15);
  - OTLP export of metrics and events per team with a test on save;
  - usage in resource-seconds by sandbox, user, team;
  - an audit log (who, what, when, with which key);
  - email/Slack notifications.
- Basis: `docs:webhooks.md`, `docs:opentelemetry.md`.

**S21. For agents: skills, plugins, documentation.** In detail in §5.

**S22. CLI and SDK v2.**
- Contents:
  - `run` (create → push → exec → summary → delete, auto-stop after 15 min if the CLI died);
  - `push` (a git-aware tar via `/files/archive` or SSH), `scp`, `forward`, `ssh-config` for VS Code/Cursor;
  - `current` and `self`; completions; self-update;
  - the in-VM CLI: `umiak` and `host` inside the sandbox on the sandbox key from S24 (`host url` waits for the route);
  - `login --key-stdin`, `logout`, `status --check`, `dashboard` (one-time login), `ssh -t`;
  - SDK helpers as in boat plus file upload, flat parameters and HTTP/2 in TS, a Python async client;
  - signed file URLs through the gateway; search, replace, directory watching.
- Basis: `docs:cli-reference.md`, `sdk:*/boat_helpers*`.

**S23. Teams and shared access.**
- Contents:
  - sandbox visibility, access levels, auto-private on the creator's logins;
  - `share` with login scrubbing;
  - team images with scrubbing on deploy by a colleague;
  - image share codes between teams;
  - per-user limits;
  - the active team for the CLI and a team header.
- Basis: `docs:organizations/shared-sandboxes.md`, `docs:snapshots/templates.md`.

**S24. API keys v2 and agent login.**
- Contents:
  - keys restricted to a set of sandboxes and environments;
  - rotate and usage; operations only from a browser session;
  - a sandbox key (sees only itself) and a port token in the VM;
  - a device flow for an agent: the agent receives a code, a human confirms it in the dashboard under SSO;
  - `WWW-Authenticate` with `resource_metadata` (RFC 9728) — OAuth for MCP (S11) at the same time.
- Basis: `docs:api-keys/*`, `docs:agent-auth.md`.

**S25. Data retention and deletion.**
- Contents:
  - retention policies for stopped sandboxes and history (with a warning N days ahead);
  - ephemeral sandboxes (stop = delete, without snapshots) for CI and evals;
  - turning off monitoring;
  - ZDR for a team.
- The public status of delete operations is in S7 (L11).
- Basis: `docs:data-retention/*`.

**S26. CI runners.**
- Contents:
  - a GitHub App (or a GitLab webhook), a job queue, a JIT runner in an ephemeral sandbox;
  - labels `umiak`, `umiak-large`, `umiak/from=<snapshot>/debug`;
  - refusing public repositories; a 6 h limit;
  - logs and status in the API/CLI; an OOM annotation;
  - Windows runners on the `windows-core` template (boat has none).
- Basis: `docs:ci.md`.

**S27. Evals and adapters.**
- Contents:
  - Harbor `BaseEnvironment`: uses per-command env/user, absolute paths, directory tars, the S17 network policies, images from S28 — what harbor-box is forced to refuse;
  - an Eve backend with a native `spawn` via detached + attach;
  - an E2B-compatible wrapper if the company's frameworks ask for it;
  - an RL/evals guide; batch create and the warm pool for a snapshot come from S30.
- Basis: `docs:evals.md`, `vr:harbor-box`, `vr:eve-box`.

**S28. Custom images and templates v2.**
- Contents:
  - building a template from a Dockerfile or a script on top of a base template (RUN steps in the VM, then seal and registering the S5 build);
  - a cache by Dockerfile hash;
  - user templates of a team with a quota;
  - versions and rollback;
  - Windows: the same pipeline on top of S9.
- Basis: `vr:harbor-box/README.md` (Terminal-Bench requires images), `vr:battleships` (custom image).

**S29. Desktop v2 and the computer-use API.**
- Contents:
  - the computer-use API and MCP tools through cua-driver for Linux and Windows;
  - a browser-only stream with Chrome profiles;
  - mp4 recording with upload;
  - noVNC as a fallback;
  - clipboard, wallpapers, `overlay=0`.
- Basis: `docs:desktop-streaming/*`, `docs:integrated-agents/computer-use.md`.

**S30. Lifecycle v2.**
- Contents:
  - wake-up on request: the gateway (S4) holds an HTTP request or an SSH connection and calls resume;
  - hibernation: `qm suspend --todisk` or a snapshot with vmstate (check the time and size on LVM-thin);
  - batch create with `count`;
  - a warm pool for a saved snapshot so that `failFast` and mass start work with `from` too (currently a create from a snapshot is always cold, S6 §7.3);
  - `Idempotency-Key` on resume;
  - disk growth on a size change;
  - a user hook `~/.umiak/pre-stop` (save application state before stop);
  - what to do with a long-`degraded` sandbox (boat stops it after 3 days, S6 §11.1 does not touch it).

## 5. Integrations for agents (in detail)

### 5.1 Skills and plugins

What boat has:
- `vr:cloud-sandbox-vm-skills` — 13 scenario skills, installed via `npx skills add` into Claude Code, Codex, OpenCode, Cursor. Each: when to use → why → prerequisites → a bash recipe → limitations. Our package is roughly the same: it holds 14 scenario skills, the set and recipes for `umiak` and our templates.
- `vr:kimi-box-plugin` — a Kimi Code plugin (`kimi.plugin.json`) with the commands `/box:setup`, `/box:new` and 18 skills: the same 13 scenario ones (with edits) and 5 reference ones (CLI, API, SDK TS, SDK Python, platform).
- In the sandbox the `boat` skill is preinstalled for all harnesses.
- Boat has no manifest for Claude Code and no `.mcp.json`.

Our package (the repository `umiak-agent-kit` or the directory `integrations/agent-kit` in the monorepo; built together with the CLI, versions match).

**Reference skills:**

| Skill | Contents |
|---|---|
| `umiak-cli` | Installation and login (`umiak login`, a key from env, `--key-stdin`); global flags; `current`/`self`; lifecycle; exec/ssh/push/forward/desktop; snapshots; **the JSON/JSONL contract**: `jq 'select(.event=="ready")'`, the error line, exit codes; the quirk of stdin in PowerShell |
| `umiak-api` | Base URL, authorization, the envelope, the table of error codes with `retryable` and the action; the state machine; the endpoint table; a curl loop; 502 = "may have executed" |
| `umiak-sdk-ts`, `umiak-sdk-py` | Configuration, the flow create → wait → work → cleanup in `finally`; helpers and their frames |
| `umiak-mcp` | The tool list, when MCP and when CLI, long tasks via detached + polling |
| `umiak-platform` | A sandbox per task or per user, template → fork, a daemon in the VM + a port with a token, quotas, what survives stop/resume/fork |

**Scenario skills** (the trigger in `description` decides whether the skill fires):

| Skill | Scenario | Boat's basis | When |
|---|---|---|---|
| `run-untrusted-code` | Untrusted or generated code: `timeout`, deletion in `trap`, no secrets | exists | MVP (the flag from R3); fully — S14 |
| `code-execution` | A code interpreter on a real machine | exists | MVP |
| `offload-build-test` | Builds and tests off the host; before S22 — create + exec + delete, after — `umiak run --push .` | `cloud-sandbox` | MVP, simplified in S22 |
| `docker-sandbox` | Docker/Compose + a port outward | exists | MVP |
| `ephemeral-ci` | A clean CI environment, artifacts back | exists | MVP |
| `delegate-to-agent` | Hand a task to a coding agent in the sandbox (`umiak prompt`, events, steer) | `agent-sandbox` | S15 |
| `parallel-agents` | Prepare a base, stop, fork N (own env per copy — R11), collect via git | exists | MVP |
| `long-running-service` | systemd, no TTL, idle-stop, what survives stop | `background-worker` | MVP |
| `expose-port` | A public URL: `token`/`sso`/`public`, binding to 0.0.0.0 not needed | `expose-localhost-tunnel`, `public-url-hosting` | MVP |
| `dev-box-ssh` | A remote developer machine, VS Code Remote | `cloud-vm`, `linux-server-ssh` | MVP |
| `computer-use-desktop` | GUI and browser: the desktop, computer-use (Linux and Windows) | exists | S10; the API — S29 |
| `windows-sandbox` | PowerShell, Windows applications, GUI on the Windows template | none in boat | S9 |
| `private-repo-work` | Private repos: in the MVP a short-lived token (S13), without a token — S16 | none in boat | S13 |
| `evals-per-task` | A snapshot per task, an idempotent create, backoff | `docs:evals.md` | MVP |

**Rules in all skills** (from boat, adapted):
- wait for `ready` before exec;
- cleanup in `trap`/`finally`; stop by default, not delete;
- retry only on `retryable: true`;
- do not pass secrets in prompts, URLs, and arguments;
- URLs with a token, keys, and desktop links are secrets, redact them in logs;
- always pass the id (`current` does not work in scripts);
- learn quotas and templates through `umiak limits`, not from memory.

**Slash commands** (the plugin):

| Command | What it does |
|---|---|
| `/umiak:setup` | Installs the CLI, logs in (a key from env or the browser), checks `umiak limits --json` |
| `/umiak:new <task>` | Creates a sandbox, copies the inputs, executes, returns the result or a URL, stop by default |
| `/umiak:list` | The user's sandboxes with their state |
| `/umiak:cleanup` | Stop or delete the sandboxes created in this session (by label) |
| `/umiak:desktop [id]` | A desktop link |
| `/umiak:fork <n> <task>` | Fork N copies and run in parallel (after S15 — via `prompt`) |

**Packaging:**
- `skills/*/SKILL.md` in the agentskills format: installed with `npx skills add <internal repository>` for Claude Code, Codex, OpenCode, Cursor;
- the Claude Code plugin: `.claude-plugin/plugin.json`, `marketplace.json` in an internal marketplace, `commands/`, `.mcp.json` with our MCP (Streamable HTTP, a key from env or OAuth);
- Codex, OpenCode, Cursor, Kimi: skill directories + MCP registration with their commands (`codex mcp add`, `opencode.json`, `mcp.json`, `kimi.plugin.json`). Check the manifest formats at the time of S21: they change quickly;
- the skill `umiak` in the templates for all harnesses (S15): how a sandbox manages itself through the in-VM CLI.

**Documentation for agents:**
- `llms.txt` with a key facts block (templates, sizes, quotas, periods, timeouts, events) and a CLI cheat sheet;
- `llms-full.txt`; every page is available as `.md`;
- a documentation MCP (`search_docs`, `read_page`) — can be tools of our own MCP server;
- an `AGENTS.md`/`CLAUDE.md` snippet for projects.

### 5.2 The MCP server tool list (S11 and phase 2)

Update 2026-10-29: the final MVP list is `docs/specs/s11-mcp.md` (38 tools). `computer_*` and `desktop_url` went into S11; `files_mkdir`, `files_move`, `sandbox_extend` are not introduced; added `files_edit`, `sandbox_recover`, `computer_move`, `computer_clipboard_*`; `exec_input` and PTY — S22. The table below is the original draft.

Transport: Streamable HTTP behind `api.<domain>` (a Bearer key, later OAuth per RFC 9728 via S24) and stdio via `umiak mcp`. Tool annotations: `readOnlyHint` and `destructiveHint`. Delete requires repeating the id (like the confirmation header).

Long operations: `exec_start` + `exec_output` with an offset, without holding one call. Output in a response is truncated with an explicit `next_offset`.

| Tool | What it does | Area |
|---|---|---|
| `templates_list` | The templates and sizes available to the user | S11 |
| `limits_get` | Quotas and the remainder, allowed sizes with a reason | S11 (MVP rec. R9) |
| `sandbox_create` | template, size, name, labels, env, ttl, idle, from, failFast; waits for `ready` (optional) | S11 |
| `sandbox_list`, `sandbox_get` | Filters by state and labels | S11 |
| `sandbox_stop`, `sandbox_resume`, `sandbox_fork`, `sandbox_extend`, `sandbox_update` | Lifecycle | S11 |
| `sandbox_delete` | With id confirmation | S11 |
| `exec_run` | Synchronously with a timeout: exit, stdout/stderr with truncation | S11 |
| `exec_start`, `exec_output`, `exec_kill`, `exec_list` | Detached, reading by offset, kill | S11 |
| `files_read`, `files_write`, `files_list`, `files_stat`, `files_delete`, `files_mkdir`, `files_move` | Files (range reads) | S11 |
| `port_expose`, `port_list`, `port_unexpose` | The port URL (`token`/`sso`/`public`) | S11 |
| `snapshot_save`, `snapshot_list`, `snapshot_delete` | Saved snapshots | S11 |
| `desktop_url` | A desktop link | S11 (after S10) |
| `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag` | Computer-use | S11 (on top of S10 §13) |
| `agent_prompt`, `agent_events`, `agent_steer`, `agent_interrupt`, `agent_conversations` | Built-in agents | S15 |
| `history_list`, `history_output`, `processes_list` | History and processes | S19 |
| `env_list`, `env_get`, `env_set_var`, `env_add_repo` | Environments | S14 |
| `snapshot_tree`, `snapshot_read_file`, `snapshot_restore` | Snapshots v2 | S18 |
| `docs_search`, `docs_read` | Platform documentation | S21 |

MCP resources (optional): `umiak://<id>/files/<path>`, `umiak://<id>/commands/<cmd>/output`.

### 5.3 Integrations with frameworks and eval harnesses

| Integration | What we do | Area |
|---|---|---|
| Harbor (Terminal-Bench etc.) | A Python `BaseEnvironment`: exec with env/user, absolute paths, directory tars, network policies, the task image from a Dockerfile | S27 (+S17, S28) |
| Eve | A `SandboxBackend` with a native `spawn` | S27 |
| An E2B-compatible SDK | A wrapper on top of our API for frameworks that only speak E2B (LangChain, OpenAI Agents SDK, etc.) — only on demand | S27, P3 |
| Claude Agent SDK / one's own agent in a sandbox | An example like `vr:harbor-box/sdks/harbor-box-evals`: the agent in the VM, the JSONL trajectory is exported | S21 (a guide) |
| CI | GitHub Actions/GitLab runners; `umiak run` in any CI | S26, S22 |
| Convex, optibox | We do not do them | ⊘ |

## 6. Master's recommendations for the MVP (S1–S13)

Gaps that are cheaper to close now than to change after release.

| # | Area | Recommendation | Why now |
|---|---|---|---|
| R1 | S7 | Fix the **CLI contract**: JSON automatically when stdout is not a TTY; JSONL with the `ready` event for `new`/`fork --wait`; an error is the last line `{"event":"error","code",…}`; the command's exit code and 124 on timeout; `current`. In the API: a delete confirmation header (`Umiak-Confirm-Delete: <id>`), `retryable` and `requestId` in every error. In the SDK — the helpers `waitUntilReady`, `runCommand`, `streamCommand` | Skills, MCP, CI, and scripts are built on this contract; changing it after release breaks everyone. Delete confirmation protects against agents' mistakes |
| R2 | S6, S7 | `failFast` on create from a template: warm pool only, otherwise `503 pool_exhausted`, nothing is created. With `from` a create is always cold for us (S6 §7.3), so there `failFast` is either rejected or waits for a warm pool for a snapshot (S30) | The pool already exists (S6 §9), this is one admission branch; needed by evals and latency-sensitive agents |
| R3 | S7/S8, S13 | A minimal **environment** entity (variables, secret files, repositories, default) and a flag "without the user's secrets" on create. Decide the owner: a Payload collection (S8) + applying at claim (S6) | S13 puts repositories into an environment, but the entity is in no specification. Versions and upgrade come later (S14) |
| R4 | S8 | The key scope model right away as **action × resource** with a lifetime: actions as in boat (§2.14 K2), restriction by a list of sandboxes and environments (optionally templates), a 90 d default lifetime, a child key no wider than its parent. Reserve a "sandbox" key type (sees only its own sandbox) for the in-VM CLI | Changing the semantics of issued keys later is a migration and a security risk; S22/S24 are built on this |
| R5 | S5 | Put into the `linux` template the coding-agent CLIs (`claude`, `codex`, `opencode`), our `umiak` CLI, and the tool set per `docs:machines/tools.md` (Node+pnpm, Python+uv, Go, Rust, Java, Docker+Compose+buildx, gh, rg, jq, Chrome, ffmpeg, xdotool) | Users will start running agents through exec and SSH long before S15; S15 relies on the versions in the template |
| R6 | S1, S5 | Check `/dev/kvm` in the guest (nested virtualization on the host, `cpu host` is already in S1 §4.6) and record whether it is a platform guarantee | Docker already exists; the Android emulator, Firecracker, and QEMU tests in CI need KVM. `cpu host` hinders live migration between different CPUs — the decision affects S12 |
| R7 | S3/S7 | Move `/files/archive` (a directory tar up and down as a stream) from "later" into v0 or S7 | Without it `umiak push`, artifact export, and the evals adapters make one call per file (harbor-box's pain) |
| R8 | S11 | Take the tool list of §5.2 as input to the S11 brainstorm, including the long-task template (detached + polling) and the `destructiveHint` annotations | S11 is the main channel for agents and our difference from boat |
| R9 | S7 | `GET /v1/limits`: team quotas and the remainder, allowed templates and sizes with a reason | Quotas exist (S6 §8.5); agents need to check before a mass start, skills refer to `umiak limits` |
| R10 | S4, S6, S7 | Align the slug format: S6 §5.6 says "10 characters `[a-z0-9]`", S4 §4.2 — `[a-z0-9]+(-[a-z0-9]+)*`, 3–40 characters, three words by default, rename in S7 | The slug is visible in port URLs and SSH; the contradiction between specifications must be removed before implementation |
| R11 | S6, S7 | `env` and `secretFiles` on fork (replace the inherited ones) and on resume. Currently fork accepts only `name, labels, ttlSeconds, size` (S6 §7.7), resume — `size` and TTL (§7.6) | The central scenario of parallel-agents and evals: its own task or secret per copy. Re-encrypting `sandbox_secrets` for the target already exists in §7.7, the change is small |

Do not touch in the MVP (already well decided or waiting for phase 2): idle-stop by activity, exact fork, `sso` ports, a permanent SSH host key, command output via the shim — these are our advantages (§3).

## 7. Open questions for the phase 2 brainstorm

- S15: is the agent runner part of the guest agent (Go) or a separate service in the VM (TS, closer to the SDK harness)?
- S16: a proxy through `*_BASE_URL` or a transparent MITM with a CA in the template; what to do with SigV4 (Bedrock) and OAuth subscriptions.
- S17: domains in the allowlist via a DNS proxy or only IP/CIDR in the PVE firewall.
- S18: object storage for history and export (S19 too) — MinIO/S3 in the cluster or Postgres.
- S26: GitHub or GitLab (Ilia's answer on S13).
- S27: is E2B compatibility needed — which frameworks the company uses.
- GPU: does the company have hardware for passthrough.

## Appendix. Source coverage

- Documentation: all 213 pages of `docs:` were read (by section: guide and platform — 35, environments/hosting/ssh/desktop/windows/ci/evals/otel/webhooks/data-retention — 34, agents/AI/orgs/keys/billing/SDK — 29, `cli-reference.md` — 1, API reference — 113 pages + `api/v1.md`) and `llms.txt`. All 113 pages of the API reference were matched to the 121 OpenAPI operations; 8 operations have no pages (4 CI and 4 hidden `named-snapshots`). The documentation mentions endpoints that are not in the OpenAPI: `GET /provider-models`, `POST /sandboxes/{id}/browser`, agent-auth endpoints.
- CLI: all 120 files of `cli:` and `docs:cli-reference.md` were read.
- SDK: `sdk:openapi/boat-v1.yaml`, the Python and TS helpers, `http2-fetch.ts`, the README.
- Vendor: `vr:cloud-sandbox-vm-skills` (13 skills), `vr:kimi-box-plugin` (2 commands, 18 skills), `vr:optibox`, `vr:boat-convex`, `vr:harbor-box`, `vr:eve-box`, `vr:battleships` (cards, comparison), `vr:agent-server-release` (install scripts).
- Discrepancies in boat's sources: the request limit per IP is 1000/min versus 10 000/60 s (`docs:limits.md`); `provider` of prompt is required by the schema but optional by the text; `boat_starting` versus `sandbox_starting`.
