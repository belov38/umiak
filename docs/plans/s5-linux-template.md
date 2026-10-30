# S5 Linux template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sbx-tpl build linux` builds the `linux` sandbox template on `pve` from the official Ubuntu 26.04 minimal cloud image through QGA, verifies it with a clone and a fork, and records the build where the worker reads it.

**Architecture:** Recipe as data in `infra/templates/linux/` (template.yaml, versions.toml, seed, bash steps, files, guest verify script); TS builder `apps/template-builder` (`sbx-tpl`) on top of `@sbx/pve`. The build VM boots the cloud image with a NoCloud seed ISO that carries the steps; each step runs as a transient systemd unit started through QGA, its log is tailed with `agent/file-read` offsets. The VM is sealed by `sbx-agent seal` and converted to a template in place. Verification clones it with the S1 `create` primitive, runs guest checks through QGA, forks it and checks the new identity.

**Tech Stack:** Node 26 (TS run directly, type stripping), vitest, biome; `openpgp`, `smol-toml`, `yaml`, `zod` (latest, checked 2026-10-30: 6.3.2, 1.9.1, 2.9.1, 4.6.7); `node:util` parseArgs like `apps/bench`; Go 1.27 for `services/node-agent`; bash + shellcheck for steps; `hdiutil` (macOS) or `xorriso` (Linux) for the seed ISO.

**Spec:** `docs/specs/s5-linux-template.md` (with R5, R6). Also S1 §4.6/§6, S3 §5, §7, §17, §20.

## Global Constraints

- `pve` rules: VMIDs ≥ 500 only; never modify 599, 9000, 9001, anything below 500, `vmbr0`, VM 103; no firewall or SDN changes; ≤ 8 GB RAM in total for VMs we start; delete build and verify VMs.
- PVE access by IP: `SBX_PVE_URL=https://100.64.10.2:8006`, `SBX_PVE_TLS_NAME=pve`, `SBX_NODE_SSH_HOST=100.64.10.2`; credentials in `~/.config/sbx/`.
- No Tailscale in the image and no Tailscale addresses in product defaults. No external tunnels or relays (cloudflared, ngrok, ...). Downloads only from official sources.
- Secrets reach the guest only through QGA `input-data` (stdin), never in a `guest-exec` command line (qemu-ga logs it). Private keys are never committed and never enter the build VM.
- Template is not tied to a gateway: verification must pass without a tunnel (agent `active`, `doctor` green, tunnel not connected).
- Versions: latest stable at build time, pinned in `infra/templates/linux/versions.toml`; version format `YYYYMMDD.n`; VM name `sbx-tpl-<slug>-<YYYYMMDD>-<n>`; tag `sbx-tpl`; pool `sandbox`.
- Build VM: 4 vCPU / 4096 MB; verify clones 2 vCPU / 2048 MB; RAM guard cap 8192 MB.
- Code comments in English; talk to the user in Russian.

## Decisions taken here (spec deviations are recorded in spec §20 at the end)

1. **Template VMID.** `Allocator.allocateTemplate()` hands out template VMIDs from the top of the S1 range downward (first build: 598) with a `purpose=template` lease in the S1 SQLite state DB. 599 stays the PoC fallback. `loadConfig` no longer rejects a template VMID inside the range (the allocator skips templates and existing VMs anyway).
2. **S1 §17.1 changes are made here** (S1 is merged, nobody else owns them): `rng0` in the hardware whitelist; no cloud-init drive when the template has none; `smbios1.family` with the 512-char check; exported VM firewall setup; `delete` refuses `template: 1`; bench cleanup and preflight skip `sbx-tpl` VMs; `sbx-node` accepts `base-<id>-*` origins for any id in its range and forbids `vm-<id>-disk-*` when `base-<id>-*` exists; `sbx-node media.list|media.remove`; runbook step `setup.sh media` (role `SbxTemplateMedia` on `/storage/local`). The new `sbx-node` is deployed with `setup.sh node`.
3. **Registry.** S6 exists, so the SQLite registry of spec §11 is not built. `sbx-tpl` keeps manifests as JSON files in `~/.local/state/sbx/templates/<buildId>.json` (version numbering, `list`, `show`, `cleanup`) and prints the `sbx-admin template register` line. The build is recorded in `deploy/compose/config/sbx.yaml` `topology.templateBuilds` (what the worker reads; `sbx-admin bootstrap` promotes it). `promote` is S6 `sbx-admin template promote`; `gc` is left to S6/S12 (spec §17.4 p. 5).
4. **Tunnel URL.** `--tunnel-url` is optional. Without it `agent.toml` has no `[tunnel] url`; the worker sets the URL per VM through `smbios1.family` (S6 §17.4 p. 3). One build = one tunnel CA bundle (inside the agent package).
5. **Agent package.** `infra/templates/agent-package.sh` builds `sbx-agent` and packs it with `sbx-release pack` using the PoC key `~/.config/sbx/update-signing/ed25519.key` and a given tunnel CA. For the PoC build the CA comes from `sbx-gateway dev-secrets` written to `~/.config/sbx/gateway-dev/` (the compose gateway must use the same files).
6. **sbx CLI.** `--sbx-cli` is optional (S7 has no release yet); step `40-coding-agents` installs `/mnt/seed/build/sbx` when present, else `tools.sbx = null`.
7. **Docker stays** (spec §8.8); `docker0` exists but listens on nothing; verify checks the sockets.
8. **Template hostname** is `sbx` (not `sbx-build`): early boot logs before `sbx-identity` show `sbx`.
9. **Free-space hygiene.** `90-cleanup` removes files, `fstrim`, zero-fills free space (`dd` to a file, `sync`, `rm`), `fstrim` again. Raw-disk secret scan runs inside the verify clone over `/dev/sda` with patterns passed on stdin.
10. **Guest checks** live in one bash script `infra/templates/linux/verify.sh` that prints `CHECK <id> <PASS|FAIL|INFO> <evidence>` lines; host-side checks (doctor fields, versions, hard stop timing, fork identity, KVM) are in `verify.ts`.

## Review Focus

