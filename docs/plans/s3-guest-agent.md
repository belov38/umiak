# S3 Guest Agent (Linux) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `services/guest-agent` (`sbx-agent`), the only platform process inside a Linux VM: commands under a systemd shim with resumable output, PTY, files, ports and CONNECT, claim and identity, quiesce, signed self-update, events, installation artifacts.

**Architecture:** One Go binary with subcommands. The `run` agent embeds `libs/tunnel/agent` and gives it an `http.Handler` (Connect `sbx.agent.v1` + `/files/*`), an `EventJournal` on bbolt and a CONNECT `Dial`. Each command runs in a transient unit `sbx-cmd-<id>.service` under `sbx-agent shim`, which owns the pipes/PTY, the log files and `exit.json`; the agent talks to it over a unix socket. Everything OS-specific sits behind interfaces with `_linux.go` / `_other.go` files so `GOOS=windows CGO_ENABLED=0` builds.

**Tech Stack:** Go 1.27.3, connect-go v1.21.1, protobuf v1.36.12, bbolt v1.5.0, go-systemd/v22 v22.7.0 (godbus v5.2.4), creack/pty v1.1.24, fsnotify v1.10.1, gopsutil/v4 v4.26.9, x/sys v0.49.0, x/crypto v0.58.0, go-toml/v2 v2.4.3, oklog/ulid/v2 v2.1.2 (all re-checked 2026-10-30), buf 1.75.0.

**Spec:** `docs/specs/s3-guest-agent.md` (with S2 `docs/specs/s2-tunnel-protocol.md` §9–§10, S4 §7.2, S5 §17.3, S6 §10/§12/§16 on branch `s6-impl`).

## Global Constraints

- Go module `github.com/belov38/boat-dev-clone/services/guest-agent`, added to `go.work` with `go work use`; `go 1.27`, `toolchain go1.27.3`; `replace` for `libs/proto` and `libs/tunnel` like `libs/tunnel/go.mod`.
- No cgo. Every package builds with `GOOS=windows CGO_ENABLED=0 go build ./...`. Linux-only code in `*_linux.go`; other OSes get stubs that return `errors.ErrUnsupported` (or a fake where a test needs one).
- `go test -race ./...` passes on darwin and Linux without root. Tests needing root, systemd or cgroups carry the build tag `integration` and run in the systemd container (Task 18).
- All paths go through `paths.Layout` (Task 2) so tests use `t.TempDir()`; no test touches the real `/etc`, `/var/lib`, `/run`.
- Never log env values, secrets, file bodies or RPC bodies. BS and MT are never written to disk.
- Connect handlers: `connect.WithReadMaxBytes(16<<20)`, `connect.WithSendMaxBytes(16<<20)`, `connect.WithCompression("gzip", nil, nil)` (no response compression, S2 acceptance). `/files` never sets `Content-Encoding`.
- `Sbx-Upload-Offset` is the only `Sbx-*` response header from `/files`, formatted with `strconv.FormatUint` (strict non-negative integer).
- Errors: `rpcconv.NewError(code, detailCode, msg)`; detail codes from spec §19 plus `invalid_path`, `payload_too_large`, `upload_not_found`, `bad_version`, `quiesced`. HTTP `/files` errors: JSON `{code, message, retryable}`.
- Comments in English, code style of `libs/tunnel` (doc comment on every exported name, `slog`, table tests).
- Commit after each task; never add a `Claude-Session:` trailer or claude.ai link.

## Decisions and deviations (executor decisions, spec §24)

1. **Shim protocol and internal records are JSON, not protobuf.** Frames on the shim socket: 4-byte big-endian length + JSON object with `"type"`. bbolt values (`commands`, `uploads`, `claim`, `meta`, `requests` metadata), `shim.json`, `exit.json`, `quiesce.json`, `identity.json`, `pending-update.json` are JSON. Reason: no codegen for internal types; `encoding/json` ignores unknown fields, so the §15/§17.5 property (old agent reads new records) holds. Event payloads and cached RPC responses stay protobuf.
2. **Request cache stores only final outcomes:** success and non-retryable errors. Retryable errors (`unavailable`, `deadline_exceeded`) are not cached, so a retry after `quiesced` really retries. A success over 1 MiB keeps hash and code only; a replay re-executes the handler (all cached methods are idempotent by design).
3. **S6 alignment (S6 is authoritative):**
   - `System/Activity` (`NO_SIDE_EFFECTS`) → `{running_commands, open_ptys, tcp_streams, attach_streams}`; event type `activity` with payload `Activity{running_commands, open_ptys, tcp_streams}` on any 0↔non-0 transition and every 60 s. `running_commands` counts commands whose unit is alive (main process or leftovers), `open_ptys` live PTY commands.
   - `System/Thaw` answers `auto_thawed`/`auto_thawed_at` for a lease that the watchdog (or the agent timer) already thawed, also on a repeated call, as long as the marker lives (1 h in `/run/sbx-agent/quiesce-thawed/`).
   - `System/PrepareStop` (`IDEMPOTENT`, no request id): flush the store, wipe `/run/sbx/secrets` contents, phase `secrets` → `pending` if the digest is non-empty.
   - Event `pty.closed{command_id, reason}` in addition to `command.exited` for PTY commands.
   - `ClaimRequest` gets `reason` (`CLAIM`/`RESUME`/`RECOVER`) and `authorized_keys` (stored in the claim record, not applied: S4 checks user keys). `RESUME`/`RECOVER` on a machine already claimed for the same `sandbox_id` applies env, secrets and CA as `UpdateEnv`+`UpdateSecrets`+`UpdateSshCa`; another `sandbox_id` → `already_claimed`.
   - `CommandExited.signal` and `ExitEvent.signal` are signal names (`"SIGKILL"`), status is the S2 enum (`EXITED/KILLED/LOST`) plus `reason`; S6/S7 derive `timed_out`/`failed_to_start` from `reason`.
4. **CONNECT dial errors (S4 §7.2):** the agent's `Dial` returns `*agent.DialError{Reason: "refused"|"timeout"}`; `libs/tunnel/agent` answers `502` with `Sbx-Dial-Error: <reason>` (new `wire.HeaderDialError`). Additive library change; the gateway side is S4's.
5. **Agent's own quiesce timer** reports `quiesce.auto_thawed{by: "watchdog"}` like the watchdog unit (both are the lease watchdog).
6. **Secrets tmpfs:** mount `tmpfs` with `noswap,mode=0755`; if the kernel rejects `noswap` (< 6.4) mount without it and log a warning (swap is forbidden by §20 anyway).
7. **Update keys file** `services/guest-agent/packaging/trust/update-keys.pub`: one key per line `ed25519 <base64 std of 32 bytes> <comment>`; `#` comments. Embedded into the binary with `go:embed` for the first install; S5's builder reads the same file. PoC private key: `~/.config/sbx/update-signing/ed25519.key` (outside the repo).
8. **Package build tool:** `services/guest-agent/cmd/sbx-release` with `keygen`, `pack`, `verify`. Package: plain tar (no zstd).
9. **`install-package` installs the unit files** (embedded in the binary of the package) into `/etc/systemd/system`, runs `daemon-reload` and enables `sbx-identity`, `sbx-agent`; S5 just calls it. It also writes `/etc/sbx-agent/agent.toml` only if absent (`--write-config`).
10. **Shared test Postgres:** new public wrapper `libs/tunnel/tunneltest/pgtest` re-exporting `internal/pgtest` (`Main`, `New`), so the guest-agent harness can run the real gateway without moving S2 code.
11. **TS:** `@sbx/proto` gets a subpath export `./agent/v1` (`src/agent/v1.ts`) because `InfoRequest`/`InfoResponse` exist in both `sbx.tunnel.v1` and `sbx.agent.v1`.
12. **Desktop seam (S10):** `ext.Extension` interface (`PlatformEnv`, `Phases`, `AfterClaim`) wired as an empty list. Not implemented.
13. Linux integration runs in a privileged Docker Desktop container with systemd as PID 1 (arm64 locally, amd64 in CI); the `pve` stand run comes after the master frees the host.

## Review Focus

1. **Agent restart between `STARTING` write and the answer** — a repeated `Start` must never start a second process; `shim.json` decides (Task 9 `TestStartRetryAfterCrashNeverDoublesLaunch`).
2. **Attach while the janitor punches holes and while the command exits** — no zeros sent, `exit` only after every stream reached `end`, offsets equal file size (Task 6 `TestReaderRecheckAfterPunch`, Task 9 `TestAttachExitAfterAllBytes`).
3. **Escaped and hostile paths** — upload ids like `..%2F..%2Fetc` or `a/b`, tar entries `../x`, `/etc/x`, symlink-then-file, hardlink outside → `invalid_path`, nothing written outside (Task 10).
4. **Writes during our freeze** — no handler blocks the read paths; events get seq only after thaw; a mutation returns `unavailable quiesced` at its deadline; foreign freeze thawed after 15 s (Tasks 3, 14).
5. **Duplicate and late acks / requestIds** — `Ack` with lower seq is a no-op; same requestId with another body → `invalid_argument`; parallel duplicate waits for the first (Tasks 3, 4).

---

## File structure

```
go.work                                           + ./services/guest-agent
proto/sbx/agent/v1/{common,process,filesystem,system,events}.proto
libs/proto/sbx/agent/v1/...                       generated Go (+ agentv1connect)
packages/proto/src/gen/sbx/agent/v1/*_pb.ts       generated TS
packages/proto/src/agent/v1.ts, package.json      subpath export ./agent/v1
libs/tunnel/wire/wire.go                          + HeaderDialError
libs/tunnel/agent/connect.go                      + DialError -> 502 Sbx-Dial-Error
libs/tunnel/tunneltest/pgtest/pgtest.go           public wrapper of internal/pgtest
.github/workflows/guest-agent.yml                 CI: unit, lint, windows build, integration (sudo)
services/guest-agent/
  go.mod, .golangci.yml
  cmd/sbx-agent/main.go                           subcommand dispatch
  cmd/sbx-release/main.go                         keygen, pack, verify
  packaging/systemd/{sbx-agent,sbx-identity,sbx-agent-rollback}.service, sbx-cmd.slice
  packaging/agent.toml                            template config (S5)
  packaging/trust/update-keys.pub                 pinned update keys
  packaging/embed.go                              go:embed of the above
  internal/paths/       Layout (all directories), defaults, ForRoot(root) for tests
  internal/config/      agent.toml, defaults, sizes ("128MiB"), durations
  internal/logx/        async non-blocking slog handler with drop counter
  internal/fsutil/      atomic write (tmp+fsync+rename), fsync dir
  internal/errs/        detail codes, errno -> Connect/HTTP mapping
  internal/store/       bbolt, single writer + freeze gate, buckets, journal (EventJournal)
  internal/reqcache/    Sbx-Request-Id cache interceptor (+ singleflight)
  internal/events/      type constants, Emitter (payload -> Any -> store)
  internal/ident/       smbios source, identity.json, resetter, apply, seal
  internal/output/      OutputStore (SEEK_DATA, punch hole), stream reader, janitor
  internal/shimproto/   frames, message types, client
  internal/shim/        shim process (linux)
  internal/supervisor/  Supervisor iface; systemd (linux); fake
  internal/process/     Process service, command manager, recovery, PTY idle
  internal/files/       path resolution, ownership, Filesystem service, /files HTTP, uploads, archive
  internal/claim/       claim apply, env files, secrets tmpfs, ssh CA, env builder
  internal/readiness/   phase tracker
  internal/ext/         desktop seam (interface only)
  internal/ports/       /proc/net/tcp scanner, owners, CONNECT dialer, stream counter
  internal/system/      System service: Info, Metrics, ListPorts, Activity, claim RPCs, PrepareStop, idle/activity
  internal/docker/      minimal Engine API client over unix socket
  internal/quiesce/     lease, freeze/thaw, hooks, watchdog, foreign-freeze probe
  internal/update/      manifest, signature, install, apply, pending, rollback, selftest, versions janitor
  internal/agent/       run: startup sequence, tunnel wiring, Info, status.json, doctor
  test/harness/         in-process gateway harness (Task 17)
  test/linux/           Dockerfile + run.sh for the systemd container (Task 18)
```

---

### Task 1: Proto `sbx.agent.v1`, generation, library additions

**Files:**
- Create: `proto/sbx/agent/v1/{common,process,filesystem,system,events}.proto`
- Generated: `libs/proto/sbx/agent/v1/*.pb.go`, `libs/proto/sbx/agent/v1/agentv1connect/*.go`, `packages/proto/src/gen/sbx/agent/v1/*_pb.ts`
- Create: `packages/proto/src/agent/v1.ts`; Modify: `packages/proto/package.json` (exports `./agent/v1`)
- Modify: `libs/tunnel/wire/wire.go`, `libs/tunnel/agent/connect.go`, `libs/tunnel/agent/connect_test.go`
- Create: `libs/tunnel/tunneltest/pgtest/pgtest.go`

**Interfaces — Produces** (package `sbx.agent.v1`, `go_package = ".../libs/proto/sbx/agent/v1;agentv1"`; all enums with `<ENUM>_UNSPECIFIED = 0` and prefixed values):

