# Architecture: self-hosted sandbox platform for AI agents

Status: draft v0.1, 2026-10-29. Source of decisions: `research/07-decisions.md`. Documents in `research/` are research; where they disagree, this file is correct.

## 1. Goal and scope

An API platform that gives AI agents and people isolated VMs (sandboxes) on Proxmox VE. Agents inside a sandbox run commands and work with files and the desktop.

**OS types (templates):**

| Template | OS | Access |
|---|---|---|
| `linux` | Ubuntu 26.04 LTS (build: `docs/specs/s5-linux-template.md`) | exec, files, SSH |
| `linux-desktop` | Ubuntu + X11/openbox + Chrome (build: `docs/specs/s10-desktop.md`) | + desktop in the browser, computer-use |
| `windows` | Windows 11 (user-supplied image and license; build: `docs/specs/s9-windows.md`) | exec (PowerShell), files, SSH, desktop |
| `windows-core` | Windows Server 2025 Core (user-supplied image and license), **phase 2** (S9 §22) | exec (PowerShell), files, SSH |

**Not supported:** corporate deployments, external identity services, Kubernetes.

**Not in phase 1:** billing, public IPs for sandboxes, ZFS, Ceph, built-in coding agents (prompt/steer/events), AI credentials proxy, multi-region.

## 2. Components

```
 Users / agents / CI
   |  HTTPS (REST + NDJSON + WS)            browser
   v                                           |
 +---------------------------+       +---------v-----------+
 | apps/api   (Hono, Node)   |<----->| apps/web            |
 | public API, auth, keys    |       | Vite + React 19 SPA |
 +-------------+-------------+       | /app + settings     |
               |  Postgres           +---------------------+
 +-------------v-------------+
 | apps/worker (Node)        |  lifecycle, snapshots, auto-stop
 | pg-boss jobs              |
 +------+-------------+------+
        | PVE API     | node ops (LVM-thin, QMP)
 +------v-------------v------+         +---------------------------+
 | Proxmox node(s)           |         | services/gateway (Go)     |
 |  services/node-agent (Go) |         | - agent tunnels (WS)      |
 |  VMs: guest-agent (Go)  --+--WS---->| - HTTP *.umiak.<domain>     |
 |  SDN VNet + SNAT          |  out    | - SSH gateway             |
 +---------------------------+         | - TLS edge, L4 LB         |
                                       +---------------------------+
```

| Component | Language | Responsibility |
|---|---|---|
| `apps/api` | TS, Hono + `@hono/zod-openapi`, Node 24 | Public REST API, OpenAPI, authorization by owner sessions and scoped team API keys, NDJSON streams, terminal WebSocket. Source of OpenAPI for the SDKs |
| `apps/worker` | TS, pg-boss | Sandbox and machine state machines, Proxmox operations, snapshots and fork, auto-stop, cleanup |
| `apps/web` | TS, Vite + React 19 SPA | `/app/settings`: owner settings (templates, sizes, defaults, workspaces, keys). `/app`: dashboard (sandbox list, xterm.js terminal, desktop iframe, logs). Works with sandboxes only through `apps/api` |
| `apps/cli` | TS (Bun compile) | Client of the public API |
| `apps/mcp` | TS | MCP server on top of the public API and `@umiak/sdk`: stdio (`umiak mcp` in the CLI binary) and Streamable HTTP (`api.<domain>/mcp`, Deployment `mcp`); `docs/specs/s11-mcp.md` |
| `packages/sdk-ts`, `sdk-py` | generation + facades | From OpenAPI; helpers for waiting, reconnecting streams, uploads, PTY |
| `packages/auth` | TS | API key format, scopes, the `IdentityStore` interface (used by `api`) |
| `services/guest-agent` | Go | Agent inside the VM (Linux: systemd unit, Windows: service) |
| `services/gateway` | Go | Agent tunnel intake, HTTP port proxy, SSH gateway, TLS edge for `*.umiak`, `tunnel`, `ssh` (S2, S4). Desktop uses the agent tunnel |
| `services/node-agent` | Go | On each Proxmox node: LVM-thin operations, QMP, node metrics. In the PoC it can be replaced by an SSH executor with the same interface |
| Postgres | — | One DB: API-owned configuration and operations in schema `runtime`; legacy `payload` retained unread for upgrades |

