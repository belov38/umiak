#!/bin/sh
# This template is served with the deployment origin filled in by the owner ingress.
set -eu
umask 077
origin='__UMIAK_ORIGIN__'
case "$origin" in
 https://*) ;;
 http://*) printf '%s\n' 'Warning: HTTP installation integrity relies on the local network; SHA256SUMS is downloaded over the same channel.' >&2;;
 *) printf '%s\n' 'Installer requires an HTTP or HTTPS origin.' >&2; exit 1;;
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
command -v gzip >/dev/null 2>&1 || { printf '%s\n' 'gzip is required.' >&2; exit 1; }
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
 rm -f "$scratch/binary" "$scratch/archive.gz" "$scratch/SHA256SUMS" "$scratch/DOWNLOADS"
 rmdir "$scratch"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() {
 # Metadata remains quiet; only the large archive displays terminal progress.
 if [ "$3" = progress ] && [ -t 2 ]; then
  set -- "$1" "$2" --progress-bar
 else
  set -- "$1" "$2" --silent
 fi
 curl --fail --show-error --proto '=https,http' "$3" "$1" -o "$2"
}
name="umiak-$os-$arch"
fetch "$origin/downloads/SHA256SUMS" "$scratch/SHA256SUMS" quiet
fetch "$origin/downloads/DOWNLOADS" "$scratch/DOWNLOADS" quiet
entry=$(awk -v name="$name.gz" '$2 == name && NF == 3 { print $1, $3 }' "$scratch/DOWNLOADS")
version=${entry% *}
size=${entry#* }
case "$version" in
 ''|*[!0-9A-Za-z.+-]*) printf '%s\n' 'Invalid download version.' >&2; exit 1;;
esac
case "$size" in
 ''|*[!0-9]*) printf '%s\n' 'Missing or invalid download size.' >&2; exit 1;;
esac
verify() {
 expected=$(awk -v name="$1" '$2 == name && length($1) == 64 { print $1 }' "$scratch/SHA256SUMS")
 case "$expected" in
  ''|*[!0-9a-f]*) printf '%s\n' 'Missing or invalid SHA256SUMS entry.' >&2; exit 1;;
 esac
 [ "${#expected}" -eq 64 ] || { printf '%s\n' 'Ambiguous SHA256SUMS entry.' >&2; exit 1; }
 actual=$(hash "$2")
 [ "$actual" = "$expected" ] || { printf '%s\n' 'Checksum verification failed; existing installation was preserved.' >&2; exit 1; }
}
mb=$(awk -v size="$size" 'BEGIN { printf "%.1f", size / 1000000 }')
printf 'Downloading umiak %s for %s-%s (%s MB)…\n' "$version" "$os" "$arch" "$mb" >&2
fetch "$origin/downloads/$name.gz" "$scratch/archive.gz" progress
verify "$name.gz" "$scratch/archive.gz"
gzip -dc "$scratch/archive.gz" > "$scratch/binary" || { printf '%s\n' 'Decompression failed; existing installation was preserved.' >&2; exit 1; }
verify "$name" "$scratch/binary"
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
printf '%s\n' 'Pair the CLI: approve only this login in your claimed owner browser.'
if [ "${UMIAK_INSTALL_SKIP_LOGIN:-0}" = 1 ]; then
 # Print shell-quoted values so paths containing spaces remain copyable.
 quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
 printf 'Next: umiak login --api-url '
 quote "$origin"
 printf '\n'
 exit 0
fi
"$install_dir/umiak" login --api-url "$origin"
