#!/usr/bin/env bash
# Builds the signed umiak-agent package that `umiak-tpl build --agent-package` bakes into a template
# (spec S5 7.2 p. 1, S3 17.1). One build pins one tunnel CA bundle (S5 14), so the CA is a
# parameter: the dev stand passes the dev CA of its gateway, production its own.
#
#   infra/templates/agent-package.sh --tunnel-ca <pem> --out <dir> [--version <v>] [--key <ed25519.key>] [--os linux|windows]
#
# --os windows builds umiak-agent.exe and packs umiak-agent-<v>-windows-amd64.tar (spec S9 12.12).
# The version defaults to 0.1.0+<UTC date>.<short git commit>. The signing key defaults to the PoC
# key ~/.config/umiak/update-signing/ed25519.key; it must be listed in
# services/guest-agent/packaging/trust/update-keys.pub. Prints the package path.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODULE="$REPO/services/guest-agent"
KEYS="$MODULE/packaging/trust/update-keys.pub"

ca=""
out=""
version=""
key="${UMIAK_UPDATE_SIGNING_KEY:-$HOME/.config/umiak/update-signing/ed25519.key}"
goos="linux"
while [[ $# -gt 0 ]]; do
	case "$1" in
	--tunnel-ca) ca="$2" ;;
	--out) out="$2" ;;
	--version) version="$2" ;;
	--key) key="$2" ;;
	--os) goos="$2" ;;
	*)
		sed -n '6p' "$0" >&2
		exit 2
		;;
	esac
	shift 2
done
[[ -n "$ca" && -n "$out" ]] || {
	sed -n '6p' "$0" >&2
	exit 2
}
case "$goos" in
linux) bin="umiak-agent" ;;
windows) bin="umiak-agent.exe" ;;
*)
	echo "agent-package: --os must be linux or windows" >&2
	exit 2
	;;
esac
[[ -s "$ca" ]] || { echo "agent-package: no tunnel CA at $ca" >&2; exit 1; }
[[ -s "$key" ]] || { echo "agent-package: no signing key at $key" >&2; exit 1; }
if [[ -z "$version" ]]; then
	version="0.1.0+$(date -u +%Y%m%d).$(git -C "$REPO" rev-parse --short HEAD)"
fi

mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pkg="$out/umiak-agent-$version-$goos-amd64.tar"

cd "$MODULE"
CGO_ENABLED=0 GOOS="$goos" GOARCH=amd64 mise exec -- go build -trimpath \
	-ldflags "-X main.version=$version" -o "$work/$bin" ./cmd/umiak-agent
mise exec -- go run ./cmd/umiak-release pack --version "$version" --os "$goos" --arch amd64 \
	--binary "$work/$bin" --tunnel-ca "$ca" --update-keys "$KEYS" --key "$key" \
	--out "$pkg" --skip-version-check >&2
mise exec -- go run ./cmd/umiak-release verify --keys "$KEYS" "$pkg" >&2
echo "$pkg"
