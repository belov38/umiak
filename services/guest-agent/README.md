# sbx guest agent

`sbx-agent` runs inside a sandbox VM (Linux, systemd). It dials the tunnel gateway and serves the
agent API: commands and PTYs, files, TCP streams, events, claim/secrets, quiesce for snapshots,
identity reset on fork, self-update. Spec: `docs/specs/s3-guest-agent.md`, plan:
`docs/plans/s3-guest-agent.md`.

Binaries:

- `cmd/sbx-agent` - the agent and its helper subcommands (`run`, `identity`, `install-package`, `rollback`, `doctor`, `version`, ...).
- `cmd/sbx-release` - builds, signs and verifies packages.
- `cmd/sbx-agent-harness` - test aid, never packaged: the real tunnel gateway and the agent with fake OS dependencies in one process, commands run as host processes; used by `apps/api/test/agent-real.test.ts`.

Run Go tools through mise: `mise exec -- go ...`.

## Build

```sh
cd services/guest-agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 mise exec -- go build \
  -ldflags "-X main.version=<v>" -o dist/sbx-agent ./cmd/sbx-agent
```

`sbx-release pack` refuses a binary whose `version` output differs from `--version`, and refuses
integration test builds (`main.failRun`, `main.devUpdateKey`).

## Package

A package is a signed tar with the binary, the systemd units, the tunnel CA and the update keys.

```sh
mise exec -- go run ./cmd/sbx-release keygen --out ./keys            # ed25519.key (0600) + public key line
mise exec -- go run ./cmd/sbx-release pack --version <v> --os linux --arch amd64 \
  --binary dist/sbx-agent --tunnel-ca ca.pem \
  --update-keys packaging/trust/update-keys.pub --key ./keys/ed25519.key --out sbx-agent-<v>.tar
mise exec -- go run ./cmd/sbx-release verify --keys packaging/trust/update-keys.pub sbx-agent-<v>.tar
```

The signing key must be listed in `--update-keys` (a file of `ed25519 <base64> <comment>` lines).
`packaging/trust/update-keys.pub` is embedded into the binary and is the trust root for later updates.

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

## Tests

```sh
cd services/guest-agent
mise exec -- go test -race ./...           # unit tests and the harness
mise exec -- golangci-lint run ./...
GOOS=linux mise exec -- golangci-lint run --build-tags integration ./...
GOOS=windows CGO_ENABLED=0 mise exec -- go build ./...
```

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
