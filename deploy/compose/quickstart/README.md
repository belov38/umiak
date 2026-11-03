# Umiak control plane: operator notes (S18)

This stack runs inside the Umiak control plane LXC container on your Proxmox node.
The installer on the PVE node creates the container, hands over credentials and
starts Tailscale. These notes cover operating what runs inside it.

## Access model

Browsers, the CLI and MCP clients reach the deployment only through Tailscale
Serve over HTTPS: `tailscale serve --bg http://127.0.0.1:4181` forwards
`https://umiak.<tailnet>.ts.net` to the trusted listener on port 4181. That
listener honours `X-Forwarded-*` headers only from a loopback socket peer (or the
container network gateway). Pin the external Host with `UMIAK_PUBLIC_URL` and
add proxy chain hops through `UMIAK_TRUSTED_PROXY_CIDRS` if needed; the latter
never admits another socket peer.

Port 4180 is the emergency listener. It accepts any socket peer (the container
firewall decides who can connect) but serves a request only when its Host header
is `localhost`, `127.0.0.1` or `[::1]`. Any other Host receives HTTP 403
`use_tailnet_https`. It ignores every forwarded header. To use it:

```sh
ssh -L 4180:<control-plane-ip>:4180 root@<pve-host>
```

then open `http://localhost:4180`. Browsers treat localhost as a secure context. The emergency login relies on the browser accepting the Secure `__Host-` cookie on `http://localhost`: Chrome and Firefox do, so use one of them.

Owner sessions use one cookie, `__Host-umiak_owner` (`Secure; HttpOnly; Path=/;
SameSite=Strict`), on both listeners. A plain `umiak_owner` cookie is neither set
nor accepted. Browser cookies expire after 180 days; CLI sessions after at most
30 days; CLI pairing requests after five minutes. Credentials and claim state
survive container recreation.

Serve covers the dashboard hostname and cannot cover wildcard sandbox preview
hostnames. Default previews remain `http://<slug>-<port>.<IP-derived-sslip.io>:8085`,
served by the guest gateway's separate HTTP listener. Token access remains the
default; `umiak port 3000 --public` deliberately allows anyone who can reach that
preview. sslip.io supplies DNS only; use your own wildcard DNS if needed.
`UMIAK_PREVIEW_PORT` changes port 8085.

## Browser secure contexts

The tailnet HTTPS origin and `http://localhost` are secure contexts, so the
desktop viewer's WebCodecs `VideoDecoder` and the Clipboard API are available.
Copy buttons fall back to `document.execCommand("copy")`; if both methods fail,
select and copy the visible text manually.

## Setup page

Connection and host facts are recorded by the installer and imported when the
stack starts; the browser never edits them. `/setup` shows the remaining steps,
each saved with its status and errors in Postgres and retryable:

1. Storage and capacity: lvmthin storage, sandbox VMID range within 500-589 and a
   RAM cap up to 8192 MiB.
2. Gateway and previews: the guest-reachable gateway address, tunnel URL and
   preview domain. IPv4 defaults use sslip.io for DNS only. Do not reissue the CA
   trusted by existing templates.
3. Templates: register existing template builds, or build Linux in an empty
   template slot. Optional desktop/Windows recipes require their ISO/media
   prerequisites. Occupied templates are never rebuilt by the wizard. Build status
   is durable; after an interrupted server restart retry a failed job.
4. Smoke test: one 2 GiB Linux sandbox, exec, deletion. Setup is complete only
   after every step succeeds. Running sandbox RAM is checked before creating a VM.

Getting started is at `/app/getting-started` (`/app/help` redirects) with this
deployment's actual CLI, MCP and SDK URLs and copy buttons.

## Guest certificates and expiry

The guest tunnel uses TLS and the gateway CA, independent of the dashboard origin. A newly generated guest CA lasts ten years. Existing CAs
keep their original expiry and are never silently replaced or extended.

The gateway checks leaf certificates daily and renews tunnel and preview leaves
when 30 days or less remain, using the same CA. Renewal reloads certificates
without restarting the gateway and does not require new agent packages or
new templates. Leaf expiry is capped by the CA expiry.

Setup and Settings show guest CA, tunnel and preview certificate expiry dates
from the owner-only `/quickstart/setup/certificates` endpoint. When the CA has one
year or less remaining, they show a rotation warning. CA rotation changes guest
trust and requires rebuilding agent packages and templates, followed by a planned
migration of existing guests. Plan it before expiry. Keep the current gateway CA
trusted by existing templates when changing network settings.

## Install and pair the CLI

```sh
curl -fsSL https://umiak.<tailnet>.ts.net/install.sh -o umiak-install.sh
sh ./umiak-install.sh
```

The installer accepts HTTPS origins, plus `http://localhost` for the emergency
tunnel. There is no quickstart owner CA.

