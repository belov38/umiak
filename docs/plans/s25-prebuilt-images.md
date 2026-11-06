# S25 Official Base and Signed Offline Layers Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task in this scoped thread. No further delegation is authorized.

**Goal:** Prepare Ubuntu Linux templates locally without archive access using a
Canonical-authenticated official base and our signed offline input layer.

**Architecture:** Manual QEMU/KVM CI captures exact recipe inputs and proves fresh
network-disabled replay. Installs download the official base directly and our
chunked tar+zstd layer from GHCR, replay through the existing PVE builder, then use
existing registration, S21 copy and S22 promotion/retirement.

**Tech stack:** Existing TS/Node, Go, QEMU/QGA/QMP, apt/GPG, zstd, Ed25519 and OCI/ORAS.
**Spec:** `docs/specs/s25-prebuilt-images.md` (latest two-layer decision is binding).

## Global constraints

- Keep Ubuntu 26.04; no Debian revival, no modified-disk distribution, no base rehosting.
- Branch s25-prebuilt-images, push commits but do not merge. Rebase main regularly.
- Do not touch apps/web or live PVE/CT590; coordinate API ownership with S24.
- All workflows workflow_dispatch only. publish=false by default. No uploads now.
- GHCR public OCI repositories umiak-linux-layer / umiak-linux-desktop-layer,
  configurable registry/repositories. Anonymous pull tokens only; no install credentials.
- Key/CI credentials only in files, never env/argv/log/git. Existing recipe key only.
- No compound rm shell commands; mktemp -d per step. English code comments.
- Proprietary/unresolved inputs excluded. Chromium without snap; ask master if no
  clean redistributable pinned binary/package works. Node-side optional vendor tools run once after offline parity, before sealing;
  their failure is tolerated. Retry builds a new template from re-verified cached inputs.
- Keep Windows local ISO behavior, old Linux baked trust and advanced recipe build.

## Review focus

1. Incomplete closure or vendor postinstall: fresh offline replay fails explicitly,
   never secretly accesses apt/npm/Rust/vendor servers (Tasks 3/7).
2. Wrong/tampered base or layer: Canonical GPG plus pinned base hash, publisher
   signature and bounded full chunk/archive verification before use (Tasks 1/4/5).
3. Unsafe archive: no symlinks, special files, traversal, overwrite or unbounded
   decompression; layer scripts execute in guest only (Task 4).
4. Channel/maintenance switch or crash mid-customization: no stale promotion or
   foreign-VM cleanup; recover reservation and preserve old active build (Tasks 5/6).
5. Wrong/malformed CA pin: no system/baked trust downgrade, no bootstrap bytes
   before full x509 validation (Task 2, implemented; retain regression coverage).

## Task 1: Evolve metadata and chunk transport for input layers

**Files:** infra/templates/image-manifest.mjs and tests; add
infra/templates/layer-pack.mjs and tests; signed fixture files under testdata.

**Interfaces:** Keep verifyImageManifest/verifyImagePointer entry points, switch
artifact discriminator to umiak-linux-layer/v1. Replace disks/hardware with
base, archive, chunks and signed inventory linkage. Existing raw-disk verifier
0fbd4c1c is not wired; reject its old format on the new installation path.
`packLayer({archivePath, outputDir})` returns ordered chunk sizes/digests,
compressed size/hash and tar size/hash. S21 raw+size framing stays unchanged.

- [ ] Add RED tests for layer schema, channel/compatibility/replay, base URL fixed
  to official Ubuntu release, duplicate fields, malicious sizes/paths and hashes.
- [ ] Implement bounded strict schema and compact exact signed bytes; preserve
  tested pinned-key and safe-origin behavior. No downloaded trust keys.
- [ ] Add RED local tar+zstd round-trip tests with forced tiny chunk size,
  corruption, cancellation, collision and invalid source/limits.
- [ ] Implement streaming compression/chunking with bounded memory and durable
  content-addressed files; no disk-image export or pvesm operation here.
- [ ] Run node tests/Biome; commit feat(layers): authenticate chunked offline inputs.

## Task 2: Firmware CA pin and compatibility

**Files:** Modify `packages/pve/src/machine.ts` and its tests;
`services/guest-agent/internal/ident/{source,source_linux,identity,smbios}.go`,
agent tunnel code and tests; `libs/tunnel/wstransport` dialer/config tests;
gateway certificate source under `services/gateway/internal/devsecrets/`;
provisioning callers discovered by `s2SerialPayload` / `formatSmbios1` searches.
Port runtime changes into S24's current owning module after rebase.

