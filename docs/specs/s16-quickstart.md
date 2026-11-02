# S16: zero-config self-host quickstart

Decision: Ilia, 2026-11-03. Status: implemented and verified on the dev stand; independent acceptance pending.

## Intent and acceptance

A developer runs `docker compose up` from the repository root, claims the deployment,
configures a home Proxmox host in the dashboard, installs the CLI from that same
origin and creates, executes in and deletes a first sandbox. No handwritten `.env`.
LAN, MagicDNS and ordinary DNS names work without a Tailscale dependency.
Existing OIDC and S15 deployment paths remain available.

## Approaches and rulings

These are implementer decisions under Ilia's explicit delegation of technical details.

1. Reuse S15 local identity behind an isolated owner ingress, rather than requiring
   Keycloak or independently implementing identity in every component. Only the
   owner ingress publishes user control-plane routes; upstream listeners must never
   be reachable around it. Guest gateway TLS, SSH and tunnel authentication remain
   independent. OIDC stays in the existing compose entry point.
2. Root `compose.yaml` is the quickstart entry point. Generated secrets live in
   named volumes, survive recreation and are never baked into images or git.
   Postgres uses a generated password, not the development literal password.
3. Owner claim uses a random 256-bit single-use code printed to compose logs.
   Claim is atomic and persisted. The code is invalid after successful claim.
   Random owner credentials are stored only as digests, with expiry and revocation.
   Browser cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. Mutation
   requests must pass same-origin checks. Neither CIDR membership nor identity
   headers confer ownership. Claim/pair attempts are bounded and rate limited.
4. HTTPS is required for remote ownership. A separate quickstart CA issues certificates
   for observed SNI names/IPs; operators obtain and verify the CA through the local
   Docker trust channel before remote curl. Never recommend `curl -k | sh`.
   Arbitrary Host headers do not select proxy destinations. Browser DNS rebinding
   is constrained by TLS and strict same-origin mutation checks.
5. CLI pairing creates a short-lived request; a claimed browser approves it and the
   CLI receives a revocable bearer credential. A code alone does not approve pairing.
   The CLI persists the CA for subsequent requests; installer assets are unauthenticated
   but no credentials or host bootstrap tokens are public.
6. Keep the S15 deny list for sandbox subnet and node SNAT addresses at ingress,
   including WebSocket upgrades. Explicitly allow tailnet 100.64.0.0/10 in addition
   to LAN ranges. Do not trust forwarded client identity from arbitrary peers.
7. Wizard state and errors are durable in Postgres. Steps: connection (TLS fingerprint
   pin), host preparation/adoption, storage/VMID/RAM policy, guest gateway and preview
   domain, templates, smoke. Re-running a step verifies current state. Completion
   requires successful smoke and a registered Linux template, not just form submission.
8. Adoption is read-only against PVE: verify user/token permissions, pool, SDN zone/VNet,
   firewall IPSet/rules, restricted node-agent SSH and templates. It may write control
   plane configuration/registration but must not create another PVE setup.
9. Fresh host setup reuses the S1 preparation primitives with a one-time, expiring,
   deployment-bound callback token. No arbitrary shell values from form input are
   interpolated unquoted. Dry run emits intended actions without host mutation or token
   consumption. Firewall/network mutations require an automatic rollback timer and
   stay limited to Umiak-owned objects. Never touch vmbr0.
10. Linux template build reuses S5 builder; desktop/Windows are optional and require
    user-provided ISO where applicable. No rebuilds of existing pve templates.
11. Help pages are rendered inside the authenticated dashboard with actual request
    origin in CLI/MCP/SDK examples and copy controls. No third-party scripts.
12. Installer ships four existing Bun targets (Darwin/Linux arm64/x64), plus Windows
    x64 when practical, with SHA256SUMS; detects unsupported targets before downloads,
    verifies exact filename checksum before install, defaults to ~/.local/bin and
    invokes `umiak login --api-url <origin>`. Chosen directory and CA are configurable.

13. Initial remote bootstrap uses a DNS name (LAN DNS, mDNS or MagicDNS), or
    localhost on the Docker host. Docker NAT cannot reveal every host IP to a
    container before TLS. `/owner/tls` lets the claimed owner add raw IP SANs
    immediately and persist them without an environment file. Dev CT IP SANs are
    supplied by its existing infrastructure overlay. This is an explicit bootstrap
    step for raw-IP-only installations, not an assumption that IPs send SNI.
14. Fresh preparation fails closed when dnsmasq, host IPv4 forwarding or an enabled
    cluster firewall are missing. Enabling shared global host policy can affect
    unrelated guests and cannot be safely automated under the host constraints.
    The generated script reports these prerequisites before applying changes;
    administrator host preparation remains a documented fresh-host gap.
15. Owner recovery is a Docker-console command only: it atomically revokes all
    browser/CLI credentials and prints a new one-time code without changing wizard
    or VM state. There is no network recovery endpoint.
16. Ship only template-builder/database production dependencies in the owner image;
    CLI build dependencies stay in a separate stage. CT590 has a 30 GiB disk, and
    shipping all monorepo dependencies exceeded free unpack space during live build.
17. Adoption verifies deny IPSet coverage and rule precedence, including the existing
    S10 TURN UDP3478 gateway exception; neither any nonempty rule list nor CIDR
    membership is evidence of isolation. Referenced node IPs are denied dynamically
    for HTTP and WebSockets; only one-time preparation capabilities bypass that deny.

## Live stand constraints

Only pve / CT590; no pve2 or ip-hub-pve. Sandbox VMIDs 500–589, total sandbox RAM
at most 8 GiB, sequential VMs, check usage first, delete every created resource.
Templates 595–598 read-only. Never touch resources below 500, 9000/9001, 100–109
or vmbr0. No broad cleanup. Always `umiak rm --yes`.
Preserve CT590 :443 and existing dev CA byte-for-byte; guests can reach only this
endpoint through umiak-gateway. Quickstart uses a separate HTTPS port.
No firewall changes unless indispensable, scoped and protected by auto rollback.
Rollback remains `UMIAK_DEVCP_AUTH_MODE=none|oidc infra/dev-cp/deploy.sh`.
Never authenticate as ilia@example.com. No secrets in git; docs/comments English.

## Verification

Gate: pnpm build/lint/typecheck; sequential workspace tests; Go build/vet/test/lint;
Python SDK tests; Playwright OIDC 21/21 and local. New tests cover atomic claim,
replay, unclaimed/unauthorized access, CSRF, forged headers, WebSocket gate, expiry,
pair approval, wizard retries and adoption failures, installer checksum failures and
unsupported architectures, shellcheck and host-prep dry run.
Live: deploy CT590, claim, adopt existing pve, register existing builds, install on Mac
via LAN and MagicDNS, create/exec/rm, dashboard help. Preserve healthy S15 rollback.
Fresh-host live setup/build is explicitly deferred to a clean host and recorded as a
roadmap gap; fakes and dry run cover its code path in this scope.

## Execution record

Implementation and verification evidence is tracked in `docs/plans/s16-quickstart.md`.