The installer detects Darwin/Linux arm64/x64, verifies SHA256SUMS, installs to
`~/.local/bin` (`UMIAK_INSTALL_DIR` overrides it), and starts `umiak login`. Open its
pairing URL in the claimed browser and compare the short code before approving.
Never approve a pairing you did not start. If the owner browser uses another
hostname for this deployment, open the pairing path and request ID on that
claimed hostname; cookies are host-only. Profiles retain the deployment URL and
any explicitly configured proxy CA path. `umiak logout` revokes that CLI credential.
Windows x64 CLI is available under `/downloads/umiak-windows-x64.exe`; the shell
installer supports Darwin and Linux.

```sh
umiak create --template linux --size 2gb --wait
umiak exec <slug> -- uname -a
umiak rm <slug> --yes
```

Pairing limits use the validated client address from the socket or a configured
trusted proxy. Serve can collapse clients into one source, sharing those limits. CLI sessions can be revoked at `/owner/sessions`.

## Console recovery

For a deliberate full access reset only, an operator with a shell in the control
plane container can invalidate all owner sessions and CLI pairings and print a new
one-time claim code. For a new browser use the non-destructive sign-in below:

```sh
docker compose exec quickstart node deploy/compose/quickstart/run.mjs node deploy/compose/quickstart/recover.mjs
```

This changes only owner access; setup, VM data and guest trust are preserved. The
recovery command is deliberately unavailable over HTTP. Protect and back up the
named volumes; `down -v` deletes state.

The corporate OIDC deployment (`deploy/compose/compose.yaml`) is a separate stack.
Do not run two stacks over the same database.

## Local validation

Run `pnpm build` before the compiled CLI gate, then:

```sh
node --test deploy/compose/canonical-fetch.test.mjs deploy/compose/quickstart/*.test.mjs deploy/compose/meta-proxy.test.mjs
```

Missing host CLI binaries fail the compiled gate. The quickstart fixtures exercise
loopback pairing and trusted proxy origins using an isolated owner store. Gateway
certificate tests verify same-CA leaf renewal and retained guest trust. No live
Proxmox environment is required by these local tests.

### Installer download and pairing

The installer downloads gzip archives (the default `gzip` utility is present on
macOS and common Linux distributions), announces the release/platform/compressed
size, and uses curl's progress bar on terminal stderr. Piped stderr stays quiet
apart from status and errors. SHA256SUMS covers both the downloaded archive and the
extracted executable; either mismatch preserves the previous installation. The
verified executable is installed by an atomic rename in the destination directory.

The installer prints the PATH hint before starting owner pairing. Set
`UMIAK_INSTALL_SKIP_LOGIN=1` to install without starting a pairing request; it prints
the manual `umiak login` command, including a selected proxy CA when needed. For example:

```sh
curl -fsSL https://umiak.<tailnet>.ts.net/install.sh | UMIAK_INSTALL_SKIP_LOGIN=1 sh
```

A native Darwin arm64 build measured 90,976,226 bytes before gzip and 40,887,362
bytes downloaded (55.1% smaller); exact release sizes are in `/downloads/DOWNLOADS`.

### Adopting an existing Windows template

The single `windows` template is the desktop build. Setup adopts an existing
Windows template only with positive desktop evidence: the PVE tag
`umiak-desktop` (set by current builds), or the build manifest in
`template-registry/<buildId>.json` of the PVE secrets with a passed verify that
includes `desktop_sunshine`, `desktop_display` and `desktop_agent_config`. A
Windows template without either is treated as a legacy headless build and is
not offered. For a desktop template built outside this stack, copy its manifest
into `template-registry/` or add the `umiak-desktop` tag in PVE, then re-run the
Templates step. A VM is never adopted under a template of another OS.

### Windows ISO URLs

The Windows and Windows desktop build forms accept an uploaded ISO file name
(or `storage:iso/name.iso`) or the owner's HTTPS URL. Umiak never ships or hosts
Windows media; supply media covered by your own license. Select an active ISO
storage, or leave storage blank to use the first storage advertising `iso` content.
Use **Validate ISO inputs only** to validate without downloading or building.

SHA256 is optional for both Windows and VirtIO URLs. If supplied, it must be 64
hexadecimal characters and PVE verifies it during its native `download-url` task.
If omitted, the form and build log say **Not verified: the ISO will be used as
downloaded**. Umiak records the node-computed SHA256 before passing the media to
S5; recording a digest does not verify the source. Existing known-checksum media
is reused only after hashing it on the node. Without a supplied checksum, URL
reuse checks the file name and the source's HEAD Content-Length against the stored
size and remains explicitly unverified. Mismatches never overwrite an existing ISO.

