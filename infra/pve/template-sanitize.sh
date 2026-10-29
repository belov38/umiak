#!/usr/bin/env bash
# boat-dev-clone S1 PoC: sanitize the root filesystem of template 599 offline, before it ever boots.
# 599 is a thin snapshot of Ilia's personal dev template 9000, so this removes Tailscale, the personal
# account with all its data, and build-time state. Runs on the Proxmox host as root:
#   template-sanitize.sh <mounted root>
# Deleted blocks must also be discarded (fstrim) by the caller, otherwise they stay readable from the
# raw disk inside every sandbox. S5 replaces 599 with a clean Ubuntu 26.04 minimal build; PoC only.
set -euo pipefail

R="${1:?usage: template-sanitize.sh <mounted root>}"
[[ -f "$R/etc/os-release" ]] || { echo "not a root filesystem: $R" >&2; exit 1; }

for d in proc sys dev; do mount --bind "/$d" "$R/$d"; done
cleanup() { for d in dev sys proc; do umount "$R/$d" 2>/dev/null || true; done; }
trap cleanup EXIT

# 1. Tailscale: a sandbox must never join a tailnet.
# Every tailscale* package (tailscale, tailscale-archive-keyring, ...), installed or with config left.
# shellcheck disable=SC2016 # dpkg-query format, not shell expansion
ts_pkgs() { chroot "$R" dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'tailscale*' 2>/dev/null | awk '$1 != "un" {print $2}'; }
mapfile -t pkgs < <(ts_pkgs)
if ((${#pkgs[@]})); then
	chroot "$R" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -q "${pkgs[@]}"
fi
if [[ -n "$(ts_pkgs)" ]]; then
	echo "tailscale packages remain: $(ts_pkgs | tr '\n' ' ')" >&2
	exit 1
fi
rm -rf "$R/var/lib/tailscale" "$R/etc/default/tailscaled" "$R/etc/apt/sources.list.d/tailscale.list" \
	"$R"/usr/share/keyrings/tailscale*
if find "$R/etc/systemd" "$R/usr/lib/systemd" "$R/lib/systemd" -name 'tailscale*' 2>/dev/null | grep -q .; then
	echo "tailscale units remain" >&2
	exit 1
fi
if [[ -e "$R/usr/sbin/tailscaled" || -e "$R/usr/bin/tailscale" ]]; then
	echo "tailscale binaries remain" >&2
	exit 1
fi

# 2. The personal account and everything it owned; root's keys and history; personal software.
if chroot "$R" id ib >/dev/null 2>&1; then
	chroot "$R" userdel --remove ib 2>/dev/null || chroot "$R" userdel ib
fi
rm -rf "$R/home/ib" "$R/etc/sudoers.d/90-cloud-init-users" "$R/opt/agent-desktop"
find "$R/root" -mindepth 1 -maxdepth 1 ! -name .bashrc ! -name .profile -exec rm -rf {} +
rm -rf "$R"/var/spool/cron/crontabs/* "$R"/var/mail/* "$R"/var/tmp/* "$R"/tmp/*
if [[ -n "$(find "$R/home" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
	echo "unexpected home directories remain" >&2
	exit 1
fi

# 3. Machine identity and first-boot state: new machine-id, SSH host keys and cloud-init instance on every clone.
chroot "$R" cloud-init clean --logs --machine-id --seed
# In a chroot cloud-init may delete /etc/machine-id instead of writing "uninitialized". Without the
# file systemd cannot set up a machine-id on the read-only early root, and networkd fails on DUID.
printf 'uninitialized\n' >"$R/etc/machine-id"
rm -f "$R"/etc/ssh/ssh_host_*
rm -rf "$R"/var/log/journal/* "$R"/var/cache/apt/archives/*.deb
find "$R/var/log" -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
find "$R/var/log" -type f -exec truncate -s 0 {} +
# The build VM's netplan file is bound to its MAC. cloud-init writes a new one from ipconfig0;
# the fallback below gives any en* NIC DHCP if cloud-init does not.
rm -f "$R/etc/netplan/50-cloud-init.yaml"
cat >"$R/etc/netplan/90-sbx-fallback.yaml" <<'EOF'
# boat-dev-clone S1 PoC: DHCP on any virtio NIC regardless of MAC.
network:
  version: 2
  ethernets:
    sbx-fallback:
      match:
        name: "en*"
      dhcp4: true
      dhcp-identifier: mac
EOF
chmod 600 "$R/etc/netplan/90-sbx-fallback.yaml"

# 4. Units that distort boot timings or change the image in the background.
for u in systemd-networkd-wait-online.service unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer; do
	ln -sf /dev/null "$R/etc/systemd/system/$u"
done

chroot "$R" dpkg -s qemu-guest-agent >/dev/null || { echo "qemu-guest-agent missing" >&2; exit 1; }
echo "sanitize: ok"
