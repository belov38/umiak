#!/usr/bin/env bash
# 10-system (spec S5 sections 8.1-8.7, S3 sections 5, 8.2, 20): one kernel,
# user `user`, sshd and PAM, network, GRUB, sysctl, journald. Runs after the
# reboot that follows 00-base.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

# Kernel: keep only the running generic kernel of linux-image-virtual.
running=$(uname -r)
[[ $running == *-generic ]] || die "running kernel $running is not generic: GRUB did not boot linux-image-virtual"
abi=${running%-generic}
mapfile -t old < <(installed_packages 'linux-*' | while read -r pkg; do
	case $pkg in
	linux-image-virtual | linux-virtual | linux-base | linux-libc-dev | linux-firmware | linux-sysctl-defaults) ;;
	*"-$abi-"* | *"-$abi") ;;
	linux-image-* | linux-modules-* | linux-headers-* | linux-tools-* | linux-cloud-tools-* | linux-buildinfo-* | linux-kvm* | linux-*-headers-* | linux-*-tools-*)
		echo "$pkg"
		;;
	esac
done)
if [ "${#old[@]}" -gt 0 ]; then
	log "purge kernels ${old[*]}"
	apt_get purge "${old[@]}"
	apt_get autoremove --purge
fi
mapfile -t kernels < <(compgen -G '/boot/vmlinuz-*' || true)
[ "${#kernels[@]}" -eq 1 ] && [ "${kernels[0]}" = "/boot/vmlinuz-$running" ] ||
	die "want exactly /boot/vmlinuz-$running, have: ${kernels[*]}"

# Swap (spec 8.6): none of any kind.
swapoff -a
sed -i -E '/^[^#[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]/d' /etc/fstab
rm -f /swap.img /swapfile

# User `user` (spec 8.2). The skeleton .bash_logout runs clear_console, which
# adds bytes to the output of `bash -lc` commands.
rm -f /etc/skel/.bash_logout
if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu 2>/dev/null || userdel ubuntu; fi
if getent group ubuntu >/dev/null; then groupdel ubuntu; fi
getent group kvm >/dev/null || groupadd --system kvm
if ! id user >/dev/null 2>&1; then
	getent passwd 1000 >/dev/null && die "uid 1000 is taken: $(getent passwd 1000)"
	getent group 1000 >/dev/null && die "gid 1000 is taken: $(getent group 1000)"
	groupadd -g 1000 user
	useradd -m -u 1000 -g 1000 -s /bin/bash user
fi
[ "$(id -u user)" = 1000 ] && [ "$(id -g user)" = 1000 ] || die "user is not uid/gid 1000: $(id user)"
usermod -s /bin/bash -aG sudo,kvm user
rm -f /home/user/.bash_logout /root/.bash_logout
passwd -l user >/dev/null
passwd -l root >/dev/null
others=$(awk -F: '$3 >= 1000 && $3 != 65534 && $1 != "user" { print $1 }' /etc/passwd)
[ -z "$others" ] || die "unexpected users with uid >= 1000: $others"
rm -f /root/.ssh/authorized_keys /root/.ssh/authorized_keys2 \
	/home/user/.ssh/authorized_keys /home/user/.ssh/authorized_keys2
install_file etc/sudoers.d/90-umiak-user 0440
visudo -c -f /etc/sudoers.d/90-umiak-user
visudo -c
loginctl enable-linger user
[ -e /var/lib/systemd/linger/user ] || die "linger for user is not enabled"

# Locale and time zone.
printf 'LANG=C.UTF-8\n' >/etc/default/locale
ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime
echo Etc/UTC >/etc/timezone

# sshd and PAM (spec 8.3, S3 8.2). Ubuntu's ssh.socket stays; its generator
# takes ListenAddress from the config.
install_file etc/ssh/sshd_config.d/10-umiak.conf
install -d -m 0755 /etc/umiak /etc/umiak-agent
: >/etc/umiak/env
chmod 0644 /etc/umiak/env
install -m 0644 "$UMIAK_BUILD_DIR/ssh-user-ca.pub" /etc/umiak-agent/ssh-user-ca.pub
install -m 0644 /etc/umiak-agent/ssh-user-ca.pub /etc/ssh/umiak_user_ca.pub
for line in \
	'session required pam_env.so readenv=1 envfile=/etc/umiak/env' \
	'session required pam_env.so readenv=1 envfile=/run/umiak/secrets/env'; do
	grep -qxF "$line" /etc/pam.d/sshd || echo "$line" >>/etc/pam.d/sshd
done
install -d -m 0755 /run/sshd
sshd -t
systemctl enable ssh.socket

# Network (spec 8.4).
install_file etc/netplan/10-umiak.yaml 0600
rm -f /etc/netplan/50-cloud-init.yaml
netplan generate
install_file etc/systemd/system/systemd-networkd-wait-online.service.d/10-umiak.conf
install_file etc/systemd/resolved.conf.d/10-umiak.conf

# Kernel and limits (spec 8.6), journald (8.7).
install_file etc/sysctl.d/90-umiak.conf
install_file etc/systemd/system.conf.d/90-umiak.conf
install_file etc/systemd/journald.conf.d/90-umiak.conf
sysctl -q -p /etc/sysctl.d/90-umiak.conf
systemctl daemon-reload

# GRUB (spec 8.5): no menu wait, no recordfail wait, always through initrd.
install_file etc/default/grub.d/90-umiak.cfg
rm -f /etc/default/grub.d/40-force-partuuid.cfg /etc/default/grub.d/99-umiak-build-kernel.cfg
update-grub
grep -q 'systemd.machine_id=firmware' /boot/grub/grub.cfg || die "grub.cfg has no systemd.machine_id=firmware"
# The 00_header of Ubuntu always defines the initrdfail function; what must
# be absent is its use by the menu entries (GRUB_FORCE_PARTUUID).
if grep -Eq '^[[:space:]]*initrdfail[[:space:]]*$|set partuuid=|root=PARTUUID=' /boot/grub/grub.cfg; then
	die "grub.cfg still has the initrd-less PARTUUID boot (initrdfail)"
fi
log "done"
