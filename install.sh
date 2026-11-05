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

# The bootstrap reads only the channel; it never evaluates saved state as shell.
channel=$(python3 -c 'import json,pathlib; p=pathlib.Path("/etc/pve/umiak/install-state.json"); print(json.loads(p.read_text()).get("channel","stable") if p.exists() else "stable")')
next_channel=0
for arg in "$@"; do
 if [ "$next_channel" -eq 1 ]; then channel=$arg; next_channel=0; continue; fi
 case "$arg" in
  --channel) next_channel=1 ;;
  --channel=*) channel=${arg#--channel=} ;;
 esac
done
case "$channel" in stable|edge) ;; *) die 'Channel must be stable or edge.' ;; esac
version=${UMIAK_VERSION:-}
if [ -z "$version" ]; then
 [ -z "${UMIAK_INSTALL_DRY_RUN:-}" ] || die 'Set UMIAK_VERSION for a dry run.'
 command -v curl >/dev/null 2>&1 || die 'curl is required.'
 if [ "$channel" = edge ]; then
  version=$(python3 - <<'PYEDGE'
import json,re,urllib.request
pattern=re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-edge\.([0-9]{8})\.(0|[1-9][0-9]*))?")
versions=[]
for page in range(1,101):
 with urllib.request.urlopen(f"https://api.github.com/repos/belov38/umiak/releases?per_page=100&page={page}",timeout=30) as response:
  rows=json.load(response)
 if not rows: break
 for row in rows:
  version=row.get("tag_name", "").removeprefix("v"); match=pattern.fullmatch(version)
  if match and not row.get("draft") and bool(row.get("prerelease")) == (match[4] is not None):
   a,b,c,d,n=match.groups();versions.append(((int(a),int(b),int(c),d is None,int(d or 0),int(n or 0)),version))
else: raise SystemExit("Release listing exceeded pagination limit")
if not versions: raise SystemExit("No edge or stable release available")
print(max(versions)[1])
PYEDGE
  ) || die 'Could not resolve the edge release.'
 else
 # The /releases/latest redirect names the newest tag without the rate-limited API.
 latest=$(curl -fsSIL --proto '=https' -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") \
  || die 'Could not resolve the latest Umiak release.'
 version=${latest##*/tag/v}
 [ "$version" != "$latest" ] || die 'Could not resolve the latest Umiak release.'
 fi
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
