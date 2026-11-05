# S25: Signed prebuilt Linux images

Status: design for review, 2026-11-06. Product implementation has not started.
Owner decisions: public-read R2, names **Umiak Linux** and **Umiak Linux Desktop**,
per-boot CA pinning, direct QEMU/KVM CI, and no image publication before
distro confirmation and redistribution clearance. This supersedes the initial GHCR proposal. Windows remains a local
build from the owner's licensed ISO.

## Intent and integration

Publish `linux` and `linux-desktop` once from manual CI. Current recipes use
Ubuntu 26.04; the base distro is pending master/Ilia confirmation (Debian 13 is
under consideration). Mechanism and artifact contracts are distro-agnostic.
An install downloads and verifies one image on one eligible PVE node, imports
into a newly reserved template VMID, verifies a clone, then promotes. Other
nodes use S21 `volume.sendTo`; they never download another upstream copy.
Default wizard action: “Download the Linux template”; advanced action: “Build
locally from recipe”. Expose download/verification/import/clone-check/copy
progress and actionable retry errors. Do not silently fall back to a local build.

Extend S22 `recipe-channel.mjs` and `recipe-rollout.mjs`, preserving their daily
poll, shared stable/edge selection, maintenance fence, node reservation,
registration, rollback and reference-aware 24-hour retirement. Linux image
selection must not depend on the private repository Releases API. Windows
continues using recipe bundles and recorded ISO inputs. A channel switch
invalidates the previous selection; recheck channel and maintenance immediately
before promotion. Running sandboxes retain their build.

Relevant code: `apps/template-builder/src/{build,stages,seed,seal,verify}.ts`,
`deploy/compose/quickstart/{setup-build,recipe-channel,recipe-rollout}.mjs`,
`packages/pve/src/{machine,node-client}.ts`, `services/node-agent/internal/ops/`,
`services/guest-agent/internal/{ident,agent,update}/`, `libs/tunnel/wstransport`.
Do not change `apps/web`; coordinate runtime provisioning changes with S24's
move into `apps/api` after rebasing. No host/stand access is authorized.

## Generic-image audit

| Input/state | Current behavior | Published-image requirement |
| --- | --- | --- |
| Tunnel CA | Required in signed agent package; loaded from current version's trust directory | No installation CA on disk; boot fingerprint supplies trust |
| Update keys | Source has global keys, but quickstart generates per-install signing keys | Global agent-update authority stays separate from recipe publisher; preserve legacy packages |
| Tunnel endpoint | Optional seed `agent.toml`; SMBIOS family already overrides URL | No baked endpoint; boot family supplies it |
| CLI API URL | Seed may install `/etc/umiak/config.json` | Omit; configure per-install endpoint at runtime/claim |
| SSH user CA | Seed accepts install CA; claim/reset manage SSH trust | Empty generic files; claim provisions install CA |
| Subnet/gateway/MAC | Build VM uses install network; template netplan is DHCP, matches `en*` | Keep DHCP; remove leases, MAC bindings and generated network state |
| DNS | DHCP plus global fallback 1.1.1.1/9.9.9.9 | No install resolver baked; retain documented fallback policy |
| Agent/CLI versions | Builder facts and exact tool pins | Global immutable versions and SHA-256 in signed metadata, no quickstart identity |
| Machine identity | `umiak-agent seal` empties machine-id, removes state/host keys | Keep; verify dbus machine-id, initrd, hostname and every clone identity |
| Cloud-init | `cloud-init clean --logs --seed`, disable file | Keep; no seed disk, seed state, authorized keys or build SMBIOS |
| Logs/caches/random | Cleanup plus seal removes logs/random seed; initrd rebuilt | Also audit DHCP state, Docker identity, desktop pairing, histories, tokens and credentials |

Desktop loopback listeners and service configs are generic; runtime pairing,
certificates and user/session state must be absent. Scan the final disk offline,
not just the running filesystem, for known build identity/endpoint markers and
secrets. Export only after shutdown; never publish a verification clone. Existing
zero-fill during seal can temporarily allocate most of the 64 GiB disk, despite
only ~7.4 GB used; CI must replace it with offline sparse compaction or budget
for it. Retain trim and cold inspection after cleanup.

## Boot trust (approved model)