1. **Second build on the same day / after a failed build:** version `n` increments, the new VMID does not collide with an existing template or a reserved lease (test in Task 1 and Task 9).
2. **Build failure in the middle** (step exits non-zero, QGA times out, PVE task fails): VM, seed ISO and lease are removed unless `--keep-on-failure`; the manifest says `failed` with stage, step and the last 200 log lines (test in Task 9).
3. **Step log tailing across UTF-8 boundaries and a growing file:** offsets advance by bytes, not characters; a multi-byte char split between two reads is printed once and intact (test in Task 8).
4. **A clone of the new template with a different MAC and smbios** gets an IP within 15 s, its own machine-id/hostname/host keys, and a fork gets yet another identity (verified on `pve` in Task 12; host-side assertion logic tested in Task 10).
5. **Worker and bench never delete the template:** bench cleanup and preflight skip `sbx-tpl`; `Machines.delete` refuses `template: 1`; `sbx-node` refuses to create `vm-<id>-disk-*` over a template id (tests in Tasks 1 and 2).

---

### Task 1: `@sbx/pve` and bench changes for new templates (S1 §17.1 p. 1, 4–8)

**Files:**
- Modify: `packages/pve/src/machine.ts`, `packages/pve/src/allocator.ts`, `packages/pve/src/config.ts`
- Modify: `apps/bench/src/cleanup.ts`, `apps/bench/src/preflight.ts`
- Test: `packages/pve/test/machine.test.ts`, `packages/pve/test/allocator.test.ts`, `packages/pve/test/config.test.ts`, `apps/bench/test/cleanup.test.ts`

**Interfaces:**
- Produces:
  - `interface Smbios { uuid: string; serial: string; family?: string }` — `family` is the raw value (`"sbxt1:" + url`), base64-encoded like `serial`.
  - `SMBIOS1_MAX = 512`; `formatSmbios1(s)` throws `SmbiosTooLongError` (exported) when the result is longer than 512 chars.
  - `familyForTunnelUrl(url: string): string` — returns `"sbxt1:" + url`; throws if not `wss://`, empty host, or > 200 bytes.
  - `TEMPLATE_HW_KEYS` gains `"rng0"`.
  - `Machines.create` adds `ide2=<storage>:cloudinit`, `ipconfig0`, `ciuser`, `ciupgrade=0` only when the template config has a drive value containing `:cloudinit` (any `ide*/scsi*/sata*` key); otherwise none of them.
  - `configureVmFirewall(api: PveClient, node: string, vmid: number, mac: string, opts: { ipfilter: boolean }): Promise<void>` — exported; `Machines` uses it.
  - `Machines.delete(vmid)` throws `Error("refusing to delete template VM <vmid>")` when the VM config has `template: 1` (checked before any lease work; a missing VM is not an error).
  - `Allocator.allocateTemplate(): Promise<AllocatedVmid>` — scans `range.max` down to `range.min`, skips leased and occupied VMIDs, inserts `{purpose: "template", state: "reserved"}`. `markActive`/`release` work on it unchanged.
  - `Allocator.allocate()` additionally skips any lease with `purpose === "template"` (already true via `taken`; add a test).
  - `loadConfig` accepts `SBX_TEMPLATE_VMID` inside `SBX_VMID_RANGE`.
  - bench `cleanup`/`preflight`: VMs with tag `sbx-tpl` or `template: 1` are never deleted and never reported as leftovers.

- [ ] **Step 1: Write failing tests**
  - `formatSmbios1({uuid, serial, family: "sbxt1:wss://t.example/v1/connect"})` contains `family=<base64>` before `base64=1`; a family making the string 513 chars throws `SmbiosTooLongError`; exactly 512 passes.
  - `familyForTunnelUrl("https://x")` throws; a 201-byte `wss://` URL throws; a 200-byte one returns `sbxt1:` + url.
  - `create` from a fake template config without a cloudinit drive posts no `ide2`, `ipconfig0`, `ciuser`, `ciupgrade`; with `ide2: "local-lvm:vm-599-cloudinit,media=cdrom"` it posts all four as before; `rng0` is copied from the template config.
  - `delete(598)` on a fake VM with `template: 1` rejects and makes no DELETE call.
  - `allocateTemplate()` with range 500–598, VM 598 occupied → 597; `allocate()` with a template lease on 500 → 501.
  - `loadConfig({SBX_TEMPLATE_VMID: "598"})` with default range succeeds.
  - bench cleanup with a fake VM `{vmid: 598, pool: "sandbox", tags: "sbx-tpl", template: 1}` does not delete it.
- [ ] **Step 2: Run** `mise exec -- pnpm --filter @sbx/pve --filter @sbx/bench test` — new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above. `#firewall` becomes a call to `configureVmFirewall`. Template check in `delete` reads `/config` (404/500 "does not exist" → not a template).
- [ ] **Step 4: Run** the same command — PASS; `mise exec -- pnpm --filter @sbx/pve --filter @sbx/bench typecheck` and `pnpm lint` clean.
- [ ] **Step 5: Commit** `pve: template VMIDs from the allocator, no cloud-init drive for S5 templates, smbios family`.

### Task 2: `sbx-node` template origins and media ops, runbook `media` step (S1 §17.1 p. 2, 3)

**Files:**
- Modify: `services/node-agent/internal/ops/guards.go`, `services/node-agent/internal/ops/lv.go`, `services/node-agent/internal/ops/dispatch.go`, `services/node-agent/internal/config/config.go`
- Create: `services/node-agent/internal/ops/media.go`
- Modify: `infra/pve/setup.sh` (new step `media` + `revert media`), `infra/pve/sbx-node.toml`, `infra/pve/README.md`
- Test: `services/node-agent/internal/ops/guards_test.go`, `services/node-agent/internal/ops/media_test.go`, `services/node-agent/internal/ops/dispatch_test.go`, `services/node-agent/internal/config/config_test.go`

**Interfaces:**
- Produces (JSON ops over the existing `sbx-node --stdio` protocol):
  - `ValidOrigin`: `base-<id>-<x>` is allowed for any `id` with `VMIDMin ≤ id ≤ VMIDMax` (the legacy `templateVmid` included).
  - `lv.snapshot`: a target `vm-<id>-disk-<n>` is forbidden (`ErrForbidden`) if an LV `base-<id>-*` exists in the thin pool.
  - `templateVmid` in `/etc/sbx-node.toml` becomes optional (default 0 = none); when set it keeps its old meaning (excluded from `InRange`).
  - `media.list` → `{"iso": [{"name","size"}], "import": [{"name","size"}]}` for files matching `^sbx-seed-[a-z0-9-]{1,64}\.iso$` in `/var/lib/vz/template/iso` and `^sbx-[a-z0-9.+_-]{1,96}\.(qcow2|img|raw)$` in `/var/lib/vz/import`.
  - `media.remove {"names": ["..."]}` removes only names that match those patterns, are regular files (`Lstat`, no symlinks), no `/` or `..`; anything else → `ErrForbidden`, nothing removed.
  - Directories are config fields `isoDir`, `importDir` with those defaults (tests point them at a temp dir).
