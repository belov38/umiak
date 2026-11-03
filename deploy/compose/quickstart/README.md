# Zero-config self-host quickstart (S16)

From the repository root:

```sh
docker compose up -d --build
docker compose logs quickstart
```

Open `http://localhost:4180` on the Docker host or `http://<docker-host-LAN-IP>:4180`
from your trusted LAN. Enter the one-time setup code from the logs to claim
ownership, then continue to `/setup`. No dashboard certificate or CA installation
is needed. The owner ingress serves plain HTTP; guest tunnel TLS remains separate.

The default listener is published on all host interfaces. Keep it on a trusted LAN
or configure host firewall access. `UMIAK_QUICKSTART_BIND=127.0.0.1` restricts the
published listener to the Docker host; `UMIAK_QUICKSTART_PORT` changes port 4180.
A DNS hostname can be added with `UMIAK_QUICKSTART_ALLOWED_HOSTS`; raw LAN IPs and
localhost work directly. Tailscale is optional.

Other peers still need owner authorization to operate the deployment. Owner
cookies expire after 180 days; CLI sessions after at most 30 days. CLI pairing
requests expire after five minutes. Credentials and claim state survive container
recreation. HTTP access uses the host-only `umiak_owner` cookie; trusted HTTPS
proxy access uses the Secure, host-only `__Host-umiak_owner` cookie.

## Choose your connection

1. **Trusted LAN HTTP:** open `http://HOST:4180`. Use the dashboard, API, CLI and
   MCP at this same origin. This is the default with no certificate setup.
2. **Tailscale Serve (recommended for remote access and browser secure contexts):**
   Serve supplies HTTPS for the tailnet hostname and keeps access within your
   tailnet. Enable HTTPS certificates and MagicDNS in your tailnet, then run:

   ```sh
   TS_AUTHKEY=YOUR_KEY TS_HOSTNAME=umiak docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml up -d --build
   ```

   Open `https://umiak.YOUR-TAILNET.ts.net`; the sidecar's `tailscale status` reports
   its hostname. Supply the auth key through the environment and keep it out of
   source control. Its state volume retains node identity. The sidecar connects to
   the owner HTTP ingress on a dedicated network; it does not share an application
   upstream network. Owner authorization still applies; Tailscale identity headers
   are discarded. Funnel is disabled in the supplied configuration.
3. **Funnel or your own HTTPS reverse proxy:** if you use Funnel, this is public.
   An Internet-facing reverse proxy also publishes the deployment to the Internet;
   owner authorization remains required. Prefer Serve for private remote access.
   Terminate HTTPS at your proxy and forward to `http://127.0.0.1:4181`, including
   WebSocket upgrades. Configure `UMIAK_PUBLIC_URL=https://your-hostname`. The proxy
   must restrict accepted Hosts and overwrite `X-Forwarded-Proto`,
   `X-Forwarded-Host` and `X-Forwarded-For`. Port 4181 is a trusted listener published
   only on host loopback: never publish it on a wildcard/LAN/tailnet address.
   Public port 4180 ignores every forwarded header, including connections arriving
   from Docker NAT or loopback. On the proxy socket only loopback, the container's
   actual network gateway and the sidecar are admitted. The optional
   sidecar uses port 4181 on its isolated network. Extra proxy-chain hops can be
   listed in `UMIAK_TRUSTED_PROXY_CIDRS`; this never enables forwarding on 4180.

For host-run Tailscale Serve:

```sh
tailscale serve --bg --https=8443 http://localhost:4181
```

For host-run Caddy (the site name restricts Host):

```caddyfile
umiak.example.com {
    reverse_proxy 127.0.0.1:4181 {
        header_up X-Forwarded-Host umiak.example.com
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-For {remote_host}
    }
}
```

For nginx, use a TLS server with `server_name umiak.example.com` (and reject
unknown names in the default server). Inside its `location /`:

```nginx
proxy_pass http://127.0.0.1:4181;
proxy_set_header Host umiak.example.com;
proxy_set_header X-Forwarded-Host umiak.example.com;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

When generating PVE host preparation over non-loopback HTTP, setup warns next to
the command: the downloaded script runs as root, and the callback sends the PVE
API token secret, CA and host key unencrypted. Generate and run preparation through
Serve/HTTPS. The command downloads a file, displays its SHA256 and checks it before
dry-run and execution. This detects a changed script but cannot authenticate an
HTTP-delivered page or protect its callback.

Setup and Settings show the warning **if you use Funnel, this is public** whenever
the current origin hostname ends in `.ts.net`; the hostname alone cannot establish
whether Serve or Funnel is in use.

Serve covers the dashboard hostname and cannot cover wildcard sandbox preview
hostnames. Default previews remain `http://<slug>-<port>.<IP-derived-sslip.io>:8085`,
using the guest gateway's separate HTTP listener. For example, a gateway at
`192.168.1.10` can use `http://<slug>-3000.192.168.1.10.sslip.io:8085`.
Token access remains the default; `umiak port 3000 --public` deliberately allows
anyone who can reach that preview. The gateway listener still enforces token,
public and team policies; HTTP does not remove those checks. sslip.io supplies DNS
only. Use your own wildcard DNS if needed. `UMIAK_PREVIEW_PORT` changes port 8085;
configured non-quickstart deployments may use HTTPS preview URLs instead.