Use a versioned SMBIOS `sku` descriptor `umiakca1:<64 lowercase hex>` containing
SHA-256 of the installation CA certificate's DER bytes. The public fingerprint
is not a secret. Gateway sends that CA certificate in its TLS chain. The agent
finds the exact matching CA, constructs an exclusive root pool and performs
normal x509 chain, DNS name, validity, constraints and server-auth checks before
sending bootstrap credentials. Only this custom verifier may bypass the default
system-root verification step; it must always run full x509 verification itself.
Reject missing matching CA, invalid encoding, unknown descriptor versions,
non-CA certificates and invalid chains. No TOFU or system-root fallback.

Absent SKU pin retains the old baked `trust/tunnel-ca.pem` path. A present but
invalid pin never falls back. New generic manifests require a pin; old locally
built templates continue booting without it. Apply the pin on create, warm-pool,
resume/restart, fork and saved-snapshot restore; do not let a snapshot restore
another install's trust. Rotation updates firmware on next boot; existing agents
retain their boot trust until restart. Windows keeps its existing trust path.

PVE caps the full base64 `smbios1` property at 512 characters. With a 36-byte
UUID, 32-byte bootstrap secret (43 base64url characters), `umiak1:` serial,
`umiakt1:wss://<hostname>/v1/connect` family, and `umiakca1:` plus 64 hex digest
SKU, maximum hostname is **143 ASCII bytes**: serialized length 511; 144 bytes
produces 515. This assumes no explicit port; a port consumes the same authority
budget. DNS labels still obey their own limits. Normalize IDNs to ASCII before
counting. Nonstandard paths/ports must use the exact serializer to derive their
smaller maximum rather than applying 143 blindly.

Approved behavior: validate at configuration time in the setup network step and
the API with “tunnel hostname too long; use a shorter name (max N chars)”. Also
retain the final serializer guard. Never truncate, drop the pin or wait until
VM start to discover this constraint. Document N = 143 for the standard endpoint
and calculate N for a nonstandard endpoint. Typical sslip.io/tailnet names fit.

Approved bootstrap boundary: CA-free generic agent first installation in isolated
CI is authenticated by the outer recipe-publisher-signed image. Install the
compiled production binary, units and global update keys directly. Later agent
updates stay under the existing distinct global agent-update authority. Legacy
signed package verification remains unchanged; no new signing secret and no
recipe key reuse for agent updates.

## Artifact and signature contract

Choose **raw+size, compressed with zstd**, matching S21/PVE import. Uncompressed
stream is eight-byte little-endian logical disk size followed by exactly that
many raw disk bytes. Current Linux logical size is 68,719,476,736 bytes. Publish
one independent zstd stream per disk, divided into ordered chunks of at most
512 MiB; chunks are transport boundaries, not separate decompression streams.
Linux currently has only `scsi0`; signed disk lists must explicitly allow future
firmware disks rather than guessing filenames.

Object layout under bucket `umiak-images`:

- `blobs/sha256/<hex>`: immutable chunks and manifest/license/provenance objects.
- `releases/<version>/<slug>/manifest.json` and `manifest.sig`: immutable metadata.
- `channels/stable.json`, `channels/edge.json` and matching `.sig`: mutable signed
  pointers with monotonically increasing sequence, channel, version and exact
  manifest digest for each Linux slug. Publish pointer last, only after both
  images and all referenced objects are readable and verified.

`umiak-linux-image/v1` metadata binds version, slug, channel, amd64, source commit,
recipe tree digest, distro/release/base URL/base serial/SHA-256 (and upstream
SHA-512/signature provenance where available), apt snapshot, agent version/binary digest,
builder API, minimum agent capability, half-open platform range, hardware allowlist,
boot-trust requirement, logical disk size, ordered chunk sizes/digests, compressed
stream size/digest and `sha256-pvesm-raw+size-v1` digest. Include exact installed
package name/version/architecture and source-package/version inventory, tool
versions, source/license inventory digest, build/verify results and measurements.
A content-addressed attached package manifest is acceptable if its size and hash
are inside the signed metadata; it must travel with the release.

Ed25519 detached raw 64-byte signatures cover exact metadata bytes using
`RECIPE_SIGNING_KEY`; verify against baked
`infra/templates/keys/recipe-publisher.pub` or S22's explicit owner override.
Never fetch authority keys from R2. Strict schema, bounded bytes/counts/sizes,
channel/slug/version compatibility and digest checks precede any host mutation.
The configurable download origin is transport configuration, never a source of trust keys.
Persist highest accepted pointer sequence per channel; ordinary polling cannot
roll back. Explicit S22 rollback to a retained verified build is separate.

