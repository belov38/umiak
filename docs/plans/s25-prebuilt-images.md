# S25 Prebuilt Linux Images Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Do the work in this scoped thread; no further delegation is authorized.

**Goal:** Download, authenticate, import and autonomously roll out generic Linux
images while preserving local recipe builds and Windows behavior.

**Architecture:** Manual QEMU/KVM CI emits zstd-compressed raw+size disk streams
and Ed25519-signed metadata to public-read R2. Quickstart extends the existing
S22 lifecycle and delegates bounded streaming downloads/import to node-agent;
S21 replicates the imported build. Boot firmware pins each install's tunnel CA.

**Tech stack:** Existing TypeScript/Node, Go, QEMU/QGA/QMP, zstd, PVE pvesm,
Ed25519 and S3-compatible R2. Reuse current dependencies first; check latest stable
versions before adding any dependency, and pin it. All commands use `mise exec --`.

**Spec:** `docs/specs/s25-prebuilt-images.md` (read in full before implementation).

## Global constraints

- Branch `s25-prebuilt-images`; push, do not merge. Rebase on main at task boundaries.
- No `apps/web` changes. Coordinate provisioning ownership with S24 / `apps/api`.
- No Proxmox/live stand access, no self-hosted runner setup, no cloud resource creation.
- Every CI workflow is `workflow_dispatch` only.
- Names: Umiak Linux / Umiak Linux Desktop. Slugs: linux / linux-desktop.
- Distro remains unconfirmed. No image publication before master's distro decision,
  license clearance and explicit publish go-ahead; R2 is already publicly readable.
- R2 account `ccd46cd070d0adbdacd7defca520f867`, bucket `umiak-images`; configurable
  public base defaults to `https://pub-bdc85570347b44df991bfcee2718c4a1.r2.dev`.
- No install storage credentials. CI credentials and signing key only as files;
  never env vars, argv, logs or git. Signing key remains in existing GH secret.
- Code comments in English; no session trailers/links in commits or PRs.
- No `rm` in compound shell commands; use a plain single `rm`, `mktemp -d` per step.
- Keep Windows local licensed-ISO builds and legacy Linux baked trust working.

## Review focus

1. Valid signature but malicious sizes/URLs: bounded parsing, explicit origin and
   no host mutation until policy checks pass (Tasks 1/4).
2. Present invalid pin or wrong CA: no legacy/system trust downgrade, no bootstrap
   bytes before full certificate validation (Task 2).
3. Crash after import but before registration: UUID-bound recovery cannot publish
   partial data or delete another job's volume (Tasks 4/5).
4. Stable/edge switch during download: stale selection cannot promote; old builds
   and running sandboxes remain usable (Task 6).
5. Rate-limited R2 / full cache / interrupted connection: bounded retry, reuse
   verified chunks, explicit failure with old active build retained (Tasks 4/6).

## Task 1: Shared artifact contract and fixtures

**Files:** Create `infra/templates/image-manifest.mjs`,
`infra/templates/image-manifest.test.mjs`, and small signed fixtures under
`infra/templates/testdata/images/`; create Go fixture tests in
`services/node-agent/internal/ops/image_manifest_test.go`.

**Interfaces:** `verifyImageManifest({bytes, signature, keys, platform, channel,
slug}) -> ImageManifest`; `verifyImagePointer({bytes, signature, keys, channel,
minimumSequence}) -> ImagePointer`. Schemas and limits are identical in Go and JS.
No fetches or host operations in these functions. Export raw+size framing/digest
fixtures compatible with S21, including its eight-byte little-endian size header.

- [ ] Write failing fixtures for valid metadata, tampered signature/chunks/order,
  unknown key, wrong channel/slug, incompatible platform, replay sequence,
  path traversal, unsafe integers, duplicate/unknown fields and oversized input.
- [ ] Run `mise exec -- node --test infra/templates/image-manifest.test.mjs` and
  focused Go tests to demonstrate missing implementation failures.
- [ ] Implement strict verifier, detached signatures and bounded schema. Persist
  sequence separately per channel; signed metadata contains no absolute URLs.
- [ ] Verify identical Go/JS fixture outcomes and framing hash against S21 tests.
- [ ] Commit `feat(images): define signed Linux image artifacts`.

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

- [ ] Ask master to resolve serialized SMBIOS size behavior and generic initial
  agent-install trust boundary from the spec; continue Task 1 while waiting.
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

## Task 3: Generic recipes and direct QEMU build

