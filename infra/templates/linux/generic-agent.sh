#!/usr/bin/env bash
# Initial bootstrap is authenticated by the signed offline layer, not an agent-update key.
set -euo pipefail
[[ $UMIAK_AGENT_VERSION =~ ^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,63}$ ]] || die "invalid agent version"
source_dir=$UMIAK_BUILD_DIR/generic-agent
version_dir=/usr/local/lib/umiak-agent/versions/$UMIAK_AGENT_VERSION
[ ! -e /usr/local/lib/umiak-agent/current ] || die "generic agent bootstrap requires an empty base"
install -d -m 0755 "$version_dir/trust"
install -m 0755 "$source_dir/umiak-agent" "$version_dir/umiak-agent"
install -m 0644 "$UMIAK_BUILD_DIR/update-keys.pub" "$version_dir/trust/update-keys.pub"
install -m 0644 "$source_dir/manifest.json" "$version_dir/manifest.json"
for unit in umiak-agent.service umiak-identity.service umiak-agent-rollback.service umiak-cmd.slice; do
 install -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
ln -s "versions/$UMIAK_AGENT_VERSION" /usr/local/lib/umiak-agent/current
ln -s /usr/local/lib/umiak-agent/current/umiak-agent /usr/local/bin/umiak-agent
install -d -m 0755 /etc/umiak-template
touch /etc/umiak-template/generic
install -D -m 0644 "$UMIAK_BUILD_DIR/umiak-LICENSE" /usr/share/doc/umiak-agent/copyright
systemctl daemon-reload