## 3. Data model (runtime, schema `runtime`)

In detail: `docs/specs/s6-control-plane.md`.

- **Sandbox** — the logical entity for the user: `id`, `slug` (for URL and hostname), `template`, `size`, `state`, `health`, `activity`, TTL and idle-stop, labels, current `machineId`. Env and secrets are in a separate table, encrypted (AES-256-GCM).
- **Machine** — a concrete VM: `id` (= `machineId` in smbios), `vmid`, `node`, `provider` (cluster), MAC, `state` (provisioning / booting / claiming / running / stopped / deleting …). The binding to a sandbox is set once and does not change; a sandbox may have several machines over its history (groundwork for migration).
- **Provider / Node / Storage** — topology: Proxmox cluster, node, storage with a driver. The model is designed for several clusters and nodes; S19 enables several sandbox nodes in one cluster, while the PoC used one node.
- **TemplateBuild** — a template build on a node (template VMID, disk layout, agent version, manifest), written by S5: `building → ready → active → deprecated → retired` (or `failed`), details in `docs/specs/s5-linux-template.md` §11–§12.
- **Disk** — an LV on the node: belongs to a machine or a snapshot.
- **Snapshot** — a set of LV snapshots of all disks of a machine: `kind` (saved / fork_source; `auto` is reserved for phase 2), `name` for saved.
- **Operation** — an operation on a sandbox (create, fork, stop, resume, recover, delete, save_snapshot); one active per sandbox, delete preempts.
- **Command** — a process: `id`, `sandboxId`, `cmd`, `cwd`, env variable names, `mode`, `status`, `exitCode`, `startedAt`, `endedAt`. The agent stores the output, later a copy goes to storage.
- **HostedPort** — a sandbox port published at a URL: `port`, `label`, mode `token` / `sso` / `public`.
- **User**, **Team**, **Membership** (`owner`/`member`), **ApiKey**, **SshKey** and configuration — **Template**, **Size**, team quotas, `PlatformDefaults` — are in the API-owned schema `runtime` (`docs/specs/s24-spa-no-payload.md`); `api` and `worker` use shared SQL `IdentityStore`/`ConfigReader` adapters, invalidated by transactional `NOTIFY` with a TTL fallback.
- **Environment** — a named set of env, secrets, and secret files of a team, plus a list of repositories (in the MVP only stored, the clone is S13, phase 2) and the flag `excludeOwnerSecrets`; stored in `runtime.environments` encrypted like `sandbox_secrets` (key rotation re-encrypts them too), managed through `/v1/environments`; on create the values are copied into the sandbox (S8 §10).

**Sandbox states:** `creating → ready → stopping → stopped → starting → ready`. Plus `error` and `deleting → deleted`. `fork` creates a new sandbox in `creating`. Health (`health: ok | degraded`, degraded — no agent for more than 60 s) and activity (`activity: busy | idle`) are separate fields, not states.

## 4. Guest agent (Go)

In detail: `docs/specs/s3-guest-agent.md` (Linux), `docs/specs/s9-windows.md` §12 (Windows). Runs as root or SYSTEM. Commands by default run as the unprivileged `user` with NOPASSWD sudo (the trust boundary is the VM, S2 §16). Installed into the template.

