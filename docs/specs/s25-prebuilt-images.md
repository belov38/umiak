# S25: Official Ubuntu base and signed offline Linux layers

Status: revised implementation design, 2026-11-06. Ilia's two-layer decision
supersedes the prebuilt customized-disk design approved at 2caf12a6. Boot trust
is implemented in 7a94e861; the initial image metadata verifier is not yet wired
to install and will be replaced by a layer-specific contract. No uploads occurred.

## Decision and scope

Keep Ubuntu 26.04. Never publish or re-host an Ubuntu cloud disk, customized or
unmodified. Each install fetches the official unmodified base directly from
`cloud-images.ubuntu.com`, checks Canonical's signed SHA256SUMS with the committed
GPG key/fingerprint and matches the base hash in our Ed25519-signed layer metadata.
CI publishes only our offline input layer: unmodified upstream debs with signed
repository verification data, redistributable tool archives, a CA-free Umiak agent,
our files and scripts, license inventory and exact input/package manifests.

Products remain **Umiak Linux** / **Umiak Linux Desktop**, slugs `linux` /
`linux-desktop`; each has its own layer. Windows keeps its local licensed-ISO
path. No Debian recipe revival or catalog migration is in S25. Distro fields
remain explicit in metadata and the transport is reusable, but this release
accepts only the confirmed Ubuntu base/recipe pair.

Default setup action remains “Download the Linux template”, with text explaining
that it downloads the official base plus prepared packages and finishes locally.
“Build locally from recipe” remains advanced and explicit. No silent fallback
when a layer fails. Target local customization is a few minutes, not a measured
promise: kernel/initrd, package scripts, extraction and reboots still take time.
No archive access occurs on the installation customization path.

## Install and rollout lifecycle

1. Existing S22 owner polls signed stable/edge pointers from the configured public
   layer origin, independently of private GitHub recipe discovery. Verify pinned
   publisher signature, monotonic sequence, channel and compatibility.
2. Reserve one idle node and a fresh VMID in the configured template range with
   existing durable build jobs/maintenance fencing. Never touch stand hosts here.
3. Download official base plus Canonical sums/signature directly from the pinned
   upstream release path. Verify GPG and SHA-256 before PVE import. Existing
   `apps/template-builder/src/image.ts` supplies the base-verification authority.
4. Node-agent stages ordered <=512 MiB layer chunks in its root-owned digest
   cache, streams SHA-256, validates complete compressed/archive hashes and
   extracts only safe regular files/directories under its owned staging directory.
5. Existing PVE builder boots the base with the prepared layer attached read-only.
   Cloud-init's normal online package stage is replaced with offline QGA bootstrap
   from captured dependencies; it must not run package_update against the network.
6. Reuse recipe step/GuestIo execution with offline adapters. Only `file:` apt
   repositories and verified local tool inputs are available. Block guest egress
   during customization (QGA is host-mediated). No fallback download on a cache
   miss; report the exact missing pinned input and keep the old active build.
7. Collect exact installed facts, clean/seal/shutdown and verify a disposable
   clone. Clone networking may be enabled for readiness/tunnel tests after the
   offline customization proof, with separate accounting for optional tools.
8. Register/promote through existing services, copy the same build to other nodes
   through S21 `volume.sendTo`, and retire old unreferenced builds after S22's
   existing 24-hour interval. Running sandboxes retain their build. Failed copies
   keep their previous active template and retry from the source; no second layer
   download or independent build on each node.

Extend `recipe-channel.mjs`, `recipe-rollout.mjs`, `setup-build.mjs` and the
existing register/replicate/retire paths; do not create another rollout engine.
Recheck stable/edge and maintenance at promotion, persist layer/base identity in
ordinary build manifests and recover jobs after restart. Windows recipe rollout
continues independently. Changes stay out of `apps/web`; coordinate configuration
ownership with S24's move to `apps/api`. Rebase on main at task boundaries.

## Offline layer closure and apt authenticity