## Browser secure contexts

The dashboard and terminal can work over LAN HTTP. Copy buttons use
`document.execCommand("copy")` when Clipboard API is absent or denied; if both
methods fail, select and copy the visible text manually.

The desktop viewer follows the configured preview scheme and port (HTTP8085 in
quickstart). Its WebSocket video path needs WebCodecs `VideoDecoder`, unavailable
on ordinary LAN HTTP. Serve secures the dashboard only; it cannot secure a
separate wildcard HTTP viewer. An HTTPS dashboard cannot embed an HTTP viewer
because of mixed-content policy. Open the viewer separately for HTTP experiments;
apply any test override to its exact origin as well. Operators can serve the viewer
through their own HTTPS proxy. An HTTPS viewer inside an HTTP dashboard also loses
secure context until opened in a new tab. WebRTC `RTCPeerConnection` remains
available in tested Chromium HTTP contexts; this does not prove a complete remote
desktop stream works in every browser. Desktop does not capture browser camera or
microphone. No dashboard `getUserMedia` or `crypto.subtle` calls were found.
Clipboard API is unavailable on LAN HTTP, but execCommand fallback remains.
The terminal uses same-origin ws/wss and works over HTTP.

For secure-context features choose one of these four options:

1. Tailscale Serve (recommended).
2. Localhost, including an SSH tunnel: run
   `ssh -L 4180:localhost:4180 <docker-host>`, then open `http://localhost:4180`.
   Localhost is treated as potentially trustworthy by browsers.
3. Your own HTTPS reverse proxy with a trusted certificate.
4. For a quick Chrome test only, open
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add this deployment's
   exact origin, enable it and relaunch Chrome. This weakens browser protection;
   remove the exception after testing. It does not establish certificate trust.

## Wizard

Open `/setup`. Each step records status and errors in Postgres and can be retried.

1. Enter the Proxmox HTTPS origin, node name and SHA256 leaf certificate fingerprint
   verified at the Proxmox console. Existing token/key/root CA can be mounted into
   `pve-secrets`; otherwise use host preparation to provision them. Fingerprint
   checking protects discovery; the worker uses the actual Proxmox root CA.
2. Adopt an existing host, or generate a preparation command. With least-privilege
   API tokens, generate the read-only adoption report command, run it as root on the PVE host. This reports existing user/token,
   pool, SDN, IPSet/rules and node-agent without changing host objects. Host script
   URLs are expiring, single-use capabilities; keep them private. Inspect `--dry-run`
   first. Fresh preparation fails closed if shared host networking/firewall
   prerequisites are missing; it does not silently enable global policy.
3. Choose lvmthin storage, sandbox VMID range within 500–589 and RAM cap up to 8192 MiB.
4. Set the guest-reachable gateway address, tunnel URL and preview domain. IPv4
   defaults use sslip.io for DNS only. Apply changed gateway/worker settings with
   `docker compose up -d --force-recreate gateway-secrets` followed by
   `docker compose restart gateway worker api web`. Do not reissue the CA trusted by
   existing templates. On the prepared dev stand preserve its explicit tunnel URL.
5. Register existing template builds, or build Linux in an empty template slot.
   Optional desktop/Windows recipes require their ISO/media prerequisites. Occupied
   templates are never rebuilt by the wizard. Build status is durable; after an
   interrupted server restart retry a failed job.
6. Run the smoke test: one 2 GiB Linux sandbox, exec, deletion. Setup is complete only
   after every step succeeds. Running sandbox RAM is checked before creating a VM.

Getting started is at `/app/getting-started` (`/app/help` redirects) with this deployment's actual CLI, MCP and SDK URLs and copy
buttons. The dashboard sidebar links Getting started and Setup.

## Guest certificates and expiry