**Interfaces:** Optional `Smbios.sku`, `Identity.TunnelCAPin`, descriptor
`umiakca1:<SHA256 DER hex>`. Production dialer accepts explicit pinned-CA verifier
without changing the semantics of ordinary `RootCAs` callers.

- [ ] Implement approved configuration-time descriptor validation in setup network
  and API: standard hostname maximum 143 ASCII bytes, exact serialization for
  nonstandard ports/paths, clear max-N error before creating a VM. Keep generic
  first-install trust under the outer signed image, later update trust distinct.
- [ ] Write failing tests for two installation CAs, unrelated valid certificate,
  wrong hostname/expiry/constraints, missing CA in chain, malformed/unknown pin,
  absent-pin legacy bundle, and total 512-character descriptor boundary.
- [ ] Implement exact root fingerprint match plus full x509 verification, gateway
  CA chain presentation, Linux SKU read and provisioning on every boot path.
  Present invalid pin must fail before any BS/MT traffic. Preserve Windows parsing.
- [ ] Test create/warm-pool/fork/resume/snapshot paths, credential redaction,
  legacy agent updates and new firmware trust surviving agent update.
- [ ] Run focused Vitest, Go tests and golangci-lint in all changed Go modules.
- [ ] Commit `feat(agent): pin install tunnel CA from boot firmware`.

## Task 3: Generic offline capture/replay and QEMU adapter

**Files:** apps/template-builder/src/qemu.ts, qemu-build.ts, offline-layer.ts and
Vitest tests; seed.ts, runner.ts, seal.ts, main.ts; infra/templates/linux lib,
seed, steps, verify; desktop inherited steps/files as needed.

**Interfaces:** QEMU GuestIo implementation (QGA local Unix socket, QMP lifecycle),
`captureLayer({slug, version, outputDir})` and
`replayLayer({base, layerDirectory, guest, recipe}) -> facts`. Neither publishes.
PVE builder consumes the same replay helper. Generic seed excludes install CA,
URLs/SSH trust. Agent bootstrap installs production binary/units/global update
keys directly under outer signature trust; never relax signed update verification.

- [ ] Add RED tests for KVM/RAM/disk probe, QGA/reboot timeout, failure/cancellation,
  production-agent/no-install-trust seed, and legacy build unchanged.
- [ ] Implement direct QEMU/KVM lifecycle and existing recipe/GuestIo execution;
  actual KVM start probe, no TCG or paid/PVE fallback. Record peak resources.
- [ ] Add RED capture tests for bootstrap QGA dependency closure, original signed
  apt Release/Packages/deb chain, Docker authority and missing/transitive input.
- [ ] Capture original apt mirror layout/keyrings plus all exact debs and source/
  license metadata. Record precise non-deb inputs, hashes and upstream URLs,
  npm native/cache closure, Rust components, toolchains and Sigstore bundles.
- [ ] Add RED offline tests: apt signature failure, network source rejected,
  npm/Rust missing payload, vendor postinstall egress, wrong base/recipe pair.
- [ ] Implement file-only apt sources with upstream signature/hash verification,
  snapshot validity policy, local tool resolvers and explicit offline modes.
  Disable cloud-init online package_update; supply QGA bootstrap offline.
- [ ] Implement generic cleanup/seal, leases/identity/SSH/dbus/log/random/desktop
  state checks and sparse/trim behavior. No seed/trust/install identity remains.
- [ ] Replace Chrome with pinned clean Chromium distribution and keep CDP/desktop
  policies/discovery verified; no snap. Optional node-side proprietary tools
  have pinned official installers and nonfatal offline status, never bundled payloads.
- [ ] Replay from fresh official base with guest network egress disabled. Compare
  final exact packages/tools to capture, cold-scan and verify two identities/CAs.
  Local Mac lacks KVM: unit fixtures can pass here, actual runner replay remains
  an explicitly unmeasured CI acceptance gate until master authorizes a run.
- [ ] Run Vitest, shell checks and relevant agent tests; commit builder changes
  in reviewable capture/adapter/replay/cleanup units.

## Task 4: Node-agent guarded layer staging

**Files:** services/node-agent/internal/ops/layer_manifest.go, layer_download.go,
layer_extract.go and tests; dispatch/config; packages/pve node-client and tests.

