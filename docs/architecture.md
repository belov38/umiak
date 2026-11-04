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

**Not in phase 1:** billing, public IPs for sandboxes, ZFS, Ceph, built-in coding agents (prompt/steer/events), AI credentials proxy, multi-region.

## 2. Components

```
 Users / agents / CI
   |  HTTPS (REST + NDJSON + WS)            browser
   v                                           |
 +---------------------------+       +---------v-----------+
 | apps/api   (Hono, Node)   |<----->| apps/web            |
 | public API, auth, keys    |       | Next.js + Payload 3 |
 +-------------+-------------+       | /admin  /app        |
               |  Postgres           +---------------------+
 +-------------v-------------+
 | apps/worker (Node)        |  warm pool, lifecycle, snapshots, auto-stop
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
                                         coturn (TURN) — a separate service (S10)
```

| Component | Language | Responsibility |
|---|---|---|
| `apps/api` | TS, Hono + `@hono/zod-openapi`, Node 24 | Public REST API, OpenAPI, authorization by Keycloak JWT and team API keys, NDJSON streams, terminal WebSocket. Source of OpenAPI for the SDKs |
| `apps/worker` | TS, pg-boss | Sandbox and machine state machines, warm pool, Proxmox operations, snapshots and fork, auto-stop, cleanup |
| `apps/web` | TS, Next.js + Payload 3 | `/admin`: operators (users, teams, keys, templates, sizes, quotas). `/app`: customer dashboard (sandbox list, xterm.js terminal, desktop iframe, logs). Works with sandboxes only through `apps/api` |
| `apps/cli` | TS (Bun compile) | Client of the public API |
| `apps/mcp` | TS | MCP server on top of the public API and `@umiak/sdk`: stdio (`umiak mcp` in the CLI binary) and Streamable HTTP (`api.<domain>/mcp`, Deployment `mcp`); `docs/specs/s11-mcp.md` |
| `packages/sdk-ts`, `sdk-py` | generation + facades | From OpenAPI; helpers for waiting, reconnecting streams, uploads, PTY |
| `packages/auth` | TS | API key format, scopes, the `IdentityStore` interface (shared by `api` and `web`) |
| `services/guest-agent` | Go | Agent inside the VM (Linux: systemd unit, Windows: service) |
| `services/gateway` | Go | Agent tunnel intake, HTTP port proxy, SSH gateway, TLS edge for `*.umiak`, `tunnel`, `ssh` (S2, S4). TURN is a separate coturn (S10) |
| `services/node-agent` | Go | On each Proxmox node: LVM-thin operations, QMP, node metrics. In the PoC it can be replaced by an SSH executor with the same interface |
| Postgres | — | One DB: the Payload schema (configuration) + the API schema (runtime) |

## 3. Data model (runtime, schema `runtime`)

In detail: `docs/specs/s6-control-plane.md`.

- **Sandbox** — the logical entity for the user: `id`, `slug` (for URL and hostname), `template`, `size`, `state`, `health`, `activity`, TTL and idle-stop, labels, current `machineId`. Env and secrets are in a separate table, encrypted (AES-256-GCM).
- **Machine** — a concrete VM: `id` (= `machineId` in smbios), `vmid`, `node`, `provider` (cluster), MAC, `state` (provisioning / booting / warm / claiming / running / stopped / deleting …). The binding to a sandbox is set once and does not change; a sandbox may have several machines over its history (groundwork for migration).
- **Provider / Node / Storage** — topology: Proxmox cluster, node, storage with a driver. The model is designed for several clusters and nodes; S19 enables several sandbox nodes in one cluster, while the PoC used one node.
- **TemplateBuild** — a template build on a node (template VMID, disk layout, agent version, manifest), written by S5: `building → ready → active → deprecated → retired` (or `failed`), details in `docs/specs/s5-linux-template.md` §11–§12.
- **Disk** — an LV on the node: belongs to a machine or a snapshot.
- **Snapshot** — a set of LV snapshots of all disks of a machine: `kind` (saved / fork_source; `auto` is reserved for phase 2), `name` for saved.
- **Operation** — an operation on a sandbox (create, fork, stop, resume, recover, delete, save_snapshot); one active per sandbox, delete preempts.
- **Command** — a process: `id`, `sandboxId`, `cmd`, `cwd`, env variable names, `mode`, `status`, `exitCode`, `startedAt`, `endedAt`. The agent stores the output, later a copy goes to storage.
- **HostedPort** — a sandbox port published at a URL: `port`, `label`, mode `token` / `sso` / `public`.
- **User**, **Team**, **Membership** (`owner`/`member`), **ApiKey**, **SshKey**, team notices (`team-notices`) and configuration — **Template**, **Size**, team quotas, warm pool targets (empty in the MVP), `PlatformDefaults` — are in Payload (schema `payload`, `docs/specs/s8-web.md` §7); `api` and `worker` read them through the Payload Local API (`IdentityStore`, `ConfigReader`, cache 10–30 s, invalidated by `NOTIFY`).
- **Environment** — a named set of env, secrets, and secret files of a team, plus a list of repositories (in the MVP only stored, the clone is S13, phase 2) and the flag `excludeOwnerSecrets`; stored in `runtime.environments` encrypted like `sandbox_secrets` (key rotation re-encrypts them too), managed through `/v1/environments`; on create the values are copied into the sandbox (S8 §10).

