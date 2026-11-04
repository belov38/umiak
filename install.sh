#!/bin/sh
# Umiak installer for Proxmox VE. Run as root on a cluster node:
#   curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh
# Non-interactive (flags: see --help):
#   curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh -s -- --non-interactive --yes ...
#
# Downloads the pinned installer bundle from the GitHub release (UMIAK_VERSION,
# default: latest), verifies it against the release SHA256SUMS, unpacks it to
# /var/lib/umiak-installer/<version> and runs it with the terminal as stdin so
# prompts work under `| sh`.
set -eu
# Restrictive only for our own downloads/extraction; reset to 022 before the Python
# installer, because children (pvesh set /cluster/sdn, apt, systemctl) inherit it and
# PVE would write dnsmasq/dbus configs as 0600, unreadable by messagebus.
umask 077

repo=belov38/umiak
tty=${UMIAK_TTY:-/dev/tty}
state_dir=/var/lib/umiak-installer

say() { printf '%s\n' "$*" >&2; }
die() { say "$1"; exit "${2:-1}"; }

interactive=1
for arg in "$@"; do
 case "$arg" in
  --non-interactive|--help|-h) interactive=0 ;;
 esac
done

# Prompts read from the terminal; without one, refuse instead of hanging. The
# probe runs in a subshell: dash exits on a failed redirection of a builtin.
if [ "$interactive" -eq 1 ] && ! (true <"$tty") 2>/dev/null; then
 die 'Run this in an interactive shell or pass --non-interactive with flags (see --help)' 2
fi

version=${UMIAK_VERSION:-}
if [ -z "$version" ]; then
 [ -z "${UMIAK_INSTALL_DRY_RUN:-}" ] || die 'Set UMIAK_VERSION for a dry run.'
 command -v curl >/dev/null 2>&1 || die 'curl is required.'
 # The /releases/latest redirect names the newest tag without the rate-limited API.
 latest=$(curl -fsSIL --proto '=https' -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") \
  || die 'Could not resolve the latest Umiak release.'
 version=${latest##*/tag/v}
 [ "$version" != "$latest" ] || die 'Could not resolve the latest Umiak release.'
fi
# Strict semver with an optional pre-release suffix (no "+": Docker tags cannot contain it).
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die 'Invalid UMIAK_VERSION.'
[ "${#version}" -le 64 ] || die 'Invalid UMIAK_VERSION.'

base="https://github.com/$repo/releases/download/v$version"
bundle="umiak-installer-$version.tar.gz"
target="$state_dir/$version"

if [ -n "${UMIAK_INSTALL_DRY_RUN:-}" ]; then
 printf 'bundle %s\n' "$base/$bundle"
 printf 'sums %s\n' "$base/SHA256SUMS"
 printf 'target %s\n' "$target"
 exit 0
fi

[ "$(id -u)" -eq 0 ] || die 'Run the installer as root on the Proxmox VE node.'
command -v pveversion >/dev/null 2>&1 || die 'This is not a Proxmox VE node (pveversion not found).'
command -v python3 >/dev/null 2>&1 || die 'python3 is required (Proxmox VE ships it).'
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die 'Python 3.11 or newer is required.'
for tool in curl sha256sum tar; do
 command -v "$tool" >/dev/null 2>&1 || die "$tool is required."
done

mkdir -p "$state_dir"
chmod 700 "$state_dir"
scratch=$(mktemp -d "$state_dir/.download-XXXXXX")
# Separate commands: cleanup never evaluates downloaded or user-supplied text.
cleanup() {
 rm -f "$scratch/$bundle" "$scratch/SHA256SUMS"
 rm -rf "$scratch/unpack"
 rmdir "$scratch" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fetch() {
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' -o "$2" "$1"
}
say "Downloading the Umiak installer $version…"
fetch "$base/SHA256SUMS" "$scratch/SHA256SUMS" || die 'Download of SHA256SUMS failed.'
fetch "$base/$bundle" "$scratch/$bundle" || die "Download of $bundle failed."
expected=$(awk -v name="$bundle" '($2 == name || $2 == "*" name) && length($1) == 64 { print $1 }' "$scratch/SHA256SUMS")
case "$expected" in
 ''|*[!0-9a-f]*) die 'Missing or ambiguous SHA256SUMS entry for the installer bundle.' ;;
esac
actual=$(sha256sum "$scratch/$bundle" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || die 'Checksum verification failed; nothing was installed.'

mkdir "$scratch/unpack"
tar -xzf "$scratch/$bundle" -C "$scratch/unpack" --no-same-owner --no-same-permissions \
 || die 'Could not unpack the installer bundle.'
[ "$(cat "$scratch/unpack/VERSION" 2>/dev/null)" = "$version" ] || die 'The bundle does not match the requested version.'
[ -f "$scratch/unpack/umiak_installer/__main__.py" ] || die 'The bundle has no installer.'
rm -rf "$target"
mv "$scratch/unpack" "$target"

cd "$target"
umask 022
if [ "$interactive" -eq 1 ]; then
 exec python3 -m umiak_installer "$@" <"$tty"
fi
exec python3 -m umiak_installer "$@"