The guest tunnel still uses TLS and the existing gateway CA; dashboard HTTP does
not change guest trust. A newly generated guest CA lasts ten years. Existing CAs
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
curl -fsSL http://HOST:4180/install.sh -o umiak-install.sh
sh ./umiak-install.sh
```

With Serve or a public HTTPS proxy, substitute its HTTPS origin. There is no
quickstart owner CA. For your own proxy using a private CA, obtain and verify that
CA through your trusted operator channel; generic client CA support remains:

```sh
curl --cacert ./proxy-ca.pem -fsSL https://your-proxy/install.sh -o umiak-install.sh
CURL_CA_BUNDLE="$PWD/proxy-ca.pem" UMIAK_INSTALL_SKIP_LOGIN=1 sh ./umiak-install.sh
umiak login --api-url https://your-proxy --cacert ./proxy-ca.pem
```

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
trusted proxy. Docker Desktop NAT and Serve can collapse clients into one source,
sharing those limits. CLI sessions can be revoked at `/owner/sessions`.

## Console recovery and legacy modes

For a deliberate full access reset only, a trusted Docker operator can invalidate
all owner sessions and CLI pairings and print a new one-time claim code. For a new
browser use non-destructive sign-in below:

```sh
docker compose exec quickstart node deploy/compose/quickstart/run.mjs node deploy/compose/quickstart/recover.mjs
```

This changes only owner access; setup, VM data and guest trust are preserved. The
recovery command is deliberately unavailable over HTTP.

Legacy OIDC: `docker compose -f deploy/compose/compose.yaml up -d --build`.
Legacy S15: add `-f deploy/compose/local.yaml`. Do not run two stacks over the same
DB simultaneously. Protect and back up named volumes; `down -v` deletes state.

CT590 deployment: `infra/dev-cp/deploy-quickstart.sh`; rollback:
`UMIAK_DEVCP_AUTH_MODE=none infra/dev-cp/deploy.sh` (or `oidc`). No PVE objects,
gateway CA or guest port are replaced by that quickstart deployment.

## Local validation

Run `pnpm build` before the compiled CLI gate, then:

```sh
node --test deploy/compose/canonical-fetch.test.mjs deploy/compose/quickstart/*.test.mjs deploy/compose/local/*.test.mjs deploy/compose/meta-proxy.test.mjs
```

Missing host CLI binaries fail the compiled gate. The quickstart fixtures exercise
HTTP pairing and trusted proxy origins using an isolated owner store. Gateway
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
curl -fsSL http://HOST:4180/install.sh | UMIAK_INSTALL_SKIP_LOGIN=1 sh
```

A native Darwin arm64 build measured 90,976,226 bytes before gzip and 40,887,362
bytes downloaded (55.1% smaller); exact release sizes are in `/downloads/DOWNLOADS`.

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

## Proxy isolation and upgrade notes

Docker Engine **28 or newer** is required for loopback-publish isolation from
other hosts on the same layer-2 network. Port 4181 also checks its socket peer:
loopback, the gateway the engine actually assigned to the container's network
(read from `/proc/net/route` at startup, e.g. 172.29.116.128 on CT 590), or the
Serve sidecar (172.30.116.12). No fixed gateway address is assumed, so a
container that happens to hold .1 or .128 is not trusted. `UMIAK_TRUSTED_PROXY_CIDRS` controls forwarding
chain traversal only; it cannot admit another socket peer. Port 4180 ignores
forwarding headers from every peer.

Docker Desktop caveat: Desktop NATs container traffic, so a container on any
network that reaches port 4181, through `host.docker.internal` or directly at
the quickstart container address, arrives from the same gateway as host
traffic. The server cannot distinguish these peers. Treat containers on that
Docker host as trusted operators, restrict accepted proxy Hosts with
`UMIAK_PUBLIC_URL`, and do not present loopback publishing as container isolation.
On Linux Docker Engine, direct container peers do not gain forwarding trust. Existing networks
are retained; this polish makes no host firewall or network changes.

After upgrading from instructions pointing host-run Serve at `localhost:4180`,
run `tailscale serve --bg --https=8443 http://localhost:4181`. The old target
silently loses the HTTPS origin and Secure `__Host-` owner cookie selection.
Owner state and sessions remain stored; use the same HTTPS hostname and new target.

The two fixed `/quickstart/ui/*.woff2` font routes intentionally remain public,
before CIDR, deny and owner checks. They contain only bundled presentation assets;
no deployment settings, owner state or arbitrary paths are exposed.

## New browser or device?

Owner sessions belong to each browser and hostname. Open the deployment, then
enter a one-time sign-in code. Existing sessions and CLI pairings remain valid.
On the Docker host, from the repository directory:

```sh
docker compose exec quickstart node deploy/compose/quickstart/run.mjs node deploy/compose/quickstart/signin-code.mjs
```

The wrapper reads the generated database credential inside the container. Or use
**Owner sessions → Sign in another browser** in a signed-in browser and copy the
code. Codes last ten minutes and work once. Keep them private. After a typo or
rate-limit error, check the code or obtain a new one; source limits reset after ten
minutes. CLI credentials cannot issue broader browser credentials.

Use **Lost every session? Reset owner access** only as a last resort: recovery
revokes all browsers, CLI credentials and pending pairings.