**Files:** Create `apps/template-builder/src/qemu.ts`, `qemu-build.ts` and
corresponding Vitest tests; extend `main.ts`, `seed.ts`, `seal.ts`,
`agent-package.ts` only as needed. Modify Linux cleanup/verification recipes.
If Debian is selected, selectively port `19fb361b` and relevant `5ae76ad0`
changes; do not cherry-pick web/Payload/catalog edits wholesale.

**Interfaces:** QEMU implementation of existing `GuestIo.exec`/file access,
QMP start/stop/reboot and production `buildImage({slug, version, outputDir})`.
Return cold disk path plus facts, package/license inventories and measurements;
never return install-bound PVE identities or publish directly.

- [ ] Add failing adapter tests for KVM/disk probe failure, guest/QGA timeout,
  reboot/reconnect, failed recipe step, cancellation and cleanup.
- [ ] Add generic-seed tests rejecting tunnel CA/URL/API URL/SSH CA input, while
  local builder defaults and legacy signed agent package tests remain intact.
- [ ] Implement Linux-only generic build using existing recipe step/fact/seal
  helpers, user-mode networking and isolated QGA/QMP Unix sockets. No TCG fallback.
- [ ] Keep exact snapshot pins and bound network/step timeouts. Audit all non-apt
  downloads; retain integrity/provenance and record exact installed versions.
- [ ] Eliminate CI zero-fill peak allocation via cold sparse export/compaction;
  inspect final filesystem for cloud-init/DHCP/identity/SSH/log/desktop state.
- [ ] If Debian confirmed, port source schema/downloader/dual hashes, snapshot
  helpers, kernel/Java/Docker differences; establish desktop dependency-compatible
  assets and fresh hashes. Never silently change base or product slugs.
- [ ] Boot two disposable local QEMU clones with different identities/CAs; run
  baseline/desktop checks and cold scans. Run only if this environment supports
  KVM; otherwise report unmeasured integration and leave CI acceptance pending.
- [ ] Commit `feat(builder): build generic Linux images with QEMU`.

## Task 4: Restricted node-agent download/import

**Files:** Create `services/node-agent/internal/ops/image_manifest.go`,
`image_download.go`, `image_import.go` and matching Go tests; modify dispatch,
node-agent config/install provisioning for trusted publisher key and image origin,
plus `packages/pve/src/node-client.ts` and its tests.

**Interfaces:** `image.prepare` verifies metadata and returns missing digest keys;
`image.import` accepts job/VMID/metadata identity, downloads from configured origin,
then returns a UUID-bound receipt. Neither operation accepts shell commands or
arbitrary local paths. Progress records contain digest keys, never credentials.

- [ ] Write failing HTTP fixture tests: dropped chunk, 429/Retry-After, timeout,
  truncated/oversized/hash-mismatched response, outside-origin redirect, symlink,
  corrupt cache after restart, cache quota/full disk and cancellation.
- [ ] Implement at-most-five attempts per <=512 MiB chunk, streaming SHA-256,
  bounded buffers, atomic durable verified cache, cache quota and restart rehash.
- [ ] Write failing import fixtures: wrong header/decoded length/raw hash, zstd
  failure/trailing data, pvesm exit failure, changed storage/UUID, occupied VMID,
  wrong ownership, concurrent job, crash before/after receipt.
- [ ] Implement size-limited raw+size pipeline and source digest through guarded
  pvesm staging, process cleanup and durable UUID receipt using S21 guards.
- [ ] Demonstrate failure leaves no publishable template and never removes
  unrelated data. Verify a completed job can recover without re-downloading.
- [ ] Run Go tests/race/lint and focused node-client Vitest.
- [ ] Commit `feat(node): verify and import chunked Linux images`.

## Task 5: Wizard default download and existing lifecycle

**Files:** Create `deploy/compose/quickstart/setup-images.mjs` and
`setup-images.test.mjs`; modify `setup-build.mjs`, `setup.mjs`, `setup-ui.mjs`
and associated tests. Extend builder registry/manifest adapters if required.

**Interfaces:** `runImageImport(invocation, hooks) -> ready Manifest`, injected
beside `runTemplateBuild` in existing `BuildJobs`; records image release identity
and raw+size disk proofs while using existing reserve/register/finish/replicate.

- [ ] Write failing tests for Linux default download, advanced local selection,
  Windows unchanged, no enabled node, occupied template range, cancellation,
  clone verification failure and restart before/after registration.