`common.proto`
- `enum Stream {STREAM_STDOUT=1; STREAM_STDERR=2; STREAM_PTY=3}`; `enum CommandState {STARTING=1; RUNNING=2; EXITED=3}`; `enum ExitStatus {EXITED=1; KILLED=2; LOST=3}`; `enum ExitReason {NONE=1; SIGNAL=2; TIMEOUT=3; OOM=4; PTY_IDLE=5; REBOOT=6; SHIM_LOST=7; START_FAILED=8}`; `enum OnExit {KEEP_LEFTOVERS=1; KILL_LEFTOVERS=2}`; `enum FileType {FILE=1; DIR=2; SYMLINK=3; OTHER=4}`.
- `Argv{repeated string args=1}`; `Pty{uint32 cols=1; uint32 rows=2; string term=3}`.
- `CommandSpec{oneof cmd {Argv argv=1; string shell=2}; optional bool login=3; string cwd=4; map<string,string> env=5; string user=6; Pty pty=7; bool stdin=8; uint64 timeout_ms=9; OnExit on_exit=10; map<string,string> tags=11}`.
- `ExitInfo{ExitStatus status=1; int32 code=2; string signal=3; ExitReason reason=4}`.
- `StreamInfo{Stream stream=1; uint64 size=2; uint64 available_from=3; optional uint64 end=4}`.
- `CommandInfo{string command_id=1; CommandSpec spec=2 /* env cleared */; repeated string env_keys=3; CommandState state=4; int32 pid=5; Timestamp created_at=6; Timestamp started_at=7; Timestamp ended_at=8; ExitInfo exit=9; repeated StreamInfo streams=10; bool has_leftovers=11; uint32 attached_clients=12; string agent_version=13}`.
- `FileInfo{string path=1; string name=2; FileType type=3; uint64 size=4; uint32 mode=5; string owner=6; string group=7; uint32 uid=8; uint32 gid=9; Timestamp mtime=10; string symlink_target=11}`.
- `Port{uint32 port=1; repeated string addresses=2; int32 pid=3; string process=4; string user=5}`.
- `enum PhaseState {PENDING=1; READY=2; FAILED=3; DISABLED=4}`; `Phase{string name=1; PhaseState state=2; string error=3; Timestamp changed_at=4}`.

