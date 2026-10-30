# S9 Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sbx-tpl build windows` builds a Windows 11 sandbox template (VMID 597) from Ilia's ISO with no console work, and the guest agent runs on it as a Windows service with the S3 API (commands, ConPTY, files, ports, claim and secrets, quiesce, identity change, self-update), verified on `pve` with create and fork timings.

**Architecture:** Agent: Windows implementations behind the existing S3 seams (`supervisor.Supervisor`, `shim`, `ident.Source`/`Resetter`, `output.Store`, ports, claim secrets, quiesce `Freezer`, `update`), all in `*_windows.go` files plus a small `internal/winapi` package for Win32/NT calls that `golang.org/x/sys/windows` lacks; no cgo, cross-compiled from macOS. Builder: a second source kind `iso-install` in `apps/template-builder` (autounattend on a build ISO, steps as SYSTEM scheduled tasks started over QGA, sysprep, offline WinPE stage), recipe data in `infra/templates/{_windows,windows}`. S1/S6: fresh vTPM per machine, `sendkey`, `media.sha256`, per-OS shutdown timeout, composite quiesce hook.

**Tech Stack:** Go 1.27.3 (`golang.org/x/sys/windows`, `x/sys/windows/svc`, `svc/mgr`), TS on Node 26 (vitest, biome, zod, yaml, smol-toml), PowerShell 5.1/7 scripts, xorriso, buf.

**Spec:** `docs/specs/s9-windows.md` (+ S3 §18, S5, S1 §6, S6 §18.6). Ilia's decisions of 2026-10-29/31 below override the spec and are written into it in Task 25.

## Global Constraints

- **Windows 11 only**; Server Core is phase 2. **No hibernated pool, no `suspend --todisk`, no `resume-hint`, no `vmstatestorage`.** Create = cold clone of the template + sysprep specialize on first boot; target ≤ 5 min, good 2–3 min.
- Trust boundary is the VM. Secrets per spec §12.8 (NTFS secret files wiped on boot, identity change, `PrepareStop`, `PRESHUTDOWN`; `ClearPageFileAtShutdown=1`; no crash dumps; `secret_env` only in memory).
- No Tailscale in product code or the image; never tunnels/relays (cloudflared, ngrok, trycloudflare).
- `pve`: sandboxes only VMIDs 500–589; template only 597; never touch 598/599/9000/9001, CT 590, VMs < 500, `vmbr0`, VM 103's state; no firewall/SDN changes except the `VM.Console` privilege step; ≤ 8 GB RAM for our VMs (one Windows VM 4 GB + build VM; two Windows VMs at once is the limit); check `qm list` before starting VMs; clean up. Run by IP: `SBX_PVE_URL=https://100.64.10.2:8006`, `SBX_PVE_TLS_NAME=pve`, `SBX_NODE_SSH_HOST=100.64.10.2`.
- **Subagents never run ssh, pve, sudo or keychain commands.** All `pve` work (Tasks 26+) runs in the coordinator session.
- Tool versions: latest stable checked at implementation time (`npm view`, `go list -m -versions`, GitHub releases); virtio-win pinned to **0.1.271** with sha256.
- Linux behaviour of the agent unchanged: `go test -race ./...` on darwin and the Linux integration suite (`services/guest-agent/test/linux/run.sh`) stay green.
- Windows code in `*_windows.go` (or `//go:build windows`); every package builds with `GOOS=windows CGO_ENABLED=0` and lints with `GOOS=windows golangci-lint run`.
- CI workflows only `workflow_dispatch`.
- Code comments in English; no `Claude-Session:` trailers.

## Decisions taken here (written into spec §24 in Task 25)

1. **No pool hibernation** (Ilia): `pool`, `size_default` dropped from the recipe; spec §14, §15 p.15, §16 `hibernate`/`resume_to_agent_ready`, §18.1 p.4–6, §18.6 p.1–4 not implemented; `resume-hint` not implemented.
2. **Desktop helper deferred to S10:** autologon of `user` is implemented (identity apply), `sbx-session.exe`, `\sbx\session` and the `desktop` readiness phase are not. `readiness.required = ["identity","claim","secrets"]`. `CommandSpec.desktop = true` → `failed_precondition desktop_not_ready`.
3. **Spec to the shim over its stdin pipe, readiness as a `READY` line on its stdout** (not a file and not a first socket message): no tmpfs on Windows and no chicken-and-egg with the socket. The shim socket protocol (shimproto) is unchanged.
4. **Local admin socket** `C:\ProgramData\sbx-agent\run\admin.sock` (ACL SYSTEM + Administrators) always serves the full agent API, like `--debug-listen` on Linux. `sbx-agent exec` and `sbx-agent call` are its clients (verify and QGA recovery use them). `run\env.sock` (ACL SYSTEM, Administrators, `user`) serves only the env for `sbx-agent env --format pwsh`.
5. **Shim liveness** = named mutex `Global\sbx-shim-<id>` held by the shim; command = permanent job `Global\sbx-cmd-<id>`. `State`: mutex exists or job has active processes → `UnitActive`; job exists and empty → `UnitInactive`; else `UnitNotFound`.
6. **Tools are downloaded inside the build VM** from the official URLs in `versions.toml` and checked with `Get-FileHash` against the pinned sha256.
7. **Real-Windows agent tests:** cross-compiled `go test -c` binaries are copied into a clone over QGA and run as SYSTEM (`sbx-bench s9 agent-tests`). A `workflow_dispatch` GitHub Actions job on `windows-2025` runs the same tests (optional, not a gate).
8. **Fresh vTPM per machine**: S1 `create` from a template skips `tpmstate0` in the clone and adds `tpmstate0=<storage>:1,version=v2.0` through the PVE API; fork and snapshot clones copy it.
9. **Verify uses a fork** (S1 snapshot with QGA VSS hook → `cloneFromSnapshot`) for the identity-change check instead of editing `smbios1`; the source is shut down before the fork boots (RAM).
10. Template boot disk is `scsi0` = `base-597-disk-1` (`SLOT_ORDER` efidisk0, scsi0, tpmstate0); builder disk checks use the slot index from `diskLayout`, not `disk-0`.
11. `hostname` from claim is not applied on Windows (`hostname_applied=false`), it is exposed as `SBX_HOSTNAME`.
12. Version switching uses NTFS junctions created with `FSCTL_SET_REPARSE_POINT`; switching is delete+create guarded by `pending-update.json`.

## Review Focus

1. **Command lines with hostile arguments**: `.cmd`/`.bat` argv with `"`, `%`, `&`, `^`, newline → either exact delivery or `invalid_argument unsafe_batch_args`; pwsh `shell` ending in a comment, `exit 7`, a failing native command, a failing cmdlet, a syntax error → codes 7 / native / 1 / 1 (Task 7).
2. **Agent restarts while commands run**: shim and job survive a service restart; `Kill` works after the shim was killed (job found by name); `State` of a finished command is `UnitInactive`, never `UnitActive` forever (Task 9).
3. **Secret files held open** by a user process: `Quiesce{wipe_secret_files}` rolls back and returns `secrets_in_use`; `PrepareStop` still overwrites/deletes what it can and reports `secret_files_wiped=false` if any remain (Tasks 13, 14).
4. **Paths from the API**: `C:/x`, `c:\X\..\Y`, `\\server\s`, `\\?\C:\x`, `\\.\pipe\x`, `~\x`, relative, `C:x` (drive-relative) → normalized or `invalid_argument`; symlink/junction loops never followed on recursive delete (Task 12).
5. **Interrupted identity apply** (power loss after MachineGuid, before identity.json): next boot repeats it; fork never changes the `user` password; first boot after seal always does (Task 15).

---

## Part A. Contracts, S1 and S6

### Task 1: Proto additions

**Files:**
- Modify: `proto/sbx/agent/v1/common.proto`, `proto/sbx/agent/v1/system.proto`
- Regenerate: `libs/proto/...`, `packages/proto/src/gen/...` (`cd proto && mise exec -- buf generate`)
- Modify: `services/guest-agent/internal/errs/errs.go` (reason constants), `docs/specs/s3-guest-agent.md` §19 note

**Interfaces:**
- Produces (proto, additions only):
  - `CommandSpec.desktop` (`bool desktop = 12;`)
  - `ClaimResponse.hostname_applied` (`optional bool hostname_applied = 3;`; Linux sets `true`)
  - `QuiesceRequest.wipe_secret_files` (`optional bool wipe_secret_files = 4;`)
  - `PrepareStopResponse.secret_files_wiped` (`bool secret_files_wiped = 1;`)
  - Go reason constants in `errs`: `ReasonUnsupportedSignal = "unsupported_signal"`, `ReasonUnsafeBatchArgs = "unsafe_batch_args"`, `ReasonFileInUse = "file_in_use"`, `ReasonSecretsInUse = "secrets_in_use"`, `ReasonSecretsPending = "secrets_pending"`, `ReasonFsFreezeUnsupported = "fs_freeze_unsupported"`, `ReasonDesktopNotReady = "desktop_not_ready"` (follow the existing naming in `errs.go`).
  - Capability string `system.quiesce.wipe_secrets.v1` (constant next to the existing capability list; advertised only on Windows).

- [ ] **Step 1:** Edit the protos; run `buf lint` and `buf breaking --against '.git#branch=origin/main,subdir=proto'` — no breaking change.
- [ ] **Step 2:** `buf generate`; `GOOS=windows go build ./...` and `go test ./...` in `services/guest-agent`, `services/gateway`, `libs/tunnel`; `pnpm -r typecheck` — all pass.
- [ ] **Step 3:** Linux agent: `claim.Claim` sets `HostnameApplied: true`; `PrepareStop` handler returns `SecretFilesWiped: true` after a successful wipe. Test in `internal/claim/claim_test.go`: `TestClaimReportsHostnameApplied`, `TestPrepareStopReportsWiped`.
- [ ] **Step 4:** Commit `proto: S9 additions (desktop, hostname_applied, wipe_secret_files, secret_files_wiped)`.

### Task 2: `sbx-node` media ops and the `VM.Console` runbook step

**Files:**
- Modify: `services/node-agent/internal/ops/guards.go`, `services/node-agent/internal/ops/media.go`, `services/node-agent/internal/ops/dispatch.go`
- Create: `services/node-agent/internal/ops/media_sha256_test.go`
- Modify: `infra/pve/setup.sh` (new step `console`), `infra/pve/README.md` if it lists steps

