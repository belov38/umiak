# sbx guest agent

`sbx-agent` runs inside a sandbox VM (Linux with systemd, Windows 11 as a service). It dials the tunnel gateway and serves the
agent API: commands and PTYs, files, TCP streams, events, claim/secrets, quiesce for snapshots,
identity reset on fork, self-update. Spec: `docs/specs/s3-guest-agent.md` (Windows:
`docs/specs/s9-windows.md` section 12), plan: `docs/plans/s3-guest-agent.md`.

Binaries:

- `cmd/sbx-agent` - the agent and its helper subcommands (`run`, `identity`, `install-package`, `rollback`, `doctor`, `version`, ...).
- `cmd/sbx-release` - builds, signs and verifies packages.

Run Go tools through mise: `mise exec -- go ...`.

## Build

```sh
cd services/guest-agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 mise exec -- go build \
  -ldflags "-X main.version=<v>" -o dist/sbx-agent ./cmd/sbx-agent
```

For Windows build `GOOS=windows` into `dist/sbx-agent.exe`.

`sbx-release pack` refuses a binary whose `version` output differs from `--version`, and refuses
integration test builds (`main.failRun`, `main.devUpdateKey`). A binary for another platform needs
`--skip-version-check`.

## Package

A package is a signed tar with the binary, the tunnel CA and the update keys; the systemd units and
the `agent.toml` template are embedded in the binary. Entries sit at the archive root without a
`./` prefix. The binary is `sbx-agent`, or `sbx-agent.exe` in a `--os windows` package.

```sh
mise exec -- go run ./cmd/sbx-release keygen --out ./keys            # ed25519.key (0600) + public key line
mise exec -- go run ./cmd/sbx-release pack --version <v> --os linux --arch amd64 \
  --binary dist/sbx-agent --tunnel-ca ca.pem \
  --update-keys packaging/trust/update-keys.pub --key ./keys/ed25519.key --out sbx-agent-<v>.tar
mise exec -- go run ./cmd/sbx-release verify --keys packaging/trust/update-keys.pub sbx-agent-<v>.tar
```

The signing key must be listed in `--update-keys` (a file of `ed25519 <base64> <comment>` lines).
`packaging/trust/update-keys.pub` is embedded into the binary and is the trust root for later updates.

`infra/templates/agent-package.sh --tunnel-ca <pem> --out <dir> [--os linux|windows]` does the build,
pack and verify in one step and prints the tar path (`sbx-agent-<v>-<os>-amd64.tar`).

## Install

On the target VM, as root, with the package tar copied to it:

```sh
sbx-agent install-package --write-config sbx-agent-<v>.tar
```

This places the version under `/usr/local/lib/sbx-agent`, switches `current`, installs the units into
`/etc/systemd/system` and enables `sbx-identity` and `sbx-agent`. `--write-config` writes the
`agent.toml` template if absent (see `packaging/agent.toml`); `--no-activate` and `--no-units` skip
the switch and the units. Check with `sbx-agent doctor [--json]`; `sbx-agent rollback` undoes an
unfinished update.

On Windows, as an administrator (the image step extracts the installer first with
`tar -xf <tar> sbx-agent.exe`):

```powershell
.\sbx-agent.exe install-package --write-config sbx-agent-<v>-windows-amd64.tar
```

This places the version under `C:\Program Files\sbx-agent\versions\<v>`, points the `current` and
`previous` junctions, writes `C:\ProgramData\sbx-agent\agent.toml` with `--write-config`, adds
`current` to the system `Path` and creates or updates the `sbx-agent` service: LocalSystem, Automatic
(not delayed), `"C:\Program Files\sbx-agent\current\sbx-agent.exe" run`, preshutdown timeout 15 s,
failure actions restart after 1 s, restart after 1 s, then run `rollback` of `previous` (of `current`
when there is no previous), reset after 120 s, also on non-crash failures. The install never starts
the service: an image build VM must not run the agent before sysprep, so it starts at the next boot.
`--no-units` skips the service.

Under the service control manager `run` reports `SERVICE_RUNNING` once state.db is open and the
shims are recovered, runs at `ABOVE_NORMAL` priority and logs to
`C:\ProgramData\sbx-agent\logs\agent.log` (10 files of 10 MiB). `PRESHUTDOWN` wipes the secret
files and flushes state.db (at most 10 s) before the shutdown. A self-update, a reverted update or a
changed identity ends the process with exit code 75 without `SERVICE_STOPPED`, so the failure
actions start the new current version. Started from a console, `run` runs in the foreground until
Ctrl+C. Switching versions deletes and recreates a junction (no atomic rename); `pending-update.json`
and the rollback cover a crash in between. `doctor` on Windows reports the service state, whether
its configuration (failure actions, start type, preshutdown timeout) matches, and whether
`early.json` belongs to the current boot.

## Tests

```sh
cd services/guest-agent
mise exec -- go test -race ./...           # unit tests and the harness
mise exec -- golangci-lint run ./...
GOOS=linux mise exec -- golangci-lint run --build-tags integration ./...
GOOS=windows CGO_ENABLED=0 mise exec -- go build ./...
GOOS=windows mise exec -- go vet ./...     # compiles the *_windows_test.go files
GOOS=windows mise exec -- golangci-lint run ./...
```

The Windows-only tests (junctions, the service install under a throwaway service name, the service
handler) run on a Windows machine as an administrator.

- `test/harness` runs the real tunnel gateway against the agent. It needs Postgres: set
  `SBX_TEST_DATABASE_URL` (admin DSN), otherwise a `postgres` container is started through the Docker
  CLI; `SBX_TEST_SKIP_PG=1` skips those tests.
- `test/linux/run.sh [-run Name] [-v] [./pkg]` runs the Linux integration tests in a privileged
  Docker container with systemd as PID 1 (cgroup v2). It builds four dev-signed packages with a key
  generated per run. `KEEP=1` leaves the container running.
- `sbx-bench s3` (`apps/bench`) runs the same tests plus reboot, quiesce with an S1 snapshot, fork
  identity and the secrets-on-disk grep inside a VM cloned from the template on the pve node. It
  needs `SBX_PVE_URL`, `SBX_PVE_TLS_NAME` and `SBX_NODE_SSH_HOST` and the credentials in
  `~/.config/sbx/`; it deletes everything it creates.

## Debug socket

`sbx-agent run --debug-listen unix:<path> [--debug-confirm]` also serves the agent API and
`Control/Info` on a root-only (0600) unix socket, without the tunnel. `--debug-confirm` lets
`Control/Info` on that socket confirm a pending update. It is a test aid used by the integration
tests; the production unit does not pass it.