`process.proto` — `service Process` with idempotency levels of spec §9.1:
- `Start(StartRequest{command_id=1; spec=2}) → StartResponse{CommandInfo command=1; bool created=2}`
- `Run(RunRequest{command_id=1; spec=2}) → stream AttachResponse`
- `Attach(AttachRequest{command_id=1; uint64 stdout_offset=2; uint64 stderr_offset=3; uint64 pty_offset=4; uint64 tail_bytes=5; optional bool follow=6}) → stream AttachResponse` `NO_SIDE_EFFECTS`
- `AttachResponse{oneof event {DataEvent data=1; HeartbeatEvent heartbeat=2; TruncatedEvent truncated=3; ExitEvent exit=4; StartedEvent started=5}}` (same numbers as `sbx.testing.v1` so S2's TS splice views map 1:1)
- `DataEvent{Stream stream=1; uint64 offset=2; bytes data=3}`; `HeartbeatEvent{}`; `TruncatedEvent{Stream stream=1; uint64 available_from=2}`; `ExitEvent{ExitStatus status=1; int32 code=2; string signal=3; uint64 stdout_end=4; uint64 stderr_end=5; uint64 pty_end=6; ExitReason reason=7; Timestamp ended_at=8}`; `StartedEvent{string command_id=1; CommandInfo command=2}`
- `SendInput({command_id=1; string input_session_id=2; uint64 seq=3; bytes data=4; bool close_stdin=5}) → {bool applied=1}` `IDEMPOTENT`
- `Update({command_id=1; uint32 cols=2; uint32 rows=3}) → {}` `IDEMPOTENT`
- `Signal({command_id=1; string signal=2}) → {CommandInfo command=1}` `IDEMPOTENT` (signal: `SIGINT`, `INT` or decimal)
- `Kill({command_id=1; optional uint32 grace_ms=2}) → {CommandInfo command=1}` `IDEMPOTENT`
- `Get({command_id=1}) → {CommandInfo command=1}` `NO_SIDE_EFFECTS`
- `List(ProcessListRequest{CommandState state=1; map<string,string> tags=2; uint32 page_size=3; string page_token=4}) → ProcessListResponse{repeated CommandInfo commands=1; string next_page_token=2}` `NO_SIDE_EFFECTS`
- `Remove(ProcessRemoveRequest{command_id=1}) → ProcessRemoveResponse{bool removed=1}` `IDEMPOTENT`

`filesystem.proto` — `service Filesystem` (§11.4): `Stat{path=1;user=2;bool no_follow=3}→{FileInfo info=1}` `NO_SIDE_EFFECTS`; `List(FilesystemListRequest{path=1;user=2;uint32 depth=3;optional bool include_hidden=4;uint32 page_size=5;string page_token=6})→FilesystemListResponse{repeated FileInfo entries=1;string next_page_token=2}` `NO_SIDE_EFFECTS`; `MakeDir{path=1;user=2;bool parents=3;optional uint32 mode=4;string owner=5}→{FileInfo info=1;bool created=2}`; `Move{src=1;dst=2;user=3;bool overwrite=4}→{FileInfo info=1}`; `Chmod{path=1;user=2;optional uint32 mode=3;string owner=4;string group=5;bool recursive=6}→{FileInfo info=1}`; `Remove(FilesystemRemoveRequest{path=1;user=2;bool recursive=3})→FilesystemRemoveResponse{bool existed=1}`. Mutating ones have no level (need `Sbx-Request-Id`).

`system.proto` — `service System`:
- `Info({}) → InfoResponse{string version=1; string previous_version=2; string os=3; string arch=4; string kernel=5; string boot_id=6; Timestamp boot_time=7; string machine_id=8; string hostname=9; string sandbox_id=10; ClaimInfo claim=11; repeated Phase readiness=12; bool ready=13; repeated string ssh_host_keys=14; QuiesceStatus quiesce=15; UpdateStatus update=16; Timestamp idle_since=17; string default_user=18; string tunnel_url=19; string tunnel_url_source=20}` `NO_SIDE_EFFECTS`; `ClaimInfo{sandbox_id=1; hostname=2; port_domain=3; map env=4; repeated string secret_env_keys=5; repeated string secret_file_names=6; repeated string ssh_user_ca_keys=7; Timestamp claimed_at=8}`; `QuiesceStatus{bool active=1; string lease_id=2; Timestamp deadline=3}`; `UpdateStatus{bool pending=1; string from=2; string to=3; Timestamp deadline=4; repeated string bad_versions=5}`.
- `Metrics({}) → MetricsResponse{Cpu cpu=1; Memory memory=2; repeated Disk disks=3; Network network=4; uint32 processes=5; uint32 running_commands=6; uint32 attach_streams=7; uint32 tcp_streams=8}` with `Cpu{double usage_percent=1; uint32 cores=2; double load1=3; double load5=4; double load15=5}`, `Memory{total,available,used,swap_total,swap_used uint64}`, `Disk{mount=1; total,used,free,inodes_total,inodes_free uint64}`, `Network{rx_bytes,tx_bytes uint64; double rx_bps,tx_bps}` `NO_SIDE_EFFECTS`.
- `ListPorts({}) → {repeated Port ports=1}` `NO_SIDE_EFFECTS`; `Activity({}) → {uint32 running_commands=1; uint32 open_ptys=2; uint32 tcp_streams=3; uint32 attach_streams=4}` `NO_SIDE_EFFECTS`.
- `Claim(ClaimRequest{sandbox_id=1; hostname=2; port_domain=3; map env=4; map secret_env=5; repeated SecretFile secret_files=6; repeated string ssh_user_ca_keys=7; ClaimReason reason=8; repeated string authorized_keys=9}) → ClaimResponse{repeated Phase readiness=1; bool ready=2}`; `enum ClaimReason{CLAIM=1; RESUME=2; RECOVER=3}`; `SecretFile{name=1; bytes content=2; uint32 mode=3; string link_path=4}`.
- `UpdateEnv({map env=1}) → {readiness=1; ready=2}`; `UpdateSecrets({map secret_env=1; repeated SecretFile secret_files=2}) → {readiness=1; ready=2}`; `UpdateSshCa({repeated string keys=1}) → {}`.
- `PrepareStop({}) → {}` `IDEMPOTENT`.
- `Quiesce({optional uint32 lease_ms=1; optional bool docker=2; optional bool fs=3}) → {lease_id=1; Timestamp deadline=2; repeated string paused_containers=3; repeated string frozen_mounts=4}`; `Thaw({lease_id=1}) → {bool auto_thawed=1; Timestamp auto_thawed_at=2; bool already_thawed=3}`.
- `ApplyUpdate({string upload_id=1; bool allow_bad_version=2}) → {string from=1; string to=2}`.

`events.proto` — payloads: `AgentStarted{version=1; previous_version=2; boot_id=3; string reason=4}`; `IdentityReset{machine_id=1}`; `CommandExited{command_id=1; ExitStatus status=2; int32 code=3; string signal=4; ExitReason reason=5; uint64 stdout_end=6; uint64 stderr_end=7; uint64 pty_end=8; Timestamp ended_at=9}`; `ReadinessChanged{string phase=1; PhaseState state=2; string error=3}`; `ClaimApplied{sandbox_id=1}`; `PortsChanged{repeated Port ports=1}`; `IdleChanged{bool idle=1; Timestamp since=2}`; `Activity{uint32 running_commands=1; uint32 open_ptys=2; uint32 tcp_streams=3}`; `PtyClosed{command_id=1; ExitReason reason=2}`; `QuiesceAutoThawed{lease_id=1; Timestamp at=2; string by=3}`; `DiskThreshold{string mount=1; uint64 free_bytes=2}` (types `disk.low`/`disk.ok`); `UpdateResult{from=1; to=2; bool ok=3; bool rolled_back=4; string error=5}`; `JournalGap{uint64 from_seq=1; uint64 to_seq=2}`.

Library: `wire.HeaderDialError = "Sbx-Dial-Error"`; `type agent.DialError struct{ Reason string; Err error }` (`Error()`, `Unwrap()`); `serveConnect` sets the header when `errors.As(err, &*DialError)` and `Reason != ""`. `pgtest.Main(m *testing.M)`, `pgtest.New(t testing.TB) (*pgxpool.Pool, string)`.

- [ ] **Step 1: Write the protos** as above; doc comment per service, RPC and message (buf lint STANDARD). `option idempotency_level` per the lists.
- [ ] **Step 2: Run** `cd proto && mise exec -- buf lint && mise exec -- buf generate` — Expected: no lint output; new files under `libs/proto/sbx/agent/v1` and `packages/proto/src/gen/sbx/agent/v1`.
- [ ] **Step 3: Write the failing library test** in `libs/tunnel/agent/connect_test.go`: `TestConnectDialErrorHeader` — a client whose `Dial` returns `&agent.DialError{Reason: "refused"}`: CONNECT gets `502` and `Sbx-Dial-Error: refused`; a plain error gets `502` without the header.
- [ ] **Step 4: Run** `cd libs/tunnel && mise exec -- go test ./agent -run TestConnectDialErrorHeader` — Expected: FAIL (undefined `DialError`).
- [ ] **Step 5: Implement** `DialError`, the header constant, the header in `serveConnect`; add `tunneltest/pgtest` wrapper; `packages/proto/src/agent/v1.ts` re-exporting the five `_pb.js` files; `exports["./agent/v1"]` with `source`/`types`/`default` like `"."`.
- [ ] **Step 6: Verify** `cd libs/tunnel && mise exec -- go test -race ./agent ./wire && mise exec -- golangci-lint run ./...`; `pnpm --filter @sbx/proto build`; `git status --porcelain` after a second `buf generate` shows no change. Expected: PASS, clean.
- [ ] **Step 7: Commit** `proto: sbx.agent.v1; tunnel: Sbx-Dial-Error, public pgtest`.

---

### Task 2: Module skeleton: paths, config, logging, fsutil, errs, CLI

**Files:**
- Create: `services/guest-agent/{go.mod,.golangci.yml}` (lint config copied from `libs/tunnel/.golangci.yml`), `cmd/sbx-agent/main.go`, `internal/paths/paths.go`, `internal/config/config.go`, `internal/logx/logx.go`, `internal/fsutil/fsutil.go`, `internal/errs/errs.go` (+ `_test.go` each)
- Modify: `go.work`

**Interfaces — Produces:**
- `paths.Layout{VersionsDir, CurrentLink, PreviousLink, BinLink, StateDir, StateDB, CommandsDir, UploadsDir, StagingDir, IdentityFile, PendingUpdateFile, BadVersionsFile, ManagedFilesList, RunDir, ShimSockDir, QuiesceFile, QuiesceThawedDir, StatusFile, SecretsMount, SecretsDir, SecretsEnvFile, SecretFilesDir, CmdSpecDir, SbxEnvFile, EtcDir, ConfigFile, TemplateSSHCA, SSHUserCA, SSHDir, MachineIDFile, DbusMachineID, HostnameFile, HostsFile, QuiesceHooksDir, SystemdUnitDir string}`; `paths.Default() Layout` (spec §5 table); `paths.ForRoot(root string) Layout` (same tree under `root`); `(Layout) CommandDir(id string) string`, `ShimSocket(id) string`, `CmdSpec(id) string`.
- `config.Config{TunnelURL string; TrustDir string; DefaultUser string; ReadinessRequired []string; DockerEnabled bool; PortsExclude []uint16; PerStreamBytes, TotalBytes int64; TotalFraction float64; MaxRunningCommands int; IdleWindow time.Duration}`; `config.Load(path string) (Config, error)` (missing file → defaults of §5); `config.ParseSize(s string) (int64, error)` (`KiB/MiB/GiB`, plain bytes).
- `logx.NewHandler(w io.Writer, level slog.Level, buf int) *Handler` — `Handle` never blocks: full channel → drop and count; `(*Handler) Dropped() uint64`; `Close()` flushes.
- `fsutil.WriteFileAtomic(path string, data []byte, perm fs.FileMode) error` (tmp in same dir, fsync file, rename, fsync dir); `fsutil.WriteJSONAtomic(path string, v any, perm fs.FileMode) error`; `fsutil.ReadJSON(path string, v any) error`.
- `errs` constants for every detail code (`errs.CommandNotFound = "command_not_found"`, …) and `errs.FromErrno(err error) *connect.Error` (§11.1 mapping), `errs.HTTPStatus(code connect.Code) int`, `errs.WriteHTTP(w, err)` (JSON `{code, message, retryable}`).
- `main.go`: `sbx-agent <run|shim|identity apply|quiesce-watchdog|rollback|doctor|thaw|install-package|seal|selftest|version>`; `var version = "dev"` (ldflags `-X main.version=`); unknown subcommand → usage, exit 2. Subcommands not built yet print `not implemented` and exit 1.

- [ ] **Step 1: Failing tests:** `TestDefaultLayoutMatchesSpec` (e.g. `StateDB == "/var/lib/sbx-agent/state.db"`, `SecretsEnvFile == "/run/sbx/secrets/env"`, `SSHUserCA == "/etc/ssh/sbx_user_ca.pub"`); `TestForRootPrefixesEveryPath` (reflect over string fields: all start with root); `TestLoadDefaults` (missing file → `PerStreamBytes == 128<<20`, `TotalBytes == 2<<30`, `TotalFraction == 0.10`, `MaxRunningCommands == 256`, `IdleWindow == 5*time.Minute`, `PortsExclude == [22 53]`, `ReadinessRequired == [identity claim secrets docker]`, `DefaultUser == "user"`, `DockerEnabled == true`); `TestLoadOverrides`; `TestParseSize` (`"128MiB"`, `"2GiB"`, `"4096"`, bad → error); `TestHandlerNeverBlocks` (writer that blocks forever; 10 000 records return within 1 s, `Dropped() > 0`); `TestWriteFileAtomic` (content, perm, no tmp left); `TestFromErrno` (`ENOENT→NotFound path_not_found`, `EEXIST→AlreadyExists already_exists`, `ENOTDIR→FailedPrecondition not_directory`, `EISDIR→FailedPrecondition is_directory`, `ENOSPC/EDQUOT→ResourceExhausted no_space`, `EACCES→PermissionDenied`).
- [ ] **Step 2: Run** `cd services/guest-agent && mise exec -- go test ./...` — Expected: FAIL (packages missing).
- [ ] **Step 3: Implement**; `go work use ./services/guest-agent`; go.mod requires and `replace` like `libs/tunnel/go.mod`.
- [ ] **Step 4: Verify** `mise exec -- go test -race ./... && mise exec -- go vet ./... && mise exec -- golangci-lint run ./... && GOOS=windows CGO_ENABLED=0 mise exec -- go build ./...` — Expected: all pass.
- [ ] **Step 5: Commit** `guest-agent: module skeleton, layout, config, logging`.

---

### Task 3: Durable store and event journal

**Files:**
- Create: `internal/store/{store.go,writer.go,commands.go,uploads.go,claim.go,meta.go,requests.go,journal.go}` + tests

**Interfaces — Consumes:** `paths.Layout`, `fsutil`.
**Produces:**
- `store.Open(path string, opts Options) (*Store, error)`; `Options{JournalMaxEvents int (100000); JournalMaxBytes int64 (64<<20); FrozenMaxRecords int (10000); FrozenMaxBytes int64 (64<<20); Now func() time.Time}`; `(*Store) Close() error`. Opens bbolt with `Timeout: 1s`, creates buckets `meta, commands, requests, events, uploads, claim`, schema version `meta/schema = 1`.
- Single writer goroutine. `(*Store) Update(ctx context.Context, fn func(tx *bbolt.Tx) error) error` — durable write; batches queued ops into one transaction (one fsync); a failing fn fails only itself (run it in a nested savepoint: execute fns one by one in the same tx, roll back the whole tx and re-run the others if one fails). While frozen it waits for thaw until ctx is done → `ErrFrozen`.
- `(*Store) SetFrozen(frozen bool)`; `(*Store) Frozen() bool`. Reads (`View`) never wait on the writer.
- Journal: `(*Store) AppendEvent(typ string, payload proto.Message)` — never blocks: queued in memory without seq; assigned seq in the writer tx (`meta/last_seq+1`), `Time` and `BootId` (from `SetBootID`) set at append. While frozen events stay in memory (bounded by `FrozenMaxRecords/Bytes`; overflow drops the oldest and later writes a `journal.gap`).
- `(*Store) SetBootID(id string)`; `(*Store) Journal() agent.EventJournal` implementing `AckedSeq`, `Read` (blocks on a notify channel; returns only committed events), `Ack` (`seq <= acked` → no-op; `seq > last_seq` → clamp to last; deletes `events` keys ≤ seq; `acked_seq` persisted).
- Overflow: after each commit, while count > max or bytes > max delete oldest unacked and append `journal.gap{from_seq, to_seq}` (one per trim pass). Gap type constant `events.TypeJournalGap = "journal.gap"`; to avoid an import cycle the store takes the gap payload builder via `Options.GapPayload func(from, to uint64) proto.Message`.
- Records (JSON): `store.Command{ID, SpecHash string; Spec json.RawMessage /* spec without env values */; EnvKeys []string; State string; Pid int; BootID string; CreatedAt, StartedAt, EndedAt time.Time; Exit *ExitRecord; Tags map[string]string; PTY bool; AgentVersion string; PTYDetachedAt *time.Time; Ends map[string]uint64}`; `ExitRecord{Status, Reason, Signal string; Code int32}`; `(*Store) GetCommand(id) (*Command, bool, error)`, `PutCommand(ctx, *Command) error`, `DeleteCommand(ctx, id) error`, `ListCommands(fn func(*Command) bool) error` (ordered by id).
- `store.Upload{ID, TempPath string; Size int64; CreatedAt, LastActivity time.Time; Commit json.RawMessage}` + `GetUpload/PutUpload/DeleteUpload/ListUploads`.
- `store.Claim{Request json.RawMessage /* no secrets */; RequestHash, SecretsDigest, SandboxID string; ClaimedAt time.Time; Response []byte}` + `GetClaim/PutClaim`.
- `store.Request{Procedure, Hash string; Code int; Detail string; Message string; Response []byte; ExpiresAt time.Time}` + `GetRequest/PutRequest`, `PruneRequests(now, max int)` (expired first, then oldest by `ExpiresAt` beyond 10 000).
- `(*Store) Meta(key string) ([]byte, bool)`, `PutMeta(ctx, key string, v []byte) error`.

- [ ] **Step 1: Failing tests:** `TestJournalSeqMonotonicAcrossReopen` (append 3, close, reopen, append 1 → seqs 1..4); `TestJournalReadBlocksUntilCommit`; `TestAckLowerSeqIgnored` (ack 5 then 3 → `AckedSeq()==5`, events 4..5 not resurrected); `TestAckBeyondLastClamps`; `TestJournalOverflowWritesGap` (max 10, append 15 unacked → trim deletes oldest until count ≤ max−1 (seqs 1..6), then appends `journal.gap{from_seq:1,to_seq:6}` as seq 16; 10 events remain); `TestFrozenEventsGetSeqAfterThaw` (`SetFrozen(true)`, append 2, `Read` with 100 ms ctx returns nothing, `SetFrozen(false)` → seqs assigned in append order); `TestUpdateWaitsWhileFrozen` (ctx 50 ms → `ErrFrozen`, nothing written); `TestBatchFailureIsolated` (two concurrent `Update`, one returns error → the other committed); `TestRequestsPrune`; `TestCommandRoundTripIgnoresUnknownFields` (raw JSON with an extra field decodes).
- [ ] **Step 2: Run** `go test ./internal/store` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race -count=3 ./internal/store` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: bbolt store and event journal`.

---

### Task 4: Request-id cache interceptor and events emitter

**Files:**
- Create: `internal/reqcache/reqcache.go` + test; `internal/events/events.go` + test

**Interfaces — Consumes:** `store.Store` requests API, `rpcconv`, `wire.HeaderRequestID`.
**Produces:**
- `reqcache.New(st *store.Store, opts Options) connect.Interceptor`; `Options{TTL time.Duration (24h); MaxEntries int (10000); MaxResponseBytes int (1<<20); Now func() time.Time}`. Unary handler calls only, skipped for `IdempotencyIdempotent/NoSideEffects` and for procedures without the header (the `RequireRequestID` interceptor runs first and rejects those). Hash = sha256(procedure + `proto.MarshalOptions{Deterministic: true}` bytes of the request). Same id + same hash → stored response (unmarshalled into `req.Spec().Schema`'s output type via a new instance from the handler's response type registry: keep `map[procedure]func() proto.Message` filled on first call) or stored error (code + detail + message rebuilt with `rpcconv.NewError`). Same id + other hash → `invalid_argument` `request_id_reused`. Parallel duplicate waits for the first (in-memory singleflight keyed by id). Retryable errors and `ErrFrozen` are not stored (Decision 2). Stores through `store.Update` with the call's ctx; a store failure after a successful handler is logged and the response returned.
- `reqcache.Interceptors(st) []connect.HandlerOption` — `connect.WithInterceptors(rpcconv.RequireRequestID(agentv1connect.ProcessStartProcedure), reqcache.New(st, Options{}))`.
- `events` constants: `TypeAgentStarted = "agent.started"`, `TypeIdentityReset = "identity.reset"`, `TypeCommandExited = "command.exited"`, `TypeReadinessChanged = "readiness.changed"`, `TypeClaimApplied = "claim.applied"`, `TypePortsChanged = "ports.changed"`, `TypeIdleChanged = "idle.changed"`, `TypeActivity = "activity"`, `TypePtyClosed = "pty.closed"`, `TypeQuiesceAutoThawed = "quiesce.auto_thawed"`, `TypeDiskLow = "disk.low"`, `TypeDiskOK = "disk.ok"`, `TypeUpdateResult = "update.result"`, `TypeJournalGap = "journal.gap"`.
- `events.Emitter` interface `{Emit(typ string, payload proto.Message)}`; `events.StoreEmitter(st)`; `events.Recorder` (test double recording `(typ, payload)`; `Of(typ) []proto.Message`).

- [ ] **Step 1: Failing tests** (`httptest` server with `agentv1connect.NewFilesystemHandler` stub counting `MakeDir` executions): `TestReplaySameBody` (two calls same id → 1 execution, equal responses); `TestSameIDOtherBody` (`invalid_argument`, detail `request_id_reused`); `TestParallelDuplicateWaits` (handler blocks on a channel; second call returns after release; 1 execution); `TestRetryableNotCached` (first call returns `unavailable` → second executes); `TestNonRetryableErrorCached` (`already_exists` replayed with same detail code); `TestIdempotentSkipped` (`Stat` never stored); `TestLargeResponseNotStored` (`MaxResponseBytes: 10` → hash kept, second call re-executes, third with other body → `invalid_argument`); `TestSurvivesReopen` (close and reopen store → replay works).
- [ ] **Step 2: Run** `go test ./internal/reqcache ./internal/events` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/reqcache ./internal/events` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: Sbx-Request-Id cache, event emitter`.

---

### Task 5: Identity: smbios, identity.json, reset, `identity apply`, `seal`

**Files:**
- Create: `internal/ident/{source.go,source_linux.go,source_other.go,identity.go,reset.go,reset_linux.go,reset_other.go,apply.go,seal.go}` + tests; wire `identity apply` and `seal` in `cmd/sbx-agent/main.go`

**Interfaces — Consumes:** `paths.Layout`, `fsutil`, `wire.ParseSMBIOSSerial`.
**Produces:**
- `ident.Source` interface `{Read(ctx) (Raw, error)}`; `Raw{Serial, UUID, Family, BootID string}`; `ident.SysfsSource{Dir string /* /sys/class/dmi/id */; BootIDPath string}` (linux); `ident.Static{Raw}` for tests.
- `ident.Parse(raw Raw) (Identity, error)`; `Identity{MachineID string; BS []byte; BootID string; TunnelURL string /* from family, "" if absent/invalid */}`; family accepted when `sbxt1:` prefix, `wss://`, non-empty host, ≤ 200 bytes (S5 §14); UUID mismatch → `Identity.Warnings`.
- `ident.File{MachineID, WrittenMachineID string; HostKeyFingerprints []string; ResetPending bool}`; `ident.LoadFile(path) (*File, error)`, `(*File) Save(path) error`.
- `ident.Resetter` interface `{SetHostname(name string) error; RegenerateHostKeys() error; ReloadNetwork() error; RestartSSH() error}`; `ident.LinuxResetter{Layout}` (`unix.Sethostname`, `rm ssh_host_*` + `ssh-keygen -A`, `networkctl renew` best effort, `systemctl try-restart ssh`); `ident.FakeResetter` (records calls).
- `ident.Apply(ctx, l paths.Layout, id Identity, r Resetter, fromAgent bool) (changed bool, err error)` — spec §7.2 steps 1–5: wipe `state.db`, `commands/`, `uploads/`, `pending-update.json`, files listed in `managed-files`; empty `/etc/sbx/env`; template SSH CA copy; machine-id rule (empty, `uninitialized` or equal to old `WrittenMachineID` → write hex without dashes; else keep); `/var/lib/dbus/machine-id` symlink; host keys; hostname `sbx-<last 12 hex>` with managed block `# BEGIN sbx` / `# END sbx` in hosts holding `127.0.1.1 <name>`; identity.json with `ResetPending: true` (fsync). `fromAgent` additionally calls `RestartSSH` and `ReloadNetwork`.
- `ident.DefaultHostname(machineID string) string`; `ident.ValidHostname(s string) bool` (RFC 1123 label ≤ 63).
- `ident.Seal(ctx, l paths.Layout, stopAgent func() error) error` — §7.3.
- CLI: `sbx-agent identity apply` (exit 0 on success and on unreadable serial with a warning — boot must not fail), `sbx-agent seal`.

- [ ] **Step 1: Failing tests:** `TestParseSerial` (valid → id/BS; malformed → error); `TestParseFamily` (valid `sbxt1:wss://h/v1/connect` → URL; `http://`, empty host, 201 bytes → `""`); `TestApplySameMachineNoop`; `TestApplyChangedResetsState` (pre-populate state files, managed file, `/etc/sbx/env` content → removed/emptied, identity.json `ResetPending`, hostname `sbx-` + last 12 hex, hosts block replaced not duplicated after two applies); `TestMachineIDRules` (empty → written; `uninitialized` → written; inherited old → rewritten; other value → kept); `TestSealWipes` (state dir gone, `/etc/machine-id` empty file, host keys gone, CA copied from template); `TestValidHostname`.
- [ ] **Step 2: Run** `go test ./internal/ident` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/ident && GOOS=windows go build ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: identity from smbios, reset and seal`.

---

### Task 6: Output store, stream reader and retention janitor

**Files:**
- Create: `internal/output/{store.go,store_linux.go,store_other.go,reader.go,janitor.go}` + tests

**Interfaces — Produces:**
- `output.Store` interface `{AvailableFrom(f *os.File, size int64) (int64, error); PunchFront(f *os.File, upTo int64) error}`; `output.Default()` — Linux: `lseek(SEEK_DATA, 0)` (`ENXIO` → size), `fallocate(FALLOC_FL_PUNCH_HOLE|FALLOC_FL_KEEP_SIZE, 0, upTo &^ 4095)`; other OSes: `AvailableFrom` = first offset whose 4 KiB block is not all zeros scanning a sidecar marker `<file>.from` written by `PunchFront` (portable fallback), `PunchFront` writes the marker.
- `output.Chunk{Offset int64; Data []byte; Truncated bool; AvailableFrom int64}`; `output.ReadChunk(st Store, f *os.File, off int64, limit int64, max int) (Chunk, error)` — if `off < availableFrom` returns `Truncated` with `AvailableFrom`; reads up to `max` (65536) bytes not past `limit` (stream `end` or −1); after reading re-checks `AvailableFrom`; if it moved past `off`, drops the prefix and returns `Truncated` first (the caller re-reads).
- `output.Janitor{Layout; Store; Config: PerStream, Total int64; Fraction float64; LowFreeBytes int64 (1<<30); LowFreeFraction float64 (0.05); LowPerStream int64 (16<<20); Commands func() []JanitorCommand; Statfs func(path string) (total, free uint64, err error); Emit events.Emitter; Now func() time.Time; RecordTTL time.Duration (7*24h); MaxRecords int (10000); RemoveRecord func(id string) error}`; `JanitorCommand{ID string; Exited bool; EndedAt time.Time; Streams []string}`; `(*Janitor) RunOnce(ctx) error`; `(*Janitor) Run(ctx, every time.Duration)`. Policy of spec §10: per-stream cap; total over `min(Total, Fraction×fs)` → drop whole logs of oldest exited (punch to size), then oldest running; free < max(1 GiB, 5%) → per-stream cap 16 MiB and one `disk.low{mount, free_bytes}`, recovery → `disk.ok`; records older than 7 days or beyond 10 000 → `RemoveRecord`.

- [ ] **Step 1: Failing tests** (Linux-only ones in `_linux_test.go`; portable ones use `Default()`): `TestPunchFrontKeepsOffsets` (write 1 MiB, punch 300 000 → `AvailableFrom` 294 912 (4 KiB aligned), size unchanged, bytes after equal original); `TestReadChunkTruncated` (off 0 after punch → `Truncated` with that `AvailableFrom`); `TestReaderRecheckAfterPunch` (fake `Store` whose `AvailableFrom` changes between the two calls → chunk returned as `Truncated` and no zero bytes returned); `TestReadChunkStopsAtLimit`; `TestJanitorPerStreamCap` (stream 200 KiB, cap 64 KiB → `size − available_from ≤ 64 KiB + 4095`); `TestJanitorTotalDropsOldestExitedFirst`; `TestJanitorDiskLowOnceThenOK` (fake `Statfs`, recorder sees exactly one `disk.low` then one `disk.ok`); `TestJanitorRecordRetention` (8-day-old exited → removed; running never removed).
- [ ] **Step 2: Run** `go test ./internal/output` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/output` on darwin, and in Linux (`docker run --rm -v $PWD:/src -w /src/services/guest-agent golang:1.27 go test -race ./internal/output`) — Expected: PASS both.
- [ ] **Step 5: Commit** `guest-agent: output store, reader, retention`.

---

### Task 7: Shim protocol and the shim process

**Files:**
- Create: `internal/shimproto/{proto.go,client.go}` + test; `internal/shim/{spec.go,shim_linux.go,cgroup_linux.go,loop_linux.go,server_linux.go,shim_other.go}` + `shim_linux_test.go`; wire `sbx-agent shim --id <id> [--layout-root <dir>] [--no-cgroup]` in main

**Interfaces — Consumes:** `paths.Layout`, `fsutil`.
**Produces:**
- `shimproto.Version = 1`; frame codec `Write(w io.Writer, m Message) error`, `Read(r io.Reader) (Message, error)` (max frame 1 MiB); `Message{Type string; ID uint64; ...}` with types `hello{min,max}`, `status`, `status_reply{pid, state, last_seq map[string]uint64, leftovers bool, exited bool}`, `input{session, seq, data, close_stdin}`, `input_reply{applied bool}`, `resize{cols, rows}`, `kill{grace_ms, first_signal, reason}`, `signal{sig int, cgroup bool}`, `ok`, `error{code, message}`, `exited{ExitFile}` (pushed).
- `shimproto.Dial(ctx, sock string) (*Client, error)`: performs hello (agent `{min:1,max:Version}`; shim answers chosen version or `error{code:"shim_outdated"}`); `(*Client) Status(ctx)`, `Input(ctx, session string, seq uint64, data []byte, closeStdin bool) (applied bool, err error)`, `Resize`, `Kill(ctx, graceMs uint32, firstSignal syscall.Signal, reason string)`, `Signal(ctx, sig syscall.Signal, cgroup bool)`, `Exited() <-chan ExitFile`, `Close()`.
- `shim.Spec` (JSON in `CmdSpec(id)`, mode 0600): `{ID, Argv []string, Env []string, Cwd string, UID, GID uint32, Groups []uint32, PTY *{Cols, Rows uint16; Term string}, Stdin bool, TimeoutMs uint64, KillLeftovers bool, AgentVersion string}` — the agent resolves the user and builds argv and env (Task 9/11); the shim does no lookups.
- `shim.ShimFile{State string /* launching|running */; AgentVersion string; ShimProto int; Pid int; StartedAt time.Time}`; `shim.ExitFile{Status string /* exited|killed */; Code int32; Signal string; Reason string; StdoutEnd, StderrEnd, PtyEnd int64; EndedAt time.Time; StartFailed string}`.
- `shim.Main(args []string) int`. Behaviour (spec §9.3–§9.5): read+delete spec; cgroup setup (`/proc/self/cgroup` → unit dir; move self to `<unit>/shim`; enable `+memory +pids +cpu` in subtree_control; mkdir `payload`) unless `--no-cgroup`; `PR_SET_CHILD_SUBREAPER`; output files 0600 (`stdout`,`stderr` or `pty`); `shim.json{launching}` fsync **before** start; `SysProcAttr{UseCgroupFD, CgroupFD, Credential, Setpgid | Setsid+Setctty}`; PTY via `creack/pty` `StartWithAttrs`; after start: oom_score_adj −900 for itself, `shim.json{running,pid,startedAt}`, `sd_notify READY=1` (via `daemon.SdNotify`, ignored when `NOTIFY_SOCKET` unset). Start failure → stderr gets the error text, `exit.json{exited, code 127, reason START_FAILED}`, READY=1, exit 0.
- Event loop (one goroutine, `unix.Poll` over pipe/PTY read fds and a pidfd): copy to files with a 64 KiB buffer; on pidfd readable → `Wait4`, non-blocking drain until `EAGAIN`/EOF/`EIO`, record ends = file sizes, reason (`OOM` if `payload/memory.events` `oom_kill` grew and signal is SIGKILL; `TIMEOUT`/`PTY_IDLE`/`SIGNAL` if a kill with that reason was issued; else `NONE`), status `killed` when terminated by signal else `exited`, write `exit.json` (fsync), push `exited` to connected clients; `KillLeftovers` → `cgroup.kill`. Keep looping (late leftover output appended past `end`) until payload cgroup is unpopulated (`cgroup.events populated 0`, checked each poll tick 250 ms) and pipes hit EOF; then exit 0.
- Socket server `ShimSocket(id)` (0600, dir 0700): single-threaded command handling (one mutex), input dedup per session (`seq <= last` → `applied:false`), `close_stdin` closes the pipe (PTY: error `failed_precondition`), resize → `pty.Setsize`, kill → `first_signal` (default SIGTERM) to `-pgid`, after grace `cgroup.kill` on payload (no cgroup: `SIGKILL` to `-pgid`), signal → `-pgid` or `cgroup.kill` when `cgroup` true; after exit only `kill`/`signal` act (leftovers); `timeout_ms` timer → kill(grace 10 s, reason TIMEOUT).

- [ ] **Step 1: Failing tests:** `shimproto`: `TestFrameRoundTrip`, `TestFrameTooLarge`, `TestHelloOutdated` (server max 1, client min 2 → `shim_outdated`). `shim_linux_test.go` (non-root, `--no-cgroup`, runs the test binary as the shim via `TestMain` re-exec when `SBX_SHIM_TEST=1`): `TestShimStdoutStderrExact` (`printf` 1 MiB pseudo-random via `head -c` | sha256 of file equals source; `exit.json` code 0, ends = sizes); `TestShimDevStderrReopen` (`sh -c 'echo x >/dev/stderr; echo y >/dev/stdout'` → files `x\n`, `y\n`, no truncation of earlier bytes); `TestShimExitAfterLastByte` (`exit.json` written only after all bytes: ends equal final sizes); `TestShimStartFailed` (`/nonexistent` → code 127, reason `START_FAILED`, stderr has the error); `TestShimLeftovers` (`sh -c 'sleep 30 & echo done'` → `exit.json` appears while shim still alive; `signal{SIGKILL, cgroup:false}` to group ends it); `TestShimInputDedup` (stdin `cat`: seq 1 "a", seq 1 "a" again → `applied:false`, file `a`); `TestShimPTYResizeAndEcho` (PTY `sh`, resize 100×40, input `stty size\n` → output contains `40 100`); `TestShimTimeout` (`sleep 30`, timeout 200 ms, grace 100 ms → `killed`, reason `TIMEOUT`); `TestShimKillGrace` (trap TERM → exits 0 within grace: status `exited`).
- [ ] **Step 2: Run** `go test ./internal/shimproto` (darwin) and the Linux container command of Task 6 for `./internal/shim` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** same commands with `-race` — Expected: PASS; `GOOS=windows go build ./...` OK.
- [ ] **Step 5: Commit** `guest-agent: shim and shim protocol`.

---

### Task 8: Supervisor (systemd transient units) and fake

**Files:**
- Create: `internal/supervisor/{supervisor.go,systemd_linux.go,systemd_other.go,fake.go}` + `fake_test.go`, `systemd_linux_integration_test.go` (tag `integration`)

**Interfaces — Consumes:** `shim` files, `shimproto`.
**Produces:**
- `supervisor.Supervisor` interface:
  - `Launch(ctx context.Context, id string, shimPath string, extraArgs []string) error` — starts `sbx-cmd-<id>.service` and returns when the shim sent READY=1 or the unit failed (`ErrUnitExists` if the name is taken).
  - `State(ctx, id) (UnitState, error)` — `UnitActive`, `UnitInactive`, `UnitNotFound`.
  - `KillCgroup(ctx, id) error` — writes `1` to `<unit cgroup>/payload/cgroup.kill`.
  - `Stop(ctx, id) error` — explicit stop (cleanup only).
  - `StartWatchdog(ctx, leaseID string, argv []string) error` / `StopWatchdog(ctx, leaseID) error` — transient `sbx-quiesce-watchdog-<lease>.service` (`Type=simple`).
- `supervisor.NewSystemd(slice string, cgroupRoot string) (Supervisor, error)` (linux) — `dbus.NewSystemConnectionContext`; properties: `Description`, `ExecStart` (`[]execStart{path, argv, false}`), `Type=notify`, `NotifyAccess=main`, `Slice=sbx-cmd.slice`, `Delegate=true`, `KillMode=control-group`, `CollectMode=inactive-or-failed`, `Environment=["GOGC=50","GOMEMLIMIT=6MiB"]`; mode `"fail"`; waits on the job channel (`done` → nil, other → error with the unit's `Result`). Unit cgroup path from `ControlGroup` property + `cgroupRoot` (`/sys/fs/cgroup`).
- `supervisor.Fake` — in-process: `Launch` records the call and runs a `FakeShim` (writes `shim.json`, files and `exit.json` per a script set by the test: `Fake.Script(id, func(*FakeRun))`); `FakeRun.Write(stream, []byte)`, `Exit(code)`, `Signal(sig)` serve `shimproto` on the socket so Task 9 tests exercise the real client.

- [ ] **Step 1: Failing tests:** `TestFakeLaunchTwiceExists`; `TestFakeServesShimProto` (status/kill through `shimproto.Client`). Integration (`-tags integration`, root, systemd): `TestSystemdLaunchNotifyAndCgroup` (launch the real shim with `sh -c 'cat /proc/self/cgroup; sleep 0.2'` → cgroup path ends with `sbx-cmd-<id>.service/payload`; unit gone after exit), `TestSystemdUnitExists` (second Launch while alive → `ErrUnitExists`), `TestSystemdKillCgroup`.
- [ ] **Step 2: Run** `go test ./internal/supervisor` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/supervisor` (integration ones run in Task 18's container; run them there now via `test/linux/run.sh ./internal/supervisor` once Task 18 exists — until then via a manual `docker run --privileged` systemd container, see Task 18 Step 1).
- [ ] **Step 5: Commit** `guest-agent: systemd supervisor`.

---

### Task 9: Process service

**Files:**
- Create: `internal/process/{service.go,manager.go,start.go,attach.go,recover.go,ptyidle.go,users.go,users_unix.go,users_windows.go}` + tests

**Interfaces — Consumes:** `store`, `supervisor.Supervisor`, `shimproto`, `shim.Spec/ShimFile/ExitFile`, `output`, `events.Emitter`, `config.Config`, `EnvBuilder` (below, implemented in Task 11; Task 9 tests use a stub).
**Produces:**
- `process.EnvBuilder` interface `{Build(u *User, spec *agentv1.CommandSpec) []string}`.
- `process.User{Name string; UID, GID uint32; Groups []uint32; Home, Shell string}`; `process.LookupUser(name string) (*User, error)` (`os/user` pure Go; `ErrUserNotFound`).
- `process.Manager` (`process.New(Options) (*Manager, error)`); `Options{Store; Supervisor; Layout; Config; Emit events.Emitter; Env EnvBuilder; ShimPath string; AgentVersion string; BootID string; Output output.Store; Now func() time.Time; PTYIdle time.Duration (10m); PTYHangupGrace time.Duration (10s); Poll time.Duration (250ms); Heartbeat time.Duration (15s); DurableTimeout time.Duration}`.
- `(*Manager) Recover(ctx) error` — §6 step 3 and §9.6: boot id changed → every `RUNNING`/`STARTING` without `exit.json` → `LOST/REBOOT` + `command.exited`; same boot → per command: `exit.json` → finalize; unit alive → connect monitor; else `LOST/SHIM_LOST`. Restores PTY idle timers from `PTYDetachedAt`.
- `(*Manager) Handler() (string, http.Handler)` — `agentv1connect.NewProcessHandler` with the options of Global Constraints and `reqcache.Interceptors`.
- Start (§9.2): validate (argv non-empty or shell; user exists → else `invalid_argument user_not_found`; running < max → else `resource_exhausted too_many_commands`); spec hash = sha256 of deterministic proto bytes of the full spec; existing id: same hash → current info (`created=false`; `STARTING` → retry path), other hash → `already_exists`; write `STARTING` (`store.Update`, `ErrFrozen` → `unavailable quiesced`); write `shim.Spec` to `CmdSpec(id)`; if `shim.json` exists or unit alive → don't launch; else `Supervisor.Launch`; after READY read `shim.json`/`exit.json` → `RUNNING`+pid (or `EXITED` START_FAILED); start the monitor goroutine. argv: shell → `/bin/bash -lc <shell>` (`-c` when `login=false`); cwd default home, relative → home-relative.
- Monitor per live command: `shimproto.Dial` with retry; on `exited` or socket loss + `exit.json` present → finalize (`EXITED` + exit + ends, `command.exited`, PTY → `pty.closed`); socket loss without `exit.json` and unit not found → `LOST/SHIM_LOST`. Leftovers: unit alive after exit → `has_leftovers`.
- Attach (§10): offsets per stream (non-PTY: stdout, stderr; PTY: pty); `tail_bytes` → `max(available_from, size−tail)`; loop with `output.ReadChunk`; waits via fsnotify on the command dir or `Poll`; `heartbeat` after 15 s silence; `exit` only after every stream offset == end; `follow=false` → send what exists and close (exit if exited). Counts `attached_clients` (and PTY idle bookkeeping: last detach writes `PTYDetachedAt`).
- Run = Start (same rules) + `started{command_id, command}` + Attach from 0.
- SendInput/Update → shim (`command_exited` after exit; `shim_outdated` passthrough); Signal (`SIGKILL` → `KillCgroup` semantics via shim `signal{cgroup:true}`); Kill (default grace 10 000; no shim → `Supervisor.KillCgroup`); both no-op on exited without leftovers; Get; List (filter state/tags, ordered by id, page token = last id, page_size default 100 max 1000); Remove (exited only → delete record and `CommandDir`; running → `failed_precondition`, detail `command_running`).
- PTY idle (§9.4): no attach for `PTYIdle` (from start if never attached) → shim `kill{grace: PTYHangupGrace, first_signal: SIGHUP, reason: PTY_IDLE}`.
- `(*Manager) Counts() (running, ptys, attaches int)` for activity.

- [ ] **Step 1: Failing tests** (all with `supervisor.Fake`, store in temp dir): `TestStartIdempotent` (same id+spec → one `Launch`, `created` false second time); `TestStartOtherSpecAlreadyExists`; `TestStartRetryAfterCrashNeverDoublesLaunch` (record `STARTING` + `shim.json` present, unit gone, no `exit.json` → `Start` does not launch, command ends `LOST/SHIM_LOST`; record `STARTING` without `shim.json` and no unit → launches once); `TestStartTooMany` (max 1); `TestStartUnknownUser`; `TestRunStartedThenDataThenExit` (fake writes 3 chunks then exit 0 → events in order `started`, data offsets 0..n, `exit` with ends); `TestAttachExitAfterAllBytes` (fake writes exit.json with ends ahead of current size, then writes the rest 100 ms later → `exit` arrives after the last data); `TestAttachTailBytes`; `TestAttachFollowFalse`; `TestAttachTruncated` (punch front before attach → `truncated` then data); `TestRecoverRebootMarksLost` (other boot id → `LOST/REBOOT` + `command.exited` recorded); `TestRecoverShimLost`; `TestSendInputAfterExit` (`command_exited`); `TestKillNoopOnExited`; `TestPTYIdleKills` (`PTYIdle: 100ms` → fake receives kill with `SIGHUP`, reason `PTY_IDLE`; with an attach open it does not); `TestListPaging`; `TestRemoveRunningRefused`; `TestStartWhileFrozen` (`store.SetFrozen(true)`, ctx 100 ms → `unavailable` detail `quiesced`).
- [ ] **Step 2: Run** `go test ./internal/process` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race -count=2 ./internal/process` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: Process service`.

---

### Task 10: Files: Filesystem service, `/files` HTTP, uploads, archive

**Files:**
- Create: `internal/files/{resolve.go,owner.go,owner_unix.go,owner_windows.go,service.go,http.go,download.go,uploads.go,archive_get.go,archive_put.go,archive_put_linux.go,archive_put_other.go}` + tests

**Interfaces — Consumes:** `store` (uploads), `process.LookupUser`, `errs`, `reqcache.Interceptors`.
**Produces:**
- `files.Service` (`files.New(Options)`): `Options{Store; Layout; DefaultUser string; Now func() time.Time; UploadTTL time.Duration (24h); MaxChunk int64 (8<<20); ArchiveMaxEntries int (200000); ArchiveMaxBytes int64 (16<<30); ArchiveMaxPath int (4096)}`; `(*Service) ConnectHandler() (string, http.Handler)`; `(*Service) HTTPHandler() http.Handler` mounted at `/files` and `/files/` (exact paths below; anything else 404); `(*Service) Janitor(ctx)` (expired uploads removed hourly).
- `files.Resolve(p string, u *process.User) (string, error)` — `""` → `invalid_argument invalid_path`; `~`, `~/x`, relative → under `u.Home`; `filepath.Clean`; NUL → `invalid_path`.
- Upload id: `^[A-Za-z0-9_-]{1,128}$`, else `400 invalid_path` (confinement of `uploads/<id>` against escaped segments: the handler takes the id from `r.URL.EscapedPath()` segments and rejects any `%2F`, `%5C`, `.`/`..`).
- HTTP per spec §11.2: `GET|HEAD /files` (`http.ServeContent`; multi-range header (contains `,`) deleted first; `ETag "<ino>-<size>-<mtime_ns>"`; dir → `400 is_directory`); `PUT /files` (tmp `.sbx-tmp-<rand>` in target dir, fsync, chown, chmod `mode` default 0644, rename; `make_parents` default true); `PUT /files/uploads/{id}?offset=&path=` (temp file under `UploadsDir/<id>` if `path` is on the same device as `StateDir`, else `.sbx-upload-<id>` in the target dir; record in store; offset ≠ size → `409` + `Sbx-Upload-Offset`; chunk > 8 MiB → `413 payload_too_large`); `HEAD /files/uploads/{id}` (`Sbx-Upload-Offset` or `404 upload_not_found`); `POST .../commit` (JSON body; committed result stored in the upload record and replayed for 24 h; `sha256` mismatch → `422 checksum_mismatch`, upload deleted; `EXDEV` → copy+fsync+rename); `DELETE /files/uploads/{id}`; `GET /files/archive` (pax tar, optional gzip, `filepath.WalkDir` without following symlinks, hardlinks as files, skip sockets/FIFOs/devices, root not dir → `400 not_directory`; mid-stream error aborts via `http.ErrAbortHandler` panic so no trailing blocks); `PUT /files/archive` (linux: every entry opened relative to a dir fd of `path` with `unix.Openat2(dirfd, rel, &OpenHow{Resolve: RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS})`; symlink entries created with `Symlinkat` into the confined parent; hardlink target must be an earlier entry of this archive; abs path, `..`, devices, FIFOs → `400 invalid_path` with `entries_written` in the JSON error; limits → `413`; mode from header `&^ (setuid|setgid)`; owner = request user; mtime kept; `overwrite=false` + exists → `409 already_exists`; response `{path, entries, size}`; other OSes: `os.Root` based fallback).
- `(*Service) UploadPath(id string) (string, error)` — temp file of a live upload or the path of its commit result (used by `ApplyUpdate`); `upload_not_found` otherwise.
- Ownership: new files/dirs get `owner` (or request user) uid/gid via `os.Lchown`; `Chmod` handles `owner`/`group` names and `recursive` (no symlink following).
- Filesystem RPCs per §11.4 with errno mapping (`errs.FromErrno`); `List` depth 1–8, `include_hidden` default true, `page_size ≤ 10000` (default 1000), sorted by path, token = last path; `Move` across devices: file → copy+remove, dir → `failed_precondition cross_device`; `Remove` missing → `existed=false`, recursive removal does not follow symlinks.

- [ ] **Step 1: Failing tests** (HTTP via `httptest`, user = current user): `TestDownloadRangeAndETag` (Range `bytes=10-19` → 206, 10 bytes; `If-Range` with stale ETag → 200 full; `bytes=0-1,4-5` → 200 full); `TestDownloadDirIsDirectory`; `TestPutAtomic` (concurrent reader never sees partial content: write 8 MiB, reader loop sees old or new size only); `TestUploadChunksResume` (2 chunks, wrong offset → 409 and header `Sbx-Upload-Offset: <n>` matching `^[0-9]+$`, HEAD returns same, commit twice → same `FileInfo`, sha mismatch → 422 and upload gone); `TestUploadIDConfinement` (`/files/uploads/..%2F..%2Fx`, `/files/uploads/a%2Fb`, `/files/uploads/.` → 400 `invalid_path`, nothing created outside `UploadsDir`); `TestArchiveRoundTrip` (tree with nested dirs, symlink, hardlink, 3 MiB file, mode 0750 dir → GET then PUT into another dir: same sha256, modes, symlink targets); `TestArchiveHostile` (entries `../x`, `/etc/x`, symlink `l -> /` then `l/x`, pre-existing symlink in target `t -> /tmp/outside` then `t/x`, char device, FIFO → each `400 invalid_path`; outside dir unchanged) — Linux-only file `archive_put_linux_test.go` plus the portable subset; `TestArchiveTooManyEntries` (`ArchiveMaxEntries: 10`, 11 entries → 413); `TestFilesystemRPCs` (Stat no_follow, List depth 2 paging with token, MakeDir existing → `created=false`, Move overwrite=false onto existing → `already_exists`, Remove missing → `existed=false`, Chmod recursive); `TestResolveHome` (`~/a` → home/a, `a` → home/a).
- [ ] **Step 2: Run** `go test ./internal/files` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/files` on darwin and in the Linux container (Task 6 command) — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: files API, uploads and archives`.

---

### Task 11: Claim, env, secrets, SSH CA, readiness, desktop seam

**Files:**
- Create: `internal/readiness/readiness.go` + test; `internal/ext/ext.go`; `internal/claim/{claim.go,envfile.go,secrets.go,secrets_linux.go,secrets_other.go,envbuilder.go,dockerphase.go}` + tests

**Interfaces — Consumes:** `store` (claim), `paths`, `fsutil`, `events.Emitter`, `ident.ValidHostname`, `ident.Resetter.SetHostname`, `process.User`, `docker.Client.Ping` (Task 14 defines `docker.Client`; Task 11 uses a `func(ctx) error` pinger).
**Produces:**
- `readiness.Tracker` (`readiness.New(required []string, emit events.Emitter, now func() time.Time)`): `Set(phase string, state agentv1.PhaseState, errMsg string)` (emits `readiness.changed` only on change), `Phases() []*agentv1.Phase` (order: agent, identity, claim, secrets, docker, then extras), `Ready() bool`, `ReadyAt(phase) time.Time` (monotonic marks for `doctor`, S5 §17.3), `Wait(ctx, phase)`.
- `ext.Extension` interface `{Name() string; PlatformEnv() map[string]string; Phases() []string; AfterClaim(ctx context.Context, first bool) error}` — no implementation; the claim manager and env builder iterate a `[]ext.Extension` (empty now).
- `claim.Manager` (`claim.New(Options)`): `Options{Store; Layout; Ready *readiness.Tracker; Emit; Hostname func(string) error; DefaultUser string; Extensions []ext.Extension; ReloadSSH func(ctx) error}`; methods `Claim(ctx, *agentv1.ClaimRequest) (*agentv1.ClaimResponse, error)`, `UpdateEnv`, `UpdateSecrets`, `UpdateSshCa`, `PrepareStop(ctx) error`, `Start(ctx) error` (boot: mount `SecretsMount` tmpfs if not mounted (Decision 6), mkdir `secrets/` 0750 `root:<user>`, `files/`, `cmd-spec/` 0700, create empty `secrets/env` and `/etc/sbx/env` if missing; phases `claim` from store, `secrets` = ready if no claim or digest empty or tmpfs content digest matches, else pending).
- Claim rules (§8.1 + Decision 3): identity phase not ready → `unavailable identity_not_ready`; stored claim with same `RequestHash` → stored response; different hash: `reason` RESUME/RECOVER and same `sandbox_id` → apply env+secrets+CA as updates; else `failed_precondition already_claimed`. Steps 1–6 idempotent; secret limits (≤1 MiB each, ≤8 MiB total, name `[A-Za-z0-9._-]{1,128}`, `link_path` absolute) → `invalid_argument`; `UpdateEnv`/`UpdateSecrets`/`UpdateSshCa` before claim → `failed_precondition not_claimed`.
- `claim.FormatEnvFile(env map[string]string) []byte` — sorted `KEY="VALUE"` lines with `"`→`\"` and `\`→`\\`; keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; values with `\n`, `\r` or NUL skipped (pam_env format checked by Task 18 `TestPamEnvSSH`).
- `claim.SecretsDigest(env map[string]string, files []*agentv1.SecretFile) string` — sha256 over a canonical encoding (sorted keys/names; length-prefixed fields).
- `claim.EnvBuilder` implementing `process.EnvBuilder` (§8.2 order: base `HOME USER LOGNAME SHELL PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/<uid>` + `TERM` for PTY → platform `SBX=1 SBX_SANDBOX_ID SBX_PORT_DOMAIN __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.<port_domain>` (+ extensions) → claim env → secret env (from tmpfs `secrets/env` cache in memory) → spec env).
- Docker phase: `claim.WatchDocker(ctx, tr, enabled bool, active func(ctx) bool, ping func(ctx) error)` — disabled → `DISABLED`; every 2 s until ready, then every 30 s.

- [ ] **Step 1: Failing tests:** `TestTrackerEmitsOnChangeOnly`; `TestTrackerReady` (required set); `TestClaimAppliesAll` (hostname func called with value; `/etc/sbx/env` has env + platform keys; `secrets/env` and `files/<name>` mode 0440; `link_path` symlink points into tmpfs; CA file written; empty CA list → template copy; events `claim.applied` and `readiness.changed`; store has no secret value: grep the bbolt file bytes for a unique secret string → absent); `TestClaimReplaySameRequest`; `TestClaimOtherContentAlreadyClaimed`; `TestClaimResumeSameSandbox`; `TestClaimIdentityNotReady`; `TestClaimBadHostname`; `TestSecretsPendingAfterReboot` (new Manager over same store, empty tmpfs dir → `secrets` pending; `UpdateSecrets` → ready); `TestPrepareStopWipes`; `TestFormatEnvFile` (quotes, backslash, newline skipped, bad key skipped); `TestEnvBuilderOrder` (spec env beats secret env beats claim env beats platform).
- [ ] **Step 2: Run** `go test ./internal/readiness ./internal/claim` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/readiness ./internal/claim` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: claim, env, secrets, readiness`.

---

### Task 12: Ports scanner and CONNECT dialer

**Files:**
- Create: `internal/ports/{scan.go,scan_linux.go,scan_other.go,owner_linux.go,dial.go,count.go}` + tests

**Interfaces — Consumes:** `events.Emitter`, `agent.DialError`.
**Produces:**
- `ports.ParseProcNetTCP(r io.Reader, v6 bool) ([]Listener, error)`; `Listener{Addr netip.Addr; Port uint16; Inode uint64}` (state `0A` only).
- `ports.Scanner` (`ports.NewScanner(Options)`): `Options{ProcDir string ("/proc"); Exclude []uint16; Interval time.Duration (1s); Debounce time.Duration (2s); Emit; LocalAddrs func() []netip.Addr}`; `Run(ctx)`; `List() []*agentv1.Port` (addresses `0.0.0.0`, `::`, loopback or local interface addrs only; owners resolved via `/proc/*/fd` → `socket:[inode]` only when the set changed; process name from `/proc/<pid>/comm`, user from status `Uid`). `ports.changed` with the full list after the set is stable for `Debounce`.
- `ports.Dialer{LocalAddrs func() []netip.Addr; Attempt time.Duration (1s); Total time.Duration (10s); Counter *Counter}`; `(Dialer) Dial(ctx, host string, port int) (net.Conn, error)` — bounds ctx with `Total` (S2 cross-scope); `localhost`/`127.0.0.1`/`""` → try `127.0.0.1`, `::1`, interface IPv4s, interface IPv6s (each `Attempt`), next on refusal; other host → only that one; all refused → `&agent.DialError{Reason: "refused"}`; any timeout and none accepted → `Reason: "timeout"`. Returned conn is wrapped so `Close` decrements `Counter`.
- `ports.Counter` with `Inc()`, `Dec()`, `Load() int64`.

- [ ] **Step 1: Failing tests:** `TestParseProcNetTCP` (fixture lines for `0100007F:1F90` LISTEN, `00000000:0050` LISTEN, an ESTABLISHED line ignored, v6 `00000000000000000000000001000000:1F90` = `::1`); `TestScannerDebounce` (fake proc dir; set changes twice within debounce → one event with the final list; excluded port 22 not reported); `TestDialOrderLoopbackV6` (listener only on `[::1]` → `Dial(ctx, "localhost", p)` succeeds); `TestDialRefused` (closed port → `*agent.DialError` reason `refused`); `TestDialStrictHost` (`127.0.0.1` given → `::1` listener not tried); `TestCounterTracksClose`.
- [ ] **Step 2: Run** `go test ./internal/ports` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/ports` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: ports and CONNECT dialer`.

---

### Task 13: System service: Info, Metrics, ListPorts, Activity, idle

**Files:**
- Create: `internal/system/{service.go,info.go,metrics.go,activity.go,idle.go}` + tests

**Interfaces — Consumes:** `readiness.Tracker`, `claim.Manager`, `ports.Scanner`, `ports.Counter`, `process.Manager.Counts`, `quiesce.Manager` (Task 14 — methods `Quiesce`, `Thaw`, `Status`; Task 13 takes an interface `Quiescer` and a stub), `update.Manager` (Task 15 — `Apply`, `Status`; interface `Updater` + stub), `events.Emitter`.
**Produces:**
- `system.Service` (`system.New(Options)`) implementing `agentv1connect.SystemHandler`; `Options{Info InfoSource; Ready; Claim; Ports; TCP *ports.Counter; Proc Counts; Quiesce Quiescer; Update Updater; Metrics MetricsSource; Emit; Now}`; `ConnectHandler() (string, http.Handler)` with `reqcache.Interceptors`.
- `system.InfoSource` interface `{Static() StaticInfo}`; `StaticInfo{Version, PreviousVersion, OS, Arch, Kernel, BootID, MachineID, DefaultUser, TunnelURL, TunnelURLSource string; BootTime time.Time; SSHHostKeys []string}`; `Info` merges hostname (`os.Hostname`), claim info, readiness, quiesce, update, `idle_since`.
- `system.Counts` interface `{Counts() (running, ptys, attaches int)}`.
- `system.ActivityLoop{Counts; TCP; Emit; Heartbeat time.Duration (60s); Tick time.Duration (1s)}` — emits `activity` on any 0↔non-0 transition of `running/ptys/tcp` and every `Heartbeat`.
- `system.IdleLoop{Counts; TCP; Sample func() (cpuPercent float64, ioBytes uint64); Window time.Duration; Tick time.Duration (10s); Emit; Now}` — §13 rules; `IdleSince() (time.Time, bool)`; emits `idle.changed{idle, since}`.
- `system.GopsutilMetrics` implementing `MetricsSource{Collect(ctx) (*agentv1.MetricsResponse, error)}` (CPU over 5 s cached sample from a background 5 s ticker, so the RPC does not block).

- [ ] **Step 1: Failing tests:** `TestActivityTransitionsAndHeartbeat` (fake clock; counts 0→1→0 → two events; 60 s idle → one heartbeat); `TestIdleRequiresWindow` (cpu 1%, io 0, no commands → idle only after window; a running command resets); `TestInfoFields` (stubs → response has readiness, ready, ssh_host_keys, claim without secrets); `TestActivityRPC`; `TestThawDelegates` (stub quiescer returns `auto_thawed` → response carries it).
- [ ] **Step 2: Run** `go test ./internal/system` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/system` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: System service, activity and idle`.

---

### Task 14: Docker client and quiesce

**Files:**
- Create: `internal/docker/docker.go` + test; `internal/quiesce/{manager.go,lease.go,freeze_linux.go,freeze_other.go,mounts_linux.go,hooks.go,watchdog.go,probe.go}` + tests; wire `quiesce-watchdog --lease <id>` and `thaw --force` in main

**Interfaces — Consumes:** `store.SetFrozen`, `supervisor.StartWatchdog/StopWatchdog`, `events.Emitter`, `paths`.
**Produces:**
- `docker.Client{Socket string ("/var/run/docker.sock"); HTTP *http.Client}`; `Ping(ctx) error`, `Running(ctx) ([]string, error)` (`GET /containers/json`, ids of state `running`), `Paused(ctx) ([]string, error)` (`?filters={"status":["paused"]}`), `Pause(ctx, id) error`, `Unpause(ctx, id) error`.
- `quiesce.Freezer` interface `{Mounts() ([]Mount, error); Freeze(path string) error; Thaw(path string) error}`; `Mount{Path, Source, FSType string}`; Linux: parse `/proc/self/mountinfo`, keep `ext4|xfs|btrfs`, not `ro`, block device source, one per source (keep the shallowest path for FIFREEZE identity, freeze order deepest first), `unix.IoctlSetInt(fd, unix.FIFREEZE, 0)` / `FITHAW` (`EINVAL` on thaw is OK).
- `quiesce.Lease{ID string; Deadline time.Time; Paused []string; Frozen []string; Hooks []string}` in `QuiesceFile` (tmpfs, JSON, rewritten after each step).
- `quiesce.Manager` (`quiesce.New(Options)`): `Options{Layout; Store *store.Store; Docker DockerAPI; Freezer; Supervisor; Emit; Now; Self string /* argv0 for watchdog */; ProbeEvery time.Duration (5s); ProbeTimeout time.Duration (15s)}`.
  - `Quiesce(ctx, leaseMs uint32, docker, fs bool) (*agentv1.QuiesceResponse, error)` — §14.2 order; `lease_ms` default 30 000, > 120 000 → `invalid_argument`; existing lease → `failed_precondition already_quiesced` (message holds lease id); docker pause ≤ 8 parallel, 5 s total; hooks from `QuiesceHooksDir` sorted, arg `freeze`, 5 s each; `unix.Sync()`; `Store.SetFrozen(true)` before FIFREEZE; `EBUSY` on a source not frozen by us → rollback + `failed_precondition frozen_by_other`; any error → rollback reverse order; watchdog unit started before step 4 plus an in-process `time.AfterFunc`.
  - `Thaw(ctx, leaseID) (*agentv1.ThawResponse, error)` — §14.3; unknown lease: marker in `QuiesceThawedDir/<id>.json` → `{auto_thawed: true, auto_thawed_at, already_thawed: true}`; else `{already_thawed: true}`. After thaw: `Store.SetFrozen(false)`, stop watchdog unit, delete lease.
  - `AutoThaw(by string)` (timer/watchdog/agent_start/foreign) — same as Thaw + marker + `quiesce.auto_thawed{lease_id, at, by}`.
  - `Startup(ctx)` — lease file present → `AutoThaw("agent_start")` before any disk write; else probe once (15 s) and `ForceThawAll` if stuck.
  - `RunProbe(ctx)` — when no own lease every `ProbeEvery`: write+`fdatasync` a probe file in `StateDir` in a goroutine; not done in `ProbeTimeout` → FITHAW all block mounts and `quiesce.auto_thawed{by: "foreign"}`.
  - `Status() *agentv1.QuiesceStatus`.
- `quiesce.Watchdog(l paths.Layout, leaseID string, f Freezer, d DockerAPI) int` — sleep until the lease deadline (re-read file), thaw like `Thaw`, write marker, exit 0. The agent picks up markers newer than its last check and emits the event if it did not thaw itself.
- `quiesce.ForceThaw(l, f, d) error` for `sbx-agent thaw --force` (FITHAW all, unpause all paused).

- [ ] **Step 1: Failing tests:** `docker`: `TestClientOverUnixSocket` (`httptest` server on a unix socket: ping, list, pause, unpause paths). `quiesce` with fake freezer/docker/supervisor: `TestQuiesceOrderAndRollback` (pause fails for the 2nd container → 1st unpaused, nothing frozen, error returned); `TestQuiesceAlready`; `TestFrozenByOther` (`EBUSY` on first freeze → rollback, `frozen_by_other`); `TestStoreFrozenDuringLease` (`Store.Frozen()` true between Quiesce and Thaw); `TestAutoThawTimer` (lease 100 ms → thaw happens, marker written, event `by: "watchdog"`, later `Thaw` returns `auto_thawed: true`); `TestStartupThawsLease` (lease file present → `agent_start`); `TestProbeForeignFreeze` (probe writer that blocks → after `ProbeTimeout` (50 ms in test) `ForceThawAll` called and `foreign` event); `TestHooksOrder` (two scripts in hooks dir write markers; freeze in name order, thaw reverse).
- [ ] **Step 2: Run** `go test ./internal/docker ./internal/quiesce` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/docker ./internal/quiesce` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: docker client and quiesce`.

---

### Task 15: Packaging, signing, install, self-update, rollback

**Files:**
- Create: `packaging/systemd/{sbx-agent.service,sbx-identity.service,sbx-agent-rollback.service,sbx-cmd.slice}`, `packaging/agent.toml`, `packaging/trust/update-keys.pub`, `packaging/embed.go`; `internal/update/{manifest.go,keys.go,pkg.go,install.go,apply.go,pending.go,rollback.go,selftest.go,versions.go}` + tests; `cmd/sbx-release/main.go` + test; wire `install-package`, `rollback [--to v]`, `selftest --schema N --shim-protos 1,2`, `version` in main

**Interfaces — Consumes:** `paths`, `fsutil`, `store` (schema), `shimproto.Version`, `supervisor`, `events.Emitter`.
**Produces:**
- Units exactly as spec §7.2 and §17.2; `sbx-agent.service` `Type=notify`, `OOMScoreAdjust=-900`, `MemoryMin=64M`, `CPUWeight=500`, `IOWeight=500`, `Restart=always`, `RestartSec=1`, `TimeoutStopSec=15`, `StartLimitIntervalSec=120`, `StartLimitBurst=5`, `OnFailure=sbx-agent-rollback.service`; rollback unit `ExecStart=/bin/sh -c 'if [ -x /usr/local/lib/sbx-agent/previous/sbx-agent ]; then exec /usr/local/lib/sbx-agent/previous/sbx-agent rollback; else exec /usr/local/lib/sbx-agent/current/sbx-agent rollback; fi'`; `sbx-cmd.slice` with `Description` only.
- `update.Manifest{Format string ("sbx-agent-manifest/v1"); Version, OS, Arch string; Files map[string]string; CreatedAt time.Time; MinRollbackVersion string}`; `update.ParseKeys(b []byte) ([]ed25519.PublicKey, error)`; `update.Verify(dir string, keys []ed25519.PublicKey) (*Manifest, error)` (sig over exact `manifest.json` bytes; every listed file sha256; no unlisted files except `manifest.sig`; `sbx-agent`, `trust/tunnel-ca.pem`, `trust/update-keys.pub` required → `signature_invalid` / `invalid_argument` codes).
- `update.Unpack(tarPath, dst string) error` — regular files and dirs only, names confined to `dst`, ≤ 512 MiB total.
- `update.Install(l paths.Layout, tarPath string, keys []ed25519.PublicKey, opts InstallOptions{Activate, InstallUnits, WriteConfig bool; Units fs.FS; Config []byte}) (*Manifest, error)` — unpack to `staging/<rand>`, verify, move to `versions/<v>` (existing identical version kept), `Activate` → `previous`=old current, `current`=v (symlink via rename), `/usr/local/bin/sbx-agent` → `current/sbx-agent`; units → `SystemdUnitDir` + `systemctl daemon-reload` + `enable sbx-identity.service sbx-agent.service`.
- `update.Manager` (`update.New(Options{Layout; Keys func() []ed25519.PublicKey /* current/trust */; Uploads func(id string) (path string, err error); SelfTest func(ctx, bin string) error; Exit func(); Emit; Now; Version string; ShimProtos func() []int; Schema int})`: `Apply(ctx, uploadID string, allowBad bool) (*agentv1.ApplyUpdateResponse, error)` — §17.4 steps 2–5 (`bad_version` if `to` in `bad-versions` without flag; same version → `invalid_argument bad_version`; `pending-update.json` exists → `failed_precondition update_in_progress`); after the response is sent calls `Exit` (the RPC wrapper uses a `connect` response-sent hook: `Exit` runs in `defer` of a goroutine waiting for handler return + 200 ms). `Confirm()` (called after first connected + Info served) → delete pending, `update.result{ok}`. `CheckPending(ctx)` on start (deadline passed → switch `current` back to `from`, write bad version, exit); `Status()`.
- `update.Rollback(l paths.Layout, to string, systemctl func(args ...string) error, sleep func(time.Duration)) error` — §17.4 rollback rules; records `rolled_back` marker file `/var/lib/sbx-agent/rollback-result.json` that the next agent start turns into `update.result{rolled_back}`.
- `update.SelfTest(l, schema int, shimProtos []int) error` — config parse, trust files present, `schema <= store.SchemaVersion`, every proto in `[1, shimproto.Version]`.
- `update.GCVersions(l, keep []string)` — keep current, previous and versions with live shims (`ShimFile.AgentVersion` of running commands).
- `sbx-release keygen --out <dir>` (writes `ed25519.key` 0600 and appends the public line to stdout); `sbx-release pack --version v --os linux --arch amd64 --binary <path> --tunnel-ca <pem> --update-keys <file> --key <ed25519.key> --out <tar>`; `sbx-release verify --keys <file> <tar>`.
- Generate the PoC key into `~/.config/sbx/update-signing/` (if absent) and commit its public line as the current key in `packaging/trust/update-keys.pub`.

- [ ] **Step 1: Failing tests:** `TestPackVerifyRoundTrip` (pack with a temp key → `Verify` ok); `TestVerifyRejects` (flipped byte in `sbx-agent`, foreign key, extra file, missing trust file → errors with detail `signature_invalid`); `TestUnpackConfined` (tar with `../x` → error, nothing outside); `TestInstallActivate` (fake layout: `current`→v2, `previous`→v1, bin link; second install of same version is a no-op); `TestApplyFlow` (fake upload path, selftest stub ok → `pending-update.json{from,to,deadline=now+120s}`, links switched, `Exit` called once after return); `TestApplyBadVersion`; `TestApplyInProgress`; `TestCheckPendingDeadlinePassed` (links back, bad version recorded); `TestRollback` (with pending → current=from, bad-versions has to, `systemctl reset-failed sbx-agent` and `start sbx-agent` called; without pending → sleep 30 s called, versions untouched; `--to v` switches); `TestSelfTestSchema`; `TestUnitsMatchSpec` (embedded `sbx-agent.service` contains each directive above).
- [ ] **Step 2: Run** `go test ./internal/update ./cmd/sbx-release` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/update ./cmd/sbx-release` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: packaging, signing, self-update and rollback`.

---

### Task 16: Agent `run` wiring, doctor, status

**Files:**
- Create: `internal/agent/{agent.go,startup.go,tunnel.go,info.go,status.go,doctor.go}` + tests; wire `run` and `doctor [--json]` in main

**Interfaces — Consumes:** everything above; `libs/tunnel/agent`, `libs/tunnel/wstransport`.
**Produces:**
- `agent.Deps` (all OS-specific pieces injectable: `Supervisor`, `IdentSource`, `Resetter`, `Freezer`, `Docker`, `Dialer transport.Dialer`, `Now`, `SdNotify func(string) error`) and `agent.Run(ctx, l paths.Layout, cfg config.Config, version string, deps Deps) error`.
- Startup order (§6 + S5 §17.3): quiesce `Startup` → mount secrets tmpfs (`claim.Start`) → open store (`GapPayload` = `JournalGap`) → `SetBootID` → identity: read source; mismatch with `identity.json` → `ident.Apply(fromAgent=true)` + warning; `ResetPending` → first event `identity.reset`, clear flag; phase `identity` ready/failed (retry every 60 s while failed, without tunnel) → `process.Recover` → `update.CheckPending` → `agent.started{reason}` (`boot` if boot id changed since last run (meta `last_boot_id`), `update`/`rollback` from pending/rollback-result, else `restart`) → readiness phases → `SdNotify("READY=1")` → start tunnel client (only when identity ready): `wstransport.NewDialer{URL: identity.TunnelURL || cfg.TunnelURL, RootCAs: <trust>/tunnel-ca.pem}`, `agent.Config{Handler: mux, Journal: store.Journal(), Info: infoFunc, Credentials: identity-backed, Identity{BootID, InstanceID: uuid v4 per process, Vmgenid: "", Version}, Dial: ports.Dialer.Dial, OnConnEvent}` → background loops (janitor 1 s, uploads janitor, ports scanner, activity, idle, docker phase, probe, status.json 5 s, versions GC hourly).
- Mux: Process, Filesystem, System Connect handlers, `/files` and `/files/` → files HTTP handler.
- `Info` callback: `InfoResponse{AgentVersion, Os, Arch, ProtoPackages: ["sbx.agent.v1"], Capabilities: ["process.v1","process.pty","process.stdin","files.v1","files.upload.v1","files.archive.v1","system.claim.v1","system.quiesce.v1","system.update.v1","system.ports.v1","system.metrics.v1","system.activity.v1"]}`; a call after a `connected` event confirms a pending update.
- Status: `/run/sbx-agent/status.json` every 5 s `{version, pid, tunnel: {connected, gateway, conn_id, epoch, last_error, since}, identity, readiness, quiesce, update, log_dropped, updated_at}` (never BS/MT).
- `doctor --json`: versions (`current`, `previous` link targets), unit states (`systemctl is-active` for `sbx-identity`, `sbx-agent`), identity from `identity.json` (no BS), effective tunnel URL + source (`smbios`|`config`), readiness with monotonic `ready_at` marks, status.json contents, quiesce lease, free space of `StateDir`; human output without `--json`.
- SIGTERM: cancel ctx → tunnel closes, store flush+close, exit 0; shims untouched.

- [ ] **Step 1: Failing tests** (all deps fakes, `memnet`-free: tunnel dialer that always fails): `TestStartupOrderIdentityReset` (identity changed → state wiped, first journal event `identity.reset` seq 1, then `agent.started`); `TestReadyBeforeTunnel` (`SdNotify` gets `READY=1` while the dialer is still failing); `TestIdentityFailedRetries` (bad serial → phase `identity` failed, no dial attempts, later good serial → ready and dial attempted); `TestAgentStartedReason` (boot vs restart); `TestStatusFileHasNoSecrets` (BS bytes absent from status.json); `TestDoctorJSONFields`.
- [ ] **Step 2: Run** `go test ./internal/agent` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** `go test -race ./internal/agent && GOOS=windows CGO_ENABLED=0 go build ./... && go build -o /tmp/sbx-agent ./cmd/sbx-agent` — Expected: PASS.
- [ ] **Step 5: Commit** `guest-agent: run wiring, doctor and status`.

---

### Task 17: In-process harness with the real S2 gateway

**Files:**
- Create: `test/harness/{harness_test.go,process_test.go,files_test.go,events_test.go,connect_test.go,system_test.go}`

**Interfaces — Consumes:** `pgtest` (Task 1), `gateway`, `registry`, `memnet`, `agent.Run`-level wiring via `agent.Deps` (fake supervisor, fake ident source, fake freezer/docker), `agentv1connect` clients.
**Produces:** `harness_test.newEnv(t) *env` (Postgres via `pgtest.New`, one gateway (`gateway.New` with `fastTiming()` copied from `libs/tunnel/internal/e2e`), `memnet` network, service token, the agent running `agent.Run` in a goroutine with `Deps.Dialer = net.Dialer()`), `env.rpcURL()` (`<internal>/v1/machines/<id>/rpc`), `env.filesURL()`, `env.cut()` (memnet `CutAll`), `env.restartAgent()` (cancel and re-run over the same layout and store), `env.sink` recording delivered events.

- [ ] **Step 1: Write the scenarios:** `TestHarnessRunThroughGateway` (Run via gateway: started → data → exit, bytes equal script); `TestHarnessAttachAcrossCut` (cut mid-stream, re-attach from last offset, concatenated bytes equal, exit once); `TestHarnessAttachAcrossAgentRestart`; `TestHarnessStartRequiresNoRequestID` and `TestHarnessMutationRequiresRequestID` (`Filesystem/MakeDir` without header → `invalid_argument request_id_required`; replay with header → same response); `TestHarnessUploadOffsetHeaderPasses` (409 through gateway carries `Sbx-Upload-Offset`); `TestHarnessArchiveThroughGateway`; `TestHarnessEventsDelivered` (command exit → sink gets `command.exited` with `Any` payload decoding to `CommandExited`; acked seq advances; restart agent → no redelivery below ack); `TestHarnessConnectRefusedHeader` (CONNECT to a closed port via `MachineConn.DialTCP` → 502; assert on the agent side with a direct h2 CONNECT that `Sbx-Dial-Error: refused` is set); `TestHarnessCapabilities` (`tunnel_sessions.capabilities` contains `files.archive.v1` and `system.activity.v1`); `TestHarnessQuiesceThaw` (fake freezer; `Quiesce` then `Thaw` with request ids; events journal flushed after thaw).
- [ ] **Step 2: Run** `cd services/guest-agent && mise exec -- go test -race ./test/harness` — Expected: failures point to wiring bugs only (all packages exist); fix them in the owning package with a regression unit test there.
- [ ] **Step 3: Verify** `go test -race -count=2 ./test/harness` — Expected: PASS.
- [ ] **Step 4: Commit** `guest-agent: in-process gateway harness`.

---

### Task 18: Linux systemd container: integration tests

**Files:**
- Create: `test/linux/Dockerfile`, `test/linux/run.sh`, `test/integration/{main_test.go,commands_test.go,pty_test.go,restart_test.go,retention_test.go,freeze_test.go,identity_test.go,ssh_test.go,update_test.go}` (all tag `integration`)

**Interfaces — Consumes:** the built `sbx-agent` binary, `sbx-release`, `agentv1connect` clients over a unix socket debug listener: `sbx-agent run --debug-listen unix:/run/sbx-agent/debug.sock` (flag added in this task to `run`, root-only socket 0600, serves the same mux without the tunnel; documented as a test/QGA aid).
**Produces:**
- `Dockerfile`: `FROM ubuntu:26.04` (fallback `ubuntu:25.10` if the tag is missing — record which), packages `systemd systemd-sysv dbus openssh-server openssh-client e2fsprogs python3 sudo iproute2 curl ca-certificates`; user `user` uid 1000 groups `sudo`; sudoers NOPASSWD; sshd config per §20 + `pam_env` lines of §8.2; `STOPSIGNAL SIGRTMIN+3`; `CMD ["/sbin/init"]`.
- `run.sh [go test args]`: builds `sbx-agent` and the integration test binary for `linux/$(go env GOARCH)` (`CGO_ENABLED=0`), starts the container `--privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock`, installs a dev-signed package with `sbx-agent install-package --activate --install-units --write-config` (dev key generated per run), writes a fake smbios dir and points `agent.toml` `[identity] sysfs_dir` at it (config field `IdentityDir`, default `/sys/class/dmi/id`, added in this task), starts `sbx-agent.service`, runs the test binary as root, removes the container.
- Tests (each maps to spec §21 items): `TestCommandsExactOutput` (1: sha256 of 8 MiB stdout; `/dev/stderr` reopen as `user` and root; repeated Start after `kill -9` of the agent between record and answer → `shim.json` created once); `TestAgentRestartKeepsCommand` (2: `systemctl restart sbx-agent` and `kill -9` during a 60 s command and an open PTY: attach continues by offset, exit correct, PTY scrollback intact); `TestPTY` (5: resize, duplicate seq, idle close with `PTYIdle` overridden to 3 s via `agent.toml [process] pty_idle = "3s"` test-only key, alive at 2 s); `TestLeftovers` (6); `TestTimeoutAndOOM` (7: `timeout_ms` → `KILLED/TIMEOUT`; OOM via a transient `MemoryMax` on `sbx-cmd.slice` set by the test to 64M and `python3 -c 'b=bytearray(512<<20)'` → `KILLED/OOM`, agent alive); `TestRetention` (8: per-stream 8 MiB via config, write 64 MiB → used ≤ 8 MiB + slack, attach from 0 gets `truncated`); `TestFreezeLoopExt4` (11 partial: loop-mounted ext4 under `/mnt/fz`, `Quiesce` freezes it (a writer blocks), `Thaw` releases; lease without thaw → auto-thaw by deadline + 5 s and `Thaw` reports `auto_thawed`; `kill -9` agent in freeze → thaw on start; `fsfreeze -f` by hand → agent thaws within 15–20 s); `TestIdentityApply` (12 partial: change the fake smbios serial, `systemctl restart sbx-identity sbx-agent` → new machine-id, new host keys, hostname `sbx-…`, journal starts at `identity.reset` seq 1); `TestClaimEnvAndSSH` (13: claim with env, secret env, secret file and a CA generated by the test; `ssh -i key -o CertificateFile=… user@127.0.0.1 env` shows env and secret env; login shell too; spec env beats claim env; `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` set; `UpdateSshCa` to a new CA works without restarting sshd); `TestPamEnvFormat` (values with spaces, quotes, `$`, backslash arrive unchanged in `ssh env`); `TestSecretsNotOnDisk` (14 partial: `grep -a` of a unique secret over `/var/lib/sbx-agent` and `/etc` → none; `/run/sbx` mount options contain `noswap` when the kernel supports it); `TestUpdateAndRollback` (3: upload a good v2 package → `update.result{ok}` after reconnect... in the container there is no gateway, so confirmation is driven by `--debug-listen` serving `Control/Info`; a package whose binary exits 1 → after `StartLimitBurst` rollback to v1 and `update.result{rolled_back}`; wrong signature → `signature_invalid`); `TestMemory` (15: idle agent RSS < 40 MiB, shim RSS < 8 MiB from `/proc/<pid>/status` `VmRSS`).
- [ ] **Step 1: Build the container and a smoke test** `TestContainerSmoke` (agent active, `doctor --json` ok). Run `services/guest-agent/test/linux/run.sh -run Smoke -v` — Expected: PASS.
- [ ] **Step 2: Add the scenario tests one by one; run each** with `run.sh -run <Name> -v`; a failure is fixed in the owning package with a unit regression test first.
- [ ] **Step 3: Run Task 8's integration tests here too:** `run.sh -run 'Systemd' ./internal/supervisor` (the script accepts a package path).
- [ ] **Step 4: Verify** `run.sh -v` — Expected: all PASS; note in the plan any item that cannot run in a container (Docker pause, real fork) — those go to the `pve` stand.
- [ ] **Step 5: Commit** `guest-agent: Linux systemd container integration tests`.

---

### Task 19: CI, cross-checks, docs

**Files:**
- Create: `.github/workflows/guest-agent.yml`
- Modify: `docs/plans/s3-guest-agent.md` (results, deviations found during implementation), `services/guest-agent/README.md` (build, package, install, test commands)

- [ ] **Step 1: CI workflow:** on push/PR touching `services/guest-agent/**`, `proto/sbx/agent/**`, `libs/**`: jobs `unit` (ubuntu-latest: mise install, `go test -race ./...` in `services/guest-agent`, `libs/tunnel`), `lint` (golangci-lint, `go vet`), `windows` (`GOOS=windows CGO_ENABLED=0 go build ./...`), `proto` (`buf lint`, `buf generate` + `git diff --exit-code`, `buf breaking --against .git#branch=main` when `main` has the files), `integration` (ubuntu-latest, `test/linux/run.sh -v` with Docker).
- [ ] **Step 2: Full local verification** — run and paste results into the plan's results section:
  - `pnpm -r test && pnpm lint && pnpm build`
  - for each of `libs/proto libs/tunnel services/node-agent services/guest-agent`: `go test -race ./... && go vet ./... && golangci-lint run ./...`
  - `cd proto && buf lint && buf generate && git status --porcelain` (empty)
  - `GOOS=windows CGO_ENABLED=0 go build ./...` in `libs/tunnel` and `services/guest-agent`
  - `services/guest-agent/test/linux/run.sh -v`
  Expected: all green.
- [ ] **Step 3: Commit** `guest-agent: CI and docs`; push `s3-impl`.

---

## pve stand (after the master frees the host)

Not a task of this plan's execution order: when the master allows, install the package into a VM cloned from 599 (VMID ≥ 500, ≤ 8 GB total, cleanup after) and run spec §21 items 1–15 that the container cannot cover: real fork identity change and different IP (12), Docker pause during quiesce and a snapshot via S1 (11), secrets grep over the LV snapshot (14), reboot → `LOST/REBOOT` and `secrets: pending` (4).

---

## Results and deviations (implementation)

### Decisions added during implementation

- **Request outcome store (Task 4).** The outcome is stored with `context.WithoutCancel` and a 5 s limit, not the call's context. While the agent's own store is frozen (spec §14.4), answers are kept in an in-memory pending map that lookups consult and that is flushed after thaw. A crash during a freeze loses those cache entries (accepted by the spec). Quiesce's own answer is stored while frozen.
- **Output offsets (Task 6).** The plan's value 294 912 was an arithmetic error; `300000 &^ 4095 = 299 008` is correct.
- **pam_env (Task 11).** `/etc/security/sbx-env` lines are `KEY="<raw value>"` without escaping, because pam_env does not unescape. Values containing `#`, CR, LF, NUL or lines over 8 KiB are skipped (they reach agent commands only). Replaces the plan's escaping.
- **link_path (Task 11).** Only an existing symlink or nothing is replaced. An existing regular file is moved to `<path>.sbx-orig` with a warning, so a claim never fails because the user created the file. Parents are created root-owned except under the user's home.
- **Dial order (Task 12).** `127.0.0.1` tries the ordered address list; strict host matching applies only to other addresses (the spec wins over the brief text).
- **Activity event (Task 13).** An `activity` event is also emitted once at loop start, so counters are fresh after an agent restart (S6 treats it as latest state).
- **idle.changed (Task 13).** Leftover-only commands count as busy (stricter than §13), following S6 §12: `runningCommands` includes any process under a shim. A VM with daemonized leftovers never reports `idle.changed{idle:true}`.
- **Quiesce budget (Task 14).** The freeze phase has a total 5 s cap (S1 budget) with rollback; per-step budgets stay inside it. A VM with many containers or slow hooks fails Quiesce and S1 falls back to the QGA path.
- **Startup order (Task 16).** Identity apply runs before `store.Open` (`Apply` wipes `state.db`). The agent exits 0 when a late-valid serial belongs to a different machine than `identity.json`, so the restart applies the identity.
- **Debug socket (Task 16).** `sbx-agent run --debug-listen unix:<path> [--debug-confirm]` serves the agent API and `Control/Info` on a root-only 0600 socket with the same interceptors. Used by the integration tests.
- **Template contract for S5 (Task 18).** Ubuntu's `~/.bash_logout` clears the screen on login-shell exit, which breaks byte-exact output for `bash -lc ...; exit`. The template must remove `/etc/skel/.bash_logout` and `/home/user/.bash_logout`. The agent is unchanged. The stand also showed that template 599 runs cloud-init, which resets the hostname of a fork; per spec §20 cloud-init must not manage hostname or host keys (S5 plans `/etc/cloud/cloud-init.disabled`).
- **Shim memory (Task 18).** The 8 MiB target is read as private (non-shared) memory: 3.4-7.2 MiB in the container, 2.9 MiB in the VM. Total VmRSS is 13-17 MiB because the binary's file pages are shared.
- **systemd restart mode (Task 18).** Spec §17.2 is amended with `RestartMode=direct`: with systemd >= 254 `OnFailure` fires on every auto-restart otherwise.
- **Recover of an unlaunched command (Task 20).** After a restart in the same boot, a `STARTING` record with no `shim.json` and no unit stays `STARTING` and holds no slot, so the caller's retry of `Start` launches it once (spec §9.2 step 5). After a reboot it is `LOST/REBOOT`. A record nobody retries stays `STARTING`.
- **Task 17b: worker adapter.** `apps/worker/src/adapters/agent-connect.ts` (`ConnectAgentPort`, on `@sbx/agent-client` and `@sbx/proto/agent/v1`) replaces `UnavailableAgentPort` in the worker wiring when `SBX_GATEWAY_SERVICE_TOKEN_FILE` is set. Claim, `updateEnv` and `updateSecrets` send `Sbx-Request-Id`; the quiesce hook uses one request id per hook for freeze and one for thaw, keeps the outcome of the first thaw that reached the agent (a retried `hook.thaw()` cannot accept an invalid snapshot), and maps `auto_thawed` to `QuiesceFailed`. Only `ClaimReason.CLAIM` is mapped, since `ports.ts` allows only `"claim"`.

### Extra detail codes (beyond spec §19)

- `shim_unavailable` (retryable, `unavailable`), `invalid_argument`, `failed_precondition` (Task 9). S6/S7 must map one more retryable code.
- `lease_expired` (`aborted`), `quiesce_timeout` (`deadline_exceeded`), `store_busy` (`unavailable`) (Task 14).
- From the plan header: `invalid_path`, `payload_too_large`, `upload_not_found`, `bad_version`, `quiesced`.

### Lint fix found in Task 19

`GOOS=linux golangci-lint run ./...` reported `contextcheck` at `cmd/sbx-agent/run.go:59` (`supervisor.NewSystemd` used `context.Background()`; invisible on darwin because the Linux file is not type-checked there). `NewSystemd` now takes the caller's context for the godbus connection.

### pve stand (Task 20, 2026-10-29/30)

`sbx-bench s3` on the pve node, VM cloned from template 599 (Ubuntu 26.04.1, systemd 259, kernel 7.0), all checks PASS and all VMs, snapshots and LVs deleted afterwards:

- A. package installed, agent active without a tunnel, `doctor --json` ok.
- B. the container integration suite inside the VM: exit 0 in 130 s (`TestFreezeLoopExt4` skipped, it asserts the loop fs is the only freezable mount).
- C. reboot: command `EXITED LOST/REBOOT`, output intact, `secrets` back to `pending`, `UpdateSecrets` restores it (item 4).
- D. Quiesce with a running Docker container and an S1 snapshot: frozen `[/boot /]`, container paused and resumed, freeze to thaw 3.9 s (S1 budget 10 s); a write during the freeze blocked until Thaw; watchdog auto-thaw verified with `quiesce.auto_thawed{by: watchdog}` (item 11).
- E. fork from the snapshot: new machine id, `/etc/machine-id`, host keys, hostname `sbx-<serial>`, empty agent state, journal starts at `identity.reset` seq 1, different IP; the source VM unchanged (item 12).
- F. secrets: raw `/dev/sda` grep of the source VM and of the fork booted from the LV snapshot, 0 matches for env, file and spec-env secrets, positive control found (item 14).
- G. memory: idle agent VmRSS 18.7 MiB (private 8.8 MiB); shim VmRSS 12.9 MiB, private 2.9 MiB (item 15).

Production fix found on the stand: Recover of an unlaunched `STARTING` command (see Decisions), regression test `TestRecoverKeepsUnlaunchedStarting`.

Observations for other scopes: qemu-ga logs the full argv of every `guest-exec` in the guest journal, so no QGA path may pass secrets in arguments; Proxmox refuses `agent/exec` `input-data` over 64 KiB.

### Full local verification (Task 19, 2026-10-30, darwin/arm64)

All green.

| Command | Result |
|---|---|
| `pnpm -r test` | pass: config 16, pve 118, bench 15, db 60, agent-client 143, core 295, worker 331 (+5 skipped) |
| `pnpm lint` | pass (biome, 275 files) |
| `pnpm build` | pass |
| `go test -race -count=1 ./...` in `libs/proto`, `libs/tunnel`, `services/node-agent`, `services/guest-agent` | pass in all four |
| `go vet ./...` in the same four | clean |
| `golangci-lint run ./...` in the same four | 0 issues each |
| `GOOS=linux golangci-lint run ./...` and `--build-tags integration` in `services/guest-agent` | 0 issues (after the `NewSystemd` fix) |
| `cd proto && buf lint && buf generate && buf generate --template buf.gen.test.yaml` | pass, `git status --porcelain` for `proto/` and generated dirs empty |
| `GOOS=windows CGO_ENABLED=0 go build ./...` in `libs/tunnel` and `services/guest-agent` | pass |
| `services/guest-agent/test/linux/run.sh -v` | exit 0: 14 tests PASS (`TestCommandsExactOutput`, `TestLeftovers`, `TestTimeoutAndOOM`, `TestIdentityApply`, `TestContainerSmoke`, `TestPTY`, `TestAgentRestartKeepsCommand`, `TestRetention`, `TestMemory`, `TestClaimEnvAndSSH`, `TestPamEnvFormat`, `TestSecretsNotOnDisk`, `TestUpdateAndRollback`, `TestFreezeLoopExt4`); 6 `TestStand*` SKIP (pve stand only) |

Items the container cannot cover (Docker pause, real fork, LV snapshot grep, reboot) are covered by the pve stand above.
