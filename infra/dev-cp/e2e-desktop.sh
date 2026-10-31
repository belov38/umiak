#!/usr/bin/env bash
# Real desktop acceptance, never a fake or a template build. Shares the host with S9, with a 4GiB per-track budget.
# Needs a logged-in sbx CLI on PATH, deployed branch, promoted desktop template and TURN.
# The Windows variant is added after S9/S10 Windows integration.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "$HERE/names.sh"
export SBX_API_URL="$API_URL"
export NODE_EXTRA_CA_CERTS="$CA_DIR/ca.pem"
export SBX_E2E_OUTPUT="${SBX_E2E_OUTPUT:-$(mktemp -d)}"
# The runner checks qm list before create, fork and resume.
cd "$REPO"
exec mise exec -- node "$HERE/e2e-desktop.ts"
