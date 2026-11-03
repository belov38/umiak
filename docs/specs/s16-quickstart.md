# S16: zero-config self-host quickstart

Decision: Ilia, 2026-11-03. Current scope: round 5 on `s16-fix4`.
The HTTP decision supersedes all earlier private owner CA/TLS rulings.
Evidence and historical rounds: `docs/plans/s16-quickstart.md`.

## Intent

Run `docker compose up -d --build` from the repository root, claim ownership,
configure a home Proxmox host, install the bundled CLI from the same origin and
create/exec/delete a sandbox. No handwritten environment file is required for the
LAN IP path. OIDC and S15 remain available through their existing compose files.

## HTTP, proxies and ownership

- Owner ingress serves plain HTTP on Docker host port4180, bound to all interfaces
  by default (`UMIAK_QUICKSTART_BIND` and `UMIAK_QUICKSTART_PORT` configure host
  binding). Dashboard, API, MCP, installer and downloads use this one origin.
  Private owner CA, certificate issuance, SNI policy, rotation UI and CA downloads
  are removed. The guest gateway TLS listener and its CA are independent.
- LAN/tailnet access retains S15 allowed/denied peer CIDRs, including sandbox and
  PVE node addresses. Network access grants no ownership. A random 256-bit one-time
  claim code is printed privately to Compose logs; credentials are stored as
  digests, scoped, expiring and revocable. Recovery is Docker-console only.
- Direct Host validation allows localhost, literal addresses, the configured
  public hostname and `UMIAK_QUICKSTART_ALLOWED_HOSTS`. Additional DNS names must
  be explicitly configured. Unknown DNS Hosts fail before routing. Destinations
  are fixed upstreams, never selected from Host. Exact Origin checks protect
  mutations, including claim and browser pairing approval; WebSockets are gated.
- Public port4180 ignores all forwarded headers, including loopback/NAT peers.
  A separate trusted proxy listener on port4181 is published only on host loopback.
  Host-run Serve/Caddy/nginx use `http://127.0.0.1:4181`; the optional isolated
  sidecar also targets4181. No Docker NAT/gateway address is trusted.
  `UMIAK_TRUSTED_PROXY_CIDRS` identifies extra trusted hops only when walking
  forwarded client chains on that listener. A proxy must reject unknown Hosts;
  optional `UMIAK_PUBLIC_URL` pins its external origin. Rate limits and preparation
  peer checks use the first untrusted forwarded client from the trusted end.
- HTTP cookies use `umiak_owner` without Secure. Trusted HTTPS proxy requests use
  `__Host-umiak_owner; Secure`, preserving existing Serve owner sessions. Both are
  HttpOnly, Path=/, SameSite=Strict. Existing CLI bearer credentials stay valid.
- HTTPS is supplied by an operator's proxy. Tailscale Serve is recommended and
  needs no private owner CA. Funnel is public Internet exposure: owner gate is
  then the only protection. Setup/settings visibly warn on *.ts.net origins.
  No Tailscale identity header grants authorization; proxy trust is generic.
- Short-code CLI pairing needs approval by a claimed browser; CLI sessions cannot
  approve pairing and expire within30 days. Installer accepts HTTP with a warning
  that integrity depends on the LAN because checksums use the same channel. It
  still verifies archive and executable SHA256 before atomic installation.
  Generic CLI `--cacert`/`UMIAK_CA_FILE` remains for private operator proxies.
  Public HTTP login warns once. Private/loopback/tailnet HTTP is allowed.

## Guest gateway, previews and browser capabilities

- Guest agents keep using TLS on gateway:443 and pin the guest CA, not a leaf.
  Never replace this CA during an owner-ingress migration. Quickstart CA lasts
  ten years. Leaves are reissued from the same CA within30 days of expiry, at
  startup and daily without user action. Retain leaf keys and atomically rename
  certificates so existing hot reload never sees a mismatched key/certificate.
  Dev-cp has the same periodic control, independent of redeployment.
- Setup/settings show guest CA, tunnel and preview leaf expiry. Warn starting one
  year before CA expiry: CA rotation requires rebuilding agent packages/templates.
  `/metrics` includes CA and leaf expiry gauges. Leaf renewal needs no rebuild.
- Quickstart exposes token/public previews over HTTP on configurable port8085,
  using IP-derived sslip.io names. API/CLI/dashboard return the configured scheme
  and port. Real wildcard HTTPS certificate deployments remain supported. Serve
  cannot terminate wildcard previews, which stay on LAN/tailnet IP HTTP.
- Non-localhost HTTP is not a browser secure context. Clipboard uses execCommand
  fallback. Desktop WebCodecs/WebRTC requirements are detected and explained;
  unavailable browser APIs cannot be enabled by the app. Guidance: Serve
  (recommended), localhost via `ssh -L 4180:localhost:4180 <docker-host>`, an HTTPS
  proxy, or a temporary Chrome insecure-origin-as-secure flag with an explicit
  warning that protection is weakened for that origin.

## Setup, media and templates

- Setup stores durable connection, host, limits, network, templates and smoke
  steps in Postgres. First-run completion requires smoke, which creates one2GiB
  Linux sandbox, execs and deletes it. Dashboard builds after completion never
  reset completion or invalidate smoke. Failed builds preserve setup steps.