**Interfaces:**
- Produces:
  - ISO name pattern accepts `sbx-seed-*`, `sbx-build-<id>.iso`, `sbx-offline-<id>.iso`, `sbx-virtio-win-<semver>.iso` (`^sbx-(seed|build|offline)-[a-z0-9-]{1,64}\.iso$|^sbx-virtio-win-[0-9]+\.[0-9]+\.[0-9]+\.iso$`) for `media.list`/`media.remove`.
  - `media.sha256 {name: string}` → `{name, size, sha256}`; reads only regular files directly in `IsoDir` ending in `.iso` (any name, read-only), rejects `/`, `..`, symlinks (`Lstat`), caches by (name, size, mtime) in `<StateDir>/media-sha256.json`. Errors `bad_request` / `forbidden` / `not_found`.
  - `setup.sh console`: role `SbxConsole` = `VM.Console` on `/pool/sandbox` for user `sbx@pve` and token `sbx@pve!poc`; `verify_console` checks `/access/permissions` of the token has `VM.Console` on `/pool/sandbox`; `revert_console` deletes the ACLs and the role. Listed in usage and `status`.
- [ ] **Step 1: Failing tests** `TestMediaSha256` (file → known sha256; second call served from cache when mtime/size unchanged — assert via a counter hook), `TestMediaSha256RejectsSymlink`, `TestMediaSha256RejectsTraversal`, `TestMediaRemoveAcceptsBuildIsos` (`sbx-build-20261031-1.iso`, `sbx-offline-20261031-1.iso`, `sbx-virtio-win-0.1.271.iso` removable; `Windows11_...iso` forbidden).
- [ ] **Step 2:** Run `cd services/node-agent && mise exec -- go test ./...` → FAIL.
- [ ] **Step 3:** Implement; `shellcheck infra/pve/setup.sh` clean.
- [ ] **Step 4:** Tests pass; `golangci-lint run ./...` clean.
- [ ] **Step 5:** Commit `sbx-node: media.sha256, build ISO names; setup.sh console step (VM.Console)`.

### Task 3: `@sbx/pve`: fresh vTPM, sendkey, freeze budget, QGA additions

**Files:**
- Modify: `packages/pve/src/machine.ts`, `packages/pve/src/storage/lvmthin.ts`, `packages/pve/src/storage/types.ts`, `packages/pve/src/qga.ts`
- Test: `packages/pve/test/machine.test.ts`, `packages/pve/test/lvmthin.test.ts`, `packages/pve/test/qga.test.ts`

**Interfaces:**
- Produces:
  - `StorageDriver.cloneFromTemplate(t, target, opts?: { skipSlots?: DiskSlot[] })`; `Machines.#build` from a template passes `skipSlots: ["tpmstate0"]` when the template has `tpmstate0` and then `PUT config {tpmstate0: "<storage>:1,version=<template version option>"}` (PVE allocates `vm-<vmid>-disk-<n>`; `delete` already purges it and `verifyGone` checks `vm-<vmid>-*`). Fork / `cloneFromSnapshot` unchanged (copies tpmstate0).
  - `TEMPLATE_HW_KEYS` unchanged except it must not copy `efidisk0`/`tpmstate0` raw (they come from `DiskSet`); add a test that `efidisk0` options `efitype=4m,pre-enrolled-keys=1,ms-cert=2023k` survive create.
  - `sendKey(api: PveClient, node: string, vmid: number, key: string): Promise<void>` exported from `machine.ts` (`PUT /nodes/{node}/qemu/{vmid}/sendkey {key}`).
  - `LvmThinDriver.snapshot`: freeze budget (default 10 000 ms) is measured from the return of `hook.freeze()` to the call of `hook.thaw()`; `hook.freeze()` itself has its own timeout `freezeTimeoutMs` (default 30 000) → on timeout throws `FreezeTimeoutError` (exported) after calling `hook.thaw()` best-effort; no LVs created.
  - `Qga.fsfreezeStatus(vmid): Promise<"thawed"|"frozen">`, `Qga.fileWriteWindows(vmid, path, data: Buffer): Promise<void>` — PVE has no append mode for `agent/file-write`, so each ≤ 32 KiB chunk goes as base64 text in `agent/exec` `input-data` to `powershell -NoProfile -NonInteractive -Command "<append script>" <path>` where the script decodes stdin with `[Convert]::FromBase64String([Console]::In.ReadToEnd())` and appends (first chunk creates/truncates); after the last chunk the guest prints the file's sha256, which must equal the local one. `Qga.shutdown(vmid)` (`POST agent/shutdown`).
- [ ] **Step 1: Failing tests:** `create from a three-disk template clones efidisk0 and scsi0 only and allocates a fresh tpmstate0` (fake PVE log shows `lv.snapshot` for two LVs and a `PUT config` with `tpmstate0: "local-lvm:1,version=v2.0"`); `fork copies tpmstate0`; `sendKey puts the key`; `freeze time before freeze() returns does not count against the budget` (fake hook resolves after 12 s of fake time, snapshot succeeds); `freeze() slower than freezeTimeoutMs throws FreezeTimeoutError and thaws`; `fsfreezeStatus parses "frozen"`; `fileWriteWindows sends base64 chunks and checks the sha256`.
- [ ] **Step 2:** `mise exec -- pnpm --filter @sbx/pve test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests, `typecheck`, `pnpm lint` pass; `pnpm -r test` still green (worker uses these types).
- [ ] **Step 5:** Commit `pve: fresh vTPM per machine, sendkey, freeze budget from freeze() return, QGA status/write/shutdown`.

### Task 4: Worker: Windows stop, composite quiesce hook, PrepareStop result

**Files:**
- Modify: `apps/worker/src/ops/stop.ts`, `apps/worker/src/ops/snapshot-step.ts`, `apps/worker/src/ports.ts`, `apps/worker/src/adapters/agent-connect.ts`, `apps/worker/src/adapters/pve-infra.ts`
- Test: `apps/worker/test/...` next to the existing stop/snapshot tests

**Interfaces:**
- Produces:
  - `SHUTDOWN_TIMEOUT_S = { linux: 60, windows: 120 }` chosen by `template_builds.os` of the machine (reuse the `osOf` helper pattern from `ops/fork.ts`); `ctx.timing.shutdownTimeoutS` still overrides.
  - `AgentPort.prepareStop(machineId): Promise<{ secretFilesWiped: boolean }>`; `stop.ts` records `progress.secretFilesWiped`.
  - `AgentPort.quiesceHook(machineId, leaseMs, opts?: { fs?: boolean; wipeSecretFiles?: boolean }): QuiesceHook`.
  - `NodeInfra.qgaFreezeHook(vmid): QuiesceHook` (QGA `fsfreeze-freeze`/`fsfreeze-thaw`; thaw reporting already-thawed is not an error but marks `autoThawed`).
  - `composeHooks(outer: QuiesceHook, inner: QuiesceHook): QuiesceHook` in `ops/snapshot-step.ts`: freeze = outer.freeze then inner.freeze (if inner.freeze fails → outer.thaw, rethrow); thaw = inner.thaw then outer.thaw (both attempted, first error rethrown).
  - For `os = windows` with the agent able to quiesce: `composeHooks(agent.quiesceHook(id, lease, {fs: false, wipeSecretFiles: kind === "saved"}), infra.qgaFreezeHook(vmid))`. Agent unavailable on Windows: QGA hook only, but `kind === "saved"` → fail with `agent_unavailable`. Linux unchanged.
- [ ] **Step 1: Failing tests:** stop of a Windows machine calls `infra.shutdown(vmid, 120, …)`, Linux 60; snapshot of a running Windows machine calls in order `agent.quiesce(fs=false, wipe=false)`, `qga.freeze`, `snapshot`, `qga.thaw`, `agent.thaw`; saved snapshot passes `wipe=true`; QGA freeze failure → agent thaw called, op error; Windows saved snapshot with agent unavailable → `agent_unavailable`.
- [ ] **Step 2:** `mise exec -- pnpm --filter @sbx/worker test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** worker tests/typecheck/lint pass.
- [ ] **Step 5:** Commit `worker: Windows shutdown 120 s, composite VSS quiesce hook, PrepareStop result`.

## Part B. Guest agent on Windows

Common rules for Tasks 5–17: Windows code in `*_windows.go`; Linux files untouched unless the task says so; shared logic that both OSes use is tested on darwin; Windows-only logic gets `*_windows_test.go` tests (compiled by `GOOS=windows go vet ./...`, executed in Task 27). Every task ends with: `cd services/guest-agent && mise exec -- go test -race ./... && GOOS=windows CGO_ENABLED=0 mise exec -- go build ./... && GOOS=windows mise exec -- go vet ./... && mise exec -- golangci-lint run ./... && GOOS=windows mise exec -- golangci-lint run ./...` all clean.

### Task 5: Windows layout, config defaults, errno mapping, log file

**Files:**
- Modify: `internal/paths/paths.go` → split `Default()` into `internal/paths/default_unix.go` (`!windows`, current values) and `internal/paths/default_windows.go`
- Modify: `internal/config/config.go` (per-OS defaults via `defaults_unix.go`/`defaults_windows.go`), add `PortsExcludeProcesses []string` (`[ports] exclude_processes`)
- Modify: `internal/errs/errs.go` (`FromErrno`, `IsNoSpace` via `errors.Is` + `errs_windows.go` table)
- Modify: `internal/logx/logx.go` + create `internal/logx/rotate.go` (portable rotating file writer)
- Create: `internal/winapi/` (package doc + lazy procs, filled by later tasks)
- Tests: `internal/paths/default_windows_test.go`, `internal/errs/errs_windows_test.go`, `internal/logx/rotate_test.go`, `internal/config/config_test.go`

