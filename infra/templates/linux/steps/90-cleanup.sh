#!/usr/bin/env bash
# 90-cleanup (spec S5 section 8.10): build leftovers out, then a self-check.
# The builder runs `sbx-agent seal`, the zero-fill and fstrim afterwards.
#
# /var/log/sbx-build stays: this step's own log and exit status are written
# there while it runs. The builder removes it before `seal`.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

# Template hostname; sbx-identity sets sbx-<12 hex> in every clone.
echo sbx >/etc/hostname
sed -i -E '/(^|[[:space:]])sbx-build([[:space:]]|$)/d' /etc/hosts

# apt: back to the plain archive, no package lists (spec 6.2).
apt_snapshot ""
# The Docker pins hold only during the build: users update Docker with apt like the rest.
apt-mark unhold docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*

# cloud-init stays installed but off (spec 8.10, S3 20).
cloud-init clean --logs --seed
touch /etc/cloud/cloud-init.disabled
rm -f /etc/netplan/50-cloud-init.yaml /etc/ssh/sshd_config.d/50-cloud-init.conf

# GRUB: no recordfail wait after a hard stop (spec 8.5).
if [ -f /boot/grub/grubenv ]; then grub-editenv /boot/grub/grubenv unset recordfail; fi

# Machine state and caches.
rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret
for home in /root /home/user; do
	rm -rf "$home/.npm" "$home/.cache" "$home/.bash_history" "$home/.python_history" \
		"$home/.lesshst" "$home/.wget-hsts" "$home/.sqlite_history" "$home/.node_repl_history" \
		"$home/.viminfo" "$home/.sudo_as_admin_successful"
done
rm -rf /home/user/.rustup/downloads/* /home/user/.rustup/tmp/* /root/go
find /tmp /var/tmp -mindepth 1 -maxdepth 1 ! -name 'systemd-private-*' -exec rm -rf {} +

# Logs: contents go, the directory tree stays.
journalctl --rotate
journalctl --vacuum-time=1s
find /var/log -path /var/log/sbx-build -prune -o -path /var/log/journal -prune -o \
	-type f \( -name '*.gz' -o -name '*.xz' -o -name '*.zst' -o -name '*.old' -o -name '*.[0-9]' \) -print0 |
	xargs -0 -r rm -f
find /var/log -path /var/log/sbx-build -prune -o -path /var/log/journal -prune -o \
	-type f -print0 | xargs -0 -r truncate -s 0

# Build manifest without the verify part (spec 11); the builder rewrites it
# with the final facts before seal.
install -D -m 0644 "$SBX_BUILD_DIR/build.json" /etc/sbx-template/build.json

# Self-check: every violation is listed, then the step fails.
bad=()
[ -z "$(swapon --show --noheadings)" ] || bad+=("swap is active")
awk '$1 !~ /^#/ && $3 == "swap"' /etc/fstab | grep -q . && bad+=("swap in /etc/fstab")
mapfile -t kernels < <(compgen -G '/boot/vmlinuz-*' || true)
[ "${#kernels[@]}" -eq 1 ] || bad+=("kernels: ${kernels[*]}")
left=$(installed_packages "${PURGE_PACKAGES[@]}" | tr '\n' ' ')
[ -z "$left" ] || bad+=("packages to purge are installed: $left")
# find may fail on files that vanish meanwhile; what it prints still counts.
keys=$({ find / -xdev \( -name authorized_keys -o -name authorized_keys2 \) -print 2>/dev/null || true; } | tr '\n' ' ')
[ -z "$keys" ] || bad+=("authorized_keys: $keys")
for f in /etc/skel/.bash_logout /home/user/.bash_logout /root/.bash_logout; do
	[ ! -e "$f" ] || bad+=("$f exists")
done
[ -e /etc/cloud/cloud-init.disabled ] || bad+=("cloud-init is not disabled")
[ "$(cat /etc/hostname)" = sbx ] || bad+=("hostname is $(cat /etc/hostname)")
! grep -q '^Snapshot:' /etc/apt/sources.list.d/ubuntu.sources || bad+=("apt sources still pin a snapshot")
for u in root user; do
	[[ $(passwd -S "$u" | awk '{ print $2 }') == L ]] || bad+=("password of $u is not locked")
done
if [ "${#bad[@]}" -gt 0 ]; then
	printf 'self-check: %s\n' "${bad[@]}" >&2
	die "self-check failed"
fi
log "self-check passed"
log "done"