Obtain the Windows SHA256 from the Microsoft or licensed vendor download portal.
VirtIO defaults to Fedora's versioned 0.1.271 archive:
<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.271-1/virtio-win-0.1.271.iso>.
Its checksum field starts with the recipe-pinned SHA256. Leaving VirtIO empty uses
the builder's pinned, checksum-verified download. The archive version and checksum
must be updated together after confirming a new trusted digest. Fedora's
`CHECKSUM` currently lists RPM MD5s, not an ISO SHA256. Download the ISO on a
trusted workstation and compute `sha256sum virtio-win.iso` (Linux),
`shasum -a 256 virtio-win.iso` (macOS), or `Get-FileHash virtio-win.iso -Algorithm
SHA256` (PowerShell); confirm it against your trusted distribution source.

Native downloads need `Datastore.AllocateTemplate` on `/storage/<iso-storage>`
and `Sys.AccessNetwork` on `/nodes/<node>`, plus read-only `Sys.Audit` on `/`
to obtain datacenter proxy options (PVE otherwise silently omits `http_proxy`).
Fresh preparation generates `UmiakMediaDownload` and a separate
`UmiakDatacenterAudit` role, the latter bound only to `/` without propagation
for both user and separated token; adoption reports whether this optional capability
is present. Existing hosts are not modified by adoption. A missing capability
blocks downloads with an actionable error, without blocking ordinary adoption.
Do not grant cluster-wide `Sys.Modify` just for ISO downloads. These checks match
[PVE's API implementation](https://github.com/proxmox/pve-storage/blob/master/src/PVE/API2/Storage/Status.pm).

URLs reject credentials, non-HTTPS schemes, and internal/loopback DNS answers
unless the owner explicitly checks the internal URL permission. HEAD preflight
checks redirects returned to HEAD before handing the final HTTPS URL to PVE. Fedora's
same-host HTTP redirect is upgraded to HTTPS. PVE performs its own later DNS
lookup and GET. PVE offers no redirect-disable option for this API. Umiak audits the complete wget task log after download: every Location must remain HTTPS and every reported resolved/connecting target address must satisfy the URL address policy. Only resolution/connection lines for the exact datacenter `http_proxy` endpoint read from `/cluster/options` are exempt; redirect destinations remain validated. A violation fails the job and deletes the downloaded volume. This post-download control cannot prevent the request itself; the administrator must trust the source and DNS. Umiak does not
proxy the bytes or control a source that changes between preflight and download.
Progress and failures are taken from the PVE task log. No ISO download or Windows
build is part of validation-only checks.

The selected ISO storage is resolved by the restricted node-agent's read-only
`media.sha256` operation through `pvesm path <storage>:iso/<name>`. Update the
node-agent when using this new optional storage argument on an existing host.

## Proxy isolation

Docker Engine **28 or newer** is required for loopback-publish isolation from
other hosts on the same layer-2 network. Port 4181 also checks its socket peer:
loopback, or the gateway the engine actually assigned to the container's network
(read from `/proc/net/route` at startup, e.g. 172.29.116.128). No fixed gateway
address is assumed, so a container that happens to hold .1 or .128 is not trusted.
`UMIAK_TRUSTED_PROXY_CIDRS` controls forwarding chain traversal only; it cannot
admit another socket peer. Port 4180 ignores forwarding headers from every peer.

Docker Desktop caveat: Desktop NATs container traffic, so a container on any
network that reaches port 4181 arrives from the same gateway as host traffic. The
server cannot distinguish these peers. Treat containers on that Docker host as
trusted operators and restrict accepted proxy Hosts with `UMIAK_PUBLIC_URL`.

The two fixed `/quickstart/ui/*.woff2` font routes intentionally remain public,
before deny and owner checks. They contain only bundled presentation assets;
no deployment settings, owner state or arbitrary paths are exposed.

## New browser or device?

Owner sessions belong to each browser and hostname. Open the deployment, then
enter a one-time sign-in code. Existing sessions and CLI pairings remain valid.
From a shell in the control plane container:

```sh
docker compose exec quickstart umiak-signin
```

The wrapper reads the generated database credential inside the container. Or use
**Owner sessions → Sign in another browser** in a signed-in browser and copy the
code. Codes last ten minutes and work once. Keep them private. After a typo or
rate-limit error, check the code or obtain a new one; source limits reset after ten
minutes. CLI credentials cannot issue broader browser credentials.

Use **Lost every session? Reset owner access** only as a last resort: recovery
revokes all browsers, CLI credentials and pending pairings.

Sign-in admission allows 20 attempts per source address per 10 minutes. NAT can
put all clients in one shared bucket: one attacker can block new sign-ins for 10
minutes. Existing sessions remain usable.
Source buckets live in the single quickstart process, expire after 10 minutes,
and are capped at 10,000. At capacity, new sources are rejected with HTTP 429
until the earliest bucket expires; existing sources keep their remaining attempts.
A process restart clears these buckets. Durable global failure counters still
invalidate each outstanding code after 20 wrong guesses across all sources.