## Public R2 access and provisioning request

Master reports bucket `umiak-images` already exists on account
`ccd46cd070d0adbdacd7defca520f867`, with public read at
`https://pub-bdc85570347b44df991bfcee2718c4a1.r2.dev`. The probe object was removed;
this branch does not create resources or upload anything. Treat every upload
to this bucket as public distribution. **No image upload until master confirms
the distro and the artifact's license gate is satisfied.**

Installs use anonymous HTTPS GET, with no read token or presigned URL. Configure
`UMIAK_IMAGE_BASE_URL` (default the above URL) and a matching host-side allowlist.
Only relative, validated object keys come from metadata; reject arbitrary URLs,
path traversal and redirects outside the configured origin. HTTPS protects
transport; authenticity comes from baked Ed25519 keys and signed hashes.
[Cloudflare documents r2.dev](https://developers.cloudflare.com/r2/buckets/public-buckets/)
as a rate-limited development endpoint. Handle 429 with bounded retries and
Retry-After, show a clear retry message and retain verified chunks. Production
migration changes the base URL/allowlist to a custom domain; object paths,
signatures, format and installer code remain identical. Do not promise an r2.dev
throughput/SLA or configure cloud resources in this task.

CI S3 endpoint is
`https://ccd46cd070d0adbdacd7defca520f867.r2.cloudflarestorage.com`, region `auto`.
Request one S3 credential pair scoped to **umiak-images only**, R2 **Object Read &
Write**: PUT for chunks/manifests/pointers, GET/HEAD for remote verification,
list as permitted by the preset. No Admin permission, bucket create/delete,
other account or `belov38-releases` access. Cloudflare's supported preset includes
read and list as well as writes; a pure write-only token is not required.

GH secret names: `R2_IMAGES_ACCESS_KEY_ID`, `R2_IMAGES_SECRET_ACCESS_KEY`, plus
existing `RECIPE_SIGNING_KEY`. Ask master to provision these when implementing
the upload workflow, not for design/testing. Endpoint/account/bucket are non-secret
configuration. Materialize credentials/signing key as restricted temporary files,
never env/argv/log/git; no tracing. Existing recipe workflow uses an env secret;
do not copy that pattern. Test file-only loading and cleanup on failure.

Mirror plan: retain content-addressed objects and identical signed metadata so
an authorized second origin can serve the same bytes. No GHCR mirror or other
public copy is created automatically; fallback origins must be explicitly
configured and use the same verification and hostname guards.

## Restricted download/import

Add node-agent operations `image.prepare` and `image.import`, with local durable
job identity. Prepare accepts bounded signed metadata/signature and verifies
publisher trust locally as well as in quickstart. It yields missing digest keys;
control plane resolves only those against the configured public base. Node-agent accepts no
commands, arbitrary paths, arbitrary storage names or caller-selected executable.
Restrict destinations to configured template ranges, excluding CT 590, using the
existing durable build reservation and owned empty VM/staging guards.

Download into a root-owned digest cache with no symlinks. Stream SHA-256 with
bounded buffers; enforce exact chunk length and metadata totals. Atomic rename
and fsync mark verified chunks. Retry each chunk at most five times with bounded
backoff, Retry-After handling and cancellation; rehash cached chunks after restart.
Retrying only a failed <=512 MiB chunk is the initial resume strategy, independent
of server Range support. Enforce free-space budget and cache quota before fetch.
Allow only the configured public base origin; redirects may
not escape the allowlist. Redact query strings and credential fields in all errors.

Concatenate verified chunks into zstd decoder, enforce decompressed byte limit,
check size header and stream SHA-256 through `pvesm import ... raw+size -` to
owned staging. Check zstd EOF, no trailing/extra frames beyond declared data,
expected digest, importer exit and destination UUID before durable receipt.
Cancellation or failure never publishes staging. Partial PVE imports restart;
verified download chunks survive. A receipt binds metadata digest/job/destination
UUID, size and raw+size hash. Crash recovery validates UUID and ownership before
reuse/removal; never delete unrelated LVs. Storage validation reuses S21 guards.

Create template VM through the existing restricted PVE path with allowlisted
hardware. Clone verification checks agent boot/trust, identity reset, baseline
and desktop readiness, then registration/promotion use existing services. Attach
image identity to the ordinary build manifest. Replicate that same verified
build via S21. Failed replicas keep their previous active build. A failed or unavailable channel reports an actionable error and offers advanced
local build explicitly.

## CI build and publication

New workflow is **workflow_dispatch only**, with version, stable/edge and publish
(default false) inputs. Build exact committed pins, never floating dependencies.
Probe `/dev/kvm` by starting a KVM VM, RAM and actual free disk before any build;
standard runners may fail. Do not silently use TCG or any Proxmox host. GitHub
calls [nested virtualization experimental/unsupported](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners). [GitHub standard private Linux
runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) advertise 2 CPU, 8 GB RAM and 14 GB disk: spare disk is not assured.
Build slugs sequentially, release intermediate images between slugs, stream
compression/chunk upload, and report peak disk. The sparse 64 GiB disk does not
justify a 64 GiB initial allocation. On probe failure report larger-runner or
paid ephemeral-builder options to master; no automatic paid fallback.

A QEMU adapter reuses recipe/seed/GuestIo step execution, fact collection, cleanup
and cold verification. Use QGA over a local Unix socket with QMP for lifecycle;
user-mode network during build, no install network. Guest agent package contains
no test aids. Snapshot apt retries remain bounded; add connect/read/overall
step timeouts so an archive outage fails CI rather than hanging. Never switch
to unpinned mirrors to make a release pass. Capture npm integrity and all other
non-apt input hashes as provenance; snapshot apt alone is not bit reproducibility.

Keep signer isolated from build execution: untrusted guest has neither R2 writer
nor signing key. After cold checks pass, a host signing step validates artifact
paths/schema and signs metadata, uploads immutable objects with conflict checks,
verifies remote reads and publishes the signed channel pointer last. Re-running
a version with different bytes fails. Retention never deletes an artifact still
referenced by a channel or retained release. A dedicated protected approval step
must prevent publication pending distro confirmation and legal clearance. All
image publishing runs require master's go-ahead in this phase.

## Alternative: official base plus signed offline layer

| Dimension | Prebuilt customized image | Official unmodified base + offline layer |
| --- | --- | --- |
| Legal posture | Modified Ubuntu aggregate; public clearance blocked for Ubuntu | Official image fetched directly from Canonical, customization local; avoids our distribution of customized disk, but package/CLI redistribution obligations remain |
| Install work | Download, hash, import, clone-check | Download pinned official image plus signed layer, import, boot, install/configure/reboot/seal/verify locally |
| Time | Network + import; no package installation | Network plus dpkg scripts, initrd/kernel, Rust/tool/npm extraction and reboot; couple of minutes is a target, not evidence |
| Size | Compression of installed root disk | Base image + compressed exact deb dependency closure + tool archives/npm/Rust components; may be smaller or larger; measure both |
| Reliability | No guest archive dependency; retry chunks | No archives if dependency closure complete; still depends on official base availability and successful local package scripts |
| Complexity | QEMU build once, guarded raw import | Separate offline resolver/replay engine, versioned base/delta closure and per-node local build |

Recommendation: implement **prebuilt images once distro and license gates clear**.
For Ubuntu without redistribution clearance, prefer the official-base/offline-layer
route for a future public offering; for a cleared Debian derivative, prebuilt
images best satisfy the original install-speed/reliability goal. Keep the offline-layer route documented for a future distribution decision;
implementing it requires a separate approved scope. It
cannot be just debs: current recipes also fetch Docker keys, npm native optional
packages, Rust components, browser packages, toolchain archives, Sigstore bundles and desktop
assets. A viable layer must capture and hash all transitive inputs, retain apt
Release/Packages signatures, stage an offline local apt repository, and replay
with network disabled. Check full final package manifests against CI. Fetch the
unmodified official base from `cloud-images.ubuntu.com` with both pinned SHA-256
and Canonical-signed sums. Public-source/licensing review is still required;
private hosting alone does not turn third-party conveyance into internal use.

## Debian 13 revival (conditional, not a distro decision)

Inspect and selectively port `19fb361b` (shared Linux/debian build and dual pins)
and `5ae76ad0` (catalog/setup integration), reverted by `ac5e7996` and `39766e0a`.
Do not blindly revert the reverts: `5ae76ad0` touches `apps/web` and Payload
migrations which overlap S24. The old `debian` slug used VMID 594; S25 keeps
public product slugs `linux` / `linux-desktop` and allocates from each install's
configured range. No stand VMID is authorized for use.

Port the Debian base downloader/pin resolver, genericcloud source schema,
SHA-512 plus SHA-256 checks, Debian apt snapshot/deb822 helpers, distro seed
environment, kernel checks, Java package selection and Docker Debian repository.
The old implementation used HTTPS-reviewed cloud checksum pins rather than a
Canonical signing key; verify current Debian cloud provenance support before
settling that trust path, and never call two hashes a signature. Snapshot slowness
is a bounded CI problem, not an installer archive dependency.

The reverted recipe is headless. Desktop needs Debian-specific Sunshine package
compatibility and dependency resolution, kernel/input/video/desktop smoke tests,
and fresh immutable pins; do not install an Ubuntu-specific deb blindly. Check
Chromium's supported dependencies and every binary's glibc baseline. Avoid adding
a new catalog slug/migration unless master chooses that behavior. Record distro
in signed metadata and manifests, show it in template details, and keep existing
Ubuntu builds usable until unreferenced retirement. A distro change affects new
sandboxes only and remains a master decision.

[Debian's DFSG](https://www.debian.org/social_contract) supports redistribution and
derived works; [Debian trademarks](https://www.debian.org/trademark) still require
accurate naming/no implied endorsement. Use Umiak product names and factual
base attribution. This does not waive individual package/non-free licensing.

## Approved bundled-tool policy

Replace Google Chrome with the selected distro's Chromium package, retaining
browser automation/CDP and computer-use behavior. Update executable discovery,
Chrome-named desktop defaults/policies and verification to test Chromium. Debian
package and dependencies need fresh snapshot pins. Ubuntu's Chromium packaging
may depend on snap, which the current recipe removes; do not silently restore
snap or download a third-party browser binary. If Ubuntu is selected, resolve
this packaging constraint with master before implementation.

Exclude Claude Code and every other proprietary/unresolved-redistribution CLI
from the published disk. A first-boot optional installer uses the vendor's
official source, exact version and checksum where published, with bounded retries
and visible status. If no vendor checksum exists, record that fact and the exact
HTTPS source; do not fabricate an integrity guarantee. Do not bundle the
proprietary payload inside the installer. Offline failure is nonfatal to agent,
sandbox and desktop readiness; explain that the tool is unavailable and permit
an explicit retry. No user credentials, license acceptance or login is automated.
This optional internet access is separate from template import: import itself
needs no snapshot archive and must not wait for a proprietary tool install.

Apache/MIT tools may stay with required notices. Sunshine/moonlight remain with
GPLv3 license texts and source links/offer in the image and signed manifest;
retain exact corresponding source/build instructions and meet the applicable
source-delivery obligations, not merely an unversioned upstream homepage.
The signed inventory distinguishes bundled packages from optional external tools
and includes each version, license, notices, source correspondence and hashes.

## License inventory and publication gate

This is a source-level inventory; exact pinned archive/deb license texts and
transitive notices must be extracted by CI before any clearance claim. No
public redistribution is authorized. Canonical's current policy permits internal
modification, preserves component-license rights, and requires approval for
modified redistribution associated with its marks; its alternative describes
removing marks and recompiling. Umiak names avoid implied endorsement but do not
by themselves clear the modified aggregate. See [Canonical policy §2–4](https://canonical.com/legal/intellectual-property-policy).

| Shipped component | Finding / obligation / unresolved evidence |
| --- | --- |
| Ubuntu packages, kernel, desktop fonts/Xorg/LightDM/Openbox/PipeWire | Mixed licenses; collect each `/usr/share/doc/*/copyright`, source package/version, notices and corresponding-source material as required. Kernel/GPL obligations remain for binary conveyance; apply the same inventory to Debian if selected |
| Google Chrome `.deb` | Exclude from images; replace with distro Chromium. Proprietary product; [Chrome terms](https://www.google.com/chrome/terms/) incorporate Google's general terms. Do not infer redistribution rights from downloadable debs. Verify exact package EULA/permission; do not bundle pending any future permission |
| Claude Code npm package | Exclude from images; optional first-boot vendor install. [Anthropic legal docs](https://code.claude.com/docs/en/legal-and-compliance) govern product use; not an assumption of permissive source licensing. Record the external installer/version policy; do not redistribute unresolved payloads |
| Codex / Gemini CLI | Upstream [Codex](https://github.com/openai/codex/blob/main/docs/license.md) and [Gemini](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) identify Apache-2.0; retain licenses/notices and audit bundled native dependencies. Service credentials/terms remain per user |
| OpenCode | [Pinned 1.19.5 license](https://github.com/anomalyco/opencode/blob/v1.19.5/LICENSE) is MIT; retain copyright/license and inspect native bundles |
| Sunshine / moonlight-web | Pinned [Sunshine](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/LICENSE) and [moonlight-web](https://github.com/MrCreativ3001/moonlight-web-stream/blob/v3.0.1/LICENSE) carry GPLv3 texts; retain exact corresponding source/build material and notices; audit linked codecs/dependencies |
| Cua Driver | [Upstream inventory](https://github.com/trycua/cua/blob/main/legal/LICENSING.md) identifies Driver releases as MIT, while other Cua products differ. Inspect 0.38.0 archive specifically; retain notices; do not apply a repository-wide assumption |
| Docker/containerd/Compose/Buildx, Node/npm, Go, Bun, uv, gh, Rust/rustup, pnpm, cosign | Record exact installed artifact and dependency licenses, copyright and required source/NOTICE. Package version pins are not a license inventory |
| Umiak agent, CLI and files | Include repository license plus Go/JS embedded third-party notices; no credentials, signing keys or install CA |

CI produces machine-readable inventory entries with name/version/hash/source URL,
license expression or `NOASSERTION`, notice paths, source correspondence and
review status. Unknown/proprietary entries block public release, not silently
get labeled MIT. Local internal testing remains separate from public R2 uploads. Bucket visibility
does not provide license permission; Debian selection would not clear Chrome or
Claude Code redistribution by itself.

## Hosting research (checked 2026-11-06)

R2 is the owner's selection. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
currently gives Standard storage $0.015/GB-month, 10 GB-month free, 1 million
Class A and 10 million Class B requests free, with no egress fees. Use Standard,
not Infrequent Access. [Limits](https://developers.cloudflare.com/r2/platform/limits/)
allow 5 TiB objects, 5 GiB single uploads; 512 MiB chunks fit. Account/token scopes
follow [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).
[Presigned GETs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) expire
within 1 second–7 days and use the S3 endpoint, not custom domains.

For comparison, [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
supports OCI/public anonymous pulls, 10 GB per layer and a 10-minute upload
limit. Its official documentation does not publish a numeric anonymous-pull
quota; do not promise unlimited service. [Container storage/bandwidth is currently
free](https://docs.github.com/en/billing/concepts/product-billing/github-packages).
[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
require each asset under 2 GiB and repository read access, so the private repo
cannot serve anonymous installs. No GHCR mirror is enabled before distro/legal clearance. Future authorized mirror uses identical digests/signed bytes and a
configured allowlist, never an unsigned alternate image.

## Measurements and acceptance

Historical S21 evidence: ~7.4 GB allocated, 64 GiB logical; 44–76 seconds per
copy on 1 GbE (`docs/specs/s21-portable-sandboxes.md`). These are **not** measured
S25 compressed size or import times. No build/download/live import has run here.

Planning estimate only: if compressed size is 3–5 GiB, ideal download is 4.3–7.2
minutes at 100 Mbit/s, 21.5–35.8 minutes at 20 Mbit/s, or 26–43 seconds at 1 Gbit/s.
Import, hashing 64 GiB, decompression, fsync and clone verification are additional;
provisionally allow 1–5 minutes for import and measure it. Do not promise those
ranges as benchmarks. Formula: download seconds = compressed bytes * 8 / bit rate.

Required evidence per slug: raw/logical/allocated/compressed bytes, chunk count,
peak runner disk/RAM, CI duration, download rate/retries, import/decode/hash elapsed,
PVE thin allocation, clone readiness time, package/license manifests, two different
install CA tests and S21 copy receipt equality. Master performs live PVE runs.
Unit/fixture tests cover malicious metadata/URLs, signature failures, compatibility,
channel switches, rollback sequence, quota/full disk, interrupted chunks/import,
crash receipt ownership, malformed pins and legacy trust. Run Biome, Vitest, Go
and golangci-lint for changed modules, plus quickstart node tests from repo root.