- [ ] Implement durable download/import/clone-check progress under existing job
  fence, use node-agent receipt, create allowlisted template VM and verify clone.
- [ ] Register/promote only verified results; use S21 replication once for every
  other eligible node. A failed replica retains old active build and can retry.
- [ ] Run quickstart tests from root and relevant builder/PVE Vitest.
- [ ] Commit `feat(setup): download Linux templates by default`.

## Task 6: S22 autonomous image rollout

**Files:** Modify `recipe-channel.mjs`, `recipe-rollout.mjs`, recipe bundle/channel
and rollout tests, `docs/specs/s22-template-channel.md`.

**Interfaces:** Independent verified image availability within the existing
recipe-channel owner/settings, using shared platform stable/edge selector;
Linux jobs receive verified image identity, Windows receives recipe directory.
Do not create a second promotion/retirement engine or an independent selector.

- [ ] Write failing tests for public pointer discovery without GitHub auth,
  invalid signature/compatibility, monotonic per-channel sequence, stale metadata,
  edge/stable switch mid-job, maintenance start mid-job and restart recovery.
- [ ] Implement image checking independently of Windows recipe fetch failures,
  enabled/auto settings and existing serial idle-node rollout. Recheck selected
  channel/fence before promotion; retain staged chunks for safe retry.
- [ ] Test rollback to retained verified builds, reference-aware retirement and
  S21 replication failure recovery; no running sandbox stops.
- [ ] Run `mise exec -- node --test deploy/compose/quickstart/` from repo root.
- [ ] Commit `feat(channel): roll out signed Linux images through S22`.

## Task 7: Manual publisher, inventories and measured acceptance

**Files:** Create `.github/workflows/linux-images.yml`,
`infra/templates/release-images.mjs`, tests, license inventory helper and
`docs/operations-s25-images.md`; update builder README and this spec's evidence.

**Interfaces:** `release-images` consumes closed, verified local artifacts,
file-based signing/S3 credentials and non-secret bucket configuration. Produces
signed release metadata, content-addressed uploads and channel pointer last.
`publish=false` builds/verifies without uploading; any upload to current bucket
requires master approval and confirmed distro/licenses.

- [ ] Write failing tests for non-main publish, version replacement, absent
  signing file, mismatched key, malformed artifact paths, unknown/proprietary
  license gate, failed upload/readback, and pointer never advancing on partial run.
- [ ] Implement zstd chunking, exact byte/raw hashes, package/source/license
  manifests with notice files, production binary/tool hashes and measurements.
- [ ] Implement file-only secret materialization/loading, host-only signing after
  guest checks, read-back verification and final pointer update under workflow
  concurrency. Verify no secret enters process env/argv/logs or artifacts.
- [ ] Use manual workflow, pinned stable tools/actions, KVM/RAM/free-disk probes,
  sequential slugs and explicit timeouts. On failure report runner alternatives;
  never choose a paid or Proxmox runner automatically.
- [ ] Ask master for bucket-scoped Object Read & Write credential pair in
  `R2_IMAGES_ACCESS_KEY_ID` / `R2_IMAGES_SECRET_ACCESS_KEY` only when implementing
  upload; reuse `RECIPE_SIGNING_KEY`. Do not request bucket admin or read tokens.
- [ ] Run publisher tests, Biome for TS, relevant Vitest, Go tests and golangci-lint,
  and root quickstart suite. Review final diff against spec and no-web constraint.
- [ ] Report actual compressed size/chunks/peak disk/CI duration if CI is authorized.
  Ask master to perform PVE import and two-CA/S21-copy acceptance; record actual
  download/import/ready timings separately from planning estimates.
- [ ] Commit `feat(ci): publish signed Linux images manually`; push branch only.
  Send master head SHA, test evidence, unresolved gates and measured/unmeasured
  size/time fields. Do not claim S25 complete before integration acceptance.

## Design-stage evidence

At drafting, HEAD matched fetched main (`git rev-list --left-right --count
HEAD...origin/main`: 0 / 0). Node via mise: v26.13.0. No dependencies added,
product code changed, image built, cloud resource modified or publish workflow run.
S25 size/import metrics remain unmeasured; estimates are labeled in the spec.

Design-stage validation: `git diff --check` passed. The requested root quickstart
suite was run and exited 1 in this checkout: missing `@umiak/db` workspace
resolution, absent compiled CLI artifacts, and font asset availability failures
prevent a passing baseline. No product code was modified to mask these failures.
Runtime tests/lints and actual image measurements remain implementation gates.