- `setup.sh media`: `pveum role add SbxTemplateMedia -privs "Datastore.AllocateTemplate,Datastore.Audit"` (or `modify` if exists), `pveum acl modify /storage/local -user sbx@pve -role SbxTemplateMedia` and the same for `-token 'sbx@pve!poc'`; verify by `GET /access/permissions` with the token showing `Datastore.AllocateTemplate` on `/storage/local`. `revert media` removes the ACLs and the role. `--dry-run` prints.

- [ ] **Step 1: Write failing Go tests:** origin `base-598-disk-0` allowed with range 500–599 and `templateVmid` unset; `base-9000-disk-0` and `base-499-disk-0` forbidden; snapshot to `vm-598-disk-0` refused when the fake LV list has `base-598-disk-0`; `media.remove` refuses `../x.iso`, `foo.iso`, a symlink named `sbx-seed-a.iso`, and removes `sbx-seed-0192abcd.iso`; `media.list` lists only matching files; config without `templateVmid` loads.
- [ ] **Step 2: Run** `cd services/node-agent && mise exec -- go test ./...` — FAIL.
- [ ] **Step 3: Implement.** Keep the existing guard style (`forbidden(...)`, regexps at the top of `guards.go`).
- [ ] **Step 4: Run** `mise exec -- go test -race ./... && mise exec -- golangci-lint run ./...` — PASS. `bash -n infra/pve/setup.sh && shellcheck infra/pve/setup.sh` clean.
- [ ] **Step 5: Commit** `node-agent: any base-<id> template origin in range, media.list/remove; setup.sh media`.

### Task 3: Builder scaffold, recipe and versions schema

**Files:**
- Create: `apps/template-builder/{package.json,tsconfig.json,vitest.config.ts}`, `apps/template-builder/src/recipe.ts`
- Create: `infra/templates/linux/template.yaml` (spec §5 verbatim, plus `verify: linux`)
- Test: `apps/template-builder/test/recipe.test.ts`, fixtures in `apps/template-builder/test/fixtures/templates/`

**Interfaces:**
- Package `@sbx/template-builder`, bin `sbx-tpl` → `src/main.ts`, scripts `test`, `build` (`tsc --noEmit`), `typecheck`; deps `@sbx/pve: workspace:*`, `openpgp`, `smol-toml`, `yaml`, `zod` (exact latest versions).
- Produces:
  - `interface Recipe { slug: string; os: "linux" | "windows"; extends: string | null; source: {kind: "cloud-image"; distro: "ubuntu"; release: string; flavor: "minimal" | "server"}; disk: {slot: "scsi0"; sizeGb: number}; hw: Record<string, string>; cloudinit: boolean; buildVm: {cores: number; memoryMb: number}; steps: string[]; seal: "sbx-agent"; bootTimeoutS: number; verify: string; dir: string; stepDirs: string[] }` — `hw` values are strings as Proxmox takes them (`tablet: 0` → `"0"`); `hw.cloudinit` is lifted to `cloudinit`; `size: 64G` → `sizeGb: 64`.
  - `loadRecipe(templatesDir: string, slug: string): Recipe` — validates with zod (strict); `extends: <parent>` loads the parent, inherits `source`, `disk`, `hw`, `buildVm`, `seal`, `bootTimeoutS` unless overridden, `steps` = the child's `steps` list where the token `"@parent"` expands to the parent's steps (no token → child list as is); `stepDirs` = parent's dir then child's dir (a step file is looked up child first). Cycles and unknown parents throw.
  - `interface Versions` (zod, from spec §6.3): `base {serial: /^\d{8}(\.\d+)?$/, sha256: hex64}`, `apt {snapshot: /^\d{8}T\d{6}Z$/}`, `docker {docker_ce, containerd_io, compose_plugin, buildx_plugin}`, `tools {node, go, bun, uv, gh: {version, sha256}; rust: {version, rustup_init_sha256}}`, `chrome.google_chrome_stable {version, sha256}`, `npm: Record<string, string>`, `sbx?: {cli: {version, sha256}}`.
  - `loadVersions(recipe: Recipe): Versions` — child `versions.toml` merged over the parent's (S10 §6: desktop inherits linux pins).
  - `recipeDigest(recipe: Recipe): string` — sha256 over sorted relative paths + contents of all files in `stepDirs` (deterministic).
  - `stepFile(recipe: Recipe, step: string): string` — absolute path, child dir first; throws if missing. `reboot` is built in and never a file.

- [ ] **Step 1: Failing tests:** load `infra/templates/linux/template.yaml` → `steps` equals the spec list, `hw.rng0 === "source=/dev/urandom"`, `cloudinit === false`, `sizeGb === 64`; unknown key → throws; fixture `child` with `extends: linux-fixture` and `steps: ["@parent", "60-desktop"]` → parent steps + `60-desktop`, `stepFile(child, "00-base")` resolves to the parent's file; `extends` cycle → throws; `recipeDigest` stable across two calls and changes when a step file changes (temp copy); versions merge: child `[npm] x = "1"` adds to parent's npm map.
- [ ] **Step 2: Run** `mise exec -- pnpm --filter @sbx/template-builder test` — FAIL.
- [ ] **Step 3: Implement** `recipe.ts`; `pnpm install` for the new package.
- [ ] **Step 4: Run** tests — PASS; typecheck and lint clean.
- [ ] **Step 5: Commit** `template-builder: recipe and versions loader`.

### Task 4: `sbx-tpl versions [--update]`

**Files:**
- Create: `apps/template-builder/src/versions-update.ts`
- Create: `infra/templates/linux/versions.toml` (written by the real `--update` run in Step 6)
- Test: `apps/template-builder/test/versions-update.test.ts`, fixtures under `test/fixtures/upstream/`

