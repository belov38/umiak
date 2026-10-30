# shellcheck shell=bash disable=SC2034 # variables are used by the steps
# Shared helpers of the linux build steps (spec S5 sections 6.2, 8). Sourced
# by every step: `. "$(dirname "$0")/../lib.sh"`. Steps run as root in the
# build VM with the seed ISO at /mnt/seed and cwd /mnt/seed/build.

SBX_BUILD_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SBX_FILES_DIR=$SBX_BUILD_DIR/files
# Downloads and unpacked archives; /var/tmp is emptied by 90-cleanup.
SBX_WORK_DIR=/var/tmp/sbx-build

# SBX_BUILD_ID, SBX_BUILD_VERSION, SBX_AGENT_VERSION, SBX_APT_SNAPSHOT
set -a
# shellcheck source=/dev/null
. "$SBX_BUILD_DIR/env"
set +a

export DEBIAN_FRONTEND=noninteractive
export UCF_FORCE_CONFFOLD=1
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
export LC_ALL=C.UTF-8
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The standard Ubuntu PATH a sandbox command gets (spec S5 section 8.9).
SBX_STD_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Removed by 00-base and checked by 90-cleanup (spec S5 section 8.1). Glob
# patterns as in bash `case`; systemd-zram-generator because there is no swap
# of any kind (section 8.6).
PURGE_PACKAGES=(snapd 'apport*' unattended-upgrades 'ubuntu-pro-client*' update-notifier-common landscape-common pollinate fwupd modemmanager multipath-tools open-iscsi udisks2 lxd-installer ufw open-vm-tools rsyslog sysstat avahi-daemon 'cups*' 'tailscale*' systemd-zram-generator)
# Masked by 00-base (spec 8.1); the systemd-oomd units only when present.
MASK_UNITS=(apt-daily.timer apt-daily-upgrade.timer motd-news.timer man-db.timer e2scrub_all.timer systemd-oomd.service systemd-oomd.socket)

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

die() {
	log "ERROR: $*" >&2
	exit 1
}

apt_get() {
	apt-get -q -y \
		-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
		-o DPkg::Lock::Timeout=600 -o Acquire::Retries=5 "$@"
}

apt_install() { apt_get install --no-install-recommends "$@"; }

# apt-get update that fails when an index could not be fetched (plain update only warns, and
# the step would go on with stale or no lists); snapshot.ubuntu.com answers 503 at times.
apt_update() {
	local i
	for i in 1 2 3 4 5; do
		apt_get update --error-on=any && return 0
		log "apt-get update failed (attempt $i), retrying in $((i * 15)) s"
		sleep $((i * 15))
	done
	die "apt-get update failed 5 times"
}

# Installed packages (any dpkg state but "not installed", so leftover
# configuration counts) whose names match one of the glob patterns.
installed_packages() {
	local status pkg pat
	dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 2>/dev/null |
		while read -r status pkg; do
			[ "${status:1:1}" = n ] && continue
			for pat in "$@"; do
				# shellcheck disable=SC2254 # $pat is a glob on purpose
				case $pkg in $pat)
					echo "$pkg"
					break
					;;
				esac
			done
		done
}

# Sets `Snapshot: <ts>` in every stanza of a deb822 sources file (spec S5
# section 6.2); an empty ts removes the Snapshot lines.
apt_snapshot() {
	local ts=$1 f=${2:-/etc/apt/sources.list.d/ubuntu.sources}
	[ -f "$f" ] || die "$f not found"
	awk -v ts="$ts" '
function flush() {
  for (i = 1; i <= n; i++) print buf[i]
  if (types && ts != "") print "Snapshot: " ts
  n = 0; types = 0
}
/^[[:space:]]*$/ { flush(); print; next }
/^Snapshot:/ { next }
{ buf[++n] = $0 }
/^Types:/ { types = 1 }
END { flush() }
' "$f" >"$f.new"
	cat "$f.new" >"$f"
	rm -f "$f.new"
}

# fetch_verify <url> <sha256> <out>: downloads url to out unless out already
# has the sha256; a mismatch fails the step.
fetch_verify() {
	local url=$1 sha=$2 out=$3
	[[ $sha =~ ^[0-9a-f]{64}$ ]] || die "bad sha256 for $url: $sha"
	if [ -f "$out" ] && echo "$sha  $out" | sha256sum -c --status; then
		return 0
	fi
	log "download $url"
	mkdir -p "$(dirname "$out")"
	curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 -o "$out.part" "$url"
	if ! echo "$sha  $out.part" | sha256sum -c --status; then
		rm -f "$out.part"
		die "sha256 mismatch for $url (want $sha)"
	fi
	mv "$out.part" "$out"
}

# toml_get <dotted.key>: a scalar from build/versions.toml; fails when absent.
toml_get() {
	python3 -I - "$SBX_BUILD_DIR/versions.toml" "$1" <<'PY'
import sys, tomllib
v = tomllib.load(open(sys.argv[1], "rb"))
for part in sys.argv[2].split("."):
    if not isinstance(v, dict) or part not in v:
        sys.exit(f"versions.toml: no {sys.argv[2]}")
    v = v[part]
if isinstance(v, (dict, list)):
    sys.exit(f"versions.toml: {sys.argv[2]} is not a scalar")
print(v)
PY
}

# toml_has <table>: whether versions.toml has the top-level table.
toml_has() {
	python3 -I -c 'import sys, tomllib; sys.exit(not isinstance(tomllib.load(open(sys.argv[1], "rb")).get(sys.argv[2]), dict))' \
		"$SBX_BUILD_DIR/versions.toml" "$1"
}

# toml_table <table>: `key=value` lines of a flat table of versions.toml.
toml_table() {
	python3 -I - "$SBX_BUILD_DIR/versions.toml" "$1" <<'PY'
import sys, tomllib
t = tomllib.load(open(sys.argv[1], "rb")).get(sys.argv[2])
if not isinstance(t, dict):
    sys.exit(f"versions.toml: no table {sys.argv[2]}")
for k, v in t.items():
    print(f"{k}={v}")
PY
}

# gpg_primary_fprs <keyfile>: fingerprints of the primary keys in the file,
# one per line; subkeys are not listed.
gpg_primary_fprs() {
	local home rc=0
	home=$(mktemp -d)
	GNUPGHOME=$home gpg --batch --show-keys --with-colons "$1" 2>/dev/null |
		awk -F: '$1 == "pub" || $1 == "sec" { want = 1; next } $1 == "fpr" && want { print $10 } { want = 0 }' || rc=$?
	rm -rf "$home"
	return "$rc"
}

# install_file <path> [mode]: /<path> from files/<path>.
install_file() {
	install -D -o root -g root -m "${2:-0644}" "$SBX_FILES_DIR/$1" "/$1"
}

# Runs a command as `user` with the env of a sandbox command (spec S3 8.2).
as_user() {
	runuser -u user -- env -i HOME=/home/user USER=user LOGNAME=user \
		SHELL=/bin/bash LANG=C.UTF-8 PATH="$SBX_STD_PATH" "$@"
}
