#!/usr/bin/env bash
# 20-docker (spec S5 section 8.8): Docker CE from download.docker.com with
# the exact versions of versions.toml.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

# Docker release signing key (https://docs.docker.com/engine/install/ubuntu/).
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
key=/etc/apt/keyrings/docker.asc

install -d -m 0755 /etc/apt/keyrings
curl -fsSL --retry 5 --retry-all-errors -o "$key.part" https://download.docker.com/linux/ubuntu/gpg
# apt trusts every key of the Signed-By file: it must hold exactly this one.
fprs=$(gpg_primary_fprs "$key.part") || die "cannot read the Docker key file"
[ "$fprs" = "$DOCKER_KEY_FPR" ] || die "Docker key file must hold only $DOCKER_KEY_FPR, has: $(echo "$fprs" | tr '\n' ' ')"
chmod 0644 "$key.part"
mv "$key.part" "$key"

cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: resolute
Components: stable
Architectures: amd64
Signed-By: $key
EOF
apt_update

ce=$(toml_get docker.docker_ce)
pkgs=(
	"docker-ce=$ce"
	"docker-ce-cli=$ce"
	"containerd.io=$(toml_get docker.containerd_io)"
	"docker-compose-plugin=$(toml_get docker.compose_plugin)"
	"docker-buildx-plugin=$(toml_get docker.buildx_plugin)"
)
log "install ${pkgs[*]}"
apt-mark unhold docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin >/dev/null
apt_install "${pkgs[@]}"
apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin

install_file etc/docker/daemon.json
usermod -aG docker user
systemctl enable docker.service containerd.service
systemctl restart docker.service
docker version --format 'docker server {{.Server.Version}}'
log "done"