**Interfaces:**
- Consumes: `Versions`, `loadVersions` (Task 3).
- Produces:
  - `type Fetch = (url: string) => Promise<{status: number; text(): Promise<string>}>`
  - `resolveLatest(fetch: Fetch, now: Date, npmNames: string[]): Promise<Versions>` with these official sources:
    - base: `https://cloud-images.ubuntu.com/minimal/releases/resolute/` → the newest `release-<serial>/`; sha256 from its `SHA256SUMS` line for `ubuntu-26.04-minimal-cloudimg-amd64.img`;
    - apt snapshot: `now` (UTC) floored to the day, format `YYYYMMDDT000000Z`;
    - node: `https://nodejs.org/dist/index.json` → newest entry with `lts !== false`; sha256 of `node-v<v>-linux-x64.tar.xz` from `https://nodejs.org/dist/v<v>/SHASUMS256.txt`;
    - go: `https://go.dev/dl/?mode=json` → first `stable` release, file `linux-amd64` archive sha256;
    - bun: GitHub API `https://api.github.com/repos/oven-sh/bun/releases/latest` tag `bun-v<v>`, sha256 of `bun-linux-x64.zip` from that release's `SHASUMS256.txt`;
    - uv: GitHub `astral-sh/uv` latest, `uv-x86_64-unknown-linux-gnu.tar.gz.sha256`;
    - gh: GitHub `cli/cli` latest, `gh_<v>_checksums.txt` line for `gh_<v>_linux_amd64.tar.gz`;
    - rust: `https://static.rust-lang.org/dist/channel-rust-stable.toml` `[pkg.rust] version` (first token); `https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256`;
    - docker: `https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages` → highest version (Debian version compare) of `docker-ce`, `containerd.io`, `docker-compose-plugin`, `docker-buildx-plugin`;
    - chrome: `https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages` → `google-chrome-stable` `Version` and `SHA256`;
    - npm: `https://registry.npmjs.org/<name>/latest` → `version` for `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`, `@google/gemini-cli`, `pnpm`;
    - sbx: kept from the existing file if present, otherwise omitted.
  - `compareDebVersions(a: string, b: string): number` (epoch, upstream, revision; `~` sorts first).
  - `formatVersionsToml(v: Versions): string` — stable key order, the header comment `# Generated by sbx-tpl versions --update; edit by hand only to pin.`
  - CLI `sbx-tpl versions <slug>` prints the file; `--update` rewrites it and prints a diff summary (`name: old -> new`).
  - Every fetch failure or a missing entry throws with the URL; GitHub requests send `User-Agent: sbx-tpl` and use `GITHUB_TOKEN` if set.

- [ ] **Step 1: Failing tests** with fixture bodies for each source: `resolveLatest` returns the newest serial, the LTS node (skipping a newer non-LTS), go stable, docker highest by Debian compare (`5:29.1.2-1~ubuntu.26.04~resolute` > `5:29.1.10-1~...` is false), chrome version and sha; `compareDebVersions("1.0~rc1", "1.0") < 0`, epoch wins; a 404 fixture throws naming the URL; `formatVersionsToml` round-trips through `loadVersions`' schema.
- [ ] **Step 2: Run** tests — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests — PASS.
- [ ] **Step 5: Real run** `mise exec -- node apps/template-builder/src/main.ts versions linux --update`; inspect the file (every value present, serial ≥ 20261024); commit it.
- [ ] **Step 6: Commit** `template-builder: versions --update; pinned linux versions`.

### Task 5: Base image fetch/verify and agent package verification

**Files:**
- Create: `apps/template-builder/src/image.ts`, `apps/template-builder/src/agent-package.ts`, `apps/template-builder/src/tar.ts`
- Create: `infra/templates/keys/ubuntu-cloud-images.asc` (Ubuntu Cloud Image Builder key, fingerprint `D2EB 4462 6FDD C30B 513D 5BB7 1A5D 6C4C 7DB8 7C81`; fetched from `keyserver.ubuntu.com`, fingerprint checked against Ubuntu docs before commit)
- Test: `apps/template-builder/test/image.test.ts`, `apps/template-builder/test/agent-package.test.ts`

**Interfaces:**
- Produces:
  - `imageFileName(v: Versions["base"]): string` → `ubuntu-26.04-minimal-cloudimg-amd64.img`; `pveImageName(serial)` → `sbx-ubuntu-26.04-minimal-<serial>.qcow2`.
  - `verifySha256Sums(sumsText: string, sigArmoredOrBinary: Uint8Array, pinnedKeyArmored: string): Promise<void>` — openpgp detached signature check; throws on a bad or missing signature.
  - `fetchBaseImage(o: {fetch, cacheDir, base: Versions["base"], keyFile}): Promise<{path: string; sha256: string}>` — downloads `SHA256SUMS`, `SHA256SUMS.gpg`, verifies the signature, checks that `base.sha256` equals the line for the image, downloads the image to `<cacheDir>/<serial>/` (stream to `.part`, sha256 while streaming, rename), reuses a cached file whose sha256 matches.
  - `readTar(buf: Buffer): Map<string, Buffer>` — ustar reader (regular files only, rejects `..` and absolute names).
  - `verifyAgentPackage(tarPath: string, updateKeysFile: string): {version: string; os: string; arch: string; sha256: string}` — parses `manifest.json` (`format: "sbx-agent-manifest/v1"`), verifies `manifest.sig` (ed25519, raw 64 bytes, over the exact bytes of `manifest.json`) against any key line of `update-keys.pub` (`ed25519 <base64-32> <comment>`), checks every `files` sha256, requires `os=linux`, `arch=amd64`; returns the tar's sha256.

- [ ] **Step 1: Failing tests:** a test PGP key generated in the test (`openpgp.generateKey`) signs a SUMS text → verify passes; tampered text → throws; a key that is not pinned → throws. Agent package: build a tar in the test with `node:crypto` ed25519 → passes; flipped byte in `sbx-agent` → throws `sha256 mismatch`; signature by an unlisted key → throws; `arch: arm64` → throws; `readTar` rejects `../evil`. `fetchBaseImage` with a fake fetch: reuses a cached file with matching sha (no image fetch), refuses a mismatching `base.sha256`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `template-builder: signed base image and agent package verification`.

### Task 6: Seed ISO

**Files:**
- Create: `apps/template-builder/src/seed.ts`
- Create: `infra/templates/linux/seed/user-data.tmpl`, `meta-data.tmpl`, `network-config`
- Test: `apps/template-builder/test/seed.test.ts`