CI resolves inputs against the exact official base and snapshot-pinned recipes,
including bootstrap QGA dependencies, kernel/initrd packages, desktop dependencies
and all apt recommends selected by the recipe. Capture byte-identical debs, original
InRelease or Release+Release.gpg, matching Packages indexes, repository keyrings,
suite/component/architecture and pool paths. Preserve each package's checksum
link from signed Release to Packages to deb; retain Ubuntu and Docker as distinct
repositories/authorities. Do not regenerate upstream indexes and present them
as upstream-signed or use trusted=yes/allow-unauthenticated.

Build an offline mirror with original dists/pool structure and the exact upstream
verification bytes. Point apt sources to `file:///mnt/layer/apt/<repository>`;
retain Signed-By and disable network sources in offline mode. Fixed historic
snapshots may need explicit Check-Valid-Until=false, documented in signed capture
metadata; never disable signature or hash checks. Capture no unnecessary packages
or credentials. Every final package has name/version/architecture, source package,
repository, exact deb SHA-256 and index provenance in the signed inventory.

The closure also includes Docker key/debs, Node/Go/Bun/uv/gh tarballs, Python inputs
if used, every Rust component/rustup artifact, npm package tarballs/native optional
dependencies and registry integrity metadata, Sunshine/moonlight/Cua archives and
Sigstore verification bundles. npm, rustup and helper scripts run in explicit
offline mode or install captured verified payloads; a successful download cache
alone is not a proof of an offline closure. No vendor postinstall may fetch.

The critical CI check is a **fresh replay** from the official base with all guest
network egress disabled, using only the finished layer. Compare exact installed
package/tool manifests against the capture run, then clean/seal and run baseline,
CDP/computer-use and desktop verification. Failure blocks release. Publish only
inputs and our files, never this replay's customized disk. Reject a layer whose
base/recipe digest does not match the replayed pair.

## Layer artifact and signature contract

Use an uncompressed POSIX tar archive, streamed through zstd, split into ordered
content-addressed chunks of at most 512 MiB. The disk-oriented raw+size framing
is **not** used for layer payloads; it remains unchanged in S21 disk copies.
Signed `archiveBytes` and archive SHA-256 bound tar decompression/extraction.
Never pass a downloaded layer archive to pvesm or execute its scripts on the PVE
host; scripts run only in the disposable build guest.

`umiak-linux-layer/v1` binds version/channel/slug/amd64, distro/release, source
commit, recipe digest, Canonical base URL/serial/hash/sums/signature locations,
builder API, half-open platform compatibility range, minimum agent capability,
firmware trust requirement, ordered chunk sizes/hashes, compressed size/hash,
archive size/hash, exact file inventory and package/source/license provenance,
capture/replay results and measurements. An attached content-addressed inventory
is acceptable only with size/hash bound by the signed metadata. All inputs,
including executable scripts, must be inventoried. Strict type/field/size/path
validation and duplicate-field rejection precede extraction or host mutation.

Ed25519 raw detached 64-byte signatures cover exact compact JSON bytes using
existing GH `RECIPE_SIGNING_KEY`. Authority comes from baked
`infra/templates/keys/recipe-publisher.pub` or the existing explicit owner override,
never a downloaded key. The generic agent's initial integrity comes from the
outer signed layer; later agent updates use separate global update authority.

Object layout (stable/edge pointer names stay shared with the original design):

- `blobs/sha256/<hex>`: immutable chunks, layer manifests and attached inventories.
- `releases/<version>/<slug>/manifest.json` and `.sig`: immutable layer metadata.
- `channels/stable.json` / `channels/edge.json` and `.sig`: signed pointers binding
  channel, version, monotonically increasing sequence and both slug manifests.

Upload pointer last after both layers and every dependency object are readable.
Never replace an immutable version with different bytes. Persist accepted
sequence per channel; explicit S22 rollback remains a separate retained-build
operation. Corrupt/stale metadata fails closed and never promotes another channel.

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

## Generic result and cleanup audit

The layer has no installation CA, tunnel/gateway/API URL, subnet, resolver binding,
MAC, SSH user CA or credentials. Final template network is DHCP on `en*`; the
existing global DNS fallback policy remains. Boot firmware supplies tunnel URL,
CA pin and identity; claim supplies SSH trust/config. Global agent/tool versions
and hashes are intentional immutable release identity, not per-install state.

