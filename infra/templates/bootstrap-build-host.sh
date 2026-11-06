#!/usr/bin/env bash
# Run inside a disposable Ubuntu 26.04 amd64 build VM. No Proxmox commands.
set -euo pipefail
[ "$(uname -m)" = x86_64 ] || { echo 'Requires x86_64 Linux'; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo 'Grant this user /dev/kvm access first (kvm group), then log in again'; exit 1; }
sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update
sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends curl ca-certificates git xz-utils qemu-system-x86 qemu-utils xorriso e2fsprogs zstd gnupg
# Official mise installer; tools are version-pinned by the approved checkout's mise.toml.
if ! command -v mise >/dev/null; then
 build_host_installer_dir=$(mktemp -d)
 installer="$build_host_installer_dir/mise-install.sh"
 curl --fail --location --retry 3 https://mise.run -o "$installer"
 sh "$installer"
 rm -r "$build_host_installer_dir"
fi
export PATH="$HOME/.local/bin:$PATH"
mise trust mise.toml
mise install node pnpm go python
mise exec -- pnpm install --frozen-lockfile
mise exec oras@1.3.6 -- oras version
printf '%s\n' 'Ready. Run: mise exec oras@1.3.6 -- node infra/templates/local-layers.mjs build VERSION AGENT_VERSION /absolute/output'
