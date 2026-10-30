#!/usr/bin/env bash
# 50-sbx-agent (spec S5 section 8.10, S3 sections 17.1, 17.2): the signed
# agent package through its own installer, agent.toml, units.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

pkg=$SBX_BUILD_DIR/sbx-agent-$SBX_AGENT_VERSION-linux-amd64.tar
[ -f "$pkg" ] || die "$pkg not found"

# agent.toml first: --write-config keeps an existing file.
install -D -m 0644 "$SBX_BUILD_DIR/agent.toml" /etc/sbx-agent/agent.toml

# The first install runs the installer of the package itself; the builder
# verified the package signature before the build (spec 7.2 p. 1).
installer=$(mktemp /root/sbx-agent-installer.XXXXXX)
tar -xOf "$pkg" sbx-agent >"$installer"
chmod 0700 "$installer"
"$installer" install-package --write-config "$pkg"
rm -f "$installer"

systemctl enable sbx-identity.service sbx-agent.service
systemctl enable qemu-guest-agent.service 2>/dev/null || true
for unit in sbx-identity.service sbx-agent.service qemu-guest-agent.service; do
	state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
	case $state in
	enabled | static | indirect | alias) log "$unit: $state" ;;
	*) die "$unit is $state" ;;
	esac
done
for unit in sbx-agent-rollback.service sbx-cmd.slice; do
	systemctl cat "$unit" >/dev/null || die "$unit is not installed"
done

# A template must carry a production agent build (spec S3 17.6).
doctor=$(sbx-agent doctor --json)
current=$(jq -r '.versions.current' <<<"$doctor")
[ "$current" = "$SBX_AGENT_VERSION" ] || die "agent current is '$current', want $SBX_AGENT_VERSION"
aids=$(jq -c '.test_aids // []' <<<"$doctor")
[ "$aids" = "[]" ] || die "agent has test aids: $aids"
log "agent $current, test_aids none"
log "done"
