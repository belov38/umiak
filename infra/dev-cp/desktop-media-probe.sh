#!/usr/bin/env bash
# Dev-only streamer probe (desktop-media-probe.ts) with the e2e-desktop environment.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "$HERE/names.sh"
export SBX_API_URL="$API_URL"
export NODE_EXTRA_CA_CERTS="$CA_DIR/ca.pem"
export SBX_E2E_OUTPUT="${SBX_E2E_OUTPUT:-$(mktemp -d)}"
preview_cert="$CA_DIR/turn/preview.crt"
ssh -o BatchMode=yes "${SBX_DEVCP_SSH:-sbx@$CT_IP}" 'cat ~/boat-dev-clone/deploy/compose/secrets/gateway/sbx.pem' >"$preview_cert"
spki() { openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A; }
export SBX_DESKTOP_BROWSER_SPKI="$(spki "$preview_cert"),$(spki "$CA_DIR/turn/tls.crt")"
cd "$REPO"
exec mise exec -- node "$HERE/desktop-media-probe.ts"
