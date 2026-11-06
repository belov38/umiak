#!/usr/bin/env bash
# 40-coding-agents (spec S5 section 8.9): global npm CLIs with the exact
# versions of versions.toml [npm], their auto-update switches, the `umiak` CLI.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# npm checks each tarball against the integrity of the registry.
if [ "${UMIAK_GENERIC_IMAGE:-}" = 1 ]; then
 bash "$UMIAK_BUILD_DIR/generic-npm.sh"
else
pkgs=()
while IFS='=' read -r name version; do
	pkgs+=("$name@$version")
done < <(toml_table npm)
[ "${#pkgs[@]}" -gt 0 ] || die "versions.toml [npm] is empty"
log "npm install -g ${pkgs[*]}"
npm install -g "${pkgs[@]}"
fi

# Auto-update off where the CLI has a system-wide switch (the rest is listed
# in apps/template-builder/README.md).
install_file etc/claude-code/managed-settings.json
install_file etc/gemini-cli/settings.json
install_file etc/opencode/opencode.json
install_file etc/codex/config.toml

# `umiak` CLI (S7) and its API URL, when the build was given them.
if [ -f "$UMIAK_BUILD_DIR/umiak" ]; then
	if toml_has umiak; then
		sha=$(toml_get umiak.cli.sha256)
		echo "$sha  $UMIAK_BUILD_DIR/umiak" | sha256sum -c --status || die "build/umiak does not match versions.toml umiak.cli.sha256"
	else
		log "versions.toml has no [umiak]: build/umiak is not checked"
	fi
	install -m 0755 "$UMIAK_BUILD_DIR/umiak" /usr/local/bin/umiak
fi
if [ -f "$UMIAK_BUILD_DIR/umiak-config.json" ]; then
	install -D -m 0644 "$UMIAK_BUILD_DIR/umiak-config.json" /etc/umiak/config.json
fi

tools=(codex gemini pnpm)
if [ "${UMIAK_GENERIC_IMAGE:-}" != 1 ]; then tools+=(claude opencode); fi
for t in "${tools[@]}"; do
	[ -x "/usr/local/bin/$t" ] || die "/usr/local/bin/$t is missing"
done
log "done"
