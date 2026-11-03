# Zero-config self-host quickstart (S16)

From the repository root:

```sh
docker compose up -d --build
docker compose logs quickstart
docker compose cp quickstart:/var/lib/umiak/owner/tls/ca.pem ./umiak-ca.pem
openssl x509 -in umiak-ca.pem -noout -fingerprint -sha256
```

Use the local Docker console as the trust channel. Install this verified CA in your
browser trust store, then open `https://localhost:8444` on the Docker host, or
`https://<configured-DNS-name>:8444` remotely. Set `UMIAK_QUICKSTART_TLS_NAMES` before boot for remote DNS names. DNS can be LAN DNS, mDNS, MagicDNS or
ordinary DNS; Tailscale is optional. For example:

```sh
UMIAK_QUICKSTART_TLS_NAMES=server.home.example docker compose up -d --build
```

The variable is passed into the ingress on first boot. No external relay is used.

Enter the one-time setup code from the logs to claim ownership. Other LAN/tailnet
peers cannot operate the deployment. Owner cookies expire after 180 days; CLI sessions after at most 30 days. CLI pairing
requests expire after five minutes. Credentials and claim state survive container recreation.

For raw LAN/tailnet IP URLs, first open by localhost or a DNS name and visit
`/owner/tls` to add the IPs to the certificate. This takes effect immediately and is
persisted without an `.env` file. Only configured names are accepted. Adding names requires explicit CA rotation and renewed trust; unknown SNI is rejected. The CA expires after one year; rotate it before expiry.
The CA has critical DNS-only permitted subtrees, with configured IPs as leaf SANs.
Bun 1.4.4 (latest stable checked on 2026-11-03) rejects any IP name constraints;
TLS verification stays enabled. This CA is **unconstrained for IP names**. Ingress
issuance stays limited to its configured names, unknown DNS SNI is rejected, and
the signing key never leaves the owner volume. Trust this CA only on owner clients.
The guest gateway on port 443 uses its own independent CA.

Adding configured names after first boot keeps existing addresses serving with
the old CA and logs a warning, also shown in Setup and `/owner/tls`. An owner can
explicitly rotate at `/owner/tls` (also for an old IP-constrained CA), or use the
trusted Docker console:

```sh
docker compose exec quickstart node deploy/compose/quickstart/rotate-ca.mjs server.home.example 192.168.1.10
docker compose restart quickstart
docker compose cp quickstart:/var/lib/umiak/owner/tls/ca.pem ./umiak-ca.pem
openssl x509 -in umiak-ca.pem -noout -fingerprint -sha256
```

The command prints the new fingerprint. Replace the old CA in browser trust and
CLI CA files; existing sessions, database and guest gateway trust survive. Do not
run console rotation concurrently with an owner UI rotation. Leaves renew daily
when less than seven days remain, without restarting the ingress or changing CA
trust. The one-year CA itself requires an explicit owner rotation before expiry.

## Wizard

Open `/setup`. Each step records status and errors in Postgres and can be retried.

1. Enter the Proxmox HTTPS origin, node name and SHA256 leaf certificate fingerprint
   verified at the Proxmox console. Existing token/key/root CA can be mounted into
   `pve-secrets`; otherwise use host preparation to provision them. Fingerprint
   checking protects discovery; the worker uses the actual Proxmox root CA.
2. Adopt an existing host, or generate a preparation command. With least-privilege
   API tokens, generate the read-only adoption report command, copy the verified
   owner CA to the PVE host and run it as root. This reports existing user/token,
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

## Install and pair the CLI

With the verified CA saved as `~/.config/umiak/quickstart-ca.pem`:

```sh
curl --cacert ~/.config/umiak/quickstart-ca.pem -fsSL https://HOST:8444/install.sh |
  UMIAK_CA_CERT="$HOME/.config/umiak/quickstart-ca.pem" sh
```

For a publicly trusted certificate the command is simply
`curl -fsSL https://HOST:8444/install.sh | sh`. The installer detects Darwin/Linux
arm64/x64, verifies SHA256SUMS, installs to `~/.local/bin` (`UMIAK_INSTALL_DIR` overrides
it) and starts `umiak login`. Open its pairing URL in the claimed browser, compare
the short code and enter it to approve. Never approve a request you did not start. If your owner browser uses another
hostname for this same deployment, open the pairing path and request ID on that
claimed hostname; cookies are intentionally host-only.

```sh
umiak create --template linux --size 2gb --wait
umiak exec <slug> -- uname -a
umiak rm <slug> --yes
```

CLI profiles retain the CA path. `umiak logout` revokes that CLI's owner credential.
Windows x64 CLI is available under `/downloads/umiak-windows-x64.exe`; the shell
installer supports Darwin and Linux.

## Console recovery and legacy modes

If the owner browser is lost, a trusted Docker operator can invalidate all owner
sessions and CLI pairings and print a new one-time claim code:

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

## Optional Tailscale Serve (publicly trusted owner HTTPS)

Enable HTTPS certificates and MagicDNS in your tailnet, then run:

```sh
TS_AUTHKEY=YOUR_KEY TS_HOSTNAME=umiak docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml up -d --build
```

