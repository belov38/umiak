# S18: homelab onboarding — one install command on Proxmox

Decision: Ilia, 2026-11-04 (brainstorm in the onboarding thread).
Supersedes the S16 rulings on how a homelab deployment is installed and reached:
LAN HTTP access, the bring-your-own-Docker-host quickstart, the browser
Connect/Prepare steps and the read-only adoption report. S16 owner gate
(claim, sessions, sign-in codes, CLI pairing), templates, smoke and the guest
gateway CA remain. Corporate OIDC mode (S6/S7) is untouched.

## Why

A home user with a Proxmox host could not get from zero to a sandbox.
Live run on 2026-11-04 (test VM 590 on `pve`, fresh Docker host):

- `docker compose up -d --build` took 6.5 minutes, almost all of it base image
  downloads and five separate `pnpm install` runs.
- Wizard step 1 failed on a PVE URL given by IP (`Setting the TLS ServerName to
  an IP address is not permitted`).
- Fresh-host preparation was unreachable: Connect requires a working
  `…@pve!…` token, Prepare is enabled only after Connect, and the preparation
  script refuses to run when that token already exists. Only adoption of an
  already prepared host worked, which is the dev stand case.
- Step 1 asked for about ten values (fingerprint, TLS name, SSH host, token,
  root CA PEM, node-agent private key, known_hosts).
- Quickstart compose has no TURN. On LAN HTTP the desktop viewer cannot use
  WebRTC (no relay) or the WebSocket fallback (`VideoDecoder` needs a secure
  context), so desktop streaming is expected not to work there.

## Goal

A person with root on a Proxmox VE node and a Tailscale account runs one
command on that node, answers a few questions, opens one HTTPS link and has a
working Linux sandbox. Everything a browser touches is on one HTTPS origin in
their tailnet. Nothing in their tailnet or LAN has to be configured by hand.

## Non-goals

