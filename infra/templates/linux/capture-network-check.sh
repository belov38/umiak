#!/usr/bin/env bash
# Installed only in disposable QEMU capture/smoke guests, before any apt transaction.
set -u
if systemctl is-failed --quiet systemd-networkd-wait-online.service ||
   ! ip -4 -o address show dev capture0 scope global | grep -q inet ||
   ! ip -4 route show default dev capture0 | grep -q default; then
 {
  echo 'UMIAK_CAPTURE_NETWORK_FAILED: wait-online/DHCP/default route failed; stopping capture'
  networkctl status --all --no-pager || true
  ls -la /run/systemd/network || true
  for file in /run/systemd/network/* /etc/netplan/*; do
   [ -f "$file" ] && { echo "--- $file"; cat "$file"; }
  done
  cloud-init status --long || true
  ip -br address; ip route
  echo UMIAK_CAPTURE_NETWORK_FAILED
 } > /dev/ttyS0 2>&1
 exit 1
fi
