#!/usr/bin/env bash
# 40-coding-agents (spec S5 section 8.9): global npm CLIs with the exact
# versions of versions.toml [npm], their auto-update switches, the `sbx` CLI.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# npm checks each tarball against the integrity of the registry.
pkgs=()
while IFS='=' read -r name version; do
	pkgs+=("$name@$version")
done < <(toml_table npm)
[ "${#pkgs[@]}" -gt 0 ] || die "versions.toml [npm] is empty"
log "npm install -g ${pkgs[*]}"
npm install -g "${pkgs[@]}"

# Auto-update off where the CLI has a system-wide switch (the rest is listed
# in apps/template-builder/README.md).
install_file etc/claude-code/managed-settings.json
install_file etc/gemini-cli/settings.json
install_file etc/opencode/opencode.json
install_file etc/codex/config.toml

# `sbx` CLI (S7) and its API URL, when the build was given them.
if [ -f "$SBX_BUILD_DIR/sbx" ]; then
	if toml_has sbx; then
		sha=$(toml_get sbx.cli.sha256)
		echo "$sha  $SBX_BUILD_DIR/sbx" | sha256sum -c --status || die "build/sbx does not match versions.toml sbx.cli.sha256"
	else
		log "versions.toml has no [sbx]: build/sbx is not checked"
	fi
	install -m 0755 "$SBX_BUILD_DIR/sbx" /usr/local/bin/sbx
fi
if [ -f "$SBX_BUILD_DIR/sbx-config.json" ]; then
	install -D -m 0644 "$SBX_BUILD_DIR/sbx-config.json" /etc/sbx/config.json
fi

for t in claude codex opencode gemini pnpm; do
	[ -x "/usr/local/bin/$t" ] || die "/usr/local/bin/$t is missing"
done
log "done"
