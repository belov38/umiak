#!/bin/sh
# This template is served with the deployment origin filled in by the owner ingress.
set -eu
umask 077
origin='__UMIAK_ORIGIN__'
case "$origin" in
 https://*|http://localhost:*|http://127.0.0.1:*) ;;
 *) printf '%s\n' 'Installer requires HTTPS (or loopback HTTP).' >&2; exit 1;;
esac
case "$(uname -s)" in
 Darwin) os=darwin;;
 Linux) os=linux;;
 *) printf '%s\n' 'Unsupported operating system; install a release manually.' >&2; exit 1;;
esac
case "$(uname -m)" in
 x86_64|amd64) arch=x64;;
 aarch64|arm64) arch=arm64;;
 *) printf '%s\n' 'Unsupported architecture; only x64 and arm64 are released.' >&2; exit 1;;
esac
command -v curl >/dev/null 2>&1 || { printf '%s\n' 'curl is required.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
 hash() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
 hash() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
 printf '%s\n' 'sha256sum or shasum is required.' >&2
 exit 1
fi
scratch=$(mktemp -d)
# Use separate commands: cleanup never evaluates user-supplied shell text.
cleanup() {
 rm -f "$scratch/binary" "$scratch/SHA256SUMS"
 rmdir "$scratch"
}
trap cleanup EXIT HUP INT TERM
ca=${UMIAK_CA_CERT:-${CURL_CA_BUNDLE:-}}
fetch() {
 if [ -n "$ca" ]; then
  curl --fail --silent --show-error --proto '=https,http' --cacert "$ca" "$1" -o "$2"
 else
  curl --fail --silent --show-error --proto '=https,http' "$1" -o "$2"
 fi
}
name="umiak-$os-$arch"
fetch "$origin/downloads/SHA256SUMS" "$scratch/SHA256SUMS"
expected=$(awk -v name="$name" '$2 == name && length($1) == 64 { print $1 }' "$scratch/SHA256SUMS")
case "$expected" in
 ''|*[!0-9a-f]*) printf '%s\n' 'Missing or invalid SHA256SUMS entry.' >&2; exit 1;;
esac
[ "${#expected}" -eq 64 ] || { printf '%s\n' 'Ambiguous SHA256SUMS entry.' >&2; exit 1; }
fetch "$origin/downloads/$name" "$scratch/binary"
actual=$(hash "$scratch/binary")
[ "$actual" = "$expected" ] || { printf '%s\n' 'Checksum verification failed; existing installation was preserved.' >&2; exit 1; }
install_dir=${UMIAK_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$install_dir"
# Copy only verified bytes. Rename within the destination directory is atomic.
install -m 755 "$scratch/binary" "$install_dir/.umiak-new-$$"
mv -f "$install_dir/.umiak-new-$$" "$install_dir/umiak"
printf 'Installed %s/umiak\n' "$install_dir"
case ":$PATH:" in
 *":$install_dir:"*) ;;
 *) printf 'Add this directory to PATH: %s\n' "$install_dir";;
esac
if [ -n "$ca" ]; then
 "$install_dir/umiak" login --api-url "$origin" --cacert "$ca"
else
 "$install_dir/umiak" login --api-url "$origin"
fi
