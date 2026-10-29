#!/usr/bin/env bash
# boat-dev-clone S1 PoC: sanitize the root filesystem of template 599 offline, before it ever boots.
# 599 is a thin snapshot of Ilia's personal dev template 9000, so this removes Tailscale, personal
# credentials and build-time state. Runs on the Proxmox host as root:
#   template-sanitize.sh <mounted root>
# S5 replaces 599 with a clean Ubuntu 26.04 minimal build; this script is PoC-only.
set -euo pipefail

R="${1:?usage: template-sanitize.sh <mounted root>}"
[[ -f "$R/etc/os-release" ]] || { echo "not a root filesystem: $R" >&2; exit 1; }

for d in proc sys dev; do mount --bind "/$d" "$R/$d"; done
cleanup() { for d in dev sys proc; do umount "$R/$d" 2>/dev/null || true; done; }
trap cleanup EXIT

# 1. Tailscale: a sandbox must never join a tailnet.
if chroot "$R" dpkg -s tailscale >/dev/null 2>&1; then
	chroot "$R" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -q tailscale
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

# 2. Personal credentials, keys, tokens, browser and agent state, shell history.
rm -f "$R/root/.ssh/authorized_keys" "$R/home/ib/.ssh/authorized_keys"
rm -rf "$R/home/ib/.ssh/agent" \
	"$R/home/ib/.claude" "$R/home/ib/.claude.json" "$R/home/ib/.codex" "$R/home/ib/.npmrc" "$R/home/ib/.npm" \
	"$R/home/ib/.gnupg" "$R/home/ib/.config/google-chrome" "$R/home/ib/.config/agent-desktop" \
	"$R/home/ib/.local/share/claude" "$R/home/ib/.local/share/pki" "$R/home/ib/.local/share/chrome-devtools-mcp" \
	"$R/home/ib/.local/share/keyrings" "$R/home/ib/.t3" "$R/home/ib/.cache" "$R/home/ib/recordings" \
	"$R/home/ib/.dbus" "$R/home/ib/.ICEauthority"
find "$R/home" "$R/root" -xdev \( -name '.*history' -o -name '.netrc' -o -name '.git-credentials' -o -name 'id_*' \
	-o -name '.docker' -o -name '.aws' -o -name '.kube' -o -name 'gh' \) -prune -exec rm -rf {} +

# 3. Machine identity and first-boot state: new machine-id, SSH host keys and cloud-init instance on every clone.
chroot "$R" cloud-init clean --logs --machine-id --seed
# In a chroot cloud-init may delete /etc/machine-id instead of writing "uninitialized". Without the
# file systemd cannot set up a machine-id on the read-only early root, and networkd fails on DUID.
printf 'uninitialized\n' >"$R/etc/machine-id"
rm -f "$R"/etc/ssh/ssh_host_*
rm -rf "$R"/var/log/journal/* "$R"/var/cache/apt/archives/*.deb
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
