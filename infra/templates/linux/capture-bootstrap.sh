#!/usr/bin/env bash
# Installed before cloud-init's QGA apt transaction, capturing even bootstrap dependencies.
set -euo pipefail
mkdir -p /var/lib/umiak-layer-capture/debs /usr/local/lib/umiak-build
cat >/usr/local/lib/umiak-build/capture-debs <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r file; do
 [ -f "$file" ] || continue
 cp "$file" /var/lib/umiak-layer-capture/debs/
done
HOOK
chmod 0755 /usr/local/lib/umiak-build/capture-debs
cat >/etc/apt/apt.conf.d/99umiak-capture <<'CONF'
DPkg::Pre-Install-Pkgs { "/usr/local/lib/umiak-build/capture-debs"; };
APT::Keep-Downloaded-Packages "true";
Acquire::Languages "none";
CONF