- Access from the public Internet. Funnel stays unsupported.
- Running without Tailscale in homelab mode. A later option ("own domain +
  DNS-01 wildcard certificate") is explicitly deferred.
- Kubernetes or an operator for homelab. Kubernetes remains the corporate
  production target only.
- Multi-tenant teams in homelab mode (S16 single-owner tenancy remains).

## Anti-goals

- The installer silently changes shared host policy: global firewall, `vmbr0`,
  other guests, storage outside what the user chose. Every host change is
  listed and confirmed.
- A control plane compromise gives root on the cluster. Node-agent stays a
  restricted SSH forced command (see Node access).
- Secrets in environment variables, image layers, git or terminal scrollback
  other than the one-time claim link.

## Rulings

### Prerequisites (hard)

- Proxmox VE 9.x, run as root on a cluster node.
- A Tailscale account with MagicDNS and HTTPS certificates enabled. The
  installer checks this after login and, if missing, prints where to enable it
  and waits.
- Tailscale is **not** required on the Proxmox host. It runs inside the
  control-plane container.

### Distribution

- The repository is public (`github.com/belov38/umiak`, Apache-2.0, published
  2026-11-04).
- Entry point: `curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh`
  (the exact URL may point at a release asset; the builder decides, but it
  must be one short line printed in README). The script re-executes itself
  with a TTY so prompts work under `| sh`.
- All control-plane images are prebuilt and published to GHCR
  (`ghcr.io/belov38/umiak-<name>:<version>`, linux/amd64). A release
  workflow builds them; per repo CI policy it runs on `workflow_dispatch`
  only. The installer pins one release version; it never builds from source.
- GHCR packages must be public. Package visibility is a one-time manual
  switch in GitHub UI by Ilia; the plan lists it as a manual step.
- Node-agent binary ships inside the quickstart image (as today); the
  installer extracts it from the image. No separate download channel.

### Installer behaviour: state-driven menu

The installer detects current state (a control-plane container tagged
`umiak`, an installer state file under `/etc/umiak/` on the node, the
`umiak@pve` user) and offers only actions that make sense:

- not installed → **Install**;
- installed → **Update**, **Sign in a new browser**, **Reset owner access**,
  **Uninstall** (S19 adds **Add or remove sandbox nodes**).

Re-running the same command is the only thing a user needs to remember.
A `--non-interactive` mode with flags for every answer exists for tests.

### Install flow

1. **Checklist.** Root, PVE version, cluster membership and node list, free
   VMIDs in the chosen ranges, an LVM-thin storage, ISO/import directory
   storage, dnsmasq present, `net.ipv4.ip_forward=1`, cluster firewall
   enabled, no pending SDN changes. For each gap the installer shows the exact
   change and asks before applying it (install dnsmasq with its system service
   disabled, enable forwarding persistently, enable cluster firewall). It
   never touches `vmbr0` or existing guests.
2. **Questions** (with defaults): storage, sandbox and template
   VMID ranges, RAM cap, control-plane CT ID, its IP (static, no DHCP
   default; see Builder rulings).
3. **PVE objects.** Creates or verifies, scoped to Umiak only: `umiak@pve`
   user, role(s), API token (secret captured once from `pveum`), pool,
   SDN zone/VNet/subnet with DHCP and SNAT, `umiak-gateway` IPSet,
   `umiak-egress` group, media roles. This reuses the logic and rollback
   behaviour of today's `setup-prep.py`, run locally instead of via callback.
4. **Node access.** Generates the node-agent SSH key, installs the forced
   command line (cluster-wide via `/etc/pve/priv/authorized_keys`), installs
   the node-agent binary on this node and records its pinned host key.
5. **Control plane container.** Unprivileged LXC from the Debian template
   available on the node (download if missing), `nesting=1`, `keyctl=1`,
   `/dev/net/tun` passed through, on `vmbr0`. Inside: Docker Engine, the
   compose file for the pinned release, `docker compose pull && up -d`.
   Its LAN address goes into the `umiak-gateway` IPSet (guests reach the
   gateway only there).
6. **Secrets handoff.** PVE token, token ID, PVE root CA, node-agent private
   key, known_hosts and the setup facts (API URL, node names, storage,
   ranges, gateway address) are written as files into the control plane's
   secrets volume via `pct push`, mode 0600. Never env vars.
7. **Bootstrap import.** On start, the control plane imports these facts into
   setup state so that connection, host, limits and network steps are already
   verified. The browser wizard shows only **Templates** and **Smoke test**.
8. **Tailscale.** Installs `tailscale` in the container, runs `tailscale up`
   with hostname `umiak` (adjustable), prints the login link, waits. Then
   checks MagicDNS/HTTPS certificates and runs
   `tailscale serve --bg http://127.0.0.1:4181`.
9. **Finish.** Prints one line:
   `Open https://umiak.<tailnet>.ts.net/claim#<code>` (code in the fragment
   so it is not sent in request logs; exact form left to the builder). The
   code is one-time; after use the link shows the normal Sign in page.

### Day-2 actions

- **Update:** pulls the new pinned version, recreates containers, refreshes
  node-agent on all sandbox nodes. Preserves volumes, owner state, guest CA.
- **Sign in a new browser:** prints a one-time sign-in link (existing
  `umiak-signin` mechanism, 10 minutes, does not revoke other sessions).
- **Reset owner access:** existing console recovery; warns that all browser
  and CLI sessions are revoked; prints a new claim link.
- **Uninstall:** stops and removes the container; asks separately whether to
  remove Umiak PVE objects, sandboxes, templates and data volumes. Never
  touches non-Umiak objects.

### Network surface (Tailscale only)

- One HTTPS origin `https://umiak.<tailnet>.ts.net` (Serve → loopback trusted
  listener 4181) serves dashboard, API, CLI, MCP, installer downloads.
- The public plain-HTTP owner listener (4180) is no longer published outside
  the container. Emergency access: `ssh -L 4180:<ct-ip>:4180 root@<pve>` and
  `http://localhost:4180` (secure context).
- **Desktop viewer moves onto the same origin under a path prefix, served
  by the control plane, not by the guest** (Ilia, 2026-11-04, option a).
  A compromised sandbox must never run script on the owner origin. So:
  - the control plane ships a trusted copy of the pinned moonlight-web
    frontend (same release tarball and SHA256 as templates, v3.0.1) and
    serves its HTML/JS/CSS itself. The prefix is runtime config: the
    ingress serves `/desktop/<slug>/config.js` with `path_prefix`;
  - only moonlight-web API and stream endpoints (`/api/...`, including the
    `web_socket` upgrade) are proxied through the gateway and tunnel to the
    guest. Responses from the guest are treated as data: the ingress forwards
    only JSON/binary/WebSocket, never `text/html` or JavaScript, and strips
    `Set-Cookie`;
  - URL shape `https://umiak.<tailnet>.ts.net/<prefix>/<slug>/…`, embedded in
    the dashboard (same origin, secure context);
  - the owner session authorizes the viewer; the gateway receives a
    per-request service credential naming the sandbox (no guest-visible
    owner cookie, no per-sandbox browser cookie);
  - the guest moonlight-web config is unchanged; the ingress strips the
    prefix before forwarding (the guest agent's own admin calls stay
    unprefixed);
  - homelab desktop links default to `dataTransport=websocket`: media goes
    through gateway and tunnel, no TURN, no 15-second WebRTC wait.
  Hostname-based desktop/preview routing stays for corporate deployments.
- **Port previews** keep hostname routing over plain HTTP on the
  control plane's **tailnet IP** (`http://<slug>-<port>.<tailnet-ip-dashed>.sslip.io:8085`).
  Tailnet traffic is WireGuard-encrypted; apps keep running at `/`.
- **Sandbox SSH** uses the tailnet IP and port 2222.
- Guests are never in the tailnet. They reach the gateway's guest TLS
  listener (443, existing guest CA) on the control plane's LAN address.

### Removed from homelab mode

- Running the stack on an arbitrary Docker host; the README instruction for
  `docker compose up` from the repository root.
- Browser Connect and Prepare host steps, generated `pve-setup.sh` + HTTP
  callback, read-only adoption report. Their verification logic moves into
  the installer and the bootstrap import.
- LAN HTTP owner access, HTTP `umiak_owner` cookie variant, secure-context
  guidance (Chrome flag etc.), the Tailscale sidecar with auth key, Funnel
  warnings.
- S15 `UMIAK_AUTH_MODE=none` local mode, `deploy/compose/local.yaml`, its
  ingress, tests and docs (Ilia, 2026-11-04: remove everything superfluous).
  Two modes remain: homelab (owner + Tailscale) and corporate (OIDC).

## Builder rulings (Claude's calls, 2026-11-04; Ilia may override)

- **Code removal, not a mode switch.** Browser Connect/Prepare steps,
  `pve-setup.sh` + callback, adoption report, HTTP owner cookie variant, LAN
  HTTP guidance and the Tailscale sidecar are deleted with their tests; their
  checks move into the installer and bootstrap import. `compose.yaml` stays as
  the stack definition used inside the container, defaulting to GHCR images;
  a dev override file keeps local `--build` for contributors.
- **Port exposure inside the container.** Gateway guest TLS (443) listens on
  the LAN address for guests. Owner HTTP (4180), previews (8085) and sandbox
  SSH (2222) are reachable only via `tailscale0` and loopback, enforced by a
  container-local nftables rule set the installer writes; published ports keep
  binding all interfaces so a tailnet IP change needs no restart.
- **Static control-plane address.** The LAN address is baked into the
  `umiak-gateway` IPSet, guest tunnel URL and gateway certificate SAN, so it
  must not change. The installer asks for a static IPv4 with no DHCP
  default: the CT is created directly with that address (`ip=<addr>/<prefix>,gw=...`),
  never boots on DHCP, and `--ct-ip` is mandatory for non-interactive runs
  (the prompt only reuses a previously saved answer). This deviates from step 2
  above ("its IP (DHCP default)"); the user picks a free LAN address and should
  exclude it from the router's DHCP pool. Update re-verifies all three places.
- **Current state of `pve` (checked 2026-11-04):** no Umiak objects remain
  (only `root@pam`, no pools, SDN zones, VNets or IPSets; CT 590 dev stand is
  gone). The installer may assume a clean host there; adopting a previous
  install is handled by Update, not by a separate adoption path.

## Live testing

- Cluster `ms02`, node `pve` (prerequisites present). `pve2` (no dnsmasq,
  forwarding off) belongs to S19 and is not changed by S18.
- Off limits: Ilia's guests (VMIDs below 500, 9000/9001, CT 110/111,
  `ip-hub-pve` VM 103 on `pve2`), host networking, non-Umiak firewall rules.
- Test VM 590 `umiak-onboard-cp` (Docker host from the brainstorm) may be
  deleted; the real control plane is an LXC created by the installer.
- Acceptance is a full fresh run on `pve`: install → claim via tailnet →
  Linux template build → smoke → desktop template → desktop opened in the
  dashboard over the single origin → update → sign in new browser →
  uninstall leaving no Umiak objects.

## Left to the builder

- Installer language (POSIX sh entry that may hand off to a bundled
  Python/Go helper on the node), file layout, flag names.
- GHCR image naming, tagging, and how the release workflow is structured.
- Exact URL shapes for the claim link and desktop prefix.
- How bootstrap import is wired into existing setup state.
- Whether to keep `setup-prep.py` as the shared host-preparation module.

## Scope split: multi-node is S19

The worker places sandboxes on one node and templates live on node-local
LVM-thin. S18 installs on the node where the installer runs and uses only
that node for sandboxes. The installer does not ask about other nodes yet.
Multi-node placement, per-node template builds and installer
add/remove-node actions are S19 (`docs/specs/s19-multi-node.md`), run as a
separate thread (Ilia, 2026-11-04). S18 keeps node records and node-agent
installation per node so S19 extends rather than rewrites them.
