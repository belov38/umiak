#!/usr/bin/env bash
# Real desktop acceptance, never a fake or a template build. Shares the host with S9, with a 4GiB per-track budget.
# Needs a logged-in umiak CLI on PATH, deployed branch, promoted desktop template and TURN.
# UMIAK_E2E_TEMPLATE=windows-desktop runs the same scenario on Windows (pwsh, Win+R, QGA as SYSTEM).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "$HERE/names.sh"
export UMIAK_API_URL="$API_URL"
export UMIAK_DESKTOP_MCP_URL="$MCP_URL"
export UMIAK_DESKTOP_TURN_HOST="$TURN_HOST"
export UMIAK_DESKTOP_TURN_PORT="$TURN_PORT"
export UMIAK_DESKTOP_TURN_TLS_PORT="$TURN_TLS_PORT"
export NODE_EXTRA_CA_CERTS="$CA_DIR/ca.pem"
export UMIAK_E2E_OUTPUT="${UMIAK_E2E_OUTPUT:-$(mktemp -d)}"
# Pin only these dev leaves for Chromium; CA/hostname is separately verified by curl.
preview_cert="$CA_DIR/turn/preview.crt"
ssh -o BatchMode=yes "${UMIAK_DEVCP_SSH:-umiak@$CT_IP}" 'cat ~/umiak/deploy/compose/secrets/gateway/umiak.pem' >"$preview_cert"
spki() { openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A; }
export UMIAK_DESKTOP_BROWSER_SPKI="$(spki "$preview_cert"),$(spki "$CA_DIR/turn/tls.crt")"
# The runner checks qm list before create, fork and resume.
cd "$REPO"
exec mise exec -- node "$HERE/e2e-desktop.ts"