- **Transport.** The agent itself opens a WSS to `gateway`; inside it is HTTP/2 where the agent is the server. No inbound ports. RPC (exec, files) and TCP streams (ports, SSH, moonlight) go over the connection. See below and S2.
- **Boot registration.** On boot the agent connects to the gateway and reports itself (machineId, bootId, vmgenid, version); it does not know its VMID. The worker waits for boot readiness before claim.
- **Claim.** Receives env, secrets (in tmpfs without swap or in a protected directory; after every reboot the control plane sends them again), secret files, the gateway SSH CA public key (`TrustedUserCAKeys`; user keys are verified by the gateway, S4 §9), hostname. Reports readiness by phases.
- **Exec.** sync / stream (NDJSON events `started`, `stdout`, `stderr`, `exit`) / detached + attach by offset / kill / timeout. Linux — bash, Windows — PowerShell. PTY/ConPTY for the terminal. Each command runs in its own systemd unit under a shim that writes its output to files.
- **Files.** read, write (stream), list, stat, delete, mkdir, move, chmod, a directory as a single tar stream in both directions (`/files/archive`).
- **Ports.** List of listening ports; proxying inbound streams to `localhost:port` (127.0.0.1, then ::1, then interface addresses).
- **Snapshot hooks.** `quiesce` (Docker pause, fsfreeze / VSS) and `thaw`, with an auto-thaw watchdog. QEMU guest agent fsfreeze is the fallback when the agent is absent.
- **Identity change.** On boot, before the network starts, the agent sees a change of `machineId` in smbios (fork, VM from a saved snapshot) and changes the hostname, machine-id, and SSH host keys, and wipes its state. On Windows instead: the computer name `UMI<12 hex>`, `MachineGuid`, and host keys; the rename requires one reboot, so the hostname from claim is not applied on Windows (S9 §11). The change is detected by `machineId`; vmgenid on Windows is read but informational only.
- **Health.** Heartbeat, CPU/RAM/disk, idle indicator.
- **Self-update.** An ed25519-signed package (binary + tunnel CA bundle) arrives through the tunnel; a failed version rolls itself back.

The model for the process and file API is E2B `envd` (Go, Apache-2.0).

### Tunnel and connection drops

In detail: `docs/specs/s2-tunnel-protocol.md`. Principle: **state lives in the agent, not in the connection.** A tunnel drop is a normal situation, no data is lost.

- **Transport.** The agent opens `wss://tunnel.<domain>/v1/connect` (443). Inside the WebSocket the roles are inverted: the agent is the HTTP/2 server, the gateway is the HTTP/2 client (like Cloudflare Tunnel). HTTP/2 gives multiplexing, flow control, PING, and CONNECT for TCP streams. Agent RPC is Connect-RPC from one proto for Go and TS. For RPC the gateway is a reverse proxy and does not parse bodies. The transport is hidden behind an interface: userspace WireGuard can be substituted.
- **Authentication.** The bootstrap secret (BS) is in the VM's `smbios1` and does not reach the guest disk. The machine token (MT) lives only in agent memory, is reissued at claim and every 24 h. Fork and snapshots do not carry credentials. The gateway presents a certificate from the private tunnel CA, and the agent verifies it against the pinned CA.
- **Drop detection.** WebSocket ping from the agent every 5 s, the connection is dead after 15 s; h2 PING from the gateway side; TCP keepalive.
- **Reconnect.** Backoff 0.25 s → 10 s with full jitter. One active connection per machine, the new one gets `epoch+1`. The combination of `connId`, `agentInstanceId`, `bootId`, and `machineId` distinguishes a drop from an agent restart, reboot, and fork.
- **Processes do not depend on the connection.** Each command runs under a shim (Linux: systemd scope; Windows: job object) that writes output to files with monotonic byte offsets and survives an agent restart.
- **Resumable streams.** `agent-client` in the API itself continues attach by `commandId` and offset, the client sees a pause. `exit` arrives only after all output. A PTY lives 10 minutes without a client.
- **Idempotency.** `commandId` is created by the control plane and also serves as the `Start` key. Mutating unary calls carry `Umiak-Request-Id`, the agent keeps responses on disk for 24 h. Files resume via `Range` and offset chunks.
- **API behavior during a drop.** A call waits for the agent up to 30 s, then `503 agent_unavailable` with `retryable: true`. The sandbox is `degraded` if there is no agent for more than 60 s.
- **Several gateways.** A `machineId → gatewayInstance` registry in Postgres (`tunnel_sessions`, `gateway_instances`, `NOTIFY`), Redis is not needed. On a gateway pod deploy, `preStop` calls `Control/Drain` on the agents. Agents reconnect make-before-break, the old pod answers `421 machine_moved`, streams continue by offset.
- **Agent events.** A durable journal with `seq` on the agent; the gateway delivers it to `api` at-least-once.
- **What breaks.** Raw TCP streams (SSH, application WebSocket, in-flight HTTP) are closed on a drop. Resuming them is phase 2.
- **Fallback channel without network.** QEMU guest agent through Proxmox (virtio-serial): check state, read the agent log, restart the agent. Further — `recover`: reboot the VM.