**Interfaces:**
- Produces:
  - `paths.Layout` new fields: `LogDir`, `EarlyFile` (`run\early.json`), `AdminSocket` (`run\admin.sock`), `EnvSocket` (`run\env.sock`), `SSHUserCATemplate` (`C:\ProgramData\sbx-agent\ssh-user-ca.pub`), `SysprepUnattend` (`C:\Windows\System32\Sysprep\sbx-unattend.xml`), `QuiesceHooksDir`. Windows values per spec §12.1: lib `C:\Program Files\sbx-agent` (`versions\`, `current`, `previous`), etc `C:\ProgramData\sbx-agent`, state `C:\ProgramData\sbx-agent\state`, run `C:\ProgramData\sbx-agent\run`, logs `C:\ProgramData\sbx-agent\logs`, secrets `C:\ProgramData\sbx\secrets` (`files\`), ssh `C:\ProgramData\ssh`, shim sockets `run\cmd\<id>.sock`. Linux-only fields (`SystemdUnitDir`, `MachineIDFile`, `HostsFile`, …) are empty on Windows; code that uses them is not reached there. `Rooted()` accepts Windows absolute paths (`filepath.IsAbs`).
  - Windows config defaults: `ReadinessRequired = [identity claim secrets]`, `DockerEnabled = false`, `DefaultUser = "user"`, `PortsExclude = [22 135]`, `PortsExcludeProcesses = ["System","lsass.exe","wininit.exe","services.exe","svchost.exe","spoolsv.exe"]`, `IdentityDir = ""`.
  - `errs.FromErrno` maps by `errors.Is(err, fs.ErrNotExist|fs.ErrExist|fs.ErrPermission)` first, then OS tables; Windows table: `ERROR_DIR_NOT_EMPTY`→ same as ENOTEMPTY, `ERROR_DIRECTORY`→ENOTDIR, `ERROR_DISK_FULL`/`ERROR_HANDLE_DISK_FULL`→no space, `ERROR_NOT_SAME_DEVICE`→EXDEV, `ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION`/`ERROR_USER_MAPPED_FILE` → `failed_precondition file_in_use` with `retryable: true`.
  - `logx.NewRotatingFile(dir, name string, maxBytes int64, keep int) (io.WriteCloser, error)`; Windows `run` logs to `LogDir\agent.log`, 10 × 10 MiB. `logx.Tail(dir, name string, n int) ([]string, error)` for `sbx-agent logs -n`.
- [ ] **Step 1: Failing tests:** `TestRotatingFileRotatesAtLimit` (writes > max → `agent.log.1` exists, ≤ keep files), `TestTailAcrossRotation`, `TestWindowsDefaultLayout` (exact paths above), `TestFromErrnoWindowsSharingViolation` (→ file_in_use, retryable), `TestConfigDefaultsWindows`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Common check passes.
- [ ] **Step 5:** Commit `guest-agent: Windows layout, config defaults, errno mapping, rotating log`.

### Task 6: Identity source: SMBIOS, boot id

**Files:**
- Create: `internal/ident/smbios.go` (portable parser), `internal/ident/smbios_test.go`, `internal/ident/source_windows.go`, `internal/winapi/firmware_windows.go`
- Modify: `internal/ident/source_other.go` → build tag `!linux && !windows`

**Interfaces:**
- Produces:
  - `ParseSMBIOSType1(raw []byte) (uuid, serial, family string, err error)` — `raw` is the `RawSMBIOSData` returned by `GetSystemFirmwareTable('RSMB',0)` (8-byte header `Used20CallingMethod, MajorVersion, MinorVersion, DmiRevision, Length` then the table). UUID bytes 0–3, 4–5, 6–7 are little-endian (SMBIOS ≥ 2.6) and formatted lower-case canonical, matching Linux `product_uuid` of the same VM.
  - `type FirmwareSource struct{ Read func() ([]byte, error); BootCount func() (uint32, error) }` implements `Source` on Windows: `Raw{Serial, UUID, Family, BootID}` where `BootID = uuid.NewSHA1(<machine uuid>, []byte(fmt.Sprint(bootCount))).String()`, boot count = `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters` `BootId` (DWORD). `NewFirmwareSource()` wires the real calls. vmgenid not read (empty).
- [ ] **Step 1: Failing tests** with a captured byte fixture (build one by hand: header + type 1 with strings `sbx1:...`, family `sbxt1:wss://...`, and a type 127 end marker; also a table where type 0 and 3 precede type 1): `TestParseSMBIOSType1`, `TestParseSMBIOSType1UUIDByteOrder` (bytes `33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff` → `00112233-4455-6677-8899-aabbccddeeff`), `TestParseSMBIOSMissingType1`, `TestParseSMBIOSTruncated` (no panic, error), `TestBootIDStableForSameCount`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows identity source (SMBIOS RSMB, BootId)`.

### Task 7: Users, tokens, env, argv and the pwsh epilogue

**Files:**
- Create: `internal/winapi/{lsa,logon,netuser,profile}_windows.go`
- Create: `internal/wincmd/` (portable: `cmdline.go`, `batch.go`, `pwsh.go`, `envmerge.go` + tests) — pure string logic, tested on darwin
- Modify: `internal/process/users_windows.go`, `internal/process/start.go` (shell + cwd per OS through small helpers `shellArgv`/`resolveCwd` in `start_unix.go`/`start_windows.go`)
- Create: `internal/claim/envbuilder_windows.go` (base env from `CreateEnvironmentBlock`), keep `envbuilder.go` shared parts

**Interfaces:**
- Produces:
  - `winapi.LsaRetrieve(name string) ([]byte, error)`, `winapi.LsaStore(name string, data []byte) error` (`LsaOpenPolicy(POLICY_CREATE_SECRET|POLICY_GET_PRIVATE_INFORMATION)` + `LsaStorePrivateData`/`LsaRetrievePrivateData`; empty data deletes).
  - `winapi.LogonUserToken(user, password string) (windows.Token, error)` (`LogonUserW(..., ".", LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT)` → `TokenLinkedToken` if elevation type is limited) — the elevated token.
  - `winapi.LoadProfile(t windows.Token, user string) (unload func(), err error)`, `winapi.SetUserPassword(user, password string) error` (`NetUserSetInfo` level 1003).
  - `process.User` gains `Windows *WinUser` (`{Account string; System bool}`); `LookupUser("user")` → profile dir from `HKLM\...\ProfileList` or `C:\Users\user`, `Shell` = `C:\Program Files\PowerShell\7\pwsh.exe`; `LookupUser("SYSTEM")` and `"root"` → `System: true`, home `C:\Windows\System32\config\systemprofile`; any other name → `ErrUserNotFound`.
  - `wincmd.ComposeArgs(args []string) string` (MSVCRT rules; equals `windows.ComposeCommandLine`).
  - `wincmd.BatchCommandLine(script string, args []string) (string, error)` → `cmd.exe /d /s /c ""<script>" <args>"`; returns `ErrUnsafeBatchArgs` for any arg containing `%`, `!`, `"`, `\r`, `\n` or `^`, or a trailing backslash; args with spaces or `&|<>()` are double-quoted.
  - `wincmd.ResolveProgram(name string, env []string, cwd string) (path string, isBatch bool, err error)` — `PATH` + `PATHEXT` from `env` (case-insensitive keys), absolute/relative paths with or without extension.
  - `wincmd.PwshArgv(pwsh, script string, login bool, dir string) (argv []string, scriptFile string)` → `[pwsh, -NoLogo, -NonInteractive, (-NoProfile if !login), -EncodedCommand, <base64 UTF-16LE of wrapped>]`; when the command line would exceed 32 000 chars, writes nothing itself but returns `-File <dir>\script.ps1` and the wrapped script text for the caller to write. Wrapped script = `$global:LASTEXITCODE = 0` + `\n` + script + `\n` + `$__sbx_ok = $?; if ($__sbx_ok) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }`.
  - `wincmd.MergeEnv(layers ...[]string) []string` — case-insensitive keys, later wins, the first-seen spelling of the key kept (`Path`).
  - Env layers on Windows (spec §12.7): `CreateEnvironmentBlock(token, false)`, then platform (`SBX=1`, `SBX_SANDBOX_ID`, `SBX_PORT_DOMAIN`, `SBX_HOSTNAME`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, `SBX_ENV_APPLIED=1`, `TERM=xterm-256color` for PTY), claim env, secret env, spec env.
- [ ] **Step 1: Failing tests (darwin):** `TestComposeArgs` (table incl. empty arg, embedded quotes, trailing backslashes), `TestBatchCommandLineSafe`, `TestBatchCommandLineRejects` (each forbidden char → `ErrUnsafeBatchArgs`), `TestResolveProgramPathext` (fake dir with `npm.cmd` → batch), `TestPwshArgvEncoded` (decode base64 UTF-16LE → exact wrapped text, ends with the epilogue on its own line), `TestPwshArgvTooLong` (→ `-File`), `TestMergeEnvCaseInsensitive` (`PATH` + `Path` → one key `Path`, value from the later layer). Windows: `TestLookupUserSystemAlias` (`root` → System).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows users and tokens, env layers, argv/batch rules, pwsh exit-code epilogue`.

### Task 8: Job objects, ConPTY and process start primitives

**Files:**
- Create: `internal/winproc/{job,start,conpty,console}_windows.go`, `internal/winapi/nt_windows.go`, tests `internal/winproc/*_windows_test.go`

**Interfaces:**
- Produces:
  - `winproc.CreatePermanentJob(name string) (*Job, error)` — enables `SeCreatePermanentPrivilege`, `NtCreateJobObject(JOB_OBJECT_ALL_ACCESS, OBJECT_ATTRIBUTES{Name: \BaseNamedObjects\Global\<name>... use "\\BaseNamedObjects\\" + name with name "sbx-cmd-<id>", Attributes: OBJ_PERMANENT})`; returns `ErrJobExists` on `STATUS_OBJECT_NAME_COLLISION`. No `KILL_ON_JOB_CLOSE`, no `BREAKAWAY_OK`; associates an IO completion port for `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`.
  - `winproc.OpenJob(name string) (*Job, error)` (`ErrJobNotFound`); `(*Job).ActiveProcesses() (uint32, error)`, `Terminate(code uint32) error`, `MakeTemporary() error` (`NtMakeTemporaryObject`), `WaitEmpty(ctx) error`, `Close() error`.
  - `winproc.StartOptions{Argv0Path, CommandLine string; Env []string; Dir string; Token windows.Token /*0 = own*/; Job *Job; Stdin, Stdout, Stderr windows.Handle; PseudoConsole windows.Handle; NewProcessGroup bool}`; `winproc.Start(o StartOptions) (*Process, error)` — `CreateProcessAsUserW`/`CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED` (+ `CREATE_NO_WINDOW` without PTY, + `CREATE_NEW_PROCESS_GROUP`), attribute list `PROC_THREAD_ATTRIBUTE_JOB_LIST` (0x2000D), `HANDLE_LIST`, `PSEUDOCONSOLE`; resume after creation. `(*Process).Pid()`, `Wait(ctx) (exitCode uint32, err error)`, `Close()`.
  - `winproc.NewPseudoConsole(cols, rows uint16) (*PseudoConsole, error)` with `In io.WriteCloser`, `Out io.ReadCloser`, `Resize(cols, rows)`, `Close()`.
  - `winproc.CtrlBreak(pid uint32) error` (AttachConsole(pid) → `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)` → FreeConsole; serialized by a mutex).
  - `winproc.ShimMutex(id string) (release func(), err error)` and `winproc.ShimAlive(id string) bool` (`Global\sbx-shim-<id>`).
- [ ] **Step 1: Failing Windows tests** (run in Task 27): `TestPermanentJobSurvivesHandleClose` (create, close, `OpenJob` succeeds, `MakeTemporary` + close → `ErrJobNotFound`), `TestJobCollision`, `TestStartInJobCountsProcesses` (`cmd /c ping -n 3 127.0.0.1` → ActiveProcesses ≥ 1, then 0), `TestTerminateJobKillsGrandchildren`, `TestConPTYEcho` (`cmd /c echo hi` → output contains `hi`), `TestCtrlBreakStopsPing`.
- [ ] **Step 2:** `GOOS=windows go vet ./internal/winproc/` compiles the tests.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Common check.
- [ ] **Step 5:** Commit `guest-agent: Windows job objects (OBJ_PERMANENT), process start, ConPTY`.

### Task 9: Windows shim and supervisor

**Files:**
- Create: `internal/shim/shim_windows.go`, `internal/shim/server_windows.go`, `internal/shim/loop_windows.go`, `internal/shim/*_windows_test.go`
- Create: `internal/supervisor/windows.go` (`//go:build windows`), `internal/supervisor/supervisor.go` (add `SpecLauncher`)
- Modify: `internal/shim/shim_other.go` → `!linux && !windows`; `internal/supervisor/systemd_other.go` unchanged; `internal/shim/spec.go` (`User string`, `Desktop bool` fields; `ReadSpecFrom(r io.Reader)`)
- Modify: `internal/process/start.go` (use `SpecLauncher` when the supervisor implements it), `internal/process/control.go` (per-OS signal support check)

**Interfaces:**
- Consumes: Task 7 (`wincmd`, `winapi.LogonUserToken`, `LsaRetrieve("L$sbx_user")`), Task 8 (`winproc`).
- Produces:
  - `supervisor.SpecLauncher interface { LaunchSpec(ctx context.Context, id, shimPath string, extraArgs []string, spec []byte) error }`; `process` writes no `CmdSpec` file when the supervisor implements it.
  - `supervisor.NewWindows(l paths.Layout) (Supervisor, error)`: `LaunchSpec` starts `shimPath shim --id <id>` with `CREATE_BREAKAWAY_FROM_JOB|DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` (no console), writes spec JSON to its stdin and closes it, waits for a line `READY` (→ nil) or `FAIL <text>` / EOF (→ error) on its stdout until ctx ends; `ErrUnitExists` when `ShimAlive(id)` or the permanent job exists before launch. `State` per Decision 5. `KillCgroup` = `OpenJob` + `Terminate(1)` (`ErrUnitNotFound` if no job). `Stop` = terminate + `MakeTemporary`. `StartWatchdog(lease, argv)` starts argv detached in a non-permanent job `Global\sbx-wd-<lease>` whose handle the supervisor keeps; `StopWatchdog` terminates it (missing = nil).
  - Shim on Windows (`shim.Run(args, stderr)`, flags `--id`, `--layout-root`): reads spec from stdin; takes the shim mutex; `CreatePermanentJob("sbx-cmd-"+id)` (exists → exit 3, "already started"); token: `System` → own, else `LogonUserToken(spec.User, LsaRetrieve("L$sbx_user"))` + `LoadProfile`; opens `stdout`/`stderr`/`pty` files with share read|write|delete and marks them sparse (Task 10 `output.MarkSparse`); writes `shim.json` launching → starts the process in the job (PTY: ConPTY sized from spec; env adds `TERM`) → `shim.json` running → listens on `ShimSocket(id)` (AF_UNIX, dir ACL SYSTEM-only) → prints `READY`. Then the shimproto loop: `status`, `input` (pipe or ConPTY input; seq dedup via `seqtable`), `resize`, `kill` (`SIGTERM` = CtrlBreak / `0x03` to ConPTY, after grace `Terminate`), `signal` (`SIGINT`/`SIGTERM` as kill's first stage, `SIGHUP` PTY-only = ConPTY close, `SIGKILL` = Terminate; others `unsupported_signal`). Exit: main process exit code (uint32 → `int32(code)`), `KILLED`/code 1 after Terminate; waits until the job is empty and the pipes hit EOF (ConPTY: `ClosePseudoConsole` then read to EOF) unless `KillLeftovers` (then Terminate). Writes `exit.json`, sends `exited`, `MakeTemporary` on the job if no leftovers, releases the mutex. Timeout handling as on Linux.
  - `process`: unsupported signals for the OS → `invalid_argument unsupported_signal` before reaching the shim; `SIGHUP` without PTY on Windows → same.
- [ ] **Step 1: Failing tests:** darwin: `TestStartUsesSpecLauncher` (fake supervisor implementing `SpecLauncher` receives the spec bytes, no file under `CmdSpec`), `TestUnsupportedSignalWindowsTable` (pure function `signalSupported(goos string, sig int, pty bool) error`). Windows: `TestShimRunsAndWritesExit` (`cmd /c exit 3` → exit.json code 3), `TestShimSurvivesSupervisorRestart` (drop the supervisor, new `NewWindows` sees `UnitActive`, then `UnitInactive` after exit), `TestKillAfterShimDied` (kill shim pid with TerminateProcess, `KillCgroup` ends the command), `TestShimPTYResize`, `TestRepeatedLaunchIsUnitExists`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows shim (job, ConPTY, pipes) and supervisor`.

### Task 10: Sparse output store and disk stats

**Files:** Create `internal/output/store_windows.go`, `internal/output/store_windows_test.go`; modify `store_other.go` → `!linux && !windows`.

**Interfaces:**
- Produces: `output.Default()` on Windows = `sparseStore` using `FSCTL_QUERY_ALLOCATED_RANGES` for `AvailableFrom` (start of the first allocated range, or size if none) and `FSCTL_SET_ZERO_DATA` for `PunchFront` aligned down to 64 KiB; `output.MarkSparse(f *os.File) error` (`FSCTL_SET_SPARSE`); `DefaultStatfs(path)` = `GetDiskFreeSpaceExW`.
- [ ] **Step 1: Failing Windows tests:** `TestPunchFrontAligns64K` (write 300 KiB, punch to 200 KiB → AvailableFrom = 192 KiB), `TestAvailableFromUnpunched` = 0, `TestStatfs`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: NTFS sparse output store`.

### Task 11: Port scanner

**Files:** Create `internal/ports/scan_windows.go`, `internal/ports/table_windows.go`, `internal/ports/filter.go` (portable), tests; modify `scan_other.go` tag; fix `dial.go` refused check with `errors.Is(err, syscall.ECONNREFUSED) || isConnRefusedOS(err)` (`WSAECONNREFUSED` on Windows).

**Interfaces:**
- Produces: a Windows `listenerSource` that returns `[]Listener{Port, Addr, Pid, Process, User}` from `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` for AF_INET and AF_INET6, process name via `QueryFullProcessImageNameW` (base name), user via the process token; `filterListeners(ls []Listener, excludePorts []uint32, excludeProcs []string) []Listener` (case-insensitive process names) used on both OSes (Linux passes no processes). `Scanner.Run` polls every 1 s on Windows.
- [ ] **Step 1: Failing tests:** darwin `TestFilterListenersByProcess`; Windows `TestScanSeesOwnListener` (listen on 127.0.0.1:0, appears with own pid).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows port scanner`.

### Task 12: Files on NTFS

**Files:** Create `internal/files/resolve_windows.go`, `internal/files/info_windows.go` (mode/owner synthesis, chmod/chown), `internal/files/write_windows.go` (replace via `MoveFileExW`), tests; modify `internal/files/owner_windows.go`, `internal/files/resolve.go` (per-OS hook).

**Interfaces:**
- Produces:
  - `files.Resolve` on Windows: accepts `C:\…`, `C:/…` (any drive letter, case-insensitive), `~` / `~\x` / `~/x` = home of the request user, relative = relative to home; rejects `\\server\…`, `\\?\…`, `\\.\…`, `C:x`, empty → `invalid_argument`; returns `filepath.Clean` output with backslashes.
  - `FileInfo` on Windows: mode dir `0755`, file `0644`, read-only attribute clears write bits, `+0111` when the extension is in `PATHEXT`; `owner` = account name of the owner SID (`user`, `SYSTEM`, `Administrators`), `group` empty, uid/gid 0; ETag from volume serial + file index + size + mtime; symlinks and junctions are `SYMLINK` with target.
  - `Chmod` uses only the owner write bit (read-only attribute); `owner` changes the owner (`SetNamedSecurityInfo`), `group` ignored.
  - Atomic write: temp in the same dir → `FlushFileBuffers` → `MoveFileExW(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)`; sharing violations → `failed_precondition file_in_use` (Task 5 mapping) in write, move and remove.
  - Files created by the agent get the request user as owner.
- [ ] **Step 1: Failing tests:** darwin (pure helpers): `TestWindowsPathRules` table (Review Focus 4), `TestSynthMode`. Windows: `TestWriteWhileOpenWithoutShareIsFileInUse`, `TestRecursiveRemoveDoesNotFollowJunction`, `TestOwnerName`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: files on NTFS (path rules, synthesized mode/owner, file_in_use)`.

### Task 13: Secrets and claim on Windows

**Files:** Create `internal/claim/secrets_windows.go` (store), `internal/claim/acl_windows.go`; modify `internal/claim/secrets.go` (split ownership/persist hooks into `secrets_unix.go` / `secrets_windows.go`), `internal/claim/claim.go` (`PrepareStop` returns wiped flag; pending-secrets wait), `internal/system/service.go` (PrepareStop response).

**Interfaces:**
- Produces:
  - Windows secret store: `SecretFilesDir` = `C:\ProgramData\sbx\secrets\files`, dir and files ACL = SYSTEM full + `user` read (mode with any write bit → read/write), `FILE_ATTRIBUTE_TEMPORARY`; `link_path` = file symlink. `secret_env` is never written to disk on Windows: `SecretsEnvFile` not created, `SecretsStateFile` stores file metas only (`Env` omitted), `Start` sets `secrets: pending` whenever the stored claim has a non-empty `SecretsDigest`.
  - `wipeFile(path string) error`: open for write with `FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE`, overwrite with zeros to its size, `FlushFileBuffers`, close, delete; sharing violation → `ErrSecretInUse`.
  - `(*Manager).WipeSecretFiles() (wiped bool, err error)` (used by PrepareStop, PRESHUTDOWN, quiesce, `early`); `PrepareStop(ctx) (wiped bool, err error)`; system service returns `PrepareStopResponse{SecretFilesWiped: wiped}`.
  - `(*Manager).RestoreSecretFiles() error` (from the in-memory set; for quiesce thaw).
  - `WipeSecretsDir(l paths.Layout) error` — standalone (no Manager) for `early` (Task 15).
  - `Start` of a command while `secrets: pending` with a non-empty digest waits up to 30 s for `UpdateSecrets`, then `unavailable secrets_pending` (retryable) — on both OSes (spec §18.3 p.5).
  - Claim on Windows: hostname not applied, `hostname_applied=false`, `SBX_HOSTNAME` in platform env.
- [ ] **Step 1: Failing tests:** darwin: `TestStartWaitsForPendingSecrets` (UpdateSecrets after 100 ms → command starts; none within 30 s fake clock → `secrets_pending`), `TestSecretEnvNotPersistedWhenDisabled` (store option `PersistEnv=false`: state file has no env, restart → pending). Windows: `TestWipeFileZeroesAndDeletes`, `TestWipeOpenFileIsInUse`, `TestSecretFileACL` (user can read, cannot write for 0400).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows secret store, memory-only secret env, PrepareStop wipe result`.

### Task 14: Quiesce on Windows

**Files:** Create `internal/quiesce/freeze_windows.go`, `internal/quiesce/hooks_windows.go`; modify `internal/quiesce/manager.go` (`wipe_secret_files`), `internal/quiesce/freeze_other.go` tag, `internal/system/service.go` (request field, capability).

**Interfaces:**
- Consumes: Task 13 `WipeSecretFiles`/`RestoreSecretFiles` (injected as `Options.Secrets interface{ WipeSecretFiles() (bool, error); RestoreSecretFiles() error }`).
- Produces: `Quiesce(ctx, leaseMs, docker, fs, wipeSecretFiles bool)`; on Windows `fs=true` → `failed_precondition fs_freeze_unsupported`, `docker` ignored; hooks are `QuiesceHooksDir\*.ps1` run as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <hook> freeze|thaw`, 5 s each; `wipeSecretFiles` → wipe before hooks finish; in-use → restore the wiped ones, `failed_precondition secrets_in_use`; `Thaw` and lease expiry restore the files. The lease watchdog on Windows is the supervisor's watchdog process (Task 9) running `sbx-agent quiesce-watchdog --lease <id>`, which only restores secret files and drops the lease (no FS). Capabilities on Windows add `system.quiesce.wipe_secrets.v1`.
- [ ] **Step 1: Failing tests (darwin, fakes):** `TestQuiesceWipeSecretFilesThenThawRestores`, `TestQuiesceSecretsInUseRollsBack`, `TestQuiesceFsUnsupportedOnWindows` (manager option `FsFreeze=false`).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows quiesce (hooks, wipe secret files)`.

### Task 15: Identity apply, `early`, seal on Windows

**Files:** Create `internal/ident/apply_windows.go`, `internal/ident/reset_windows.go`, `internal/ident/early.go` (portable orchestration) + `early_windows.go`, `internal/ident/seal_windows.go`, `internal/winapi/{computername,shutdown,setup}_windows.go`; modify `cmd/sbx-agent/identity.go` (`--specialize`, `early`).

**Interfaces:**
- Produces:
  - `ident.ApplyWindows(ctx, l paths.Layout, id Identity, r WinResetter, mode ApplyMode) (changed, rebootNeeded bool, err error)`, `ApplyMode` = `ModeSpecialize | ModeEarly | ModeService`. Steps per spec §11.2: wipe agent state and secrets dir; `MachineGuid` = machine id; delete `C:\ProgramData\ssh\ssh_host_*`, run `C:\Windows\System32\OpenSSH\ssh-keygen.exe -A` (cwd `C:\ProgramData\ssh`), fix ACLs (owner SYSTEM, SYSTEM+Administrators full only); `SetComputerNameExW(ComputerNamePhysicalDnsHostname, "SBX"+upper(last 12 hex))`; **only when identity.json is absent**: new 32-char random password → `SetUserPassword("user")`, `LsaStore("L$sbx_user")`, `LsaStore("DefaultPassword")`, Winlogon `AutoAdminLogon=1`, `DefaultUserName=user`, `DefaultDomainName=.`; delete `SysprepUnattend`; copy `SSHUserCATemplate` → `C:\ProgramData\ssh\sbx_user_ca.pub` with sshd ACL; write identity.json (`ResetPending`, flushed). `rebootNeeded` = active name (`GetComputerNameExW(ComputerNamePhysicalDnsHostname)` current) ≠ new name and mode ≠ specialize.
  - `WinResetter interface { SetMachineGUID(string) error; RegenerateHostKeys() error; SetComputerName(string) error; ActiveComputerName() (string, error); NewUserPassword(user string) error; Reboot(reason string) error }` with a fake for darwin tests.
  - `ident.SetupInProgress() bool` (Windows: `ImageState` ≠ `IMAGE_STATE_COMPLETE`; elsewhere false).
  - `ident.Early(ctx, l, src Source, r WinResetter, wipe func() error) error`: if `SetupInProgress()` → return nil; apply (`ModeEarly`); wipe secrets dir; clean `run\` (except sockets of live shims… simply leave `run\cmd`) when the boot id changed; write `EarlyFile {bootId}`; reboot if needed (identity.json was already saved, so the next boot finds no change). Global named mutex `Global\sbx-identity`.
  - `sbx-agent identity apply --specialize` (no reboot, no wait for setup); `sbx-agent early`.
  - `ident.Seal` on Windows: stop `sbx-agent` and `sshd` services, wipe state and run dirs, host keys, secrets dir, restore template `sbx_user_ca.pub` from `SSHUserCATemplate`, empty env.
- [ ] **Step 1: Failing tests (darwin with fake resetter, tagged to compile the Windows-free core):** `TestApplyFirstBootChangesPassword`, `TestApplyForkKeepsPassword` (identity.json present with other machine id → no `NewUserPassword`), `TestApplySameIDNoop`, `TestApplyRebootOnlyOutsideSpecialize`, `TestApplyInterruptedRepeats` (resetter fails after `SetMachineGUID` → identity.json unchanged → next call re-runs all steps), `TestComputerNameFromMachineID` (`…-0123456789ab` → `SBX0123456789AB`).
- [ ] **Step 2–4:** FAIL → implement (core in portable `apply_win_core.go` taking the resetter + layout so darwin tests run it) → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows identity apply, early, seal`.

### Task 16: Service, install, self-update, package

**Files:** Create `cmd/sbx-agent/service_windows.go`, `cmd/sbx-agent/run_windows.go` (and move the Linux `runAgent` to `run_linux.go`/`run_other.go` as needed), `internal/update/{links,service}_windows.go`, `internal/update/{links,service}_unix.go`, `internal/update/junction_windows.go`; modify `internal/update/{manifest,install,rollback,apply,versions}.go`, `cmd/sbx-release/main.go`, `infra/templates/agent-package.sh` (`--os windows`), `services/guest-agent/README.md`.

**Interfaces:**
- Produces:
  - `update.BinaryName` = `sbx-agent.exe` on Windows.
  - `update.ServiceManager interface { Start(name string) error; Restart(name string) error; ResetFailed(name string) error }`: `SystemctlManager` (current behaviour) and `SCMManager` (Windows; `ResetFailed` no-op). `Rollback` and `Install` take it instead of the `systemctl` func.
  - Links: Windows `pointLink(link, target)` = remove junction + create junction (`FSCTL_SET_REPARSE_POINT`, `IO_REPARSE_TAG_MOUNT_POINT`); `LinkVersion` reads it with `os.Readlink`. No `/usr/local/bin` link on Windows; `current` is added to the system `Path` by `install-package` once.
  - `install-package` on Windows: version dir, junctions, `agent.toml` with `--write-config`, service `sbx-agent` (LocalSystem, `SERVICE_AUTO_START`, ImagePath `"C:\Program Files\sbx-agent\current\sbx-agent.exe" run`, preshutdown timeout 15 000 ms, failure actions restart 1 s / restart 1 s / run command `"C:\Program Files\sbx-agent\previous\sbx-agent.exe" rollback` (falls back to `current` if no previous), reset period 120 s, `FailureActionsOnNonCrashFailures=1`). `--no-activate`, `--no-units` (= no service) keep their meaning.
  - `run` on Windows: when `svc.IsWindowsService()` → `svc.Run("sbx-agent", handler)`; `SdNotify("READY=1")` → `SERVICE_RUNNING` with accepts `Stop|PreShutdown`; `PRESHUTDOWN` → wipe secret files + flush store (≤ 15 s), then cancel; process priority `ABOVE_NORMAL_PRIORITY_CLASS`; logs to the rotating file. Self-update exit = `os.Exit(75)` without reporting `SERVICE_STOPPED`, so SCM failure actions restart it. Outside SCM, runs in the console (tests).
  - `sbx-release pack --os windows --binary sbx-agent.exe` (no units); `install` refuses a package whose `os` ≠ `runtime.GOOS` (existing check).
  - `doctor` on Windows: service state via SCM, failure actions configured, `early.json` of the current boot present, identity, tunnel URL source.
- [ ] **Step 1: Failing tests:** darwin: `TestRollbackUsesServiceManager` (fake records `ResetFailed`, `Start`), `TestPackWindowsPackage` (sbx-release packs and verifies a Windows tar with `sbx-agent.exe`). Windows: `TestJunctionSwitch` (current → v1 → v2, `LinkVersion` = v2), `TestInstallCreatesServiceConfig` (run against a temp service name `sbx-agent-test-<rand>`, delete after).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `guest-agent: Windows service, install-package, junction updates, Windows packages`.

### Task 17: Agent wiring and new CLI subcommands

**Files:** Modify `cmd/sbx-agent/main.go`, `cmd/sbx-agent/identity.go` (`defaultDeps` per OS), `internal/agent/{agent,startup}.go`; create `internal/agent/startup_windows.go`, `internal/agent/localsock.go` (admin/env sockets), `cmd/sbx-agent/{exec,call,envcmd,logs}.go`.

**Interfaces:**
- Consumes: Tasks 5–16.
- Produces:
  - Windows `defaultDeps`: `ident.NewFirmwareSource()`, Windows resetter, `supervisor.NewWindows`, Windows freezer, `LookupUser`, secrets store, `output.DefaultStatfs`, `SCMManager`.
  - Startup on Windows before the S3 sequence: wait while `ident.SetupInProgress()` (poll 5 s; nothing else runs); wait up to 60 s for `EarlyFile` with the current boot id, else run `ident.Early` in-process (log a warning; reboot if needed); `Start`/`Claim`/`UpdateSecrets` return `unavailable identity_not_ready` until then; after identity is ready, start the `sshd` service (SCM, ignore "already running").
  - Admin socket (Decision 4) serving the same Connect handlers as `--debug-listen`; ACL on the socket file set right after `Listen`.
  - `sbx-agent exec [--user <u>] [--pty] [--cwd <d>] [--shell <script>] -- <argv…>` → `Process/Start` over the admin socket, streams stdout/stderr, exits with the command's code (killed → 137 on Linux, 1 on Windows).
  - `sbx-agent call <Service/Method> [<json>]` → unary Connect JSON over the admin socket, prints the JSON response (verify uses `System/Claim`, `System/PrepareStop`, `System/Info`, `System/Quiesce`, `System/Thaw`).
  - `sbx-agent env --format pwsh|cmd|sh` → `$env:K = 'v'` lines (single quotes doubled) from `env.sock`.
  - `sbx-agent logs [-n 500]` (Task 5 `Tail`).
  - `selftest --pty` (Windows: ConPTY session running `pwsh -NoProfile -Command "Read-Host"`, writes a line, expects it echoed).
- [ ] **Step 1: Failing tests (darwin):** `TestExecSubcommandExitCode` and `TestCallSubcommand` against an agent started by the test harness with an admin socket in a temp dir; `TestEnvFormatPwshQuoting` (`a'b` → `'a''b'`).
- [ ] **Step 2–4:** FAIL → implement → common check, plus `test/linux/run.sh` green (Linux unchanged).
- [ ] **Step 5:** Commit `guest-agent: Windows wiring, admin socket, exec/call/env/logs subcommands`.

## Part C. Builder

Common check for Tasks 18–24: `mise exec -- pnpm --filter @sbx/template-builder test && pnpm --filter @sbx/template-builder typecheck && pnpm lint`.

### Task 18: Windows recipe and versions

**Files:** Modify `apps/template-builder/src/recipe.ts`, `apps/template-builder/src/versions-update.ts` (split: `versions-update-linux.ts`, `versions-update-windows.ts`); create `infra/templates/windows/template.yaml`, `infra/templates/windows/versions.toml`, `infra/templates/_windows/keys.toml`; tests `test/recipe.test.ts`, `test/versions-update-windows.test.ts`, fixture `test/fixtures/templates/windows-fixture/`.

**Interfaces:**
- Produces:
  - `Recipe.source` = `CloudImageSource | IsoInstallSource` with `IsoInstallSource = { kind: "iso-install"; family: "client"|"server"; drivers: "w11"|"2k25"; locale: { formats; keyboard; timezone } }`; `Recipe.seal: "sbx-agent"|"sysprep"`; `Recipe.offline: string[]` (allowed `defender-off`, `waasmedic-off`); `Recipe.options: { vsBuildtools: boolean }`; `Recipe.installTimeoutS` (default 2400); `Recipe.shared?: string` (`_windows`, steps and files looked up in recipe dir then shared dir); `Recipe.hw` accepts nested `efidisk0`/`tpmstate0` objects → `Recipe.firmwareDisks: { efidisk0?: Record<string,string>; tpmstate0?: Record<string,string> }`; `hw.machine: "pinned"` allowed. Steps resolve to `steps/<n>.ps1` for `os: windows`; built-in steps `reboot`, `network-up`.
  - `WindowsVersions = { iso: {file, sha256, edition, productKey: string|null, channel, uiLanguage}, virtioWin: {version, sha256}, tools: Record<"pwsh"|"git"|"node"|"python"|"go"|"bun"|"uv"|"gh", {version, sha256, url}>, npm: Record<string,string>, openssh: {source: "inbox"|"github"} }`; `loadVersions` returns it for windows recipes.
  - `sbx-tpl versions windows --update`: latest stable of each tool from the official sources (PowerShell LTS + Git for Windows + gh + uv + Bun from GitHub releases with the asset `digest`; Node LTS from `nodejs.org/dist/index.json` + `SHASUMS256.txt`; Python from python.org (download + hash if no published sha256); Go from `go.dev/dl/?mode=json`); npm packages via `npm view`; virtio-win stays pinned (warns when Proxmox wiki recommends another version or `stable` is newer); writes the file deterministically.
  - `template.yaml` per spec §5 minus `pool`/`size_default`, plus `shared: _windows`, `install_timeout_s: 2400`, `ui` from versions; `versions.toml` filled by running the updater now (values committed), `[iso]` = Ilia's ISO (`Windows11_Client_x64_en-gb_26300_9457.iso`, `edition = "Windows 11 Pro"`, `product_key = "generic-pro"`, `channel = "retail"`, `ui_language = "en-GB"`, sha256 filled in Task 26 via `--accept-iso-sha256`), `[virtio_win] version = "0.1.271"` + sha256 of `virtio-win-0.1.271.iso` from fedorapeople (download + hash).
- [ ] **Step 1: Failing tests:** `loads the windows fixture recipe with nested efidisk0/tpmstate0`, `rejects unknown offline stage`, `windows steps resolve to .ps1 from the shared dir`, `linux recipe unchanged` (existing tests), `windows versions parser requires iso.sha256 and tools sha256`, `updater picks LTS node and writes stable output` (fixtures for the HTTP responses).
- [ ] **Step 2–4:** FAIL → implement → common check; then run the updater for real and commit `versions.toml`.
- [ ] **Step 5:** Commit `sbx-tpl: windows recipe and versions (iso-install)`.

### Task 19: Unattend files and build/offline ISO contents

**Files:** Create `apps/template-builder/src/windows/unattend.ts`, `apps/template-builder/src/windows/media.ts`; create `infra/templates/_windows/{autounattend.xml.tmpl,sbx-unattend.xml,offline-autounattend.xml,offline.cmd,SetupComplete.cmd,run-step.ps1}`; modify `src/seed.ts` (`makeIso(files, out, label)`); tests `test/windows-unattend.test.ts`, `test/windows-media.test.ts`.

**Interfaces:**
- Produces:
  - `renderAutounattend(i: { edition; productKey: string|null; uiLanguage; locale; buildPassword; driverPaths: string[] }): string` — `windowsPE`: `DriverPaths` for the virtio-win drive (search letters D–I with the `w11\amd64` subfolders of `vioscsi`, `NetKVM`, `viostor`, `Balloon`, `vioserial`, `viorng`), disk 0 GPT EFI 260 MB + MSR 16 MB + Windows rest (no recovery partition), `/IMAGE/NAME` = edition, key (if any) with `WillShowUI=OnError`; `specialize`: `PreventDeviceEncryption=1` (`HKLM\SYSTEM\CurrentControlSet\Control\BitLocker`), `RunSynchronous` copying `build\SetupComplete.cmd` from the drive labelled `SBXBUILD` to `C:\Windows\Setup\Scripts\`; `oobeSystem`: `HideEULAPage`, `HideOEMRegistrationScreen`, `HideOnlineAccountScreens`, `HideWirelessSetupInOOBE`, `ProtectYourPC=3`, `LocalAccounts` `user` in Administrators with the build password (`PlainText=false` base64 as Windows expects), `TimeZone=UTC`, en-US formats/keyboard. XML-escaped.
  - `SBX_UNATTEND` (static `sbx-unattend.xml`, spec §10.2): `generalize` `PersistAllDeviceInstalls=true`; `specialize` `RunSynchronous` `"C:\Program Files\sbx-agent\current\sbx-agent.exe" identity apply --specialize`; `oobeSystem` as above without accounts. No password anywhere.
  - `renderOfflineAutounattend(): string` (`windowsPE` `RunSynchronous` → `cmd /c <offline drive>\offline.cmd`; found by label `SBXOFFL`) and `offline.cmd` (spec §10.3: `drvload` vioscsi from the virtio-win drive, find the Windows volume, `reg load HKLM\OFFSYS`, `Start=4` for each service of the selected stages in every `ControlSet00x`, log to `\Windows\Setup\Scripts\sbx-offline.log`, `wpeutil shutdown`).
  - `buildIsoFiles(i: { recipe; versions; agentTar: Buffer; agentToml: string; sshUserCa?: string; buildPassword; buildId }): Map<string, string|Buffer>` (layout of spec §6.3; `build/agent.toml`, `build/versions.json` — tool URLs and sha256 for the steps) and `offlineIsoFiles(stages: string[]): Map<…>`; volume labels `SBXBUILD`, `SBXOFFL`.
  - `run-step.ps1 -Step <n>` contract: finds `SBXBUILD`, runs `build\steps\<n>.ps1` in pwsh when the step's first line is `#requires -Version 7`, else Windows PowerShell; all output (UTF-8, no BOM) to `C:\sbx-build\logs\<n>.log`; exit code to `C:\sbx-build\logs\<n>.exit` written last (`Set-Content -NoNewline`, then rename from `.exit.tmp`).
- [ ] **Step 1: Failing tests:** `autounattend is well-formed XML with the edition and the build password only in LocalAccounts`, `sbx-unattend contains no Password element`, `offline.cmd sets Start=4 for WinDefend, WdNisSvc, Sense, WdBoot, WdFilter, WdNisDrv, WaaSMedicSvc`, `build ISO file map has the spec §6.3 layout`, `makeIso passes -V SBXBUILD` (spawn mocked).
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `sbx-tpl: Windows unattend files and build/offline ISO contents`.

### Task 20: Windows step runner over QGA

**Files:** Create `apps/template-builder/src/windows/runner.ts`; test `test/windows-runner.test.ts` (uses `FakeGuest`).

**Interfaces:**
- Produces:
  - `runWindowsStep(io: GuestIo, o: { step: string; timeoutMs?: number; pollMs?: number; onLog(chunk: string): void; signal?: AbortSignal }): Promise<void>` — `schtasks /create /f /tn sbx-build-<step> /ru SYSTEM /sc once /st 00:00 /rl HIGHEST /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <SBXBUILD>:\build\run-step.ps1 -Step <step>"` then `/run`; poll `C:\sbx-build\logs\<step>.exit` every 2 s via `readFile`; tail `<step>.log` by byte offset (UTF-8 boundaries as S5); non-zero → `StepFailedError` with the last 200 lines; timeout default 60 min; deletes the task afterwards. The build ISO drive letter is resolved once with `powershell -NoProfile -Command "(Get-Volume -FileSystemLabel SBXBUILD).DriveLetter"`.
  - `rebootWindows(io, o)`: records `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`, `shutdown /r /t 0`, waits for ping loss then ping and a different boot time (10 min).
  - `networkUp(api, node, vmid, mac)`: `PUT config net0=...link_down=0` (same MAC/bridge/firewall), then wait for an IPv4 in 10.88.0.0/24 (5 min).
- [ ] **Step 1: Failing tests:** `runs a step to exit 0 and streams the log`, `non-zero exit throws StepFailedError with tail`, `UTF-8 split across reads printed once`, `timeout throws StepTimeoutError and deletes the task`, `reboot waits for a new boot time`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `sbx-tpl: Windows step runner (scheduled tasks over QGA)`.

### Task 21: `iso-install` pipeline

**Files:** Create `apps/template-builder/src/windows/stages.ts`; modify `src/build.ts` (dispatch by `recipe.source.kind`, rollback of ISOs), `src/stages.ts` (`checkTemplateDisk` by slot index), `src/agent-package.ts` (`windows/amd64`), `src/manifest.ts` (`windows`, `license` fields), `src/main.ts` (`--iso`, `--iso-sha256`, `--accept-iso-sha256`, `--edition`, `--product-key-file`, `iso upload <file>`), `src/cleanup.ts` (`sbx-build-*`, `sbx-offline-*` leftovers), `src/preflight.ts` (VM.Console, media.sha256, ISO present); tests `test/windows-build.test.ts`, updates in `test/fakes.ts`.

**Interfaces:**
- Consumes: Tasks 2, 3, 18–20.
- Produces: stage list for `iso-install`: `prepare` → `media` (user ISO `media.sha256` == `versions.iso.sha256` else fail, or print and write with `--accept-iso-sha256`; virtio-win fetched to `~/.cache/sbx/images/virtio-win-<v>.iso`, sha256 checked, uploaded as `local:iso/sbx-virtio-win-<v>.iso` unless present with the same size; build and offline ISOs rendered with `makeIso` and uploaded) → `vm` (create per spec §7 p.3: `bios=ovmf`, `efidisk0=<storage>:1,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k`, `tpmstate0=<storage>:1,version=v2.0`, `scsi0=<storage>:<size>,discard=on,iothread=1,ssd=1`, `net0=virtio=<mac>,bridge=<vnet>,firewall=1,link_down=1`, `ide2=local:iso/<user iso>,media=cdrom`, `sata1=local:iso/sbx-virtio-win-<v>.iso,media=cdrom`, `sata2=local:iso/sbx-build-<id>.iso,media=cdrom`, `boot=order=scsi0;ide2`, `machine` = newest `pc-q35-*+pve*` from `GET /nodes/{node}/capabilities/qemu/machines`, `balloon=0`, cores/memory from `build_vm`) → `install` (start, `sendKey("ret")` every 1 s for 20 s, wait `ping` until `installTimeoutS`) → `steps` → `seal` (`90-cleanup` is a normal step; then `sbx-agent seal` via QGA; then async `sysprep.exe /generalize /oobe /shutdown /quiet /unattend:C:\Windows\System32\Sysprep\sbx-unattend.xml`; wait `stopped` ≤ 30 min; on failure read the last 50 lines of `setuperr.log` while QGA is alive) → `offline` (`sata2` → offline ISO, `boot=order=ide2`, start, `sendKey` every 1 s for 30 s, wait `stopped` ≤ 10 min; any successful QGA ping during this stage → fail "sealed disk booted") → `template` (`delete=ide2,sata1,sata2`, `boot=order=scsi0`, `net0` link up, `POST template`, remove build/offline ISOs, disk check on the `scsi0` index) → `verify` → `ready`. Manifest: `os: windows`, `windows: {edition, build, ubr, family, isoFile, isoSha256, virtioWinVersion, openssh, appxRemoved, options}`, `diskLayout` for all three slots, `hw` incl. pinned `machine`. Rollback removes the VM (name+tag guard), `sbx-build-<id>.iso`, `sbx-offline-<id>.iso`, lease; never the user ISO or virtio-win ISO. `install-package`/agent package check accepts `windows/amd64`. RAM guard reserves `build_vm.memory_mb`.
- [ ] **Step 1: Failing tests (fake PVE):** happy path asserts the ordered API log (create config keys above, sendkey calls, sysprep exec, offline config swap, template, ISO removal); `ISO sha mismatch fails before any VM`; `--accept-iso-sha256 writes versions.toml`; `failing step rolls back VM, build+offline ISOs, lease; user ISO untouched`; `QGA answers during offline stage → failed`; `sysprep failure surfaces setuperr tail`; Linux happy path test unchanged.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `sbx-tpl: iso-install pipeline (install, steps, sysprep, offline WinPE, template)`.

### Task 22: Image content: PowerShell steps and files

**Files:** Create `infra/templates/_windows/steps/{00-base,10-system,30-toolchains,40-coding-agents,50-sbx-agent,60-desktop,90-cleanup}.ps1`, `infra/templates/_windows/lib.ps1`, `infra/templates/_windows/files/{appx-remove.txt,sshd_config,profile.ps1,scripts.ini,gpt.ini}`; test `apps/template-builder/test/windows-steps.test.ts` (static checks).

**Interfaces:**
- Consumes: Task 19 `run-step.ps1` contract, `build\versions.json`.
- Produces (spec §8, with Decisions 1–2): 
  - `00-base` (PS 5.1): policies before network (§8.1 list), services Disabled (§8.1 list minus `wuauserv`/`UsoSvc`, which wait for `90-cleanup`), maintenance tasks off, High performance, `powercfg /h off`, Fast Startup off, BCD `bootstatuspolicy ignoreallfailures`, `recoveryenabled no`, `reagentc /disable`, pagefile fixed 2048 MB on C:, `ClearPageFileAtShutdown=1`, `CrashDumpEnabled=0`, System Restore off, `VSS`/`swprv` Manual, UTC, en-US, ACP/OEMCP 65001, `LongPathsEnabled=1`, Developer Mode, VBS/HVCI off, w32time settings, firewall on all profiles + block inbound + disable all enabled allow-inbound rules + `NotifyOnListen False`, BitLocker/`PreventDeviceEncryption`, Appx removal from `appx-remove.txt` (provisioned packages).
  - `network-up` (built-in) then `10-system` (PS 5.1): OpenSSH Server via `Add-WindowsCapability` (retry 3×), `sshd` Manual, firewall rule `OpenSSH-Server-In-TCP` removed, `sshd_config` from files (spec §8.3), `DefaultShell` pwsh path, users (`user` never expires, Administrator/Guest/DefaultAccount/WDAGUtilityAccount disabled), UAC values; installs PowerShell 7 MSI (all users, `POWERSHELL_TELEMETRY_OPTOUT=1`).
  - `30-toolchains` (pwsh): Git (silent, system `core.autocrlf=false`, `core.symlinks=true`, `CLAUDE_CODE_GIT_BASH_PATH`), Node MSI + npm prefix `C:\ProgramData\npm` in system Path, Python all users + `py`, uv/uvx zip → `C:\Program Files\uv`, Bun zip → `C:\Program Files\bun`, Go MSI, gh MSI; every download checked with `Get-FileHash` against `versions.json`; VS Build Tools only if `options.vsBuildtools`.
  - `40-coding-agents` (pwsh): `npm install -g` of the pinned npm packages (`@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`, `@google/gemini-cli` — names as in S5 `versions.toml [npm]`), auto-update disabled where a system setting exists (S5 parity: `DISABLE_AUTOUPDATER=1` system env etc.).
  - `50-sbx-agent` (pwsh): `sbx-agent install-package --write-config <SBXBUILD>\build\sbx-agent-<v>-windows-amd64.tar`, `agent.toml` from the ISO, `ssh-user-ca.pub` (or empty), `profile.ps1` into `$PSHOME` of pwsh 7 and 5.1 (spec §8.4), local GPO startup script `sbx-agent.exe early` (`C:\Windows\System32\GroupPolicy\Machine\Scripts\scripts.ini` + `gpt.ini` with the scripts CSE GUIDs, `gpupdate /target:computer`), `SyncForegroundPolicy=1`, `QEMU-GA` Automatic, VSS provider registered (check `Get-Service QEMU-GA`, `vss` provider listed by `vssadmin list providers`), sysprep answer file copied to `C:\Windows\System32\Sysprep\sbx-unattend.xml`.
  - `60-desktop` (pwsh): no lock screen (`NoLockScreen=1`, `powercfg CONSOLELOCK 0`, screensaver off), Default User hive: `DisableLockWorkstation=1`, `EnableFirstLogonAnimation=0`, privacy experience / SCOOBE / Hello / tips off. No `\sbx\session` task (Decision 2).
  - `90-cleanup` (pwsh): `wuauserv`, `UsoSvc` Disabled; `Dism /Online /Cleanup-Image /StartComponentCleanup /ResetBase`; remove `C:\Windows\Temp\*`, installers, npm/pip/uv/go caches, `C:\Windows\Panther\unattend*.xml`; clear event logs; write `C:\ProgramData\sbx-template\build.json` (the builder writes it through QGA before this step and the step leaves it); `Optimize-Volume -DriveLetter C -ReTrim` non-fatal; self-check (no listed service Running/Automatic, no `authorized_keys`, no build password in `Panther`). `C:\sbx-build` is removed by the builder after reading the last log (seal stage, before `sbx-agent seal`).
- [ ] **Step 1: Failing static tests:** every recipe step file exists; first line is `#requires -Version 7` for `30`, `40`, `50`, `60`, `90`; no step contains `Invoke-Expression` on downloaded content, `-UseBasicParsing` misuse aside; every `Invoke-WebRequest`/download is followed by `Assert-Sha256` from `lib.ps1`; `appx-remove.txt` does not list Edge, Terminal, Notepad, Calculator, Paint, SnippingTool, Photos, Store, AppInstaller; `sshd_config` has `ListenAddress 127.0.0.1`, `ListenAddress ::1`, `PasswordAuthentication no`.
- [ ] **Step 2–4:** FAIL → write scripts → common check. If `pwsh` is available through `mise` (`mise exec pwsh@latest`) run `Invoke-ScriptAnalyzer` on `_windows`; otherwise PSScriptAnalyzer runs in the build VM in Task 26 (record which).
- [ ] **Step 5:** Commit `templates: Windows 11 image steps`.

### Task 23: Windows verify profile

**Files:** Create `apps/template-builder/src/windows/verify.ts`, `infra/templates/windows/verify.ps1`; modify `src/verify.ts` (dispatch by `manifest.os`), `src/main.ts`; test `test/windows-verify.test.ts`.

**Interfaces:**
- Consumes: Task 3 (`Qga`, `Machines`, S1 snapshot), Task 17 (`sbx-agent exec`, `call`, `doctor`), dev CP registrar (`src/devcp.ts`).
- Produces: `verifyWindows(deps: VerifyDeps, m: Manifest, o: VerifyOptions): Promise<VerifyResult>`. Machine A from the template (2 vCPU / 4096 MB, test smbios with `family` = connect URL or `TEST_TUNNEL_URL`), boot through specialize; checks (ids are the `CHECK` names):
  1. guest `verify.ps1` (QGA, pwsh) prints `CHECK <id> PASS|FAIL|INFO <evidence>` for spec §15 p.1–10, 16–18 except p.15 (edition/build, name `SBX<12 hex>`, `MachineGuid`, reboots ≤ setup's own, `sbx-unattend.xml` gone, Panther clean, listeners allow-list, firewall, sshd -T + service running + host keys from this boot + DefaultShell, users/UAC/LSA secret present, autologon session `query user`, services and policies, Defender `Start=4` + no `MsMpEng`, `sbx-offline.log` clean, pagefile + `ClearPageFileAtShutdown=1` + `CrashDumpEnabled=0`, VBS off, BitLocker off, TPM ready, BCD, WinRE off, codepage 65001, tool `--version`s = manifest, npm prefix, network/DNS/HTTPS, UTC, TRIM warning, licence → manifest `license`, leftovers).
  2. host: `sbx-agent doctor --json` (identity ready, tunnel URL from smbios family, service running, failure actions, early.json); `tunnel_connected` via the dev CP registrar when `--connect-url`.
  3. agent processes through `sbx-agent exec --user user`: `pwsh` shell contract (`exit 7`→7, `cmd /c exit 3`→3, `Get-Item C:\nope`→1, `Write-Output ok`→0), `cmd /c echo %USERNAME%` → `user`, `npm --version` via argv, `sbx-agent selftest --pty`, files (`call Filesystem/...` write/read/stat).
  4. secrets: `call System/Claim` with a secret file + secret env → visible to an `exec`; `call System/PrepareStop` → `secret_files_wiped: true`, file gone; claim again, S1 hard `stop` + `start` → file gone before `doctor` reports ready (`early` wiped it).
  5. VSS: `qga fsfreeze-freeze` → status frozen → thaw ≤ 10 s; S1 snapshot of A with the QGA hook (freeze ms recorded) after writing a marker file and a DPAPI blob (`exec --user user pwsh -c [Security.Cryptography.ProtectedData]::Protect(...)` to `C:\Users\user\dpapi.bin`).
  6. fork: shut down A (`shutdown`, 120 s); B = `cloneFromSnapshot` with a new smbios; boot; one extra reboot; new name/`MachineGuid`/host keys; marker file present; DPAPI blob decrypts as `user`; `exec --user user` works without a password change (LSA secret unchanged: compare `call System/Info` and a hash printed by `verify.ps1 -Check lsa-hash`); `identity.reset` in `sbx-agent logs`; times recorded (`fork_boot_ms`).
  7. hard stop of B + start: agent ready ≤ normal boot + 10 s.
  8. cleanup: delete B, A, snapshot; `verifyGone`.
  Boot timings (`first_boot_to_agent_ready`, `boot_to_agent_ready`, `hard_stop_restart`, `identity_change_boot`, `freeze`) go to `verify.boot`.
- [ ] **Step 1: Failing tests (fakes):** `parses CHECK lines`, `pwsh exit-code contract assertions fail on wrong codes`, `fork check requires a new name and the marker`, `cleanup runs on failure`.
- [ ] **Step 2–4:** FAIL → implement → common check.
- [ ] **Step 5:** Commit `sbx-tpl: windows verify profile`.

### Task 24: `sbx-bench s9` and agent tests on real Windows

**Files:** Create `apps/bench/src/s9.ts`, `apps/bench/src/win-agent-tests.ts`, `services/guest-agent/test/windows/build-tests.sh`, `.github/workflows/guest-agent-windows.yml`; modify `apps/bench/src/main.ts`; tests `apps/bench/test/s9.test.ts`.

**Interfaces:**
- Produces:
  - `sbx-bench s9 --template 597 [--runs 3] [--connect-url <wss>] [--dev-cp-ssh <host>] [--keep]`: per run — `create_to_agent_ready` (S1 create + start → `doctor` identity ready and, with `--connect-url`, tunnel connected), `boot_to_agent_ready`, `hard_stop_restart`, `fork_to_agent_ready` (snapshot with QGA hook + `cloneFromSnapshot` + start → ready with a new name), `freeze_ms`; one Windows VM at a time; RAM guard 8192 MB; deletes everything; writes `bench-out/s9-<ts>.json` and a markdown table.
  - `sbx-bench s9 agent-tests --vmid <running clone> --dir <test binaries>`: copies each `*.test.exe` with `Qga.fileWriteWindows` to `C:\sbx-tests\`, runs `<bin> -test.v -test.timeout 5m` as SYSTEM via QGA exec, prints results, exit 1 on any failure, removes the dir.
  - `build-tests.sh`: `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -ldflags='-s -w' -o <out>/<pkg>.test.exe` for every package with `*_windows_test.go`.
  - GitHub Actions `guest-agent-windows.yml` (`on: workflow_dispatch` only, `runs-on: windows-2025`, `go test ./...` in `services/guest-agent`).
- [ ] **Step 1: Failing tests:** `s9 summarizes runs (median/p95)`, `agent-tests chunks files ≤ 32 KiB and fails on a non-zero test exit` (fake QGA).
- [ ] **Step 2–4:** FAIL → implement → `pnpm --filter @sbx/bench test` + typecheck + lint.
- [ ] **Step 5:** Commit `bench: s9 scenario and Windows agent test runner`.

### Task 25: Spec and docs

**Files:** `docs/specs/s9-windows.md` (status line: Ilia's decisions of 2026-10-31; §14 replaced by "cold create"; §24 decisions/deviations from this plan), `docs/specs/s3-guest-agent.md` §18 table (Windows column as built), `services/guest-agent/README.md` (Windows build/package/tests), `apps/template-builder/README.md` (windows build), `deploy/compose/config/sbx.yaml` (template `windows` + build 597 after Task 28).

- [ ] **Step 1:** Write the changes; numbers are filled in Task 29.
- [ ] **Step 2:** Commit `docs: S9 decisions (Windows 11 only, cold create)`.

## Part D. On `pve` (coordinator session only)

### Task 26: Host preparation and first build

- [ ] `qm list` + `free -m`: our budget is free; no other thread's Windows VM.
- [ ] Deploy: `infra/pve/setup.sh node` (new `sbx-node`) and `setup.sh console`; `setup.sh status` green.
- [ ] `sbx-tpl preflight`; `sbx-tpl build windows --agent-package <tar> --accept-iso-sha256 --keep-on-failure --connect-url wss://tunnel.192-168-68-90.sslip.io/v1/connect --dev-cp-ssh <ct590>`; fix and repeat until `ready` (each fix goes through a task-sized change with a review).
- [ ] Record: OVMF boot-order behaviour on the offline stage, OpenSSH install path, PSScriptAnalyzer result.

### Task 27: Agent tests on real Windows

- [ ] Create a clone of 597 (S1), run `sbx-bench s9 agent-tests` with `build-tests.sh` output; all Windows tests pass; delete the clone.

### Task 28: Reproducibility, verify, bench

- [ ] Second build with the same `versions.toml` and commit → same edition/build/tools/virtio in the manifest (spec §20 p.2); keep the better of the two as 597, remove the other.
- [ ] `sbx-tpl verify <buildId> --connect-url … --dev-cp-ssh …` all green.
- [ ] `sbx-bench s9 --template 597 --runs 3 --connect-url …`.
- [ ] Register the build in `deploy/compose/config/sbx.yaml` (`windows`, `pveVmid: 597`).

### Task 29: Finish

- [ ] Fill spec §24 (timings, build duration, template size, OpenSSH path, BootId, specialize reboots).
- [ ] Full checks: Go (`go test -race`, `go vet`, `golangci-lint` for linux and `GOOS=windows`) in every Go module; `test/linux/run.sh`; `pnpm -r test`, `pnpm lint`, `pnpm -r build`.
- [ ] Final whole-branch review by a fresh subagent; push `s9-impl` (no merge).