**Interfaces:** `layer.prepare` validates bounded signed metadata and reports
missing digest keys; `layer.stage` downloads only from configured origin and
returns an owned immutable media reference, metadata digest and staging receipt.
Receipts bind job/VMID/layer digest. No arbitrary path/URL/command/executable.
No layer-to-pvesm raw disk import. Existing PVE base import remains in builder.

- [ ] Add RED cross-language signed metadata fixtures matching Task 1, including
  signature/channel/base/inventory/size policy failures before host mutation.
- [ ] Add RED HTTP/cache tests: drop/429/timeout/truncate/hash mismatch, redirects,
  symlink cache, disk quota, restart rehash, cancellation and corrupt completed file.
- [ ] Implement streaming SHA-256, <=512 MiB chunk retries (max five), bounded
  backoff/Retry-After, fsync/atomic cache and reuse after restart.
- [ ] Add RED archive fixtures: traversal/absolute/duplicate path, symlink/hardlink,
  devices, oversized member/count/total, malformed zstd, hash mismatch and staging
  ownership collision. No script can execute on node host.
- [ ] Implement extraction into owned restricted staging, verifying compressed,
  archive and every file digest. Only regular files/directories; immutable final
  receipt only after complete success. Stage attachable read-only media using
  existing media/storage guards, with bounded free-space budget and durable job.
- [ ] Recover/reuse completed staging only with matching identity; remove only
  proven owned partials. Keep verified chunks for retry.
- [ ] Run Go tests/race/golangci-lint, node-client Vitest; commit guarded staging.

## Task 5: Setup offline template default and existing PVE builder

**Files:** quickstart setup-images.mjs/tests, setup-build.mjs, setup.mjs,
setup-ui.mjs/tests; template-builder build/stages/seed/manifest/registry and tests.

**Interfaces:** `runLayerBuild(invocation, hooks) -> ready Manifest` under existing
TemplateBuildJobs. Input includes verified layer/base identity. Uses Task 3 replay
and Task 4 staged media. Existing reserve/register/finish/replicate hooks remain.

- [ ] Add RED tests for default download action/explanatory text, advanced recipe
  choice, Windows unchanged and no silent fallback on missing layer/network.
- [ ] Verify official base with current Canonical GPG/hashed sums plus layer pin;
  download only from cloud-images.ubuntu.com. Test substituted sums/key/base,
  mismatched metadata, cache corruption, cancellation and bounded retries.
- [ ] Boot base+layer read-only through existing PVE path; deny guest egress for
  customization, retain QGA access, reuse steps and verification. Test zero
  archive requests, missing offline input, final facts mismatch and failed clone.
- [ ] Keep durable template reservation/recovery and record layer/base identity.
  Register/promote only verified result, then existing S21 replicate once. Failed
  replica leaves prior active build; no per-target upstream download/build.
- [ ] Build workspace deps/CLI, run root quickstart suite and relevant Vitest;
  commit feat(setup): prepare Linux templates from signed offline layers.

## Task 6: S22 channel rollout of offline layers

**Files:** recipe-channel.mjs, recipe-rollout.mjs and tests;
docs/specs/s22-template-channel.md.

**Interfaces:** Existing owner/settings/lifecycle receives verified layer release
for Linux and recipe bundles for Windows, using the shared stable/edge selector.

- [ ] Add RED tests for anonymous layer discovery without private GitHub auth,
  invalid signature/base/compatibility, pointer sequence, mid-build channel switch,
  maintenance, restart, S21 copy failure, rollback and reference-aware retirement.
- [ ] Implement layer checking independently of Windows recipe fetch failures;
  serial idle-node replay through normal jobs, promotion fence/channel recheck,
  durable identity/history and no running sandbox interruption.
- [ ] Run root quickstart suite; commit feat(channel): roll out offline Linux layers.

## Task 7: Manual gated CI publisher and acceptance

**Files:** .github/workflows/linux-layers.yml, infra/templates/release-layers.mjs,
license inventory helper/tests, docs/operations-s25-images.md, builder README.

**Interfaces:** Publisher accepts only verified input-layer artifacts/inventories,
file signing/registry credentials, capture+closed-network replay evidence and explicit
publish gate. It must never accept a disk image or rehost Canonical base bytes.

- [ ] Add RED tests for non-main publish/version conflict, absent/mismatched keys,
  unresolved/proprietary payload, omitted source/licenses, incomplete replay,
  disk/base artifact inclusion and failed readback/pointer partial publication.
- [ ] Implement exact signed input/package/license inventory, including GPLv3
  texts/source offer/links and upstream input provenance. No unresolved payloads.
