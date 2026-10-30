#!/usr/bin/env bash
# Cross-compiles the Windows tests of the guest agent (spec S9 section 18.3, plan Task 24).
#
#   services/guest-agent/test/windows/build-tests.sh <out-dir>
#
# For every package that contains a *_windows_test.go file, builds a windows/amd64 test binary
# <out-dir>/<package path with / replaced by _>.test.exe (for example internal_winapi.test.exe).
# `sbx-bench s9 agent-tests --dir <out-dir>` copies the binaries into a running Windows clone and
# runs them as SYSTEM. Nothing is downloaded: the module cache must already hold the dependencies
# (GOPROXY=off, GOFLAGS=-mod=readonly), and nothing runs on the host.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
	echo "usage: $0 <out-dir>" >&2
	exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
module="$(cd "$here/../.." && pwd)"

if command -v mise >/dev/null 2>&1; then
	GO=(mise exec -- go)
else
	GO=(go)
fi

mkdir -p "$1"
out="$(cd "$1" && pwd)"

cd "$module"
# No mapfile: the bash 3.2 of macOS lacks it.
pkgs=()
while IFS= read -r p; do
	pkgs+=("$p")
done < <(find . -name '*_windows_test.go' -not -path './vendor/*' -exec dirname {} \; | sort -u)
if [ "${#pkgs[@]}" -eq 0 ]; then
	echo "no package with *_windows_test.go under $module" >&2
	exit 1
fi

export GOOS=windows GOARCH=amd64 CGO_ENABLED=0 GOPROXY=off GOFLAGS=-mod=readonly
for pkg in "${pkgs[@]}"; do
	name="$(printf '%s' "${pkg#./}" | tr '/' '_')"
	echo "build $pkg -> $out/$name.test.exe"
	"${GO[@]}" test -c -ldflags='-s -w' -o "$out/$name.test.exe" "$pkg"
done
echo "built ${#pkgs[@]} test binaries in $out"