## 5. Storage: the `lvmthin` driver

Driver interface: `cloneFromTemplate`, `snapshot`, `cloneFromSnapshot`, `delete`, `usage`. A second driver (ZFS or Ceph) comes later, behind the same interface.

- **Template** — LV disks of the template VM (`base-*`): `scsi0`, `efidisk0`, `tpmstate0`.
- **New machine** = a thin snapshot of each template disk, activated as writable, + a VM config with a new VMID and MAC. Done through `node-agent`, not `qm clone`, to avoid Proxmox locks and races.
- **Snapshot of a running machine:** `guest-agent quiesce` → `lvcreate -s` for all disks → `thaw`. Freeze duration is seconds.
- **Fork** = snapshot + a new machine from those LVs. Thin snapshots do not depend on the original, it can be deleted.
- **Stop** = VM shutdown, LVs stay on the node. **Resume** = start of the same VM.
- **Saved snapshot / user template** = a named snapshot from which new sandboxes are created.
- **Templates and capacity waits (S21):** Build once and copy base disks via restricted node-agent volume.sendTo: standard pvesm raw+size export/import, zstd and pinned cluster SSH. Streaming SHA-256 and UUID-bound receipts precede publication. Resume/fork/saved-snapshot create stay on the node holding disks; optional per-team FIFO waits reserve RAM only on admission. Sandbox cold moves are deferred (future options: pvesm, rsync over a base snapshot, or a ZFS driver with zfs send -i).

## 6. Cold create

Every create reserves RAM, clones the template (or saved snapshot), boots,
rotates the machine token and claims through the agent. Claim injects environment,
secrets and credentials before the sandbox becomes ready. Cold create latency of
about one minute is acceptable. Warm pools, pool-only admission and eviction are
not part of the product.

Admission counts reserved and powered RAM; it never evicts another VM. Legacy
unallocated pool rows remain quarantined and counted, with an operator-visible
count in `umiak-admin node ram`. Allocated legacy machines may finish claim.
Legacy storage remains for compatibility; no VM is deleted based on pool metadata.

## 7. Network

- Each node has its own local NAT network for sandboxes: Proxmox SDN **Simple zone** + VNet with SNAT, DHCP, and **Isolate Ports**. The subnet may repeat on different nodes, as in boat (`192.168.122.0/24` on each host). No public IPs.
- An inter-node L2 network (VXLAN/EVPN) is not needed: VMs do not talk to each other directly, and the control plane does not reach them by IP — everything goes through the agent's outbound tunnel.
- Firewall: sandboxes do not see each other (isolate ports), the LAN, or the host management interface; outbound internet is allowed; no inbound.
- Instead of SDN one can manually configure a bridge without a physical port, nftables masquerade, and dnsmasq. The result is the same; SDN was chosen because it is managed through the Proxmox API.
- All inbound traffic goes through the agent tunnel to `gateway`:
  - **HTTP:** `https://<slug>-<port>.umiak.<domain>` → any gateway pod → tunnel (locally or via the owner pod) → `localhost:port`. Access modes `token`, `sso`, `public`. In detail: `docs/specs/s4-gateway.md`.
  - **SSH:** `ssh <sandbox>@ssh.<domain>` → the gateway terminates SSH and verifies a short-lived certificate from `api` or the user key via `api` → tunnel → the VM's system sshd on `127.0.0.1:22` with a short-lived certificate from the gateway SSH CA (`TrustedUserCAKeys`). User keys are not copied into the VM.
  - **Desktop:** moonlight-web signaling through the tunnel (`<slug>-desktop.umiak`); WebSocket media through the gateway and agent tunnel (S18).

