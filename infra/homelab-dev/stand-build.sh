#!/bin/sh
# Build the control-plane images from the current checkout INSIDE an installed
# homelab control-plane CT and switch its stack to them. Development loop only:
# releases are still built by .github/workflows/release.yml.
#
# Usage: infra/homelab-dev/stand-build.sh <pve-ssh-host> [ct-id]
#   UMIAK_STAND_INSTALLER=1  also overlay deploy/installer/umiak_installer onto
#                            the node's installed bundle (for installer fixes).
# Builds the committed HEAD (git archive), tags images dev-<sha>.
set -eu

host=${1:?usage: stand-build.sh <pve-ssh-host> [ct-id]}
ct=${2:-590}
root=$(git rev-parse --show-toplevel)
sha=$(git -C "$root" rev-parse --short=12 HEAD)
tag="dev-$sha"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$root" archive --format=tar.gz -o "$work/src.tgz" HEAD
scp -q "$work/src.tgz" "$host:/root/umiak-stand-src.tgz"

# shellcheck disable=SC2087 # expand $ct/$tag/$sha locally on purpose
ssh "$host" sh -s <<EOF
set -eu
pct config $ct | grep -q '^tags:.*umiak' || { echo "CT $ct is not a Umiak CT" >&2; exit 1; }
pct push $ct /root/umiak-stand-src.tgz /root/umiak-stand-src.tgz
rm -f /root/umiak-stand-src.tgz
pct exec $ct -- sh -euc '
  rm -rf /opt/umiak-src && mkdir -p /opt/umiak-src
  tar -xzf /root/umiak-stand-src.tgz -C /opt/umiak-src && rm -f /root/umiak-stand-src.tgz
  cd /opt/umiak-src
  echo "Building images $tag (source $sha)…"
  UMIAK_VERSION=$tag UMIAK_SOURCE_COMMIT=$sha docker compose --env-file compose.dev.env \
    -f compose.yaml -f compose.dev.yaml build
  # Stack files the running deployment mounts, from the same source.
  cp compose.yaml /opt/umiak/compose.yaml
  for f in \$(python3 - <<PY 2>/dev/null || true
import ast, pathlib
src = pathlib.Path("deploy/installer/umiak_installer/stack.py").read_text()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "STACK_FILES" for t in node.targets):
        for value in ast.literal_eval(node.value):
            print(value)
PY
  ); do
    [ "\$f" = compose.yaml ] && continue
    install -D -m 0644 "\$f" "/opt/umiak/\$f"
  done
  sed -i "s/^UMIAK_VERSION=.*/UMIAK_VERSION=$tag/" /opt/umiak/.env
  cd /opt/umiak && docker compose --project-directory /opt/umiak up -d --remove-orphans
  docker compose --project-directory /opt/umiak ps --format "{{.Service}} {{.Status}}"
'
EOF

if [ -n "${UMIAK_STAND_INSTALLER:-}" ]; then
	tar -C "$root/deploy/installer" -czf "$work/inst.tgz" --exclude __pycache__ umiak_installer
	scp -q "$work/inst.tgz" "$host:/root/umiak-stand-installer.tgz"
	ssh "$host" 'set -eu; v=$(python3 -c "import json;print(json.load(open(\"/etc/pve/umiak/install-state.json\"))[\"release\"])"); cd "/var/lib/umiak-installer/$v" && tar -xzf /root/umiak-stand-installer.tgz && rm -f /root/umiak-stand-installer.tgz && echo "installer overlaid onto $v"'
fi
echo "Stand runs $tag."
