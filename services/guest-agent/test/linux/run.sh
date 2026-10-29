#!/usr/bin/env bash
# Linux integration tests of the guest agent in a privileged systemd
# container (spec S3 section 21, plan Task 18).
#
#   services/guest-agent/test/linux/run.sh [go test flags] [./pkg]
#
# Builds sbx-agent for linux/$(go env GOARCH) (CGO_ENABLED=0) as four
# versions signed with a dev key generated for this run (never the PoC key
# in ~/.config/sbx), starts the container, installs v1 with
# `sbx-agent install-package --write-config`, points agent.toml at a fake
# smbios directory, starts sbx-identity and sbx-agent (with the debug socket)
# and runs the integration test binary as root inside the container.
#
# go test flags (-run, -v, -count, -timeout, ...) are passed to the test
# binary. A ./path argument selects another package with integration tests,
# for example `run.sh -run Systemd ./internal/supervisor`. KEEP=1 leaves the
# container running for debugging; otherwise it is removed on exit.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
module="$(cd "$here/../.." && pwd)"

if command -v mise >/dev/null 2>&1; then
	GO=(mise exec -- go)
else
	GO=(go)
fi

pkg=./test/integration
args=()
for a in "$@"; do
	case "$a" in
	./*) pkg="$a" ;;
	-test.*) args+=("$a") ;;
	-*) args+=("-test.${a#-}") ;;
	*) args+=("$a") ;;
	esac
done
has_timeout=0
for a in "${args[@]+"${args[@]}"}"; do
	case "$a" in -test.timeout*) has_timeout=1 ;; esac
done
if [ "$has_timeout" = 0 ]; then
	args+=(-test.timeout 30m)
fi

arch="$(cd "$module" && "${GO[@]}" env GOARCH)"
image=sbx-guest-systemd:dev
name="sbx-it-$$"
work="$(mktemp -d "${TMPDIR:-/tmp}/sbx-it.XXXXXX")"

cleanup() {
	status=$?
	if [ "$status" != 0 ] && docker inspect "$name" >/dev/null 2>&1; then
		echo "--- sbx-agent journal (last 150 lines) ---" >&2
		docker exec "$name" journalctl -m -u sbx-agent -u sbx-identity -u sbx-agent-rollback --no-pager -n 150 >&2 || true
	fi
	if [ "${KEEP:-0}" = 1 ]; then
		echo "KEEP=1: container $name left running; remove with: docker rm -f $name" >&2
	else
		docker rm -f "$name" >/dev/null 2>&1 || true
	fi
	rm -rf "$work"
	exit "$status"
}
trap cleanup EXIT

log() { echo "run.sh: $*" >&2; }

# Versions installed and updated by the tests (TestUpdateAndRollback).
v1=0.0.1-it
v2=0.0.2-it
v3=0.0.3-it-failrun
v4=0.0.4-it-badsig

cd "$module"
log "dev signing keys"
release=("${GO[@]}" run ./cmd/sbx-release)
"${release[@]}" keygen --out "$work/key" --comment sbx-it-dev >"$work/update-keys.pub"
"${release[@]}" keygen --out "$work/key-other" --comment sbx-it-other >/dev/null
devkey="$(awk '{print $2}' "$work/update-keys.pub")"

log "tunnel CA"
# A named-curve key (LibreSSL's -newkey ec writes explicit parameters, which
# Go's x509 rejects).
openssl ecparam -name prime256v1 -genkey -noout -out "$work/tunnel-ca.key"
openssl req -new -x509 -key "$work/tunnel-ca.key" -out "$work/tunnel-ca.pem" -days 1 \
	-subj /CN=sbx-it-tunnel-ca >/dev/null 2>&1

build() { # version out [extra ldflags]
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "${GO[@]}" build -trimpath \
		-ldflags "-X main.version=$1 -X main.devUpdateKey=$devkey ${3:-}" -o "$2" ./cmd/sbx-agent
}
pack() { # version binary key out [flags]
	"${release[@]}" pack --version "$1" --os linux --arch "$arch" --binary "$2" \
		--tunnel-ca "$work/tunnel-ca.pem" --update-keys "$work/update-keys.pub" \
		--key "$3" --out "$4" --skip-version-check "${@:5}" >/dev/null 2>&1
}

log "build sbx-agent $v1 $v2 $v3 $v4 (linux/$arch)"
mkdir -p "$work/it/pkg" "$work/bin"
build "$v1" "$work/bin/sbx-agent-1"
build "$v2" "$work/bin/sbx-agent-2"
build "$v3" "$work/bin/sbx-agent-3" "-X main.failRun=1"
build "$v4" "$work/bin/sbx-agent-4"
pack "$v1" "$work/bin/sbx-agent-1" "$work/key/ed25519.key" "$work/it/pkg/v1.tar"
pack "$v2" "$work/bin/sbx-agent-2" "$work/key/ed25519.key" "$work/it/pkg/v2.tar"
pack "$v3" "$work/bin/sbx-agent-3" "$work/key/ed25519.key" "$work/it/pkg/v3-failrun.tar"
pack "$v4" "$work/bin/sbx-agent-4" "$work/key-other/ed25519.key" "$work/it/pkg/v4-badsig.tar" --allow-foreign-signer
printf '%s\n%s\n%s\n%s\n' "$v1" "$v2" "$v3" "$v4" >"$work/it/pkg/versions"

log "build the test binary of $pkg"
CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "${GO[@]}" test -c -tags integration -trimpath \
	-o "$work/it/integration.test" "$pkg"

log "build the image and start the container"
docker build -q -t "$image" "$here" >/dev/null
docker run -d --name "$name" --hostname sbx-it --privileged --cgroupns=host \
	-v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
	"$image" >/dev/null
for _ in $(seq 1 60); do
	state="$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)"
	case "$state" in running | degraded) break ;; esac
	sleep 1
done
docker cp "$work/it" "$name:/it" >/dev/null

log "install $v1 and start the agent"
docker exec -i "$name" bash -euo pipefail -s <<'SETUP'
# Docker bind-mounts /etc/hostname, /etc/hosts and /etc/resolv.conf from the
# ext4 disk of its VM. The agent would FIFREEZE that disk on Quiesce (it is a
# visible rw ext4 mount), so replace them: resolv.conf by a plain file,
# hostname and hosts by bind mounts from tmpfs. Those still refuse a rename
# over them (EBUSY), like Docker's, which the identity code must handle.
mkdir -p /run/sbx-it
for f in hostname hosts resolv.conf; do
	cp "/etc/$f" "/run/sbx-it/$f"
	umount "/etc/$f"
done
cp /run/sbx-it/resolv.conf /etc/resolv.conf
for f in hostname hosts; do
	cp "/run/sbx-it/$f" "/etc/$f"
	mount --bind "/run/sbx-it/$f" "/etc/$f"
done

# Fake smbios (spec 7.1): sbx1:<machineId>:<base64url(BS)>, uuid = machine id.
mkdir -p /var/lib/sbx-it/dmi
python3 - <<'PY'
import base64, os, uuid
mid = str(uuid.uuid4())
bs = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
open("/var/lib/sbx-it/dmi/product_serial", "w").write("sbx1:%s:%s\n" % (mid, bs))
open("/var/lib/sbx-it/dmi/product_uuid", "w").write(mid + "\n")
PY

# The first install runs the binary of the package itself (S5 does the same).
tar -xOf /it/pkg/v1.tar sbx-agent >/tmp/sbx-agent-installer
chmod 0755 /tmp/sbx-agent-installer
/tmp/sbx-agent-installer install-package --write-config /it/pkg/v1.tar
rm -f /tmp/sbx-agent-installer

# The test configuration: no Docker, a tunnel URL that points nowhere (the
# agent must still be ready: READY=1 comes before the tunnel), the fake
# smbios directory. Tests extend it and restart the agent.
cat >/var/lib/sbx-it/agent.toml <<'TOML'
[tunnel]
url = "wss://127.0.0.1:9/v1/connect"

[user]
default = "user"

[readiness]
required = ["identity", "claim", "secrets"]

[docker]
enabled = false

[identity]
sysfs_dir = "/var/lib/sbx-it/dmi"
TOML
cp /var/lib/sbx-it/agent.toml /etc/sbx-agent/agent.toml

mkdir -p /etc/systemd/system/sbx-agent.service.d
cat >/etc/systemd/system/sbx-agent.service.d/50-debug.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent run --debug-listen unix:/run/sbx-agent/debug.sock --debug-confirm
UNIT
systemctl daemon-reload
systemctl start sbx-identity.service
# The container booted before the agent was installed, so ssh.service found
# no host keys and failed; on a template sbx-identity runs before it.
systemctl reset-failed ssh.service || true
systemctl restart ssh.service
systemctl start sbx-agent.service
for _ in $(seq 1 60); do
	[ -S /run/sbx-agent/debug.sock ] && exit 0
	sleep 1
done
echo "the agent did not open its debug socket" >&2
systemctl status sbx-agent --no-pager >&2 || true
exit 1
SETUP

log "run ${args[*]}"
docker exec "$name" /it/integration.test "${args[@]}"