**Interfaces:**
- Consumes: `Recipe`, `Versions`, `stepFile` (Task 3).
- Produces:
  - `interface SeedInput { recipe: Recipe; versions: Versions; buildId: string; version: string; agentPackage: string; agentVersion: string; sbxCli?: string; apiUrl?: string; tunnelUrl?: string; sshUserCa?: string; manifestBase: object }`
  - `renderSeed(i: SeedInput): Map<string, string | Buffer>` — relative path → content:
    - `meta-data`: `instance-id: <buildId>`, `local-hostname: sbx-build`;
    - `network-config`: v2, `match: {name: "en*"}`, `dhcp4: true`;
    - `user-data`: `#cloud-config`, `users: []`, `disable_root: true`, `ssh_pwauth: false`, `bootcmd` that adds `Snapshot: <apt.snapshot>` to every stanza of `/etc/apt/sources.list.d/ubuntu.sources` (idempotent), `package_update: true`, `packages: [qemu-guest-agent]`, `runcmd: [[systemctl, enable, --now, qemu-guest-agent]]`; no keys, no passwords;
    - `build/steps/<step>.sh` for every non-`reboot` step, `build/lib.sh` (child over parent), `build/files/**` (child over parent), `build/versions.toml` (merged, re-serialized), `build/env` (`SBX_BUILD_ID`, `SBX_BUILD_VERSION`, `SBX_AGENT_VERSION`, `SBX_APT_SNAPSHOT`; values shell-quoted), `build/sbx-agent-<v>-linux-amd64.tar`, `build/agent.toml`, `build/ssh-user-ca.pub` (empty if none), `build/sbx` + `build/sbx-config.json` (`{"apiUrl": ...}`) when given, `build/build.json` (manifest without verify).
  - `renderAgentToml(tunnelUrl?: string): string` — `[tunnel] url` only when given, `[user] default = "user"`, `[readiness] required = ["identity", "claim", "secrets", "docker"]`, `[docker] enabled = true`.
  - `makeIso(files: Map<string, string|Buffer>, out: string, tool?: "hdiutil" | "xorriso"): void` — writes the tree to a temp dir, volume label `cidata`; macOS `hdiutil makehybrid -iso -joliet -default-volume-name cidata -o <out> <dir>`; Linux `xorriso -as mkisofs -V cidata -J -R -o <out> <dir>`; throws when the tool is missing.

- [ ] **Step 1: Failing tests:** user-data parses as YAML, has no `ssh_authorized_keys`, `passwd`, `chpasswd`; contains the snapshot; network-config has no `macaddress`; agent.toml without tunnel URL has no `url =`; with one has it; `build/env` quotes a value with a space; every recipe step except `reboot` is present; on macOS `makeIso` produces a file whose `hdiutil imageinfo`/`isoinfo` shows volume `cidata` (test skipped when neither tool exists).
- [ ] **Step 2–4:** run FAIL, implement, run PASS.
- [ ] **Step 5: Commit** `template-builder: seed ISO`.

### Task 7: Recipe steps, config files and the guest verify script

**Files:**
- Create: `infra/templates/linux/steps/{00-base,10-system,20-docker,30-toolchains,40-coding-agents,50-sbx-agent,90-cleanup}.sh`
- Create: `infra/templates/linux/files/` — `etc/ssh/sshd_config.d/10-sbx.conf`, `etc/netplan/10-sbx.yaml`, `etc/systemd/system/systemd-networkd-wait-online.service.d/10-sbx.conf`, `etc/systemd/resolved.conf.d/10-sbx.conf`, `etc/default/grub.d/90-sbx.cfg`, `etc/sysctl.d/90-sbx.conf`, `etc/systemd/system.conf.d/90-sbx.conf`, `etc/systemd/journald.conf.d/90-sbx.conf`, `etc/docker/daemon.json`, `etc/sudoers.d/90-sbx-user`, system-wide auto-update switches of the coding-agent CLIs, each the one its vendor documents (Claude Code `/etc/claude-code/managed-settings.json` with `env.DISABLE_AUTOUPDATER`; Gemini CLI system settings; OpenCode global config; Codex if it has one) — a CLI without a system-wide switch is listed in `apps/template-builder/README.md`
- Create: `infra/templates/linux/verify.sh`, `infra/templates/linux/lib.sh` (shared helpers: `log`, `apt_install`, `fetch_verify <url> <sha256> <out>`, `toml_get <key>`)
- Test: `apps/template-builder/test/steps.test.ts` (shellcheck on all `.sh`, plus static assertions)

**Interfaces:**
- Steps run as root with `bash /mnt/seed/build/steps/<n>.sh`, cwd `/mnt/seed/build`, `set -euo pipefail`, source `lib.sh` and `build/env`; idempotent; `DEBIAN_FRONTEND=noninteractive`; every download checks sha256 from `versions.toml`.
- Content is spec §8 exactly; the cross-scope items that must be visible in code:
  - `00-base`: full-upgrade from the snapshot, `linux-image-virtual`, package list §8.1, purge list §8.1 (+ `tailscale*`), mask list §8.1.
  - `10-system`: user `user` uid/gid 1000 (`sudo`, `kvm`), locked passwords for `user` and `root`, sudoers `visudo -c`, linger, no `ubuntu` user, **remove `/etc/skel/.bash_logout`, `/home/user/.bash_logout`, `/root/.bash_logout`**, locale `C.UTF-8`, TZ `UTC`, files from `files/`, `40-force-partuuid.cfg` removed, `update-grub`, `grub.cfg` has no `initrdfail`, netplan `50-cloud-init.yaml` removed, remove all kernels but the running one (this step runs after `reboot`), swap absent, PAM lines of S3 §8.2, `/etc/sbx/env` empty, `/etc/ssh/sbx_user_ca.pub` and `/etc/sbx-agent/ssh-user-ca.pub` from `build/ssh-user-ca.pub`.
  - `20-docker`: Docker apt repo (`signed-by` keyring from `https://download.docker.com/linux/ubuntu/gpg`), exact versions with `=`, `apt-mark hold`, `user` in group `docker`, `daemon.json`, `docker.service` enabled.
  - `30-toolchains`: node, go, bun, uv/uvx, gh, rust (as `user`, symlinks), chrome `.deb` by version with sha256; all binaries reachable in `/usr/local/bin`.
  - `40-coding-agents`: `npm install -g` the `[npm]` table with exact versions; `sbx` CLI only when `build/sbx` exists (sha256 = `versions.toml [sbx]` if present) and `/etc/sbx/config.json` when `build/sbx-config.json` exists; auto-update off files.
  - `50-sbx-agent`: `tar -xOf <pkg> sbx-agent > /tmp/sbx-agent-installer; install-package --write-config <pkg>` after copying `build/agent.toml` to `/etc/sbx-agent/agent.toml`; units enabled; `qemu-guest-agent` enabled; `sbx-agent doctor --json` shows `test_aids` empty.
  - `90-cleanup`: spec §8.10 list; `/etc/hostname` = `sbx`, `/etc/hosts` without `sbx-build`; apt sources back to the archive (drop `Snapshot:`), `apt-get clean`, lists removed; `cloud-init clean --logs --seed`, `touch /etc/cloud/cloud-init.disabled`; caches (`/root/.npm`, `/root/.cache`, `/home/user/.cache`, go build cache, rustup downloads/tmp); shell histories; `/var/log` contents; journal vacuum; copy `build/build.json` to `/etc/sbx-template/build.json`; then the self-check (swap, one kernel, purged packages absent, no `authorized_keys`, no `.bash_logout`) failing the step on any violation. The builder runs `sbx-agent seal`, the zero-fill and `fstrim` after this step (Task 9), not the script.