## 8. Desktop and computer-use

In detail: `docs/specs/s10-desktop.md`.

- Linux and Windows: Sunshine (screen capture, x264 on CPU) + moonlight-web (WebRTC to the browser), upstream without a fork, only on the VM loopback. The streamer starts on demand.
- A desktop link with a one-time 10 min ticket, embedded in a dashboard iframe. Access modes `token`, `sso` (team only), `public` (off by default).
- The computer-use API (screenshot, mouse, keyboard, clipboard) consists of the agent's own primitives via the `umiak-session` helper in the user session (Linux and Windows), independent of the streamer. The MCP wrapper is in `apps/mcp`.
- cua-driver (MIT) is installed into templates as an MCP for agents inside the VM (registration — S15).
- Windows: autologon of the agent user, disabled lock screen and UAC prompts in the template; the `umiak-session` helper in the interactive session (phase `desktop`, S9 §13).

## 9. Public API (v1, summary)

In detail: `docs/specs/s7-public-api.md`.

- `/v1/sandboxes` (create, get with long-poll, list, update, delete, `stop`, `resume`, `fork`, `recover`, `extend`, `env`), `/v1/operations`, `/commands` (sync, NDJSON stream, detached, attach by offset, output, input, kill), `/ptys` (WebSocket), `/files` (Range, streaming write, chunked upload, directory tar, list/stat/mkdir/move/chmod/delete), `/ports`, `/ssh`, `/desktop` (links, access, screenshot, actions, clipboard; S10 §13), `/v1/ssh-keys`, `/v1/snapshots` (saved), `/v1/environments`, `/v1/templates`, `/v1/sizes`, `/v1/api-keys`, `/v1/me`, `/v1/limits`, `/v1/meta`. Semantics as in boat (`research/03-api-sdk-surface.md`), own format, not wire-compatible.
- IDs with prefixes (`sb_`, `op_`, `cmd_`, `snap_`, `key_`), a slug can be passed in the path. Resources without a wrapper, lists `{data, nextCursor}`, errors `{error: {code, message, retryable, details, requestId}}`. `Idempotency-Key` for create, fork, and commands: a retry does not run the command twice. Deleting a sandbox and a saved snapshot only with `Umiak-Confirm-Delete: <id>`. The CLI without a TTY prints JSON and JSONL (S7 §14.3).
- Three `api` listeners: public (owner session and team keys), private browser listener (owner ingress, Origin check), internal (gateway, service tokens).
- OpenAPI is generated from zod schemas; the TS SDK (`openapi-typescript` + `openapi-fetch`) and Python (`openapi-python-client`) with handwritten helpers; the `umiak` CLI on the TS SDK via Bun compile.

## 10. Deployment and authentication

Umiak is homelab-only. `curl … install.sh | sh` on a Proxmox VE node creates
an LXC running the root Compose stack. The installer manages updates, owner
recovery, Tailscale access and uninstall. See `docs/getting-started.md`.

The control plane is reachable only over the owner's tailnet. A one-time claim
link establishes the first browser session. Additional browsers use one-time
sign-in codes, and `umiak login` pairs a CLI credential with an already claimed
owner browser. Sessions and paired credentials can be revoked independently.
The installer can recover ownership without any external identity service.

The quickstart ingress verifies the owner cookie or paired credential, checks
client networks, removes forged identity headers and forwards requests to the
private API, MCP and web listeners. Those listeners verify their trusted ingress
peer or the ingress's client stamp and enforce Origin checks. Public metadata
advertises `authMode: owner` and `tenancy: single`.

