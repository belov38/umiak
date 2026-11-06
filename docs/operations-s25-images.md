# Operating signed Linux input layers

S25 distributes unmodified Ubuntu packages and offline inputs, not a customized
Ubuntu disk. Installs fetch the official Canonical cloud image directly, verify
Canonical's GPG-signed SHA256SUMS and the hash pinned by our signed metadata, then
customize locally. Windows retains its licensed ISO build.

## First workflow registration and public packages

The workflow is `.github/workflows/linux-layers.yml`, named `linux-layers`.
It has **workflow_dispatch only**, `contents: read` and `packages: write`.
GHCR authentication uses only the repository's built-in GITHUB_TOKEN, held in a
0600 file. Signing uses the existing RECIPE_SIGNING_KEY, matching
`infra/templates/keys/recipe-publisher.pub`; it is materialized only after replay
and license/source policy checks. Neither credential is put in environment
variables, command arguments or logs. No new secrets or cloud resources.

A new manual workflow must first exist on the default branch. The owner can put
only this workflow file on main, then dispatch the implementation branch. See
[GitHub's manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
`approved_sha` must equal the full reviewed implementation head, preventing a
moving branch from publishing unreviewed changes. Stable publication also requires
main; reviewed edge builds can run on the feature branch.

First dispatch, with these input names:

```text
action=initialize-packages
version=20261106.1-edge.20261106.1
channel=edge
agent_version=0.4.0-edge.20261106.1
publish=true
approved_sha=<full reviewed S25 head SHA>
```

This pushes tiny Umiak-authored visibility placeholders, with no Ubuntu or vendor
payloads, to four packages:

- `ghcr.io/belov38/umiak-linux-layer`
- `ghcr.io/belov38/umiak-linux-desktop-layer`
- `ghcr.io/belov38/umiak-linux-layer-sources`
- `ghcr.io/belov38/umiak-linux-desktop-layer-sources`

Ilia must set each package to **Public** once in GitHub's package settings UI.
The workflow prints settings links. Existing release.yml associates packages with
the repository but does not make them public. Anonymous readback fails clearly
if visibility is still private. The companion requirement increases the initial
two layer packages to four packages.

Then dispatch the same reviewed ref with:

```text
action=build
version=20261106.1-edge.20261106.1
channel=edge
agent_version=0.4.0-edge.20261106.1
publish=true
approved_sha=<the same full reviewed head SHA>
```

The version is immutable. A failed partial publication requires a new version;
existing tags are never overwritten. `publish=false` builds, checks and signs
without registry writes. The built-in token still authenticates read-only public
GitHub source metadata to avoid anonymous API throttling. Both modes use the
same explicit gate; there are no push or pull_request triggers.

## CI proof, sources and measurements

The standard Ubuntu runner must pass an actual KVM startup/QMP probe, at least
6 GiB RAM and 24 GiB free disk. Source collection requires additional free disk
and checks it before downloads. A failed probe reports the limitation. The next
choices are a larger GitHub runner or an approved paid ephemeral builder; never
a silent TCG fallback or Ilia's Proxmox hosts. No runner is provisioned here.

For each product, sequentially:

1. Capture the snapshot-pinned recipe inputs in an isolated QEMU VM, with bounded
   archive retries. Export exact original debs, signed InRelease/Packages and
   notices; independently verify their key/index/deb chains on the runner.
2. Collect source-index-verified dsc/orig/debian files for Ubuntu/xtradeb binary
   inputs, from the same captured signed Release and snapshot. Include Sunshine
   and moonlight-web's pinned source archives and exact gitlink source archives.
   Record every binary hash to source-package/archive mapping. Preserve the
   Sunshine/moonlight root archives unchanged. For libvirtualhid, derive only the
   MIT Linux target's sources/headers/configuration inputs from CMake's File API,
   the exported API header tree and actual compiler dependency files inside the
   isolated capture VM; retain
   the MIT notice and upstream path/license map. Reconstruct and recompile the
   subset before accepting it. Any SAL build input stops publication. Original
   commit/archive hash, excluded SAL paths and complete derivation evidence are
   in the signed inventory and source manifest; the full mixed-license
   libvirtualhid archive and Windows-only NVAPI/ViGEm gitlinks are not published.
3. Build a source OCI layout locally. Original source files split at fixed
   512 MiB boundaries; identical files retain identical blobs across versions.
   Local layouts hard-link the shared verified source cache. ORAS copy skips
   digests already in the destination repository, preserving the OCI digest.
4. Put that source artifact's immutable OCI digest in the layer metadata and
   license inventory. The source artifact's metadata/chunks are authenticated
   transitively by this Ed25519-signed reference. No extra signing authority.
5. Prove replay on a fresh verified official base with **no NIC**, checking exact
   package/tool/kernel parity, native Chromium CDP and sealing/identity cleanup.
   CI never runs the vendor phase or transfers the installed platform CLI.
6. Pack only the input tree as tar+zstd chunks at most 512 MiB, sign exact compact
   metadata, and prepare one stable/edge pointer binding both product manifests.

Docker's Apache-licensed debs retain distribution copyright/license/NOTICE files.
Their inventory includes best-effort release references and dated, commit-pinned
**packaging recipe snapshots**, explicitly not attested build checkouts. Docker
sources are excluded from the copyleft companion. A detected copyleft notice in
a Docker package stops publication for inspection of whether it is bundled.
There is no gate on Docker packaging checkout attestation.

With publish=true, both source companions upload and pass anonymous byte/digest
readback, then both layers upload and pass readback. **Only after all four pass**
do either layer's stable/edge tags advance. The source tag is immutable; installs
never download a source companion. Keep source companions available while their
layers are distributed; local template retirement never deletes published sources. Unknown licenses, missing notices/sources,
vendor payloads, altered inputs or incomplete offline replay prevent signing or
promotion. The official base disk is never uploaded.

The Actions summary and retained control artifact contain measured base/layer/
source sizes, source capture and offline replay times, plus upload/readback times.
Download estimates at 20/100 Mbit/s include only the base and layer, exclude retry
cost and are estimates. PVE replay/import, platform CLI transfer, online vendor
installation and S21 timings must come from the live stand run. The known pinned
Chromium source entry is about 782 MiB plus dsc; full companion size remains
unmeasured until the first CI run. Unchanged Chromium source blobs are reused.

## Install and safe retry

Update the control plane and node-agent together before the live test. Node-agent
must understand layer.prepare/stage/base/release and its root-owned template VMID
range must agree with Setup. The default media storage is local; a custom storage
requires matching `layerMediaStorage` in `/etc/umiak-node.toml`. Setup never rewrites
host permissions or node-agent resource guards during adoption.

Setup's default **Download the Linux template** authenticates a stable/edge
control envelope, reserves a fresh template VMID and stages verified chunks on
one node. That node imports the official base and locally creates a read-only
input disk. The guest NIC stays down through offline replay/parity checks.

After parity, the builder transfers the installed platform release's guest
`umiak` CLI through bounded QGA binary writes, verifies its hash and records its
exact version/SHA in `platformTools`, outside the signed layer. A missing asset
is a build error. This local release asset needs no network.

Then a separate online vendor phase installs pinned Claude Code, Bun and OpenCode.
These payloads are never captured or published in the layer. Each records its
version/hash/source and duration; vendor failure completes the template without
that tool and displays `<tool> not installed: <reason>`. The builder restores
NIC isolation, cleans state/logs, seals and verifies clones before registration.
Inability to restore isolation prevents sealing. Sandbox readiness does not
require a vendor tool, and sandboxes perform no per-VM installer downloads.

**Install Claude Code (rebuilds the template)** has the hint: “The rebuild reuses
the downloaded layer, takes a few minutes, and existing sandboxes are not affected.”
Bun/OpenCode warnings use their own tool names. Retry re-authenticates the cached
original layer, builds a new VM, registers/S21-copies/promotes normally and leaves
existing sandboxes on their old build. Never mutate an active template; ordinary
reference-aware retirement removes the old build when it is unused.

Other nodes receive the finished template through existing S21 volume.sendTo;
they never download/customize it again. The local recipe path remains an advanced
option, including legacy baked-CA support. Generic templates use the per-boot
SMBIOS CA pin. The API/setup validate the full descriptor and the standard tunnel
hostname limit is 143 ASCII bytes; never truncate the pin.

## Registry configuration and first-release boundary

Control downloads support `UMIAK_LAYER_REGISTRY` (default https://ghcr.io),
`UMIAK_LAYER_LINUX_REPOSITORY` and `UMIAK_LAYER_LINUX_DESKTOP_REPOSITORY`.
Node-agent has matching `layerRegistryURL` and `layerRepositories` root-owned
settings. Anonymous pull tokens are in-memory and pull-only. Redirects allow the
registry itself and only GHCR's exact `pkg-containers.githubusercontent.com` HTTPS
blob host; credentials are stripped and hashes remain mandatory. No S3 path.

Automatic S22 discovery of newly published layers follows the first live
acceptance. During this first testable release, setup respects stable/edge and
uses normal promotion/retirement; legacy recipe rollout skips active generic
Linux templates. No workflow or live stand test was run by the implementing
agent. Master runs the workflow, merges and releases edge for stand acceptance.
