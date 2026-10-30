#!/usr/bin/env bash
# boat-dev-clone dev control plane: trust the dev CA in the macOS login keychain, for port
# previews in the browser only. Dev only.
#
#   infra/dev-cp/trust-mac.sh [--remove]
#
# Previews (https://<slug>-<port>.<port domain>, names.sh) are the only browser-facing hosts with
# a dev CA certificate: a wildcard, which Tailscale Serve cannot give. The dashboard, api, CLI and
# Keycloak go through Tailscale Serve with a Let's Encrypt certificate and need no trust here.
# The CA is name-constrained to the tunnel host and the port domain, so it vouches for nothing
# else. No sudo: the login keychain is the user's; macOS asks for the password once.
# Firefox keeps its own store (Settings > Privacy & Security > Certificates > Import).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
CA="$CA_DIR/ca.pem"

REMOVE=0
if [[ "${1:-}" == "--remove" ]]; then
	REMOVE=1
	shift
fi
[[ $# -eq 0 ]] || {
	sed -n '2,13p' "$0"
	exit 2
}
[[ "$(uname -s)" == Darwin ]] || {
	echo "trust-mac.sh: macOS only" >&2
	exit 1
}
[[ -s "$CA" ]] || {
	echo "trust-mac.sh: no $CA (infra/dev-cp/dev-ca.sh or deploy.sh creates it)" >&2
	exit 1
}

cn=$(openssl x509 -in "$CA" -noout -subject -nameopt multiline | awk -F' = ' '/commonName/ {print $2}')
sha1=$(openssl x509 -in "$CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
present() { security find-certificate -a -Z -c "$cn" "$KEYCHAIN" 2>/dev/null | grep -qi "SHA-1 hash: $sha1"; }

if ((REMOVE)); then
	if present; then
		security delete-certificate -Z "$sha1" -t "$KEYCHAIN"
		echo "removed '$cn' from the login keychain"
	else
		echo "'$cn' is not in the login keychain"
	fi
	exit 0
fi

if present && security verify-cert -c "$CA" -p ssl >/dev/null 2>&1; then
	echo "'$cn' is already trusted"
else
	echo "trusting '$cn' ($CA) for SSL in the login keychain"
	security add-trusted-cert -r trustRoot -p ssl -k "$KEYCHAIN" "$CA"
fi
echo "previews: https://<slug>-<port>.$PORT_DOMAIN (Safari, Chrome; restart the browser if it cached a failure)"