Open the node's `https://umiak.YOUR-TAILNET.ts.net` URL (see
`docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml exec tailscale tailscale status`).
Claim with the Docker log code, then `curl -fsSL https://umiak.YOUR-TAILNET.ts.net/install.sh | sh`
and enter the CLI short code in the owner browser. No CA download or `--cacert` is needed.
The state volume retains node identity; protect the auth key and do not commit it.
Serve uses userspace networking and connects only to the private owner ingress;
its internal HTTPS target skips certificate verification within a dedicated network
shared only with quickstart. It connects by a fixed internal IP without SNI, so
enabling Serve requires no new owner-CA name. The sidecar has no network in common
with api, mcp, web or postgres. It never bypasses the owner gate. Tailscale identity headers are stripped,
not used as authentication. Funnel is disabled. The fixed sidecar address is used
only to report public certificate handling in metadata, never to grant access.

Serve cannot issue wildcard certificates. Sandbox previews continue to use the
gateway wildcard domain/certificate and its separate trust configuration. The LAN
owner endpoint remains available with the constrained owner CA; Tailscale is optional.

Pairing pending limits and request limits use the socket source, never arbitrary
forwarded headers. Docker Desktop NAT and Serve can collapse multiple clients into
one source: they share its limits. Pending entries expire after five minutes;
short codes, timestamp and client details help detect unsolicited pairing attempts.
CLI sessions expire after 30 days and can be individually revoked at `/owner/sessions`.

If you change Serve's HTTPS port, set `UMIAK_QUICKSTART_SERVE_PORT` on the owner
service to that port (default443). The trusted sidecar peer plus MagicDNS origin
port select the installer instructions only. This avoids confusing direct private
HTTPS with Serve when Docker NAT gives both the same socket source; neither source
nor origin port confers owner authorization.


## Compiled CLI TLS gate

Run `pnpm build` first, then
`node --test deploy/compose/quickstart/*.test.mjs deploy/compose/local/*.test.mjs deploy/compose/meta-proxy.test.mjs`.
The quickstart wildcard includes `compiled-cli.test.mjs`; missing host binaries
fail rather than skip. It executes `apps/cli/dist/umiak-<os>-<arch>` against a real
HTTPS quickstart ingress and its generated constrained CA, with an isolated owner
store and metadata upstream fixture. Both DNS localhost and raw IP login must
reach `/v1/meta` and create pairing requests. This catches Bun verifier failures
that source tests under Node cannot detect. TLS tests also exercise first-boot DNS,
pending-name restart, explicit rotation and a one-day leaf renewed at runtime.
Compose assertions ensure the optional sidecar cannot share any upstream network.

### Installer download and pairing

The installer downloads gzip archives (the default `gzip` utility is present on
macOS and common Linux distributions), announces the release/platform/compressed
size, and uses curl's progress bar on terminal stderr. Piped stderr stays quiet
apart from status and errors. SHA256SUMS covers both the downloaded archive and the
extracted executable; either mismatch preserves the previous installation. The
verified executable is installed by an atomic rename in the destination directory.

The installer prints the PATH hint before starting owner pairing. Set
`UMIAK_INSTALL_SKIP_LOGIN=1` to install without starting a pairing request; it prints
the manual `umiak login` command, including the selected CA when needed. For example:

```sh
curl -fsSL https://your-deployment/install.sh | UMIAK_INSTALL_SKIP_LOGIN=1 sh
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
VirtIO defaults to Fedora's official stable alias:
<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso>.
Its checksum field deliberately starts empty: the alias moves and Fedora's
`CHECKSUM` currently lists RPM MD5s, not an ISO SHA256. Download the ISO on a
trusted workstation and compute `sha256sum virtio-win.iso` (Linux),
`shasum -a 256 virtio-win.iso` (macOS), or `Get-FileHash virtio-win.iso -Algorithm
SHA256` (PowerShell); confirm it against your trusted distribution source.

Native downloads need `Datastore.AllocateTemplate` on `/storage/<iso-storage>`
and `Sys.AccessNetwork` on `/nodes/<node>`. Fresh preparation generates the
scoped `UmiakMediaDownload` role; adoption reports whether this optional capability
is present. Existing hosts are not modified by adoption. A missing capability
blocks downloads with an actionable error, without blocking ordinary adoption.
Do not grant cluster-wide `Sys.Modify` just for ISO downloads. These checks match
[PVE's API implementation](https://github.com/proxmox/pve-storage/blob/master/src/PVE/API2/Storage/Status.pm).

URLs reject credentials, non-HTTPS schemes, and internal/loopback DNS answers
unless the owner explicitly checks the internal URL permission. HEAD preflight
validates each redirect before handing the final HTTPS URL to PVE. Fedora's
same-host HTTP redirect is upgraded to HTTPS. PVE performs its own later DNS
lookup and GET, so the administrator must trust the source and DNS; Umiak does not
proxy the bytes or control a source that changes between preflight and download.
Progress and failures are taken from the PVE task log. No ISO download or Windows
build is part of validation-only checks.

The selected ISO storage is resolved by the restricted node-agent's read-only
`media.sha256` operation through `pvesm path <storage>:iso/<name>`. Update the
node-agent when using this new optional storage argument on an existing host.