**Sandbox states:** `creating → ready → stopping → stopped → starting → ready`. Plus `error` and `deleting → deleted`. `fork` creates a new sandbox in `creating`. Health (`health: ok | degraded`, degraded — no agent for more than 60 s) and activity (`activity: busy | idle`) are separate fields, not states.

## 4. Guest agent (Go)

In detail: `docs/specs/s3-guest-agent.md` (Linux), `docs/specs/s9-windows.md` §12 (Windows). Runs as root or SYSTEM. Commands by default run as the unprivileged `user` with NOPASSWD sudo (the trust boundary is the VM, S2 §16). Installed into the template.

- **Transport.** The agent itself opens a WSS to `gateway`; inside it is HTTP/2 where the agent is the server. No inbound ports. RPC (exec, files) and TCP streams (ports, SSH, moonlight) go over the connection. See below and S2.
- **Pool registration.** On boot the agent connects to the gateway and reports itself (machineId, bootId, vmgenid, version); it does not know its VMID. The machine becomes warm.
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
- **Disk locality:** LVs, snapshots, fork and resume remain on the machine's home node. S19 places new sandboxes across nodes of one cluster by free RAM when an active local template build is available. Cross-node migration and archive come later, through Proxmox Backup Server.

## 6. Warm pool

- For each (template, size) pair we keep N booted machines in the warm status. The agent is connected, the OS is ready.
- **Create** = claim a warm machine (milliseconds + provisioning through the agent) → `ready`. If the pool is empty — cold start: template clone and boot, Linux ~15–30 s, Windows 3–5 min (specialize and first login). With `failFast` — pool only, otherwise `503 pool_exhausted`, nothing is created (phase 2: the MVP has no warm pool, `failFast` and `pool_exhausted` are not part of the public contract, S7 §23.1).
- The pool is refilled in the background with a limit on parallel clones per node and storage.
- Fork and resume bypass the pool: they have their own disks.
- Windows pool machines sleep on disk (`qm suspend --todisk`) and take no RAM; claim = RAM admission, wake-up, clock sync, claim (S9 §14). The decision is confirmed by a spike during implementation.
- RAM accounting on a node: running + warm + booting machines ≤ the node limit (8 GB in the PoC). The pool is refilled only from free RAM. Create or resume under shortage evicts warm machines of other (template, size) pairs, otherwise `503 out_of_capacity`.
- The machine identity (`machineId`, bootstrap secret in smbios) is set when the machine is prepared for the pool; at claim the worker rotates the machine token and passes env, secrets, and SSH keys to the agent.
- A new template build changes the pool generation: old warm machines are replaced, sandboxes on the old build are not touched.
- In detail: `docs/specs/s6-control-plane.md` §9.

## 7. Network

- Each node has its own local NAT network for sandboxes: Proxmox SDN **Simple zone** + VNet with SNAT, DHCP, and **Isolate Ports**. The subnet may repeat on different nodes, as in boat (`192.168.122.0/24` on each host). No public IPs.
- An inter-node L2 network (VXLAN/EVPN) is not needed: VMs do not talk to each other directly, and the control plane does not reach them by IP — everything goes through the agent's outbound tunnel.
- Firewall: sandboxes do not see each other (isolate ports), the LAN, or the host management interface; outbound internet is allowed; no inbound.
- Instead of SDN one can manually configure a bridge without a physical port, nftables masquerade, and dnsmasq. The result is the same; SDN was chosen because it is managed through the Proxmox API.
- All inbound traffic goes through the agent tunnel to `gateway`:
  - **HTTP:** `https://<slug>-<port>.umiak.<domain>` → any gateway pod → tunnel (locally or via the owner pod) → `localhost:port`. Access modes `token`, `sso`, `public`. In detail: `docs/specs/s4-gateway.md`.
  - **SSH:** `ssh <sandbox>@ssh.<domain>` → the gateway terminates SSH and verifies a short-lived certificate from `api` or the user key via `api` → tunnel → the VM's system sshd on `127.0.0.1:22` with a short-lived certificate from the gateway SSH CA (`TrustedUserCAKeys`). User keys are not copied into the VM.
  - **Desktop:** moonlight-web signaling through the tunnel (`<slug>-desktop.umiak`); WebRTC media through a separate TURN (coturn, relay only between its own allocations), fallback transport — WebSocket through the gateway and the tunnel (S10 §9).

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
- Three `api` listeners: public (Keycloak JWT and team keys), behind oauth2-proxy (browser, Origin check), internal (gateway, service tokens).
- OpenAPI is generated from zod schemas; the TS SDK (`openapi-typescript` + `openapi-fetch`) and Python (`openapi-python-client`) with handwritten helpers; the `umiak` CLI on the TS SDK via Bun compile.