- `verify.sh` (runs as root; the builder sends `export MACHINE_ID=...; export EXPECT_SUBNET=10.88.0.0/24` followed by the script on stdin to `bash -s`, never in argv; `SBX_VERIFY_MODE=tools` prints only the `TOOLS` line, used by the build for `manifest.tools`), prints one line per check `CHECK <id> <PASS|FAIL|INFO> <evidence>` for spec §10 items 1–8, 12–15, 17, 19 and: `bash_logout` absent; `cloudinit` disabled; `no_tailscale` (no package, unit, binary); `no_unattended` (package absent, timers masked); `no_ci_drive` (`/dev/sr0` has no `cidata` label); `hostname` = `sbx-<last 12 hex of MACHINE_ID>`; then `TOOLS {json}` with `--version` output per tool run as `user` both by direct exec (`sudo -u user env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/user <cmd>`) and through `sudo -iu user bash -lc`.
- `steps.test.ts`: every `.sh` under `infra/templates` passes `shellcheck -x -S warning` (skip with a message when shellcheck is missing); `10-system.sh` mentions all three `.bash_logout` paths; no file under `infra/templates/linux` contains `tailscale` except purge lists; `00-base.sh` purges every package of spec §8.1 list; `90-cleanup.sh` contains `cloud-init.disabled`.

- [ ] **Step 1: Failing tests** (`steps.test.ts` as above).
- [ ] **Step 2: Run** — FAIL. **Step 3: Write** the scripts and files. **Step 4: Run** — PASS (shellcheck clean).
- [ ] **Step 5: Commit** `templates/linux: build steps, config files, guest verify script`.

### Task 8: QGA step runner

**Files:**
- Create: `apps/template-builder/src/runner.ts`
- Test: `apps/template-builder/test/runner.test.ts`

**Interfaces:**
- Consumes: `Qga` from `@sbx/pve` (`exec`, `ping`), `PveClient` for `agent/file-read` and `agent/get-osinfo`.
- Produces:
  - `interface GuestIo { exec(cmd: string[], o?: {input?: string; timeoutMs?: number}): Promise<ExecResult>; readFile(path: string, offset: number, count: number): Promise<Buffer>; ping(): Promise<boolean> }` and `pveGuestIo(api: PveClient, node: string, vmid: number): GuestIo` (`file-read` with `decode=0`, base64 → bytes; a missing file → empty buffer).
  - `runStep(io: GuestIo, o: {name: string; script: string; log: (chunk: string) => void; pollMs?: number; timeoutMs?: number}): Promise<{exitStatus: number; tail: string[]}>` — starts `systemd-run --unit=sbx-build-<name> --collect --property=StandardOutput=append:/var/log/sbx-build/<name>.log --property=StandardError=append:/var/log/sbx-build/<name>.log --property=WorkingDirectory=/mnt/seed/build -- bash <script>` (after `mkdir -p /var/log/sbx-build`), then every `pollMs` (default 2000): reads new bytes from the log at the byte offset, feeds them through a `TextDecoder` in streaming mode, and reads `systemctl show -p ActiveState,Result,ExecMainStatus sbx-build-<name>`; done when `ActiveState` is `inactive` or `failed` (with `--collect` a vanished unit counts as done: read `ExecMainStatus` before it is collected by also writing `/var/log/sbx-build/<name>.rc` from an `ExecStopPost=/bin/sh -c 'echo $EXIT_STATUS > ...'` property and treating that file as the source of truth); drains the log once more; returns the exit status and the last 200 lines. Throws `StepFailedError {step, exitStatus, tail}` on non-zero.
  - `mountSeed(io)`: `mkdir -p /mnt/seed && (mountpoint -q /mnt/seed || mount -o ro LABEL=cidata /mnt/seed)`.
  - `rebootGuest(io, o: {timeoutMs})`: reads `/proc/sys/kernel/random/boot_id`, runs `systemctl reboot` (exec may fail as the agent goes away: ignore), waits for `ping` and a different boot id, remounts the seed.

- [ ] **Step 1: Failing tests** with a fake `GuestIo` whose log grows over polls: the output is delivered in order with a 3-byte UTF-8 char split across two reads (printed once, intact); exit status from the `.rc` file; non-zero → `StepFailedError` with the tail (≤ 200 lines); the start command contains no value from the step's env (only the unit name and script path); timeout → throws with the step name; `rebootGuest` waits until the boot id changes.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `template-builder: QGA step runner with offset log tailing`.

### Task 9: Build orchestration, registry, CLI

**Files:**
- Create: `apps/template-builder/src/{build.ts,registry.ts,context.ts,main.ts,preflight.ts,cleanup.ts}`
- Test: `apps/template-builder/test/{build.test.ts,registry.test.ts}`, fake PVE in `test/fakes.ts` (reuse `@sbx/pve/testing` where it fits)