- Adoption is read-only on PVE and preserves existing objects/template IDs.
  Validate pinned PVE TLS fingerprint, node-agent, token permissions, cluster
  firewall, VM/NIC isolation, SDN pending state, deny IPSet coverage and precedence.
  Node host firewall flag is independent of VM firewall enforcement. Templates
  remain excluded from sandbox isolation checks.
- Fresh preparation is an expiring one-use capability with dry run and complete
  per-run rollback limited to Umiak objects. It checks storage, dnsmasq, IPv4
  forwarding and cluster firewall before writes. It never enables global host
  policy or changes vmbr0. Missing prerequisites require administrator preparation.
- Template VMIDs have a configurable range disjoint from sandbox500–589;
  inventory/nextid checks allocate an empty slot. Rebuild requires confirmation,
  preserves active version and existing sandbox/snapshot disks, and needs another
  free slot. Adopted node-agent range changes require administrator action.
- Windows stays licensed user-provided media. Uploaded names and
  `storage:iso/name.iso` share validation with build; storage and filename are
  passed separately to S5. HTTPS downloads run on PVE, never through Umiak.
  Optional SHA256 verifies source; absent checksums remain explicitly unverified,
  even after recording the computed digest. VirtIO form prefills recipe hash;
  empty VirtIO retains the builder's pinned verified fallback.
- HEAD preflight is advisory. PVE download-url has no redirect-disable option.
  Audit every page of its final wget log: every Location and every resolved or
  connecting address follows the original URL policy. Reject HTTPS downgrades,
  credentials, internal targets without explicit opt-in, 6to4 and Teredo. On
  violation fail the job and delete the downloaded volume; report cleanup failure.
  This post-download control cannot prevent the outbound request itself.
- Local media.sha256 omits the optional storage argument for older node-agents.
  Preserve actual agent error messages and durable builder output in Setup.

## Deployment isolation and presentation

Generated secrets survive named-volume recreation and never enter git/images.
API/web/worker get separate secret subdirectories; public network configuration is
separate from PVE secrets. Web reaches only GET /v1/meta through a private bridge.
Owner ingress is the sole public control-plane boundary. Optional proxy sidecar
shares no upstream network; host-published listeners still need their own gates.
Single tenancy uses personal Settings/navigation and no team controls. CLI caches
server tenancy and preserves explicit team overrides. Missing metadata means teams.
Effective lifecycle and size defaults come from existing API/config catalogs.

## Live constraints and gate

CT590 is claimed and in use. Preserve owner state/sessions/sandboxes and guest
CA. Never log in as ilia@example.com, reset claim or create a pairing. No live
builds, downloads, VM creation, host prep, firewall or network changes. Only
read-only pvesh/qm on pve; never touch pve2/ip-hub-pve. Restart only with no active
operations. Serve8443 forwards to loopback HTTP4181; LAN is http://192.168.68.90:4180.

Gate: pnpm build/lint/typecheck, sequential workspace tests, quickstart/local/
meta-proxy Node tests including compiled HTTP CLI and custom-CA HTTPS proxy,
shellcheck, Go build/vet/test/lint, Python SDK, OIDC23 and local Playwright.
Use unique Compose projects/ports. Fresh-host prep/build remains fake/dry-run
because the active stand forbids those mutations. No main merge in this branch.

### Owner sign-in rulings (2026-11-03)

- A claimed deployment presents Sign in to anonymous browser navigations, including
  setup and pairing links. Claim, sign-in and anonymous errors expose no dashboard
  menu. Brand, appearance and a minimal footer remain available.
- Sign-in uses 24 uniformly random base32 characters (120 bits), grouped in fours,
  case-insensitive with spaces/hyphens ignored. Only SHA256 digests persist in the
  existing locked owner row. Codes expire after 10 minutes and are consumed in the
  same transaction that creates a normal browser session. No existing session or
  pending CLI pairing is reset; upgrades add fields without resetting owner state.
- Only the Docker operator or a browser owner may issue codes. CLI tokens cannot
  mint browser access: that would escalate their deliberately narrower authority.
  Browser issuance requires the exact Origin even when using a bearer credential.
- Per-source admission is 20 attempts per 10 minutes; keys are hashed validated
  client addresses. Each incorrect attempt increments every outstanding code's
  global failure counter; 20 failures invalidate that code. Thus distributed
  guesses are bounded too. Invalid guesses can deny use of outstanding codes;
  issue a fresh code, while existing sessions continue working. Source buckets
  expire and are capped at 10,000; outstanding codes are capped at ten.
- Failed-attempt state commits even when sign-in fails (errors are thrown outside
  the transaction). Shared Postgres row locking prevents reuse across replicas.
  Issue/use audit events contain no codes, credentials or digests. The console
  command alone prints its newly issued code to its operator's terminal.
- Sign-in POST requires exact Origin and retains Host allowlist, CIDR admission,
  body size and ingress rate controls. HTTP uses the existing HttpOnly Strict
  cookie; trusted HTTPS ingress uses Secure `__Host-umiak_owner`.
- Sessions show kind, creation, last HTTP use and creation hostname. Historical
  sessions missing metadata display unknown; metadata does not invalidate them.
  CLI hostname is the pairing initiation hostname. WebSocket traffic does not
  continually update last-use time. Revocation retains confirmation.
- Recovery remains console-only, destructive and behind an explicit disclosure
  warning that all browser and CLI sessions and pending pairings are revoked.