## 10. Deployment and authentication

The default mode is `UMIAK_AUTH_MODE=oidc` (described below). The `owner` mode
(home setup, S18 installer, root `compose.yaml`) is a single owner/operator behind a trusted
ingress (`deploy/compose/quickstart/server.mjs`): the backend accepts only the
socket peer of the ingress from `UMIAK_LOCAL_ALLOWED_CIDRS` and runs under the fixed
identity `umiak:local`, without Keycloak and oauth2-proxy.

### Homelab mode (S18)

The home setup is installed with one command on a Proxmox VE 9 node (`install.sh` → the Python installer `deploy/installer`, a release bundle from GitHub with `SHA256SUMS` verification). The installer creates Umiak objects in PVE (user and token `umiak@pve`, roles, pool `umiak`, SDN zone `umiak` / VNet `umiak0` `10.88.0.0/24`, IPSet `umiak-gateway`, group `umiak-egress`) and a restricted `node-agent`. The control plane is an unprivileged Debian 13 LXC with Docker and Tailscale; the root `compose.yaml` pulls the published GHCR images (`UMIAK_VERSION`) into `/opt/umiak`. Tailscale runs inside the CT, not on the PVE host.

Access is only over tailnet HTTPS (`https://umiak.<tailnet>.ts.net`, Tailscale Serve → trusted ingress `quickstart` :4181). `owner` mode: one owner, claim through a one-time link `/claim#<code>`, cookie `__Host-umiak_owner`. Emergency path: an SSH tunnel to :4180 (Host `localhost` only). Port previews — `http://<slug>-<port>.<tailnet-ip-dashed>.sslip.io:8085` over the tailnet, SSH — tailnet IP :2222. The desktop is embedded in the dashboard on the same origin (`/desktop/<slug>/`): the ingress serves its own trusted copy of the moonlight-web frontend and passes from the guest only JSON/SDP/NDJSON/binary, not HTML and JS. Browser wizard: Templates and Smoke test. Day 2 (Update, new browser, owner reset, Uninstall) is a rerun of the installer. Spec: `docs/specs/s18-onboarding.md`.

S19 adds sandbox nodes through the original root installer console. The source of truth is `runtime.nodes/storages/providers`; install-state records installation bookkeeping. The PVE token and forced-command SSH key are shared within the cluster; SSH endpoints, pinned host keys, LVM-thin and media storage are per node. Preparation validates configuration and persists a cordoned reservation before checking local DHCP/SNAT, the guest listener and restricted RPC, then activating the node. A template build reserves an idle node and uses the shared PostgreSQL allocator; an interrupted build continues to block starts. Removing the sandbox role preserves topology/history and refuses while machines, snapshots, templates, build jobs or leases remain. The control-plane CT is independent of this role. Details: `docs/specs/s19-multi-node.md`, `docs/operations-multi-node.md`.

**S20 packaging:** two published images: `umiak-quickstart` (shared runtime for
API, worker, MCP, ingress, gateway, web-meta, offline bootstrap and renewal;
different commands, separate processes, and the previous mounts/networks) and `umiak-web`
(Next standalone + Payload migrations). MCP has no secrets and talks to the
public REST API; merging the image does not merge the processes. Postgres is an
upstream image. See `docs/specs/s20-cp-consolidation.md`.

**The control plane runs in Kubernetes:** `api`, `worker`, `web`, `gateway`, `mcp`, Keycloak (IdP, operations — S12). Postgres is in the cluster (operator) or external. Proxmox nodes, VMs, and `umiak-node` stay outside Kubernetes.