The API owns configuration and serves the static React dashboard through the
existing owner ingress. Setup/claim/pairing/recovery stay in quickstart (S24b). The owner has a stable
internal session subject (`umiak:local`), operator rights and a personal team.
Teams, memberships, scoped team API keys and their quotas remain part of the
internal authorization model. They are not a second login mechanism.

Published port access `sso` is the wire name for owner-session access; it uses
the owner ingress and the gateway's short-lived access codes. It has no
external sign-in provider or configurable corporate port policy. `token` and
`public` port access remain available subject to platform settings.

S19 adds sandbox nodes through the original root installer console. The source of truth is `runtime.nodes/storages/providers`; install-state records installation bookkeeping. The PVE token and forced-command SSH key are shared within the cluster; SSH endpoints, pinned host keys, LVM-thin and media storage are per node. Preparation validates configuration and persists a cordoned reservation before checking local DHCP/SNAT, the guest listener and restricted RPC, then activating the node and copying active templates (S21); nodes without a verified local build are not cold-placement candidates. A template build reserves an idle node and uses the shared PostgreSQL allocator; an interrupted build continues to block starts. Removing the sandbox role preserves topology/history and refuses while machines, snapshots, templates, build jobs or leases remain. The control-plane CT is independent of this role. Details: `docs/specs/s19-multi-node.md`, `docs/operations-multi-node.md`.

Desktop streaming uses WebSocket through the gateway and agent tunnel (S18).
It needs no media relay service or separate media address.

## 11. Security

- Team API keys with "resource × action" scopes (`sandboxes:read`, `commands:exec`, …) and a mandatory lifetime, stored as hashes in `runtime.api_keys`. People have no long-lived keys: the CLI works with short-lived owner sessions. The key type `sandbox` (one sandbox, for the CLI inside the VM) is reserved and not issued in the MVP (S7 §7.2–7.3).
- Each machine has its own bootstrap secret in `smbios1` and a machine token for the tunnel only in agent memory; the token is reissued at claim. A machine is not reused between sandboxes (S2).
- Secrets in the guest are in tmpfs (Linux). On Windows `secret_env` is in memory only, `secret_files` are in a directory with an ACL (SYSTEM and `user`), wiped on every boot before user login, at stop, and before a saved snapshot; pagefile cleared at shutdown. Remnants in the pagefile and NTFS metadata of a snapshot of a running VM are an accepted risk (S9 §12.8).
- Proxmox: a separate user and API token with rights only on the pool `umiak` and the needed storages.

## 12. Phases

| Phase | Contents |
|---|---|
| **PoC** (homelab `pve`) | Template `linux`, guest-agent v0 (tunnel, exec, files), gateway (tunnels, HTTP ports), worker (cold create, claim, delete), lvmthin driver (clone from template, snapshot, fork), minimal API and CLI. Measurements: claim-to-ready, cold start, fork |
| **MVP** | + `windows`, `linux-desktop`; stop/resume, saved snapshots, SSH gateway, desktop, computer-use API (screenshot, mouse, keyboard, clipboard), owner settings/dashboard, API keys, auto-stop, TS/Python SDKs, MCP |
| **Phase 2** | `windows-core` (Windows Server Core, S9 §22), several nodes and clusters, PBS archive and migration, computer-use v2 and desktop v2 (S29), command history outside the VM, built-in coding agents, egress policies, OTel, webhooks |

## 13. Open questions

- PoC resources on `pve`: RAM, VMID range, consent to host changes (user and token, SDN, pool).
- Domain for `*.umiak`: `umiak.<domain>` by default; a separate registrable domain is Ilia's choice, possible later (S4 §14.1). Tailnet HTTPS is configured by the installer; custom wildcard DNS/TLS remains deferred.
- ~~SSH in the guest: system sshd or a built-in SSH server in the agent.~~ Decided in S4: system sshd on loopback with certificates from the gateway SSH CA.