Keep cloud-init clean --logs --seed and disable cloud-init after customization;
remove seed disks/build SMBIOS, generated network configuration, DHCP leases,
authorized keys, all SSH host keys, machine-id/dbus copy, agent state, Docker
machine identity, desktop pairing/certs, random seeds, histories/caches and logs.
Rebuild initrd after identity seal. Inspect final cold disk and two independent
clone identities. Avoid the current zero-fill peak allocation of most of 64 GiB;
use discard/sparse cleanup where supported without making sealing optional.
Keep existing local templates and signed agent-package verification working.

## Browser and optional proprietary tools

Do not distribute Chrome or Claude Code payloads in a layer. Proprietary or
unresolved tools use optional first-boot vendor installation, exact version plus
vendor checksum where published, bounded retries and visible status. Missing
network is nonfatal to sandbox/agent/desktop readiness. No automatic login or
license acceptance. This optional phase occurs after offline customization and
is tested/accounted separately, so it cannot hide archive access during replay.

Chromium must run without snap and preserve CDP/computer-use. Evaluate a pinned
upstream Chromium build first, keeping its exact revision, SHA-256, license and
third-party credits/source material. Chromium's [binary redistribution license](https://chromium.googlesource.com/chromium/src/+/HEAD/LICENSE)
permits redistribution subject to notices/no endorsement; this is not a blanket
license for every binary dependency or codec. [Upstream downloadable snapshots](https://www.chromium.org/getting-involved/download-chromium/)
are best-effort arbitrary revisions, not guaranteed stable releases. Do not
silently label a snapshot “stable”. A native xtradeb/debian deb is an alternative
only after exact packaging, repository signatures, licenses and Ubuntu dependency
compatibility are verified. If neither offers a clean pinned redistributable
choice, ask master; never silently re-enable snap or substitute proprietary Chrome.

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
| Google Chrome `.deb` | Exclude from images; replace with a verified snap-free Chromium distribution. Proprietary product; [Chrome terms](https://www.google.com/chrome/terms/) incorporate Google's general terms. Do not infer redistribution rights from downloadable debs. Verify exact package EULA/permission; do not bundle pending any future permission |
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

## Hosting, access and upload gate

R2 bucket `umiak-images` already exists on account
`ccd46cd070d0adbdacd7defca520f867`. Public base defaults to
`https://pub-bdc85570347b44df991bfcee2718c4a1.r2.dev`; make it configurable with
`UMIAK_IMAGE_BASE_URL` and a host-side origin allowlist. Anonymous HTTPS only,
no install tokens/presigned URLs. Restrict redirects to the configured origin;
Canonical base downloads have a separate fixed official allowlist and GPG trust.
A future custom-domain or GitHub public mirror changes origin configuration and
object paths only, with the same signatures/digests. Never mirror the base disk.

[R2 public r2.dev](https://developers.cloudflare.com/r2/buckets/public-buckets/)
is development-only/rate-limited; retain verified chunks across bounded retries
and honor Retry-After. No production throughput guarantee. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
currently has no egress fees, Standard storage $0.015/GB-month and 10 GB-month
free. [Limits](https://developers.cloudflare.com/r2/platform/limits/) permit
5 TiB objects / 5 GiB single upload, so 512 MiB chunks fit.

CI uploads use S3 endpoint
`https://ccd46cd070d0adbdacd7defca520f867.r2.cloudflarestorage.com`, region auto.
Request bucket-only **Object Read & Write** credentials (PUT, GET/HEAD readback,
list allowed by preset), no bucket/admin rights. Proposed GH secrets:
`R2_IMAGES_ACCESS_KEY_ID`, `R2_IMAGES_SECRET_ACCESS_KEY`; reuse `RECIPE_SIGNING_KEY`.
Request only when uploader is ready. Secret values live only in restricted files,
never env/argv/logs/git. No cloud resources created by this task.

Uploader stays behind explicit publish=false default and protected manual approval;
no uploads are authorized during implementation. CI is workflow_dispatch only.
Never upload an Ubuntu disk, even when publish is approved. Sign only after
inventory/legal policy and network-disabled replay pass.

For comparison: [GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
supports OCI and public anonymous pulls, but documents 10 GB/layer and a ten-minute
upload timeout, without a numeric anonymous pull quota guarantee. [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
need repository access and files under 2 GiB; the private repo cannot serve these
anonymous installs. R2 remains selected, with a configuration-only public mirror
possible later. No mirror is provisioned now.

## CI runner and measurements

Direct QEMU/KVM adapter reuses recipe/seed/GuestIo execution and fact/verify logic.
Probe KVM by actually starting a VM plus RAM/free disk before capture. Sequential
headless/desktop jobs limit peak disk. [Nested virtualization is experimentally
possible but unsupported](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).
Standard private Linux runners advertise 2 CPU/8 GB RAM/14 GB disk; if the probe
fails, report larger-runner or paid ephemeral-builder options to master. Never
silently use TCG, a paid resource or Ilia's Proxmox. No live PVE/CT590 access.
Keep snapshot apt and all tool pins; bounded connect/read/step retries fail CI
rather than switching to unpinned archives. Separate signer from guest execution.

Actual layer size, fresh offline customization time and import time are not yet
measured. Historical 7.4 GB allocated / 64 GiB logical and S21 copy 44–76 seconds
on 1 GbE describe the resulting Linux disk, **not layer download size**. Raw-disk
compression estimates from the superseded design must not be reused as layer
benchmarks. Download time = compressed layer bytes * 8 / link bit rate, plus
separate official base transfer, local package/reboot/seal/verify work and S21 copy.
Measure per slug: layer/base bytes, chunk count, capture/closed-network replay time,
peak RAM/disk, input/package completeness, apt signature evidence, PVE customization
and clone-ready time, archive network attempts (must be zero), and replica receipts.
Master performs live acceptance; this thread uses fixtures only until authorized.

Run Biome/Vitest for changed TS, Go tests/golangci-lint for changed Go and
`mise exec -- node --test deploy/compose/quickstart/` from root after workspace
install/dependency builds. Trust-stage evidence: 244 quickstart, 81 PVE, 45 worker,
10 API tests and scoped Go/lint checks passed. No upload or live image test ran.

### Stable native Chromium capture

The generic layer uses xtradeb's native **resolute/amd64** Chromium packages,
not the Ubuntu snap transition package. The committed layer input pins record
Chromium, chromium-common and chromium-sandbox versions and SHA-256 values, plus
the PPA authority `5301FA4FD93244FBC6F6149982BB6851C64F6880`. Capture retains the
PPA's original InRelease/Packages and the unchanged debs. Replay uses those local
indexes and the exact same key. Repository preferences allow this PPA to supply
only those three packages; install them before any apt transaction during replay.
Chromium's native policy directory and desktop association replace Chrome's;
legacy CDP executable aliases resolve to Chromium.

The checked package revision is `156.0.8078.73-1xtradeb1.2604.1` (source publication
18904289). Its three debs total **129,291,674 bytes**, according to the original
Packages index; this is an input measurement, not a measured layer size. Its
copyright/third-party notices must be captured from the actual debs and included
in the signed inventory. Chromium is not treated as a single BSD-only payload.
The PPA publishes [native Ubuntu packages](https://xtradeb.net/apps/chromium/)
and its [signed resolute archive](https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/dists/resolute/InRelease)
provides the package authentication chain. Exact upstream source revision and
notice hashes accompany the chosen binary revision.

No update-cadence SLA was found. The .73 package appeared on October 28, about
21 hours after that Linux stable release; the PPA was still on .73 when inspected
on November 6, while Chromium's [official stable release feed](https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=5)
listed subsequent .79 and 157 releases. A successful native dependency/CDP replay
is required before this candidate can be released. The manual publication review
also checks the current stable security baseline and refreshes pins as needed;
we do not silently switch to snapshots, snap, or an unreviewed third source.
Debian trixie remains the approved fallback only if native xtradeb replay fails.