**IdP — Keycloak** (Ilia's decision 2026-10-29), one realm `umiak`. Later it may broker a corporate IdP (Google, Entra, LDAP); not in the MVP. Roles and teams come from Keycloak groups and claims (S8 §5).

**Users (browser) — through oauth2-proxy** (provider `keycloak-oidc`, `--cookie-refresh=5m`: a user disabled in Keycloak loses the dashboard and `/admin` within 5 min).
- `web` (`/admin`, `/app`) and browser API calls are fronted by oauth2-proxy.
- The user is created at first login (JIT) from oauth2-proxy headers: `X-Auth-Request-Email`, `-User`, `-Groups`. This is a custom Payload auth strategy; the API reads the same user.
- Roles come from Keycloak groups: a group from `UMIAK_OPERATOR_GROUPS` → platform operator. Operator rights (including blocks and `allTeams`, S8 §17.1 C3) apply only in a browser session, not by API key and not by the CLI JWT. Teams and `owner`/`member` roles are in Payload; a personal team is created at first login (S8 §6).
- We trust headers only from oauth2-proxy. Direct access to pods is closed by NetworkPolicy. oauth2-proxy runs in upstream mode and routes `app.<domain>`: `/api/*` (without `/api`), `/umiak-auth/*` → `api :8081`, the rest → `web` (S8 §5.1).

**People in the CLI, SDK, and MCP — Keycloak JWT, no personal long-lived keys** (S7 §7.6, §7.10). The remote MCP accepts the same JWT; browser login uses the client `umiak-mcp` (S11 §6.4).
- `umiak login` — OAuth 2.0 Device Authorization Grant with the public client `umiak-cli`. The access token lives 5 min, the refresh token is bound to the Keycloak SSO session and stored in the OS keychain (fallback — a `0600` file). The SDK and MCP get the token from the CLI (`umiak auth token`).
- `api` verifies the JWT itself (JWKS, `iss`, `aud=umiak-api`, `exp`), no introspection per request; `sub` → the same Payload user as in the browser. A disabled user cannot refresh the token: access ends within 5 min.

**Automation and CI — team keys `umiak_`** (S7 §7.2). Owned by the team, issued by an `owner` in the dashboard, the creator is recorded for audit; "resource × action" scopes, lifetime 90 d by default, maximum 365 d. The creator leaving does not disable the keys, `owner`s revoke them.

`/v1/*` routes with `Authorization: Bearer` (JWT or `umiak_`) go to `api.<domain>` bypassing oauth2-proxy: oauth2-proxy is for the browser only. The paths `/mcp` and `/.well-known/oauth-protected-resource/mcp` on the same host go to the `mcp` Deployment (S11 §6.2).

**Deactivation (offboarding, option A, S8 §20.1).** `worker` reads users through the Keycloak Admin API (client `umiak-worker`) every 5 min. A disabled or deleted user is deactivated in Payload; their streams, PTYs, and SSH sessions are closed immediately; the `owner`s of their teams get the list of team keys the user created. Keys are not revoked automatically.

**Keycloak settings** (realm `umiak`, Keycloak 26.8; installed by S12):

| What | Setting |
|---|---|
| Shared client scope `groups` | Group Membership mapper → claim `groups`, Full group path off; attached by default to `oauth2-proxy`, `umiak-cli`, and `umiak-mcp` so that the browser and the CLI get groups in the same format |
| Client `oauth2-proxy` | confidential (Client authentication on), Standard flow; Audience mapper to itself; scope `groups` |
| Client `umiak-cli` | public (Client authentication off), only OAuth 2.0 Device Authorization Grant; Audience mapper (Included Client Audience `umiak-api`, Add to access token); default scopes `basic` (`sub`), `email`, `profile`, `groups`; `offline_access` removed from both default and optional (the refresh does not outlive the SSO session); lightweight access token off |
| Client `umiak-mcp` | public, only Standard flow (authorization code) with PKCE `S256`; redirect URIs `http://127.0.0.1:33418/*`, `http://localhost:33418/*`; Audience mapper `umiak-api`; scopes and the `offline_access` ban as for `umiak-cli`; login to the remote MCP via the browser (S11 §6.4) |
| Client `umiak-api` | audience only: no flow, gets no tokens itself |
| Client `umiak-worker` | confidential, Service accounts only; role `view-users` of client `realm-management` |
| Lifetimes | Access Token Lifespan 5 min; SSO Session Idle 24 h; SSO Session Max 7 d (CLI login once a week, with daily use); Client Session Idle/Max as in the realm; Revoke Refresh Token off (the CLI refreshes under a lock); device code 600 s, polling interval 5 s |
| Users | email required and verified; the operator group is `UMIAK_OPERATOR_GROUPS` |

**Bypassing oauth2-proxy (own authentication):**
- `tunnel.<domain>`: agent tunnels (WSS, bootstrap secret / machine token, see S2).
- The internal gateway listener (ClusterIP) for `api` and `worker` calls, authorized by service tokens.
- `*.umiak.<domain>`: public port URLs. Access modes: `token` (as in boat), `sso` (login via oauth2-proxy on the main domain and a one-time code, the IdP cookie does not reach umiak), `public`.
- `ssh.<domain>`: SSH gateway. Login with short-lived SSH certificates that `api` issues from a person's JWT or a team key, or with a person's registered key; identity is verified by `api` on every connection (S4 §9.2, S7 §11.3).

**Edge gateway.** `tunnel.<domain>`, `*.umiak.<domain>`, and `ssh.<domain>` go not through the ingress but through a separate L4 LoadBalancer Service `gateway-edge` (443 and 22; client IP via PROXY protocol v2 or `externalTrafficPolicy: Local`). TLS is terminated by the gateway itself: wildcard `*.umiak` from cert-manager (DNS-01), `tunnel` from the tunnel CA. A fallback "behind ingress" mode is supported (S4 §5). All platform cookies on the main domain are host-only with the `__Host-` prefix, otherwise code in a sandbox could plant them (S4 §14.1).

**Gateway deploy.** Rolling update: `preStop` starts the drain (S2, S4 §10). HTTP streams live up to 2 min, SSH sessions up to 15 min with a warning, `terminationGracePeriodSeconds: 960`.

**Network.** `worker` reaches the Proxmox API (`:8006`) and `umiak-node` over SSH from the cluster (secrets in a Kubernetes Secret). The sandbox network allows outbound connections only to the `gateway-edge` address (`tunnel.<domain>:443`, IPSet `umiak-gateway`). TURN (UDP) for the desktop is a separate coturn `turn.<domain>` with hostNetwork on a dedicated node or a UDP LoadBalancer (S12); sandboxes reach it over UDP 3478 (IPSet `umiak-turn`, S10 §9.2).

## 11. Security

- Team API keys with "resource × action" scopes (`sandboxes:read`, `commands:exec`, …) and a mandatory lifetime, stored as hashes in Payload. People have no long-lived keys: the CLI works with short-lived Keycloak JWTs. The key type `sandbox` (one sandbox, for the CLI inside the VM) is reserved and not issued in the MVP (S7 §7.2–7.3).
- Each machine has its own bootstrap secret in `smbios1` and a machine token for the tunnel only in agent memory; the token is reissued at claim. A machine is not reused between sandboxes (S2).
- Secrets in the guest are in tmpfs (Linux). On Windows `secret_env` is in memory only, `secret_files` are in a directory with an ACL (SYSTEM and `user`), wiped on every boot before user login, at stop, and before a saved snapshot; pagefile cleared at shutdown. Remnants in the pagefile and NTFS metadata of a snapshot of a running VM are an accepted risk (S9 §12.8).
- Proxmox: a separate user and API token with rights only on the pool `umiak` and the needed storages.

## 12. Phases

| Phase | Contents |
|---|---|
| **PoC** (homelab `pve`) | Template `linux`, guest-agent v0 (tunnel, exec, files), gateway (tunnels, HTTP ports), worker (claim from the warm pool, create, delete), lvmthin driver (clone from template, snapshot, fork), minimal API and CLI. Measurements: claim-to-ready, cold start, fork |
| **MVP** | + `windows`, `linux-desktop`; stop/resume, saved snapshots, SSH gateway, desktop, computer-use API (screenshot, mouse, keyboard, clipboard), Payload admin/dashboard, API keys, auto-stop, TS/Python SDKs, MCP |
| **Phase 2** | `windows-core` (Windows Server Core, S9 §22), several nodes and clusters, PBS archive and migration, computer-use v2 and desktop v2 (S29), command history outside the VM, built-in coding agents, egress policies, OTel, webhooks |

## 13. Open questions

- PoC resources on `pve`: RAM, VMID range, consent to host changes (user and token, SDN, pool).
- Domain for `*.umiak`: `umiak.<domain>` by default; a separate registrable domain is Ilia's choice, possible later (S4 §14.1). TLS: wildcard via cert-manager DNS-01 (S4 §5).
- Kubernetes: which cluster and ingress controller; which Keycloak group grants the operator role. ~~Which IdP~~ — Keycloak (Ilia's decision 2026-10-29).
- ~~SSH in the guest: system sshd or a built-in SSH server in the agent.~~ Decided in S4: system sshd on loopback with certificates from the gateway SSH CA.