- [ ] Implement gated upload, protected manual approval, immutable write/readback,
  channel pointer last and cleanup of file-only secrets on every failure.
- [ ] Use built-in GITHUB_TOKEN packages:write, file-only token/recipe key. ORAS
  stdin authentication; no new secrets. Document one-time Public visibility and
  require anonymous readback. No uploads during local fixture work.
- [ ] Workflow workflow_dispatch only, publish default false, KVM/free-space probes,
  exact committed pins, bounded retry/timeouts and sequential slug jobs.
- [ ] Run Biome/Vitest, Go/race/golangci-lint and root quickstart tests. Inspect
  final diff against spec and no-web/no-host/no-upload constraints.
- [ ] Report measured layer/base sizes and network-disabled replay duration only
  after authorized CI run. Master performs PVE offline replay/clone/S21 acceptance.
  Distinguish unmeasured size/time targets from evidence; push branch, no merge.

## Progress at pivot

- 0fbd4c1c: initial disk metadata verifier, 11 tests/Biome green; replace schema
  in Task 1, do not expose a disk publishing path.
- 7a94e861: CA pin path, gateway chain, 143-byte early validation and provisioning
  refresh implemented. PVE 81, API 10, worker 45 and quickstart 244 tests pass;
  scoped Go tests/golangci-lint and worker/PVE typechecks pass.
- Workspace install/dependency/CLI builds now succeed. Tests run from repo root.
- No cloud resource changes, uploads, image builds or live host operations.
- Raw-disk packing test was uncommitted at pivot; replace with layer-tar packing
  tests rather than building the superseded disk export feature.

## Latest implementation ordering

Finish Tasks 5 and 7 first (PVE/setup + manual GHCR publisher), including once-per-template
vendor installation, nonfatal warning and safe rebuild retry. Task 6 S22 autonomous
new-layer rollout follows first live acceptance and is explicitly pending then.

## Approved source/CLI extension for the first testable release

- Required source companion per product, referenced by OCI digest from layer
  metadata/inventory; independently verified Sources chains for Ubuntu/xtradeb,
  pinned upstream/gitlink sources for GPL Sunshine/moonlight.
- Docker is Apache: retain copyright/license/NOTICE, best-effort tags and dated
  packaging recipe snapshots. No Docker source/attestation gate unless actual
  bundled copyleft is found.
- Stable per-source-file chunks reuse unchanged blobs; one gated run uploads and
  verifies all four artifacts before advancing any channel. First long CI is OK.
- Required installed-platform guest CLI transfers via QGA after offline parity,
  with exact hash/version record; missing asset is fatal, no network. Bun/Claude/
  OpenCode remain separate tolerant online vendor tools, absent from CI layer.
- Master bootstraps only linux-layers.yml onto main, initializes four packages
  against our reviewed SHA, Ilia sets Public once, then master runs the full build.
  Report head, exact workflow path and inputs; implementation never triggers CI.


### libvirtualhid Linux source subset (approved exception)

Sunshine's pinned Linux CMake target links libvirtualhid. Its repository also contains Windows SAL sources that we do not redistribute. CI preserves the Sunshine and moonlight root source archives byte-for-byte, excludes the Windows-only NVAPI/ViGEm gitlinks, and derives a libvirtualhid MIT subset inside the isolated Linux capture guest after the layer export/facts are frozen. The audit configures the actual upstream library subproject as Sunshine does, builds its Linux target, reads CMake File API target/configuration inputs, the exported API header tree and GCC dependency files, and checks every selected path against the pinned upstream license map. No handwritten source allowlist is used. Any SAL input stops publication.

The subset retains original selected file bytes, the MIT license, repository license summary and path-to-license map. CI reconstructs the subset in a fresh directory and compiles it again, requiring the same source/header/configuration closure and hashes. The signed inventory and digest-bound source companion record the original commit/archive SHA-256, derived archive SHA-256, excluded SAL paths, exact audit script, CMake wrapper/options, compiler versions and reconstruction result. Full mixed-license libvirtualhid archives remain private CI scratch data and are not OCI source files. Audit-only dev packages are installed after export and never enter the layer.

Local acceptance pivot: keep local NoCloud mode, fixed capture0/MAC, pre-apt network
guard and lease proof. Provide bootstrap + clean-checkout local build using the
existing KVM coordinator, immutable staging-only push with file-held operator token,
and no-KVM CI fetch/verify/sign/readback/edge promotion. Verification provenance is
local-staged + approved SHA; no claim of CI VM replay. Full CI build remains intact.