**Interfaces:**
- Consumes: Tasks 1, 3, 5, 6, 8.
- Produces:
  - `interface Manifest` = spec §11 fields: `buildId, templateSlug, version, os, status ("building"|"ready"|"failed"), node, storage, pveVmid, vmName, gitCommit, recipeDigest, base {distro, release, flavor, serial, sha256}, apt {snapshot}, kernel, systemd, packages: Record<string,string>, tools: Record<string,string|null>, agentVersion, defaultTunnelUrl: string|null, hw, diskLayout, bootTimeoutS, buildMemoryMb, startedAt, finishedAt, durationS, verify?: VerifyResult, error?: {stage, step?, message, tail?: string[]}`.
  - `class FileRegistry { constructor(dir: string); create(m: Manifest); update(id, patch: Partial<Manifest>); get(id); list(slug?): Manifest[]; nextVersion(slug: string, now: Date): string }` — `nextVersion` = `<YYYYMMDD UTC>.<1 + max n of that date for slug>`; writes are atomic (temp + rename).
  - `newBuildId(): string` — UUIDv7.
  - `buildTemplate(deps: BuildDeps, o: BuildOptions): Promise<Manifest>` with `BuildDeps = {api: PveClient; node: NodeOps; allocator: Allocator; registry: FileRegistry; fetch: Fetch; io: (vmid) => GuestIo; makeIso; verify: (m: Manifest) => Promise<VerifyResult>; ramGuard: {reserve(vmid, mb), release(vmid)}; log; now }` and `BuildOptions = {slug, node, storage, pool, vnet, agentPackage, sbxCli?, apiUrl?, tunnelUrl?, sshUserCa?, keepOnFailure, noVerify, templatesDir, updateKeysFile, imageCacheDir, gitCommit, failStep?: string /* test flag: makes that step exit 1 */}`. Stages, in order (spec §7.2): prepare (recipe, versions, verifyAgentPackage, registry `building`) → image (fetchBaseImage; `GET /nodes/{n}/storage/local/content?content=import` and skip upload when `pveImageName` exists with the same size, else `POST /nodes/{n}/storage/local/upload` multipart `content=import`, `checksum`, `checksum-algorithm=sha256`) → seed (render, makeIso, upload as `content=iso` `sbx-seed-<buildId>.iso`) → vm (`allocateTemplate`, `POST /nodes/{n}/qemu` with the spec §7.2 p. 4 params, `PUT .../resize scsi0 64G`, `configureVmFirewall` with ipfilter) → boot (RAM guard 4096, start, wait `ping` ≤ 10 min) → steps (`runStep` each, `reboot` → `rebootGuest`) → seal (`sbx-agent seal`; zero-fill `dd if=/dev/zero of=/var/tmp/zero bs=4M || true; sync; rm -f /var/tmp/zero`; `fstrim -av`; `sync`; read facts for the manifest — `dpkg-query -W`, `uname -r`, `systemctl --version`, tool versions via `verify.sh` with `SBX_VERIFY_MODE=tools` — **before** seal, then write the manifest (without `verify`) to `/etc/sbx-template/build.json` with `agent/file-write`; `agent/shutdown`, wait `stopped`) → template (`PUT config delete=ide2`, `POST .../template`, `media.remove` the ISO, `allocator.markActive`) → verify (unless `noVerify`) → registry `ready` (+ print the `sbx-admin template register` line and the YAML snippet for `topology.templateBuilds`).
  - Upload needs multipart form data: add `PveApi.upload(path, fields, file: {name, path, size})` in `@sbx/pve` (streams the file; tested with a local https server like `pve-api.test.ts`).
  - On error at any stage: registry `failed` with stage/step/tail; unless `keepOnFailure`: `stop` (if running), `DELETE /nodes/{n}/qemu/{vmid}?purge=1&destroy-unreferenced-disks=1`, `media.remove` ISO, `allocator.release(vmid)`; the base image stays.
  - CLI (`main.ts`): `preflight`, `versions <slug> [--update]`, `build <slug> --agent-package <tar> [--sbx-cli f] [--api-url u] [--tunnel-url u] [--ssh-user-ca f] [--refresh] [--keep-on-failure] [--no-verify] [--fail-step name]`, `verify <buildId>`, `list [slug]`, `show <buildId> [--field f]` (and `show --active-vmid <slug>` = newest `ready` build's `pveVmid`), `cleanup`. Logs of steps go to `build-logs/<buildId>/<step>.log` (add `build-logs/` to `.gitignore`).
  - `preflight`: token has `Datastore.AllocateTemplate` on `/storage/local`, `local` has content `import` and `iso`, node free RAM ≥ 4 GB + running pool VMs under cap, ISO tool present, Ubuntu key file present, sbx-node answers `media.list`.
  - `cleanup`: VMs tagged `sbx-tpl` that are not templates → delete (purge), `media.list` ISOs `sbx-seed-*` not used by a VM → `media.remove`, template leases whose VM is gone → release, registry rows `building` older than 2 h → `failed`.

- [ ] **Step 1: Failing tests** (fake PVE records calls): happy path call order `upload(iso)` → `POST /qemu` (params contain `tags=sbx-tpl`, `pool=sandbox`, `scsi0=local-lvm:0,import-from=local:import/sbx-ubuntu-26.04-minimal-<serial>.qcow2,discard=on,iothread=1,ssd=1`, `ide2=local:iso/sbx-seed-<id>.iso,media=cdrom`, `balloon=0`, `rng0`, no `ciuser`) → `resize` → firewall → `start` → steps in recipe order → `seal` before `shutdown` → `delete=ide2` → `/template` → `media.remove` → registry `ready`; image upload skipped when present; a failing step → VM deleted with `purge=1`, ISO removed, lease released, registry `failed` with `stage: "steps"`, `step`, `tail`; same with `keepOnFailure` → nothing deleted; `nextVersion` → `20261030.1`, then `.2`, other slug unaffected, failed builds count; the version in the VM name is `sbx-tpl-linux-20261030-1`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `template-builder: build orchestration, file registry, CLI`.

### Task 10: Template verification (`sbx-tpl verify`)

**Files:**
- Create: `apps/template-builder/src/verify.ts`
- Test: `apps/template-builder/test/verify.test.ts`

**Interfaces:**
- Consumes: `Machines` from `@sbx/pve` (built with `templateVmid = manifest.pveVmid`), `GuestIo`, `Manifest`.
- Produces:
  - `interface CheckResult { id: string; status: "PASS" | "FAIL" | "INFO"; evidence: string }`, `interface VerifyResult { ok: boolean; checks: CheckResult[]; boot: {first: BootTimes; hardRestart: BootTimes}; kvm: {available: boolean; reason?: string}; fork: {ok: boolean}; at: string }`, `BootTimes = {startToQgaMs, startToIpMs, startToAgentActiveMs?}`.
  - `parseCheckLines(stdout: string): {checks: CheckResult[]; tools: Record<string, {direct: string; login: string}>}`.
  - `checkDoctor(doctorJson: unknown, expect: {agentVersion, machineId, tunnelUrl}): CheckResult[]` — version, `units` both `active`, `identity.machine_id`, `tunnel_url` = expected with source `smbios`, `test_aids` empty.
  - `checkTools(tools, manifestTools): CheckResult[]` — direct and login output equal and equal to the manifest value; missing tool → FAIL.
  - `checkForkIdentity(a: Facts, f: Facts): CheckResult[]` — machine-id, hostname, host key fingerprints, DHCP IP all differ, and each machine-id = its smbios uuid without dashes.
  - `verifyTemplate(deps, manifest, o: {keep?: boolean}): Promise<VerifyResult>` — create A (2 vCPU/2 GB, smbios `{uuid, serial: s2SerialPayload(uuid, random 32 bytes), family: familyForTunnelUrl("wss://tunnel.verify.invalid/v1/connect")}`), start, time to `ping` and IP; wait `sbx-agent` active (≤ 60 s); pipe `verify.sh` through stdin (`bash -s` with the script followed by the expected values after a marker, or run the script from `input-data` and pass values in env files written via `input-data`, never argv); `sbx-agent doctor --json`; docker `hello-world`; **raw-disk scan**: `grep -a -c -F -f /dev/stdin /dev/sda` with patterns = the PoC update signing private key (file contents, base64 and hex forms of its 32-byte seed), the PVE token secret, the sbx-node private key body lines, the build's BS; result 0 → PASS; hard stop (`Machines.stop`) + start, time again, `hardRestart.startToQgaMs ≤ first + 3000` → PASS; snapshot A (S1 snapshot) and fork F with a new smbios, boot F, `checkForkIdentity`; KVM best-effort check; delete F, A, the snapshot (and verify traces gone, S1 `delete`). Any FAIL → `ok = false`. Under the RAM guard (A + F ≤ 4 GB).
  - The scanned secrets and BS are added to a redaction list for every log line.

- [ ] **Step 1: Failing tests:** `parseCheckLines` on a sample with PASS/FAIL/INFO and a TOOLS line; `checkDoctor` FAILs on wrong tunnel source, non-empty `test_aids`, wrong version; `checkTools` FAILs when direct ≠ login; `checkForkIdentity` FAILs when host keys are equal; the hard-restart rule (first 6000, restart 9001 → FAIL; 9000 → PASS).
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `template-builder: verification with clone, fork, raw-disk secret scan`.

### Task 11: `sbx-bench s5` boot timing

**Files:**
- Create: `apps/bench/src/s5.ts`; Modify: `apps/bench/src/main.ts`
- Test: `apps/bench/test/s5.test.ts`

**Interfaces:**
- Produces: `sbx-bench s5 --template <vmid> [--baseline 599] [--runs 5] [--keep]`; per template N runs of S1 `create` (with smbios) → start → `start_to_qga`, `start_to_ip`, `start_to_agent_ready` (host time of `sbx-agent` `ActiveEnterTimestampMonotonic` mapped through `t_ping − uptime`; `null` for a template without the agent), `systemd-analyze` (kernel/initrd/userspace), `critical_chain`, `blame_top10` → hard stop → start → `hard_stop_restart` → delete. Report median/p95/min/max (reuse `stats.ts`) and a comparison table; JSON to `bench-results/s5-<ts>.json`. RAM guard 8 GB; one VM at a time.
  - `parseSystemdAnalyze(text: string): {kernelMs, initrdMs, userspaceMs}` and `agentReadyMs(pingHostMs, uptimeS, activeEnterMonotonicUs)`.

- [ ] **Step 1: Failing tests** for `parseSystemdAnalyze` (with and without initrd, `min`/`s`/`ms` units) and `agentReadyMs`.
- [ ] **Step 2–4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `bench: s5 boot timing scenario`.

### Task 12: Real build on `pve`, registration, docs

Done by the main session (needs `pve`).

- [ ] **Step 1:** `infra/pve/setup.sh media` and `infra/pve/setup.sh node` (new `sbx-node`), then `sbx-bench preflight` and `sbx-tpl preflight` green.
- [ ] **Step 2:** `sbx-gateway dev-secrets -dir ~/.config/sbx/gateway-dev`; `infra/templates/agent-package.sh` (script added here: builds `sbx-agent` with version `0.1.0-s5.<gitsha>` or the scheme S3 uses, `sbx-release pack` with the PoC key and `~/.config/sbx/gateway-dev/ca.pem`, `sbx-release verify`).
- [ ] **Step 3:** `sbx-tpl build linux --agent-package <tar>` → `ready`, all checks PASS; fix-and-rebuild loop for failures (each fix with its test).
- [ ] **Step 4:** failure path: `--fail-step 20-docker` → nothing left (`sbx-tpl cleanup` reports nothing; S1 inventory unchanged); `--keep-on-failure` → left, `cleanup` removes.
- [ ] **Step 5:** reproducibility: second build with the same `versions.toml` and commit → same `packages` and `tools` (diff the two manifests); delete the extra build VM (keep the newest `ready` as the registered one).
- [ ] **Step 6:** `SBX_TEMPLATE_VMID=<vmid> sbx-bench s1` and `sbx-bench s5 --template <vmid> --baseline 599`; `sbx-bench cleanup`.
- [ ] **Step 7:** record the build in `deploy/compose/config/sbx.yaml` `topology.templateBuilds` (`version`, `pveVmid`, `bootTimeoutS: 300`, `agentVersion`, `hw` and `diskLayout` copied from the manifest); `packages/config` tests still pass.
- [ ] **Step 8:** spec §20 results (numbers, duration, size, deviations), roadmap status line, `apps/template-builder/README.md` (how to build, inputs, outputs).
- [ ] **Step 9:** `pnpm -r test`, `pnpm lint`, `pnpm build`, Go tests and golangci-lint for touched modules; commit and push `s5-impl`.
