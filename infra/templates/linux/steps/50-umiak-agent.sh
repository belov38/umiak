#!/usr/bin/env bash
# 50-umiak-agent (spec S5 section 8.10, S3 sections 17.1, 17.2): the signed
# agent package through its own installer, agent.toml, units.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

pkg=$UMIAK_BUILD_DIR/umiak-agent.tar

keys=$UMIAK_BUILD_DIR/update-keys.pub
[ -s "$keys" ] || die "$keys not found"

# agent.toml first: --write-config keeps an existing file.
install -D -m 0644 "$UMIAK_BUILD_DIR/agent.toml" /etc/umiak-agent/agent.toml

# The first install runs the installer of the package itself; the builder
# verified the package signature before the build (spec 7.2 p. 1).
# --trust-keys: the builder hands over, on its seed, the update keys it
# verified the package with. They are the first-install trust anchor instead
# of the keys embedded in the binary: a homelab install signs its packages
# with its own key, which no released binary embeds. The installed version's
# trust/update-keys.pub verifies later updates.
if [ "${UMIAK_GENERIC_IMAGE:-0}" = 1 ]; then
 # No install CA or private signing key is ever present in this path.
 . "$UMIAK_BUILD_DIR/generic-agent.sh"
else
 [ -f "$pkg" ] || die "$pkg not found"
 installer=$(mktemp /root/umiak-agent-installer.XXXXXX)
 tar -xOf "$pkg" umiak-agent >"$installer"
 chmod 0700 "$installer"
 "$installer" install-package --write-config --trust-keys "$keys" "$pkg"
 rm -f "$installer"
fi

systemctl enable umiak-identity.service umiak-agent.service
systemctl enable qemu-guest-agent.service 2>/dev/null || true
for unit in umiak-identity.service umiak-agent.service qemu-guest-agent.service; do
	state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
	case $state in
	enabled | static | indirect | alias) log "$unit: $state" ;;
	*) die "$unit is $state" ;;
	esac
done
for unit in umiak-agent-rollback.service umiak-cmd.slice; do
	systemctl cat "$unit" >/dev/null || die "$unit is not installed"
done

# A template must carry a production agent build (spec S3 17.6).
doctor=$(umiak-agent doctor --json)
current=$(jq -r '.versions.current' <<<"$doctor")
[ "$current" = "$UMIAK_AGENT_VERSION" ] || die "agent current is '$current', want $UMIAK_AGENT_VERSION"
aids=$(jq -c '.test_aids // []' <<<"$doctor")
[ "$aids" = "[]" ] || die "agent has test aids: $aids"
log "agent $current, test_aids none"
log "done"
