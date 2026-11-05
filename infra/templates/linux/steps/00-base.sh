#!/usr/bin/env bash
# 00-base (spec S5 sections 6.2, 8.1): packages from the apt snapshot, the
# generic kernel for the next boot, purge and mask lists. The builder reboots
# the VM after this step.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

log "wait for cloud-init"
cloud-init status --wait >/dev/null || log "cloud-init status: $(cloud-init status 2>&1 | tr '\n' ' ')"
# Nothing may touch apt behind our back.
systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service \
	apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true

# cloud-init (bootcmd) set the snapshot already; set it again in case the
# apt module rewrote the file.
log "apt snapshot $UMIAK_APT_SNAPSHOT"
apt_snapshot "$UMIAK_APT_SNAPSHOT"
apt_update

# grub-pc upgrades must not ask for the boot disk. The by-id name of the
# QEMU disk is the same in every clone.
if [ -n "$(installed_packages grub-pc)" ]; then
	root_disk=/dev/$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -n1)
	boot_dev=$root_disk
	for l in /dev/disk/by-id/*; do
		[ "$(readlink -f "$l")" = "$root_disk" ] && boot_dev=$l && break
	done
	echo "grub-pc grub-pc/install_devices multiselect $boot_dev" | debconf-set-selections
	log "grub-pc install device $boot_dev"
fi

# Purging packages like ubuntu-pro-client removes the minimal metapackages
# too. Their other dependencies become "manual" first, so a later
# `apt autoremove` in a sandbox does not take netplan, sudo or cloud-init.
mapfile -t purge < <(installed_packages "${PURGE_PACKAGES[@]}")
if [ "${#purge[@]}" -gt 0 ]; then
	mapfile -t metas < <(dpkg-query -W -f '${db:Status-Abbrev} ${Section} ${Package}\n' |
		awk '$1 == "ii" && $2 == "metapackages" { print $3 }')
	keep=()
	for meta in "${metas[@]}"; do
		while read -r dep; do
			[[ " ${purge[*]} " == *" $dep "* ]] && continue
			[ -n "$(installed_packages "$dep")" ] && keep+=("$dep")
		done < <(apt-cache depends --installed --no-suggests --no-conflicts --no-breaks \
			--no-replaces --no-enhances "$meta" |
			awk '$1 ~ /^[|]?(PreDepends|Depends|Recommends):$/ && $2 !~ /^</ { print $2 }')
	done
	if [ "${#keep[@]}" -gt 0 ]; then
		apt-mark manual "${keep[@]}" >/dev/null
	fi
	log "purge ${purge[*]}"
	apt_get purge "${purge[@]}"
fi
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd

log "full-upgrade"
apt_get full-upgrade

log "install packages"
apt_install "$UMIAK_KERNEL_PACKAGE" netplan.io systemd-resolved \
	build-essential pkg-config libssl-dev git git-lfs curl wget ca-certificates \
	gnupg jq ripgrep fd-find tmux vim nano less man-db htop rsync unzip zip \
	xz-utils zstd file tree sqlite3 make cmake openssh-server openssh-client \
	sudo bash-completion python3 python3-venv python3-pip python3-dev \
	"$UMIAK_JAVA_PACKAGE" ffmpeg xdotool qemu-guest-agent chrony iproute2 \
	iputils-ping dnsutils netcat-openbsd lsof strace tzdata
ln -sfn /usr/bin/fdfind /usr/local/bin/fd
apt_get autoremove --purge

log "mask units"
oomd=$(systemctl cat systemd-oomd.service >/dev/null 2>&1 && echo yes || echo no)
for unit in "${MASK_UNITS[@]}"; do
	[[ $unit == systemd-oomd.* && $oomd == no ]] && continue
	systemctl mask --now "$unit"
done

# Kernel (spec 8.1): boot the generic kernel of linux-image-virtual next. The
# running one (often linux-kvm in the minimal image) cannot be removed now;
# 10-system removes it after the reboot. GRUB_TOP_LEVEL puts this kernel
# into the default menu entry; 10-system deletes the file.
kernel=$(dpkg-query -W -f '${Depends}' "$UMIAK_KERNEL_PACKAGE" | grep -o "linux-image-[^ ,]*-$UMIAK_KERNEL_SUFFIX" | head -n1 || true)
kernel=${kernel#linux-image-}
[ -n "$kernel" ] && [ -f "/boot/vmlinuz-$kernel" ] || die "no generic kernel from linux-image-virtual"
log "next boot: $kernel"
# The initrd-less PARTUUID boot of the image (spec 8.5) is not tried with the
# generic kernel either.
rm -f /etc/default/grub.d/40-force-partuuid.cfg
printf 'GRUB_DEFAULT=0\nGRUB_TOP_LEVEL="/boot/vmlinuz-%s"\n' "$kernel" >/etc/default/grub.d/99-umiak-build-kernel.cfg
update-grub
first=$(awk '/^menuentry /{ m = 1 } m && $1 == "linux" { print $2; exit }' /boot/grub/grub.cfg)
[[ $first == *"/vmlinuz-$kernel" ]] || die "first GRUB entry boots '$first', not $kernel"
log "done"
